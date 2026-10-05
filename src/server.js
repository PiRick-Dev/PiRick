import { randomBytes } from 'node:crypto';
import { validatePassword, validateUsername } from './auth.js';
import { build } from './build.js';
import { loadConfig } from './config.js';
import { log } from './log.js';

const SESSION_CLEANUP_MS = 60 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 5000;

/** Creates the first admin account when the database has no users yet. */
async function ensureAdmin(auth, config) {
  if (auth.userCount() > 0) return;
  const { username } = config.admin;
  const generated = !config.admin.password;
  const password = generated ? randomBytes(12).toString('base64url') : config.admin.password;
  const problem = validateUsername(username) ?? validatePassword(password);
  if (problem) throw new Error(`Cannot create the first admin account. ${problem}`);

  await auth.createUser(username, password, 'admin');
  if (generated) {
    console.log(
      [
        '',
        '================ PiRick first-run admin account ================',
        `  username: ${username}`,
        `  password: ${password}`,
        '  Shown once. Sign in and change it under Account.',
        '================================================================',
        '',
      ].join('\n'),
    );
  } else {
    log.info('created the first admin account from ADMIN_USERNAME / ADMIN_PASSWORD', { username });
  }
}

async function main() {
  const config = loadConfig();
  const { app, auth, db, settings, upkeep } = build(config);
  await ensureAdmin(auth, config);

  if (!config.jackett.apiKey) log.warn('JACKETT_API_KEY is not set: searches will fail until it is');
  const retired = Object.keys(process.env).filter((name) => /^QBIT_(CATEGORY|SAVEPATH)_/.test(name));
  if (retired.length) {
    log.warn('these settings are no longer used and can be removed from .env; destinations are now set under Admin > Libraries', {
      settings: retired,
    });
  }
  if (!settings.libraries().length) log.warn('no libraries are set up: downloads are refused until an admin adds one');
  auth.purgeExpiredSessions();
  setInterval(() => auth.purgeExpiredSessions(), SESSION_CLEANUP_MS).unref();

  const server = app.listen(config.port, () => {
    log.info('PiRick is listening', { port: config.port, model: config.ollama.model });
  });
  // Watches PiRick's own downloads and replaces the ones that get stuck.
  upkeep.start();

  // As PID 1 in a container, Node gets no default signal handling.
  const shutdown = (signal) => {
    log.info('shutting down', { signal });
    upkeep.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error(`PiRick could not start: ${err.message}`);
  process.exit(1);
});
