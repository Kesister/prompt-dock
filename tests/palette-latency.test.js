const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./palette-test-fixture');
const config = { enabled: true, shortcut: 'Control+Alt+Space' };
async function setup(t) {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.configure(config); f.ready(); f.controller.event({ type: 'ready' });
  f.controller.openPalette(); return f;
}
function prepare(f, session = 1) {
  f.controller.event({ type: 'prepare', session, request: f.controller.paletteRequest, palette: true, x: 100, y: 100 });
}
function query(f, extra = {}) {
  f.controller.event({ type: 'query', session: 1, request: f.controller.paletteRequest, palette: true,
    query: '', x: 100, y: 100, copyOnly: false, ...extra });
}

test('disabled features allocate no helper or popup; enabling preloads a hidden window', async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  assert.equal(f.windows.length, 0); assert.equal(f.spawned.length, 0);
  await f.controller.configure(config);
  assert.equal(f.windows.length, 1); assert.equal(f.controller.window.isVisible(), false);
  f.ready(); assert.equal(f.controller.window.isVisible(), false); assert.equal(f.reads, 0);
});
test('an immediate first invocation waits for helper configuration before sending its request', async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.configure(config); f.controller.openPalette();
  assert.equal(f.commands.some(x => x.type === 'palette'), false);
  f.controller.event({ type: 'ready' });
  assert.deepEqual(f.commands.slice(-2).map(x => x.type), ['config', 'palette']);
  assert.ok(f.commands.at(-1).request > 0);
});
test('candidate rendering overlaps acquisition and the validated request reuses the painted content', async t => {
  const f = await setup(t); prepare(f); f.rendered();
  assert.equal(f.controller.view.acquiring, true); assert.equal(f.controller.window.isVisible(), false);
  assert.equal(f.reads, 1);
  query(f);
  assert.equal(f.controller.window.isVisible(), true); assert.equal(f.controller.window.isFocused(), true);
  assert.equal(f.controller.view.acquiring, false); assert.equal(f.reads, 1); assert.equal(f.windows.length, 1);
});
test('unvalidated or copy-only state cannot paste or become visible with an outdated hint', async t => {
  const f = await setup(t); prepare(f); f.rendered();
  f.controller.action({ type: 'choose', session: 1, id: 'sample', variant: 'default' });
  assert.equal(f.copies.length, 0);
  const old = f.controller.window.messages.filter(x => x.channel === 'slash:view').at(-1).value;
  query(f, { copyOnly: true, copyReason: 'read-only' });
  f.rendered(old); assert.equal(f.controller.window.isVisible(), false);
  f.rendered(); assert.equal(f.controller.window.isVisible(), true); assert.match(f.controller.view.message, /只读/);
  f.controller.action({ type: 'choose', session: 1, id: 'sample', variant: 'default' });
  assert.deepEqual(f.copies, ['BODY']); assert.equal(f.commands.some(x => x.type === 'commit'), false);
});
test('cancellation or a protected input cannot reveal a prepared window through a late reply', async t => {
  const f = await setup(t); const request = f.controller.paletteRequest;
  prepare(f); f.controller.event({ type: 'closed', session: 1 });
  query(f, { request });
  assert.equal(f.controller.view, null); assert.equal(f.controller.window.isVisible(), false);
});
test('a newer invocation rejects replies from the cancelled acquisition', async t => {
  const f = await setup(t); const oldRequest = f.controller.paletteRequest; prepare(f);
  f.controller.openPalette(); const request = f.controller.paletteRequest;
  assert.ok(request > oldRequest); query(f, { request: oldRequest }); assert.equal(f.controller.view, null);
  prepare(f, 2); f.rendered(); query(f, { session: 2, request });
  f.controller.event({ type: 'closed', session: 1 });
  assert.equal(f.controller.view.session, 2); assert.equal(f.controller.window.isVisible(), true);
});
test('library changes during acquisition invalidate the prepared candidate list', async t => {
  const f = await setup(t); prepare(f); f.rendered();
  f.state.prompts = [{ id: 'new', title: 'Updated', content: 'NEW' }]; f.controller.invalidate();
  query(f); assert.equal(f.controller.window.isVisible(), false); f.rendered();
  assert.equal(f.controller.view.items[0].id, 'new'); assert.equal(f.reads, 2);
});
test('helper failure clears pending requests and the next attempt performs a fresh handshake', async t => {
  const f = await setup(t); prepare(f); f.spawned[0].emit('exit', 1);
  assert.equal(f.controller.helperReady, false); assert.equal(f.controller.paletteRequest, 0);
  f.controller.openPalette(); assert.equal(f.spawned.length, 2);
  const request = f.controller.paletteRequest; f.controller.event({ type: 'ready' });
  assert.equal(f.commands.at(-1).request, request); assert.equal(f.commands.at(-1).type, 'palette');
});
test('pausing or disabling during acquisition keeps the warm window hidden and rejects completion', async t => {
  const f = await setup(t); prepare(f); const request = f.controller.paletteRequest;
  f.controller.pause(); query(f, { request });
  assert.equal(f.controller.view, null); assert.equal(f.controller.window.isVisible(), false);
  await f.controller.configure({ ...config, enabled: false }); assert.equal(f.controller.helper, null);
});
test('a repeated hotkey closes the visible palette and the next opening reuses its loaded window', async t => {
  const f = await setup(t); prepare(f); f.rendered(); query(f);
  f.controller.openPalette(); await new Promise(resolve=>setImmediate(resolve)); assert.equal(f.controller.window.isVisible(), false);
  f.controller.openPalette(); prepare(f, 2); f.rendered(); query(f, { session: 2 });
  assert.equal(f.windows.length, 1); assert.equal(f.controller.window.isVisible(), true);
});

test('Esc dismissal hands focus back without pasting, changing clipboard or recording usage', async t => {
  const f=await setup(t);prepare(f);f.rendered();query(f);
  await f.controller.dismiss();
  assert.deepEqual(f.commands.at(-1),{type:'restore',session:1});
  assert.equal(f.controller.view,null);assert.equal(f.controller.window.isVisible(),false);
  assert.equal(f.commands.some(x=>x.type==='commit'),false);assert.deepEqual(f.copies,[]);
});
test('a blur or settings cancellation while permission is pending cannot restore stale focus', async t => {
  for(const cancel of [f=>f.controller.window.emit('blur'),f=>f.controller.close()]){
    const f=await setup(t);prepare(f);f.rendered();query(f);
    const promise=f.controller.dismiss();cancel(f);await promise;
    assert.equal(f.commands.some(x=>x.type==='restore'),false);assert.equal(f.controller.view,null);
  }
});
test('denied foreground permission closes without trying to activate a target', async t => {
  const f=fixture({focusGrant:'denied'});t.after(()=>f.controller.dispose());
  await f.controller.configure(config);f.ready();f.controller.event({type:'ready'});f.controller.openPalette();
  prepare(f);f.rendered();query(f);await f.controller.dismiss();
  assert.equal(f.controller.view,null);assert.equal(f.commands.some(x=>x.type==='restore'),false);assert.equal(f.commands.at(-1).type,'cancel');
});
test('selected-text state gets a fresh frame so the popup shows replacement rather than insertion',async t=>{
  const f=await setup(t);prepare(f);f.rendered();query(f,{replaceSelection:true});
  assert.equal(f.controller.window.isVisible(),false);
  const frame=f.controller.window.messages.filter(x=>x.channel==='slash:view').at(-1).value;
  assert.equal(frame.replaceSelection,true);f.rendered();assert.equal(f.controller.window.isVisible(),true);
  f.controller.action({type:'choose',session:1,id:'sample',variant:'default'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.copies,['BODY']);assert.equal(f.commands.at(-1).type,'commit');
  assert.equal(f.commands.at(-1).session,1);assert.equal(f.controller.window.isVisible(),false);
});
test('a delayed blur from the hidden preloaded window cannot cancel a new acquisition', async t => {
  const f = await setup(t); prepare(f); const request = f.controller.paletteRequest;
  f.controller.window.emit('blur');
  assert.equal(f.controller.paletteRequest, request); assert.equal(f.controller.view.acquiring, true);
  f.rendered(); query(f); assert.equal(f.controller.window.isVisible(), true);
  f.controller.window.emit('blur'); assert.equal(f.controller.view, null);
});
