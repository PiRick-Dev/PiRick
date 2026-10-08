// What has changed in PiRick that the people using it would notice. Each person
// is told once, the next time they open the chat, as part of the welcome-back
// message (see agent.js).
//
// To announce a change, add an entry at the end with the next number:
//   id     its number. Never change one or use one twice: PiRick goes by it to
//          know who has been told what
//   text   what to tell people, or a function that gives it from what this
//          PiRick has (see createNews). Say what is new and how to use it,
//          plainly, in a sentence or two. The model that retells it knows
//          nothing else about it and cannot answer questions about it later
//   when   optionally, a function of what this PiRick has that says whether
//          the entry applies here at all. Until it does, nobody is told
//   admin  optionally true, when only an admin can make use of it
//
// Leave out what nobody would notice, and what only whoever runs PiRick needs
// to know: that belongs in the README.
import { transaction } from './db.js';

/** How many are told in one message. The rest wait for the next one. */
export const MAX_NEWS = 3;

export const NEWS = [
  {
    id: 1,
    text: (has) =>
      has.personalities
        ? 'PiRick has themes and personalities to choose from. Open Account to pick a theme, light or dark, and a personality.'
        : 'PiRick has themes to choose from. Open Account to pick a theme, and light or dark.',
  },
  {
    id: 2,
    when: (has) => has.catalogue,
    text: 'PiRick can answer questions about films, shows and the people in them. Ask what something is about, who is in it, whether it is out yet, what an actor has been in, or for ideas of what to watch.',
  },
];

/**
 * Keeps track of who has still to be told what. An entry is owed to everyone
 * who has an account when this PiRick first starts with it. Whoever joins
 * later finds PiRick as it is, and is told nothing.
 *
 * `has()` says what this PiRick has at the moment: `{ catalogue, personalities }`.
 */
export function createNews({ db, has, entries = NEWS }) {
  const q = {
    arrived: db.prepare('SELECT 1 FROM news_arrived WHERE entry = ?'),
    arrive: db.prepare('INSERT INTO news_arrived (entry) VALUES (?)'),
    owe: db.prepare("INSERT OR IGNORE INTO news_owed (user_id, entry) SELECT id, ? FROM users WHERE role = 'admin' OR ? = 0"),
    owed: db.prepare('SELECT entry FROM news_owed WHERE user_id = ? ORDER BY entry'),
    told: db.prepare('DELETE FROM news_owed WHERE user_id = ? AND entry = ?'),
  };
  const applies = (entry, having) => !entry.when || Boolean(entry.when(having));

  // Once for each entry. One that does not apply yet is looked at again at the
  // next start, which is when what it waits for can have changed.
  const having = has();
  transaction(db, () => {
    for (const entry of entries) {
      if (q.arrived.get(entry.id) || !applies(entry, having)) continue;
      q.owe.run(entry.id, entry.admin ? 1 : 0);
      q.arrive.run(entry.id);
    }
  });

  return {
    /** What this person has still to be told, oldest first and no more than MAX_NEWS: `[{ id, text }]`. */
    unheard(user) {
      const now = has();
      const listed = new Map(entries.map((entry) => [entry.id, entry]));
      return q.owed
        .all(user.id)
        .map((row) => listed.get(row.entry))
        // One that has since been switched off stays owed, for when it is back.
        .filter((entry) => entry && applies(entry, now))
        .slice(0, MAX_NEWS)
        .map((entry) => ({ id: entry.id, text: typeof entry.text === 'function' ? entry.text(now) : entry.text }));
    },

    heard(user, ids) {
      for (const id of ids) q.told.run(user.id, id);
    },
  };
}
