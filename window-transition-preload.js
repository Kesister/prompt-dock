const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  const stage = document.getElementById('stage');
  const before = document.getElementById('before');
  const after = document.getElementById('after');
  let scene;
  const animations = [];
  const ack = (token, phase) => ipcRenderer.send('window:transition-ack', token, phase);
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  ipcRenderer.on('window:transition-prepare', async (_, value) => {
    scene = value;
    animations.splice(0).forEach(animation => animation.cancel());
    before.style.opacity = '1';
    after.style.opacity = '0';
    after.removeAttribute('src');
    before.src = value.source;
    stage.style.left = `${value.start.x}px`;
    stage.style.top = `${value.start.y}px`;
    stage.style.width = `${value.start.width}px`;
    stage.style.height = `${value.start.height}px`;
    stage.style.transform = 'none';
    await before.decode();
    ack(value.token, 'prepared');
  });
  ipcRenderer.on('window:transition-present', async (_, token) => {
    await paint();
    if (scene?.token === token) ack(token, 'presented');
  });
  ipcRenderer.on('window:transition-play', async (_, value) => {
    if (scene?.token !== value.token) return;
    after.src = value.destination;
    await after.decode();
    const { start } = scene;
    const target = `translate(${value.target.x - start.x}px, ${value.target.y - start.y}px) scale(${value.target.width / start.width}, ${value.target.height / start.height})`;
    const timing = { duration: value.duration, easing: 'cubic-bezier(.25,.1,.25,1)', fill: 'forwards' };
    animations.push(stage.animate([{ transform: 'none' }, { transform: target }], timing));
    animations.push(before.animate([{ opacity: 1 }, { opacity: 0 }], timing));
    animations.push(after.animate([{ opacity: 0 }, { opacity: 1 }], timing));
    try {
      await Promise.all(animations.map(animation => animation.finished));
      await paint();
      if (scene?.token === value.token) ack(value.token, 'complete');
    } catch { /* The owner cancelled the transition. */ }
  });
  ipcRenderer.on('window:transition-clear', () => {
    scene = null;
    animations.splice(0).forEach(animation => animation.cancel());
    before.removeAttribute('src');
    after.removeAttribute('src');
  });
});
