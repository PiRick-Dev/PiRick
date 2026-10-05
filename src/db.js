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

  -- Unfinished downloads PiRick is watching for progress.
  CREATE TABLE IF NOT EXISTS tracked_downloads (
    hash        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    username    TEXT NOT NULL DEFAULT '',
    completed   INTEGER NOT NULL DEFAULT 0,
    progress_at INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'watching',
    attempts    INTEGER NOT NULL DEFAULT 0,
    tried       TEXT NOT NULL DEFAULT '[]',
    searched_at INTEGER NOT NULL DEFAULT 0
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
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
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
