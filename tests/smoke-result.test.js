const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifySmokeOutput } = require('../scripts/smoke-test');

test('smoke verification accepts completed boolean checks and ignores diagnostic fields', () => {
  assert.deepEqual(verifySmokeOutput('startup\nSMOKE_OK:{"one":true,"two":true,"detail":{"optional":false}}\r\n'), { checks: 2 });
});
test('an output marker cannot hide failed UI checks', () => {
  assert.throws(() => verifySmokeOutput('SMOKE_OK:{"one":true,"privacyModeMasksPromptText":false}'), /privacyModeMasksPromptText/);
});
test('a truncated or malformed result is rejected', () => {
  assert.throws(() => verifySmokeOutput('SMOKE_OK:{"one":'), SyntaxError);
});
test('missing output is rejected even when the process exits successfully', () => {
  assert.throws(() => verifySmokeOutput('startup complete'), /did not return/);
});
test('a marker with no boolean checks is rejected', () => {
  assert.throws(() => verifySmokeOutput('SMOKE_OK:{"version":"0.11.2"}'), /no checks/);
});
