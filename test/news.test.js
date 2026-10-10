import assert from 'node:assert/strict';
import { test } from 'node:test';

// The agent warns when the model fails it, which one test makes happen on purpose.
process.env.LOG_LEVEL = 'error';
const { openDb } = await import('../src/db.js');
const { MAX_NEWS, NEWS, createNews } = await import('../src/news.js');
const { createWorld } = await import('../bench/world.js');

const EVERYTHING = { catalogue: true, personalities: true, matches: true };

function person(db, username, role = 'user') {
  const { lastInsertRowid } = db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, 'none', ?, ?)").run(username, role, Date.now());
  return { id: Number(lastInsertRowid), username, role };
}
const texts = (news, user) => news.unheard(user).map((entry) => entry.text);
const ids = (news, user) => news.unheard(user).map((entry) => entry.id);

test('what is new is told once, to whoever had an account when it came', () => {
  const db = openDb(':memory:');
  const alice = person(db, 'alice');
  const first = [{ id: 1, text: 'One.' }];
  // An update: PiRick starts with an entry it did not have before.
  let news = createNews({ db, has: () => EVERYTHING, entries: first });
  assert.deepEqual(news.unheard(alice), [{ id: 1, text: 'One.' }]);
  // Asking what there is to tell is not telling it.
  assert.deepEqual(texts(news, alice), ['One.']);
  news.heard(alice, [1]);
  assert.deepEqual(news.unheard(alice), []);

  // Bob joins afterwards, and finds PiRick as it is.
  const bob = person(db, 'bob');
  assert.deepEqual(news.unheard(bob), []);
  // A restart brings nothing back.
  news = createNews({ db, has: () => EVERYTHING, entries: first });
  assert.deepEqual([news.unheard(alice), news.unheard(bob)], [[], []]);

  // The next update is news to both of them, and only what it added.
  news = createNews({ db, has: () => EVERYTHING, entries: [...first, { id: 2, text: 'Two.' }] });
  assert.deepEqual([texts(news, alice), texts(news, bob)], [['Two.'], ['Two.']]);
  news.heard(alice, [2]);
  assert.deepEqual([texts(news, alice), texts(news, bob)], [[], ['Two.']]);

  // Nothing is kept for an account that is gone.
  db.prepare('DELETE FROM users WHERE id = ?').run(bob.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM news_owed').get().n, 0);
});

test('a PiRick with nobody in it yet has nothing to tell its first admin', () => {
  const db = openDb(':memory:');
  const news = createNews({ db, has: () => EVERYTHING });
  assert.deepEqual(news.unheard(person(db, 'admin', 'admin')), []);
});

test('news of something that is switched off waits until it is on', () => {
  const db = openDb(':memory:');
  const alice = person(db, 'alice');
  const entries = [{ id: 1, when: (has) => has.catalogue, text: 'Ask me about films.' }];
  let catalogue = false;
  const has = () => ({ catalogue, personalities: true });
  let news = createNews({ db, has, entries });
  assert.deepEqual(news.unheard(alice), []);

  // Bob joins while it is off, so for him too it is new when it comes.
  const bob = person(db, 'bob');
  catalogue = true;
  news = createNews({ db, has, entries });
  assert.deepEqual([texts(news, alice), texts(news, bob)], [['Ask me about films.'], ['Ask me about films.']]);

  // Switched off again before anyone was told: kept back, and not forgotten.
  catalogue = false;
  assert.deepEqual(news.unheard(alice), []);
  catalogue = true;
  assert.deepEqual(texts(news, alice), ['Ask me about films.']);
});

test('a few are told at a time, the oldest first, and what is for admins goes to admins', () => {
  const db = openDb(':memory:');
  const alice = person(db, 'alice');
  const root = person(db, 'root', 'admin');
  const entries = [1, 2, 3, 4, 5].map((id) => ({ id, text: `Number ${id}.`, ...(id === 2 && { admin: true }) }));
  const news = createNews({ db, has: () => EVERYTHING, entries });
  assert.equal(MAX_NEWS, 3);
  assert.deepEqual(ids(news, alice), [1, 3, 4]);
  assert.deepEqual(ids(news, root), [1, 2, 3]);

  // The rest come with the next message.
  news.heard(alice, [1, 3, 4]);
  assert.deepEqual(ids(news, alice), [5]);
  news.heard(root, [1, 2, 3]);
  assert.deepEqual(ids(news, root), [4, 5]);

  // An entry that has since been taken out of the list is passed over.
  const shorter = createNews({ db, has: () => EVERYTHING, entries: entries.slice(0, 4) });
  assert.deepEqual([ids(shorter, alice), ids(shorter, root)], [[], [4]]);
});

test('PiRick’s own list is numbered in order and says only what this PiRick has', () => {
  assert.deepEqual(NEWS.map((entry) => entry.id), NEWS.map((entry, i) => i + 1));

  const told = (has) => {
    const db = openDb(':memory:');
    const alice = person(db, 'alice');
    return texts(createNews({ db, has: () => has }), alice);
  };
  assert.deepEqual(told(EVERYTHING), [
    'PiRick has themes and personalities to choose from. Open Account to pick a theme, light or dark, and a personality.',
    'PiRick can answer questions about films, shows and the people in them. Ask what something is about, who is in it, whether it is out yet, what an actor has been in, or for ideas of what to watch.',
    'PiRick now sees that Plex takes what it fetches for the right film or show. When Plex takes something for another of the same name, or does not recognise it, PiRick tells Plex which it is and leaves you a note.',
  ]);
  // How to switch that off is for whoever can.
  const db = openDb(':memory:');
  const root = person(db, 'root', 'admin');
  const forAdmin = createNews({ db, has: () => EVERYTHING });
  forAdmin.heard(root, [1, 2, 3]);
  assert.deepEqual(texts(forAdmin, root), ['PiRick now corrects a wrong match in Plex by itself, for films and shows it has just added and for nothing that was in Plex before. To switch that off, open Admin, then Upkeep.']);
  // Without Plex, or with the correcting switched off, there is nothing to tell of it.
  assert.equal(told({ catalogue: true, personalities: true, matches: false }).length, 2);
  // No catalogue, and an admin who has removed every personality: neither is offered.
  assert.deepEqual(told({ catalogue: false, personalities: false }), ['PiRick has themes to choose from. Open Account to pick a theme, and light or dark.']);

  // Each is one plain line that can stand alone in the chat.
  for (const has of [EVERYTHING, { catalogue: true, personalities: false }]) {
    for (const text of [...told(has), ...texts(forAdmin, root)]) assert.match(text, /^PiRick [^\n]{20,280}\.$/);
  }
});

/** A world whose model says `reply` to whatever it is asked, or fails with it, and a record of what it was asked. */
function returning(setup, reply) {
  const asked = [];
  const world = createWorld(setup, () => ({
    async chat({ messages, tools, onDelta }) {
      asked.push(structuredClone({ messages, tools }));
      if (reply instanceof Error) throw reply;
      onDelta?.(reply);
      return { role: 'assistant', content: reply };
    },
  }));
  return { world, asked };
}

test('someone who comes back after an update is told what is new: plain lines, then PiRick’s voice', async () => {
  const setup = { news: ['PiRick has themes.', 'PiRick answers questions.'], personality: 'You are a cheerful pirate captain.' };
  const { world, asked } = returning(setup, 'Ahoy! I have themes now, and I answer questions.');
  try {
    const back = await world.comeBack();
    assert.deepEqual(back.statuses, ['New: PiRick has themes.', 'New: PiRick answers questions.']);
    assert.equal(back.reply, 'Ahoy! I have themes now, and I answer questions.');

    const [{ messages, tools }] = asked;
    assert.equal(tools, undefined, 'the summary cannot do anything, only speak');
    assert.match(messages[0].content, /alice has just come back\. While they were away you were updated, and the list you are given says exactly what is new\./);
    assert.match(messages[0].content, /Do not add features, steps, examples, promises or anything else that is not in it\./);
    // Two sentences for each new thing, a greeting and a goodbye.
    assert.match(messages[0].content, /- Plain text, six sentences at most, no headings\./);
    assert.match(messages[0].content, /You are a cheerful pirate captain\./);
    assert.equal(messages[1].content, 'New in PiRick:\n- PiRick has themes.\n- PiRick answers questions.');

    // It is said once.
    const again = await world.comeBack();
    assert.deepEqual([again.statuses, again.reply, asked.length], [[], '', 1]);
    // And it is not replayed to the model as something it said.
    await world.say('Can you get Sintel?');
    assert.equal(JSON.stringify(asked.at(-1).messages).includes('themes'), false);
  } finally {
    world.close();
  }
});

test('download notes and news come in one message, each under its own heading', async () => {
  const { world, asked } = returning({ notes: ['“Sintel” has finished downloading.'], news: ['PiRick has themes.'] }, 'Welcome back!');
  try {
    const back = await world.comeBack();
    assert.deepEqual(back.statuses, ['“Sintel” has finished downloading.', 'New: PiRick has themes.']);
    const [{ messages }] = asked;
    assert.match(messages[0].content, /you checked on their downloads and you were updated\./);
    assert.match(messages[0].content, /Mention every item in the notes by name[^\n]+\n- Then tell them every new thing in the list and how to use it\./);
    // A sentence for the one download, two for the one new thing, and a greeting and a goodbye.
    assert.match(messages[0].content, /- Plain text, five sentences at most, no headings\./);
    assert.equal(messages[1].content, 'Notes:\n- “Sintel” has finished downloading.\n\nNew in PiRick:\n- PiRick has themes.');
    assert.deepEqual((await world.comeBack()).statuses, []);
  } finally {
    world.close();
  }
});

test('with nothing new, the model is asked what it always was', async () => {
  const { world, asked } = returning({ notes: ['“Sintel” has finished downloading.'] }, 'Welcome back!');
  try {
    await world.comeBack();
    const [{ messages }] = asked;
    assert.equal(
      messages[0].content,
      `You are PiRick, an assistant that looks after downloads for a home Plex server. alice has just come back. While they were away you checked on their downloads, and the notes you are given say exactly what happened.

Write them a short welcome-back message that tells them what happened.
- Mention every item in the notes by name and say plainly what happened to it.
- Use only what the notes say. Do not add downloads, progress, promises or anything else that is not in them.
- Plain text, five sentences at most, no headings.
- Be warm and friendly.`,
    );
    assert.equal(messages[1].content, 'Notes:\n- “Sintel” has finished downloading.');
  } finally {
    world.close();
  }
});

test('when the model cannot be asked, the plain lines are still shown and count as told', async () => {
  const { world } = returning({ news: ['PiRick has themes.'] }, new Error('Ollama is away'));
  try {
    const back = await world.comeBack();
    assert.deepEqual(back.statuses, ['New: PiRick has themes.']);
    assert.equal(back.reply, 'Welcome back! I have something new for you; the notes above say what.');
    assert.equal(back.error, undefined);
    assert.deepEqual((await world.comeBack()).statuses, []);
  } finally {
    world.close();
  }

  const both = returning({ notes: ['“Sintel” has finished downloading.'], news: ['PiRick has themes.'] }, new Error('Ollama is away'));
  try {
    assert.equal((await both.world.comeBack()).reply, 'Welcome back! I looked after your downloads while you were away, and I have something new for you; the notes above say what.');
  } finally {
    both.world.close();
  }
});
