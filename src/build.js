import { createAgent } from './agent.js';
import { createAuth } from './auth.js';
import { createConversation } from './conversation.js';
import { openDb } from './db.js';
import { createJackett } from './jackett.js';
import { createOllama } from './ollama.js';
import { createQbittorrent } from './qbittorrent.js';
import { createApp } from './routes.js';
import { createSettings } from './settings.js';
import { createTools } from './tools.js';

/** Wires every part of PiRick together from a config object. */
export function build(config) {
  const db = openDb(config.dbFile);
  const auth = createAuth(db, config);
  const ollama = createOllama(config.ollama);
  const jackett = createJackett(config.jackett);
  const qbit = createQbittorrent(config.qbit);
  const conversation = createConversation(db);
  const settings = createSettings(db);
  const tools = createTools({ config, jackett, qbit, settings });
  const agent = createAgent({ ollama, tools, conversation, settings });
  const app = createApp({ config, auth, agent, conversation, tools, settings, ollama, jackett, qbit });
  return { app, auth, db, settings };
}
