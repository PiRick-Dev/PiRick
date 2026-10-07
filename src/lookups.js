// How PiRick puts what its catalogue knows into words, for the AI model and
// for the status lines people read.
import { sayDate } from './catalogue.js';

export const listOf = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : String(items[0]));

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
