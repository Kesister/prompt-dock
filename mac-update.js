const { EventEmitter } = require('node:events');
const semver = require('semver');

const MAC_RELEASES_API = 'https://api.github.com/repos/Kesister/prompt-dock/releases';
const MAC_INSTALL_MESSAGE = 'Mac 版通过安装包更新。请下载新版安装包，退出 Prompt Dock 后覆盖安装。';

function macReleaseVersion(release) {
  const tag = String(release?.tag_name || '');
  const version = /^(?:mac-v|v)(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  // Mac previews have their own explicit channel. Windows/other prereleases
  // must never become Mac updates just because they were published later.
  if (release?.draft || (release?.prerelease && !tag.startsWith('mac-v'))) return null;
  return semver.valid(version) || null;
}

function macReleaseAsset(release, arch, currentVersion) {
  const version = macReleaseVersion(release);
  if (!version || semver.lt(version, currentVersion) || !Array.isArray(release.assets)) return null;
  // Prefer the complete installer; retain DMG compatibility for older releases.
  for (const extension of ['pkg', 'dmg']) {
    for (const target of [`mac-${arch}`, 'mac-universal']) {
      const name = `Prompt-Dock-${version}-${target}.${extension}`;
      const asset = release.assets.find(asset => asset.name === name &&
        asset.browser_download_url === `https://github.com/Kesister/prompt-dock/releases/download/${release.tag_name}/${name}`);
      if (asset) return asset;
    }
  }
  return null;
}

async function latestMacRelease(fetch, arch, currentVersion) {
  const signal = AbortSignal.timeout(15000);
  let latest = null;
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(`${MAC_RELEASES_API}?per_page=100&page=${page}`, {
      signal, headers: { Accept: 'application/vnd.github+json' }
    });
    if (!response.ok) throw new Error('Unable to check Mac releases');
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error('Invalid Mac releases response');
    for (const release of releases) {
      const asset = macReleaseAsset(release, arch, currentVersion);
      const version = macReleaseVersion(release);
      if (asset && (!latest || semver.gt(version, latest.version))) {
        latest = { version, asset, notes: String(release.body || ''), tag: release.tag_name };
      }
    }
    if (!/rel="next"/.test(response.headers.get('link') || '')) return latest;
  }
  throw new Error('Mac release list exceeds the check limit');
}

// Reuse the shared update UI without pointing Mac users at Windows latest.yml.
// PKG releases are downloaded manually; no automatic installation is enabled.
class MacReleaseUpdater extends EventEmitter {
  constructor({ fetch, arch, currentVersion }) {
    super();
    Object.assign(this, { fetch, arch, currentVersion });
  }
  setFeedURL() {} // UpdateController configures the Windows feed; Mac owns its API.
  async checkForUpdates() {
    const release = await latestMacRelease(this.fetch, this.arch, this.currentVersion);
    if (release && semver.gt(release.version, this.currentVersion)) {
      this.emit('update-available', { version: release.version, releaseNotes: release.notes });
    } else this.emit('update-not-available');
  }
}

module.exports = { macReleaseAsset, macReleaseVersion, latestMacRelease, MacReleaseUpdater, MAC_INSTALL_MESSAGE };
