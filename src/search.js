// Searching the way a person would want it to work: under every common spelling
// of the title, and keeping only results that are about what was asked for.
import { canonicalWord, numberFromRoman, numberFromWord, romanForNumber, wordForNumber } from './words.js';

const MAX_VARIANTS = 2;
// An empty answer this quick did not come from an indexer; it came from Jackett's cache.
const CACHED_ANSWER_MS = 2000;
const YEAR = /^(?:19|20)\d{2}$/;
const SEASON = /^s\d{1,2}$/;
// Words that describe a copy, not the thing itself.
const COPY_WORDS = new Set([
  '4k', 'uhd', 'hd', 'sd', 'hdr', 'bluray', 'blu', 'ray', 'brrip', 'bdrip', 'web', 'webrip', 'webdl', 'dl', 'hdtv', 'dvd', 'dvdrip',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'remux', 'extended', 'remastered', 'uncut', 'unrated', 'proper', 'repack',
]);
const ARTICLES = new Set(['the', 'a', 'an']);
// A name that ends like this is a program. Offered as a film, a show, an album or a book, it is an advert or worse.
const PROGRAM = /\.(?:exe|msi|bat|cmd|scr|apk|dmg|pkg|jar|vbs|ps1|lnk)$/i;
// Torznab's categories for console and PC games (1000, 4050) and for software (4000): there a program is what was asked for.
const mayBePrograms = (categories) => categories.some((id) => Math.floor(id / 1000) === 1 || Math.floor(id / 1000) === 4);

const isCopyWord = (word) => COPY_WORDS.has(word) || /^\d{3,4}[pi]$/.test(word);
const isMarker = (word) => YEAR.test(word) || isCopyWord(word.toLowerCase()) || /^s\d{1,2}(?:e\d{1,3})*$/i.test(word);

/** The words of a title or query, in the form used for comparing. */
export function canonicalWords(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(canonicalWord);
}

/** The same words in plain letters: "Señora Marisol" as "Senora Marisol", which is how release names write it. */
export const unaccented = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');

/**
 * Other spellings worth searching for, since indexers match release names
 * literally: "7 Chances" is released as "Seven.Chances", "Part 2" as "Part.II".
 */
export function queryVariants(query) {
  const words = String(query ?? '').split(/\s+/).filter(Boolean);
  // The number of a season is not part of a title: "Season 2" is not released as "Season Two".
  const fixed = (word, i) => isMarker(word) || (i > 0 && /^seasons?$/i.test(words[i - 1]));
  const rewrite = (change) => words.map((word, i) => (fixed(word, i) ? word : change(word, i) ?? word)).join(' ');
  const digits = (word) => (/^\d{1,4}$/.test(word) ? Number(word) : null);
  const variants = [
    // Digits as words, and words as digits.
    rewrite((word) => (digits(word) != null ? wordForNumber(digits(word)) : null)),
    rewrite((word) => numberFromWord(word)?.toString() ?? numberFromRoman(word)?.toString()),
    rewrite((word) => (word === '&' ? 'and' : null)),
  ];
  // A sequel number: "Part 2" is as likely to be "Part II". Only for one number that is not the first word.
  const titleWords = words.filter((word, i) => !fixed(word, i));
  const numbers = titleWords.filter((word) => digits(word) != null);
  if (numbers.length === 1 && titleWords[0] !== numbers[0]) variants.push(rewrite((word) => (digits(word) != null ? romanForNumber(digits(word)) : null)));

  const original = words.join(' ');
  return [...new Set(variants)].filter((variant) => variant !== original).slice(0, MAX_VARIANTS);
}

/**
 * Words after the year are not part of a title ("7 Chances 1925 Buster Keaton").
 * Returns the query cut off after its year, or null when there is nothing to cut.
 */
export function withoutTrailingWords(query) {
  const words = String(query ?? '').split(/\s+/).filter(Boolean);
  const year = words.findLastIndex((word) => YEAR.test(word));
  if (year < 1 || !words.slice(year + 1).some((word) => !isMarker(word))) return null;
  return words.slice(0, year + 1).join(' ');
}

/**
 * What a search for a film is made of: its title, its year, the words that
 * describe a copy ("1080p", "BluRay"), and whether it names a season or an
 * episode. A year that comes first is part of the title ("1808"), and words
 * after the year are not ("7 Chances 1925 Buster Keaton").
 */
export function splitQuery(query) {
  const words = String(query ?? '').replace(/[()[\]]/g, ' ').split(/\s+/).filter(Boolean);
  const season = (word) => /^s\d{1,2}(?:e\d{1,3})*$/i.test(word);
  const at = words.findLastIndex((word, i) => i > 0 && YEAR.test(word));
  return {
    title: (at > 0 ? words.slice(0, at) : words).filter((word) => !isCopyWord(word.toLowerCase()) && !season(word)).join(' '),
    year: at > 0 ? Number(words[at]) : null,
    copy: words.filter((word) => isCopyWord(word.toLowerCase())),
    episodes: words.some(season),
  };
}

/** The same query in other capitals: the same search to an indexer, a new one to Jackett's cache. */
function recapitalise(query) {
  const titled = query.replace(/\p{L}+/gu, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
  return titled === query ? query.toUpperCase() : titled;
}

/** Whether a release name is about what was searched for. */
function matcher(query) {
  const words = canonicalWords(query);
  const year = words.findLast((word) => YEAR.test(word)) ?? null;
  const wanted = words.filter((word) => !ARTICLES.has(word) && !isCopyWord(word) && word !== year);
  return {
    year,
    hasTitle: wanted.length > 0,
    matches(title) {
      // A year in the release name sits between title and season ("Show.2019.S01"); it is judged separately.
      const have = canonicalWords(title).filter((word) => !ARTICLES.has(word) && !YEAR.test(word));
      // "S01" also matches "S01E05".
      const same = (word, want) => word === want || (SEASON.test(want) && word.startsWith(want));
      // The wanted words, in order and close together. A long title may have a
      // word or two in between ("Night [of the] Living Dead");
      // a short one may not, or "Kestrel 2" would match "Kestrel Kane 2".
      const reach = wanted.length + (wanted.length >= 3 ? 2 : 0);
      for (let start = 0; start < have.length; start++) {
        if (!same(have[start], wanted[0])) continue;
        let at = 1;
        for (let i = start + 1; i < Math.min(have.length, start + reach) && at < wanted.length; i++) {
          if (same(have[i], wanted[at])) at += 1;
        }
        if (at === wanted.length) return true;
      }
      // Or the same letters run together or split differently: "Salt-Marsh" and "Saltmarsh".
      const joined = wanted.join('');
      return joined.length >= 5 && have.join('').includes(joined);
    },
  };
}

/** Keeps the results that are about `query`. Returns null when none clearly are. */
export function relevantResults(query, results) {
  const { year, hasTitle, matches } = matcher(query);
  if (!hasTitle) return results;
  const about = results.filter((result) => matches(result.title));
  if (!about.length) return null;
  // With a year given, a copy from that year beats the same title from another.
  const sameYear = year ? about.filter((result) => canonicalWords(result.title).includes(year)) : [];
  return sameYear.length ? sameYear : about;
}

/**
 * `retryCachedEmpty`: ask again, in other capitals, when an empty answer comes
 * back instantly. Jackett caches what an indexer returned, including nothing at
 * all after a hiccup, and replays it for the same query for half an hour.
 */
export function createFinder(jackett, { retryCachedEmpty = true, cachedAnswerMs = CACHED_ANSWER_MS } = {}) {
  async function ask(query, categories) {
    const started = Date.now();
    const results = await jackett.search(query, categories);
    if (results.length || !retryCachedEmpty || Date.now() - started >= cachedAnswerMs) return results;
    const again = recapitalise(query);
    return again === query ? results : jackett.search(again, categories);
  }

  return {
    /**
     * Searches for `query`, then for its other spellings if that found nothing
     * suitable. Searches run one after another: indexers behind a Cloudflare
     * solver return far fewer results when asked several things at once.
     *
     * Resolves to:
     *   results  best-seeded first
     *   also     the other spellings that had to be searched
     *   foundAs  the spelling that found them, when it was not the one asked for
     *   exact    false when nothing clearly matched and `results` is everything
     *            the indexers returned, which may be unrelated
     *
     * A result that is a program is left out, unless the categories searched are
     * those of games or software.
     *
     * `filter: false` skips the relevance check, for callers that do their own.
     * `onTry(spelling)` is called before each search, to show progress.
     * `title` is the part at the start of the query that is a title, when the
     * caller knows: other spellings are then tried of that part only, and what
     * follows it ("S02", "05") is left as it is. `asWritten` tries no other
     * spellings at all, for a caller that is already working through names.
     *
     * Release names are written in plain letters, and not every indexer takes
     * "é" for "e". So a query with accents is searched for without them, and as
     * it was written only if that finds nothing.
     */
    async search(written, categories, { filter = true, onTry, title, asWritten = false } = {}) {
      const query = unaccented(written);
      const name = unaccented(title ?? '');
      const others = (asked) => (name && asked.startsWith(name) ? queryVariants(name).map((other) => `${other}${asked.slice(name.length)}`) : queryVariants(asked));
      const spellingsOf = (asked) => (asWritten ? [] : others(asked));
      const found = new Map();
      const wanted = mayBePrograms(categories ?? []) ? () => true : (result) => !PROGRAM.test(String(result.title).trim());
      const also = [];
      let foundAs = null;
      let failure = null;
      const merged = () => {
        const all = [...found.values()].sort((a, b) => b.seeders - a.seeders);
        const seeded = all.filter((result) => result.seeders > 0);
        return seeded.length ? seeded : all;
      };

      /** Tries each spelling of `asked` in turn, stopping at the first that is enough. */
      async function tryAll(asked, first = []) {
        for (const spelling of [asked, ...first, ...spellingsOf(asked)]) {
          if (spelling !== query) also.push(spelling);
          onTry?.(spelling);
          try {
            for (const result of (await ask(spelling, categories)).filter(wanted)) {
              const key = result.infoHash ?? result.title;
              if (!found.has(key)) found.set(key, result);
            }
          } catch (err) {
            failure ??= err;
          }
          const enough = filter ? relevantResults(asked, merged()) : found.size ? merged() : null;
          if (enough) {
            if (spelling !== query) foundAs = spelling;
            return enough;
          }
        }
        return null;
      }

      let results = await tryAll(query, written === query ? [] : [written]);
      const shorter = results ? null : withoutTrailingWords(query);
      if (shorter) results = await tryAll(shorter);
      // Only an error if nothing at all came back.
      if (!results && failure && !found.size) throw failure;
      return results ? { results, also, foundAs, exact: true } : { results: merged(), also, foundAs: null, exact: false };
    },
  };
}
