import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id, id);

  -- Destinations an admin has defined. Nothing is ever saved anywhere else.
  CREATE TABLE IF NOT EXISTS libraries (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    save_path   TEXT NOT NULL,
    per_title   INTEGER NOT NULL DEFAULT 0,
    category    TEXT NOT NULL DEFAULT ''
  );

  -- The downloads PiRick looks after: unfinished ones watched for progress, and
  -- finished ones until they are removed. "meant" is the film or show one was
  -- fetched as, when the catalogue said, and "filed" how far the check that Plex
  -- took it for the same thing has got (see upkeep.js), with what Plex had it as
  -- in "filed_as" while a correction waits to be confirmed.
  CREATE TABLE IF NOT EXISTS tracked_downloads (
    hash        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    username    TEXT NOT NULL DEFAULT '',
    completed   INTEGER NOT NULL DEFAULT 0,
    progress_at INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'watching',
    attempts    INTEGER NOT NULL DEFAULT 0,
    tried       TEXT NOT NULL DEFAULT '[]',
    searched_at INTEGER NOT NULL DEFAULT 0,
    meant       TEXT NOT NULL DEFAULT '',
    filed       TEXT NOT NULL DEFAULT '',
    filed_as    TEXT NOT NULL DEFAULT ''
  );

  -- What upkeep did, for the admin screen and for telling each person on their return.
  CREATE TABLE IF NOT EXISTS upkeep_log (
    id       INTEGER PRIMARY KEY,
    at       INTEGER NOT NULL,
    username TEXT NOT NULL,
    action   TEXT NOT NULL,
    detail   TEXT NOT NULL,
    seen     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- The voices an admin has set up for people to choose from. Ids are never
  -- handed out twice, so a choice of a removed one cannot land on a later one.
  CREATE TABLE IF NOT EXISTS personalities (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    text TEXT NOT NULL
  );

  -- What each person has chosen for themselves. An empty value means the usual one.
  CREATE TABLE IF NOT EXISTS preferences (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme       TEXT NOT NULL DEFAULT '',
    mode        TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT ''
  );

  -- What is new in PiRick (see news.js): the entries this PiRick has had so far,
  -- and who has still to be told of each. A row in news_owed goes once its
  -- person has been told.
  CREATE TABLE IF NOT EXISTS news_arrived (
    entry INTEGER PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS news_owed (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry   INTEGER NOT NULL,
    PRIMARY KEY (user_id, entry)
  );
`;

// Columns that tables made by an earlier PiRick lack: [table, column, what it holds].
const ADDED_COLUMNS = [
  ['tracked_downloads', 'meant', "TEXT NOT NULL DEFAULT ''"],
  ['tracked_downloads', 'filed', "TEXT NOT NULL DEFAULT ''"],
  ['tracked_downloads', 'filed_as', "TEXT NOT NULL DEFAULT ''"],
];

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, column, holds] of ADDED_COLUMNS) {
    const there = db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
    if (!there) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${holds}`);
  }
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
