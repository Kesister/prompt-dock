// Measure actual popup visibility, rendered candidates and keyboard focus.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const bundle = process.env.PROMPT_DOCK_LATENCY_APP;
const runtime = bundle ? path.join(bundle, 'Contents/Resources/app.asar') : path.resolve(__dirname, '..');
const { MacInput } = require(path.join(runtime, 'mac-input'));
const { SlashController } = require(path.join(runtime, 'slash-controller'));
const { PromptStorage } = require(path.join(runtime, 'storage'));
const profile = process.env.PROMPT_DOCK_LATENCY_PROFILE;
if (!profile || !path.isAbsolute(profile)) throw Error('An isolated profile is required');
app.setPath('userData', path.join(profile, 'electron-profile'));
let controller, input, storage;
let phases, sampleStartedAt;
let focusStatus, lastClosedAt = 0;
const children = [];
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await check()) return; await sleep(10); }
  throw Error('Latency fixture timed out');
}
async function receiver(scenario) {
  const output = path.join(profile, scenario + '.txt');
  const child = spawn(process.env.PROMPT_DOCK_LATENCY_TARGET, [output, scenario]);
  children.push(child);
  await until(() => fs.existsSync(output + '.ready'));
  focusStatus = output + '.status'; lastClosedAt = 0;
  return child;
}
async function measure(scenario) {
  if (scenario !== 'helper-not-ready') await until(() => {
    try { const status = JSON.parse(fs.readFileSync(focusStatus)); return status.active && status.updatedAt >= lastClosedAt; } catch { return false; }
  });
  phases = {};
  const capture = controller.macInput.capture;
  controller.macInput.capture = async function (...args) {
    const started = performance.now();
    const result = await capture.apply(this, args);
    phases.captureMs = Math.round((performance.now() - started) * 10) / 10;
    return result;
  };
  const start = performance.now();
  sampleStartedAt = start;
  const opened = controller.openPalette();
  await until(async () => controller.ready && controller.window?.isVisible() && await controller.window.webContents.executeJavaScript('document.activeElement.id === "search" && document.querySelectorAll("#results .item").length > 0'));
  const result = { scenario, interactiveMs: Math.round((performance.now() - start) * 10) / 10, phases: { ...phases }, copyOnly: controller.view.copyOnly, reason: controller.view.copyReason || null };
  results.push(result);
  fs.writeFileSync(path.join(profile, 'samples-progress.json'), JSON.stringify(results, null, 2));
  await opened;
  controller.macInput.capture = capture;
  if (scenario === 'slow-capture') fs.writeFileSync(path.join(profile, 'slow-target-popup.png'), (await controller.window.webContents.capturePage()).toPNG());
  lastClosedAt = Date.now(); controller.close();
  return result;
}
app.whenReady().then(async () => {
  input = new MacInput(bundle ? path.join(bundle, 'Contents/Resources/PromptDock.MacHelper') : path.resolve(__dirname, '../build/PromptDock.MacHelper'), process.pid);
  const helperStartedAt = performance.now();
  await until(async () => {
    const ready = await input.ready;
    if (input.stopped) throw Error('Native test helper exited: ' + JSON.stringify({ code: input.child.exitCode, signal: input.child.signalCode }));
    return ready;
  }, 12000);
  const nativeHelperStartupMs = Math.round((performance.now() - helperStartedAt) * 10) / 10;
  assert.equal((await input.permissionStatus()).trusted, true, 'Native latency test requires the test host Accessibility permission');
  controller = new SlashController({ macInput: input, readState: () => ({ prompts: [{ id: 'latency', title: 'Latency fixture', content: 'Synthetic isolated test text', tags: [], variants: [] }] }), recordUse: () => {} });
  const action = controller.action;
  controller.action = function (value) {
    if (phases && value.type === 'size' && !phases.rendererRenderedAtMs) phases.rendererRenderedAtMs = Math.round((performance.now() - sampleStartedAt) * 10) / 10;
    return action.call(this, value);
  };
  for (const method of ['search', 'show', 'reveal', 'publish']) {
    const original = controller[method];
    controller[method] = function (...args) {
      const started = performance.now();
      const result = original.apply(this, args);
      if (phases) phases[method + 'Ms'] = Math.max(phases[method + 'Ms'] || 0, Math.round((performance.now() - started) * 10) / 10);
      return result;
    };
  }
  assert.equal((await controller.configure({ enabled: true, shortcut: 'Command+Shift+F9' })).ok, true);
  const normal = await receiver('normal');
  // Let enabled-app startup finish; timing begins only at hotkey callback entry.
  await sleep(600);
  for (let index = 0; index < 10; index++) {
    const result = await measure(index === 0 ? 'first-open' : 'repeat-' + index);
    assert.equal(result.copyOnly, false, 'Responsive fields must retain direct insertion');
  }
  const initialState = () => ({ settings: {}, prompts: [], vocabulary: { collections: [], entries: [], settings: {} } });
  storage = new PromptStorage({ userDataPath: path.join(profile, 'synthetic-library'), initialState });
  storage.writeState({ ...initialState(), prompts: Array.from({ length: 1200 }, (_, index) => ({ id: 'large-' + index, title: 'Synthetic prompt ' + index, content: 'Synthetic isolated content. '.repeat(160), tags: [], variants: [] })) });
  const originalRead = controller.readState;
  controller.readState = () => storage.readState();
  const large = await measure('sqlite-library-1200');
  assert.equal(large.copyOnly, false);
  controller.readState = originalRead;
  normal.kill();
  await receiver('slow-capture');
  const slow = await measure('slow-capture');
  assert.equal(slow.copyOnly, true, 'Unresponsive targets must use copy fallback');
  const resumedAt = performance.now();
  assert.equal((await input.permissionStatus()).trusted, true, 'A slow target must not keep the native command queue blocked');
  const helperResponsiveAfterSlowCaptureMs = Math.round((performance.now() - resumedAt) * 10) / 10;
  const silent = path.join(profile, 'silent-helper');
  fs.writeFileSync(silent, '#!/bin/sh\nexec /bin/sleep 10\n', { mode: 0o755 });
  const notReady = new MacInput(silent, process.pid);
  controller.macInput = notReady;
  const startup = await measure('helper-not-ready');
  notReady.dispose();
  const late = path.join(profile, 'late-helper');
  const helperPath = bundle ? path.join(bundle, 'Contents/Resources/PromptDock.MacHelper') : path.resolve(__dirname, '../build/PromptDock.MacHelper');
  const quotedHelper = "'" + helperPath.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(late, '#!/bin/sh\n/bin/sleep 5.2\nexec ' + quotedHelper + ' "$@"\n', { mode: 0o755 });
  const delayed = new MacInput(late, process.pid);
  assert.equal((await delayed.capture()).reason, 'timeout');
  await until(() => delayed.ready, 10000);
  assert.equal((await delayed.permissionStatus()).trusted, true, 'Late readiness must recover after the original timer expires');
  delayed.dispose();
  const normalTimes = results.slice(0, 10).map(item => item.interactiveMs).sort((a, b) => a - b);
  const summary = { samples: results, normalMedianMs: normalTimes[5], normalP95Ms: normalTimes[9], nativeHelperStartupMs, helperResponsiveAfterSlowCaptureMs, lateReadinessRecovery: true, runtime: bundle || 'source', baseline: process.env.PROMPT_DOCK_LATENCY_BASELINE === '1', scope: 'Hotkey callback to visible popup with rendered candidates and search focus; isolated Cocoa target, test-host Accessibility' };
  fs.writeFileSync(path.join(profile, 'results.json'), JSON.stringify(summary, null, 2));
  if (!summary.baseline) {
    assert.ok(summary.normalP95Ms < 350, 'Responsive popup exceeded 350 ms');
    assert.ok(slow.interactiveMs < 350, 'Unresponsive AX target delayed the popup');
    assert.ok(startup.interactiveMs < 350, 'Helper readiness delayed the popup');
    assert.ok(large.interactiveMs < 350, 'Synthetic SQLite library delayed the popup');
    assert.ok(helperResponsiveAfterSlowCaptureMs < 100, 'Native helper remained blocked after the short capture');
  }
}).catch(error => { console.error(error); process.exitCode = 1; })
.finally(() => { controller?.dispose(); input?.dispose(); storage?.close(); for (const child of children) child.kill(); app.exit(process.exitCode || 0); });
