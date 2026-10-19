const { test } = require('node:test');
const assert = require('node:assert/strict');
const { name, build } = require('../package.json');

test('installer retains application identity for the existing user profile', () => {
  assert.equal(name, 'prompt-dock');
  assert.equal(build.appId, 'com.codex.promptdock');
  assert.equal(build.productName, 'Prompt Dock');
});

test('normal uninstall preserves data and installation remains a per-user wizard', () => {
  assert.equal(build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(build.nsis.oneClick, false);
  assert.equal(build.nsis.perMachine, false);
  assert.equal(build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(build.nsis.createDesktopShortcut, true);
  assert.equal(build.nsis.createStartMenuShortcut, true);
  assert.match(build.nsis.artifactName, /-Setup\./);
});

test('release inputs use reviewed code/assets rather than a workspace-wide glob', () => {
  assert.ok(!build.files.includes('**/*'));
  assert.ok(build.files.includes('assets/**/*'));
  assert.ok(build.files.includes('!assets/author-wechat-qr.jpg'));
  assert.ok(!build.extraFiles && !build.extraResources);
  assert.ok(!build.files.some(entry => /userData|\.sqlite|\.promptdock|backup|dist|tests|scripts/.test(entry)));
});
