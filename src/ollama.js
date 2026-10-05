import { UpstreamError, describeError } from './errors.js';
import { log } from './log.js';

async function* ndjson(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

async function errorText(res) {
  const body = await res.text().catch(() => '');
  try {
    return JSON.parse(body).error ?? body;
  } catch {
    return body;
  }
}

const toMs = (nanoseconds) => Math.round((nanoseconds ?? 0) / 1e6);

/**
 * `config.think` and `config.seed` are passed to Ollama when set. `onUsage`
 * is told what each reply cost: the token counts and timings Ollama reports.
 */
export function createOllama(config, { onUsage } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  async function call(path, init) {
    try {
      return await fetch(config.url + path, { ...init, headers });
    } catch (err) {
      throw new UpstreamError('ollama', `Cannot reach Ollama at ${config.url} (${describeError(err)})`);
    }
  }

  return {
    /**
     * Runs one model turn. Reply text is passed to `onDelta` as it arrives; the
     * resolved value is the complete assistant message, including any tool calls.
     */
    async chat({ messages, tools, onDelta }) {
      const options = { num_ctx: config.numCtx, temperature: 0.2 };
      if (config.seed != null) options.seed = config.seed;
      const body = { model: config.model, messages, stream: true, options };
      // Left out, a thinking model decides for itself, which usually means it thinks.
      if (config.think != null) body.think = config.think;
      if (tools?.length) body.tools = tools;
      if (config.keepAlive) body.keep_alive = config.keepAlive;

      const res = await call('/api/chat', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!res.ok) {
        const reason = await errorText(res);
        if (res.status === 404) {
          throw new UpstreamError('ollama', `Model "${config.model}" is not available: run "ollama pull ${config.model}"`);
        }
        if (/does not support tools/i.test(reason)) {
          throw new UpstreamError('ollama', `Model "${config.model}" cannot call tools; set OLLAMA_MODEL to one that can`);
        }
        if (/does not support thinking|think value/i.test(reason)) {
          throw new UpstreamError('ollama', `Model "${config.model}" does not accept OLLAMA_THINK=${config.think}; clear it or use a value the model supports`);
        }
        throw new UpstreamError('ollama', `Ollama returned HTTP ${res.status}: ${reason.slice(0, 300)}`);
      }

      let content = '';
      let thinking = '';
      let last = null;
      const toolCalls = [];
      try {
        for await (const chunk of ndjson(res.body)) {
          if (chunk.error) throw new UpstreamError('ollama', `Ollama failed: ${String(chunk.error).slice(0, 300)}`);
          // Reasoning from thinking models is kept out of the reply; it is only logged.
          thinking += chunk.message?.thinking ?? '';
          const text = chunk.message?.content;
          if (text) {
            content += text;
            onDelta?.(text);
          }
          if (chunk.message?.tool_calls) toolCalls.push(...chunk.message.tool_calls);
          if (chunk.done) last = chunk;
        }
      } catch (err) {
        if (err instanceof UpstreamError) throw err;
        throw new UpstreamError('ollama', `Lost the connection to Ollama mid-reply (${describeError(err)})`);
      }

      // LOG_LEVEL=debug shows what the model did at each step, for tuning prompts and models.
      log.debug('model reply', {
        content,
        tools: toolCalls.map((call) => `${call.function?.name}(${JSON.stringify(call.function?.arguments)})`),
        thinking: thinking.slice(-600),
      });
      onUsage?.({
        promptTokens: last?.prompt_eval_count ?? 0,
        outputTokens: last?.eval_count ?? 0,
        loadMs: toMs(last?.load_duration),
        promptMs: toMs(last?.prompt_eval_duration),
        outputMs: toMs(last?.eval_duration),
        thinkingChars: thinking.length,
        contentChars: content.length,
      });
      const message = { role: 'assistant', content };
      if (toolCalls.length) message.tool_calls = toolCalls;
      return message;
    },

    /** Confirms Ollama is reachable and the configured model is pulled. */
    async check() {
      const res = await call('/api/tags', { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new UpstreamError('ollama', `Ollama returned HTTP ${res.status}`);
      const { models = [] } = await res.json();
      const wanted = config.model.includes(':') ? config.model : `${config.model}:latest`;
      if (!models.some((model) => model.name === wanted || model.name === config.model)) {
        throw new UpstreamError('ollama', `Reachable, but model "${config.model}" is not pulled: run "ollama pull ${config.model}"`);
      }
      return `Model ${config.model} is ready`;
    },
  };
}
