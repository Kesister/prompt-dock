const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AUTHOR_LINKS, resolveAuthorLink, authorInfo } = require('../author-links');

test('author destinations are fixed HTTPS links; arbitrary URLs and prototype keys are rejected', () => {
  assert.equal(resolveAuthorLink('github'), 'https://github.com/Kesister');
  assert.equal(resolveAuthorLink('feedback'), 'https://kersss.notion.site/5cc968f36d944b1ab59abe70202e5147?source=copy_link');
  for (const id of [null, undefined, '', {}, [], '__proto__', 'constructor', 'toString', 'file:///C:/test', 'javascript:alert(1)', 'https://example.com']) {
    assert.equal(resolveAuthorLink(id), null);
  }
  assert.ok(Object.isFrozen(AUTHOR_LINKS));
});

test('feedback info contains only app version and OS details', () => {
  const info = authorInfo('0.11.0-beta.8', 'win32', '10.0.26200', 'x64');
  assert.equal(info.feedbackInfo, 'Prompt Dock v0.11.0-beta.8\n系统：Windows 10.0.26200 (x64)');
  assert.deepEqual(Object.keys(info).sort(), ['feedbackInfo', 'links', 'version']);
  assert.match(authorInfo('1', 'darwin', '24.0', 'arm64').feedbackInfo, /macOS 24.0 \(arm64\)/);
});

test('QR no longer exists in the page and is excluded from new distributions', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(!html.includes('author-wechat-qr') && !html.includes('authorQrDialog'));
  const build = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build;
  assert.ok(build.files.includes('!assets/author-wechat-qr.jpg'));
  assert.ok(build.files.includes('author-links.js'));
});

test('author title retains its rounded frame and Notion uses the official filled mark', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /class="author-title">Prompt Dock 作者<\/span>/);
  assert.ok(!html.includes('独立创作者'));
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const titleRule = css.match(/\.author-title\s*\{[^}]*\}/)?.[0];
  assert.match(titleRule, /border:\s*1px solid #e7c7b3/);
  assert.match(titleRule, /border-radius:\s*6px/);
  const mark = html.match(/<symbol id="icon-notion"[\s\S]*?<\/symbol>/)?.[0];
  assert.ok(mark);
  assert.match(mark, /viewBox="0 0 33 34"/);
  assert.equal((mark.match(/<path /g) || []).length, 3);
  assert.match(mark, /M20\.5301 2\.04318C22\.5838/);
  assert.match(mark, /fill="#000"/);
  assert.ok(!/script|onload|href=|url\(/i.test(mark));
});
