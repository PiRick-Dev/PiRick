import { randomInt } from 'node:crypto';
import { describeError } from './errors.js';
import { cleanFolderName, findFolder, joinPath, splitPath, titleFromRelease } from './folders.js';
import { log } from './log.js';
import { BASE_TAG, formatBytes, userTag } from './qbittorrent.js';
import { describeContents, describePart, parseRelease, planShow } from './releases.js';
import { createFinder } from './search.js';
import { infoHashOf } from './torrentfile.js';

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
const MAX_PLAN_TORRENTS = 200;
const MAX_LISTED_DOWNLOADS = 20;
// No 0/o, 1/l/i: ids are copied by a language model and read by people.
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const SEARCH_DEFINITION = {
  type: 'function',
  function: {
    name: 'search_media',
    description:
      'Search for a movie, an album, a book, a game or another file. Returns matching results, most available first, each with an id. For TV shows and anime, use find_show instead.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The title and, when known, the year or quality, and nothing else. Example: "The General 1926". Never add actors, directors or a description: release names do not contain them.',
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

const FIND_SHOW_DEFINITION = {
  type: 'function',
  function: {
    name: 'find_show',
    description:
      'Find the best way to get a TV show or anime: the whole show, one season, or one episode. Returns a plan with one id that covers what was asked in the fewest downloads: a complete pack if there is a good one, otherwise season packs, otherwise single episodes. Use this for anything that is a TV show or anime.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The name of the show, for example "The Perils of Pauline". Add a year only to tell apart two shows with the same name.',
        },
        season: {
          type: 'integer',
          description: 'The season number, when the user wants one season or an episode of it. Leave out for the whole show.',
        },
        episode: {
          type: 'integer',
          description: 'The episode number, only when the user wants one single episode.',
        },
        quality: {
          type: 'string',
          enum: ['2160p', '1080p', '720p', '480p'],
          description: 'Only when the user asks for a particular quality. The default is 1080p.',
        },
      },
      required: ['title'],
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
    result_id: { type: 'string', description: 'The id of the chosen search result, or the plan id from find_show.' },
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
      description:
        'Start downloading a search result, or everything in a find_show plan, into a library. Only works with an id returned by search_media or find_show.',
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
  const year = /\b(?:19|20)\d{2}\b/g;
  if (query.match(year) || /\bS\d{1,2}(?:E\d{1,3})?\b/i.test(query)) return undefined;
  const dated = titles.map((title) => title.match(year) ?? []).filter((found) => found.length);
  // A year that every result carries is the film's own: "Seven.Chances.2013.REMASTERED.1925"
  // is still the 1980 film, not a different one.
  if (dated.length && dated[0].some((candidate) => dated.every((found) => found.includes(candidate)))) return undefined;
  const years = new Set(dated.map((found) => found[0]));
  if (years.size < 2) return undefined;
  return `These results are from different years (${[...years].sort().join(', ')}), so they may be different films or shows with the same name. Unless the user already said which one they want, ask them before downloading.`;
}

const listOf = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : String(items[0]));

/** A plan in a few plain words: "seasons 1 and 2 as packs, season 3 as 8 single episodes". */
export function planSummary(plan) {
  if (plan.parts.length === 1 && plan.parts[0].type === 'series') return 'the complete series in one pack';
  const bits = plan.parts
    .filter((part) => part.type === 'series' || part.type === 'seasons')
    .map((part) => `${describePart(part).toLowerCase()} in one pack`);
  const packs = plan.parts.filter((part) => part.type === 'season').map((part) => part.seasons[0]);
  if (packs.length) bits.push(packs.length === 1 ? `season ${packs[0]} as a pack` : `seasons ${listOf(packs)} as packs`);
  for (const part of plan.parts.filter((entry) => entry.type === 'episodes')) {
    bits.push(`season ${part.seasons[0]} as ${part.releases.length} single episode${part.releases.length === 1 ? '' : 's'}`);
  }
  return bits.join(', ');
}

/** Per-user store of recent search results and plans, so the model only ever handles ids. */
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

export function createTools({ config, jackett, qbit, settings, upkeep }) {
  const cache = createResultCache();
  const finder = createFinder(jackett, config.jackett);
  // Searches can take a while behind a Cloudflare solver, so each one is announced.
  const announce = (turn) => (spelling) => turn.emit({ type: 'working', text: `Searching for “${spelling}”…` });

  // Admins see the technical reason in the chat; everyone else gets it in the log only.
  const detail = (user, err) => (user.role === 'admin' ? ` (${describeError(err)})` : '');

  /**
   * Works out where in a library a download goes. Returns `{ savePath, label }`,
   * or `{ reply }` when the model has to be told something instead.
   *
   * `folders` is what qBittorrent says is inside the library folder, or null
   * when it could not say. `name` is the release or show being saved.
   */
  function destination(library, folders, name, args, turn, id) {
    if (!library.perTitle) return { savePath: library.savePath, label: library.name };

    const title = cleanFolderName(args.title) || titleFromRelease(name);
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

  /**
   * Checks the library's folder and works out the destination. Returns
   * `{ savePath, label }`, or `{ reply }` to hand straight back to the model.
   */
  async function place(user, library, name, args, turn, id) {
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
        reply: {
          ok: false,
          error: `Nothing was downloaded: the ${library.name} library is not set up correctly. Tell the user to ask the admin to check its folder (Admin, then Libraries).`,
        },
      };
    }
    let folders = listing?.names ?? null;
    if (library.perTitle) {
      // A new show's folder is not on disk until data arrives, so also count
      // the folders qBittorrent has already been told to use in this library.
      const pending = (await qbit.savePaths())
        .map((path) => splitPath(path))
        .filter(({ parent }) => parent === library.savePath)
        .map(({ name: folder }) => folder);
      if (pending.length) folders = [...new Set([...(folders ?? []), ...pending])];
    }
    return destination(library, folders, name, args, turn, id);
  }

  /**
   * Hands one release to qBittorrent unless it is already there. Resolves to
   * the existing torrent (as `qbit.find` gives it) or null when it was added.
   */
  async function addUnlessPresent(release, target) {
    let hash = release.infoHash;
    let existing = hash ? await qbit.find(hash) : null;
    if (!existing) {
      const source = await jackett.resolve(release);
      // A result that only had a link reveals its identity once the file is fetched.
      if (source.file && !hash) {
        hash = infoHashOf(source.file);
        existing = hash ? await qbit.find(hash) : null;
      }
      if (!existing) {
        await qbit.add({ ...source, ...target });
        return null;
      }
    }
    await qbit.addTags(hash, target.tags);
    return existing;
  }

  /** Downloads every release in a find_show plan into one place. */
  async function downloadPlan(user, entry, library, args, turn, id) {
    const spot = await place(user, library, entry.show, args, turn, id);
    if (spot.reply) return spot.reply;
    const target = { category: library.category, savePath: spot.savePath, tags: [BASE_TAG, userTag(user.username)] };
    const total = entry.parts.reduce((sum, part) => sum + part.releases.length, 0);
    const counts = { started: 0, already: 0, failed: 0 };
    let done = 0;
    // "(new folder)" is worth saying once, on the first line, not on every part.
    let label = spot.label;

    for (const part of entry.parts) {
      const outcome = { started: 0, already: 0, failed: 0 };
      for (const release of part.releases) {
        done += 1;
        if (total > 1) turn.emit({ type: 'working', text: `Starting download ${done} of ${total}…` });
        try {
          outcome[(await addUnlessPresent(release, target)) ? 'already' : 'started'] += 1;
        } catch (err) {
          outcome.failed += 1;
          log.warn('download failed', { user: user.username, title: release.title, error: describeError(err) });
        }
      }
      for (const key of Object.keys(counts)) counts[key] += outcome[key];

      // One line per pack; single episodes are summed up rather than listed.
      const what = part.type === 'episodes' && part.releases.length > 1 ? `${part.releases.length} single episodes of season ${part.seasons[0]}` : part.releases[0].title;
      const size = formatBytes(part.releases.reduce((sum, release) => sum + release.size, 0));
      if (outcome.started) {
        const extra = [outcome.already && `${outcome.already} already there`, outcome.failed && `${outcome.failed} could not be started`].filter(Boolean);
        const count = part.type === 'episodes' && outcome.started < part.releases.length ? `${outcome.started} of ` : '';
        turn.status(`Started downloading: ${count}${what} (${size}) → ${label}${extra.length ? ` (${extra.join(', ')})` : ''}`, 'download');
        label = label.replace(' (new folder)', '');
      } else if (outcome.already) {
        turn.status(`Already have: ${what}`, 'download');
      } else {
        turn.status(`Could not start the download: ${what}`, 'error');
      }
    }
    log.info('plan downloaded', { user: user.username, show: entry.show, library: library.name, savePath: spot.savePath, ...counts });

    if (!counts.started && !counts.already) {
      turn.failed = true;
      return { ok: false, error: 'None of the downloads could be started. Tell the user to try again later or let the admin know.' };
    }
    turn.succeeded = true;
    turn.downloads += 1;
    return {
      ok: true,
      downloads_started: counts.started,
      already_had: counts.already || undefined,
      could_not_start: counts.failed || undefined,
      saved_in: spot.label,
      note: counts.started
        ? 'Downloads started. They will appear in Plex as they finish.'
        : 'Nothing new was started: the user already has all of this, or it is already on its way.',
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
      let found;
      let also;
      let exact;
      let foundAs;
      try {
        // Searches other spellings too ("7 Chances" is released as "Seven.Chances") and
        // drops results that are not about what was asked for.
        ({ results: found, also, exact, foundAs } = await finder.search(query, TORZNAB_CATEGORIES[mediaType], { onTry: announce(turn) }));
      } catch (err) {
        log.warn('search failed', { user: user.username, query, error: describeError(err) });
        turn.status(`The search for “${query}” failed${detail(user, err)}`, 'error');
        return { error: 'The search service is not working right now. Tell the user to try again later or let the admin know.' };
      }

      const shown = found.slice(0, config.searchLimit);
      const contents = shown.map((result) => parseRelease(result.title));
      const results = shown.map((result, i) => ({
        id: cache.put(user.id, result),
        title: result.title,
        kind: kindOf(result.categories),
        contains: describeContents(contents[i]),
        size: formatBytes(result.size),
        seeders: result.seeders,
        age: age(result.published),
      }));
      log.info('search', { user: user.username, query, also, mediaType, results: results.length, exact });
      const count = results.length === 1 ? '1 result' : `${results.length} results`;
      const outcome = !results.length ? 'nothing found' : exact ? count : 'nothing that clearly matches';
      const others = also.length === 1 ? ' and 1 other spelling' : ` and ${also.length} other spellings`;
      const how = foundAs ? ` (found as “${foundAs}”)` : also.length ? others : '';
      turn.status(`Searched for “${query}”${how}: ${outcome}`, 'search');

      const notes = [differentReleasesNote(query, results.map((result) => result.title))];
      if (!exact && results.length) {
        notes.push('None of these clearly match what was searched for, so they are probably unrelated. Do not download one unless it is plainly the right thing. Otherwise search again with only the title, or ask the user to check it.');
      }
      const singles = contents.filter((parsed) => parsed.kind === 'episode').length;
      if (results.length > 1 && singles * 2 >= results.length && !/\bS\d{1,2} ?E\d/i.test(query)) {
        notes.push('Most of these are single episodes. If the user wants a whole season or a whole show, call find_show instead: it finds packs, so it takes far fewer downloads.');
      }
      const note = notes.filter(Boolean).join(' ') || undefined;
      const output = results.length
        ? {
            results,
            ...(note && { note }),
            // Said here, at the point of decision, because small models otherwise
            // tend to announce a download without making the call.
            next_step: notes[0]
              ? 'Nothing is downloading yet. Once you know which one the user wants, call download with its id.'
              : 'Nothing is downloading yet. To get one of these, call download with its id; it also tells you if the user already has it.',
          }
        : { results: [], note: 'Nothing found. Search again with only the title and the year (no names of people, no extra words), or tell the user you could not find it.' };
      turn.searches.set(searchKey, output);
      return output;
    },

    async find_show(user, args, turn) {
      const title = String(args.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!title) return { error: 'A title is required.' };
      const whole = (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);
      const season = whole(args.season);
      const episode = whole(args.episode);
      const quality = Number.parseInt(args.quality, 10) || 1080;
      const scope = episode ? (season ? `season ${season} episode ${episode} of ` : `episode ${episode} of `) : season ? `season ${season} of ` : '';
      const what = `${scope}“${title}”`;

      turn.searched = true;
      const searchKey = `show|${title.toLowerCase()}|${season}|${episode}|${quality}`;
      if (turn.searches.has(searchKey)) {
        return { ...turn.searches.get(searchKey), note: 'You already looked this up in this turn. Call download with the plan id, or answer the user.' };
      }
      turn.emit({ type: 'working', text: `Looking for the best way to get ${what}…` });
      const options = { title, season, episode, quality, maxBytes: config.maxTorrentBytes, atOnce: config.jackett.searchesAtOnce };
      let found;
      try {
        // planShow decides for itself which releases are this show, so only the other spellings are wanted here.
        const search = async (query) => (await finder.search(query, TORZNAB_CATEGORIES.tv, { filter: false, onTry: announce(turn) })).results;
        found = await planShow(search, options);
      } catch (err) {
        log.warn('show search failed', { user: user.username, title, error: describeError(err) });
        turn.status(`The search for ${what} failed${detail(user, err)}`, 'error');
        return { error: 'The search service is not working right now. Tell the user to try again later or let the admin know.' };
      }

      let output;
      if (found.others) {
        turn.status(`Looked for ${what}: several different shows match`, 'search');
        output = { found: false, different_shows: found.others, note: 'Several different shows match that name. Ask the user which one they mean, then call find_show again with that exact name.' };
      } else if (found.years) {
        turn.status(`Looked for ${what}: more than one show has this name`, 'search');
        output = { found: false, first_released: found.years, note: 'More than one show has this name; these are the years each began. Ask the user which one they mean, then call find_show again with that year added to the title.' };
      } else if (!found.plan.torrents) {
        turn.status(`Looked for ${what}: nothing found`, 'search');
        output = { found: false, note: 'Nothing found. Check the spelling of the title, or tell the user you could not find it.' };
      } else if (found.plan.torrents > MAX_PLAN_TORRENTS) {
        turn.status(`Looked for ${what}: it would take ${found.plan.torrents} separate downloads`, 'search');
        output = {
          found: true,
          downloads_needed: found.plan.torrents,
          note: `Getting all of it would take ${found.plan.torrents} separate downloads, more than the limit of ${MAX_PLAN_TORRENTS} for one request. Ask the user which seasons they want, then call find_show for each season.`,
        };
      } else {
        const { plan, show } = found;
        const sizeOf = (releases) => releases.reduce((sum, release) => sum + release.size, 0);
        const total = formatBytes(sizeOf(plan.parts.flatMap((part) => part.releases)));
        // For one episode the release name says more than "1 single episode".
        const summary = episode ? plan.parts[0].releases[0].title : planSummary(plan);
        const id = cache.put(user.id, { plan: true, show, title: `${show}: ${summary}`, parts: plan.parts });
        log.info('show plan', { user: user.username, title, season, episode, torrents: plan.torrents, summary });
        turn.status(`Found ${what}: ${summary} (${total})`, 'search');
        output = {
          plan: {
            id,
            show,
            gets: plan.parts.map((part) => ({
              what: describePart(part),
              size: formatBytes(sizeOf(part.releases)),
              seeders: Math.min(...part.releases.map((release) => release.seeders)),
            })),
            downloads: plan.torrents,
            total_size: total,
            ...(plan.missing.length && { seasons_not_found: plan.missing }),
          },
          next_step: 'Nothing is downloading yet. Call download with this plan id to get all of it.',
        };
      }
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
        return { ok: false, error: 'No search result or plan has that id. Search again and use an id from the new results.' };
      }
      if (turn.downloads >= MAX_DOWNLOADS_PER_TURN) {
        turn.failed = true;
        return { ok: false, error: `Already started ${MAX_DOWNLOADS_PER_TURN} downloads for this message. Ask the user before adding more.` };
      }
      if (!result.plan && config.maxTorrentBytes && result.size > config.maxTorrentBytes) {
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

      turn.emit({ type: 'working', text: 'Starting the download…' });
      let label;
      try {
        if (result.plan) return await downloadPlan(user, result, library, args, turn, id);

        const tags = [BASE_TAG, userTag(user.username)];
        const alreadyThere = (existing) => {
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
        };
        // Known up front for magnets; checked before any question about folders.
        const known = result.infoHash ? await qbit.find(result.infoHash) : null;
        if (known) {
          await qbit.addTags(result.infoHash, tags);
          return alreadyThere(known);
        }

        const spot = await place(user, library, result.title, args, turn, id);
        if (spot.reply) return spot.reply;
        label = spot.label;
        const existing = await addUnlessPresent(result, { category: library.category, savePath: spot.savePath, tags });
        if (existing) return alreadyThere(existing);
        log.info('download started', {
          user: user.username,
          title: result.title,
          size: result.size,
          indexer: result.indexer,
          library: library.name,
          savePath: spot.savePath,
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
      const stuck = upkeep?.stuckHashes() ?? new Set();
      return {
        downloads: downloads.slice(0, MAX_LISTED_DOWNLOADS).map((item) => ({
          name: item.name,
          // PiRick replaces stuck downloads itself; the user only needs to know it is on it.
          status: stuck.has(item.hash) ? 'stuck: no progress for hours, PiRick is looking for another copy' : item.status,
          progress: `${item.progress}%`,
          minutes_left: item.etaSeconds == null ? undefined : Math.ceil(item.etaSeconds / 60),
        })),
      };
    },
  };

  return {
    /** The tool definitions for one turn. They follow the libraries as they are now. */
    definitions: () => [SEARCH_DEFINITION, FIND_SHOW_DEFINITION, downloadDefinition(settings.libraries()), LIST_DEFINITION],

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
