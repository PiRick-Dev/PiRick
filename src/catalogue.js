// What exists: films, shows and the people in them. PiRick asks which film or
// show a name means, who made it, which episodes there are and whether they
// are out yet, so that none of it has to come from the AI model's memory.
//
// Films and people come from Wikidata, shows and their episode guides from
// TVmaze, and a few lines about a film from Wikipedia. All three are free to
// use with credit and need no account. Everything that comes back was typed in
// by members of the public, so names are tidied and descriptions are cut down
// before anything is passed on.
import { UpstreamError, describeError } from './errors.js';
import { titleKey } from './folders.js';
import { cleanTitle } from './releases.js';
import { queryVariants } from './search.js';

// Wikimedia asks every program to say who it is.
const USER_AGENT = 'PiRick (https://github.com/PiRick-Dev/PiRick)';
const SEARCH_FRESH_MS = 60 * 60 * 1000;
const DETAILS_FRESH_MS = 12 * 60 * 60 * 1000;
const MAX_KEPT = 1000;
const MAX_NAME = 100;
const ABOUT_MAX = 300;
const ABOUT_IN_LISTS = 160;
/** How many same-named films or shows are offered to choose from. */
export const MAX_CHOICES = 5;
const MAX_CAST = 4;
const MAX_SERIES = 12;
const MAX_LISTED = 8;
const MAX_FILMS_OF_PERSON = 10;
const MAX_SHOWS_OF_PERSON = 5;
// How many people of a name are looked at for one who has made something, and how much two people may share.
const MAX_NAMESAKES = 3;
const MAX_TOGETHER = 8;
const MAX_FOUND = 10;
// Of what a search found, how many with the right name are looked at closely.
const MAX_NAMED = 8;
// When nothing has the name asked for, how many of what was found are checked for another name of theirs.
const MAX_ALIASES_CHECKED = 3;
const MAX_OTHER_NAMES = 300;
// A genre's suggestions are chosen from this many of its best-linked films, leaving out those filed under more genres than this.
const GENRE_SHELF = 40;
const MAX_GENRES_OF_ITS_OWN = 3;
// How many of yesterday's most-read Wikipedia pages are looked through for films and shows.
const MOST_READ_CHECKED = 200;
const DAY_MS = 86_400_000;
const ASKED_TOO_OFTEN_MS = 1500;

// One of several same-named things is taken without asking only when it is far
// better known than the next. Wikidata measures a film by how many Wikipedias
// write about it, TVmaze a show by a weight out of 100.
const CLEARLY = {
  film: (a, b) => a.known >= 10 && a.known >= b.known * 2.5,
  show: (a, b) => a.known >= 50 && a.known - b.known >= 30,
};
// The two measures on one scale, for telling a film from a show of the same name.
const FAME = { film: (thing) => Math.min(1, thing.known / 80), show: (thing) => thing.known / 100 };
/** How well known a film or a show is, from 0 to 1, whichever of the two it is. */
export const fame = (thing) => FAME[thing.kind](thing);

// Wikidata's names for things.
const P = { kind: 'P31', date: 'P577', start: 'P580', director: 'P57', cast: 'P161', creator: 'P170', series: 'P179', follows: 'P155', followedBy: 'P156', country: 'P495', language: 'P364', title: 'P1476', genre: 'P136', imdb: 'P345', occupation: 'P106' };
const FILM_KINDS = ['Q11424', 'Q24862', 'Q202866', 'Q226730', 'Q506240', 'Q20650540', 'Q24869', 'Q29168811', 'Q17517379', 'Q93204', 'Q917641', 'Q18011172'];
const SHOW_KINDS = ['Q5398426', 'Q63952888', 'Q581714', 'Q1259759', 'Q117467246'];
const UNFINISHED_FILM = 'Q18011172';
const ANIME_KINDS = new Set(['Q20650540', 'Q63952888']);
const ANIMATED_KINDS = new Set(['Q202866', 'Q29168811', 'Q17517379', 'Q581714', 'Q117467246']);
const JAPAN = 'Q17';
const JAPANESE = 'Q5287';
const HUMAN = 'Q5';
const DIRECTORS = new Set(['Q2526255', 'Q3455803']);
const either = (property, ids) => ids.map((id) => `${property}=${id}`).join('|');
const KIND_FILTER = { film: either(P.kind, FILM_KINDS), show: either(P.kind, SHOW_KINDS) };
/** The genres suggestions can be asked for, as Wikidata files films and shows under them (null where it has no such shelf). */
const GENRE_FILTERS = {
  action: [either(P.genre, ['Q188473']), either(P.genre, ['Q343782'])],
  adventure: [either(P.genre, ['Q319221']), either(P.genre, ['Q56064758'])],
  animation: [`${either(P.kind, ['Q202866', 'Q29168811'])}|${either(P.genre, ['Q202866'])}`, either(P.kind, ['Q581714', 'Q117467246', 'Q63952888'])],
  comedy: [either(P.genre, ['Q157443']), either(P.genre, ['Q170238', 'Q9335576'])],
  crime: [either(P.genre, ['Q959790']), either(P.genre, ['Q9335577', 'Q2321734'])],
  documentary: [`${either(P.kind, ['Q93204'])}|${either(P.genre, ['Q93204'])}`, either(P.genre, ['Q7603925'])],
  drama: [either(P.genre, ['Q130232']), either(P.genre, ['Q1366112'])],
  family: [either(P.genre, ['Q1361932', 'Q2143665']), null],
  fantasy: [either(P.genre, ['Q157394']), either(P.genre, ['Q98526245'])],
  history: [either(P.genre, ['Q17013749']), null],
  horror: [either(P.genre, ['Q200092']), either(P.genre, ['Q20220309'])],
  musical: [either(P.genre, ['Q842256']), null],
  mystery: [either(P.genre, ['Q1200678']), null],
  romance: [either(P.genre, ['Q1054574']), either(P.genre, ['Q84270297'])],
  'science fiction': [either(P.genre, ['Q471839']), either(P.genre, ['Q140472311', 'Q336059'])],
  thriller: [either(P.genre, ['Q2484376']), either(P.genre, ['Q67175872'])],
  war: [either(P.genre, ['Q369747']), null],
  western: [either(P.genre, ['Q172980', 'Q21590660']), either(P.genre, ['Q7988576'])],
};
export const GENRES = Object.keys(GENRE_FILTERS);
/** Country codes people put after a show's name to say which one they mean. */
const COUNTRY_WORDS = { us: 'US', usa: 'US', uk: 'GB', gb: 'GB', au: 'AU', ca: 'CA', nz: 'NZ', ie: 'IE' };

// ---- Text from the catalogue ---------------------------------------------------

/** A name as it may be shown or handed to the model: one line, no control characters, a sensible length. */
export const cleanName = (text) => cleanTitle(text).slice(0, MAX_NAME).trim();

// Signs that a description was written to steer an assistant, not to describe a film.
const STEERING = [
  /https?:\/\/|\bwww\./i,
  /\b(?:ignore|disregard|forget|override)\b[^.!?]{0,60}\b(?:instructions?|rules?|prompts?|guidelines|above|previous|earlier)\b/i,
  /\b(?:system|developer) (?:prompt|note|message|instructions?)\b/i,
  /\b(?:AI|virtual|chat) assistant\b|\bassistant[,:]|\bnote (?:to|for) (?:the |an? )?(?:assistant|AI|model|chatbot)\b|\blanguage model\b|\bchatbot\b/i,
  /\b(?:call|use|invoke|run) (?:the |a )?(?:\w+ )?(?:tool|function)\b|\b(?:search_media|find_show|look_up\w*|list_downloads)\b/i,
  /\byou (?:must|should|have to|need to|are to|will) (?:now )?(?:download|search|reply|respond|answer|tell|say)\b/i,
];

/**
 * A description fit to pass on: plain text on one line, cut at the end of a
 * sentence. No filter can tell every instruction from a description, so this
 * only keeps it short and drops the ones that plainly are not descriptions;
 * what really limits the harm is that descriptions never sit beside a download id.
 */
export function cleanAbout(text, max = ABOUT_MAX) {
  const raw = String(text ?? '').replace(/\p{Cc}+/gu, ' ');
  const plain = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/[`{}[\]|*_#~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Judged as it came and as it will be passed on: markup can hide a word or make one.
  if (!plain || STEERING.some((pattern) => pattern.test(raw) || pattern.test(plain))) return '';
  if (plain.length <= max) return plain;
  let kept = '';
  for (const [sentence] of plain.matchAll(/[^.!?]+[.!?]+["'”’)]*\s*/g)) {
    if ((kept + sentence).trimEnd().length > max) break;
    kept += sentence;
  }
  // One sentence longer than the room there is: cut between words.
  return kept.trim() || `${plain.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

// ---- Comparing names -----------------------------------------------------------

/** A name in the form used for comparing, with a leading "The" or "A" set aside. */
export const nameKey = (name) => titleKey(name).replace(/^(?:the|an?) (?=\S)/, '');

/** How many letters would have to change, be added, dropped or swapped to turn one text into the other. */
function lettersApart(a, b) {
  let before = null;
  let previous = Array.from({ length: b.length + 1 }, (unused, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const same = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + same);
      if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], before[j - 2] + 1);
    }
    before = previous;
    previous = row;
  }
  return previous[b.length];
}

/** The same name with a letter or two wrong. Short names are left alone: "Rook" is not "Book". */
function misspelt(wanted, key) {
  if (Math.min(wanted.length, key.length) < 6) return false;
  const allowed = Math.min(3, Math.max(1, Math.floor(Math.max(wanted.length, key.length) / 8)));
  return Math.abs(wanted.length - key.length) <= allowed && lettersApart(wanted, key) <= allowed;
}

/**
 * A person's name with its words each a letter or two off: "Jon" for "John", or
 * both of two words misspelt, which taken as one text is too far off to be
 * `misspelt`. The words are as many and in the same order.
 */
function nearlyNamed(wanted, key) {
  const want = wanted.split(' ');
  const have = key.split(' ');
  if (want.length < 2 || want.length !== have.length) return false;
  let off = 0;
  for (const [i, word] of want.entries()) {
    const longer = Math.max(word.length, have[i].length);
    const apart = lettersApart(word, have[i]);
    if (apart > (longer >= 6 ? 2 : longer >= 3 ? 1 : 0)) return false;
    off += apart;
  }
  return off > 0 && off <= 4;
}

/** The words asked for, in order, inside a slightly longer name: "Jekyll and Hyde" in "Dr Jekyll and Mr Hyde". */
function within(wanted, key) {
  const want = wanted.split(' ');
  const have = key.split(' ');
  if (want.length < 2 || have.length <= want.length || have.length - want.length > 2) return false;
  let at = 0;
  for (const word of have) if (word === want[at]) at += 1;
  return at === want.length;
}

/** What a name with a subtitle is called for short: "Caminandes" of "Caminandes: Llama Drama". */
const leadOf = (name) => /^(.{2,}?)(?::\s|\s[-–—]\s)/.exec(String(name ?? ''))?.[1] ?? null;
const leadsOf = (names) => [...new Set(names.map(leadOf).filter(Boolean).map(nameKey).filter(Boolean))];

/**
 * How far a thing's names are from the name asked for: 3 the same, 2 the same
 * words inside a longer name or the name without its subtitle (`leads`), 1 a
 * letter or two off, 0 not it.
 */
export function likeness(wanted, keys, leads = []) {
  if (keys.includes(wanted)) return 3;
  if (leads.includes(wanted) || keys.some((key) => within(wanted, key))) return 2;
  return keys.some((key) => misspelt(wanted, key)) ? 1 : 0;
}

/**
 * Chooses among the things the catalogue found. `wanted` is `{ key, year, country }`
 * and each candidate has `{ keys, year, countries, known }`, where `known` says
 * how well known it is. `clearly(a, b)` says whether `a` is so much better known
 * than `b` that it may be taken without asking. Returns one of:
 *   { one, others }   that one; `others` counts the namesakes passed over
 *   { several }       up to MAX_CHOICES that nothing tells apart, best known first
 *   { none: true }    nothing is called that
 * with `wrongYear` when a year was asked for and nothing of that name is from it,
 * and `inexact` when the name is not quite the one asked for. The one chosen
 * comes with `shared` when something else has exactly its name, whatever the
 * year or country that told them apart, and with `outshone` when one of those
 * is at least as well known as it is.
 */
export function pick(candidates, wanted, clearly = CLEARLY.film) {
  const scored = candidates.map((candidate) => ({ candidate, like: likeness(wanted.key, candidate.keys, candidate.leads) })).filter((entry) => entry.like > 0);
  if (!scored.length) return { none: true };
  const chosen = (one, rest) => {
    const namesakes = scored.filter((entry) => entry.like === 3 && entry.candidate !== one).map((entry) => entry.candidate);
    const own = scored.find((entry) => entry.candidate === one).like === 3;
    return { one, ...rest, ...(own && namesakes.length && { shared: true }), ...(own && namesakes.some((other) => other.known >= one.known) && { outshone: true }) };
  };
  // A misspelling is only believed when nothing has the name as given.
  const strong = scored.filter((entry) => entry.like >= 2);
  let pool = strong.length ? strong : scored;

  if (wanted.country) {
    const from = pool.filter(({ candidate }) => candidate.countries?.includes(wanted.country));
    if (from.length) pool = from;
  }
  let wrongYear = false;
  if (wanted.year != null) {
    const apart = ({ candidate }) => (candidate.year == null ? Infinity : Math.abs(candidate.year - wanted.year));
    const same = pool.filter((entry) => apart(entry) === 0);
    // Dates differ by a year between countries and sources.
    const near = same.length ? same : pool.filter((entry) => apart(entry) <= 1);
    if (near.length) pool = near;
    else wrongYear = true;
  }
  const best = Math.max(...pool.map((entry) => entry.like));
  const ranked = pool.filter((entry) => entry.like === best).map((entry) => entry.candidate).sort((a, b) => b.known - a.known);
  const flags = { ...(wrongYear && { wrongYear: true }), ...(best < 3 && { inexact: true }) };
  if (ranked.length === 1 || clearly(ranked[0], ranked[1])) return chosen(ranked[0], { others: ranked.length - 1, ...flags });
  // None stands out. If only one is called exactly that, and the rest merely also go by it, that one is meant.
  const outright = ranked.filter((candidate) => candidate.key === wanted.key);
  return outright.length === 1 ? chosen(outright[0], { others: ranked.length - 1, ...flags }) : { several: ranked.slice(0, MAX_CHOICES), ...flags };
}

/** Splits "Kestrelmere US" into the name and the country it names, when it ends in one. */
export function splitCountry(title) {
  const match = /^(.+?)[\s(]+([A-Za-z]{2,3})\)?$/.exec(String(title ?? '').trim());
  const country = match ? COUNTRY_WORDS[match[2].toLowerCase()] : null;
  // "US" in capitals is a country; "us" at the end of a title is a word.
  return country && match[2] === match[2].toUpperCase() ? { name: match[1].trim(), country } : { name: String(title ?? '').trim(), country: null };
}

// A name with a description after it: "The Vampires, the French serial", "Metropolis - the 1927 one".
const DESCRIBED = /^(.{2,}?)\s*(?:,|\s[-–—])\s*((?:the|a|an|that|this|from|with|by|starring|directed|made)\b.*)$/i;

/**
 * The name alone, where a description follows it, as `{ name, year }` with any
 * year the description gives. Null when nothing reads as a description: a comma
 * is part of many names.
 */
export function withoutDescription(title) {
  const match = DESCRIBED.exec(String(title ?? '').trim());
  if (!match) return null;
  const year = /\b(1[89]\d\d|20\d\d)\b/.exec(match[2]);
  return { name: match[1].trim(), year: year ? Number(year[1]) : null };
}

/** The words of a name, with nothing a search would read as an instruction to it: no punctuation, and no AND, OR or NOT in capitals. */
const searchWords = (text) => String(text ?? '').replace(/['’]/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// ---- Dates ---------------------------------------------------------------------

const dateOf = (value) => /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ''))?.[1] ?? null;
const yearOf = (date) => (date ? Number(date.slice(0, 4)) : null);
const today = (now) => new Date(now).toISOString().slice(0, 10);

/** A date the way a person would say it: "18 December 2026". */
export function sayDate(date) {
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(time) ? '' : new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

let regions = null;
/** "United States" for "US". */
export function countryName(code) {
  try {
    regions ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regions.of(String(code).toUpperCase()) ?? String(code);
  } catch {
    return String(code);
  }
}

/**
 * Where a film stands: 'out', 'due' (not released; `film.date` or `film.year`
 * says when, if that is known) or 'unknown'.
 */
export function standing(film, now = Date.now()) {
  const day = today(now);
  if (film.date) return film.date > day ? 'due' : 'out';
  if (film.year != null) {
    // Only the year is known. This year's could be either.
    const year = Number(day.slice(0, 4));
    return film.year > year ? 'due' : film.year < year ? 'out' : 'unknown';
  }
  return film.unfinished ? 'due' : 'unknown';
}

// ---- Reading Wikidata ----------------------------------------------------------

const unique = (values) => [...new Set(values)];
const keysOf = (names) => unique(names.map(nameKey).filter(Boolean));

/** An entity's statements for one property: the preferred ones when some are marked so, and never the withdrawn ones. */
function claimsOf(entity, property) {
  const claims = (entity?.claims?.[property] ?? []).filter((claim) => claim.rank !== 'deprecated' && claim.mainsnak?.snaktype === 'value');
  const preferred = claims.filter((claim) => claim.rank === 'preferred');
  return preferred.length ? preferred : claims;
}
const STATEMENTS_READ = new Set(Object.values(P));
/**
 * An entity cut down to what is read from it. A well-known film's entry runs
 * to hundreds of kilobytes, nearly all of it statements PiRick never looks
 * at, and a thousand answers are kept at a time. Of its site links only how
 * many there are and the English Wikipedia page are used.
 */
export function slimEntity(entity) {
  const claims = {};
  for (const [property, list] of Object.entries(entity.claims ?? {})) {
    if (!STATEMENTS_READ.has(property)) continue;
    claims[property] = list.map((claim) => ({ rank: claim.rank, mainsnak: { snaktype: claim.mainsnak?.snaktype, datavalue: { value: claim.mainsnak?.datavalue?.value } } }));
  }
  const sitelinks = Object.fromEntries(Object.entries(entity.sitelinks ?? {}).map(([site, link]) => [site, site === 'enwiki' ? { title: link?.title } : {}]));
  return {
    id: entity.id,
    labels: entity.labels,
    aliases: entity.aliases,
    descriptions: entity.descriptions,
    ...(entity.sitelinks && { sitelinks }),
    ...(entity.claims && { claims }),
  };
}
const idsOf = (entity, property) => claimsOf(entity, property).map((claim) => claim.mainsnak.datavalue?.value?.id).filter(Boolean);
const textsOf = (entity, property) => claimsOf(entity, property).map((claim) => claim.mainsnak.datavalue?.value).map((value) => (typeof value === 'string' ? value : value?.text)).filter(Boolean);

/** The earliest date a property gives: `{ year, date }`, with `date` null when only the year or month is known. */
function earliest(entity, property) {
  const dates = claimsOf(entity, property)
    .map((claim) => {
      const value = claim.mainsnak.datavalue?.value;
      const match = /^\+(\d{4})-(\d{2})-(\d{2})/.exec(value?.time ?? '');
      if (!match) return null;
      const exact = Number(value.precision) >= 11 && match[2] !== '00' && match[3] !== '00';
      return { year: Number(match[1]), date: exact ? `${match[1]}-${match[2]}-${match[3]}` : null };
    })
    .filter(Boolean)
    .sort((a, b) => a.year - b.year || (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  return dates[0] ?? { year: null, date: null };
}

const labelOf = (entity) => cleanName(entity?.labels?.en?.value);
const describedAs = (entity) => cleanAbout(entity?.descriptions?.en?.value, ABOUT_IN_LISTS);
/** Descriptions usually begin with the year: "1963 film directed by…". */
const yearIn = (text) => {
  const match = /\b(1[89]\d\d|20\d\d)\b/.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
};
const kindOf = (entity) => {
  const kinds = idsOf(entity, P.kind);
  return kinds.some((id) => FILM_KINDS.includes(id)) ? 'film' : kinds.some((id) => SHOW_KINDS.includes(id)) ? 'show' : null;
};
/** For pages whose kind is only known from how they are described. */
function kindSaid(description) {
  const text = String(description ?? '');
  if (/\b(?:actor|actress|director|producer|singer|writer|character|franchise|film series|company|studio|award|festival|soundtrack|album|song|novel|book|video game)\b|\b(?:season|series) (?:\d+|one|two|three|four|five)\b|\b(?:season|series) of\b/i.test(text)) return null;
  if (/\b(?:television|TV|web|streaming|animated|anime|drama|comedy) (?:series|show|program|programme|sitcom|drama)\b|\bminiseries\b|\bsitcom\b|\bseries\b/i.test(text)) return 'show';
  return /\b(?:film|movie|short)\b/i.test(text) ? 'film' : null;
}

/** A film as a search first turns it up: its names and how well known it is. Dates come later, for those with the right name. */
function filmFound(entity) {
  const title = labelOf(entity);
  const names = [title, ...(entity.aliases?.en ?? []).map((alias) => cleanName(alias.value))].filter(Boolean);
  return {
    kind: 'film',
    id: entity.id,
    title,
    year: yearIn(entity.descriptions?.en?.value),
    date: null,
    countries: [],
    known: Object.keys(entity.sitelinks ?? {}).length,
    key: nameKey(title),
    keys: keysOf(names),
    leads: leadsOf(names),
    about: describedAs(entity),
    firm: false,
  };
}

/** Everything about a film. `names` gives the English name of each thing it points to. */
function filmFrom(entity, names) {
  const found = filmFound(entity);
  const { year, date } = earliest(entity, P.date);
  const kinds = idsOf(entity, P.kind);
  const original = cleanName(textsOf(entity, P.title)[0]);
  const all = unique([found.title, original, ...(entity.aliases?.en ?? []).map((alias) => cleanName(alias.value))].filter(Boolean));
  const named = (ids, most) => unique(ids.map((id) => names.get(id)?.label).filter(Boolean)).slice(0, most);
  const neighbour = (property) => {
    const other = names.get(idsOf(entity, property)[0]);
    return other?.label ? { title: other.label, year: yearIn(other.description) } : null;
  };
  const animated = kinds.some((id) => ANIMATED_KINDS.has(id)) || idsOf(entity, P.genre).some((id) => ANIMATED_KINDS.has(id));
  return {
    ...found,
    originalTitle: original && nameKey(original) !== nameKey(found.title) ? original : null,
    year: year ?? found.year,
    date,
    unfinished: kinds.includes(UNFINISHED_FILM),
    countries: named(idsOf(entity, P.country), 3),
    directors: named(idsOf(entity, P.director), 2),
    cast: named(idsOf(entity, P.cast), MAX_CAST),
    follows: neighbour(P.follows),
    followedBy: neighbour(P.followedBy),
    seriesId: idsOf(entity, P.series)[0] ?? null,
    names: all,
    keys: keysOf(all),
    leads: leadsOf(all),
    anime: kinds.some((id) => ANIME_KINDS.has(id)) || (animated && (idsOf(entity, P.country).includes(JAPAN) || idsOf(entity, P.language).includes(JAPANESE))),
    genres: named(idsOf(entity, P.genre), 3),
    page: entity.sitelinks?.enwiki?.title ?? null,
    firm: true,
  };
}
/** Which other things a film's facts point to, whose names are needed to state them. */
const pointsTo = (entity) => [
  ...idsOf(entity, P.director).slice(0, 2),
  ...idsOf(entity, P.cast).slice(0, MAX_CAST),
  ...idsOf(entity, P.country).slice(0, 3),
  ...idsOf(entity, P.genre).slice(0, 3),
  ...idsOf(entity, P.follows).slice(0, 1),
  ...idsOf(entity, P.followedBy).slice(0, 1),
];

/** One line of a list: a film or show by its name, year and what it is said to be. */
function listed(entity, kind = kindOf(entity) ?? kindSaid(entity?.descriptions?.en?.value)) {
  const title = labelOf(entity);
  if (!title || !kind) return null;
  const year = earliest(entity, P.date).year ?? earliest(entity, P.start).year ?? yearIn(entity.descriptions?.en?.value);
  return { kind, title, year, about: describedAs(entity) };
}

// ---- Reading TVmaze ------------------------------------------------------------

/** A show as a search turns it up, which is already enough to choose by. */
function showFound(show) {
  const title = cleanName(show.name);
  const date = dateOf(show.premiered);
  const country = show.network?.country?.code ?? show.webChannel?.country?.code ?? null;
  return {
    kind: 'show',
    id: Number(show.id),
    title,
    year: yearOf(date),
    date,
    countries: country ? [String(country).toUpperCase()] : [],
    known: Number(show.weight) || 0,
    key: nameKey(title),
    keys: keysOf([title]),
    leads: leadsOf([title]),
    about: cleanAbout(show.summary, ABOUT_MAX),
    firm: true,
  };
}

const LATIN_LETTERS = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{Zs}]+$/u;
/** Whether a name is written in the letters release names are written in. */
export const inLatinLetters = (name) => LATIN_LETTERS.test(String(name ?? ''));

/** Everything about a show, its episode guide included. */
function showFrom(show, now) {
  const found = showFound(show);
  const day = today(now);
  const parts = show._embedded ?? {};
  // Specials have no number and are not part of a season.
  const episodes = (parts.episodes ?? [])
    .filter((episode) => Number.isInteger(episode.season) && episode.season >= 1 && Number.isInteger(episode.number) && (episode.type ?? 'regular') === 'regular')
    .map((episode) => ({ season: episode.season, episode: episode.number, date: dateOf(episode.airdate) }));
  const aired = (episode) => Boolean(episode.date) && episode.date <= day;
  const seasons = unique(episodes.map((episode) => episode.season))
    .sort((a, b) => a - b)
    .map((number) => {
      const own = episodes.filter((episode) => episode.season === number);
      return { number, episodes: own.length, aired: own.filter(aired).length, date: own.map((episode) => episode.date).filter(Boolean).sort()[0] ?? null };
    });
  const inOrder = [...episodes].sort((a, b) => a.season - b.season || a.episode - b.episode);
  const status = String(show.status ?? '');
  const names = unique([found.title, ...(parts.akas ?? []).map((aka) => cleanName(aka.name))].filter(Boolean));
  // The names a release could go by: what the show is called where it was made, or everywhere, in letters an
  // indexer has. What it is called in other countries is for recognising it, not for finding it.
  const own = (aka) => !aka.country?.code || found.countries.includes(String(aka.country.code).toUpperCase());
  const ownNames = unique([found.title, ...(parts.akas ?? []).filter(own).map((aka) => cleanName(aka.name))].filter((name) => name && LATIN_LETTERS.test(name)));
  return {
    ...found,
    // 'running' is still being made, 'upcoming' has not started, 'unsure' is in between seasons with no word either way.
    status: /ended/i.test(status) ? 'ended' : /running/i.test(status) ? 'running' : /development/i.test(status) ? 'upcoming' : /determined/i.test(status) ? 'unsure' : '',
    seasons,
    last: inOrder.findLast(aired) ?? null,
    next: inOrder.find((episode) => episode.date && episode.date > day) ?? null,
    creators: unique((parts.crew ?? []).filter((entry) => entry.type === 'Creator').map((entry) => cleanName(entry.person?.name)).filter(Boolean)).slice(0, 2),
    cast: unique((parts.cast ?? []).map((entry) => cleanName(entry.person?.name)).filter(Boolean)).slice(0, MAX_CAST),
    names,
    ownNames,
    keys: keysOf(names),
    leads: leadsOf(names),
    anime: show.type === 'Animation' && show.language === 'Japanese',
    genres: (show.genres ?? []).map(cleanName).filter(Boolean).slice(0, 3),
    imdb: /^tt\d+$/.test(show.externals?.imdb ?? '') ? show.externals.imdb : null,
  };
}

// ---- The client ----------------------------------------------------------------

/** `fetch` can be replaced, which the benchmark does to stand in for the services. `now` likewise, for dates. */
export function createCatalogue(config, { fetch: send = fetch, now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const kept = new Map();

  async function get(service, url) {
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await send(url, {
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
          // Wikipedia sends a page's other spellings on to the page; nothing else here has cause to redirect.
          redirect: service === 'Wikipedia' ? 'follow' : 'error',
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        throw new UpstreamError('catalogue', `Cannot reach ${service} (${describeError(err)})`);
      }
      // Asked too often, a service wants a moment's peace and then answers.
      if (res.status !== 429 || attempt > 1) break;
      await res.body?.cancel();
      await pause(ASKED_TOO_OFTEN_MS);
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new UpstreamError('catalogue', res.status === 429 ? `${service} is being asked too often and wants PiRick to slow down` : `${service} returned HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new UpstreamError('catalogue', `${service} did not answer as expected`);
    }
  }
  async function wikidata(params) {
    const data = await get('Wikidata', `${config.wikidata}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`);
    // Wikidata reports a request it will not serve inside an ordinary answer.
    if (data?.error) throw new UpstreamError('catalogue', `Wikidata refused a request (${cleanName(data.error.code) || 'no reason given'})`);
    return data;
  }
  const tvmaze = (path) => get('TVmaze', `${config.tvmaze}${path}`);

  // Answers are kept for a while: the catalogue changes slowly, and one request
  // to PiRick asks it the same thing several times.
  const recalled = (key, freshMs) => {
    const hit = kept.get(key);
    return hit && now() - hit.at < freshMs ? hit : null;
  };
  function keep(key, value) {
    kept.delete(key);
    kept.set(key, { at: now(), value });
    while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
    return value;
  }
  const remembered = async (key, freshMs, load) => (recalled(key, freshMs) ?? { value: keep(key, await load()) }).value;

  // ---- Wikidata ------------------------------------------------------------------

  /** The ids of what Wikidata finds for some words, among things that have all of `having` (statements such as "P31=Q11424"). */
  const searchIds = (text, having = [], { sort, most = MAX_FOUND } = {}) =>
    remembered(`ids ${text} ${having.join(' ')} ${sort} ${most}`, SEARCH_FRESH_MS, async () => {
      const srsearch = [text, ...having.map((statement) => `haswbstatement:${statement}`)].filter(Boolean).join(' ');
      const data = await wikidata({ action: 'query', list: 'search', srsearch, srlimit: String(most), srprop: '', ...(sort && { srsort: sort }) });
      return (data?.query?.search ?? []).map((hit) => String(hit.title)).filter((id) => /^Q\d+$/.test(id));
    });
  const BEST_KNOWN_FIRST = 'incoming_links_desc';

  const LIGHT = 'labels|aliases|descriptions|sitelinks';
  // Statements are most of an entity's size, so they are only asked for when they are needed.
  const FULL = 'labels|aliases|descriptions|sitelinks|claims';
  /** Entities by id, in the order asked for, each with the parts asked for. What has been fetched once is kept. */
  async function entities(ids, parts) {
    const found = new Map();
    const wanted = unique(ids);
    const missing = wanted.filter((id) => {
      // A fuller copy already in hand serves as well.
      const hit = recalled(`entity ${parts} ${id}`, DETAILS_FRESH_MS) ?? recalled(`entity ${FULL} ${id}`, DETAILS_FRESH_MS);
      if (hit) found.set(id, hit.value);
      return !hit;
    });
    for (let i = 0; i < missing.length; i += 50) {
      const data = await wikidata({ action: 'wbgetentities', ids: missing.slice(i, i + 50).join('|'), props: parts, languages: 'en' });
      for (const entity of Object.values(data?.entities ?? {})) {
        if (entity?.id && entity.missing === undefined) found.set(entity.id, keep(`entity ${parts} ${entity.id}`, slimEntity(entity)));
      }
    }
    return new Map(wanted.filter((id) => found.has(id)).map((id) => [id, found.get(id)]));
  }
  /** The English name and description of each id. */
  const namesOf = async (ids) => new Map([...(await entities(ids, 'labels|descriptions'))].map(([id, entity]) => [id, { label: labelOf(entity), description: entity.descriptions?.en?.value ?? '' }]));

  const filmsFound = async (ids) => [...(await entities(ids, LIGHT)).values()].map(filmFound).filter((film) => film.title);

  /** Everything about one film, or null when Wikidata no longer has it. */
  const film = (id) =>
    remembered(`film ${id}`, DETAILS_FRESH_MS, async () => {
      const entity = (await entities([id], FULL)).get(id);
      return entity ? filmFrom(entity, await namesOf(pointsTo(entity))) : null;
    });

  /** The films of the series one belongs to, in the order they came out: `{ name, films: [{ title, year }] }`, or null. */
  const seriesOf = (thing) =>
    !thing?.seriesId
      ? null
      : remembered(`series ${thing.seriesId}`, DETAILS_FRESH_MS, async () => {
          const ids = await searchIds('', [`${P.series}=${thing.seriesId}`, KIND_FILTER.film], { sort: BEST_KNOWN_FIRST, most: MAX_SERIES });
          const members = [...(await entities(ids, FULL)).values()].map((entity) => ({ title: labelOf(entity), ...earliest(entity, P.date) })).filter((member) => member.title);
          if (members.length < 2) return null;
          members.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || (a.date ?? '9999').localeCompare(b.date ?? '9999'));
          const name = (await namesOf([thing.seriesId])).get(thing.seriesId)?.label ?? '';
          return { name, films: members.map(({ title, year }) => ({ title, year })) };
        });

  // ---- TVmaze --------------------------------------------------------------------

  /** Everything about one show, or null when TVmaze no longer has it. */
  const show = (id) =>
    remembered(`show ${id}`, DETAILS_FRESH_MS, async () => {
      const data = await tvmaze(`/shows/${encodeURIComponent(id)}?embed[]=episodes&embed[]=akas&embed[]=cast&embed[]=crew`);
      return data ? showFrom(data, now()) : null;
    });

  // ---- Working out which one is meant ------------------------------------------

  // How each kind of thing is searched for. TVmaze forgives misspellings by
  // itself and gives the year and country at once; Wikidata does neither.
  const SOURCES = {
    film: {
      clearly: CLEARLY.film,
      /** With a year, the year is searched for too: descriptions begin with it, and a common name has more films than one answer holds. */
      search: async (words, year) => filmsFound(await searchIds([...words, ...(year == null ? [] : [String(year)])].join(' '), [KIND_FILTER.film])),
      /** Sets the true date of each, which a search does not give. */
      async firm(films) {
        const full = await entities(films.map((found) => found.id), FULL);
        for (const found of films) {
          const { year, date } = earliest(full.get(found.id), P.date);
          Object.assign(found, { year: year ?? found.year, date, firm: true });
        }
      },
      /** A film's names in every language. What is kept is the names as compared, not the answer they came in. */
      otherKeys: (found) =>
        remembered(`names ${found.id}`, DETAILS_FRESH_MS, async () => {
          const data = await wikidata({ action: 'wbgetentities', ids: found.id, props: 'labels|aliases' });
          const entity = data?.entities?.[found.id];
          const names = [...Object.values(entity?.labels ?? {}).map((label) => label.value), ...Object.values(entity?.aliases ?? {}).flatMap((list) => list.map((alias) => alias.value))];
          return keysOf(names.slice(0, MAX_OTHER_NAMES).map(cleanName));
        }),
      /** For a name that found nothing: the same words with a letter or two allowed to differ, and lastly anything described as a film. */
      async loosely(words) {
        const roughly = (list) => list.map((word) => (word.length >= 4 ? `${word}~` : word)).join(' ');
        const longest = [...words].sort((a, b) => b.length - a.length).slice(0, 2);
        for (const text of unique([roughly(words), roughly(longest)])) {
          const ids = await searchIds(text, [KIND_FILTER.film]);
          if (ids.length) return filmsFound(ids);
        }
        const any = [...(await entities(await searchIds(words.join(' ')), LIGHT)).values()];
        return any.filter((entity) => kindSaid(entity.descriptions?.en?.value) === 'film').map(filmFound).filter((found) => found.title);
      },
      details: (found) => film(found.id),
    },
    show: {
      clearly: CLEARLY.show,
      /** TVmaze cannot be asked for a year, so a second look with one has nothing to add. */
      async search(words, year) {
        if (year != null) return [];
        const hits = await remembered(`shows ${words.join(' ')}`, SEARCH_FRESH_MS, () => tvmaze(`/search/shows?q=${encodeURIComponent(words.join(' '))}`));
        return (hits ?? []).map((hit) => showFound(hit.show ?? {})).filter((found) => found.title);
      },
      firm: async () => {},
      otherKeys: async (found) => (await show(found.id))?.keys ?? [],
      loosely: async () => [],
      details: (found) => show(found.id),
    },
  };

  /**
   * Works out which film or show a name means. `asked` is `{ title, year, country }`.
   * Resolves to `{ one }`, `{ several }` or `{ none: true }` as `pick` does, with
   * everything known about each in place of what the search gave.
   */
  async function find(kind, asked) {
    const source = SOURCES[kind];
    const title = cleanName(asked.title);
    const words = searchWords(title);
    const wanted = { key: nameKey(title), year: asked.year ?? null, country: asked.country ?? null };
    if (!wanted.key || !words.length) return { none: true };
    const pool = new Map();
    const add = (list) => {
      for (const found of list) if (!pool.has(found.id)) pool.set(found.id, found);
    };
    const choose = async () => {
      const like = (found) => likeness(wanted.key, found.keys, found.leads);
      const named = [...pool.values()].filter((found) => like(found) > 0);
      // Those with exactly the name come first, however little known: a new film that has the name of a
      // series of well-known ones is still the one of that name.
      const unsure = named.filter((found) => !found.firm).sort((a, b) => like(b) - like(a) || b.known - a.known).slice(0, MAX_NAMED);
      if (unsure.length) await source.firm(unsure);
      return pick(named.filter((found) => found.firm), wanted, source.clearly);
    };

    add(await source.search(words));
    let choice = await choose();
    if (wanted.year != null && (choice.none || choice.wrongYear)) {
      add(await source.search(words, wanted.year));
      choice = await choose();
    }
    if (choice.none) {
      // Numbers written the other way: "7" for "Seven".
      for (const variant of queryVariants(title)) add(await source.search(searchWords(variant)));
      choice = await choose();
    }
    if (choice.none || choice.inexact) {
      // It may have been found under another of its names: a translation, another country's title.
      for (const found of [...pool.values()].slice(0, MAX_ALIASES_CHECKED)) found.keys = unique([...found.keys, ...(await source.otherKeys(found))]);
      choice = await choose();
    }
    if (choice.none) {
      add(await source.loosely(words));
      choice = await choose();
    }
    if (choice.none) return { none: true };
    const { one, several, ...rest } = choice;
    const full = async (found) => (await source.details(found)) ?? found;
    return one ? { one: await full(one), ...rest } : { several: await Promise.all(several.map(full)), ...rest };
  }
  const named = (kind, asked) => remembered(`find ${kind} ${nameKey(asked.title)} ${asked.year ?? ''} ${asked.country ?? ''}`, SEARCH_FRESH_MS, () => find(kind, asked));
  async function found(kind, asked) {
    const choice = await named(kind, asked);
    // Nothing has all of it for a name. If it ends in a description, what comes before that is the name.
    const plain = choice.none ? withoutDescription(asked.title) : null;
    return plain ? named(kind, { ...asked, title: plain.name, year: asked.year ?? plain.year }) : choice;
  }

  const findFilm = (asked) => found('film', asked);
  /** Which show a name means. A country may follow the name: "Kestrelmere US". */
  async function findShow(asked) {
    const { name, country } = asked.country ? { name: asked.title, country: asked.country } : splitCountry(asked.title);
    const choice = await found('show', { ...asked, title: name, country });
    if (name === asked.title || !(choice.none || choice.inexact)) return choice;
    // The letters may have been part of the name after all.
    const whole = await found('show', { ...asked, country: null });
    return choice.none || !(whole.none || whole.inexact) ? whole : choice;
  }

  // ---- People and suggestions ------------------------------------------------------

  /**
   * The films and shows among some Wikidata ids, as lines of a list, in the
   * order given. With `ofAGenre`, they are a genre's shelf instead: a famous
   * film gathers stray labels, so those filed under many genres are set aside,
   * and the rest go by how many Wikipedias write about them.
   */
  async function listOf(ids, { most = MAX_LISTED, ofAGenre = false } = {}) {
    const full = await entities(ids, FULL);
    const all = ids.map((id) => ({ line: listed(full.get(id)), genres: idsOf(full.get(id), P.genre).length, known: Object.keys(full.get(id)?.sitelinks ?? {}).length })).filter((entry) => entry.line);
    if (!ofAGenre) return all.map((entry) => entry.line).slice(0, most);
    const focused = all.filter((entry) => entry.genres <= MAX_GENRES_OF_ITS_OWN);
    return (focused.length >= most ? focused : all).sort((a, b) => b.known - a.known).map((entry) => entry.line).slice(0, most);
  }
  const KINDS = [KIND_FILTER.film, KIND_FILTER.show].join('|');
  /** Has this person among its cast, or as its director or creator. */
  const inAnyPart = (id) => [P.cast, P.director, P.creator].map((property) => `${property}=${id}`).join('|');

  /** What someone is known for: their own work first, then the best known. */
  const credits = (id) =>
    remembered(`credits ${id}`, DETAILS_FRESH_MS, async () => {
      // Films and shows are asked for apart: taken together, a film star's dozen best-known parts are all films.
      const [actedInFilms, actedInShows, directed, created, person] = await Promise.all([
        searchIds('', [`${P.cast}=${id}`, KIND_FILTER.film], { sort: BEST_KNOWN_FIRST, most: 12 }),
        searchIds('', [`${P.cast}=${id}`, KIND_FILTER.show], { sort: BEST_KNOWN_FIRST, most: 6 }),
        searchIds('', [`${P.director}=${id}`, KINDS], { sort: BEST_KNOWN_FIRST, most: 8 }),
        searchIds('', [`${P.creator}=${id}`, KINDS], { sort: BEST_KNOWN_FIRST, most: 4 }),
        entities([id], FULL),
      ]);
      const acted = [...actedInFilms, ...actedInShows];
      const roles = new Map();
      const note = (ids, as) => ids.forEach((part, rank) => roles.set(part, { rank: Math.min(rank, roles.get(part)?.rank ?? rank), as: [...(roles.get(part)?.as ?? []), as] }));
      note(actedInFilms, 'actor');
      note(actedInShows, 'actor');
      note(directed, 'director');
      note(created, 'creator');
      const directs = idsOf(person.get(id), P.occupation).some((occupation) => DIRECTORS.has(occupation)) && directed.length >= acted.length;
      const knownFor = directs || (!acted.length && directed.length) ? 'director' : acted.length ? 'actor' : null;
      const full = await entities([...roles.keys()], 'labels|descriptions|claims');
      const parts = [...roles]
        .map(([part, role]) => ({ ...listed(full.get(part)), ...role }))
        .filter((part) => part.title)
        // What they both made and appeared in is most their own. After that, the best known of each thing
        // they do, turn about, so that what a director directed is not buried under what she acted in.
        .sort((a, b) => b.as.length - a.as.length || a.rank - b.rank || Number(b.as.includes(knownFor)) - Number(a.as.includes(knownFor)));
      const of = (kind, most) => parts.filter((part) => part.kind === kind).slice(0, most).map(({ title, year, as }) => ({ title, year, as }));
      return { name: labelOf(person.get(id)), knownFor, films: of('film', MAX_FILMS_OF_PERSON), shows: of('show', MAX_SHOWS_OF_PERSON) };
    });

  /** The films and shows Wikipedia's readers looked at most yesterday, as lines of a list. */
  const mostRead = () =>
    remembered('most read', 6 * 60 * 60 * 1000, async () => {
      // The day's figures appear some hours after it ends.
      let pages = [];
      for (const daysAgo of [1, 2, 3]) {
        const [year, month, day] = today(now() - daysAgo * DAY_MS).split('-');
        const data = await get('Wikipedia', `${config.pageviews}/metrics/pageviews/top/en.wikipedia/all-access/${year}/${month}/${day}`);
        pages = (data?.items?.[0]?.articles ?? []).map((entry) => String(entry.article)).filter((page) => !/^(?:Main_Page$|[A-Za-z_ ]+:)/.test(page));
        if (pages.length) break;
      }
      const lines = [];
      for (let i = 0; i < Math.min(pages.length, MOST_READ_CHECKED); i += 50) {
        // Page names come with underscores for spaces.
        const batch = pages.slice(i, i + 50).map((page) => page.replace(/_/g, ' '));
        const data = await wikidata({ action: 'wbgetentities', sites: 'enwiki', titles: batch.join('|'), props: 'labels|descriptions|sitelinks', sitefilter: 'enwiki', languages: 'en' });
        const byPage = new Map(Object.values(data?.entities ?? {}).map((entity) => [String(entity.sitelinks?.enwiki?.title ?? ''), entity]));
        for (const page of batch) {
          const entity = byPage.get(page);
          const line = entity && listed(entity, kindSaid(entity.descriptions?.en?.value));
          if (line) lines.push(line);
        }
      }
      return lines;
    });

  return {
    /** False unless switched on, and PiRick carries on without a catalogue. */
    enabled: Boolean(config.enabled),

    film,
    show,
    findFilm,
    findShow,
    seriesOf,

    /**
     * Which film or show a name means, when it is not known which of the two it
     * is. Resolves as `find` does; what comes back says its own `kind`.
     */
    async findAny(asked) {
      const choices = await Promise.all([findFilm(asked), findShow(asked)]);
      const options = choices.flatMap((choice) => (choice.one ? [choice.one] : choice.several ?? []).map((entry) => ({ entry, choice })));
      if (!options.length) return { none: true };
      // One with exactly the name, from the year asked for, beats one that only nearly fits.
      const fit = ({ choice }) => Number(!choice.inexact) * 2 + Number(!choice.wrongYear);
      const best = Math.max(...options.map(fit));
      const chosen = options.filter((option) => fit(option) === best);
      const ranked = chosen.map((option) => option.entry).sort((a, b) => fame(b) - fame(a));
      const flags = { ...(chosen[0].choice.wrongYear && { wrongYear: true }), ...(chosen[0].choice.inexact && { inexact: true }) };
      if (ranked.length === 1 || (fame(ranked[0]) >= 0.3 && fame(ranked[0]) >= fame(ranked[1]) * 3)) return { one: ranked[0], others: ranked.length - 1, ...flags };
      // As in `pick`: the one called exactly that, where the rest only also go by the name.
      const outright = ranked.filter((thing) => thing.key === nameKey(cleanName(asked.title)));
      return outright.length === 1 ? { one: outright[0], others: ranked.length - 1, ...flags } : { several: ranked.slice(0, MAX_CHOICES), ...flags };
    },

    /** A few lines about a film or show: Wikipedia's opening for a film that has a page, else what the catalogue calls it. */
    async about(thing) {
      if (thing?.kind !== 'film' || !thing.page) return thing?.about ?? '';
      const summary = await remembered(`page ${thing.page}`, DETAILS_FRESH_MS, () => get('Wikipedia', `${config.wikipedia}/page/summary/${encodeURIComponent(thing.page.replace(/ /g, '_'))}`)).catch(() => null);
      return cleanAbout(summary?.extract) || thing.about;
    },

    /**
     * A person by name and what they are known for: `{ id, name, knownFor, films, shows }`,
     * each part as `{ title, year, as: ['actor'] }`, with `inexact` when the name is a
     * letter or two off the one asked for. Null when no one who has had a part in a
     * film or a show is called that.
     */
    async person(name) {
      const words = searchWords(cleanName(name));
      const wanted = nameKey(cleanName(name));
      if (!wanted || !words.length) return null;
      const called = async (text) =>
        [...(await entities(await searchIds(text, [`${P.kind}=${HUMAN}`]), LIGHT)).values()]
          .map((entity) => ({ id: entity.id, known: Object.keys(entity.sitelinks ?? {}).length, keys: keysOf([labelOf(entity), ...(entity.aliases?.en ?? []).map((alias) => cleanName(alias.value))]) }))
          .map(({ keys, ...entry }) => ({ ...entry, like: likeness(wanted, keys) || Number(keys.some((key) => nearlyNamed(wanted, key))) }))
          .filter((entry) => entry.like > 0)
          // The best known of those with the name, then of those nearly called it.
          .sort((a, b) => b.like - a.like || b.known - a.known);
      // Whoever has the name but no part in any film or show is not who is meant: a politician, say, whose
      // name is one letter from an actor's. The next of the name is tried, and then those nearly called it.
      const tried = new Set();
      for (const text of [words.join(' '), words.map((word) => (word.length >= 4 ? `${word}~` : word)).join(' ')]) {
        for (const entry of (await called(text)).filter((other) => !tried.has(other.id)).slice(0, MAX_NAMESAKES)) {
          tried.add(entry.id);
          if (!(await searchIds('', [inAnyPart(entry.id), KINDS], { most: 1 })).length) continue;
          const found = await credits(entry.id);
          if (found.films.length || found.shows.length) return { ...found, id: entry.id, ...(entry.like === 1 && { inexact: true }) };
        }
      }
      return null;
    },

    /**
     * The films and shows two people both had a part in, as actor, director or
     * creator, best known first: `{ kind, title, year }` each. The two are people
     * as `person` gives them.
     */
    async together(one, other) {
      if (!one?.id || !other?.id || one.id === other.id) return [];
      const ids = await searchIds('', [inAnyPart(one.id), inAnyPart(other.id), KINDS], { sort: BEST_KNOWN_FIRST, most: MAX_TOGETHER });
      const full = await entities(ids, 'labels|descriptions|claims');
      return ids.map((id) => listed(full.get(id))).filter(Boolean).map(({ kind, title, year }) => ({ kind, title, year }));
    },

    /**
     * Films or shows in the vein of one the catalogue knows: the rest of its
     * series, more by whoever made it, and well-known ones of the same kind.
     * Null when there is nothing to go on.
     */
    async like(thing) {
      let id = thing?.kind === 'film' ? thing.id : null;
      // A show is known to Wikidata by the number IMDb gives it.
      if (thing?.kind === 'show' && thing.imdb) [id] = await searchIds('', [`${P.imdb}=${thing.imdb}`], { most: 1 });
      const entity = id ? (await entities([id], FULL)).get(id) : null;
      if (!entity) return null;
      const kind = KIND_FILTER[thing.kind];
      const makers = [...idsOf(entity, P.director), ...idsOf(entity, P.creator)].slice(0, 1);
      const genres = idsOf(entity, P.genre).slice(0, 2);
      const series = idsOf(entity, P.series).slice(0, 1);
      const [sameSeries, sameMaker, sameKind] = await Promise.all([
        series.length ? searchIds('', [`${P.series}=${series[0]}`, kind], { sort: BEST_KNOWN_FIRST, most: 4 }) : [],
        makers.length ? searchIds('', [`${either(P.director, makers)}|${either(P.creator, makers)}`, kind], { sort: BEST_KNOWN_FIRST, most: 5 }) : [],
        genres.length ? searchIds('', [...genres.map((genre) => `${P.genre}=${genre}`), kind], { sort: BEST_KNOWN_FIRST, most: MAX_LISTED + 2 }) : [],
      ]);
      const ids = unique([...sameSeries, ...sameMaker.slice(0, 3), ...sameKind, ...sameMaker.slice(3)]).filter((other) => other !== id);
      return ids.length ? listOf(ids) : null;
    },

    /** What people are reading about just now: films, or shows. */
    popular: async (kind) => (await mostRead()).filter((line) => line.kind === kind).slice(0, MAX_LISTED),

    /** Well-known films or shows of one genre, or null when the catalogue has no such shelf for that kind of thing. */
    async ofGenre(kind, genre) {
      const filter = GENRE_FILTERS[genre]?.[kind === 'film' ? 0 : 1];
      if (!filter) return null;
      return listOf(await searchIds('', [filter, KIND_FILTER[kind]], { sort: BEST_KNOWN_FIRST, most: GENRE_SHELF }), { ofAGenre: true });
    },

    /** Confirms both services can be reached. */
    async check() {
      const [films, shows] = await Promise.all([wikidata({ action: 'wbgetentities', ids: 'Q11424', props: 'labels', languages: 'en' }), tvmaze('/shows/1')]);
      if (!films?.entities?.Q11424) throw new UpstreamError('catalogue', 'Wikidata did not answer as expected');
      if (!shows?.id) throw new UpstreamError('catalogue', 'TVmaze did not answer as expected');
      return 'Wikidata and TVmaze';
    },
  };
}
