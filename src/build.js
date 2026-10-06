import { createAgent } from './agent.js';
import { createAuth } from './auth.js';
import { createConversation } from './conversation.js';
import { openDb } from './db.js';
import { createJackett } from './jackett.js';
import { createOllama } from './ollama.js';
import { createPlex } from './plex.js';
import { createQbittorrent } from './qbittorrent.js';
import { createApp } from './routes.js';
import { createSettings } from './settings.js';
import { createTools } from './tools.js';
import { createUpkeep } from './upkeep.js';

/** Wires every part of PiRick together from a config object. */
export function build(config) {
  const db = openDb(config.dbFile);
  const auth = createAuth(db, config);
  const ollama = createOllama(config.ollama);
  const jackett = createJackett(config.jackett);
  const qbit = createQbittorrent(config.qbit);
  const plex = createPlex(config.plex);
  const conversation = createConversation(db);
  const settings = createSettings(db);
  const upkeep = createUpkeep({ db, qbit, jackett, settings, config, plex });
  const tools = createTools({ config, jackett, qbit, settings, upkeep, plex });
  const agent = createAgent({ ollama, tools, conversation, settings, upkeep, plex });
  const app = createApp({ config, auth, agent, conversation, tools, settings, upkeep, ollama, jackett, qbit, plex });
  return { app, auth, db, settings, upkeep };
}
