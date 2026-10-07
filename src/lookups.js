// How PiRick puts what its catalogue knows into words, for the AI model and
// for the status lines people read.
import { countryName, sayDate } from './catalogue.js';

/** More seasons than this and the numbering is taken to be by year or by episode, which no plan can follow. */
const MAX_GUIDE_SEASONS = 60;
const ABOUT_IN_A_LIST = 160;

export const listOf = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : String(items[0]));
const count = (number, word) => `${number} ${word}${number === 1 ? '' : 's'}`;

/** "Charade (1963)". */
export const titled = (thing) => (thing.year ? `${thing.title} (${thing.year})` : thing.title);

// A description that says no more than the year, that it is a film, and who directed it.
const SAYS_NOTHING_NEW = /^(?:\d{4} )?(?:[\p{L}-]+ ){0,3}(?:film|movie|short film|short)(?: (?:directed )?by [^,;]+)?$/iu;

/**
 * A film in one line, with what would tell it from another of the same name:
 * its year, who made it and who is in it. `about` adds what it is said to be,
 * which is only for answers that carry no download id.
 */
export function filmLine(film, { about = false } = {}) {
  const parts = [titled(film)];
  if (film.directors?.length) parts.push(`directed by ${listOf(film.directors)}`);
  if (film.cast?.length) parts.push(`with ${listOf(film.cast.slice(0, 3))}`);
  const line = parts.join(', ');
  return about && film.about && !SAYS_NOTHING_NEW.test(film.about) ? `${line}: ${film.about}` : line;
}

/** When something not yet out is due, as the end of a sentence: "on 18 December 2026", "in 2027", or '' when nobody has said. */
export function whenDue(film) {
  if (film.date) return `on ${sayDate(film.date)}`;
  return film.year ? `in ${film.year}` : '';
}

/** What a film comes after and before, as a sentence, or ''. */
export function neighbours(film) {
  const parts = [film.follows && `follows ${titled(film.follows)}`, film.followedBy && `is followed by ${titled(film.followedBy)}`].filter(Boolean);
  return parts.length ? `It ${parts.join(' and ')}.` : '';
}

/** A description cut down to fit a line of a list, at the end of a sentence where there is one. */
function shortly(about) {
  if (!about || about.length <= ABOUT_IN_A_LIST) return about ?? '';
  const sentence = /^.{20,}?[.!?](?= |$)/.exec(about)?.[0];
  return sentence && sentence.length <= ABOUT_IN_A_LIST ? sentence : `${about.slice(0, ABOUT_IN_A_LIST).replace(/\s+\S*$/, '')}…`;
}

/**
 * A show in one line, with what would tell it from another of the same name:
 * the year it began, where it is from, and how much of it there is.
 * `about` adds what it is about, for answers that carry no download id.
 */
export function showLine(show, { about = false } = {}) {
  const facts = [show.year, ...(show.countries ?? []).slice(0, 1).map(countryName)].filter(Boolean);
  const seasons = show.seasons?.length ?? 0;
  if (seasons) facts.push(count(seasons, 'season'));
  if (show.status === 'running') facts.push('still running');
  else if (show.status === 'upcoming') facts.push('not started yet');
  if (show.anime) facts.push('anime');
  const line = facts.length ? `${show.title} (${facts.join(', ')})` : show.title;
  return about && show.about ? `${line}: ${shortly(show.about)}` : line;
}

/**
 * A show's episode guide as the planner wants it: a map from season number to
 * `{ number, episodes, aired, date }`. Null when there is none to go by: an
 * anime, whose releases are seldom numbered the way a guide numbers them, or a
 * show whose seasons are numbered by year.
 */
export function guideOf(show) {
  const seasons = show?.seasons ?? [];
  if (!seasons.length || show.anime || seasons.some((season) => season.number > MAX_GUIDE_SEASONS)) return null;
  return new Map(seasons.map((season) => [season.number, season]));
}

/** Numbers put briefly, with a run of three or more as a range: "7 and 8", "5 to 10", "1, 3 and 5 to 7". */
export function numbered(numbers) {
  const runs = [];
  for (const number of [...new Set(numbers)].sort((a, b) => a - b)) {
    const run = runs.at(-1);
    if (run && number === run[1] + 1) run[1] = number;
    else runs.push([number, number]);
  }
  return listOf(runs.flatMap(([first, last]) => (last - first >= 2 ? [`${first} to ${last}`] : first === last ? [String(first)] : [String(first), String(last)])));
}

/** What Plex has of a show, measured against its guide: "all of seasons 1 and 2, and 8 of the 10 episodes of season 3". */
export function heldAgainst(held, guide) {
  const whole = [];
  const partly = [];
  for (const [number, episodes] of [...held].sort((a, b) => a[0] - b[0])) {
    const aired = guide.get(number)?.aired ?? 0;
    const has = aired ? [...episodes].filter((episode) => episode <= aired).length : episodes.size;
    if (aired && has >= aired) whole.push(number);
    else partly.push(aired ? `${has} of the ${count(aired, 'episode')} of season ${number}` : `${count(episodes.size, 'episode')} of season ${number}`);
  }
  const parts = [whole.length && `all of season${whole.length === 1 ? '' : 's'} ${numbered(whole)}`, ...partly].filter(Boolean);
  return listOf(parts);
}
