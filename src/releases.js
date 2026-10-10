// Reads release names ("Show.S02E05.1080p.WEB") and plans how to get a whole show
// or season in the fewest downloads. Pure apart from planShow, which is handed
// the search function it should use.
import { titleFromRelease, titleKey } from './folders.js';

/** A copy with at least this many seeders is preferred over anything with fewer. */
export const HEALTHY_SEEDERS = 3;
const MAX_SEASONS = 30;
// A pack that runs from the first episode to this share of all there are is taken to hold the show.
const NEARLY_ALL = 0.95;

const COMPLETE_SERIES = /\b(?:complete (?:series|collection|show|saga|box ?set)|(?:full|entire|whole) series|all seasons|integrale)\b/i;
// "COMPLETE BLURAY" describes a full disc, not a full series.
const COMPLETE_ALONE = /\bcomplete\b(?! ?(?:bluray|blu ray|uhd|bd|dvd))/i;
// All of a show that has one season, and of a show that has more, something else: its pilot, or a namesake.
const MINISERIES = /\b(?:mini ?series|limited series)\b/i;
const POOR_COPY = /\b(?:CAM|CAMRip|HDCAM|TS|HDTS|TELESYNC|TC|TELECINE|SCR|SCREENER)\b/;
// A country in brackets after the name tells two shows of one name apart, as it does without them: "Kestrelmere (US)".
const COUNTRY_IN_BRACKETS = /^((?:\s*\[[^\]]*\])*[^([]*?[\p{L}\p{N}])[\s._]*[([]\s*(US|USA|UK|GB|AU|NZ|CA|IE)\s*[)\]]/u;
// The first sign of what a release holds. What comes before it is about the show, what comes after about the copy.
const CONTENTS = /\bS\d{1,2}(?: ?E\d{1,3})?\b|\b(?:Seasons?|Saison|Series) \d|\b\d{1,2}(?:st|nd|rd|th) Season\b|\b\d{1,2}x\d{2,3}\b|\s-\s\d{1,4}\b|\b(?:E|Ep|Episode) ?\d{1,4}\b/i;
// After a season: a piece of it. "S04 Vol 1", "Season 3 Part 2".
const PIECE = /^ ?(?:Vol(?:ume)?|Part|Pt) ?\d{1,2}\b/i;

/**
 * Tidies a name that came from the internet, whether an indexer's title for a
 * release or the name inside a torrent: one line, no control characters, and a
 * length that cannot crowd out everything else the model is told.
 */
export function cleanTitle(title) {
  return String(title ?? '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

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
 *   kind 'part'     a piece of one season             (seasons: [4]: "S04 Vol 1", "S02E05-E09")
 *   kind 'episode'  one episode                       (season may be null: fansub numbering)
 *   kind 'movie'    a film (has a year, no markers)
 *   kind 'unknown'  none of the above
 *
 * A file that holds two episodes is an 'episode' whose `episodes` lists both.
 * A season given as a run of episodes from the first ("S01E01-E10") has
 * `through`, the last of them. `showYear` is the year the name gives the show,
 * which stands before what the release holds; `year` is the first year anywhere.
 */
export function parseRelease(title) {
  const raw = String(title ?? '');
  const named = raw.replace(COUNTRY_IN_BRACKETS, '$1 $2');
  const text = raw.replace(/[._]+/g, ' ');
  const show = titleFromRelease(named);
  const base = {
    title: raw,
    show,
    keys: [show, ...aliasesOf(named)].map(titleKey).filter(Boolean),
    year: yearOf(text),
    showYear: yearOf(text.slice(0, CONTENTS.exec(text)?.index ?? text.length)),
    resolution: resolutionOf(text),
    poor: POOR_COPY.test(text),
    seasons: [],
    season: null,
    episode: null,
  };
  const episode = (season, number, more = []) => ({ ...base, kind: 'episode', season, episode: Number(number), ...(more.length && { episodes: [Number(number), ...more] }) });
  const pack = (seasons) => ({ ...base, kind: seasons.length > 1 ? 'seasons' : 'season', seasons });

  // S01E01-E10 is a pack of the season, S01E05-E09 a piece of it, and S01E01-E02 one double episode.
  let match = /\bS(\d{1,2}) ?E(\d{1,3}) ?(?:-|–|to) ?(?:S\d{1,2} ?)?E?(\d{1,3})\b/i.exec(text);
  if (match) {
    const [season, first, last] = match.slice(1).map(Number);
    if (last - first < 2) return episode(season, first, last > first ? [last] : []);
    return first === 1 ? { ...pack([season]), through: last } : { ...base, kind: 'part', seasons: [season] };
  }
  match = /\bS(\d{1,2}) ?E(\d{1,3})(?!\d)/i.exec(text);
  if (match) {
    // "S05E15E16": two episodes in one file.
    const run = /^(?: ?E\d{1,3}(?!\d))+/i.exec(text.slice(match.index + match[0].length))?.[0] ?? '';
    return episode(Number(match[1]), match[2], [...run.matchAll(/\d+/g)].map(Number));
  }
  match = /\b(\d{1,2})x(\d{2,3})\b/i.exec(text);
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
    if (numbered) return episode(season, numbered[1]);
    return PIECE.test(text.slice(match.index + match[0].length)) ? { ...base, kind: 'part', seasons: [season] } : pack([season]);
  }

  // No season marker at all: batches, fansub episodes, films.
  if (/\bbatch\b/i.test(text) || /[[(] ?\d{1,3} ?[-~] ?\d{1,3} ?[\])]/.test(text) || /\s\d{2,3} ?[-~] ?\d{2,3}\b/.test(text) || COMPLETE_ALONE.test(text)) {
    // Probably everything, but for a show with later seasons it may be only the first. The episodes it says
    // it runs from and to, when it says, let a caller that knows how many there are judge: years are not those.
    const run = (/[[(] ?(\d{1,4}) ?[-~] ?(\d{1,4}) ?[\])]/.exec(text) ?? /\s(\d{2,4}) ?[-~] ?(\d{2,4})\b/.exec(text))?.slice(1).map(Number);
    const span = run && run[1] > run[0] && !run.every((number) => number >= 1900 && number <= 2099) ? run : null;
    return { ...base, kind: 'series', certain: false, ...(span && { span }) };
  }
  match = /\s-\s(\d{1,4})(?:v\d)?(?= |$)/.exec(text) ?? /\b(?:E|Ep|Episode) ?(\d{1,4})\b/i.exec(text);
  if (match) return episode(null, match[1]);
  // Only a caller that knows the show has a single season can take this for all of it.
  if (MINISERIES.test(text)) return { ...base, kind: 'series', certain: false, mini: true };
  return { ...base, kind: base.year ? 'movie' : 'unknown' };
}

/** A few words for what a release contains, for the model and for status lines. */
export function describeContents(parsed) {
  switch (parsed.kind) {
    case 'series':
      return parsed.mini ? 'miniseries' : 'complete series';
    case 'seasons':
      return `seasons ${parsed.seasons[0]}-${parsed.seasons.at(-1)}`;
    case 'season':
      return `season ${parsed.seasons[0]}`;
    case 'part':
      return `part of season ${parsed.seasons[0]}`;
    case 'episode':
      if (parsed.season == null) return `episode ${parsed.episode}`;
      return `S${pad(parsed.season)}E${pad(parsed.episode)}${parsed.episodes ? `-E${pad(parsed.episodes.at(-1))}` : ''}`;
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
 * `wanted.keys` lists every name the show goes by, when more than the one asked for is known.
 *
 * `wanted.known` is set by a caller that knows which show this is, from a
 * catalogue: `{ year, lastSeason, shared, marks }`. A release that gives its
 * show another year, or holds a season the show does not have, is then some
 * other show of the name. When the name is `shared`, a release that says which
 * show it is, by a year or by one of the names in `marks`, comes back `marked`:
 * one that does not could be either.
 */
export function matchShow(wanted, releases) {
  const names = wanted.keys ?? [wanted.key];
  const { known } = wanted;
  // A show's name may end in what reads as a year: "Harbour 1900". A release of it is then read as "Harbour", from 1900.
  const yearInName = ({ parsed }) => parsed.showYear != null && names.includes(titleKey(`${parsed.show} ${parsed.showYear}`));
  const named = releases.filter((release) => release.parsed.keys.some((key) => names.includes(key)) || yearInName(release));
  // A year apart is the same show, dated by its first showing somewhere else.
  const theirs = (release) =>
    (known.year == null || release.parsed.showYear == null || yearInName(release) || Math.abs(release.parsed.showYear - known.year) <= 1) &&
    Math.max(0, ...release.parsed.seasons, release.parsed.season ?? 0) <= known.lastSeason;
  const exact = known ? named.filter(theirs) : named;
  if (known) {
    if (!known.shared) return { releases: exact };
    const marks = known.marks ?? [];
    return { releases: exact.map((release) => ({ ...release, marked: release.parsed.showYear != null || release.parsed.keys.some((key) => marks.includes(key)) })) };
  }
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

/** The better of two copies: healthy first, then one that says which show it is where that is in doubt, then the wanted quality, then the most seeders. */
function better(a, b, quality) {
  const rank = (release) => [healthy(release) ? 1 : 0, release.marked ? 1 : 0, release.parsed.resolution === quality ? 1 : 0, release.seeders];
  const [x, y] = [rank(a), rank(b)];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b;
  return a;
}
/** The best of several copies of the same thing. */
export const best = (releases, quality) => releases.reduce((a, b) => better(a, b, quality));

/** The last season of which anything has aired, going by an episode guide. */
export const lastAired = (guide) => Math.max(0, ...[...guide].filter(([, season]) => season.aired > 0).map(([number]) => number));
/** The last season to plan for. A guide is taken at its word; numbers read from release names are not, beyond a point. */
const lastOf = (guide, seen) => (guide ? lastAired(guide) : Math.min(Math.max(0, ...seen), MAX_SEASONS));

/**
 * Chooses the fewest downloads that cover a show (or one season of it):
 * one complete pack, else packs of several seasons, else season packs, else
 * single episodes. With `episode`, picks the best copy of that one episode.
 * Returns `{ parts, missing, torrents }`.
 *
 * `guide` is the show's episode guide, when there is one: a map from season
 * number to `{ episodes, aired }`. With it the plan covers every season that
 * has aired, not only those some release happens to name, and comes back with
 * `gaps`: `[{ season, episodes }]`, the aired episodes of a season fetched as
 * single episodes for which no copy was found.
 *
 * `sizes` is `{ total, first, largest }`: how many episodes the show has in
 * all, in its first season and in its longest, when that is known. It tells
 * releases that number a show straight through, which are no part of any
 * season. A plan that comes to nothing because of them comes back `straight`.
 */
export function buildPlan(releases, { season = null, episode = null, quality = 1080, maxBytes = 0, guide = null, sizes = null } = {}) {
  const usable = releases.filter((release) => release.seeders > 0 && !(maxBytes && release.size > maxBytes));
  const laterSeasons = usable.some(({ parsed }) => (parsed.seasons.at(-1) ?? parsed.season ?? 0) >= 2);
  // A show the guide gives one season: what calls itself a miniseries is all of it. Of any other, it is not known what it is.
  const oneSeason = guide?.size === 1 && guide.has(1);

  const series = [];
  const multi = [];
  const packs = new Map(); // season -> packs of exactly that season
  const episodes = new Map(); // season -> Map(episode -> best copy)
  const doubles = [];
  const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
  // Releases that number a show straight through ("- 1071", "S21E1071", "001-061") say nothing of its
  // seasons. They are told by a number no season of the show could hold, kept apart, and never taken
  // for part of its first season.
  const beyond = (number, most) => most > 0 && sizes.total > most && number > most * 1.1 + 1;
  // A number past all the episodes there have been is of some other show of the name.
  const notOfIt = (number) => Boolean(sizes?.total) && number > sizes.total * 1.1 + 1;
  const numbered = new Map(); // episode -> best copy, by its number in the whole show
  let straight = false;
  // Fansub releases number the first season's episodes without a season.
  const copiesOf = ({ parsed }) => episodes.get(parsed.season ?? 1) ?? episodes.set(parsed.season ?? 1, new Map()).get(parsed.season ?? 1);
  for (const release of usable) {
    const { parsed } = release;
    if (parsed.kind === 'series') {
      if (parsed.mini && !oneSeason) continue;
      if (parsed.span && notOfIt(parsed.span[1])) continue;
      if (sizes && parsed.span && beyond(parsed.span[1], sizes.first)) {
        // A run of a show numbered straight through is all of it only if it goes from the first episode to nearly the last.
        straight = true;
        if (parsed.span[0] <= 1 && parsed.span[1] >= sizes.total * NEARLY_ALL) series.push(release);
        continue;
      }
      // An unlabelled batch of a show that has later seasons is its first season.
      if (parsed.certain || !laterSeasons) series.push(release);
      else push(packs, 1, release);
    } else if (parsed.kind === 'seasons') multi.push(release);
    else if (parsed.kind === 'season') {
      // A run of episodes from the first is the season only if it reaches the last that has aired.
      const short = parsed.through != null && guide?.has(parsed.seasons[0]) && parsed.through < guide.get(parsed.seasons[0]).aired;
      if (!short) push(packs, parsed.seasons[0], release);
    } else if (parsed.kind === 'episode') {
      if (parsed.season == null && notOfIt(parsed.episode)) continue;
      if (sizes && beyond(parsed.episode, parsed.season == null ? sizes.first : sizes.largest)) {
        straight = true;
        numbered.set(parsed.episode, numbered.has(parsed.episode) ? better(numbered.get(parsed.episode), release, quality) : release);
      } else if (parsed.episodes) doubles.push(release);
      else {
        const copies = copiesOf(release);
        const current = copies.get(parsed.episode);
        copies.set(parsed.episode, current ? better(current, release, quality) : release);
      }
    }
  }
  // A file with two episodes in it is used when one of them has no copy of its own, and then for both, so neither comes twice.
  for (const release of doubles) {
    const copies = copiesOf(release);
    const own = (part) => copies.has(part) && !copies.get(part).parsed.episodes;
    if (release.parsed.episodes.every(own)) continue;
    for (const part of release.parsed.episodes) copies.set(part, copies.has(part) && !own(part) ? better(copies.get(part), release, quality) : release);
  }

  // A season still being aired: a pack of it cannot hold all of it, while its episodes one by one keep up.
  const airing = (number) => Boolean(guide?.has(number)) && guide.get(number).aired < guide.get(number).episodes;

  function coverSeason(number) {
    const pack = packs.has(number) ? best(packs.get(number), quality) : null;
    const singles = [...new Set([...(episodes.get(number) ?? new Map()).entries()].sort((a, b) => a[0] - b[0]).map(([, release]) => release))];
    if (airing(number) && singles.length) return { type: 'episodes', seasons: [number], releases: singles };
    if (pack && healthy(pack)) return { type: 'season', seasons: [number], releases: [pack] };
    // A weak pack only loses to single episodes when most of those are healthy.
    if (singles.length && (!pack || singles.filter(healthy).length * 2 >= singles.length)) {
      return { type: 'episodes', seasons: [number], releases: singles };
    }
    return pack ? { type: 'season', seasons: [number], releases: [pack] } : null;
  }

  function finish(parts, missing = []) {
    const gaps = [];
    for (const part of guide && episode == null ? parts.filter((entry) => entry.type === 'episodes') : []) {
      const have = new Set(part.releases.flatMap((release) => release.parsed.episodes ?? [release.parsed.episode]));
      const lacking = range(1, guide.get(part.seasons[0])?.aired ?? 0).filter((number) => !have.has(number));
      if (lacking.length) gaps.push({ season: part.seasons[0], episodes: lacking });
    }
    // Nothing to fetch, and what there is goes by numbers that are not seasons: the caller will want to say so.
    return { parts, missing, torrents: parts.reduce((sum, part) => sum + part.releases.length, 0), ...(gaps.length && { gaps }), ...(straight && !parts.length && { straight: true }) };
  }

  if (episode != null) {
    // Fansub releases leave the season off; those count as the first. One numbered through the whole show is that episode whatever season was said.
    const copy = episodes.get(season ?? 1)?.get(episode) ?? numbered.get(episode);
    return finish(copy ? [{ type: 'episodes', seasons: [season ?? 1], releases: [copy] }] : []);
  }
  if (season != null) {
    const part = coverSeason(season);
    return finish(part ? [part] : [], part ? [] : [season]);
  }

  const seen = [...packs.keys(), ...episodes.keys(), ...multi.flatMap(({ parsed }) => parsed.seasons)];
  const lastSeason = lastOf(guide, seen);
  // Of a show with one season, a pack of that season is all of it, whatever it calls itself.
  const only = oneSeason && !airing(1) ? (packs.get(1) ?? []) : [];
  // A range such as S01-S05 that spans every season seen is a complete pack too.
  const whole = [...series, ...multi.filter(({ parsed }) => parsed.seasons[0] <= 1 && parsed.seasons.at(-1) >= lastSeason && lastSeason > 0), ...only];
  const wholePart = (release) => (only.includes(release) ? { type: 'season', seasons: [1], releases: [release] } : { type: 'series', seasons: [], releases: [release] });
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
    const batch = await Promise.allSettled(queries.slice(i, i + atOnce).map(({ query, title }) => search(query, title)));
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
 * `search(query, title)` returns releases ({ title, size, seeders, infoHash, ... });
 * `title` is the part of the query that is the show's name.
 * `skip(release)` can rule copies out. `atOnce` is how many searches may run
 * together. Resolves to `{ plan }`, `{ others }` or `{ years }` (see matchShow).
 *
 * Searches are slow, so each one is only made if what is known so far is not
 * already good enough. A caller that already has part of the show can save
 * more of them: `settled` lists seasons that need no looking for, and
 * `inParts` says a pack of the whole show is no use.
 *
 * A caller that knows more about the show says so: `names` are the other
 * names it goes by, `year` the year it began, and `guide` its episode guide
 * (see buildPlan). One that knows which show it is, from a catalogue, is `sure`,
 * and then says whether other shows have the name (`shared`), whether one of
 * them is the better known (`crowded`), and how release names tell this one
 * from them: `tagged`, its name with its country after it. `fansub` says its
 * episodes may be released the way anime is, numbered with no season, and
 * `sizes` how many episodes it has (see buildPlan).
 */
export async function planShow(
  search,
  {
    title,
    season = null,
    episode = null,
    quality = 1080,
    maxBytes = 0,
    skip = () => false,
    settled = new Set(),
    inParts = false,
    atOnce = 1,
    names = [],
    year = null,
    guide = null,
    sure = false,
    shared = false,
    crowded = false,
    tagged = [],
    fansub = false,
    sizes = null,
  },
) {
  // A caller that is sure of the show gives its name as it is, which may end in what reads as a year.
  const wanted = sure ? { name: String(title).trim(), key: titleKey(title), year } : parseWanted(title);
  wanted.year ??= year;
  const keys = (list) => list.map(titleKey).filter(Boolean);
  if (names.length || tagged.length) wanted.keys = [...new Set([wanted.key, ...keys(names), ...keys(tagged)])].filter(Boolean);
  if (sure) wanted.known = { year, lastSeason: guide ? Math.max(...guide.keys()) : Infinity, shared, marks: keys(tagged) };
  // Under a name it shares with a better-known show, that show fills every answer. Release names
  // tell the two apart by a year or a country after the name, so it is searched for those ways as well.
  const apart = sure && crowded ? [year == null ? null : `${wanted.name} ${year}`, tagged[0]].filter(Boolean) : [];
  // What is searched for is a name and, after it, what is wanted of the show. The search is told which part is the name.
  const under = (name, rest = '') => ({ query: `${name}${rest}`, title: name });
  const asked = (rest = '') => [wanted.name, ...apart].map((name) => under(name, rest));
  const options = { season, episode, quality, maxBytes, guide, sizes };
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
  // All of the show in one good pack: a complete one, or the one season of a show that has no other.
  const allInOne = () => goodPack('series') || (guide?.size === 1 && goodPack('season'));

  let unclear;
  if (episode != null) {
    unclear = await look(asked(` ${season == null ? pad(episode) : `S${pad(season)}E${pad(episode)}`}`));
    // Fansub releases number the episodes of a first season with no season: "Title - 05".
    if (!unclear && !plan.torrents && fansub && season === 1) unclear = await look([under(wanted.name, ` ${pad(episode)}`)]);
    // It may only exist in one file with the episode before it, which a search for it alone does not find.
    if (!unclear && !plan.torrents && season != null) unclear = await look([under(wanted.name, ` S${pad(season)}`)]);
  } else if (season != null) {
    unclear = await look(asked(` S${pad(season)}`));
    // Some packs are only ever labelled "Season 2".
    if (!unclear && !goodPack('season')) unclear = await look([under(wanted.name, ` season ${season}`)]);
  } else {
    unclear = await look(asked());
    // Nothing at all under the name: searching for all of it, or for a season of it, cannot find more.
    const some = found.length > 0;
    if (some && !unclear && !inParts && !allInOne()) unclear = await look([under(wanted.name, ' complete')]);
    if (some && !unclear && !allInOne()) {
      // No good complete pack: look at each season that still lacks a good pack of its own.
      const seen = releases.flatMap(({ parsed }) => (parsed.seasons.length ? parsed.seasons : [parsed.season ?? 1]));
      const lastSeason = lastOf(guide, seen);
      const covered = new Set(plan.parts.filter((part) => part.type !== 'episodes' && part.releases.every(healthy)).flatMap((part) => part.seasons));
      const seasons = range(1, lastSeason).filter((number) => !covered.has(number) && !settled.has(number));
      if (seasons.length) unclear = await look(seasons.map((number) => under(wanted.name, ` S${pad(number)}`)));
    }
  }
  return unclear ?? { plan, show: releases[0]?.parsed.show ?? wanted.name };
}
