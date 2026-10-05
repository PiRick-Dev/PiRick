const $ = (selector, root = document) => root.querySelector(selector);

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child != null && child !== false));
  return node;
}

// The custom header is what the server's cross-site request guard looks for.
const HEADERS = { 'X-PiRick': '1' };
const OFFLINE = "Can't reach PiRick. Check your connection and try again.";

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(OFFLINE);
  }
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('Please sign in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

function showNote(node, text, bad) {
  node.textContent = text;
  node.className = `form-note ${bad ? 'bad' : 'good'}`;
  node.hidden = false;
}

let me = null;

// ---- Chat -----------------------------------------------------------------

const chat = $('#chat');
const messages = $('#messages');
const working = $('#working');
const composer = $('#composer');
const input = $('#input');
const sendButton = $('#send');
const STATUS_KINDS = ['search', 'download', 'error'];
let busy = false;

// Model output is only ever inserted as text nodes; **bold** is the one bit of
// formatting that is honoured.
function renderText(node, text) {
  const parts = text.split(/\*\*([^*\n]+)\*\*/g);
  node.replaceChildren(...parts.map((part, i) => (i % 2 ? h('strong', {}, part) : part)));
}

function addBubble(type, text) {
  const node = h('div', { class: `bubble ${type}` });
  renderText(node, text);
  messages.append(node);
  return node;
}

function addStatus(text, kind) {
  messages.append(h('div', { class: `status ${STATUS_KINDS.includes(kind) ? kind : ''}` }, text));
}

function setWorking(text) {
  working.hidden = !text;
  if (text) $('#working-text').textContent = text;
}

function refreshWelcome() {
  $('#welcome').hidden = messages.childElementCount > 0;
}

const nearEnd = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 140;
const scrollToEnd = () => {
  chat.scrollTop = chat.scrollHeight;
};

const MAX_INPUT_HEIGHT = 160;

function resizeInput() {
  input.style.height = 'auto';
  // scrollHeight leaves out the border, which border-box sizing needs included.
  const height = input.scrollHeight + input.offsetHeight - input.clientHeight;
  input.style.height = `${Math.min(height, MAX_INPUT_HEIGHT)}px`;
  input.style.overflowY = height > MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
}

async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

/**
 * Posts to a streaming endpoint and shows what comes back as it arrives.
 * `quiet` is for work nobody asked for: nothing is shown unless there is news.
 */
async function runStream(url, body, { quiet = false } = {}) {
  busy = true;
  sendButton.disabled = true;
  let bubble = null;
  let reply = '';
  let finished = false;
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(OFFLINE);
    }
    if (res.status === 401) {
      location.replace('/login');
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Something went wrong. Please try again.');
    }

    for await (const event of readEvents(res.body)) {
      const stick = nearEnd();
      if (event.type === 'delta') {
        if (!bubble) {
          bubble = addBubble('assistant', '');
          reply = '';
        }
        reply += event.text;
        renderText(bubble, reply);
        setWorking(null);
      } else if (event.type === 'working') {
        // Text after a tool step starts a fresh bubble, matching how history reloads.
        bubble = null;
        setWorking(event.text);
      } else if (event.type === 'status') {
        bubble = null;
        addStatus(event.text, event.kind);
        refreshWelcome();
      } else if (event.type === 'error') {
        addStatus(event.message, 'error');
        finished = true;
      } else if (event.type === 'done') {
        finished = true;
      }
      if (stick) scrollToEnd();
    }
    if (!finished) throw new Error('The connection dropped before PiRick finished. Check Downloads to see what was started.');
  } catch (err) {
    if (!quiet) addStatus(err.message, 'error');
  } finally {
    busy = false;
    sendButton.disabled = false;
    setWorking(null);
    if (!quiet) scrollToEnd();
  }
}

async function send(text) {
  addBubble('user', text);
  refreshWelcome();
  setWorking('Thinking…');
  scrollToEnd();
  await runStream('/api/chat', { message: text });
  // On phones, focusing would pop the keyboard back up over the reply.
  if (!matchMedia('(pointer: coarse)').matches) input.focus();
}

// When someone comes back, PiRick says what it did to their downloads meanwhile.
const CATCH_UP_EVERY_MS = 5 * 60 * 1000;
let lastCatchUp = 0;
async function catchUp() {
  if (busy || Date.now() - lastCatchUp < CATCH_UP_EVERY_MS) return;
  lastCatchUp = Date.now();
  await runStream('/api/chat/catch-up', {}, { quiet: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') catchUp();
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  resizeInput();
  send(text);
});

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

for (const button of document.querySelectorAll('[data-fill]')) {
  button.addEventListener('click', () => {
    input.value = button.dataset.fill;
    resizeInput();
    input.focus();
  });
}

$('#btn-new').addEventListener('click', async () => {
  try {
    await api('/api/chat', { method: 'DELETE' });
    messages.replaceChildren();
    refreshWelcome();
  } catch (err) {
    addStatus(err.message, 'error');
  }
});

// ---- Dialogs --------------------------------------------------------------

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    // A click on the dialog element itself is a click on the backdrop.
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
  });
}

// ---- Downloads ------------------------------------------------------------

const downloadsDialog = $('#dlg-downloads');
const STATUS_LABELS = {
  finished: 'Finished, ready in Plex',
  downloading: 'Downloading',
  waiting: 'Waiting for a connection',
  starting: 'Getting started',
  queued: 'Waiting its turn',
  paused: 'Paused',
  checking: 'Checking the files',
  error: 'Something went wrong, ask the admin',
  stuck: 'Stuck: looking for another copy',
  unknown: 'Working on it',
};
let downloadsTimer = null;

function timeLeft(seconds) {
  if (seconds < 90) return 'about a minute left';
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes left`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `about ${hours} hour${hours === 1 ? '' : 's'} left`;
  return `about ${Math.round(hours / 24)} days left`;
}

function downloadRow(item, everyone) {
  const status = item.status in STATUS_LABELS ? item.status : 'unknown';
  const details = [STATUS_LABELS[status]];
  if (status !== 'finished') details.push(`${item.progress}%`);
  details.push(item.size);
  if (item.etaSeconds != null) details.push(timeLeft(item.etaSeconds));
  if (everyone && item.requestedBy.length) details.push(`for ${item.requestedBy.join(', ')}`);
  return h(
    'li',
    { class: `download ${status}` },
    h('div', { class: 'dl-name' }, item.name),
    h('progress', { max: 100, value: item.progress }),
    h('div', { class: 'dl-meta' }, details.join(' · ')),
  );
}

async function loadDownloads() {
  const everyone = $('#dl-all').checked;
  const error = $('#dl-error');
  try {
    const { downloads } = await api(`/api/downloads${everyone ? '?all=1' : ''}`);
    error.hidden = true;
    $('#dl-empty').hidden = downloads.length > 0;
    $('#dl-list').replaceChildren(...downloads.map((item) => downloadRow(item, everyone)));
  } catch (err) {
    $('#dl-empty').hidden = true;
    showNote(error, err.message, true);
  }
}

$('#btn-downloads').addEventListener('click', () => {
  downloadsDialog.showModal();
  loadDownloads();
  downloadsTimer = setInterval(loadDownloads, 5000);
});
downloadsDialog.addEventListener('close', () => clearInterval(downloadsTimer));
$('#dl-all').addEventListener('change', loadDownloads);

// ---- Account --------------------------------------------------------------

$('#btn-account').addEventListener('click', () => {
  $('#password-form').reset();
  $('#password-note').hidden = true;
  $('#dlg-account').showModal();
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const note = $('#password-note');
  try {
    await api('/api/password', {
      method: 'POST',
      body: { currentPassword: form.currentPassword.value, newPassword: form.newPassword.value },
    });
    form.reset();
    showNote(note, 'Password updated. Other devices have been signed out.', false);
  } catch (err) {
    showNote(note, err.message, true);
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login');
});

// ---- Admin ----------------------------------------------------------------

const adminDialog = $('#dlg-admin');
const TAB_LOADERS = {
  connections: () => loadStatus(),
  libraries: () => loadLibraries(),
  personality: () => loadPersonality(),
  upkeep: () => loadUpkeep(),
  people: () => loadUsers(),
};

function showTab(name) {
  for (const button of adminDialog.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
  }
  for (const panel of adminDialog.querySelectorAll('[role="tabpanel"]')) panel.hidden = panel.id !== `tab-${name}`;
  TAB_LOADERS[name]();
}

function openAdmin(tab) {
  for (const note of adminDialog.querySelectorAll('.form-note[role="status"]')) note.hidden = true;
  adminDialog.showModal();
  showTab(tab);
}

async function refreshSetupNotice() {
  if (me.role !== 'admin') return;
  try {
    me = await api('/api/me');
  } catch {
    return;
  }
  $('#setup-notice').hidden = !me.setupNeeded;
}

for (const button of adminDialog.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => showTab(button.dataset.tab));
}
$('#btn-admin').addEventListener('click', () => openAdmin('connections'));
$('#btn-setup').addEventListener('click', () => openAdmin('libraries'));
adminDialog.addEventListener('close', refreshSetupNotice);

// Connections

const SERVICES = [
  ['ollama', 'Ollama (the AI)'],
  ['jackett', 'Jackett (search)'],
  ['qbittorrent', 'qBittorrent (downloads)'],
];

async function loadStatus() {
  const list = $('#status-list');
  list.replaceChildren(h('li', {}, 'Checking…'));
  try {
    const status = await api('/api/admin/status');
    list.replaceChildren(
      ...SERVICES.map(([key, label]) =>
        h('li', { class: status[key].ok ? 'ok' : 'bad' }, h('strong', {}, label), h('span', {}, status[key].detail)),
      ),
    );
  } catch (err) {
    list.replaceChildren(h('li', { class: 'bad' }, err.message));
  }
}
$('#btn-recheck').addEventListener('click', loadStatus);

// Libraries

const libraryForm = $('#library-form');
const libraryNote = $('#library-note');
let editingLibrary = null;

// What to say about a library's folder, and whether it is good news.
function folderStatus(folder) {
  switch (folder.status) {
    case 'ok':
      return { tone: 'ok', text: 'Folder found' };
    case 'wrong-case':
      return { tone: 'bad', text: `Folder not found. Did you mean ${folder.suggestion}? Downloads here are refused until this is fixed.` };
    case 'missing':
      return { tone: 'bad', text: 'Folder not found. Downloads here are refused until the folder exists or the path is corrected.' };
    default:
      return { tone: '', text: 'Could not check this folder with qBittorrent.' };
  }
}

const libraryFields = (source) => ({
  name: source.name,
  description: source.description,
  savePath: source.savePath,
  perTitle: source.perTitle,
  category: source.category,
});

function saveLibrary(fields, id) {
  return api(id ? `/api/admin/libraries/${id}` : '/api/admin/libraries', { method: id ? 'PUT' : 'POST', body: fields });
}

function resetLibraryForm() {
  editingLibrary = null;
  libraryForm.reset();
  $('#library-form-title').textContent = 'Add a library';
  $('#library-submit').textContent = 'Add library';
  $('#library-cancel').hidden = true;
}

function editLibrary(library) {
  editingLibrary = library;
  libraryForm.elements.name.value = library.name;
  libraryForm.elements.description.value = library.description;
  libraryForm.elements.savePath.value = library.savePath;
  libraryForm.elements.perTitle.checked = library.perTitle;
  libraryForm.elements.category.value = library.category;
  $('#library-form-title').textContent = `Edit ${library.name}`;
  $('#library-submit').textContent = 'Save changes';
  $('#library-cancel').hidden = false;
  libraryNote.hidden = true;
  libraryForm.scrollIntoView({ block: 'nearest' });
  libraryForm.elements.name.focus();
}

function libraryRow(library) {
  const status = folderStatus(library.folder);
  const actions = h('div', { class: 'row-actions' });
  if (library.folder.status === 'wrong-case') {
    const useSuggestion = async () => {
      try {
        await saveLibrary({ ...libraryFields(library), savePath: library.folder.suggestion }, library.id);
        showNote(libraryNote, `${library.name} now saves to ${library.folder.suggestion}.`, false);
        await loadLibraries();
      } catch (err) {
        showNote(libraryNote, err.message, true);
      }
    };
    actions.append(h('button', { type: 'button', class: 'primary', onclick: useSuggestion }, `Use ${library.folder.suggestion}`));
  }
  const remove = async () => {
    if (!confirm(`Remove the ${library.name} library? Nothing already downloaded is deleted.`)) return;
    try {
      await api(`/api/admin/libraries/${library.id}`, { method: 'DELETE' });
      if (editingLibrary?.id === library.id) resetLibraryForm();
      await loadLibraries();
    } catch (err) {
      showNote(libraryNote, err.message, true);
    }
  };
  actions.append(
    h('button', { type: 'button', onclick: () => editLibrary(library) }, 'Edit'),
    h('button', { type: 'button', class: 'danger', onclick: remove }, 'Remove'),
  );

  const details = [];
  if (library.perTitle) details.push('one subfolder per show');
  if (library.category) details.push(`category “${library.category}”`);
  return h(
    'li',
    { class: 'library' },
    h('div', { class: 'library-head' }, h('strong', {}, library.name), library.description && h('span', { class: 'muted' }, library.description)),
    h('code', {}, library.savePath),
    details.length > 0 && h('div', { class: 'muted small' }, details.join(' · ')),
    h('div', { class: `folder-status ${status.tone}` }, status.text),
    actions,
  );
}

async function loadLibraries() {
  try {
    const { libraries } = await api('/api/admin/libraries');
    $('#library-empty').hidden = libraries.length > 0;
    $('#library-list').replaceChildren(...libraries.map(libraryRow));
    // The notice on the chat page depends on whether any library exists.
    $('#setup-notice').hidden = libraries.length > 0;
  } catch (err) {
    showNote(libraryNote, err.message, true);
  }
}

libraryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = {
    name: libraryForm.elements.name.value,
    description: libraryForm.elements.description.value,
    savePath: libraryForm.elements.savePath.value,
    perTitle: libraryForm.elements.perTitle.checked,
    category: libraryForm.elements.category.value,
  };
  try {
    const { library } = await saveLibrary(fields, editingLibrary?.id);
    resetLibraryForm();
    const status = folderStatus(library.folder);
    // A saved library with a bad folder is worth a warning, not a quiet success.
    const bad = status.tone === 'bad';
    showNote(libraryNote, bad ? `${library.name} was saved, but: ${status.text}` : `${library.name} was saved.`, bad);
    await loadLibraries();
  } catch (err) {
    showNote(libraryNote, err.message, true);
  }
});
$('#library-cancel').addEventListener('click', resetLibraryForm);

// Folder suggestions: the real folders around whatever has been typed so far.
let folderTimer = null;
async function suggestFolders() {
  try {
    const { folders } = await api(`/api/admin/folders?path=${encodeURIComponent(libraryForm.elements.savePath.value)}`);
    $('#folder-options').replaceChildren(...folders.map((folder) => h('option', { value: folder })));
  } catch {
    // Suggestions are a convenience; typing a path by hand still works.
  }
}
libraryForm.elements.savePath.addEventListener('focus', suggestFolders);
libraryForm.elements.savePath.addEventListener('input', () => {
  clearTimeout(folderTimer);
  folderTimer = setTimeout(suggestFolders, 250);
});

// Personality

const personalityForm = $('#personality-form');
const personalityBox = personalityForm.elements.personality;
const PERSONALITY_PRESETS = {
  pirate: 'You are a cheerful pirate captain. You call the user "matey", talk of treasure and the high seas, and say "Arr" now and then.',
  butler: 'You are an impeccably polite English butler. You are discreet and unflappable, call the user "sir or madam", and take quiet pride in good service.',
  clerk: 'You are a grumpy but lovable video-store clerk from the 1990s. You grumble, you have strong opinions about films, and you help anyway.',
  buff: 'You are an over-excited film buff. Whatever the user asks for is a brilliant choice, and you cannot resist adding one short fun fact about it.',
};

async function loadPersonality() {
  try {
    const { personality, max } = await api('/api/admin/personality');
    personalityBox.value = personality;
    personalityBox.maxLength = max;
  } catch (err) {
    showNote($('#personality-note'), err.message, true);
  }
}

for (const button of personalityForm.querySelectorAll('[data-preset]')) {
  button.addEventListener('click', () => {
    personalityBox.value = PERSONALITY_PRESETS[button.dataset.preset];
    showNote($('#personality-note'), 'Edit it if you like, then save.', false);
  });
}

personalityForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const note = $('#personality-note');
  try {
    const { personality } = await api('/api/admin/personality', { method: 'PUT', body: { personality: personalityBox.value } });
    personalityBox.value = personality;
    showNote(note, personality ? 'Saved. PiRick will sound like this from the next message.' : 'Saved. PiRick is back to its friendly default.', false);
  } catch (err) {
    showNote(note, err.message, true);
  }
});

// Upkeep

const upkeepForm = $('#upkeep-form');
const upkeepNote = $('#upkeep-note');
const UPKEEP_TONES = { replaced: 'ok', 'gave-up': 'bad', problem: 'bad' };

function showUpkeep(state) {
  upkeepForm.elements.enabled.checked = state.enabled;
  upkeepForm.elements.stuckHours.value = state.stuckHours;
  const watching = state.watching === 1 ? '1 unfinished download' : `${state.watching} unfinished downloads`;
  $('#upkeep-summary').textContent = `Watching ${watching}; ${state.stuck} stuck right now.`;
  $('#upkeep-empty').hidden = state.log.length > 0;
  $('#upkeep-log').replaceChildren(
    ...state.log.map((entry) =>
      h(
        'li',
        { class: UPKEEP_TONES[entry.action] ?? '' },
        h('span', {}, entry.detail),
        h('span', { class: 'muted small' }, `${new Date(entry.at).toLocaleString()}${entry.username ? ` · for ${entry.username}` : ''}`),
      ),
    ),
  );
}

async function loadUpkeep() {
  try {
    showUpkeep(await api('/api/admin/upkeep'));
  } catch (err) {
    showNote(upkeepNote, err.message, true);
  }
}

upkeepForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const body = { enabled: upkeepForm.elements.enabled.checked, stuckHours: Number(upkeepForm.elements.stuckHours.value) };
    showUpkeep(await api('/api/admin/upkeep', { method: 'PUT', body }));
    showNote(upkeepNote, 'Saved.', false);
  } catch (err) {
    showNote(upkeepNote, err.message, true);
  }
});

$('#upkeep-run').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  showNote(upkeepNote, 'Checking…', false);
  try {
    const state = await api('/api/admin/upkeep/run', { method: 'POST' });
    showUpkeep(state);
    const { result } = state;
    const message = result.skipped
      ? 'A check is already running.'
      : `Checked: ${result.stuck} stuck, ${result.replaced} replaced${result.stuck > result.replaced ? '. The rest are explained below.' : '.'}`;
    showNote(upkeepNote, message, false);
  } catch (err) {
    showNote(upkeepNote, err.message, true);
  } finally {
    button.disabled = false;
  }
});

// People

function userRow(user) {
  const note = $('#user-note');
  const actions = h('div', { class: 'row-actions' });

  function showButtons() {
    const buttons = [h('button', { type: 'button', onclick: showReset }, 'Reset password')];
    // You cannot remove yourself, so the button is not offered on your own row.
    if (user.id !== me.id) buttons.push(h('button', { type: 'button', class: 'danger', onclick: remove }, 'Remove'));
    actions.replaceChildren(...buttons);
  }

  function showReset() {
    const password = h('input', {
      type: 'password',
      placeholder: 'New password',
      autocomplete: 'new-password',
      'aria-label': `New password for ${user.username}`,
    });
    const save = async () => {
      try {
        await api(`/api/admin/users/${user.id}/password`, { method: 'POST', body: { password: password.value } });
        showNote(note, `Password changed for ${user.username}.`, false);
        showButtons();
      } catch (err) {
        showNote(note, err.message, true);
      }
    };
    actions.replaceChildren(
      password,
      h('button', { type: 'button', class: 'primary', onclick: save }, 'Save'),
      h('button', { type: 'button', onclick: showButtons }, 'Cancel'),
    );
    password.focus();
  }

  async function remove() {
    if (!confirm(`Remove ${user.username}? They will no longer be able to sign in.`)) return;
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      showNote(note, `${user.username} was removed.`, false);
      await loadUsers();
    } catch (err) {
      showNote(note, err.message, true);
    }
  }

  showButtons();
  return h(
    'li',
    { class: 'user-row' },
    h('div', {}, h('strong', {}, user.username), h('span', { class: 'role' }, user.role === 'admin' ? 'Admin' : 'Member')),
    actions,
  );
}

async function loadUsers() {
  try {
    const { users } = await api('/api/admin/users');
    $('#user-list').replaceChildren(...users.map(userRow));
  } catch (err) {
    showNote($('#user-note'), err.message, true);
  }
}

$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const note = $('#user-note');
  try {
    const { user } = await api('/api/admin/users', {
      method: 'POST',
      body: { username: form.username.value, password: form.password.value, role: form.role.value },
    });
    form.reset();
    showNote(note, `${user.username} can now sign in.`, false);
    await loadUsers();
  } catch (err) {
    showNote(note, err.message, true);
  }
});

// ---- Start ----------------------------------------------------------------

async function start() {
  me = await api('/api/me');
  $('#me-name').textContent = me.username;
  $('#welcome-title').textContent = `Hi ${me.username}, what would you like to watch?`;
  if (me.role === 'admin') {
    $('#btn-admin').hidden = false;
    $('#dl-all-wrap').hidden = false;
    $('#setup-notice').hidden = !me.setupNeeded;
  }
  const { messages: history } = await api('/api/chat');
  for (const item of history) {
    if (item.type === 'status') addStatus(item.text, item.kind);
    else addBubble(item.type === 'user' ? 'user' : 'assistant', item.text);
  }
  refreshWelcome();
  scrollToEnd();
  await catchUp();
}

start().catch((err) => addStatus(err.message, 'error'));
