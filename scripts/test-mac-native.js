// Build a distinct Cocoa receiver; never paste into a user's existing application.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'darwin') throw Error('Run on macOS');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-dock-native-'));
const bundle = path.join(directory, 'PasteTarget.app', 'Contents');
fs.mkdirSync(path.join(bundle, 'MacOS'), { recursive: true });
fs.writeFileSync(path.join(bundle, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.codex.promptdock.pastefixture</string><key>CFBundleName</key><string>Prompt Dock Paste Fixture</string><key>CFBundleExecutable</key><string>PasteTarget</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
const target = path.join(bundle, 'MacOS', 'PasteTarget');
const compile = spawnSync('xcrun', ['swiftc', '-module-cache-path', path.join(root, 'build/module-cache'), '-O', path.join(root, 'scripts/native-paste-target.swift'), '-o', target], { stdio: 'inherit' });
if (compile.status) process.exit(compile.status);
const executable = process.argv[2] || require('electron');
const results = [];
for (const scenario of ['normal', 'palette', 'password', 'read-only']) {
  const profile = path.join(directory, scenario); fs.mkdirSync(profile);
  const env = { ...process.env, PROMPT_DOCK_NATIVE_TEST: target, PROMPT_DOCK_NATIVE_SCENARIO: scenario, PROMPT_DOCK_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PROMPT_DOCK_SMOKE_TEST;
  const log = fs.openSync(path.join(profile, 'native.log'), 'w');
  const child = spawnSync(executable, process.argv[2] ? [] : [root], { cwd: root, env, stdio: ['ignore', log, log], timeout: 25000 });
  fs.closeSync(log);
  const file = path.join(profile, 'native-result.json');
  const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { scenario, passed: false, message: child.error?.message || 'No result' };
  results.push(result); console.log(`${scenario}: ${result.passed ? 'PASS' : 'FAIL'} (${file})`);
}
fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
console.log(`Native evidence: ${directory}`);
process.exitCode = results.every(result => result.passed) ? 0 : 1;
