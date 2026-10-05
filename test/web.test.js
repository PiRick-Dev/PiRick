import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const WEB = new URL('../web/', import.meta.url);
const read = (file) => readFileSync(new URL(file, WEB), 'utf8');
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
