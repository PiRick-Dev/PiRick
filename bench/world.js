// A throwaway PiRick for one benchmark run: the real agent, prompt and tools,
// with in-process stand-ins for Jackett, qBittorrent, Plex and the catalogue
// and a record of everything the model did. Nothing here can reach a real
// service except the model it is handed.
import { createAgent } from '../src/agent.js';
import { createCatalogue } from '../src/catalogue.js';
import { loadConfig } from '../src/config.js';
import { createConversation } from '../src/conversation.js';
import { openDb } from '../src/db.js';
import { UpstreamError, describeError } from '../src/errors.js';
import { hashFromMagnet } from '../src/jackett.js';
import { createNews } from '../src/news.js';
import { createPlex } from '../src/plex.js';
import { BASE_TAG, toDownload, userTag } from '../src/qbittorrent.js';
import { createSettings } from '../src/settings.js';
import { createTools } from '../src/tools.js';
import { createUpkeep } from '../src/upkeep.js';
import { SERVICES, catalogueStandIn } from './catalogue.js';
import * as CORPUS from './corpus.js';
import { PLEX_TOKEN, PLEX_URL, plexStandIn } from './plex.js';
import { WORLD } from './works.js';

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
 *   news         what is new in PiRick since the user was last told, as sentences
 *                like those in its own list (src/news.js)
 *   plex       connects a Plex server that already has { films: [{ title, year }],
 *                shows: [{ title, year, seasons: { 1: 10 } }] }. Without it PiRick
 *                runs with no Plex, as it does when none is set up
 *   folders      folders on disk besides the usual ones: { '/media/TV': ['Name'] }
 *   catalogue    switches on the catalogue of what exists, which knows the films and
 *                shows in works.js, or those given in their place as { films, shows,
 *                mostRead }. Without it PiRick runs with none, as it does when none
 *                is switched on
 * `connect(onUsage)` returns the model: an object with `chat()`, as createOllama gives.
 * `using` swaps parts of the world for others: `corpus` for what the indexer has
 * ({ search, byHash, byTitle }), `catalogue` for a catalogue client of one's own,
 * `plex` for a Plex client of one's own.
 */
export function createWorld(setup = {}, connect, using = {}) {
  const { byHash, byTitle, search } = using.corpus ?? CORPUS;
  const db = openDb(':memory:');
  const { lastInsertRowid } = db
    .prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, 'none', 'user', ?)")
    .run(USERNAME, Date.now());
  const user = { id: Number(lastInsertRowid), username: USERNAME, role: 'user' };
  const tags = [BASE_TAG, userTag(USERNAME)];

  const settings = createSettings(db);
  for (const library of setup.libraries ?? LIBRARIES) settings.addLibrary(library);
  // The scenario's personality is the usual one, which is what its user hears.
  if (setup.personality) settings.setUsualPersonality(settings.addPersonality({ name: 'Benchmark', text: setup.personality }).id);
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

  const folders = Object.fromEntries(Object.entries(FOLDERS).map(([path, names]) => [path, [...names, ...(setup.folders?.[path] ?? [])]]));
  // Plex sees the same folders under another path, as it does from inside its own container.
  const plexServer = setup.plex
    ? plexStandIn([
        { key: '1', title: 'Films', type: 'movie', folders: ['/data/Movies'], items: setup.plex.films ?? [] },
        { key: '2', title: 'TV Shows', type: 'show', folders: ['/data/TV'], items: setup.plex.shows ?? [] },
        { key: '3', title: 'Anime', type: 'show', folders: ['/data/Anime'], items: [] },
      ])
    : null;
  const plex = using.plex ?? createPlex(plexServer ? { url: PLEX_URL, token: PLEX_TOKEN, timeoutMs: 5000 } : { url: '', token: '' }, { fetch: plexServer?.fetch });
  const catalogueServices = setup.catalogue ? catalogueStandIn(setup.catalogue === true ? WORLD : setup.catalogue) : null;
  const catalogue = using.catalogue ?? createCatalogue({ enabled: Boolean(catalogueServices), ...SERVICES, timeoutMs: 5000 }, { fetch: catalogueServices?.fetch });

  const qbit = {
    listFolders: async (path) => (Object.hasOwn(folders, path) ? { exists: true, names: [...folders[path]] } : { exists: false, names: [] }),
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
  const upkeep = createUpkeep({ db, qbit, jackett, settings, config, plex });
  const realTools = createTools({ config, jackett, qbit, settings, upkeep, plex, catalogue });
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
  // The scenario's own news and never PiRick's, so that no run shifts when PiRick's list grows.
  const news = createNews({
    db,
    has: () => ({ catalogue: catalogue.enabled, personalities: settings.personalities().length > 0 }),
    entries: (setup.news ?? []).map((text, i) => ({ id: i + 1, text })),
  });
  const agent = createAgent({ ollama, tools, conversation: createConversation(db), settings, upkeep, plex, catalogue, news });

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

    /** The stand-in Plex server, when the scenario has one. */
    plexServer,
    /** The stand-in for the catalogue's services, when the scenario has one. */
    catalogueServices,

    close() {
      db.close();
    },
  };
}

/**
 * A world to talk to with a model whose replies are scripted as the talk goes,
 * for tests. `say(text, calls, reply)` is one message from the user, which the
 * model answers with these tool calls in order and then with `reply` in words.
 * A call may be a function of the tool outputs so far in that message. Resolves
 * to those outputs in full, the record of the request, and the prompt and tools
 * the model was given.
 */
export function talkTo(setup = {}, using = {}) {
  const queue = [];
  let seen = [];
  let offered = [];
  let asked = '';
  const outputs = () => seen.slice(seen.findLastIndex((message) => message.role === 'user' && message.content === asked)).filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
  const world = createWorld(
    setup,
    () => ({
      async chat({ messages, tools, onDelta }) {
        seen = messages;
        offered = tools ?? offered;
        const step = queue.shift();
        if (!step) throw new Error('The script ran out of replies');
        const reply = structuredClone(typeof step === 'function' ? step(outputs()) : step);
        if (reply.content) onDelta?.(reply.content);
        return reply;
      },
    }),
    using,
  );
  return {
    world,
    async say(text, calls, reply) {
      asked = text;
      queue.push(...calls, { role: 'assistant', content: reply });
      const record = await world.say(text);
      if (queue.length) throw new Error(`${queue.length} scripted repl${queue.length === 1 ? 'y was' : 'ies were'} not used`);
      return { record, outputs: outputs(), prompt: seen[0].content, tools: offered };
    },
    close: () => world.close(),
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
