// How the Downloads panel is laid out. A flat list of every torrent, each
// under the name its maker gave it, is hard to read once a show has come as
// twenty of them. So downloads of one show or film are gathered under its name,
// and the gathered rows are put in three sections: what needs a look, what is
// on the way, and what has finished. Everything here is pure: no network, no
// database.
import { pathBelow, titleKey } from './folders.js';
import { formatBytes } from './qbittorrent.js';
import { describeContents, parseRelease } from './releases.js';

// When the downloads of a show differ, the first of these that any of them is in speaks for all.
const BY_URGENCY = ['error', 'stuck', 'downloading', 'checking', 'starting', 'waiting', 'queued', 'paused', 'unknown', 'finished'];
const NEEDS_A_LOOK = new Set(['error', 'stuck']);
const LAST = 9999;

/**
 * What a download is part of, and which part: `{ key, title, label, order }`.
 * `key` is the same for everything shown as one row, `label` says which part
 * of it this is ("S03E01", "season 4"; empty for a film) and `order` puts the
 * parts in the order they are watched.
 */
function partOf(item, libraries) {
  const parsed = parseRelease(item.name);
  const label = (parsed.show && describeContents(parsed)) || '';
  const season = parsed.season ?? parsed.seasons?.[0] ?? (parsed.kind === 'series' ? 0 : LAST);
  // A pack of several seasons comes before a pack of the first of them.
  const order = [season, parsed.episode ?? 0, -(parsed.seasons?.length ?? 0)];

  // A show kept in a folder of its own is known by that folder, whatever each release calls it.
  const library = libraries
    .filter((entry) => entry.perTitle && pathBelow(entry.savePath, item.savePath ?? '')?.length)
    .sort((a, b) => b.savePath.length - a.savePath.length)[0];
  if (library) {
    const [folder] = pathBelow(library.savePath, item.savePath);
    return { key: `folder ${library.id} ${folder.toLowerCase()}`, title: folder, label, order };
  }
  if (label) return { key: `show ${titleKey(parsed.show)}`, title: parsed.show, label, order };
  if (parsed.kind === 'movie') return { key: `film ${titleKey(parsed.show)} ${parsed.year}`, title: `${parsed.show} (${parsed.year})`, label, order };
  // An album, a book, or a name that says too little: it stands as it is.
  return { key: `name ${item.name}`, title: item.name, label, order };
}

/**
 * Lays out downloads for the panel. `items` are downloads as qBittorrent's
 * client gives them, newest first, with `status` and `inPlex` as upkeep has
 * them, and `requestedBy` only where it may be shown. `libraries` are the
 * folders PiRick saves into.
 *
 * Returns `{ summary, groups }`. A group is one row: `{ key, title, detail,
 * section, status, progress, size, etaSeconds, count, finished, troubled,
 * inPlex, requestedBy, items }`, where `section` is 'attention', 'active' or
 * 'finished', and `items` are its downloads as `{ name, label, status,
 * progress, size, etaSeconds, inPlex }`. `summary` counts the rows of each section.
 */
export function groupDownloads(items, libraries = []) {
  const gathered = new Map();
  for (const item of items) {
    const part = partOf(item, libraries);
    if (!gathered.has(part.key)) gathered.set(part.key, { key: part.key, title: part.title, parts: [] });
    gathered.get(part.key).parts.push({ item, label: part.label, order: part.order });
  }

  const groups = [...gathered.values()].map(({ key, title, parts }) => {
    parts.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2] || (a.item.addedAt ?? 0) - (b.item.addedAt ?? 0));
    const all = parts.map((part) => part.item);
    const unfinished = all.filter((item) => item.status !== 'finished');
    const bytes = all.reduce((sum, item) => sum + (item.bytes || 0), 0);
    // By size, so that a season pack counts for more than a single episode beside it.
    const done = bytes ? all.reduce((sum, item) => sum + item.progress * (item.bytes || 0), 0) / bytes : all.reduce((sum, item) => sum + item.progress, 0) / all.length;
    const troubled = all.filter((item) => NEEDS_A_LOOK.has(item.status)).length;
    const requestedBy = [...new Set(all.flatMap((item) => item.requestedBy ?? []))];
    return {
      key,
      title,
      // Which part of the show it is, or how many downloads it is made up of.
      detail: all.length === 1 ? parts[0].label : `${all.length} downloads`,
      section: troubled ? 'attention' : unfinished.length ? 'active' : 'finished',
      status: BY_URGENCY.find((status) => all.some((item) => item.status === status)) ?? 'unknown',
      // Capped so that a show with something still to come never reads as 100%.
      progress: unfinished.length ? Math.min(99.9, Math.round(done * 10) / 10) : 100,
      size: formatBytes(bytes),
      // When the last of them will be there, which is only known if every one of them is on its way.
      etaSeconds: unfinished.length && unfinished.every((item) => item.etaSeconds != null) ? Math.max(...unfinished.map((item) => item.etaSeconds)) : null,
      count: all.length,
      finished: all.length - unfinished.length,
      troubled,
      ...(all.every((item) => item.inPlex) && { inPlex: true }),
      ...(all.some((item) => item.requestedBy) && { requestedBy }),
      // What rows are put in order by: when the newest of it was asked for, or, once it is done, when the last of it finished.
      at: unfinished.length ? Math.max(...all.map((item) => item.addedAt ?? 0)) : Math.max(...all.map((item) => item.finishedAt || item.addedAt || 0)),
      items: parts.map(({ item, label }) => ({
        name: item.name,
        label,
        status: item.status,
        progress: item.progress,
        size: item.size,
        etaSeconds: item.etaSeconds,
        ...(item.inPlex && { inPlex: true }),
      })),
    };
  });

  const sections = ['attention', 'active', 'finished'];
  // Within a section, what is moving comes before what is waiting, and then the newest first.
  groups.sort((a, b) => sections.indexOf(a.section) - sections.indexOf(b.section) || BY_URGENCY.indexOf(a.status) - BY_URGENCY.indexOf(b.status) || b.at - a.at);
  const summary = Object.fromEntries(sections.map((section) => [section, groups.filter((group) => group.section === section).length]));
  return { summary, groups: groups.map(({ at, ...group }) => group) };
}
