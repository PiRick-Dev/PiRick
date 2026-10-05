import { createHash } from 'node:crypto';

const MAX_DEPTH = 100;
const [INTEGER, LIST, DICTIONARY, END, COLON] = [0x69, 0x6c, 0x64, 0x65, 0x3a];

/** The index just past the bencoded value that starts at `at`. Throws if the data is malformed. */
function skip(bytes, at, depth = 0) {
  if (depth > MAX_DEPTH || at >= bytes.length) throw new Error('malformed torrent');
  const first = bytes[at];
  if (first === INTEGER) {
    const end = bytes.indexOf(END, at);
    if (end < 0) throw new Error('malformed torrent');
    return end + 1;
  }
  if (first === LIST || first === DICTIONARY) {
    // A dictionary is laid out as a list of alternating keys and values.
    let next = at + 1;
    while (bytes[next] !== END) next = skip(bytes, next, depth + 1);
    return next + 1;
  }
  // A string: <length>:<bytes>
  const colon = bytes.indexOf(COLON, at);
  const length = colon > at && colon - at <= 12 ? Number(bytes.toString('latin1', at, colon)) : NaN;
  if (!Number.isInteger(length) || length < 0 || colon + 1 + length > bytes.length) throw new Error('malformed torrent');
  return colon + 1 + length;
}

/**
 * The info hash of a .torrent file (SHA-1 of its "info" dictionary), which is
 * how qBittorrent identifies a torrent. Returns null if the file cannot be read.
 */
export function infoHashOf(file) {
  try {
    const bytes = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
    if (bytes[0] !== DICTIONARY) return null;
    let at = 1;
    while (bytes[at] !== END) {
      const keyEnd = skip(bytes, at);
      const key = bytes.toString('latin1', bytes.indexOf(COLON, at) + 1, keyEnd);
      const valueEnd = skip(bytes, keyEnd);
      if (key === 'info') return createHash('sha1').update(bytes.subarray(keyEnd, valueEnd)).digest('hex');
      at = valueEnd;
    }
  } catch {
    // Not a torrent we can read: the caller carries on without a hash.
  }
  return null;
}
