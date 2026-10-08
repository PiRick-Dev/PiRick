// How PiRick puts what its catalogue knows into words, for the AI model and
// for the status lines people read.
import { countryName, sayDate, standing } from './catalogue.js';

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

// ---- The tools that only look things up ------------------------------------------
//
// Three tools answer questions from the catalogue: about one film or show, about
// a person, and for ideas of what to watch. None of them searches for copies,
// and none returns a download id. That is why descriptions, which anyone may
// have written, are passed on here and nowhere else. A model that took one for
// an instruction could still go on to search and download, so each of these
// sets `turn.looked`, and download starts nothing in a message where it is set.

const MAX_SEASONS_LISTED = 12;
const MAX_PLEX_MARKS = 15;
// A second person looked up within this long of a first is taken to belong to the same question,
// and is compared with the last few.
const PEOPLE_REMEMBERED_MS = 30 * 60 * 1000;
const MAX_PEOPLE_REMEMBERED = 4;
const MAX_COMPARED = 2;
const MAX_NAMED_IN_STATUS = 3;

const LOOK_UP_DEFINITION = {
  type: 'function',
  function: {
    name: 'look_up',
    description:
      'Look up what is known about one film or TV show, to answer a question about it: what it is about, when it came out or is due, who made it and who is in it, what it follows, how many seasons and episodes it has and which have aired, and whether the user already has it. It only looks things up: it never searches for copies and never downloads anything.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The name of the film or show, with its year if you know it. Example: "Nosferatu 1922".' },
        kind: { type: 'string', enum: ['film', 'show'], description: 'Which of the two it is, when you know.' },
      },
      required: ['title'],
    },
  },
};

const PERSON_DEFINITION = {
  type: 'function',
  function: {
    name: 'look_up_person',
    description: 'Look up an actor, a director or another film-maker by name: the films and shows they are best known for. Use it for questions such as "what has she been in?" or "what else did he direct?".',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'The name of the person.' } }, required: ['name'] },
  },
};

const suggestDefinition = (genres) => ({
  type: 'function',
  function: {
    name: 'suggest',
    description:
      'Suggest films or shows to watch. Give like for ones in the vein of a film or show the user names, or genre for well-known ones of a genre, or neither for what people are reading about most right now.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['film', 'show'], description: 'Whether films or shows are wanted.' },
        like: { type: 'string', description: 'The name of a film or show to find others like, with its year if you know it.' },
        genre: { type: 'string', enum: genres, description: 'A genre.' },
      },
      required: ['kind'],
    },
  },
});

/** An object without the keys that have nothing to say. */
const said = (facts) => Object.fromEntries(Object.entries(facts).filter(([, value]) => value != null && value !== '' && !(Array.isArray(value) && !value.length)));
const text = (value, most = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, most);
/** "Nosferatu 1922" and "Nosferatu (1922)" as a name and a year. */
function nameAndYear(asked) {
  const match = /^(.+?)[\s(]+((?:19|20)\d{2})\)?$/.exec(asked);
  return match ? { title: match[1].trim(), year: Number(match[2]) } : { title: asked, year: null };
}
/** A line of a list: what it is, what it is said to be when that adds anything, and whether Plex has it. */
const listLine = (entry, held) => `${titled(entry)}${entry.about && !SAYS_NOTHING_NEW.test(entry.about) ? `: ${shortly(entry.about)}` : ''}${held ? ' (already in Plex)' : ''}`;

/**
 * `catalogue` and `plex` are the clients; `askCatalogue` and `askPlex` call them
 * and give undefined when they cannot be asked; `tell(user, turn, key)` notes
 * that the person has been told Plex has something.
 */
export function createLookups({ catalogue, plex, askCatalogue, askPlex, tell, genres, now = Date.now }) {
  const UNREACHABLE = { error: 'The catalogue cannot be reached right now. Tell the user you cannot look that up at the moment.' };
  const ONLY_LOOKED = 'This only looked it up: nothing was searched for and nothing is downloading.';

  // The people each user looked up a little while ago, latest first.
  const lookedUp = new Map();
  /** Whom this user looked up lately, other than `person`, who is remembered for the next time. */
  function recentlyLookedUp(user, person) {
    const at = now();
    const others = (lookedUp.get(user.id) ?? []).filter((entry) => at - entry.at < PEOPLE_REMEMBERED_MS && entry.id !== person.id);
    lookedUp.set(user.id, [{ id: person.id, name: person.name, at }, ...others].slice(0, MAX_PEOPLE_REMEMBERED));
    return others;
  }

  /** Which of some films and shows Plex has, as a set of their places in the list. Empty when Plex cannot say. */
  async function inPlex(entries) {
    const held = new Set();
    await askPlex(async () => {
      for (const [i, entry] of entries.slice(0, MAX_PLEX_MARKS).entries()) {
        const has = entry.kind === 'show' ? await plex.show(entry.title, entry.year) : (await plex.films(entry.title, entry.year))[0];
        if (has) held.add(i);
      }
    });
    return held;
  }

  /** Works out which film or show is meant. Resolves to `{ thing, note }`, or `{ reply }` to hand straight back. */
  async function identify(asked, kind, turn) {
    const about = nameAndYear(asked);
    const found = await askCatalogue(() => (kind === 'film' ? catalogue.findFilm(about) : kind === 'show' ? catalogue.findShow(about) : catalogue.findAny(about)));
    if (!found) return { reply: UNREACHABLE };
    const sort = kind ?? 'film or show';
    const named = `“${about.title}”`;
    if (found.none) {
      turn.status(`Looked up ${named}: the catalogue knows no ${sort} of that name`, 'search');
      return { reply: { found: false, catalogue: `The catalogue knows no ${sort} called ${named}.`, note: 'Tell the user that, and ask them to check the name.' } };
    }
    if (found.several) {
      turn.status(`Looked up ${named}: ${found.several.length} share that name`, 'search');
      const line = (thing) => (thing.kind === 'show' ? `the show ${showLine(thing, { about: true })}` : `the film ${filmLine(thing, { about: true })}`);
      return {
        reply: {
          found: false,
          catalogue: `More than one ${sort} is called ${named}.`,
          which_one: found.several.map(line),
          note: 'Nothing more was looked up. If what the user said settles which of these they mean, call the same tool again with that title and its year. Otherwise ask the user which one.',
        },
      };
    }
    const thing = found.one;
    let note = '';
    if (found.wrongYear) note = `No ${sort} called ${named} is from ${about.year}; this is the one of that name.`;
    else if (found.inexact) note = `Nothing is called ${named}; this is the nearest.`;
    return { thing, note };
  }

  async function aboutFilm(user, turn, film, note) {
    const [about, series, held] = await Promise.all([
      askCatalogue(() => catalogue.about(film)),
      askCatalogue(() => catalogue.seriesOf(film)),
      askPlex(async () => {
        for (const name of [film.title, film.originalTitle].filter(Boolean)) {
          const [has] = await plex.films(name, film.year);
          if (has) return has;
        }
        return null;
      }),
    ]);
    // Told here that they have it, the person may next ask for another copy.
    if (held) tell(user, turn, `film ${held.id}`);
    const state = standing(film);
    let released = '';
    if (state === 'out') released = film.date ? `It came out on ${sayDate(film.date)}.` : film.year ? `It came out in ${film.year}.` : '';
    else if (state === 'due') released = `It is not out yet.${whenDue(film) ? ` It is due ${whenDue(film)}.` : ' No date has been given for it.'}`;
    else if (film.year) released = `It is dated ${film.year}. Whether it is out yet is not known.`;
    return said({
      film: titled(film),
      catalogue: note,
      about: about ?? film.about,
      released,
      directed_by: film.directors,
      with: film.cast,
      from: film.countries,
      genres: film.genres,
      original_title: film.originalTitle,
      // The films of its series in the order they came out, or failing that what it is known to follow.
      series: series?.films.map(titled),
      order: series ? '' : neighbours(film),
      plex: held === undefined ? '' : held ? `Plex already has ${titled(held)}.` : 'Plex does not have it.',
      note: `${ONLY_LOOKED} If the user wants it fetched, call search_media with this title and year.`,
    });
  }

  async function aboutShow(user, turn, show, note) {
    const guide = new Map(show.seasons.map((season) => [season.number, season]));
    const held = await askPlex(async () => {
      for (const name of show.names.slice(0, 4)) {
        const under = await plex.show(name, show.year);
        if (under) return under;
      }
      return null;
    });
    if (held?.seasons.size) tell(user, turn, `show ${held.title} looked up`);
    const seasonLine = (season) => `season ${season.number}: ${count(season.episodes, 'episode')}${season.aired < season.episodes ? `, ${season.aired} aired so far` : ''}`;
    const episodes = show.seasons.reduce((sum, season) => sum + season.episodes, 0);
    // A long-running show's seasons are summed up, with the latest spelled out.
    const seasons = show.seasons.length > MAX_SEASONS_LISTED ? [`${count(show.seasons.length, 'season')} and ${count(episodes, 'episode')} in all`, `the latest, ${seasonLine(show.seasons.at(-1))}`] : show.seasons.map(seasonLine);
    const states = { ended: 'It has ended.', cancelled: 'It was cancelled.', running: 'It is still running.', upcoming: 'It has not started yet.', unsure: 'It is between seasons, with no word on whether there will be more.' };
    return said({
      show: titled(show),
      catalogue: note,
      about: show.about,
      from: show.countries.map(countryName),
      status: states[show.status],
      seasons,
      next_episode: show.next ? `season ${show.next.season} episode ${show.next.episode}${show.next.date ? `, due on ${sayDate(show.next.date)}` : ''}` : '',
      created_by: show.creators,
      with: show.cast,
      genres: show.genres,
      anime: show.anime ? 'It is anime.' : '',
      // Its names in other alphabets say nothing to someone reading this one.
      other_names: show.names.filter((name) => name !== show.title && /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]+$/u.test(name)).slice(0, 3),
      plex: held === undefined ? '' : held?.seasons.size ? `Plex already has ${heldAgainst(held.seasons, show.anime ? new Map() : guide)}.` : 'Plex has none of it.',
      note: `${ONLY_LOOKED} If the user wants it fetched, call find_show with this title.`,
    });
  }

  const handlers = {
    async look_up(user, args, turn) {
      const asked = text(args.title);
      if (!asked) return { error: 'A title is required.' };
      turn.looked = true;
      turn.emit({ type: 'working', text: `Looking up “${asked}”…` });
      const { thing, note, reply } = await identify(asked, ['film', 'show'].includes(args.kind) ? args.kind : null, turn);
      if (reply) return reply;
      turn.status(`Looked up ${titled(thing)}`, 'search');
      return thing.kind === 'show' ? aboutShow(user, turn, thing, note) : aboutFilm(user, turn, thing, note);
    },

    async look_up_person(user, args, turn) {
      const name = text(args.name, 80);
      if (!name) return { error: 'A name is required.' };
      turn.looked = true;
      turn.emit({ type: 'working', text: `Looking up ${name}…` });
      const person = await askCatalogue(() => catalogue.person(name));
      if (person === undefined) return UNREACHABLE;
      if (!person || (!person.films.length && !person.shows.length)) {
        turn.status(`Looked up ${name}: the catalogue knows no film-maker of that name`, 'search');
        return { found: false, catalogue: `The catalogue knows no actor or film-maker called “${name}”.`, note: 'Tell the user that, and ask them to check the name.' };
      }
      turn.status(person.inexact ? `Looked up ${name}: taken to be ${person.name}` : `Looked up ${person.name}`, 'search');
      const parts = [...person.films.map((part) => ({ ...part, kind: 'film' })), ...person.shows.map((part) => ({ ...part, kind: 'show' }))];
      const held = await inPlex(parts);
      const line = (part) => `${titled(part)}, as ${listOf(part.as)}${held.has(parts.indexOf(part)) ? ' (already in Plex)' : ''}`;

      // Asked about two people, a model looks each of them up. What they were both in is seldom among the
      // best known of either, so PiRick asks the catalogue for that itself.
      const inCommon = [];
      for (const other of recentlyLookedUp(user, person).slice(0, MAX_COMPARED)) {
        const both = await askCatalogue(() => catalogue.together(person, other));
        if (!both) continue;
        const theirs = await inPlex(both);
        const named = both.map((part, i) => `the ${part.kind} ${titled(part)}${theirs.has(i) ? ' (already in Plex)' : ''}`);
        // The chat line names a few; the model is given them all.
        const few = both.slice(0, MAX_NAMED_IN_STATUS).map(titled);
        turn.status(`Compared with ${other.name}: ${both.length ? `both in ${listOf(both.length > few.length ? [...few, `${both.length - few.length} more`] : few)}` : 'nothing listed with both'}`, 'search');
        inCommon.push(`With ${other.name}, looked up earlier: ${both.length ? listOf(named) : 'nothing the catalogue lists'}.`);
      }
      const together = inCommon.length ? ' What this person and one looked up earlier were both in is under in_common, and is all the catalogue lists: go by that, not by comparing the two lists.' : '';
      return said({
        person: person.name,
        ...(person.inexact && { catalogue: `No actor or film-maker is called “${name}”. The nearest is ${person.name}, and that is who was looked up.` }),
        known_as: person.knownFor,
        in_common: inCommon,
        films: parts.filter((part) => part.kind === 'film').map(line),
        shows: parts.filter((part) => part.kind === 'show').map(line),
        note: `These are the best known of their work, not all of it.${together} ${ONLY_LOOKED} If the user wants one fetched, call search_media for a film or find_show for a show, with its title and year.`,
      });
    },

    async suggest(user, args, turn) {
      const kind = args.kind === 'show' ? 'show' : 'film';
      const like = text(args.like);
      const genre = text(args.genre, 40).toLowerCase();
      turn.looked = true;
      turn.emit({ type: 'working', text: 'Looking for something to suggest…' });
      let found;
      let basis;
      if (like) {
        const { thing, reply } = await identify(like, kind, turn);
        if (reply) return reply;
        found = await askCatalogue(() => catalogue.like(thing));
        if (found === undefined) return UNREACHABLE;
        basis = `These are in the vein of ${titled(thing)}: the rest of its series if it has one, more by whoever made it, and well-known ${kind}s of the same kind.`;
        turn.status(`Suggested ${kind}s like ${titled(thing)}`, 'search');
        // The film itself is not a suggestion.
        found = (found ?? []).filter((entry) => !(entry.title === thing.title && entry.year === thing.year));
      } else if (genre) {
        if (!genres.includes(genre)) return { error: `There is no such genre. Use one of: ${genres.join(', ')}.` };
        found = await askCatalogue(() => catalogue.ofGenre(kind, genre));
        if (found === undefined) return UNREACHABLE;
        turn.status(`Suggested ${genre} ${kind}s`, 'search');
        if (found === null) return { suggestions: [], note: `The catalogue keeps no list of ${genre} ${kind}s. Tell the user that, and offer ${kind === 'show' ? 'films of that genre' : 'another genre'} or what is popular instead.` };
        basis = `These are well-known ${genre} ${kind}s.`;
      } else {
        found = await askCatalogue(() => catalogue.popular(kind));
        if (found === undefined) return UNREACHABLE;
        turn.status(`Suggested the ${kind}s read about most just now`, 'search');
        basis = `These are the ${kind}s people are reading about most on Wikipedia just now. Some may not be out yet.`;
      }
      if (!found.length) return { suggestions: [], note: 'The catalogue has nothing to suggest for that. Tell the user so.' };
      const held = await inPlex(found);
      return {
        suggestions: found.map((entry, i) => listLine(entry, held.has(i))),
        basis,
        note: `Offer these to the user as a numbered list, with the years. Do not add any of your own. ${ONLY_LOOKED} If the user picks one, call ${kind === 'show' ? 'find_show' : 'search_media'} with its title and year.`,
      };
    },
  };

  return { definitions: [LOOK_UP_DEFINITION, PERSON_DEFINITION, suggestDefinition(genres)], handlers };
}
