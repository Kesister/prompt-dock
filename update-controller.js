const { EventEmitter } = require('node:events');
const semver = require('semver');

const RELEASE_URL = 'https://github.com/Kesister/prompt-dock/releases/latest';
const FEED = Object.freeze({ provider: 'github', owner: 'Kesister', repo: 'prompt-dock', releaseType: 'release' });

function releaseDetails(info = {}) {
  const notes = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.map(item => `${item.version || ''}\n${item.note || ''}`).join('\n\n')
    : String(info.releaseNotes || '本次更新的详细说明请查看发布页面。');
  return { version: String(info.version || ''), notes: notes.slice(0, 16000) };
}

class UpdateController extends EventEmitter {
  constructor({ updater, currentVersion, enabled = true, canInstall = true, backup, prepareQuit = () => {}, cancelQuit = () => {} }) {
    super();
    this.updater = updater;
    this.backup = backup;
    this.prepareQuit = prepareQuit;
    this.cancelQuit = cancelQuit;
    this.state = { phase: enabled ? 'idle' : 'disabled', currentVersion, canInstall, version: '', notes: '', percent: 0, checkedAt: '', message: enabled ? '' : '开发环境不检查更新。' };
    if (!enabled) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableDifferentialDownload = true;
    updater.setFeedURL(FEED);
    updater.on('update-available', info => {
      const version = semver.valid(info.version);
      // Optional Skill releases and replaced files with the same version are not application updates.
      if (!version || semver.prerelease(version) || !semver.gt(version, currentVersion)) {
        this.set({ phase: 'current', version: '', notes: '', message: '当前已是最新版本。' });
        return;
      }
      this.set({ ...releaseDetails(info), phase: 'available', percent: 0, message: '' });
    });
    updater.on('update-not-available', () => this.set({ phase: 'current', version: '', notes: '', message: '当前已是最新版本。' }));
    updater.on('download-progress', progress => {
      if (this.state.phase === 'downloading') this.set({ percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)) });
    });
    updater.on('update-downloaded', info => {
      if (this.state.phase === 'downloading' && info.version === this.state.version) {
        this.set({ phase: 'downloaded', percent: 100, message: '下载完成。点击重启并更新，安装前会自动备份资料。' });
      }
    });
    updater.on('error', () => this.fail());
  }

  snapshot() { return { ...this.state }; }
  set(patch) { Object.assign(this.state, patch); this.emit('status', this.snapshot()); }
  fail(message) {
    const installing = this.state.phase === 'installing';
    if (installing) this.cancelQuit();
    const retryPhase = installing || this.state.phase === 'downloaded' ? 'downloaded'
      : this.state.phase === 'downloading' ? 'available' : this.state.retryPhase || 'idle';
    this.set({ phase: 'error', retryPhase, message: message || (installing
      ? '暂时无法启动安装，请重试或前往发布页面手动安装。'
      : '暂时无法完成更新，请检查网络后重试，或前往发布页面手动下载。') });
  }

  async check() {
    if (['disabled', 'checking', 'available', 'downloading', 'downloaded', 'installing'].includes(this.state.phase)) return this.snapshot();
    if (this.state.phase === 'error' && this.state.retryPhase === 'downloaded') return this.snapshot();
    this.set({ phase: 'checking', message: '', version: '', notes: '', retryPhase: '', checkedAt: new Date().toISOString() });
    try { await this.updater.checkForUpdates(); } catch { if (this.state.phase !== 'error') this.fail(); }
    return this.snapshot();
  }

  async download() {
    const ready = this.state.phase === 'available' || (this.state.phase === 'error' && this.state.retryPhase === 'available');
    if (!ready || !this.state.canInstall) return this.snapshot();
    this.set({ phase: 'downloading', percent: 0, message: '', retryPhase: '' });
    try { await this.updater.downloadUpdate(); } catch { if (this.state.phase !== 'error') this.fail(); }
    return this.snapshot();
  }

  async install() {
    const ready = this.state.phase === 'downloaded' || (this.state.phase === 'error' && this.state.retryPhase === 'downloaded');
    if (!ready || !this.state.canInstall) return this.snapshot();
    this.set({ phase: 'installing', message: '正在备份资料，完成后重启并更新…', retryPhase: '' });
    try {
      const result = await this.backup();
      if (!result?.ok) throw new Error('backup');
    } catch {
      this.fail('更新前备份失败，本次安装已停止。请检查磁盘空间和备份目录后重试。');
      return this.snapshot();
    }
    try {
      this.prepareQuit();
      this.updater.quitAndInstall(false, true);
    } catch { this.fail('暂时无法启动安装，请重试或前往发布页面手动安装。'); }
    return this.snapshot();
  }
}

module.exports = { UpdateController, RELEASE_URL, FEED, releaseDetails };
