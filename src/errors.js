/** A failure talking to Ollama, Jackett or qBittorrent. The message is safe to show an admin. */
export class UpstreamError extends Error {
  constructor(service, message) {
    super(message);
    this.name = 'UpstreamError';
    this.service = service;
  }
}

/** Turns a fetch/network failure into a short human-readable reason. */
export function describeError(err) {
  if (err?.name === 'TimeoutError') return 'timed out';
  const code = err?.cause?.code ?? err?.code;
  if (code) return String(code);
  return err?.message ?? String(err);
}
