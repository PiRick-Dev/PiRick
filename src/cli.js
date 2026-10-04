// Recovery tool for a locked-out account:
//   docker compose exec pirick node src/cli.js reset-password <username>
import { randomBytes } from 'node:crypto';
import { createAuth } from './auth.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';

const [command, username] = process.argv.slice(2);
if (command !== 'reset-password' || !username) {
  console.error('Usage: node src/cli.js reset-password <username>');
  process.exit(2);
}

const config = loadConfig();
const db = openDb(config.dbFile);
const auth = createAuth(db, config);
const user = auth.findUser(username);
if (!user) {
  console.error(`There is no user called "${username}".`);
  process.exit(1);
}

const password = randomBytes(12).toString('base64url');
await auth.setPassword(user.id, password);
db.close();
console.log(`New password for ${user.username}: ${password}`);
console.log('They have been signed out everywhere and should change it under Account.');
