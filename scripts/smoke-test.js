const { spawn } = require('node:child_process');
const path = require('node:path');
function verifySmokeOutput(output) {
  const line = output.split(/\r?\n/).find(line => line.startsWith('SMOKE_OK:'));
  if (!line) throw new Error('Smoke test did not return a result.');
  const result = JSON.parse(line.slice('SMOKE_OK:'.length));
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Invalid smoke result.');
  const checks = Object.entries(result).filter(([, value]) => typeof value === 'boolean');
  if (!checks.length) throw new Error('Smoke result has no checks.');
  const failed = checks.filter(([, value]) => !value).map(([name]) => name);
  if (failed.length) throw new Error('Smoke checks failed: ' + failed.join(', '));
  return { checks: checks.length };
}

function run() {
  const root = path.resolve(__dirname, '..');
  const exe = process.argv[2] || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env, PROMPT_DOCK_SMOKE_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, process.argv[2] ? [] : ['.'], { cwd: root, env, windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { const text = String(chunk); output += text; process.stdout.write(text); });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  const timer = setTimeout(() => { console.error('Smoke test timeout'); child.kill(); process.exitCode = 1; }, 120000);
  child.on('close', code => {
    clearTimeout(timer);
    try {
      if (code !== 0) throw new Error('Smoke test exited: ' + code);
      console.log('SMOKE_VERIFIED:' + JSON.stringify(verifySmokeOutput(output)));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  });
}

module.exports = { verifySmokeOutput };
if (require.main === module) run();
