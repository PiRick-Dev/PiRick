import { randomInt } from 'node:crypto';
import { describeError } from './errors.js';
import { cleanFolderName, findFolder, joinPath, splitPath, titleFromRelease } from './folders.js';
import { log } from './log.js';
import { BASE_TAG, formatBytes, userTag } from './qbittorrent.js';

const SEARCH_TYPES = ['movie', 'tv', 'anime', 'music', 'book', 'game', 'software', 'any'];
// Torznab category ids, which Jackett maps onto every indexer.
const TORZNAB_CATEGORIES = {
  movie: [2000],
  tv: [5000],
  // Indexers file anime under TV (5070 is TV/Anime) or, for films, under Movies.
  anime: [5000, 2000],
  music: [3000],
  book: [7000],
  game: [1000, 4050],
  software: [4000],
  any: [],
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_PER_USER = 300;
const MAX_DOWNLOADS_PER_TURN = 10;
const MAX_LISTED_DOWNLOADS = 20;
// No 0/o, 1/l/i: ids are copied by a language model and read by people.
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const SEARCH_DEFINITION = {
  type: 'function',
  function: {
    name: 'search_media',
    description:
      'Search for a movie, TV show, anime, album, book, game or other file. Returns matching results, most available first, each with an id.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Short search keywords: the title plus, when known, the year, season or episode (S02 or S02E05) or quality. Example: "The General 1926 1080p".',
        },
        media_type: {
          type: 'string',
          enum: SEARCH_TYPES,
          description: 'What kind of thing is being looked for. Use "any" when unsure.',
        },
      },
      required: ['query'],
    },
  },
};

const LIST_DEFINITION = {
  type: 'function',
  function: {
    name: 'list_downloads',
    description: 'Show the progress of the things this user has asked for, newest first.',
    parameters: { type: 'object', properties: {} },
  },
};

/** The download tool offers exactly the libraries an admin has set up, so none can be made up. */
function downloadDefinition(libraries) {
  const properties = {
    result_id: { type: 'string', description: 'The id of the chosen search result.' },
  };
  const required = ['result_id'];
  if (libraries.length) {
    properties.library = {
      type: 'string',
      enum: libraries.map((library) => library.name),
      description: 'Which library it belongs in: the most specific one that fits.',
    };
    required.push('library');
  }
  if (libraries.some((library) => library.perTitle)) {
    properties.title = {
      type: 'string',
      description:
        'The plain, usual English name of the show, film or album, for example "The Perils of Pauline". No year, season, episode or quality.',
    };
    properties.new_folder = {
      type: 'boolean',
      description: 'Set to true only after download reported similar folders and this is a different show.',
    };
    required.push('title');
  }
  return {
    type: 'function',
    function: {
      name: 'download',
      description: 'Start downloading one search result into a library. Only works with an id returned by search_media.',
      parameters: { type: 'object', properties, required },
    },
  };
}

function newId() {
  let id = '';
  for (let i = 0; i < 4; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

/** What the indexer filed a result under, when that says something useful. */
function kindOf(categories) {
  if (categories.includes(5070)) return 'anime';
  for (const id of categories) {
    if (id >= 2000 && id < 3000) return 'movie';
    if (id >= 5000 && id < 6000) return 'tv';
    if (id >= 3000 && id < 4000) return 'music';
    if (id >= 7000 && id < 8000) return 'book';
  }
  return undefined;
}

function age(published) {
  const time = Date.parse(published ?? '');
  // Indexers that do not know the date report year 1.
  if (Number.isNaN(time) || time < Date.UTC(1990, 0, 1)) return undefined;
  const days = Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
  if (days < 1) return 'today';
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return `${Math.round(days / 365)} years`;
}

/** Indexers name episodes S01E05; people and models write "season 1 episode 5". */
export function normaliseQuery(query) {
  return String(query ?? '')
    .replace(/\bseason\s*(\d{1,2})(?:\s*,?\s*episode\s*(\d{1,3}))?\b/gi, (match, season, episode) =>
      `S${season.padStart(2, '0')}${episode ? `E${episode.padStart(2, '0')}` : ''}`,
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * A hint for the model when one search returned releases from several years,
 * which usually means different films or shows that share a name.
 */
export function differentReleasesNote(query, titles) {
  const year = /\b(?:19|20)\d{2}\b/;
  if (year.test(query) || /\bS\d{1,2}(?:E\d{1,3})?\b/i.test(query)) return undefined;
  const years = new Set(titles.map((title) => year.exec(title)?.[0]).filter(Boolean));
  if (years.size < 2) return undefined;
  return `These results are from different years (${[...years].sort().join(', ')}), so they may be different films or shows with the same name. Unless the user already said which one they want, ask them before downloading.`;
}

/** Per-user store of recent search results, so the model only ever handles ids. */
function createResultCache() {
  const byUser = new Map();
  return {
    put(userId, result) {
      let entries = byUser.get(userId);
      if (!entries) byUser.set(userId, (entries = new Map()));
      let id;
      do id = newId();
      while (entries.has(id));
      entries.set(id, { result, expires: Date.now() + CACHE_TTL_MS });
      while (entries.size > CACHE_MAX_PER_USER) entries.delete(entries.keys().next().value);
      return id;
    },
    get(userId, id) {
      const entry = byUser.get(userId)?.get(id);
      return entry && entry.expires > Date.now() ? entry.result : null;
    },
    clear(userId) {
      byUser.delete(userId);
    },
  };
}

export function createTools({ config, jackett, qbit, settings }) {
  const cache = createResultCache();

  // Admins see the technical reason in the chat; everyone else gets it in the log only.
  const detail = (user, err) => (user.role === 'admin' ? ` (${describeError(err)})` : '');

  /**
   * Works out where in a library a download goes. Returns `{ savePath, label }`,
   * or `{ reply }` when the model has to be told something instead.
   *
   * `folders` is what qBittorrent says is inside the library folder, or null
   * when it could not say.
   */
  function destination(library, folders, result, args, turn, id) {
    if (!library.perTitle) return { savePath: library.savePath, label: library.name };

    const title = cleanFolderName(args.title) || titleFromRelease(result.title);
    if (!title) {
      return { reply: { ok: false, error: `${library.name} keeps each show in its own folder. Call download again with title set to the name of the show.` } };
    }
    let folder = title;
    // Only claim the folder is new when qBittorrent confirmed it is not there.
    let created = Boolean(folders);
    if (folders) {
      const found = findFolder(title, folders);
      if (found.match) {
        // Reuse the folder that is already there, with its own spelling and capitals.
        folder = found.match;
        created = false;
      } else if (found.similar && args.new_folder !== true && !turn.folderQuestions.has(id)) {
        // Let the model, which may know two names are one show, decide. Once only.
        turn.folderQuestions.add(id);
        return {
          reply: {
            ok: false,
            not_downloaded_yet: true,
            existing_folders: found.similar,
            error: `Nothing was downloaded yet. ${library.name} has no "${title}" folder, but the existing folders listed here look similar. If one of them is the same show, call download again with title set to exactly that folder name. If this is a different show, call download again with the same title and new_folder set to true.`,
          },
        };
      }
    }
    return {
      savePath: joinPath(library.savePath, folder),
      label: `${library.name} / ${folder}${created ? ' (new folder)' : ''}`,
    };
  }

  const handlers = {
    async search_media(user, args, turn) {
      const query = normaliseQuery(args.query);
      const mediaType = SEARCH_TYPES.includes(args.media_type) ? args.media_type : 'any';
      if (!query) return { error: 'A query is required.' };

      turn.searched = true;
      // A model that is going round in circles gets the same answer, not a new search.
      const searchKey = `${mediaType}|${query.toLowerCase()}`;
      if (turn.searches.has(searchKey)) {
        return {
          ...turn.searches.get(searchKey),
          note: 'You already ran this exact search in this turn. Use these results: call download with one of the ids, or answer the user.',
        };
      }
      turn.emit({ type: 'working', text: `Searching for “${query}”…` });
      let found;
      try {
        found = await jackett.search(query, TORZNAB_CATEGORIES[mediaType]);
      } catch (err) {
        log.warn('search failed', { user: user.username, query, error: describeError(err) });
        turn.status(`The search for “${query}” failed${detail(user, err)}`, 'error');
        return { error: 'The search service is not working right now. Tell the user to try again later or let the admin know.' };
      }

      const results = found.slice(0, config.searchLimit).map((result) => ({
        id: cache.put(user.id, result),
        title: result.title,
        kind: kindOf(result.categories),
        size: formatBytes(result.size),
        seeders: result.seeders,
        age: age(result.published),
      }));
      log.info('search', { user: user.username, query, mediaType, results: results.length });
      const count = results.length === 1 ? '1 result' : `${results.length} results`;
      turn.status(`Searched for “${query}”: ${results.length ? count : 'nothing found'}`, 'search');
      const note = differentReleasesNote(query, results.map((result) => result.title));
      const output = results.length
        ? {
            results,
            ...(note && { note }),
            // Said here, at the point of decision, because small models otherwise
            // tend to announce a download without making the call.
            next_step: note
              ? 'Nothing is downloading yet. Once you know which one the user wants, call download with its id.'
              : 'Nothing is downloading yet. To get one of these, call download with its id; it also tells you if the user already has it.',
          }
        : { results: [], note: 'Nothing found. Try simpler keywords, or tell the user you could not find it.' };
      turn.searches.set(searchKey, output);
      return output;
    },

    // Only a definite outcome sets turn.succeeded or turn.failed. Replies that ask
    // the model to call again (bad id, bad library, similar folders) set neither,
    // so a "started downloading" claim made after one of them is still caught.
    async download(user, args, turn) {
      const libraries = settings.libraries();
      if (!libraries.length) {
        turn.failed = true;
        turn.status('Not downloaded: PiRick has no libraries set up yet', 'error');
        return {
          ok: false,
          error: 'PiRick has no libraries set up yet, so nothing can be downloaded. Tell the user an admin needs to add one first (Admin, then Libraries).',
        };
      }
      const id = String(args.result_id ?? args.id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const result = cache.get(user.id, id);
      if (!result) {
        return { ok: false, error: 'No search result has that id. Call search_media again and use an id from its results.' };
      }
      if (turn.downloads >= MAX_DOWNLOADS_PER_TURN) {
        turn.failed = true;
        return { ok: false, error: `Already started ${MAX_DOWNLOADS_PER_TURN} downloads for this message. Ask the user before adding more.` };
      }
      if (config.maxTorrentBytes && result.size > config.maxTorrentBytes) {
        return {
          ok: false,
          error: `That one is ${formatBytes(result.size)}, over the ${formatBytes(config.maxTorrentBytes)} limit. Choose a smaller version.`,
        };
      }
      const library = libraries.length === 1 && !args.library ? libraries[0] : settings.findLibrary(args.library);
      if (!library) {
        const names = libraries.map((entry) => `"${entry.name}"`).join(', ');
        return { ok: false, error: `Call download again with library set to one of: ${names}.` };
      }

      const tags = [BASE_TAG, userTag(user.username)];
      turn.emit({ type: 'working', text: 'Starting the download…' });
      let label;
      try {
        if (result.infoHash) {
          const existing = await qbit.find(result.infoHash);
          if (existing) {
            await qbit.addTags(result.infoHash, tags);
            const finished = existing.status === 'finished';
            turn.succeeded = true;
            turn.status(`${finished ? 'Already downloaded' : 'Already downloading'}: ${result.title}`, 'download');
            return {
              ok: true,
              already_have_it: true,
              title: result.title,
              state: finished ? 'finished, already in Plex' : `in progress, ${existing.progress}% done`,
              note: finished
                ? 'Nothing new was started. Tell the user it is already in Plex.'
                : 'Nothing new was started. Tell the user it is already downloading and not finished yet.',
            };
          }
        }

        const listing = await qbit.listFolders(library.savePath);
        if (listing && !listing.exists) {
          // Saving here would make qBittorrent create the folder, which is how a
          // mistyped path turns into a stray folder. Refuse instead.
          turn.failed = true;
          log.warn('library folder missing', { library: library.name, path: library.savePath });
          turn.status(
            `Not downloaded: the ${library.name} library's folder does not exist${user.role === 'admin' ? ` (${library.savePath})` : ''}`,
            'error',
          );
          return {
            ok: false,
            error: `Nothing was downloaded: the ${library.name} library is not set up correctly. Tell the user to ask the admin to check its folder (Admin, then Libraries).`,
          };
        }

        let folders = listing?.names ?? null;
        if (library.perTitle) {
          // A new show's folder is not on disk until data arrives, so also count
          // the folders qBittorrent has already been told to use in this library.
          const pending = (await qbit.savePaths())
            .map((path) => splitPath(path))
            .filter(({ parent }) => parent === library.savePath)
            .map(({ name }) => name);
          if (pending.length) folders = [...new Set([...(folders ?? []), ...pending])];
        }
        const place = destination(library, folders, result, args, turn, id);
        if (place.reply) return place.reply;
        label = place.label;

        const source = await jackett.resolve(result);
        await qbit.add({ ...source, category: library.category, savePath: place.savePath, tags });
        log.info('download started', {
          user: user.username,
          title: result.title,
          size: result.size,
          indexer: result.indexer,
          library: library.name,
          savePath: place.savePath,
        });
      } catch (err) {
        turn.failed = true;
        log.warn('download failed', { user: user.username, title: result.title, error: describeError(err) });
        turn.status(`Could not start the download: ${result.title}${detail(user, err)}`, 'error');
        return { ok: false, error: 'The download could not be started. Tell the user to try again later or let the admin know.' };
      }

      turn.succeeded = true;
      turn.downloads += 1;
      turn.status(`Started downloading: ${result.title} (${formatBytes(result.size)}) → ${label}`, 'download');
      return {
        ok: true,
        title: result.title,
        size: formatBytes(result.size),
        saved_in: label,
        note: 'Download started. It will appear in Plex when it finishes.',
      };
    },

    async list_downloads(user, args, turn) {
      turn.listed = true;
      turn.emit({ type: 'working', text: 'Checking your downloads…' });
      let downloads;
      try {
        downloads = await qbit.list(userTag(user.username));
      } catch (err) {
        log.warn('list downloads failed', { user: user.username, error: describeError(err) });
        turn.status(`Could not check the downloads${detail(user, err)}`, 'error');
        return { error: 'The download service is not working right now. Tell the user to try again later.' };
      }
      return {
        downloads: downloads.slice(0, MAX_LISTED_DOWNLOADS).map((item) => ({
          name: item.name,
          status: item.status,
          progress: `${item.progress}%`,
          minutes_left: item.etaSeconds == null ? undefined : Math.ceil(item.etaSeconds / 60),
        })),
      };
    },
  };

  return {
    /** The tool definitions for one turn. They follow the libraries as they are now. */
    definitions: () => [SEARCH_DEFINITION, downloadDefinition(settings.libraries()), LIST_DEFINITION],

    /** What the tools record about one user message as the model works on it. */
    newTurn: (emit, status) => ({
      emit,
      status,
      downloads: 0,
      searched: false,
      succeeded: false,
      failed: false,
      listed: false,
      searches: new Map(),
      folderQuestions: new Set(),
    }),

    /** Runs one tool call from the model and returns the JSON-serialisable result. */
    async run(user, call, turn) {
      const name = call?.function?.name;
      let args = call?.function?.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = null;
        }
      }
      if (!args || typeof args !== 'object') args = {};
      if (!Object.hasOwn(handlers, name)) return { error: `There is no tool called "${name}".` };
      try {
        return await handlers[name](user, args, turn);
      } catch (err) {
        log.error('tool crashed', { tool: name, error: err?.stack ?? String(err) });
        return { error: 'That did not work because of an internal problem.' };
      }
    },

    forget(userId) {
      cache.clear(userId);
    },
  };
}
