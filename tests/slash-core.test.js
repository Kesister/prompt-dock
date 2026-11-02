const { test } = require('node:test');
const assert = require('node:assert/strict');
const { search, settings } = require('../slash-core');
const preview = require('../slash-preview');
const prompts = [
  { id:'a', alias:'model', title:'人物', usageNote:'模特', content:'生成线稿', tags:['图像/设计'], variants:[{id:'v1', title:'水彩', content:'透明背景'}] },
  { id:'b', title:'model 说明', content:'人物照片', favorite:true },
  { id:'c', title:'model', content:'人物 模特 线稿', deletedAt:'2026-10-01' }
];
test('hotkey-only settings ignore legacy trigger/scope while preserving shortcut and confirm', () => {
  assert.equal(settings().enabled, false);
  assert.deepEqual(settings({enabled:true,apps:['Code.exe'],trigger:'//',scope:'include',shortcut:'Control+Alt+F8',confirm:'Enter'}),{enabled:true,shortcut:'Control+Alt+F8',confirm:'Enter'});
  assert.deepEqual(settings({enabled:true,apps:['Code.exe'],trigger:';;',scope:'exclude',shortcut:'Control+Alt+F8',confirm:'Enter'}),{enabled:true,shortcut:'Control+Alt+F8',confirm:'Enter'});
  assert.equal(settings({shortcut:''}).shortcut,'');
  assert.equal(settings(null).confirm,'Tab');
});
test('reviewed native commit guards include verified selected-text replacement',()=>{
  const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
  const source=fs.readFileSync(path.join(__dirname,'../assets/PromptDock.SlashHelper.cs'),'utf8').replace(/\r\n/g,'\n');
  const commit=source.slice(source.indexOf('  static void Commit('),source.indexOf('  static void Restore('));
  // Behavioral coverage runs the real routines with fake UIA/Win32 in palette-native.test.js.
  assert.equal(crypto.createHash('sha256').update(commit).digest('hex'),'01c33e537e52fd457820952f87c90ab9538e10abe3b71a6a99d752084d78ca87');
});
test('reviewed selection acquisition and focus handoff stay pinned; trigger entry is absent',()=>{
  const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
  const source=fs.readFileSync(path.join(__dirname,'../assets/PromptDock.SlashHelper.cs'),'utf8').replace(/\r\n/g,'\n');
  const controller=fs.readFileSync(path.join(__dirname,'../slash-controller.js'),'utf8').replace(/\r\n/g,'\n');
  const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(digest(source.slice(source.indexOf('  static bool AcquirePalette('),source.indexOf('  static void Start('))),'bc1f38b0a8679522ef041b14a16e1c7742f8522dd9199361ab4516715c5f9ded');
  assert.equal(digest(controller.slice(controller.indexOf('  async commitPalette('),controller.indexOf('  dispose('))),'f140879b034a055f1f18277d27237318de030e3969117ab39366659c599a93a1');
  assert.ok(!source.includes('ToUnicodeEx')&&!source.includes('Start(false)')&&!source.includes('Poll();'));
  assert.ok(source.includes('if(!manual)return;')&&source.includes('bool hasTrigger=false;'));
  assert.ok(!source.includes('apps.Contains(')&&!source.includes('Process.GetProcesses()'));
});
test('query tokens match across title, notes and body, all required', () => {
  assert.deepEqual(search(prompts,'人物 模特 线稿').map(p=>p.id),['a']);
  assert.equal(search(prompts,'人物 不存在').length,0);
});
test('alias exact match outranks favorite and trash never appears', () => {
  assert.deepEqual(search(prompts,'ＭＯＤＥＬ').map(p=>p.id),['a','b']);
});

test('opening the recent list does not scan bodies that are not returned', () => {
  const expensive = { id: 'other', title: 'Other', favorite: false, get content() { throw new Error('Unnecessary full-body scan'); } };
  const favorite = { id: 'favorite', title: 'Favorite', content: 'BODY', favorite: true };
  assert.deepEqual(search([expensive, favorite], '', 1).map(p => p.id), ['favorite']);
});

test('empty-query ranking and punctuation-only exact aliases keep their existing order', () => {
  const data = [
    { id: 'used', title: 'Used', content: 'A', useCount: 10, favorite: false },
    { id: 'alias', title: 'Alias', content: 'B', alias: '::', favorite: false },
    { id: 'favorite', title: 'Favorite', content: 'C', favorite: true },
    { id: 'recent', title: 'Recent', content: 'D', lastUsed: '2026-11-01', favorite: false }
  ];
  assert.deepEqual(search(data, '').map(p => p.id), ['favorite', 'recent', 'used', 'alias']);
  assert.equal(search(data, '::')[0].id, 'alias');
});
test('variants, nested tags and limits work without exposing full text', () => {
  const result = search(prompts,'水彩 透明')[0];
  assert.equal(result.id,'a'); assert.equal(result.variants[1].id,'v1');
  assert.equal(result.variants[1].content,undefined);
  assert.equal(search(prompts,'图像 设计')[0].id,'a');
  assert.equal(search(prompts,'',1).length,1);
});
test('preview resolves only the selected version and keeps notes separate',()=>{
  const prompt={...prompts[0],defaultVariantTitle:'基础版'};
  assert.equal(preview.details(prompt).content,'生成线稿');
  assert.equal(preview.details(prompt).variantTitle,'基础版');
  assert.equal(preview.details(prompt,'v1').content,'透明背景');
  assert.equal(preview.details(prompt,'v1').usageNote,'模特');
  assert.equal(preview.details(prompt,'missing'),null);
  assert.equal(preview.details({...prompt,deletedAt:'today'}),null);
  assert.equal(preview.details(null),null);
});
test('preview uses local thumbnails only, rejects remote/file/traversal images',()=>{
  const image='prompt-dock-image://asset/original/'+'a'.repeat(64)+'.png';
  const thumbnail=image.replace('original','thumbnail');
  const result=preview.details({...prompts[0],images:[image,'https://example.com/a.png','file:///C:/secret.png','prompt-dock-image://asset/thumbnail/../../secret.png'],imageThumbnails:[thumbnail]});
  assert.deepEqual(result.images,[thumbnail]);
  assert.equal(preview.details({...prompts[0],images:Array(9).fill(image)}).images.length,6);
  assert.equal(preview.details({...prompts[0],content:'x'.repeat(50000)}).content.length,50000);
});
test('preview bounds fit every work area, including negative monitor coordinates',()=>{
  for(const area of [{x:0,y:0,width:1280,height:720},{x:-1600,y:-100,width:1600,height:900},{x:0,y:0,width:600,height:440}]){
    for(const point of [{x:area.x,y:area.y},{x:area.x+area.width-5,y:area.y+area.height-5}]){
      const b=preview.bounds(point,area,true);
      assert.ok(b.x>=area.x&&b.y>=area.y&&b.x+b.width<=area.x+area.width&&b.y+b.height<=area.y+area.height);
      assert.equal(b.width,area.width<700?400:760);
    }
  }
  assert.equal(preview.bounds({x:0,y:0},{x:0,y:0,width:1280,height:720},false,256).width,400);
});
