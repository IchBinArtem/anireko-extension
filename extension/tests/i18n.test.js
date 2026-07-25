const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionRoot = path.join(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(extensionRoot, relative), 'utf8');
}

function messages(locale) {
  return JSON.parse(read(path.join('_locales', locale, 'messages.json')));
}

test('English and Russian locale catalogs are complete and structurally equal', () => {
  const en = messages('en');
  const ru = messages('ru');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  assert.ok(Object.keys(en).length >= 100, 'unexpectedly small locale catalog');

  for (const [locale, catalog] of Object.entries({ en, ru })) {
    for (const [key, entry] of Object.entries(catalog)) {
      assert.equal(typeof entry.message, 'string', `${locale}.${key} has no message`);
      assert.ok(entry.message.trim(), `${locale}.${key} is empty`);
      const placeholderNames = [...entry.message.matchAll(/\$([A-Z][A-Z0-9_]*)\$/gu)]
        .map((match) => match[1].toLowerCase());
      for (const name of placeholderNames) {
        assert.match(entry.placeholders?.[name]?.content || '', /^\$\d+$/u,
          `${locale}.${key} is missing placeholder ${name}`);
      }
    }
  }
});

test('manifest, popup markup, and popup runtime reference catalog messages only', () => {
  const en = messages('en');
  const manifestText = read('manifest.json');
  const popupHtml = read('popup.html');
  const popupJs = read('popup.js');
  const popupRuntime = popupJs
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');

  assert.equal(/[А-Яа-яЁё]/u.test(manifestText), false, 'manifest contains an unlocalized Cyrillic string');
  assert.equal(/[А-Яа-яЁё]/u.test(popupHtml), false, 'popup HTML contains an unlocalized Cyrillic string');
  assert.equal(/[А-Яа-яЁё]/u.test(popupRuntime), false, 'popup runtime contains an unlocalized Cyrillic string');

  const referenced = new Set();
  for (const match of manifestText.matchAll(/__MSG_([A-Za-z0-9_@]+)__/gu)) referenced.add(match[1]);
  for (const match of popupHtml.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_@]+)"/gu)) referenced.add(match[1]);
  for (const match of popupJs.matchAll(/\bt\('([A-Za-z0-9_@]+)'/gu)) referenced.add(match[1]);
  for (const key of referenced) assert.ok(en[key], `missing locale message: ${key}`);

  assert.match(popupJs, /\$\{siteBase\}\/\$\{siteLocale\}\/privacy/u);
  assert.match(popupJs, /\$\{siteBase\}\/\$\{siteLocale\}\/profile/u);
  assert.match(popupJs, /\$\{siteBase\}\/\$\{siteLocale\}\/anime/u);
});
