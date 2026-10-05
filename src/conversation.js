import { transaction } from './db.js';

const KEEP_PER_USER = 400;
// Rows with these roles are shown in the chat window but never sent to the model.
// An 'aside' is something PiRick said unprompted, such as a welcome-back summary.
const STATUS = 'status';
const ASIDE = 'aside';

export function createConversation(db) {
  const insert = db.prepare('INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)');
  const prune = db.prepare(`
    DELETE FROM messages
    WHERE user_id = ? AND id <= (
      SELECT id FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
    )`);
  const recentForModel = db.prepare(`
    SELECT content FROM (
      SELECT id, content FROM messages WHERE user_id = ? AND role NOT IN (?, ?) ORDER BY id DESC LIMIT ?
    ) ORDER BY id`);
  const recentForDisplay = db.prepare(`
    SELECT content FROM (
      SELECT id, content FROM messages WHERE user_id = ? AND role != 'tool' ORDER BY id DESC LIMIT ?
    ) ORDER BY id`);
  const clear = db.prepare('DELETE FROM messages WHERE user_id = ?');

  return {
    /** Stores messages in order, atomically. */
    append(userId, messages) {
      transaction(db, () => {
        const now = Date.now();
        for (const message of messages) insert.run(userId, message.role, JSON.stringify(message), now);
        prune.run(userId, userId, KEEP_PER_USER);
      });
    },

    /** Recent messages to replay to the model. Always starts at a user message. */
    context(userId, limit = 40) {
      const messages = recentForModel.all(userId, STATUS, ASIDE, limit).map((row) => JSON.parse(row.content));
      // The window may have cut a tool exchange in half; drop the orphaned start.
      while (messages.length && messages[0].role !== 'user') messages.shift();
      return messages;
    },

    /** What the chat window shows: what was said, plus status lines. */
    history(userId, limit = 200) {
      const items = [];
      for (const row of recentForDisplay.all(userId, limit)) {
        const message = JSON.parse(row.content);
        if (message.role === STATUS) items.push({ type: 'status', text: message.text, kind: message.kind });
        else if (message.content?.trim()) items.push({ type: message.role === ASIDE ? 'assistant' : message.role, text: message.content });
      }
      return items;
    },

    clear(userId) {
      clear.run(userId);
    },
  };
}
