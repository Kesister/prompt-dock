const { app, BrowserWindow, clipboard } = require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'prompt-dock-browser-test-')));
app.commandLine.appendSwitch('force-renderer-accessibility');
if (process.argv.includes('--legacy-accessibility')) app.commandLine.appendSwitch('disable-features','UiaProvider');
else app.commandLine.appendSwitch('enable-features','UiaProvider');
let window;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
app.whenReady().then(async()=>{
  window=new BrowserWindow({width:700,height:470,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  await window.loadFile(path.join(__dirname,'browser-input-host.html'));
  window.show();window.focus();
  const server=require('node:net').createServer(socket=>{
  const lines=require('node:readline').createInterface({input:socket});
  lines.on('line',async line=>{
    const c=JSON.parse(line);
    if(c.type==='close')return app.quit();
    if(c.type==='clipboard')clipboard.writeText(c.text);
    if(c.type==='selectionPolicy')await window.webContents.executeJavaScript(`(()=>{window.rejectSelection=${c.mode==='reject'};if(!window.selectionGuard){window.selectionGuard=()=>{const s=getSelection();if(window.rejectSelection&&s.rangeCount&&!s.isCollapsed)s.collapseToEnd();};document.addEventListener('selectionchange',window.selectionGuard);}})()`);
    if(c.type==='set'){
      window.show();window.focus();window.webContents.focus();
      await window.webContents.executeJavaScript(`(()=>{const c=${JSON.stringify(c)},field=document.getElementById(c.kind||'rich');field.focus();if(field.isContentEditable){field.textContent=c.text;const r=document.createRange();r.setStart(field.firstChild,c.caret??c.text.length);r.setEnd(field.firstChild,(c.caret??c.text.length)+(c.length||0));const s=getSelection();s.removeAllRanges();s.addRange(r);}else{field.value=c.text;field.setSelectionRange(c.caret??c.text.length,(c.caret??c.text.length)+(c.length||0));}})()`);
    }
    const state=await window.webContents.executeJavaScript(`({text:document.getElementById('rich').innerText,other:document.getElementById('other').value,focus:document.activeElement.id})`);
    emit({id:c.id,...state,foreground:window.isFocused()});
  });
  });server.listen(0,'127.0.0.1',()=>emit({ready:true,port:server.address().port}));
  app.on('will-quit',()=>server.close());
});
