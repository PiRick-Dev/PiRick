import { createAgent } from './agent.js';
import { createAuth } from './auth.js';
import { createCatalogue } from './catalogue.js';
import { createConversation } from './conversation.js';
import { openDb } from './db.js';
import { createJackett } from './jackett.js';
import { createNews } from './news.js';
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
  const catalogue = createCatalogue(config.catalogue);
  const conversation = createConversation(db);
  const settings = createSettings(db);
  const upkeep = createUpkeep({ db, qbit, jackett, settings, config, plex });
  const tools = createTools({ config, jackett, qbit, settings, upkeep, plex, catalogue });
  const news = createNews({
    db,
    has: () => ({
      catalogue: catalogue.enabled,
      personalities: settings.personalities().length > 0,
      // It takes Plex to correct and the catalogue to know what is right.
      matches: plex.enabled && catalogue.enabled && settings.upkeep().fixMatches,
    }),
  });
  const agent = createAgent({ ollama, tools, conversation, settings, upkeep, plex, catalogue, news });
  const app = createApp({ config, auth, agent, conversation, tools, settings, upkeep, ollama, jackett, qbit, plex, catalogue });
  return { app, auth, db, settings, upkeep, catalogue };
}
