// Folder and title logic for libraries. Everything here is pure: no network, no database.

const FORBIDDEN_IN_NAMES = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const MAX_FOLDER_NAME = 120;
const MAX_SIMILAR = 8;
// Too common to say anything about whether two titles are the same show.
const FILLER_WORDS = new Set(['with', 'from', 'that', 'this', 'your', 'season', 'series', 'complete', 'part', 'movie', 'show']);
// The first of these in a release name marks where the title ends.
const RELEASE_MARKERS =
  /\b(?:S\d{1,2}(?:E\d{1,3})?|Season \d+|\d{1,2}x\d{2}|(?:19|20)\d{2}|\d{3,4}p|Complete|BluRay|BDRip|WEB|HDTV|DVDRip)\b|\s-\s\d{1,3}\b|[[(]/gi;

/**
 * Makes a title safe to use as a single folder name. Path separators and the
 * characters Windows forbids are removed, so the result can never point outside
 * the folder it is joined to. Returns '' when nothing usable is left.
 */
export function cleanFolderName(name) {
  return String(name ?? '')
    .normalize('NFC')
    .replace(FORBIDDEN_IN_NAMES, ' ')
    .split(/\s+/)
    .filter((part) => part && !/^\.+$/.test(part)) // what is left of "../.."
    .join(' ')
    .replace(/^\.+/, '') // no hidden folders
    .slice(0, MAX_FOLDER_NAME)
    .replace(/[. ]+$/, ''); // Windows silently drops trailing dots and spaces
}

/**
 * The form in which two titles are compared: capitals, accents and punctuation
 * are ignored, as are a trailing year and Plex id tags, so "Tears of Steel
 * (2012) {tvdb-208671}" and "tears of steel" are the same show.
 */
export function titleKey(name) {
  let text = String(name ?? '');
  for (let previous = null; previous !== text; ) {
    previous = text;
    text = text.replace(/\s*(?:\((?:19|20)\d{2}\)|\{[^{}]*\}|\[[^[\]]*\])\s*$/, '');
  }
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A best-effort title from a release name, for when the model did not supply one. */
export function titleFromRelease(release) {
  const text = String(release ?? '')
    .replace(/^\s*(?:\[[^\]]*\]\s*)+/, '') // leading [Group] tags
    .replace(/[._]+/g, ' ');
  // Skip a marker at the very start, so a show called "1808" keeps its name.
  const marker = [...text.matchAll(RELEASE_MARKERS)].find((match) => match.index > 0);
  return cleanFolderName((marker ? text.slice(0, marker.index) : text).replace(/[-\s]+$/, ''));
}

function distinctiveWords(name) {
  return new Set(titleKey(name).split(' ').filter((word) => word.length >= 4 && !FILLER_WORDS.has(word)));
}

/**
 * Decides which existing folder, if any, a title belongs in.
 *   { match }    one existing folder is this title; use its exact spelling
 *   { similar }  no match, but these existing folders might be the same show
 *   {}           nothing like it exists
 */
export function findFolder(title, existing) {
  const exact = existing.find((name) => name.toLowerCase() === title.toLowerCase());
  if (exact) return { match: exact };

  const key = titleKey(title);
  const sameKey = existing.filter((name) => titleKey(name) === key);
  if (sameKey.length === 1) return { match: sameKey[0] };
  // "Wrenfield Cross (1963)" and "Wrenfield Cross (2005)": the caller has to say which.
  if (sameKey.length > 1) return { similar: sameKey.slice(0, MAX_SIMILAR) };

  const words = distinctiveWords(title);
  if (!words.size) return {};
  const similar = [];
  for (const name of existing) {
    const other = distinctiveWords(name);
    if (!other.size) continue;
    const shared = [...words].filter((word) => other.has(word)).length;
    // At least half of the shorter title: catches "Mirelle" inside "Minato no
    // Mirelle" without flagging every show that has "dragon" in its name.
    if (shared / Math.min(words.size, other.size) >= 0.5) similar.push({ name, shared });
  }
  if (!similar.length) return {};
  similar.sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name));
  return { similar: similar.slice(0, MAX_SIMILAR).map((entry) => entry.name) };
}

const usesBackslash = (path) => path.includes('\\') && !path.includes('/');

/** Trims a path and drops trailing separators, keeping roots such as "/" and "D:\". */
export function tidyPath(path) {
  const trimmed = String(path ?? '').trim();
  const stripped = trimmed.replace(/[/\\]+$/, '');
  if (stripped === '' && trimmed !== '') return trimmed[0];
  return /^[a-z]:$/i.test(stripped) ? `${stripped}\\` : stripped;
}

/** True for paths qBittorrent can use as given: "/media/TV", "D:\Media", "\\nas\share". */
export function isAbsolutePath(path) {
  return /^(?:\/|[a-z]:[/\\]|\\\\)/i.test(path);
}

/** Joins a folder and one name, using the folder's own separator style. */
export function joinPath(folder, name) {
  const separator = usesBackslash(folder) ? '\\' : '/';
  return `${folder.replace(/[/\\]+$/, '')}${separator}${name}`;
}

/** Splits "/media/TV" into its parent ("/media") and last part ("TV"). */
export function splitPath(path) {
  const tidy = tidyPath(path);
  const cut = Math.max(tidy.lastIndexOf('/'), tidy.lastIndexOf('\\'));
  if (cut < 0) return { parent: '', name: tidy };
  const parent = tidy.slice(0, cut);
  // "/TV" has parent "/", and "D:\TV" has parent "D:\".
  const root = parent === '' || /^[a-z]:$/i.test(parent);
  return { parent: root ? tidy.slice(0, cut + 1) : parent, name: tidy.slice(cut + 1) };
}

/** The last part of each path, whichever separator it uses. */
export function baseNames(paths) {
  return paths.map((path) => splitPath(path).name).filter(Boolean);
}

/**
 * Whether a library folder really exists, given the names that exist next to
 * it (`siblings`, or null when that could not be listed).
 */
export function checkFolder(path, siblings) {
  if (!siblings) return { status: 'unknown' };
  const { parent, name } = splitPath(path);
  if (!name || siblings.includes(name)) return { status: 'ok' };
  const differsByCase = siblings.find((sibling) => sibling.toLowerCase() === name.toLowerCase());
  return differsByCase ? { status: 'wrong-case', suggestion: joinPath(parent, differsByCase) } : { status: 'missing' };
}
