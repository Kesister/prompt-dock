const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const semver = require('semver');

function signingStatus(executable) {
  const bundle = path.resolve(executable, '../../..');
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe', timeout: 15000 });
    const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { encoding: 'utf8', timeout: 5000 });
    const signed = result.status === 0 && /^Authority=Developer ID Application:/m.test(result.stderr)
      && /^TeamIdentifier=(?!not set)\S+/m.test(result.stderr);
    return { signed, message: signed ? '' : '此本地试用包使用临时签名，自动安装更新尚不可用。正式签名和公证后才能验收完整更新流程。' };
  } catch {
    return { signed: false, message: '未能验证应用的正式签名，本次只提供版本检查，自动安装更新尚不可用。' };
  }
}

function macReleaseAsset(release, arch, currentVersion) {
  const version = semver.valid(String(release?.tag_name || '').replace(/^v/, ''));
  if (release?.draft || release?.prerelease || !version || semver.prerelease(version) || semver.lt(version, currentVersion)) return null;
  return release.assets?.find(asset => {
    if (!new RegExp(`^Prompt-Dock-${version.replace(/\./g, '\\.')}-(?:mac-${arch}|mac-universal)\\.dmg$`).test(asset.name)) return false;
    return asset.browser_download_url === `https://github.com/Kesister/prompt-dock/releases/download/${release.tag_name}/${asset.name}`;
  }) || null;
}

module.exports = { signingStatus, macReleaseAsset };
