const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL ?? 'info').toLowerCase()] ?? LEVELS.info;

function write(level, message, fields) {
  if (LEVELS[level] < threshold) return;
  // Values are JSON-encoded so user-supplied text cannot forge extra log lines.
  const extra = fields
    ? ' ' + Object.entries(fields).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')
    : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${extra}`;
  (LEVELS[level] >= LEVELS.warn ? console.error : console.log)(line);
}

export const log = {
  debug: (message, fields) => write('debug', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
};
