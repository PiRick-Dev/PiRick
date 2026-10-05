// Reads release names ("Show.S02E05.1080p.WEB") and plans how to get a whole show
// or season in the fewest downloads. Pure apart from planShow, which is handed
// the search function it should use.
import { titleFromRelease, titleKey } from './folders.js';

/** A copy with at least this many seeders is preferred over anything with fewer. */
export const HEALTHY_SEEDERS = 3;
const MAX_SEASONS = 30;

const COMPLETE_SERIES = /\b(?:complete (?:series|collection|show|saga|box ?set)|(?:full|entire|whole) series|all seasons|integrale)\b/i;
// "COMPLETE BLURAY" describes a full disc, not a full series.
const COMPLETE_ALONE = /\bcomplete\b(?! ?(?:bluray|blu ray|uhd|bd|dvd))/i;
const POOR_COPY = /\b(?:CAM|CAMRip|HDCAM|TS|HDTS|TELESYNC|TC|TELECINE|SCR|SCREENER)\b/;

const range = (first, last) => Array.from({ length: last - first + 1 }, (unused, i) => first + i);
const pad = (number) => String(number).padStart(2, '0');

function resolutionOf(text) {
  const match = /\b(2160|1080|720|576|480)[pi]\b/i.exec(text);
  if (match) return Number(match[1]);
  return /\b(?:4k|uhd)\b/i.test(text) ? 2160 : null;
}

function yearOf(text) {
  // A year at the very start is a title ("1808"), not a date.
  const match = [...text.matchAll(/\b((?:19|20)\d{2})\b/g)].find((found) => found.index > 0);
  return match ? Number(match[1]) : null;
}

/** Other names given in brackets before the season marker: "Minato no Mirelle (Mirelle of the Harbor) S01". */
function aliasesOf(raw) {
  const head = raw.replace(/^\s*(?:\[[^\]]*\]\s*)+/, '').replace(/[._]+/g, ' ');
  const cut = head.search(/\bS\d{1,2}\b|\bSeasons? \d|\s-\s\d/i);
  const aliases = [];
  for (const [, inner] of (cut > 0 ? head.slice(0, cut) : head).matchAll(/\(([^()]+)\)/g)) {
    if (/\p{L}{3}/u.test(inner) && !/^\d+$/.test(inner.trim())) aliases.push(inner.trim());
  }
  return aliases;
}

/**
 * What a release name says it contains.
 *
 *   kind 'series'   every season                      (seasons: [])
 *   kind 'seasons'  several seasons, e.g. S01-S03     (seasons: [1, 2, 3])
 *   kind 'season'   one whole season                  (seasons: [2])
 *   kind 'episode'  one episode                       (season may be null: fansub numbering)
 *   kind 'movie'    a film (has a year, no markers)
 *   kind 'unknown'  none of the above
 */
export function parseRelease(title) {
  const raw = String(title ?? '');
  const text = raw.replace(/[._]+/g, ' ');
  const show = titleFromRelease(raw);
  const base = {
    title: raw,
    show,
    keys: [show, ...aliasesOf(raw)].map(titleKey).filter(Boolean),
    year: yearOf(text),
    resolution: resolutionOf(text),
    poor: POOR_COPY.test(text),
    seasons: [],
    season: null,
    episode: null,
  };
  const episode = (season, number) => ({ ...base, kind: 'episode', season, episode: Number(number) });
  const pack = (seasons) => ({ ...base, kind: seasons.length > 1 ? 'seasons' : 'season', seasons });

  // S01E01-E10 is a pack of the season; S01E01-E02 is one double episode.
  let match = /\bS(\d{1,2}) ?E(\d{1,3}) ?(?:-|–|to) ?(?:S\d{1,2} ?)?E?(\d{1,3})\b/i.exec(text);
  if (match) {
    const [season, first, last] = match.slice(1).map(Number);
    return last - first >= 2 ? pack([season]) : episode(season, first);
  }
  match = /\bS(\d{1,2}) ?E(\d{1,3})(?!\d)/i.exec(text) ?? /\b(\d{1,2})x(\d{2,3})\b/i.exec(text);
  if (match) return episode(Number(match[1]), match[2]);

  // Several seasons: "S01-S05", "Season 1-5", "Seasons 1 to 5", "S01 S02 S03".
  // A spaced "S2 - 05" is fansub for season 2 episode 5, so a range needs either
  // no spaces ("S01-05") or an S on both ends ("S01 - S05").
  match =
    /\bS(\d{1,2})[-–]S?(\d{1,2})\b/i.exec(text) ??
    /\bS(\d{1,2}) ?(?:-|–|to|thru) ?S(\d{1,2})\b/i.exec(text) ??
    /\bSeasons? (\d{1,2}) ?(?:-|–|to|thru|&|and) ?(\d{1,2})\b/i.exec(text);
  if (match && Number(match[2]) > Number(match[1])) return pack(range(Number(match[1]), Number(match[2])));
  const listed = [...new Set([...text.matchAll(/\bS(\d{1,2})\b/gi)].map((found) => Number(found[1])))];
  if (listed.length > 1) return pack(listed.sort((a, b) => a - b));

  if (COMPLETE_SERIES.test(text)) return { ...base, kind: 'series', certain: true };

  match =
    /\bS(\d{1,2})\b/i.exec(text) ??
    /\b(?:Season|Saison|Series) (\d{1,2})\b/i.exec(text) ??
    /\b(\d{1,2})(?:st|nd|rd|th) Season\b/i.exec(text);
  if (match) {
    const season = Number(match[1]);
    // Fansub style, "Title S2 - 05": a season marker and a bare episode number.
    const numbered = /\s-\s(\d{1,3})(?:v\d)?(?= |$)/.exec(text);
    return numbered ? episode(season, numbered[1]) : pack([season]);
  }

  // No season marker at all: batches, fansub episodes, films.
  if (/\bbatch\b/i.test(text) || /[[(] ?\d{1,3} ?[-~] ?\d{1,3} ?[\])]/.test(text) || /\s\d{2,3} ?[-~] ?\d{2,3}\b/.test(text) || COMPLETE_ALONE.test(text)) {
    // Probably everything, but for a show with later seasons it may be only the first.
    return { ...base, kind: 'series', certain: false };
  }
  match = /\s-\s(\d{1,4})(?:v\d)?(?= |$)/.exec(text) ?? /\b(?:E|Ep|Episode) ?(\d{1,4})\b/i.exec(text);
  if (match) return episode(null, match[1]);
  return { ...base, kind: base.year ? 'movie' : 'unknown' };
}

/** A few words for what a release contains, for the model and for status lines. */
export function describeContents(parsed) {
  switch (parsed.kind) {
    case 'series':
      return 'complete series';
    case 'seasons':
      return `seasons ${parsed.seasons[0]}-${parsed.seasons.at(-1)}`;
    case 'season':
      return `season ${parsed.seasons[0]}`;
    case 'episode':
      return parsed.season == null ? `episode ${parsed.episode}` : `S${pad(parsed.season)}E${pad(parsed.episode)}`;
    default:
      return undefined;
  }
}

/** Splits a requested title such as "Wrenfield Cross (2005)" into its name and year. */
export function parseWanted(title) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim();
  const match = /^(.+?)[\s(]+((?:19|20)\d{2})\)?$/.exec(text);
  const name = match ? match[1].trim() : text;
  return { name, key: titleKey(name), year: match ? Number(match[2]) : null };
}

/**
 * Keeps only the releases that are the wanted show. Returns one of:
 *   { releases }           the matches (possibly none)
 *   { others: [names] }    nothing matched, but these similarly named shows were found
 *   { years: [n, n] }      two shows share the name; the caller must say which year
 */
export function matchShow(wanted, releases) {
  const exact = releases.filter((release) => release.parsed.keys.includes(wanted.key));
  if (!exact.length) {
    const counts = new Map();
    for (const { parsed } of releases) {
      if (parsed.kind === 'movie' || parsed.kind === 'unknown' || !parsed.keys[0]) continue;
      if (` ${parsed.keys[0]} `.includes(` ${wanted.key} `)) counts.set(parsed.show, (counts.get(parsed.show) ?? 0) + 1);
    }
    const others = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);
    return others.length ? { others } : { releases: [] };
  }

  // The same season dated years apart means two shows with one name ("Doctor
  // Who" 1963 and 2005). Each first season's year is where one of them starts.
  const yearsBySeason = new Map();
  for (const { parsed } of exact) {
    const season = parsed.seasons[0] ?? parsed.season;
    if (parsed.year == null || season == null) continue;
    yearsBySeason.set(season, [...(yearsBySeason.get(season) ?? []), parsed.year]);
  }
  const clash = [...yearsBySeason.values()].some((years) => Math.max(...years) - Math.min(...years) >= 2);
  if (!clash) return { releases: exact };

  const starts = [...new Set(yearsBySeason.get(Math.min(...yearsBySeason.keys())))].sort((a, b) => a - b);
  // Releases a year apart are the same show (air date drift); merge those.
  const shows = starts.filter((year, i) => i === 0 || year - starts[i - 1] >= 2);
  if (wanted.year == null) return { years: shows };
  const chosen = shows.reduce((a, b) => (Math.abs(b - wanted.year) < Math.abs(a - wanted.year) ? b : a));
  const showOf = (year) => shows.filter((start) => start <= year).at(-1) ?? shows[0];
  return { releases: exact.filter(({ parsed }) => parsed.year != null && showOf(parsed.year) === chosen) };
}

const healthy = (release) => release.seeders >= HEALTHY_SEEDERS;

/** The better of two copies: healthy first, then the wanted quality, then the most seeders. */
function better(a, b, quality) {
  const rank = (release) => [healthy(release) ? 1 : 0, release.parsed.resolution === quality ? 1 : 0, release.seeders];
  const [x, y] = [rank(a), rank(b)];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b;
  return a;
}
/** The best of several copies of the same thing. */
export const best = (releases, quality) => releases.reduce((a, b) => better(a, b, quality));

/**
 * Chooses the fewest downloads that cover a show (or one season of it):
 * one complete pack, else packs of several seasons, else season packs, else
 * single episodes. With `episode`, picks the best copy of that one episode.
 * Returns `{ parts, missing, torrents }`.
 */
export function buildPlan(releases, { season = null, episode = null, quality = 1080, maxBytes = 0 } = {}) {
  const usable = releases.filter((release) => release.seeders > 0 && !(maxBytes && release.size > maxBytes));
  const laterSeasons = usable.some(({ parsed }) => (parsed.seasons.at(-1) ?? parsed.season ?? 0) >= 2);

  const series = [];
  const multi = [];
  const packs = new Map(); // season -> packs of exactly that season
  const episodes = new Map(); // season -> Map(episode -> best copy)
  const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
  for (const release of usable) {
    const { parsed } = release;
    if (parsed.kind === 'series') {
      // An unlabelled batch of a show that has later seasons is its first season.
      if (parsed.certain || !laterSeasons) series.push(release);
      else push(packs, 1, release);
    } else if (parsed.kind === 'seasons') multi.push(release);
    else if (parsed.kind === 'season') push(packs, parsed.seasons[0], release);
    else if (parsed.kind === 'episode') {
      // Fansub releases number the first season's episodes without a season.
      const number = parsed.season ?? 1;
      const copies = episodes.get(number) ?? episodes.set(number, new Map()).get(number);
      const current = copies.get(parsed.episode);
      copies.set(parsed.episode, current ? better(current, release, quality) : release);
    }
  }

  function coverSeason(number) {
    const pack = packs.has(number) ? best(packs.get(number), quality) : null;
    if (pack && healthy(pack)) return { type: 'season', seasons: [number], releases: [pack] };
    const singles = [...(episodes.get(number) ?? new Map()).entries()].sort((a, b) => a[0] - b[0]).map(([, release]) => release);
    // A weak pack only loses to single episodes when most of those are healthy.
    if (singles.length && (!pack || singles.filter(healthy).length * 2 >= singles.length)) {
      return { type: 'episodes', seasons: [number], releases: singles };
    }
    return pack ? { type: 'season', seasons: [number], releases: [pack] } : null;
  }

  const finish = (parts, missing = []) => ({ parts, missing, torrents: parts.reduce((sum, part) => sum + part.releases.length, 0) });

  if (episode != null) {
    // Fansub releases leave the season off; those count as the first.
    const copy = episodes.get(season ?? 1)?.get(episode);
    return finish(copy ? [{ type: 'episodes', seasons: [season ?? 1], releases: [copy] }] : []);
  }
  if (season != null) {
    const part = coverSeason(season);
    return finish(part ? [part] : [], part ? [] : [season]);
  }

  const seen = [...packs.keys(), ...episodes.keys(), ...multi.flatMap(({ parsed }) => parsed.seasons)];
  const lastSeason = Math.min(Math.max(0, ...seen), MAX_SEASONS);
  // A range such as S01-S05 that spans every season seen is a complete pack too.
  const whole = [...series, ...multi.filter(({ parsed }) => parsed.seasons[0] <= 1 && parsed.seasons.at(-1) >= lastSeason && lastSeason > 0)];
  const wholePart = (release) => ({ type: 'series', seasons: [], releases: [release] });
  if (whole.some(healthy)) return finish([wholePart(best(whole.filter(healthy), quality))]);

  const uncovered = new Set(range(1, lastSeason));
  const parts = [];
  const spans = multi.filter(healthy).sort((a, b) => b.parsed.seasons.length - a.parsed.seasons.length || b.seeders - a.seeders);
  for (const release of spans) {
    if (!release.parsed.seasons.every((number) => uncovered.has(number))) continue;
    parts.push({ type: 'seasons', seasons: release.parsed.seasons, releases: [release] });
    for (const number of release.parsed.seasons) uncovered.delete(number);
  }
  const missing = [];
  for (const number of [...uncovered].sort((a, b) => a - b)) {
    const part = coverSeason(number);
    if (part) parts.push(part);
    else missing.push(number);
  }
  // A weak complete pack is still better than leaving seasons out.
  if ((missing.length || !parts.length) && whole.length) return finish([wholePart(best(whole, quality))]);
  return finish(parts.sort((a, b) => a.seasons[0] - b.seasons[0]), missing);
}

/** One line for a part of a plan: "Season 3: 8 single episodes". */
export function describePart(part) {
  if (part.type === 'series') return 'Complete series';
  if (part.type === 'seasons') return `Seasons ${part.seasons[0]}-${part.seasons.at(-1)}`;
  if (part.type === 'season') return `Season ${part.seasons[0]}`;
  const count = part.releases.length;
  return `Season ${part.seasons[0]}: ${count} single episode${count === 1 ? '' : 's'}`;
}

async function searchAll(search, queries, atOnce) {
  const found = new Map();
  let failure = null;
  for (let i = 0; i < queries.length; i += atOnce) {
    const batch = await Promise.allSettled(queries.slice(i, i + atOnce).map((query) => search(query)));
    for (const result of batch) {
      if (result.status === 'rejected') {
        failure = result.reason;
        continue;
      }
      for (const release of result.value) {
        const key = release.infoHash ?? release.title;
        if (!found.has(key)) found.set(key, { ...release, parsed: parseRelease(release.title) });
      }
    }
  }
  // Partial answers are still useful; only give up when every search failed.
  if (failure && !found.size) throw failure;
  return [...found.values()];
}

/**
 * Finds the best way to get a show, one season of it, or one episode.
 * `search(query)` returns releases ({ title, size, seeders, infoHash, ... }).
 * `skip(release)` can rule copies out. `atOnce` is how many searches may run
 * together. Resolves to `{ plan }`, `{ others }` or `{ years }` (see matchShow).
 *
 * Searches are slow, so each one is only made if what is known so far is not
 * already good enough.
 */
export async function planShow(search, { title, season = null, episode = null, quality = 1080, maxBytes = 0, skip = () => false, atOnce = 1 }) {
  const wanted = parseWanted(title);
  const options = { season, episode, quality, maxBytes };
  let found = [];
  let releases = [];
  let plan = buildPlan([], options);

  /** Searches further and replans. Resolves to an ambiguity to hand back, or null. */
  async function look(queries) {
    let more;
    try {
      more = await searchAll(search, queries, atOnce);
    } catch (err) {
      // What earlier searches found still stands.
      if (!found.length) throw err;
      more = [];
    }
    found = [...new Map([...found, ...more].map((release) => [release.infoHash ?? release.title, release])).values()];
    const match = matchShow(wanted, found);
    if (!match.releases) return match;
    releases = match.releases.filter((release) => !skip(release));
    plan = buildPlan(releases, options);
    return null;
  }
  const goodPack = (type) => plan.parts.length === 1 && plan.parts[0].type === type && healthy(plan.parts[0].releases[0]);

  let unclear;
  if (episode != null) {
    unclear = await look([`${wanted.name} ${season == null ? pad(episode) : `S${pad(season)}E${pad(episode)}`}`]);
  } else if (season != null) {
    unclear = await look([`${wanted.name} S${pad(season)}`]);
    // Some packs are only ever labelled "Season 2".
    if (!unclear && !goodPack('season')) unclear = await look([`${wanted.name} season ${season}`]);
  } else {
    unclear = await look([wanted.name]);
    if (!unclear && !goodPack('series')) unclear = await look([`${wanted.name} complete`]);
    if (!unclear && !goodPack('series')) {
      // No good complete pack: look at each season that still lacks a good pack of its own.
      const seen = releases.flatMap(({ parsed }) => (parsed.seasons.length ? parsed.seasons : [parsed.season ?? 1]));
      const lastSeason = Math.min(Math.max(0, ...seen), MAX_SEASONS);
      const covered = new Set(plan.parts.filter((part) => part.type !== 'episodes' && part.releases.every(healthy)).flatMap((part) => part.seasons));
      const seasons = range(1, lastSeason).filter((number) => !covered.has(number));
      if (seasons.length) unclear = await look(seasons.map((number) => `${wanted.name} S${pad(number)}`));
    }
  }
  return unclear ?? { plan, show: releases[0]?.parsed.show ?? wanted.name };
}
