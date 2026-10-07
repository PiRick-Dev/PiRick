import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PASSWORD_MAX, createRateLimiter, validatePassword, validateUsername } from './auth.js';
import { UpstreamError, describeError } from './errors.js';
import { checkFolder, isAbsolutePath, joinPath, splitPath, tidyPath } from './folders.js';
import { log } from './log.js';
import { matchLibrary } from './plex.js';
import { BASE_TAG, userTag } from './qbittorrent.js';
import { PERSONALITIES_MAX, PERSONALITY_MAX, STARTER_PERSONALITIES, parseLibrary, parsePersonality, parsePlexChoice, parseUpkeep } from './settings.js';
import { MODES, THEMES } from './themes.js';

const WEB_DIR = fileURLToPath(new URL('../web', import.meta.url));
const MAX_MESSAGE_LENGTH = 2000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 15_000;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const FRIENDLY = {
  ollama: "I can't think right now: the AI service isn't responding. Please try again in a moment.",
  qbittorrent: "The download service isn't responding right now. Please try again in a moment.",
  jackett: "The search service isn't responding right now. Please try again in a moment.",
};

function field(req, name) {
  const value = req.body?.[name];
  return typeof value === 'string' ? value : '';
}

/** A plain-language error for the person; admins also get the technical reason. */
function explain(err, user) {
  const friendly = (err instanceof UpstreamError && FRIENDLY[err.service]) || 'Something went wrong. Please try again.';
  return user.role === 'admin' ? `${friendly} (${describeError(err)})` : friendly;
}

export function createApp({ config, auth, agent, conversation, tools, settings, upkeep, ollama, jackett, qbit, plex, catalogue }) {
  const app = express();
  const attempts = createRateLimiter({ windowMs: ATTEMPT_WINDOW_MS });
  const busy = new Set();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));
  app.use('/static', express.static(path.join(WEB_DIR, 'static'), { index: false }));

  const page = (file) => (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(WEB_DIR, file));
  app.get('/login', (req, res, next) => (auth.userFromRequest(req) ? res.redirect('/') : next()), page('login.html'));
  app.get('/', (req, res, next) => (auth.userFromRequest(req) ? next() : res.redirect('/login')), page('index.html'));
  // Forms are submitted by script. If the script failed to load, the browser
  // posts the form here instead (never as a GET, which would put passwords in
  // the URL); the body is ignored and the page simply reloads.
  app.post(['/', '/login'], (req, res) => res.redirect(303, req.path));

  const api = express.Router();
  app.use('/api', api);

  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    // CSRF guard. A cross-site page cannot add a custom header without a CORS
    // preflight, which is never granted; browsers on HTTPS also say where the
    // request came from.
    const site = req.get('sec-fetch-site');
    if (req.get('x-pirick') !== '1' || (site && site !== 'same-origin')) {
      return res.status(403).json({ error: 'This request was blocked because it did not come from PiRick.' });
    }
    next();
  });
  api.use(express.json({ limit: '32kb' }));

  function requireUser(req, res, next) {
    req.user = auth.userFromRequest(req);
    if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
    next();
  }

  function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can do that.' });
    next();
  }

  /** Starts a line-by-line event stream to the browser. */
  function openStream(res) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
    res.on('error', () => {});
    // If the browser goes away the work still finishes, so the history stays
    // consistent with what was actually downloaded.
    const emit = (event) => {
      if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    // A slow model can be silent for minutes; reverse proxies drop idle connections.
    const heartbeat = setInterval(() => emit({ type: 'ping' }), HEARTBEAT_MS);
    return {
      emit,
      end() {
        clearInterval(heartbeat);
        res.end();
      },
    };
  }

  function tooMany(res, wait) {
    const minutes = Math.ceil(wait / 60);
    res
      .status(429)
      .set('Retry-After', String(wait))
      .json({ error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
  }

  // ---- Session -------------------------------------------------------------

  api.post('/login', async (req, res) => {
    const username = field(req, 'username').trim();
    const password = field(req, 'password');
    if (!username || !password) return res.status(400).json({ error: 'Enter your username and password.' });

    const name = username.toLowerCase().slice(0, 64);
    const pair = `pair:${req.ip}|${name}`;
    // Counted before the password is checked, so parallel guesses cannot slip past.
    // The pair comes before the username: guesses from an address that is already
    // blocked stop there, so one address cannot lock a person out for everyone.
    const wait = attempts.hit([[`ip:${req.ip}`, 30], [pair, 5], [`user:${name}`, 20]]);
    if (wait) {
      log.warn('login blocked', { username: name, ip: req.ip });
      return tooMany(res, wait);
    }

    const plausible = username.length <= 64 && password.length <= PASSWORD_MAX;
    const user = plausible ? await auth.checkCredentials(username, password) : null;
    if (!user) {
      log.warn('login failed', { username: name, ip: req.ip });
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }

    attempts.reset(pair);
    auth.signIn(req, res, user.id);
    log.info('login', { username: user.username, ip: req.ip });
    res.json({ username: user.username, role: user.role });
  });

  api.post('/logout', (req, res) => {
    auth.signOut(req, res);
    res.json({ ok: true });
  });

  api.use(requireUser);

  /** Who is signed in, what they have chosen for themselves, and what there is to choose from. */
  function describeMe({ id, username, role }) {
    return {
      id,
      username,
      role,
      // Admins are told when nothing can be downloaded yet, so the page can say so.
      ...(role === 'admin' && { setupNeeded: settings.libraries().length === 0 }),
      ...settings.preferences(id),
      themes: THEMES,
      modes: MODES,
      // Names only: a personality's description is the admin's instruction to the model.
      personalities: settings.personalities().map((entry) => ({ id: String(entry.id), name: entry.name })),
      usualPersonality: settings.usualPersonality()?.name ?? '',
    };
  }

  api.get('/me', (req, res) => res.json(describeMe(req.user)));

  // A person's own theme and personality. Only ever their own: there is no id in the address.
  api.put('/me', (req, res) => {
    const { changes, error } = settings.checkPreferences(req.body);
    if (error) return res.status(400).json({ error });
    settings.setPreferences(req.user.id, changes);
    res.json(describeMe(req.user));
  });

  api.post('/password', async (req, res) => {
    const problem = validatePassword(field(req, 'newPassword'));
    if (problem) return res.status(400).json({ error: problem });

    const key = `password:${req.user.id}`;
    const wait = attempts.hit([[key, 5]]);
    if (wait) return tooMany(res, wait);
    // 403, not 401: the session is fine, so the page must not bounce to the login screen.
    if (!(await auth.checkCredentials(req.user.username, field(req, 'currentPassword')))) {
      return res.status(403).json({ error: 'Your current password is not right.' });
    }
    attempts.reset(key);
    await auth.setPassword(req.user.id, field(req, 'newPassword'), req.user.session);
    log.info('password changed', { username: req.user.username });
    res.json({ ok: true });
  });

  // ---- Chat ----------------------------------------------------------------

  api.get('/chat', (req, res) => res.json({ messages: conversation.history(req.user.id) }));

  api.delete('/chat', (req, res) => {
    if (busy.has(req.user.id)) return res.status(409).json({ error: 'PiRick is still working on your last message.' });
    conversation.clear(req.user.id);
    tools.forget(req.user.id);
    res.json({ ok: true });
  });

  api.post('/chat', async (req, res) => {
    const text = field(req, 'message').trim();
    if (!text) return res.status(400).json({ error: 'Type a message first.' });
    if (text.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Messages can be at most ${MAX_MESSAGE_LENGTH} characters.` });
    }
    if (busy.has(req.user.id)) return res.status(409).json({ error: 'PiRick is still working on your last message.' });

    busy.add(req.user.id);
    const stream = openStream(res);
    try {
      await agent.runTurn(req.user, text, stream.emit);
      stream.emit({ type: 'done' });
    } catch (err) {
      log.error('chat failed', { username: req.user.username, error: describeError(err) });
      stream.emit({ type: 'error', message: explain(err, req.user) });
    } finally {
      busy.delete(req.user.id);
      stream.end();
    }
  });

  // Called when someone opens the chat: tells them what upkeep did while they were away.
  api.post('/chat/catch-up', async (req, res) => {
    const stream = openStream(res);
    // Skipped while a message is being answered; it is offered again next time.
    if (!busy.has(req.user.id)) {
      busy.add(req.user.id);
      try {
        await agent.catchUp(req.user, stream.emit);
      } catch (err) {
        log.error('catch-up failed', { username: req.user.username, error: describeError(err) });
      } finally {
        busy.delete(req.user.id);
      }
    }
    stream.emit({ type: 'done' });
    stream.end();
  });

  // ---- Downloads -----------------------------------------------------------

  api.get('/downloads', async (req, res) => {
    const everyone = req.user.role === 'admin' && req.query.all === '1';
    try {
      const downloads = await qbit.list(everyone ? BASE_TAG : userTag(req.user.username));
      const stuck = upkeep.stuckHashes();
      const inPlex = upkeep.inPlex();
      res.json({
        downloads: downloads.slice(0, 100).map(({ hash, requestedBy, ...item }) => ({
          ...item,
          ...(stuck.has(hash) && { status: 'stuck', etaSeconds: null }),
          // Only said of the ones Plex has actually been asked to pick up.
          ...(inPlex.has(hash) && item.status === 'finished' && { inPlex: true }),
          // Who asked for what is only for an admin looking at everyone's.
          ...(everyone && { requestedBy }),
        })),
      });
    } catch (err) {
      log.warn('downloads unavailable', { error: describeError(err) });
      res.status(502).json({ error: explain(err, req.user) });
    }
  });

  // ---- Admin ---------------------------------------------------------------

  const admin = express.Router();
  api.use('/admin', requireAdmin, admin);

  admin.get('/status', async (req, res) => {
    const probe = async (service) => {
      try {
        return { ok: true, detail: await service.check() };
      } catch (err) {
        return { ok: false, detail: err instanceof UpstreamError ? err.message : describeError(err) };
      }
    };
    // Plex is optional: left out of .env, it is reported as switched off, not as broken.
    const plexProbe = plex.enabled ? probe(plex) : { off: true, detail: 'Not connected. Set PLEX_URL and PLEX_TOKEN to connect it.' };
    // So is the catalogue.
    const catalogueProbe = catalogue?.enabled ? probe(catalogue) : { off: true, detail: 'Switched off. Set CATALOGUE=on to use it.' };
    const [ollamaStatus, jackettStatus, qbitStatus, plexStatus, catalogueStatus] = await Promise.all([probe(ollama), probe(jackett), probe(qbit), plexProbe, catalogueProbe]);
    res.json({ ollama: ollamaStatus, jackett: jackettStatus, qbittorrent: qbitStatus, plex: plexStatus, catalogue: catalogueStatus });
  });

  // Which build of PiRick this is: `{ commit, builtAt }`, both empty unless it runs from the published image.
  admin.get('/about', (req, res) => res.json(config.build));

  // ---- Admin: libraries --------------------------------------------------------

  /** Folder names inside `folder` as qBittorrent sees them, or null when it cannot say. */
  async function foldersIn(folder) {
    try {
      const listing = await qbit.listFolders(folder);
      return listing ? listing.names : null;
    } catch (err) {
      log.warn('could not list folders', { error: describeError(err) });
      return null;
    }
  }

  /** Adds `folder: { status, suggestion }` to each library: does its folder really exist? */
  async function withFolderChecks(libraries) {
    const parentOf = (library) => splitPath(library.savePath).parent;
    const parents = [...new Set(libraries.map(parentOf))];
    const siblings = new Map(await Promise.all(parents.map(async (parent) => [parent, await foldersIn(parent)])));
    return libraries.map((library) => ({ ...library, folder: checkFolder(library.savePath, siblings.get(parentOf(library))) }));
  }

  /**
   * With Plex connected, adds to each library the Plex folder it matches
   * (`plex`: `{ title, path, chosen }` or `{ none: true, chosen }`), and returns
   * every Plex folder there is to choose from.
   */
  async function withPlex(libraries) {
    if (!plex.enabled) return { libraries };
    let plexLibraries;
    try {
      plexLibraries = await plex.libraries({ fresh: true });
    } catch (err) {
      log.warn('could not list the Plex libraries', { error: describeError(err) });
      return { libraries, plex: { error: err instanceof UpstreamError ? err.message : describeError(err) } };
    }
    const folders = plexLibraries.flatMap(({ key, title, folders: paths }) => paths.map((path) => ({ key, title, path })));
    return {
      libraries: libraries.map((library) => {
        const choice = settings.plexChoice(library.id);
        const match = matchLibrary(library, plexLibraries, choice);
        // "chosen" is what the admin picked, which the match can fall back from if that folder has gone.
        const chosen = choice?.none ? 'none' : match?.chosen ? 'folder' : 'auto';
        return { ...library, plex: match ? { key: match.key, title: match.title, path: match.path, chosen } : { none: true, chosen } };
      }),
      plex: { folders },
    };
  }

  admin.get('/libraries', async (req, res) => res.json(await withPlex(await withFolderChecks(settings.libraries()))));

  /** One library as the admin screen shows it, with its folder check and its Plex match. */
  const described = async (library) => (await withPlex(await withFolderChecks([library]))).libraries[0];

  admin.post('/libraries', async (req, res) => {
    const { library, error } = parseLibrary(req.body);
    if (error) return res.status(400).json({ error });
    const saved = settings.addLibrary(library);
    if (!saved) return res.status(409).json({ error: 'There is already a library with that name.' });
    log.info('library added', { name: saved.name, path: saved.savePath, by: req.user.username });
    res.status(201).json({ library: await described(saved) });
  });

  admin.param('libraryId', (req, res, next, id) => {
    req.library = /^\d+$/.test(id) ? settings.library(Number(id)) : null;
    if (!req.library) return res.status(404).json({ error: 'That library no longer exists.' });
    next();
  });

  admin.put('/libraries/:libraryId', async (req, res) => {
    const { library, error } = parseLibrary(req.body);
    if (error) return res.status(400).json({ error });
    const saved = settings.updateLibrary(req.library.id, library);
    if (!saved) return res.status(409).json({ error: 'There is already a library with that name.' });
    log.info('library changed', { name: saved.name, path: saved.savePath, by: req.user.username });
    res.json({ library: await described(saved) });
  });

  // Which Plex folder a library's downloads end up in, when PiRick's own match is wrong.
  admin.put('/libraries/:libraryId/plex', async (req, res) => {
    const { choice, error } = parsePlexChoice(req.body);
    if (error) return res.status(400).json({ error });
    settings.setPlexChoice(req.library.id, choice);
    log.info('library matched to Plex', { name: req.library.name, plex: choice?.none ? 'none' : (choice?.path ?? 'automatic'), by: req.user.username });
    res.json({ library: await described(req.library) });
  });

  admin.delete('/libraries/:libraryId', (req, res) => {
    settings.removeLibrary(req.library.id);
    log.info('library removed', { name: req.library.name, by: req.user.username });
    res.json({ ok: true });
  });

  // Suggestions for the folder box: the real folders around what has been typed.
  admin.get('/folders', async (req, res) => {
    const typed = typeof req.query.path === 'string' ? req.query.path : '';
    let folder;
    if (!typed.trim()) {
      // Nothing typed yet: start beside qBittorrent's own default save folder.
      folder = await qbit.defaultSavePath().then((path) => splitPath(path).parent, () => '');
    } else {
      folder = /[/\\]$/.test(typed) ? tidyPath(typed) : splitPath(typed).parent;
    }
    if (!isAbsolutePath(folder)) return res.json({ folders: [] });
    const names = (await foldersIn(folder)) ?? [];
    res.json({ folders: names.sort((a, b) => a.localeCompare(b)).map((name) => joinPath(folder, name)) });
  });

  // ---- Admin: upkeep -------------------------------------------------------------

  const upkeepState = () => ({ ...settings.upkeep(), ...upkeep.overview(), log: upkeep.recent() });

  admin.get('/upkeep', (req, res) => res.json(upkeepState()));

  admin.put('/upkeep', (req, res) => {
    const { upkeep: value, error } = parseUpkeep(req.body);
    if (error) return res.status(400).json({ error });
    settings.setUpkeep(value);
    log.info('upkeep settings changed', { ...value, by: req.user.username });
    res.json(upkeepState());
  });

  admin.post('/upkeep/run', async (req, res) => {
    try {
      const result = await upkeep.runOnce({ manual: true });
      res.json({ result, ...upkeepState() });
    } catch (err) {
      log.warn('upkeep check failed', { error: describeError(err) });
      res.status(502).json({ error: explain(err, req.user) });
    }
  });

  // ---- Admin: personalities ----------------------------------------------------

  // The list people choose from, which entry is the usual one, and the starters an admin can bring back.
  admin.get('/personalities', (req, res) =>
    res.json({
      personalities: settings.personalities(),
      usualId: settings.usualPersonality()?.id ?? null,
      starters: STARTER_PERSONALITIES,
      max: PERSONALITY_MAX,
    }),
  );

  admin.post('/personalities', (req, res) => {
    const { personality, error } = parsePersonality(req.body);
    if (error) return res.status(400).json({ error });
    if (settings.personalities().length >= PERSONALITIES_MAX) {
      return res.status(400).json({ error: `There can be at most ${PERSONALITIES_MAX} personalities. Remove one first.` });
    }
    const saved = settings.addPersonality(personality);
    if (!saved) return res.status(409).json({ error: 'There is already a personality with that name.' });
    log.info('personality added', { name: saved.name, by: req.user.username });
    res.status(201).json({ personality: saved });
  });

  // Which entry people hear unless they choose otherwise; null for plain PiRick.
  admin.put('/personalities/usual', (req, res) => {
    const id = req.body?.id ?? null;
    if (id !== null && !(Number.isInteger(id) && settings.personality(id))) {
      return res.status(400).json({ error: 'That personality no longer exists.' });
    }
    settings.setUsualPersonality(id);
    log.info('usual personality changed', { name: id === null ? '(none)' : settings.personality(id).name, by: req.user.username });
    res.json({ usualId: id });
  });

  admin.param('personalityId', (req, res, next, id) => {
    req.personality = /^\d{1,15}$/.test(id) ? settings.personality(Number(id)) : null;
    if (!req.personality) return res.status(404).json({ error: 'That personality no longer exists.' });
    next();
  });

  admin.put('/personalities/:personalityId', (req, res) => {
    const { personality, error } = parsePersonality(req.body);
    if (error) return res.status(400).json({ error });
    const saved = settings.updatePersonality(req.personality.id, personality);
    if (!saved) return res.status(409).json({ error: 'There is already a personality with that name.' });
    log.info('personality changed', { name: saved.name, by: req.user.username });
    res.json({ personality: saved });
  });

  admin.delete('/personalities/:personalityId', (req, res) => {
    settings.removePersonality(req.personality.id);
    log.info('personality removed', { name: req.personality.name, by: req.user.username });
    res.json({ ok: true });
  });

  // ---- Admin: people -----------------------------------------------------------

  admin.get('/users', (req, res) => res.json({ users: auth.listUsers() }));

  admin.post('/users', async (req, res) => {
    const username = field(req, 'username').trim();
    const password = field(req, 'password');
    const role = field(req, 'role') === 'admin' ? 'admin' : 'user';
    const problem = validateUsername(username) ?? validatePassword(password);
    if (problem) return res.status(400).json({ error: problem });
    const user = await auth.createUser(username, password, role);
    if (!user) return res.status(409).json({ error: 'That username is already taken.' });
    log.info('user created', { username, role, by: req.user.username });
    res.status(201).json({ user });
  });

  admin.param('id', (req, res, next, id) => {
    req.target = /^\d+$/.test(id) ? auth.findUserById(Number(id)) : null;
    if (!req.target) return res.status(404).json({ error: 'That person no longer exists.' });
    next();
  });

  admin.post('/users/:id/password', async (req, res) => {
    const problem = validatePassword(field(req, 'password'));
    if (problem) return res.status(400).json({ error: problem });
    // Resetting someone else's password signs them out everywhere.
    const keep = req.target.id === req.user.id ? req.user.session : '';
    await auth.setPassword(req.target.id, field(req, 'password'), keep);
    log.info('password reset', { username: req.target.username, by: req.user.username });
    res.json({ ok: true });
  });

  admin.delete('/users/:id', (req, res) => {
    // Admins cannot remove themselves, so at least one admin always remains.
    if (req.target.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account.' });
    auth.deleteUser(req.target.id);
    tools.forget(req.target.id);
    log.info('user removed', { username: req.target.username, by: req.user.username });
    res.json({ ok: true });
  });

  // ---- Fallbacks -----------------------------------------------------------

  api.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) log.error('request failed', { path: req.path, error: err?.stack ?? String(err) });
    const message = status === 413 ? 'That is too long.' : status === 500 ? 'Something went wrong.' : 'Bad request.';
    res.status(status).json({ error: message });
  });

  return app;
}
