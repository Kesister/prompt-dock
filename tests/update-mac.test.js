const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const AdmZip = require('adm-zip');
const { macReleaseAsset, latestMacRelease, MacReleaseUpdater, MAC_INSTALL_MESSAGE } = require('../mac-update');
const { UpdateController } = require('../update-controller');
const { NodeHttpExecutor } = require('builder-util/out/nodeHttpExecutor');
const { configureRequestUrl, configureRequestOptions } = require('builder-util-runtime');

test('Mac manual downloads select only a matching stable DMG in the fixed repository', () => {
  const tag_name = 'v0.11.2';
  const asset = name => ({ name, browser_download_url: `https://github.com/Kesister/prompt-dock/releases/download/${tag_name}/${name}` });
  const release = { tag_name, assets: [asset('Prompt-Dock-0.11.2-Setup.exe'), asset('Prompt-Dock-0.11.2-mac-x64.dmg'), asset('Prompt-Dock-0.11.2-mac-arm64.dmg')] };
  assert.match(macReleaseAsset(release, 'arm64', '0.11.1').name, /arm64/);
  for (const bad of [{ ...release, prerelease: true }, { ...release, draft: true }, { ...release, tag_name: 'notion-skill-v1' }, { ...release, assets: [release.assets[0]] }]) {
    assert.equal(macReleaseAsset(bad, 'arm64', '0.11.1'), null);
  }
  assert.equal(macReleaseAsset(release, 'arm64', '0.12.0'), null);
  assert.equal(macReleaseAsset({ ...release, assets: [{ ...release.assets[2], browser_download_url: 'https://example.com/mac.dmg' }] }, 'arm64', '0.11.1'), null);
});

function macRelease(version, extra = {}) {
  const tag_name = `mac-v${version}`;
  const name = `Prompt-Dock-${version}-mac-arm64.pkg`;
  return { tag_name, prerelease: true, body: `Mac ${version}`, assets: [{ name,
    browser_download_url: `https://github.com/Kesister/prompt-dock/releases/download/${tag_name}/${name}` }], ...extra };
}
function response(releases, next = false) {
  return { ok: true, json: async () => releases, headers: new Headers(next ? { link: '<https://api.github.com/next>; rel="next"' } : {}) };
}

test('Mac channel prefers matching PKG and accepts published Mac previews only', () => {
  const release = macRelease('0.11.2');
  const dmg = { name: 'Prompt-Dock-0.11.2-mac-arm64.dmg', browser_download_url: 'https://github.com/Kesister/prompt-dock/releases/download/mac-v0.11.2/Prompt-Dock-0.11.2-mac-arm64.dmg' };
  assert.equal(macReleaseAsset({ ...release, assets: [dmg, ...release.assets] }, 'arm64', '0.11.2'), release.assets[0]);
  assert.equal(macReleaseAsset(release, 'x64', '0.11.1'), null);
  for (const invalid of [
    { ...release, draft: true }, macRelease('0.11.3-beta.1'),
    { ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://example.com/installer.pkg' }] },
    { ...release, tag_name: 'notion-skill-v0.11.2' },
    { ...release, assets: undefined }
  ]) assert.equal(macReleaseAsset(invalid, 'arm64', '0.11.1'), null);
});

test('Mac update discovery paginates and sorts versions independently of Windows and publication order', async () => {
  const pages = [
    [macRelease('0.11.1'), { tag_name: 'v9.0.0', assets: [{ name: 'Prompt-Dock-9.0.0-Setup.exe' }] }, macRelease('0.12.0', { draft: true })],
    [macRelease('0.11.3'), macRelease('0.11.2'), macRelease('1.0.0', { assets: [] })]
  ];
  const urls = [];
  const found = await latestMacRelease(async url => { urls.push(url); return response(pages[urls.length - 1], urls.length === 1); }, 'arm64', '0.11.1');
  assert.equal(found.version, '0.11.3');
  assert.equal(urls.length, 2);
  assert.match(urls[1], /releases\?per_page=100&page=2$/);
  assert.equal(await latestMacRelease(async () => response([macRelease('0.11.1')]), 'arm64', '0.11.2'), null);
});

test('Mac version checks use the shared UI without automatic installation or Windows feed requests', async () => {
  let failed = true, requests = 0, backup = false;
  const updater = new MacReleaseUpdater({ arch: 'arm64', currentVersion: '0.11.1', fetch: async url => {
    requests++;
    assert.match(url, /\/releases\?per_page=/);
    return failed ? { ok: false } : response([macRelease('0.11.2')]);
  } });
  const controller = new UpdateController({ updater, currentVersion: '0.11.1', canInstall: false,
    installMessage: MAC_INSTALL_MESSAGE, backup: async () => { backup = true; } });
  await controller.check(); assert.equal(controller.snapshot().phase, 'error');
  failed = false;
  await controller.check();
  assert.equal(controller.snapshot().phase, 'available');
  assert.equal(controller.snapshot().version, '0.11.2');
  assert.equal(controller.snapshot().notes, 'Mac 0.11.2');
  await controller.download(); await controller.install();
  assert.equal(backup, false); assert.equal(requests, 2);
  assert.equal(controller.snapshot().phase, 'available');
  const current = new UpdateController({ updater: new MacReleaseUpdater({ arch: 'arm64', currentVersion: '0.11.2', fetch: async () => response([macRelease('0.11.2')]) }), currentVersion: '0.11.2', canInstall: false });
  await current.check(); assert.equal(current.snapshot().phase, 'current');
  await assert.rejects(latestMacRelease(async () => response({}), 'arm64', '0.11.2'), /Invalid/);
});

class TestHttpExecutor extends NodeHttpExecutor {
  download(url, destination, options) {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers || undefined, redirect: 'manual' };
      configureRequestUrl(url, requestOptions); configureRequestOptions(requestOptions);
      this.doDownload(requestOptions, { destination, options, onCancel, responseHandler: null, callback: error => error ? reject(error) : resolve(destination) }, 0);
    });
  }
}
async function get(url, headers) {
  return new Promise((resolve, reject) => http.get(url, { headers }, response => {
    const chunks = []; response.on('data', data => chunks.push(data)); response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', reject);
  }).on('error', reject));
}

// Real MacUpdater transport, architecture selection, checksum and Squirrel proxy.
// The native Squirrel boundary is a stub: this test cannot attest to code signing or OS installation.
for (const corrupt of [false, true]) test(`MacUpdater ${corrupt ? 'rejects corrupt ZIP and retries' : 'downloads ZIP only on request and hands off only after backup'}`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-dock-mac-update-'));
  const archive = new AdmZip(); archive.addFile('Prompt Dock.app/Contents/Info.plist', Buffer.from('<plist><dict><key>CFBundleIdentifier</key><string>com.codex.promptdock</string></dict></plist>'));
  const payload = archive.toBuffer();
  const hash = createHash('sha512').update(payload).digest('base64');
  let bad = corrupt, downloads = 0, backup = false, installed = false, nativeChecks = 0;
  const nativeUpdater = new EventEmitter();
  nativeUpdater.setFeedURL = value => { nativeUpdater.feed = value; };
  nativeUpdater.checkForUpdates = async () => {
    nativeChecks++;
    assert.equal(backup, true);
    const info = JSON.parse(await get(nativeUpdater.feed.url, nativeUpdater.feed.headers));
    const received = await get(info.url);
    assert.deepEqual(received, payload);
    nativeUpdater.emit('update-downloaded');
  };
  nativeUpdater.quitAndInstall = () => { assert.equal(backup, true); installed = true; };
  const load = Module._load;
  Module._load = function(name, ...args) { return name === 'electron' ? { autoUpdater: nativeUpdater } : load.call(this, name, ...args); };
  let updater;
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/latest-mac.yml')) {
      response.end(`version: 0.11.2\nfiles:\n  - url: Prompt-Dock-0.11.2-mac-${process.arch}.zip\n    sha512: ${hash}\n    size: ${payload.length}\n`);
    } else {
      assert.match(request.url, new RegExp(`mac-${process.arch}\\.zip$`));
      downloads++; const bytes = Buffer.from(payload); if (bad) bytes[0] ^= 1;
      response.setHeader('Content-Length', bytes.length); response.end(bytes);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    fs.writeFileSync(path.join(directory, 'app-update.yml'), 'updaterCacheDirName: prompt-dock-mac-test-cache\n');
    const app = { version: '0.11.1', name: 'Prompt Dock Test', isPackaged: true, appUpdateConfigPath: path.join(directory, 'app-update.yml'), userDataPath: directory, baseCachePath: directory, whenReady: async () => {}, onQuit: () => {}, quit: () => { throw Error('No real application quit'); } };
    const { MacUpdater } = require('electron-updater/out/MacUpdater');
    updater = new MacUpdater(null, app);
    Module._load = load;
    updater.httpExecutor = new TestHttpExecutor(); updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
    const controller = new UpdateController({ updater, currentVersion: '0.11.1', backup: async () => { backup = true; return { ok: true }; } });
    updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}` });
    await controller.check(); assert.equal(controller.snapshot().phase, 'available'); assert.equal(downloads, 0);
    await controller.download();
    if (corrupt) {
      assert.equal(controller.snapshot().phase, 'error'); await controller.install(); assert.equal(backup, false); assert.equal(nativeChecks, 0);
      bad = false; await controller.download();
    }
    assert.equal(controller.snapshot().phase, 'downloaded');
    assert.equal(installed, false); assert.equal(nativeChecks, 0);
    await controller.install();
    for (let i = 0; !installed && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(installed, true); assert.equal(nativeChecks, 1);
  } finally {
    Module._load = load; updater?.closeServerIfExists();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true });
  }
});
