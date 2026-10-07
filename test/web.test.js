import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { THEMES } from '../src/themes.js';

const WEB = new URL('../web/', import.meta.url);
const read = (file) => readFileSync(new URL(file, WEB), 'utf8').replace(/\r\n/g, '\n');
const PAGES = ['index.html', 'login.html'];

const sceneOf = (html) => /<div class="scene"[\s\S]*?\n {2}<\/div>/.exec(html)?.[0];

// There is no build step, so the scene is written out in each page.
test('both pages show the same scene', () => {
  const [index, login] = PAGES.map((page) => sceneOf(read(page)));
  assert.ok(index, 'index.html has a scene');
  assert.equal(login, index);
});

// The security header only allows styles from style.css; anything inline is silently dropped.
test('no page or image carries inline styles', () => {
  for (const file of [...PAGES, 'static/icon.svg']) {
    assert.doesNotMatch(read(file), /<style|\sstyle=/i, file);
  }
});

// Moving and fading are the two things a browser can animate without redrawing
// the page every frame, which is what keeps an open tab from eating the CPU.
test('animations only move or fade things, and none are run from script', () => {
  const css = read('static/style.css');
  const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];
  assert.ok(keyframes.length > 0, 'style.css has keyframes');
  for (const [, name, steps] of keyframes) {
    const properties = [...steps.matchAll(/[{;]\s*([\w-]+)\s*:/g)].map((match) => match[1]);
    assert.ok(properties.length > 0, `${name} sets something`);
    for (const property of properties) {
      // A keyframe may also say how to ease into the next one.
      assert.ok(['transform', 'opacity', 'animation-timing-function'].includes(property), `@keyframes ${name} animates ${property}`);
    }
  }
  assert.equal(keyframes.length, css.match(/@keyframes/g).length, 'every @keyframes block was checked');

  for (const page of PAGES) assert.doesNotMatch(read(page), /<animate|<set\s/i, page);
  for (const script of readdirSync(new URL('static/', WEB)).filter((file) => file.endsWith('.js'))) {
    assert.doesNotMatch(read(`static/${script}`), /requestAnimationFrame|\.animate\(/, script);
  }
});

// ---- Themes ----------------------------------------------------------------------

/** The custom properties a rule sets, for the rule with exactly this selector. */
function properties(css, selector, indent = '') {
  const start = css.indexOf(`\n${indent}${selector} {\n`);
  assert.ok(start >= 0, `style.css has a rule for ${selector}`);
  const body = css.slice(start, css.indexOf(`\n${indent}}`, start));
  return Object.fromEntries([...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [name, value.trim()]));
}

/** Every colour set there is: each theme in light and in dark, as the stylesheet layers them. */
function palettes(css) {
  const sea = properties(css, ':root');
  const sets = {};
  for (const { id } of THEMES) {
    const light = id === 'sea' ? sea : { ...sea, ...properties(css, `:root[data-theme="${id}"]`) };
    sets[`${id}, light`] = light;
    sets[`${id}, dark`] = { ...light, ...properties(css, `:root[data-theme="${id}"][data-mode="dark"]`) };
  }
  return sets;
}

test('the themes people are offered are the themes the stylesheet has', () => {
  const css = read('static/style.css');
  const styled = new Set([...css.matchAll(/data-theme="([a-z-]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...styled].sort(), THEMES.map((theme) => theme.id).sort());

  // A theme with a picture has it on both pages, and a rule that shows it when chosen.
  const sets = [...read('index.html').matchAll(/<div class="set ([a-z-]+)">/g)].map((match) => match[1]);
  assert.ok(sets.includes('sea'));
  for (const id of sets) {
    assert.ok(styled.has(id), `the "${id}" picture belongs to a theme`);
    assert.ok(css.includes(`:root[data-theme="${id}"] .set.${id}`), `the "${id}" picture is shown when its theme is chosen`);
  }
});

// A picture's container carries the theme's name as a class. If a piece of a
// picture were styled under that same class, the container would take on the
// piece's size and place, and cut off everything outside it.
test('a theme’s name is not also the name of a piece of a picture', () => {
  const css = read('static/style.css');
  const page = read('index.html');
  for (const id of [...page.matchAll(/<div class="set ([a-z-]+)">/g)].map((match) => match[1])) {
    assert.doesNotMatch(css, new RegExp(`(?:^|[\\s,])\\.${id}\\s*[{,]`, 'm'), `style.css has a rule for .${id} by itself`);
    assert.equal(page.match(new RegExp(`class="[^"]*(?<![\\w-])${id}(?![\\w-])[^"]*"`, 'g')).length, 1, `only the container has the class "${id}"`);
  }
});

// A page whose script has not run can only follow the device, so the sea's night
// colours are written out a second time for it.
test('the sea at night has the same colours however it was arrived at', () => {
  const css = read('static/style.css');
  assert.deepEqual(properties(css, ':root:not([data-mode])', '  '), properties(css, ':root[data-theme="sea"][data-mode="dark"]'));
});

test('the look is applied before the page is drawn, on both pages', () => {
  for (const page of PAGES) {
    const head = /<head>[\s\S]*<\/head>/.exec(read(page))[0];
    // A plain script, not a module, placed after the stylesheet it reads from.
    assert.match(head, /<link rel="stylesheet" href="\/static\/style\.css">\s*<script src="\/static\/theme\.js"><\/script>/, page);
  }
});

// WCAG's measure of how far apart two colours are, from 1 (the same) to 21 (black on white).
function contrast(a, b) {
  const luminance = (hex) => {
    const [red, green, blue] = hex.slice(1).match(/../g).map((pair) => {
      const channel = parseInt(pair, 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

test('text can be read against what is behind it, in every theme, light and dark', () => {
  // What is written, and what it is written on.
  const PAIRS = [
    ['--text', '--surface'],
    ['--text', '--surface-2'],
    ['--text', '--bg'],
    ['--text', '--chrome'],
    ['--muted', '--surface'],
    ['--muted', '--surface-2'],
    ['--on-accent', '--accent'],
    ['--on-bubble', '--bubble'],
    ['--danger', '--surface'],
    ['--good', '--surface'],
    ['--accent', '--surface'],
  ];
  for (const [name, palette] of Object.entries(palettes(read('static/style.css')))) {
    const colour = (property) => {
      let value = palette[property];
      while (value?.startsWith('var(')) value = palette[/var\((--[\w-]+)\)/.exec(value)[1]];
      assert.match(value ?? '', /^#[0-9a-f]{6}$/i, `${name}: ${property} is a plain colour`);
      return value;
    };
    for (const [text, behind] of PAIRS) {
      const ratio = contrast(colour(text), colour(behind));
      // 4.5 is what WCAG asks of ordinary text.
      assert.ok(ratio >= 4.5, `${name}: ${text} on ${behind} is ${ratio.toFixed(1)}, below 4.5`);
    }
  }
});
