const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateController, FEED, releaseDetails } = require('../update-controller');

function setup(options = {}) {
  const updater = new EventEmitter();
  const calls = { check: 0, download: 0, install: 0, backup: 0, quit: 0, cancel: 0 };
  updater.setFeedURL = feed => { calls.feed = feed; };
  updater.checkForUpdates = async () => { calls.check++; updater.emit('update-available', { version: '0.11.2', releaseNotes: '<b>更新说明</b>' }); };
  updater.downloadUpdate = async () => { calls.download++; updater.emit('download-progress', { percent: 56.7 }); updater.emit('update-downloaded', { version: '0.11.2' }); };
  updater.quitAndInstall = (...args) => { calls.install++; calls.installArgs = args; };
  const controller = new UpdateController({ updater, currentVersion: '0.11.1', backup: async () => { calls.backup++; return { ok: true }; },
    prepareQuit: () => { calls.quit++; }, cancelQuit: () => { calls.cancel++; }, ...options });
  return { controller, updater, calls };
}

test('checking never downloads; only explicit actions back up and launch installer', async () => {
  const { controller: c, updater: u, calls } = setup();
  assert.deepEqual(calls.feed, FEED);
  assert.equal(u.autoDownload, false);
  assert.equal(u.autoInstallOnAppQuit, false);
  assert.equal(u.allowPrerelease, false);
  assert.equal(u.allowDowngrade, false);
  await c.check();
  assert.equal(c.snapshot().phase, 'available');
  assert.equal(calls.download, 0);
  await c.download();
  assert.equal(c.snapshot().phase, 'downloaded');
  assert.equal(calls.install, 0);
  assert.equal(calls.backup, 0);
  await c.install();
  assert.equal(calls.backup, 1);
  assert.equal(calls.quit, 1);
  assert.deepEqual(calls.installArgs, [false, true]);
});

test('failed backup blocks quit and installation and can be retried', async () => {
  let attempt = 0;
  const { controller: c, calls } = setup({ backup: async () => { if (++attempt === 1) throw new Error('disk full'); return { ok: true }; } });
  await c.check(); await c.download(); await c.install();
  assert.equal(c.snapshot().retryPhase, 'downloaded');
  assert.match(c.snapshot().message, /备份失败/);
  assert.equal(calls.install, 0);
  assert.equal(calls.quit, 0);
  await c.install();
  assert.equal(attempt, 2);
  assert.equal(calls.install, 1);
});

test('concurrent actions cannot download, back up, or install twice', async () => {
  let release;
  const { controller: c, updater: u, calls } = setup({ backup: () => { calls.backup++; return new Promise(resolve => { release = resolve; }); } });
  await Promise.all([c.check(), c.check()]);
  assert.equal(calls.check, 1);
  await Promise.all([c.download(), c.download()]);
  assert.equal(calls.download, 1);
  const installing = c.install();
  await c.install(); await c.check(); await c.download();
  assert.equal(calls.backup, 1);
  assert.equal(calls.install, 0);
  release({ ok: true }); await installing;
  assert.equal(calls.install, 1);
  u.emit('error', new Error('spawn failed'));
  assert.equal(c.snapshot().retryPhase, 'downloaded');
  assert.equal(calls.cancel, 1);
});

test('network and checksum failures are retryable without offering an unverified install', async () => {
  const { controller: c, updater: u, calls } = setup();
  u.checkForUpdates = async () => { throw new Error('offline'); };
  await c.check(); assert.equal(c.snapshot().phase, 'error');
  await c.install(); assert.equal(calls.install, 0);
  u.checkForUpdates = async () => u.emit('update-available', { version: '0.11.2' });
  await c.check();
  u.downloadUpdate = async () => { u.emit('error', new Error('sha512 mismatch')); throw new Error('sha512 mismatch'); };
  await c.download();
  assert.equal(c.snapshot().retryPhase, 'available');
  await c.install(); assert.equal(calls.install, 0);
  u.downloadUpdate = async () => u.emit('update-downloaded', { version: '0.11.2' });
  await c.download(); assert.equal(c.snapshot().phase, 'downloaded');
});

test('same versions, downgrades, prereleases and non-app tags do not offer updates', async () => {
  for (const version of ['0.11.1', '0.11.0', '0.12.0-beta.1', 'notion-skill-v1', undefined]) {
    const { controller: c, updater: u, calls } = setup();
    u.checkForUpdates = async () => u.emit('update-available', { version });
    await c.check(); await c.download(); await c.install();
    assert.equal(c.snapshot().phase, 'current');
    assert.equal(calls.download + calls.install, 0);
  }
});

test('portable builds can check, but must use a manual download', async () => {
  const { controller: c, calls } = setup({ canInstall: false });
  await c.check(); await c.download(); await c.install();
  assert.equal(c.snapshot().phase, 'available');
  assert.equal(calls.download + calls.install, 0);
});

test('development and smoke tests never make update requests', async () => {
  const { controller: c, calls } = setup({ enabled: false });
  await c.check(); await c.download(); await c.install();
  assert.equal(c.snapshot().phase, 'disabled');
  assert.equal(calls.check + calls.download + calls.install, 0);
});

test('release notes are bounded and preserved as plain data', () => {
  assert.equal(releaseDetails({ releaseNotes: 'x'.repeat(20000) }).notes.length, 16000);
  assert.match(releaseDetails({ releaseNotes: [{ version: '0.11.2', note: '<script>untrusted</script>' }] }).notes, /<script>/);
});
