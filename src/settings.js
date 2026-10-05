import { isAbsolutePath, tidyPath } from './folders.js';

export const PERSONALITY_MAX = 1000;
export const UPKEEP_DEFAULTS = { enabled: true, stuckHours: 6 };
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
  return { upkeep: { enabled: input.enabled, stuckHours } };
}

/** Admin-editable settings kept in the database: libraries, personality and upkeep. */
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
  };

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

    removeLibrary: (id) => q.remove.run(id).changes > 0,

    upkeep() {
      const stored = q.get.get('upkeep')?.value;
      return { ...UPKEEP_DEFAULTS, ...(stored ? JSON.parse(stored) : {}) };
    },
    setUpkeep(value) {
      q.set.run('upkeep', JSON.stringify(value));
    },

    personality: () => q.get.get('personality')?.value ?? '',
    setPersonality(text) {
      q.set.run('personality', text);
    },
  };
}
