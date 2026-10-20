// Same entry point on Windows and macOS; always allocate a disposable profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-dock-smoke-'));
const env = { ...process.env, PROMPT_DOCK_SMOKE_TEST: '1', PROMPT_DOCK_USER_DATA: profile };
delete env.PROMPT_DOCK_NATIVE_TEST;
delete env.ELECTRON_RUN_AS_NODE;
if (env.PROMPT_DOCK_TEST_BACKUP) {
  env.PROMPT_DOCK_TEST_BACKUP = path.resolve(env.PROMPT_DOCK_TEST_BACKUP);
  if (!fs.existsSync(env.PROMPT_DOCK_TEST_BACKUP)) throw new Error('Backup file does not exist');
}
console.log(`Isolated test profile: ${profile}`);
const log = fs.openSync(path.join(profile, 'smoke.log'), 'w');
const executable = process.argv[2] || require('electron');
const child = spawnSync(executable, process.argv[2] ? [] : [root], {
  cwd: root, env, stdio: ['ignore', log, log], timeout: 120000
});
fs.closeSync(log);
const resultPath = path.join(profile, 'smoke-result.json');
if (child.error || child.status !== 0 || !fs.existsSync(resultPath)) {
  console.error(`Smoke test did not complete (${child.error?.message || child.signal || child.status}). See ${path.join(profile, 'smoke.log')}`);
  process.exitCode = 1;
} else {
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const checks = Object.entries(result).filter(([, value]) => typeof value === 'boolean');
  const failures = checks.filter(([, value]) => !value).map(([name]) => name);
  if (env.PROMPT_DOCK_TEST_BACKUP && result.windowsBackupVerification?.passed !== true) failures.push('windowsBackupVerification');
  console.log(`${checks.length - checks.filter(([, value]) => !value).length}/${checks.length} checks passed. Results: ${resultPath}`);
  if (failures.length) {
    console.error(`Failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}
