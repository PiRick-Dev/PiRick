import { transaction } from './db.js';
import { isAbsolutePath, tidyPath } from './folders.js';
import { DEFAULT_MODE, DEFAULT_THEME, MODES, THEMES } from './themes.js';

export const PERSONALITY_MAX = 1000;
export const PERSONALITIES_MAX = 20;
// What the list of personalities begins with, and what an admin can bring back.
export const STARTER_PERSONALITIES = [
  {
    name: 'Pirate captain',
    text: 'You are a cheerful pirate captain. You call the user "matey", talk of treasure and the high seas, and say "Arr" now and then.',
  },
  {
    name: 'Posh butler',
    text: 'You are an impeccably polite English butler. You are discreet and unflappable, call the user "sir or madam", and take quiet pride in good service.',
  },
  {
    name: 'Grumpy video-store clerk',
    text: 'You are a grumpy but lovable video-store clerk from the 1990s. You grumble, you have strong opinions about films, and you help anyway.',
  },
  {
    name: 'Over-excited film buff',
    text: 'You are an over-excited film buff. Whatever the user asks for is a brilliant choice, and you cannot resist adding one short fun fact about it.',
  },
];
// What an earlier version's one personality for everybody is called in the list.
const EARLIER_PERSONALITY_NAME = 'House voice';
// `enabled` is whether stuck downloads are replaced, and `fixMatches` whether Plex is told
// what a download is when it took it for something else.
export const UPKEEP_DEFAULTS = { enabled: true, stuckHours: 6, fixMatches: true };
const STUCK_HOURS_MAX = 168;
const DESCRIPTION_MAX = 200;
const PATH_MAX = 500;
const CATEGORY_MAX = 60;
// The name is shown to people and offered to the model as a fixed choice, so it stays simple.
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} &'+.-]{0,39}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const oneLine = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** Checks what an admin entered for a library. Returns `{ library }` or `{ error }`. */
export function parseLibrary(input) {
  const name = oneLine(input?.name);
  if (!NAME_PATTERN.test(name)) {
    return { error: 'Give the library a short name made of letters, numbers and spaces, such as "TV" or "Anime".' };
  }
  const description = oneLine(input?.description);
  if (description.length > DESCRIPTION_MAX) {
    return { error: `Keep "what goes here" under ${DESCRIPTION_MAX} characters.` };
  }
  const rawPath = typeof input?.savePath === 'string' ? input.savePath : '';
  // The folder is kept exactly as typed, capitals included; only the ends are tidied.
  const savePath = tidyPath(rawPath);
  if (!savePath) return { error: 'Enter the folder qBittorrent should save into.' };
  if (!isAbsolutePath(savePath) || savePath.length > PATH_MAX || CONTROL_CHARACTERS.test(rawPath)) {
    return { error: 'The folder must be a full path as qBittorrent sees it, such as /media/TV or D:\\Media\\TV.' };
  }
  const category = oneLine(input?.category);
  if (category.length > CATEGORY_MAX || /[\\,]/.test(category)) {
    return { error: 'That is not a valid qBittorrent category name.' };
  }
  return { library: { name, description, savePath, perTitle: input?.perTitle === true, category } };
}

/** Checks what an admin entered for upkeep. Returns `{ upkeep }` or `{ error }`. */
export function parseUpkeep(input) {
  const stuckHours = Number(input?.stuckHours);
  if (typeof input?.enabled !== 'boolean' || !Number.isInteger(stuckHours) || stuckHours < 1 || stuckHours > STUCK_HOURS_MAX) {
    return { error: `Choose a whole number of hours between 1 and ${STUCK_HOURS_MAX}.` };
  }
  // Left out by whoever does not know of it, it stays as PiRick comes: on.
  const fixMatches = input.fixMatches ?? UPKEEP_DEFAULTS.fixMatches;
  if (typeof fixMatches !== 'boolean') return { error: 'Correcting matches in Plex is either on or off.' };
  return { upkeep: { enabled: input.enabled, stuckHours, fixMatches } };
}

/**
 * Checks which Plex folder an admin picked for a library. Returns `{ choice }`
 * (null to have it worked out, `{ none: true }` for a library Plex does not
 * have, or `{ key, path }`), or `{ error }`.
 */
export function parsePlexChoice(input) {
  if (input?.choice === 'auto') return { choice: null };
  if (input?.choice === 'none') return { choice: { none: true } };
  const { key, path } = input?.choice ?? {};
  if (typeof key !== 'string' || !/^\w{1,20}$/.test(key) || typeof path !== 'string' || !path || path.length > PATH_MAX || CONTROL_CHARACTERS.test(path)) {
    return { error: 'Choose one of the Plex folders in the list.' };
  }
  return { choice: { key, path } };
}

/** Checks what an admin entered for a personality. Returns `{ personality }` or `{ error }`. */
export function parsePersonality(input) {
  const name = oneLine(input?.name);
  if (!NAME_PATTERN.test(name)) {
    return { error: 'Give the personality a short name made of letters, numbers and spaces, such as "Pirate captain".' };
  }
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  if (!text) return { error: 'Describe how PiRick should sound.' };
  if (text.length > PERSONALITY_MAX) return { error: `Keep the description under ${PERSONALITY_MAX} characters.` };
  return { personality: { name, text } };
}

/**
 * What is kept in the database besides accounts and chats: what an admin sets
 * up (libraries, personalities, upkeep) and what each person chooses for
 * themselves (theme and personality).
 */
export function createSettings(db) {
  const columns = 'id, name, description, save_path, per_title, category';
  const q = {
    list: db.prepare(`SELECT ${columns} FROM libraries ORDER BY name`),
    byId: db.prepare(`SELECT ${columns} FROM libraries WHERE id = ?`),
    byName: db.prepare(`SELECT ${columns} FROM libraries WHERE name = ?`),
    insert: db.prepare('INSERT INTO libraries (name, description, save_path, per_title, category) VALUES (?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE libraries SET name = ?, description = ?, save_path = ?, per_title = ?, category = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM libraries WHERE id = ?'),
    get: db.prepare('SELECT value FROM settings WHERE key = ?'),
    set: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    personalities: db.prepare('SELECT id, name, text FROM personalities ORDER BY name'),
    personality: db.prepare('SELECT id, name, text FROM personalities WHERE id = ?'),
    personalityByName: db.prepare('SELECT id, name, text FROM personalities WHERE name = ?'),
    addPersonality: db.prepare('INSERT INTO personalities (name, text) VALUES (?, ?)'),
    updatePersonality: db.prepare('UPDATE personalities SET name = ?, text = ? WHERE id = ?'),
    removePersonality: db.prepare('DELETE FROM personalities WHERE id = ?'),
    forgetPersonality: db.prepare("UPDATE preferences SET personality = '' WHERE personality = ?"),
    preferences: db.prepare('SELECT theme, mode, personality FROM preferences WHERE user_id = ?'),
    savePreferences: db.prepare(`
      INSERT INTO preferences (user_id, theme, mode, personality) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, mode = excluded.mode, personality = excluded.personality`),
  };

  // Once only: the list begins with the starters. An earlier version kept a
  // single personality for everybody; that becomes an entry too, and the usual
  // one, so nobody hears a change. Its old setting is left where it was.
  if (!q.get.get('personalities-started')) {
    transaction(db, () => {
      for (const { name, text } of STARTER_PERSONALITIES) if (!q.personalityByName.get(name)) q.addPersonality.run(name, text);
      const earlier = (q.get.get('personality')?.value ?? '').trim();
      if (earlier) {
        const same = q.personalities.all().find((row) => row.text === earlier);
        const id = same?.id ?? q.addPersonality.run(EARLIER_PERSONALITY_NAME, earlier).lastInsertRowid;
        q.set.run('usual-personality', String(id));
      }
      q.set.run('personalities-started', '1');
    });
  }
  const copy = (row) => (row ? { ...row } : null);
  /** The entry an admin has made the usual one, or null. */
  const usualPersonality = () => copy(q.personality.get(Number(q.get.get('usual-personality')?.value) || 0));

  /** One person's choices, with anything unset or no longer on offer read as the usual. */
  function preferences(userId) {
    const row = q.preferences.get(userId);
    const known = (list, value, fallback) => (list.some((entry) => entry.id === value) ? value : fallback);
    const chosen = row?.personality ?? '';
    return {
      theme: known(THEMES, row?.theme, DEFAULT_THEME),
      mode: known(MODES, row?.mode, DEFAULT_MODE),
      // '' is the usual personality, 'none' is plain PiRick, anything else is an entry's id.
      personality: chosen === 'none' || q.personality.get(Number(chosen) || 0) ? chosen : '',
    };
  }

  const toLibrary = (row) =>
    row && {
      id: row.id,
      name: row.name,
      description: row.description,
      savePath: row.save_path,
      perTitle: Boolean(row.per_title),
      category: row.category,
    };
  const values = (library) => [library.name, library.description, library.savePath, library.perTitle ? 1 : 0, library.category];
  const plexChoices = () => JSON.parse(q.get.get('plex-libraries')?.value ?? '{}');
  function setPlexChoice(libraryId, choice) {
    const choices = plexChoices();
    if (choice) choices[libraryId] = choice;
    else delete choices[libraryId];
    q.set.run('plex-libraries', JSON.stringify(choices));
  }

  return {
    libraries: () => q.list.all().map(toLibrary),
    library: (id) => toLibrary(q.byId.get(id)) ?? null,
    /** Looks a library up by name, whatever the capitals. */
    findLibrary: (name) => toLibrary(q.byName.get(String(name ?? '').trim())) ?? null,

    /** Returns the new library, or null when the name is already used. */
    addLibrary(library) {
      if (q.byName.get(library.name)) return null;
      const { lastInsertRowid } = q.insert.run(...values(library));
      return toLibrary(q.byId.get(Number(lastInsertRowid)));
    },

    /** Returns the updated library, or null when another library has that name. */
    updateLibrary(id, library) {
      const clash = q.byName.get(library.name);
      if (clash && clash.id !== id) return null;
      q.update.run(...values(library), id);
      return toLibrary(q.byId.get(id));
    },

    removeLibrary(id) {
      // Ids are handed out again, so a choice left behind would attach itself to a later library.
      setPlexChoice(id, null);
      return q.remove.run(id).changes > 0;
    },

    /** The Plex folder an admin picked for a library (see parsePlexChoice), or null when it is worked out. */
    plexChoice: (libraryId) => plexChoices()[libraryId] ?? null,
    setPlexChoice,

    upkeep() {
      const stored = q.get.get('upkeep')?.value;
      return { ...UPKEEP_DEFAULTS, ...(stored ? JSON.parse(stored) : {}) };
    },
    setUpkeep(value) {
      q.set.run('upkeep', JSON.stringify(value));
    },

    /** The personalities people can choose from, by name: `{ id, name, text }`. */
    personalities: () => q.personalities.all().map(copy),
    personality: (id) => copy(q.personality.get(id)),

    /** Returns the new entry, or null when the name is already used. */
    addPersonality({ name, text }) {
      if (q.personalityByName.get(name)) return null;
      return copy(q.personality.get(Number(q.addPersonality.run(name, text).lastInsertRowid)));
    },

    /** Returns the changed entry, or null when another entry has that name. */
    updatePersonality(id, { name, text }) {
      const clash = q.personalityByName.get(name);
      if (clash && clash.id !== id) return null;
      q.updatePersonality.run(name, text, id);
      return copy(q.personality.get(id));
    },

    /** Removes an entry. Whoever had chosen it is back on the usual one. */
    removePersonality(id) {
      q.forgetPersonality.run(String(id));
      return q.removePersonality.run(id).changes > 0;
    },

    usualPersonality,
    /** Makes an entry the one people hear unless they choose otherwise; null for none. */
    setUsualPersonality(id) {
      q.set.run('usual-personality', id == null ? '' : String(id));
    },

    preferences,

    /**
     * Checks choices a person sent: any of `theme`, `mode` and `personality`.
     * Returns `{ changes }` holding the ones that were given, or `{ error }`.
     */
    checkPreferences(input) {
      const changes = {};
      const offered = (list, value) => typeof value === 'string' && list.some((entry) => entry.id === value);
      if (input?.theme !== undefined) {
        if (!offered(THEMES, input.theme)) return { error: 'Choose one of the themes in the list.' };
        changes.theme = input.theme;
      }
      if (input?.mode !== undefined) {
        if (!offered(MODES, input.mode)) return { error: 'Choose light, dark, or to match the device.' };
        changes.mode = input.mode;
      }
      if (input?.personality !== undefined) {
        const { personality } = input;
        const listed = typeof personality === 'string' && /^\d{1,15}$/.test(personality) && q.personality.get(Number(personality));
        if (personality !== '' && personality !== 'none' && !listed) return { error: 'Choose one of the personalities in the list.' };
        changes.personality = personality;
      }
      return { changes };
    },

    setPreferences(userId, changes) {
      const { theme, mode, personality } = { ...preferences(userId), ...changes };
      q.savePreferences.run(userId, theme, mode, personality);
    },

    /** How PiRick should sound to this person: a personality's description, or '' for plain PiRick. */
    personalityFor(userId) {
      const { personality } = preferences(userId);
      if (personality === 'none') return '';
      return (personality ? q.personality.get(Number(personality)) : usualPersonality())?.text ?? '';
    },
  };
}
