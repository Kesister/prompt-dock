const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'darwin') throw Error('Run on macOS');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-dock-chromium-'));
const bundle = path.join(directory, 'ChromiumTarget.app');
let targetExecutable;
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw Error(result.stderr || result.stdout || result.error?.message);
}
if (process.env.PROMPT_DOCK_BROWSER_EDGE === '1') {
  targetExecutable = path.join(directory, 'edge-receiver');
  fs.writeFileSync(targetExecutable, '#!' + process.execPath + '\n' + fs.readFileSync(path.join(root, 'tests/mac-edge-target.js'), 'utf8'), {mode:0o755});
} else {
  run('ditto', [path.resolve(require('electron'), '../../..'), bundle]);
  const plist = path.join(bundle, 'Contents/Info.plist');
  run('/usr/libexec/PlistBuddy', ['-c', 'Set CFBundleIdentifier com.codex.promptdock.chromiumfixture', plist]);
  run('/usr/libexec/PlistBuddy', ['-c', 'Set CFBundleName Prompt Dock Chromium Fixture', plist]);
  const resources = path.join(bundle, 'Contents/Resources/app'); fs.mkdirSync(resources);
  fs.writeFileSync(path.join(resources, 'package.json'), JSON.stringify({ name: 'prompt-dock-chromium-fixture', version: '1.0.0', main: 'main.js' }));
  fs.copyFileSync(path.join(root, 'tests/mac-browser-target.js'), path.join(resources, 'main.js'));
  run('codesign', ['--force', '--deep', '--sign', '-', bundle]);
  targetExecutable = path.join(bundle, 'Contents/MacOS/Electron');
  // A newly ad-hoc-signed fixture can spend several seconds in macOS's first
  // executable scan. Complete that setup separately from the paste assertions.
  // Every scenario still starts a NEW process with a cold accessibility tree.
  const bootstrap = path.join(directory, 'bootstrap'); fs.mkdirSync(bootstrap);
  const bootstrapOutput = path.join(bootstrap, 'ready.txt');
  const setupEnv = { ...process.env, PROMPT_DOCK_USER_DATA: bootstrap };
  delete setupEnv.ELECTRON_RUN_AS_NODE;
  const setup = spawnSync(targetExecutable, [bootstrapOutput, 'bootstrap'], { env: setupEnv, stdio: 'ignore', timeout: 25000 });
  if (setup.status !== 0 || !fs.existsSync(bootstrapOutput + '.ready')) throw Error('Chromium receiver setup failed before paste testing');
}
const executable = process.argv[2] || require('electron');
const modes = process.env.PROMPT_DOCK_BROWSER_MODES?.split(',') || ['normal', 'normal-selection', 'textarea', 'rich', 'palette', 'palette-selection', 'palette-textarea', 'palette-rich', 'compact-selection', 'password', 'read-only', 'palette-password', 'palette-read-only'];
const results = [];
for (const scenario of modes) {
  const profile = path.join(directory, scenario); fs.mkdirSync(profile);
  const env = { ...process.env, PROMPT_DOCK_USER_DATA: profile, PROMPT_DOCK_NATIVE_TEST: targetExecutable, PROMPT_DOCK_NATIVE_SCENARIO: scenario };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PROMPT_DOCK_SMOKE_TEST;
  const log = fs.openSync(path.join(profile, 'native.log'), 'w');
  const child = spawnSync(executable, process.argv[2] ? [] : [root], { cwd: root, env, stdio: ['ignore', log, log], timeout: 25000 });
  fs.closeSync(log);
  const file = path.join(profile, 'native-result.json');
  const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { scenario, passed: false, message: child.error?.message || 'No result' };
  results.push(result); console.log(`${scenario}: ${result.passed ? 'PASS' : 'FAIL'} (${file})`);
}
fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
console.log(`Chromium evidence: ${directory}`);
process.exitCode = results.every(result => result.passed) ? 0 : 1;
