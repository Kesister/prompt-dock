const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { NsisUpdater } = require('electron-updater');
const { NodeHttpExecutor } = require('builder-util/out/nodeHttpExecutor');
const { configureRequestUrl, configureRequestOptions } = require('builder-util-runtime');
const { UpdateController } = require('../update-controller');

// Use the actual updater and its checksum validation over loopback. Never execute the downloaded file.
class TestHttpExecutor extends NodeHttpExecutor {
  download(url, destination, options) {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers || undefined, redirect: 'manual' };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(requestOptions, { destination, options, onCancel, responseHandler: null, callback: error => error ? reject(error) : resolve(destination) }, 0);
    });
  }
}

for (const corrupt of [false, true]) test(`real updater ${corrupt ? 'rejects a corrupted download' : 'downloads and verifies a release before installation'}`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-dock-update-test-'));
  const payload = Buffer.alloc(256 * 1024, 0x5a);
  const expected = createHash('sha512').update(payload).digest('base64');
  let downloads = 0;
  let installed = false;
  let backedUp = false;
  const server = http.createServer((request, response) => {
    // The provider derives its channel filename from the test host, even for NsisUpdater.
    if (/^\/latest(?:-mac)?\.yml(?:\?|$)/.test(request.url)) {
      response.end(`version: 0.11.2\nfiles:\n  - url: Prompt-Dock-0.11.2-Setup.exe\n    sha512: ${expected}\n    size: ${payload.length}\nreleaseDate: '2026-10-20T00:00:00Z'\n`);
    } else {
      downloads++;
      const data = Buffer.from(payload);
      if (corrupt) data[0] = 0;
      response.setHeader('Content-Length', data.length);
      response.end(data);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    fs.writeFileSync(path.join(directory, 'app-update.yml'), 'updaterCacheDirName: prompt-dock-test-cache\n');
    const app = { version: '0.11.1', name: 'Prompt Dock Test', isPackaged: true,
      appUpdateConfigPath: path.join(directory, 'app-update.yml'), userDataPath: directory, baseCachePath: directory,
      whenReady: async () => {}, onQuit: () => {}, quit: () => { throw new Error('Must not quit a real application'); } };
    const updater = new NsisUpdater(null, app);
    let updaterError;
    updater.on('error', error => { updaterError = error; });
    updater.httpExecutor = new TestHttpExecutor();
    updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
    const controller = new UpdateController({ updater, currentVersion: '0.11.1', backup: async () => { backedUp = true; return { ok: true }; } });
    updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}` });
    updater.doInstall = () => {
      assert.equal(backedUp, true);
      assert.equal(createHash('sha512').update(fs.readFileSync(updater.installerPath)).digest('base64'), expected);
      installed = true;
      return false; // Stop before a real OS installation or application quit.
    };
    await controller.check();
    assert.equal(controller.snapshot().phase, 'available', updaterError?.stack);
    assert.equal(downloads, 0);
    await controller.download();
    assert.equal(downloads, 1);
    if (corrupt) {
      assert.equal(controller.snapshot().phase, 'error');
      await controller.install();
      assert.equal(backedUp, false);
      assert.equal(installed, false);
    } else {
      assert.equal(controller.snapshot().phase, 'downloaded');
      assert.equal(installed, false);
      await controller.install();
      assert.equal(installed, true);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    // Only this test's freshly created temporary directory is removed.
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('prompt-dock-update-test-'));
    fs.rmSync(resolved, { recursive: true });
  }
});
