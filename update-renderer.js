(() => {
  const api = window.promptDock;
  const el = id => document.getElementById(id);
  let status;
  let dismissedVersion = '';
  let dismissedPhase = '';
  let installing = false;
  const busy = () => ['checking', 'downloading', 'installing'].includes(status?.phase);
  const retryPhase = () => status?.phase === 'error' ? status.retryPhase : status?.phase;

  function readableNotes(value) {
    // A detached template keeps GitHub's HTML inert; only extracted text reaches the page.
    const template = document.createElement('template');
    template.innerHTML = value || '';
    template.content.querySelectorAll('script,style,img,iframe,object,embed').forEach(node => node.remove());
    template.content.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    template.content.querySelectorAll('p,li,h1,h2,h3,h4,div').forEach(node => node.append('\n'));
    return template.content.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }

  function action() {
    const phase = retryPhase();
    if (phase === 'downloaded') return ['重启并更新', 'install'];
    if (phase === 'available') return status.canInstall ? ['下载更新', 'download'] : ['下载新版安装包', 'manual'];
    return ['检查更新', 'check'];
  }

  function render(next) {
    if (!next?.phase) return;
    status = next;
    installing = status.phase === 'installing';
    const messages = {
      idle: '可以检查是否有新版本。', checking: '正在检查新版本…', available: `发现新版本 v${status.version}。${status.canInstall ? '' : '便携版请下载新版安装包或手动替换程序。'}`,
      downloading: `正在下载更新… ${Math.floor(status.percent)}%`, downloaded: '下载完成，可重启并更新。', installing: '正在备份资料，完成后重启并更新…',
      current: '当前已是最新版本。', disabled: '当前环境不支持内置更新，可前往发布页面下载。'
    };
    const message = status.phase === 'error' ? status.message : messages[status.phase] || status.message;
    el('updateCurrentVersion').textContent = `v${status.currentVersion}`;
    el('updateAutoCheck').checked = status.autoCheck !== false;
    el('updateSettingsStatus').textContent = message;
    el('updateMessage').textContent = message;
    el('updateVersionSummary').textContent = `当前 v${status.currentVersion}${status.version ? ` → 新版 v${status.version}` : ''}`;
    // Release content is untrusted text, never HTML or executable links.
    el('updateReleaseNotes').textContent = readableNotes(status.notes);
    el('updateReleaseNotes').classList.toggle('hidden', !status.notes);
    el('updateProgress').value = status.percent;
    el('updateProgress').classList.toggle('hidden', status.phase !== 'downloading');
    el('updateCheckBtn').disabled = busy() || status.phase === 'disabled';
    el('updateAutoCheck').disabled = installing;
    el('updateActionBtn').textContent = action()[0];
    el('updateActionBtn').disabled = busy() || status.phase === 'disabled';
    el('updateLaterBtn').disabled = installing;
    el('updateManualBtn').disabled = installing;
    el('updateDialog').querySelector('[data-close-dialog]').disabled = installing;
    const announce = ['available', 'downloaded'].includes(status.phase);
    const dismissed = dismissedVersion === status.version && dismissedPhase === status.phase;
    el('updateBanner').classList.toggle('hidden', !announce || dismissed || el('updateDialog').open);
    el('updateBannerText').textContent = status.phase === 'downloaded' ? `v${status.version} 已下载，随时可以更新` : `Prompt Dock v${status.version} 已发布`;
  }

  function open() { el('updateDialog').showModal(); if (status) render(status); }
  function dismiss() {
    if (status) { dismissedVersion = status.version; dismissedPhase = status.phase; }
    el('updateBanner').classList.add('hidden');
  }
  async function run(operation) {
    try {
      if (operation === 'manual') return await api.openUpdateRelease();
      if (operation === 'install') {
        // Flush queued library writes before the main process creates the update snapshot.
        const saved = await persist();
        if (!saved?.ok) throw new Error('save');
        render(await api.installUpdate());
      } else render(await (operation === 'download' ? api.downloadUpdate() : api.checkForUpdates()));
    } catch { toast('暂时无法完成更新操作，请稍后重试。'); }
  }
  el('updateCheckBtn').addEventListener('click', () => { open(); run('check'); });
  el('updateDetailsBtn').addEventListener('click', open);
  el('updateBannerView').addEventListener('click', open);
  el('updateBannerDismiss').addEventListener('click', dismiss);
  el('updateLaterBtn').addEventListener('click', () => { dismiss(); el('updateDialog').close(); });
  el('updateDialog').addEventListener('cancel', event => { if (installing) event.preventDefault(); else dismiss(); });
  el('updateDialog').addEventListener('close', () => { dismiss(); if (status) render(status); });
  el('updateManualBtn').addEventListener('click', () => run('manual'));
  el('updateActionBtn').addEventListener('click', () => { if (!busy()) run(action()[1]); });
  el('updateAutoCheck').addEventListener('change', async () => {
    try {
      const result = await api.setUpdateAutoCheck(el('updateAutoCheck').checked);
      if (!result.ok) { toast(result.message); render(status); } else render(result);
    } catch { toast('无法保存更新偏好，请重试。'); render(status); }
  });
  api.onUpdateStatus(render);
  api.getUpdateStatus().then(render).catch(() => { el('updateSettingsStatus').textContent = '暂时无法读取更新状态。'; });
})();
