// A throwaway PiRick for one benchmark run: the real agent, prompt and tools,
// with in-process stand-ins for Jackett and qBittorrent and a record of
// everything the model did. Nothing here can reach a real service except the
// model it is handed.
import { createAgent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { createConversation } from '../src/conversation.js';
import { openDb } from '../src/db.js';
import { UpstreamError, describeError } from '../src/errors.js';
import { hashFromMagnet } from '../src/jackett.js';
import { BASE_TAG, toDownload, userTag } from '../src/qbittorrent.js';
import { createSettings } from '../src/settings.js';
import { createTools } from '../src/tools.js';
import { createUpkeep } from '../src/upkeep.js';
import { byHash, byTitle, search } from './corpus.js';

const USERNAME = 'alice';
/** A request that is still going after this long has failed, whatever comes back. */
const TURN_LIMIT_MS = 8 * 60 * 1000;
const OUTPUT_KEPT = 1500;

export const LIBRARIES = [
  { name: 'Movies', description: 'Films', savePath: '/media/Movies', perTitle: false, category: '' },
  { name: 'TV', description: 'TV series', savePath: '/media/TV', perTitle: true, category: '' },
  { name: 'Anime', description: 'Japanese animation, series and films', savePath: '/media/Anime', perTitle: true, category: '' },
];
/** What is already on disk in each library. */
export const FOLDERS = {
  '/media/Movies': [],
  '/media/TV': ['Les Vampires', 'Tales of Ossendale'],
  '/media/Anime': ['Minato no Mirelle'],
};

// The agent's own words, which mark a reply it had to replace or a model it had to push.
const NUDGE = '[Automatic check';
const STUCK = 'Sorry, I got in a muddle';
const BLANK = "Sorry, I didn't catch that";

const REFUSAL = /\b(?:piracy|pirated|illegal(?:ly)?|copyright(?:ed)?|against (?:the law|my guidelines|policy)|can(?:not|['’]t) (?:help|assist) (?:you )?with (?:that|this|download))/i;
const JARGON = /\b(?:torrents?|seeders?|seeds|leechers?|magnet|trackers?|indexers?|jackett|qbittorrent)\b/i;
// Headings, tables and links, which the prompt rules out.
const MARKUP = /^\s*#{1,6}\s|^\s*\|.*\|\s*$|\]\(https?:/m;

/**
 * `setup` describes the scenario's starting point:
 *   libraries    replaces the usual three (an empty list means none are set up)
 *   have         downloads already in qBittorrent: [{ title, progress, state, eta }]
 *   failAdds     qBittorrent refuses every new download
 *   personality  the admin's personality text
 *   notes        what upkeep did while the user was away
 * `connect(onUsage)` returns the model: an object with `chat()`, as createOllama gives.
 */
export function createWorld(setup = {}, connect) {
  const db = openDb(':memory:');
  const { lastInsertRowid } = db
    .prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, 'none', 'user', ?)")
    .run(USERNAME, Date.now());
  const user = { id: Number(lastInsertRowid), username: USERNAME, role: 'user' };
  const tags = [BASE_TAG, userTag(USERNAME)];

  const settings = createSettings(db);
  for (const library of setup.libraries ?? LIBRARIES) settings.addLibrary(library);
  if (setup.personality) settings.setPersonality(setup.personality);
  const logNote = db.prepare('INSERT INTO upkeep_log (at, username, action, detail) VALUES (?, ?, ?, ?)');
  for (const detail of setup.notes ?? []) logNote.run(Date.now(), USERNAME, 'replaced', detail);

  const turns = [];
  const added = [];
  const searches = [];
  let current = null;

  const torrents = (setup.have ?? []).map(({ title, progress = 0, state = 'downloading', eta = 0 }, i) => {
    const entry = byTitle(title);
    return {
      hash: entry.infoHash,
      name: title,
      progress,
      state,
      eta,
      size: entry.size,
      tags: tags.join(', '),
      save_path: '/media/Movies',
      added_on: 1_700_000_000 + i,
    };
  });

  const qbit = {
    listFolders: async (path) => (Object.hasOwn(FOLDERS, path) ? { exists: true, names: [...FOLDERS[path]] } : { exists: false, names: [] }),
    savePaths: async () => [...new Set(torrents.map((torrent) => torrent.save_path))],
    async find(hash) {
      const torrent = torrents.find((entry) => entry.hash === hash);
      return torrent ? toDownload(torrent) : null;
    },
    async add({ magnet, savePath, category, tags: given }) {
      if (setup.failAdds) throw new UpstreamError('qbittorrent', 'qBittorrent returned HTTP 500 for /api/v2/torrents/add');
      const hash = hashFromMagnet(magnet);
      const entry = byHash(hash);
      torrents.push({ hash, name: entry.title, progress: 0, state: 'metaDL', eta: 0, size: entry.size, tags: given.join(', '), save_path: savePath, added_on: Math.floor(Date.now() / 1000) });
      added.push({ title: entry.title, size: entry.size, savePath, category, turn: turns.length - 1 });
    },
    async addTags() {},
    list: async (tag) => torrents.filter((torrent) => torrent.tags.split(', ').includes(tag)).reverse().map(toDownload),
    tagged: async (tag) => torrents.filter((torrent) => torrent.tags.split(', ').includes(tag)).map((torrent) => ({ ...torrent })),
    async remove(hash) {
      torrents.splice(0, torrents.length, ...torrents.filter((torrent) => torrent.hash !== hash));
    },
  };
  const jackett = {
    async search(query, categories) {
      searches.push(query);
      return search(query, categories);
    },
    resolve: async (result) => ({ magnet: result.magnet }),
  };

  // An in-process indexer answers instantly, which the finder would otherwise take for a cached answer.
  const config = loadConfig({ JACKETT_RETRY_CACHED_EMPTY: 'false' });
  const upkeep = createUpkeep({ db, qbit, jackett, settings, config });
  const realTools = createTools({ config, jackett, qbit, settings, upkeep });
  const tools = {
    ...realTools,
    async run(who, call, turn) {
      const output = await realTools.run(who, call, turn);
      let args = call?.function?.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          // Kept as the model wrote it.
        }
      }
      current.calls.push({ name: call?.function?.name ?? 'unknown', args, output: JSON.stringify(output).slice(0, OUTPUT_KEPT), error: output?.error });
      return output;
    },
  };

  const model = connect((usage) => current?.usage.push(usage));
  const ollama = {
    async chat(request) {
      if (Date.now() - current.startedAt > TURN_LIMIT_MS) throw new Error('The request took too long and was abandoned');
      // A nudge stays in the messages for the rest of the turn, so the count is the most seen.
      current.nudgesNow = Math.max(current.nudgesNow, request.messages.filter((message) => message.role === 'user' && message.content.startsWith(NUDGE)).length);
      const started = Date.now();
      const reply = await model.chat(request);
      current.modelMs += Date.now() - started;
      current.modelCalls += 1;
      if (!reply.tool_calls?.length && !reply.content.trim()) current.emptyReplies += 1;
      // Everything the model said, including replies PiRick withheld from the user.
      current.said.push({ content: reply.content, calls: (reply.tool_calls ?? []).map((entry) => entry.function?.name ?? 'unknown') });
      return reply;
    },
  };
  const agent = createAgent({ ollama, tools, conversation: createConversation(db), settings, upkeep });

  /** A new request from the user. Everything PiRick does about it is recorded in one place. */
  function begin(text) {
    current = { text, reply: '', statuses: [], calls: [], said: [], usage: [], modelCalls: 0, modelMs: 0, nudges: 0, emptyReplies: 0, confirmations: 0, ms: 0 };
    turns.push(current);
  }

  /** One message to PiRick and its reply, added to the record of the current request. */
  async function exchange(act) {
    current.startedAt = Date.now();
    current.nudgesNow = 0;
    current.reply = '';
    const emit = (event) => {
      if (event.type === 'delta') current.reply += event.text;
      else if (event.type === 'status') current.statuses.push(event.text);
    };
    try {
      await act(emit);
    } catch (err) {
      current.error = describeError(err);
    }
    current.ms += Date.now() - current.startedAt;
    current.nudges += current.nudgesNow;
    current.stuck = current.reply.startsWith(STUCK);
    current.blank = current.reply.startsWith(BLANK);
    delete current.startedAt;
    delete current.nudgesNow;
    return current;
  }

  return {
    /** Sends one message as the user and waits for PiRick to finish with it. Resolves to the record of the request. */
    say(text) {
      begin(text);
      return exchange((emit) => agent.runTurn(user, text, emit));
    },
    /** The user answers something PiRick asked. It counts as part of the same request. */
    answer(text) {
      current.asked = current.reply;
      current.answered = text;
      current.confirmations += 1;
      return exchange((emit) => agent.runTurn(user, text, emit));
    },
    /** The user opens the chat again after being away. */
    comeBack() {
      begin('(comes back to the chat)');
      return exchange((emit) => agent.catchUp(user, emit));
    },

    /** Everything that happened, in the form scenario checks and the report read. */
    trace() {
      const replies = turns.map((entry) => entry.reply);
      return {
        turns,
        added,
        searches,
        calls: turns.flatMap((entry) => entry.calls),
        reply: replies.at(-1) ?? '',
        flags: {
          refusal: replies.some((reply) => REFUSAL.test(reply)),
          jargon: replies.some((reply) => JARGON.test(reply)),
          markup: replies.some((reply) => MARKUP.test(reply)),
        },
      };
    },

    close() {
      db.close();
    },
  };
}

/**
 * A model that follows a script, for testing scenarios without a real one.
 * Each step is a reply, or a function of the messages so far that returns one.
 */
export function scripted(steps) {
  let at = 0;
  return {
    async chat({ messages, onDelta }) {
      const step = steps[at++];
      if (!step) throw new Error('The script ran out of replies');
      const reply = structuredClone(typeof step === 'function' ? step(messages) : step);
      if (reply.content) onDelta?.(reply.content);
      return reply;
    },
  };
}
