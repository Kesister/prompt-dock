const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');
const { version } = require('../package.json');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Only stable application versions can be published.');
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${version}`) throw new Error('Release tag must match package.json.');
const output = path.resolve(process.argv[2] || path.join(root, 'dist'));
const name = `Prompt-Dock-${version}-Setup.exe`;
const installer = fs.readFileSync(path.join(output, name));
const metadata = yaml.load(fs.readFileSync(path.join(output, 'latest.yml'), 'utf8'));
const sha512 = createHash('sha512').update(installer).digest('base64');
if (metadata.version !== version || !metadata.files.some(file => file.url === name && file.sha512 === sha512 && file.size === installer.length)) {
  throw new Error('Update metadata does not match the installer.');
}
fs.accessSync(path.join(output, `${name}.blockmap`));
const files = [name, `${name}.blockmap`, 'latest.yml'];
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), files.map(file => `${createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex')}  ${file}\n`).join(''));
const changelog = fs.readFileSync(path.join(root, 'docs', 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
const entry = changelog.split(`## ${version}\n`)[1]?.split('\n## ')[0]?.trim();
if (!entry) throw new Error('Add release notes to docs/CHANGELOG.md before publishing.');
fs.writeFileSync(path.join(output, 'RELEASE-NOTES.md'), `${entry}\n\n**下载与更新**\n\nWindows x64 请下载下方的 **${name}**。升级前建议备份资料，并从托盘退出旧版，再沿用原安装目录覆盖安装。原有资料会保留。\n\nv0.11.1 起也可在软件设置中检查更新。\n`);
console.log(`Release v${version} verified: installer, blockmap, latest.yml, SHA256SUMS.txt`);
