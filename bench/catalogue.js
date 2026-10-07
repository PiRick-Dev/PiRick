// A stand-in for the services behind PiRick's catalogue: Wikidata (films and
// people), TVmaze (shows) and Wikipedia (a few lines about a film, and what is
// read most). It answers the requests PiRick makes the way the real ones do,
// and is used by the benchmark and the tests through the real catalogue client,
// so what is measured includes how PiRick reads them.
//
// It is handed the films and shows that exist in its world:
//   film  { title, aliases, original, otherNames, year | date, known, said, directors,
//           cast, series, follows, genres, country, language, kind, about, page }
//   show  { id, name, akas, year, weight, country, seasons, last, next, status,
//           type, language, summary, cast, creators, genres }
// A film's `known` is how many Wikipedias write about it, a show's `weight` is
// TVmaze's measure out of 100. `otherNames` are a film's names in other
// languages. `seasons` maps a season number to how many episodes it has; `last`
// is `{ season, episode }`, the latest to have aired, and everything listed
// has aired when it is left out. `mostRead` lists titles in the order
// Wikipedia's readers looked them up.
//
// Searching is no more forgiving than the real thing. Wikidata wants every
// word to be a word of a name or of the description, and forgives a letter or
// two only where a word is marked with "~". TVmaze forgives small slips itself.

export const SERVICES = {
  wikidata: 'https://wikidata.invalid/w/api.php',
  tvmaze: 'https://tvmaze.invalid',
  wikipedia: 'https://wikipedia.invalid/api/rest_v1',
  pageviews: 'https://pageviews.invalid/api/rest_v1',
};

// Wikidata's ids for kinds of thing, genres, countries and trades.
const FILM = 'Q11424';
const FILM_KINDS = { short: 'Q24862', animated: 'Q202866', 'animated short': 'Q17517379', anime: 'Q20650540', project: 'Q18011172', documentary: 'Q93204', silent: 'Q226730' };
const SERIES = 'Q5398426';
const ANIMATED_SERIES = 'Q117467246';
const ANIME_SERIES = 'Q63952888';
const HUMAN = 'Q5';
const ACTOR = 'Q33999';
const DIRECTOR = 'Q2526255';
const FILM_GENRES = { action: 'Q188473', adventure: 'Q319221', comedy: 'Q157443', crime: 'Q959790', drama: 'Q130232', family: 'Q1361932', fantasy: 'Q157394', history: 'Q17013749', horror: 'Q200092', musical: 'Q842256', mystery: 'Q1200678', romance: 'Q1054574', 'science fiction': 'Q471839', thriller: 'Q2484376', war: 'Q369747', western: 'Q172980', animation: 'Q202866' };
const SHOW_GENRES = { action: 'Q343782', adventure: 'Q56064758', comedy: 'Q9335576', crime: 'Q9335577', drama: 'Q1366112', fantasy: 'Q98526245', horror: 'Q20220309', romance: 'Q84270297', 'science fiction': 'Q140472311', thriller: 'Q67175872', western: 'Q7988576' };
const COUNTRIES = { 'United States': 'Q30', 'United Kingdom': 'Q145', Germany: 'Q183', Japan: 'Q17', 'Soviet Union': 'Q15180', Netherlands: 'Q55', France: 'Q142' };
const LANGUAGES = { Japanese: 'Q5287', English: 'Q1860', German: 'Q188' };
const DAY_MS = 86_400_000;

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const words = (text) =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
// As a search index does, plurals are filed with their singular.
const stem = (word) => (word.length > 3 ? word.replace(/s$/, '') : word);

function lettersApart(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (unused, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}
/** Two words that differ by a letter, or by two when they are long. */
const nearly = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && lettersApart(a, b) <= (Math.min(a.length, b.length) >= 6 ? 2 : 1));

export function catalogueStandIn({ films = [], shows = [], mostRead = [] } = {}, { now = Date.now } = {}) {
  const state = { requests: [], down: new Set() };
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const dayFrom = (offset) => new Date(now() + offset * DAY_MS).toISOString().slice(0, 10);

  // ---- Wikidata: every film, show, person and series of films is an entity ------

  const entities = new Map();
  const put = (id, entity) => entities.set(id, { id, type: 'item', ...entity });
  const label = (value) => ({ en: { language: 'en', value } });
  const pointTo = (id) => ({ mainsnak: { snaktype: 'value', datavalue: { value: { id }, type: 'wikibase-entityid' } }, rank: 'normal' });
  const dated = (item) => {
    const time = item.date ? `+${item.date}T00:00:00Z` : item.year ? `+${item.year}-00-00T00:00:00Z` : null;
    return time ? [{ mainsnak: { snaktype: 'value', datavalue: { value: { time, precision: item.date ? 11 : 9 }, type: 'time' } }, rank: 'normal' }] : [];
  };
  // Sitelinks stand for fame: one per Wikipedia that writes about the thing.
  const links = (known, page) => Object.fromEntries([...(page ? [['enwiki', { site: 'enwiki', title: page }]] : []), ...Array.from({ length: Math.max(0, known - (page ? 1 : 0)) }, (unused, i) => [`wiki${i}`, { site: `wiki${i}`, title: 'x' }])]);
  const claims = (pairs) => Object.fromEntries(Object.entries(pairs).filter(([, values]) => values.length));

  const everyone = [...new Set([...films, ...shows].flatMap((item) => [...(item.cast ?? []), ...(item.directors ?? []), ...(item.creators ?? [])]))];
  const personId = (name) => `Q${3000 + everyone.indexOf(name)}`;
  const seriesNames = [...new Set(films.map((film) => film.series).filter(Boolean))];
  const seriesId = (name) => `Q${4000 + seriesNames.indexOf(name)}`;
  const filmId = (film) => `Q${1000 + films.indexOf(film)}`;
  const showId = (show) => `Q${2000 + shows.indexOf(show)}`;
  const imdbOf = (show) => `tt${String(9000000 + shows.indexOf(show))}`;
  const pageOf = (film) => film.page ?? ((film.known ?? 0) >= 2 ? film.title : null);

  for (const film of films) {
    const order = film.series ? films.filter((other) => other.series === film.series) : [];
    const at = order.indexOf(film);
    const kind = FILM_KINDS[film.kind] ?? FILM;
    put(filmId(film), {
      labels: label(film.title),
      aliases: film.aliases?.length ? { en: film.aliases.map((value) => ({ language: 'en', value })) } : {},
      descriptions: label(film.said ?? `${film.year ?? (film.date ?? '').slice(0, 4)} film${film.directors?.length ? ` directed by ${film.directors[0]}` : ''}`.trim()),
      otherNames: [film.original, ...(film.otherNames ?? [])].filter(Boolean),
      sitelinks: links(film.known ?? 0, pageOf(film)),
      claims: claims({
        P31: [pointTo(kind)],
        P577: dated(film),
        P57: (film.directors ?? []).map((name) => pointTo(personId(name))),
        P161: (film.cast ?? []).map((name) => pointTo(personId(name))),
        P179: film.series ? [pointTo(seriesId(film.series))] : [],
        P155: at > 0 ? [pointTo(filmId(order[at - 1]))] : [],
        P156: at >= 0 && at < order.length - 1 ? [pointTo(filmId(order[at + 1]))] : [],
        P136: (film.genres ?? []).map((genre) => pointTo(FILM_GENRES[genre])).filter((claim) => claim.mainsnak.datavalue.value.id),
        P495: film.country ? [pointTo(COUNTRIES[film.country] ?? 'Q30')] : [],
        P364: film.language ? [pointTo(LANGUAGES[film.language] ?? 'Q1860')] : [],
        P1476: film.original ? [{ mainsnak: { snaktype: 'value', datavalue: { value: { text: film.original, language: 'und' }, type: 'monolingualtext' } }, rank: 'normal' }] : [],
      }),
    });
  }
  for (const show of shows) {
    const kind = show.type === 'Animation' ? (show.language === 'Japanese' ? ANIME_SERIES : ANIMATED_SERIES) : SERIES;
    put(showId(show), {
      labels: label(show.name),
      aliases: show.akas?.length ? { en: show.akas.map((value) => ({ language: 'en', value })) } : {},
      descriptions: label(show.said ?? `${countryWord(show.country)} television series`),
      otherNames: [],
      sitelinks: links(Math.round((show.weight ?? 0) / 2), show.name),
      claims: claims({
        P31: [pointTo(kind)],
        P580: dated(show),
        P161: (show.cast ?? []).map((name) => pointTo(personId(name))),
        P170: (show.creators ?? []).map((name) => pointTo(personId(name))),
        P136: (show.genres ?? []).map((genre) => pointTo(SHOW_GENRES[genre])).filter((claim) => claim.mainsnak.datavalue.value.id),
        P345: [{ mainsnak: { snaktype: 'value', datavalue: { value: imdbOf(show), type: 'string' } }, rank: 'normal' }],
      }),
    });
  }
  for (const name of everyone) {
    const acted = [...films, ...shows].filter((item) => (item.cast ?? []).includes(name)).length;
    const directed = films.filter((film) => (film.directors ?? []).includes(name)).length;
    put(personId(name), {
      labels: label(name),
      aliases: {},
      descriptions: label(directed > acted ? 'film director' : 'actor'),
      otherNames: [],
      sitelinks: links(10 + acted + directed, name),
      claims: claims({ P31: [pointTo(HUMAN)], P106: [...(acted ? [pointTo(ACTOR)] : []), ...(directed ? [pointTo(DIRECTOR)] : [])] }),
    });
  }
  for (const name of seriesNames) put(seriesId(name), { labels: label(name), aliases: {}, descriptions: label('film series'), otherNames: [], sitelinks: {}, claims: claims({ P31: [pointTo('Q24856')] }) });
  // What a film's facts point to has a name too.
  for (const [name, id] of [...Object.entries(COUNTRIES), ...Object.entries(LANGUAGES)]) put(id, { labels: label(name), aliases: {}, descriptions: label(''), otherNames: [], sitelinks: {}, claims: {} });
  for (const [name, id] of Object.entries(FILM_GENRES)) put(id, { labels: label(`${name} film`), aliases: {}, descriptions: label('film genre'), otherNames: [], sitelinks: {}, claims: {} });
  for (const [name, id] of Object.entries(SHOW_GENRES)) put(id, { labels: label(`${name} television series`), aliases: {}, descriptions: label('television genre'), otherNames: [], sitelinks: {}, claims: {} });
  put(FILM, { labels: label('film'), aliases: {}, descriptions: label(''), otherNames: [], sitelinks: {}, claims: {} });

  function countryWord(code) {
    return { US: 'American', GB: 'British', JP: 'Japanese' }[code] ?? '';
  }
  const fame = (entity) => Object.keys(entity.sitelinks).length;
  const has = (entity, statement) => {
    const [property, value] = statement.split('=');
    return (entity.claims[property] ?? []).some((claim) => (claim.mainsnak.datavalue.value.id ?? claim.mainsnak.datavalue.value) === value);
  };

  function wikidataSearch(params) {
    const terms = String(params.get('srsearch') ?? '').split(/\s+/).filter(Boolean);
    const having = terms.filter((term) => term.startsWith('haswbstatement:')).map((term) => term.slice('haswbstatement:'.length).split('|'));
    const wanted = terms.filter((term) => !term.startsWith('haswbstatement:')).map((term) => ({ word: stem(words(term)[0] ?? ''), roughly: term.endsWith('~') })).filter((term) => term.word);
    const found = [...entities.values()].filter((entity) => {
      if (!having.every((either) => either.some((statement) => has(entity, statement)))) return false;
      const text = [entity.labels.en.value, ...(entity.aliases.en ?? []).map((alias) => alias.value), ...entity.otherNames, entity.descriptions.en.value].flatMap(words).map(stem);
      return wanted.every(({ word, roughly }) => text.some((other) => (roughly ? nearly(word, other) : word === other)));
    });
    // With no words there is nothing to be relevant to, and an empty search with no statement finds nothing.
    if (!wanted.length && !having.length) return json({ query: { searchinfo: { totalhits: 0 }, search: [] } });
    found.sort((a, b) => fame(b) - fame(a));
    return json({ query: { searchinfo: { totalhits: found.length }, search: found.slice(0, Number(params.get('srlimit')) || 10).map((entity) => ({ ns: 0, title: entity.id })) } });
  }

  function wikidataEntities(params) {
    const parts = String(params.get('props') ?? 'labels|aliases|descriptions|claims|sitelinks').split('|');
    const everyLanguage = !params.get('languages');
    let chosen;
    if (params.get('titles')) {
      const byPage = new Map([...entities.values()].filter((entity) => entity.sitelinks.enwiki).map((entity) => [entity.sitelinks.enwiki.title, entity]));
      chosen = params.get('titles').split('|').map((title) => byPage.get(title) ?? { missing: '', title });
    } else {
      chosen = String(params.get('ids') ?? '').split('|').map((id) => entities.get(id) ?? { id, missing: '' });
    }
    const out = {};
    chosen.forEach((entity, i) => {
      if (entity.missing !== undefined) {
        out[entity.id ?? `-${i + 1}`] = entity;
        return;
      }
      const shown = { id: entity.id, type: 'item' };
      if (parts.includes('labels')) shown.labels = everyLanguage ? { ...entity.labels, ...Object.fromEntries(entity.otherNames.map((value, at) => [`x${at}`, { language: `x${at}`, value }])) } : entity.labels;
      if (parts.includes('aliases')) shown.aliases = entity.aliases;
      if (parts.includes('descriptions')) shown.descriptions = entity.descriptions.en.value ? entity.descriptions : {};
      if (parts.includes('claims')) shown.claims = entity.claims;
      if (parts.includes('sitelinks')) shown.sitelinks = entity.sitelinks;
      out[entity.id] = shown;
    });
    return json({ entities: out, success: 1 });
  }

  // ---- TVmaze -------------------------------------------------------------------

  const showOf = (show) => ({
    id: show.id,
    name: show.name,
    type: show.type ?? 'Scripted',
    language: show.language ?? 'English',
    genres: (show.genres ?? []).map((genre) => genre.replace(/^\w/, (letter) => letter.toUpperCase())),
    status: show.status ?? (show.next || show.last ? 'Running' : 'Ended'),
    premiered: show.date ?? (show.year ? `${show.year}-03-01` : null),
    weight: show.weight ?? 0,
    network: show.country ? { id: 1, name: 'A network', country: { name: show.country, code: show.country } } : null,
    webChannel: null,
    externals: { tvrage: null, thetvdb: null, imdb: imdbOf(show) },
    summary: show.summary ? `<p>${show.summary}</p>` : null,
  });

  /** A show's episodes, dated so that exactly those up to `last` have aired. */
  function episodesOf(show) {
    const list = [];
    for (const [season, count] of Object.entries(show.seasons ?? {}).map(([number, episodes]) => [Number(number), episodes])) {
      for (let number = 1; number <= count; number++) {
        let airdate = `${(show.year ?? 2000) + season - 1}-03-${String(Math.min(28, number)).padStart(2, '0')}`;
        if (show.last) {
          // A week apart, the latest three days ago; what follows has a date when it is the season now airing, and none beyond it.
          const behind = season < show.last.season ? null : season === show.last.season ? number - show.last.episode : Infinity;
          if (behind !== null) airdate = behind === Infinity ? '' : dayFrom(behind * 7 - 3);
        }
        list.push({ id: season * 1000 + number, name: `Episode ${number}`, season, number, type: 'regular', airdate });
      }
    }
    // A special, which has no number and belongs to no season's count.
    if (list.length) list.push({ id: 1, name: 'A special', season: 1, number: null, type: 'significant_special', airdate: list[0].airdate });
    return list;
  }

  function tvmazeSearch(query) {
    const asked = words(query);
    const scored = shows
      .map((show) => {
        const names = [show.name, ...(show.akas ?? [])].map(words);
        // The share of the words asked for that some name of the show has, slips forgiven.
        const score = Math.max(...names.map((name) => asked.filter((word) => name.some((other) => nearly(word, other))).length / Math.max(asked.length, name.length)));
        return { score, show };
      })
      .filter((entry) => asked.length && entry.score >= 0.5)
      .sort((a, b) => b.score - a.score || (b.show.weight ?? 0) - (a.show.weight ?? 0));
    return json(scored.slice(0, 10).map(({ score, show }) => ({ score, show: showOf(show) })));
  }

  /** Answers one request as `fetch` would. */
  async function answer(address, { headers = {} } = {}) {
    const url = new URL(address);
    const service = Object.keys(SERVICES).find((name) => address.startsWith(SERVICES[name]));
    const header = (wanted) => Object.entries(headers).find(([key]) => key.toLowerCase() === wanted.toLowerCase())?.[1];
    state.requests.push({ service, path: url.pathname, search: url.search, userAgent: header('User-Agent') });
    if (state.down.has(service) || state.down.has('all')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const missing = () => json({ status: 404 }, 404);

    if (service === 'wikidata') {
      const action = url.searchParams.get('action');
      if (action === 'query') return wikidataSearch(url.searchParams);
      if (action === 'wbgetentities') return wikidataEntities(url.searchParams);
      return json({ error: { code: 'badvalue', info: 'Unrecognized value for parameter "action"' } });
    }
    if (service === 'tvmaze') {
      const path = url.pathname;
      if (path === '/search/shows') return tvmazeSearch(url.searchParams.get('q'));
      const match = /^\/shows\/(\d+)$/.exec(path);
      const show = match && shows.find((entry) => entry.id === Number(match[1]));
      // The first show there is, which PiRick asks for to see whether TVmaze answers.
      if (match && !show) return match[1] === '1' ? json({ id: 1, name: 'A show' }) : missing();
      if (show) {
        const person = (name) => ({ person: { id: everyone.indexOf(name) + 1, name } });
        return json({ ...showOf(show), _embedded: { episodes: episodesOf(show), akas: (show.akas ?? []).map((name) => ({ name, country: null })), cast: (show.cast ?? []).map(person), crew: (show.creators ?? []).map((name) => ({ type: 'Creator', ...person(name) })) } });
      }
      return missing();
    }
    if (service === 'wikipedia') {
      const page = decodeURIComponent(url.pathname.split('/page/summary/')[1] ?? '').replace(/_/g, ' ');
      const film = films.find((entry) => pageOf(entry) === page);
      return film?.about ? json({ type: 'standard', title: page, extract: film.about }) : missing();
    }
    if (service === 'pageviews') {
      // The day just gone has no figures yet.
      if (url.pathname.endsWith(today().replace(/-/g, '/')) || url.pathname.endsWith(dayFrom(-1).replace(/-/g, '/'))) return missing();
      const articles = ['Main_Page', 'Special:Search', ...mostRead].map((title, i) => ({ article: title.replace(/ /g, '_'), views: 100000 - i, rank: i + 1 }));
      return json({ items: [{ project: 'en.wikipedia', articles }] });
    }
    return missing();
  }

  return {
    fetch: answer,
    /** Every request made, as `{ service, path, search, userAgent }`. */
    requests: state.requests,
    /** Makes one service ('wikidata', 'tvmaze', 'wikipedia', 'pageviews') or 'all' unreachable, or reachable again. */
    setDown(service, down = true) {
      if (down) state.down.add(service);
      else state.down.delete(service);
    },
  };
}
