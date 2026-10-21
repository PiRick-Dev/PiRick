// Whether an episode has aired, going by the catalogue's episode guide. A copy
// of an episode that has not aired cannot be real: what is offered under its
// name before then is a fake, and fakes are how programs get passed off as
// videos. The search, the download tool and upkeep all ask this, so no way of
// asking for an episode gets round it.
import { sayDate } from './catalogue.js';
import { guideOf } from './lookups.js';
import { describeContents, parseRelease } from './releases.js';

/**
 * The episode a release or a request names, when the catalogue says it has not
 * aired yet: `{ show, label, due }`, where `label` is the part ("S03E05",
 * "season 4") and `due` says when it airs, or is empty. Null when it has aired,
 * names no episode or season, or the catalogue cannot say which show it is:
 * several share the name, or it has no guide to go by.
 *
 * `name` is a release name or what was searched for ("Wrenfield Cross S03E05").
 * Throws when the catalogue cannot be reached.
 */
export async function notAiredYet(catalogue, name) {
  if (!catalogue?.enabled) return null;
  const parsed = parseRelease(name);
  if (!parsed.show || (parsed.kind !== 'episode' && parsed.kind !== 'season') || (parsed.season ?? parsed.seasons?.[0]) == null) return null;
  const found = await catalogue.findShow({ title: parsed.show, year: parsed.showYear ?? null });
  // Only a show the catalogue is sure of: the guide of a namesake would say nothing about this one.
  const show = found?.one && !found.inexact && !found.wrongYear ? found.one : null;
  const guide = guideOf(show);
  if (!guide) return null;
  const number = parsed.season ?? parsed.seasons[0];
  const season = guide.get(number);
  // A season the guide does not have may be numbered otherwise: nothing here says it is to come.
  if (!season) return null;
  const label = describeContents(parsed);
  const due = (episode) => (show.next?.date && show.next.season === number && (episode == null || show.next.episode === episode) ? ` It is due on ${sayDate(show.next.date)}.` : '');
  if (parsed.kind === 'season') return season.aired ? null : { show: show.title, label, due: season.date ? ` It begins on ${sayDate(season.date)}.` : due() };
  // Of a file that holds two episodes, the later is the one that may not have aired.
  const last = parsed.episodes?.at(-1) ?? parsed.episode;
  // A season that has aired all it lists has no episode still to come: a higher number is numbered otherwise.
  if (last <= season.aired || season.aired === season.episodes) return null;
  return { show: show.title, label, due: due(last) };
}
