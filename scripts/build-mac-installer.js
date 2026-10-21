// Wrap an already tested, signed app without changing its code signature.
// Usage: node scripts/build-mac-installer.js /absolute/Prompt\ Dock.app /absolute/output
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'darwin') throw Error('Build on macOS');
if (!process.argv[2] || !process.argv[3]) throw Error('Provide the tested .app and output directory');
const app = fs.realpathSync(process.argv[2]);
const output = path.resolve(process.argv[3]);
const repo = path.resolve(__dirname, '..');
const build = path.join(repo, 'build');
fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(output, { recursive: true });
const work = fs.mkdtempSync(path.join(build, 'mac-installer-'));
const log = path.join(work, 'build.log');
function run(command, args) {
  fs.appendFileSync(log, JSON.stringify({ command, args }) + '\n');
  try {
    const result = execFileSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    fs.appendFileSync(log, result);
    return result;
  } catch (error) {
    fs.appendFileSync(log, String(error.stdout || '') + String(error.stderr || ''));
    throw error;
  }
}
function plist(file) { return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file])); }
function writePlist(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
  run('/usr/bin/plutil', ['-convert', 'xml1', file]);
}
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function tree(root, current = root) {
  return fs.readdirSync(current).sort().flatMap(name => {
    const file = path.join(current, name), relative = path.relative(root, file), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return [{ path: relative, link: fs.readlinkSync(file) }];
    if (stat.isDirectory()) return tree(root, file);
    return [{ path: relative, sha256: hash(file), mode: stat.mode & 0o777 }];
  });
}
function page(title, content) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:#252525;line-height:1.65;padding:12px 16px}h1{font-size:23px}h2{font-size:16px}li{margin-bottom:8px}</style><h1>${title}</h1>${content}</html>`;
}

const info = plist(path.join(app, 'Contents/Info.plist'));
const version = info.CFBundleShortVersionString;
if (info.CFBundleIdentifier !== 'com.codex.promptdock' || !/^\d+\.\d+\.\d+$/.test(version)) throw Error('Unexpected application identity or version');
const arch = run('/usr/bin/lipo', ['-archs', path.join(app, 'Contents/MacOS', info.CFBundleExecutable)]).trim();
if (arch !== 'arm64') throw Error('This installer targets the tested Apple Silicon app');
if (run('/usr/bin/lipo', ['-archs', path.join(app, 'Contents/Resources/PromptDock.MacHelper')]).trim() !== arch) throw Error('Native helper architecture mismatch');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const packageFile = path.join(output, `Prompt-Dock-${version}-mac-${arch}.pkg`);
if (fs.existsSync(packageFile)) throw Error(`Output already exists: ${packageFile}`);
const payload = path.join(work, 'payload');
const staged = path.join(payload, 'Applications/Prompt Dock.app');
fs.mkdirSync(path.dirname(staged), { recursive: true });
run('/usr/bin/ditto', [app, staged]);
const componentPlist = path.join(work, 'components.plist');
run('/usr/bin/pkgbuild', ['--analyze', '--root', payload, componentPlist]);
const components = plist(componentPlist);
if (components.length !== 1 || components[0].RootRelativeBundlePath !== 'Applications/Prompt Dock.app') throw Error('Unexpected installer payload');
function configure(bundle) {
  bundle.BundleIsRelocatable = false;
  bundle.BundleHasStrictIdentifier = true;
  bundle.BundleIsVersionChecked = true;
  bundle.BundleOverwriteAction = 'upgrade';
  for (const child of bundle.ChildBundles || []) configure(child);
}
components.forEach(configure);
writePlist(componentPlist, components);
const component = path.join(work, 'PromptDock.component.pkg');
run('/usr/bin/pkgbuild', ['--root', payload, '--component-plist', componentPlist, '--identifier', 'com.codex.promptdock.pkg', '--version', version, '--install-location', '/', '--ownership', 'recommended', component]);
const requirements = path.join(work, 'requirements.plist');
// The Swift helper is built with a macOS 12 deployment target.
writePlist(requirements, { os: ['12.0'], arch: [arch] });
const distribution = path.join(work, 'distribution.xml');
run('/usr/bin/productbuild', ['--synthesize', '--product', requirements, '--package', component, distribution]);
let xml = fs.readFileSync(distribution, 'utf8');
const root = xml.match(/<installer-gui-script\b[^>]*>/)?.[0];
if (!root) throw Error('Missing Installer distribution root');
xml = xml.replace(/\s*<title>[^<]*<\/title>/, '');
xml = xml.replace(root, root + `\n<title>Prompt Dock ${version}</title>\n<welcome file="welcome.html" mime-type="text/html"/>\n<readme file="readme.html" mime-type="text/html"/>\n<conclusion file="conclusion.html" mime-type="text/html"/>\n<domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>`);
fs.writeFileSync(distribution, xml);
const resources = path.join(work, 'resources');
fs.mkdirSync(resources);
fs.writeFileSync(path.join(resources, 'welcome.html'), page(`安装 Prompt Dock ${version}`, '<p>完整的 Mac 桌面应用，适用于 Apple Silicon（M 系列芯片），macOS 12 或更高版本。</p><p>请先退出正在运行的 Prompt Dock，再继续安装。</p><p>安装位置：<b>应用程序 → Prompt Dock</b></p><p>内含完整运行环境和原生粘贴助手。安装后可直接打开应用，无需启动脚本、Node.js 或命令行。</p>'));
fs.writeFileSync(path.join(resources, 'readme.html'), page('安装与使用', '<h2>资料保存</h2><p>安装只替换应用程序。已有的 Prompt、图片、设置和备份保存在各自的用户资料目录中，不包含在安装包里，也不会被安装程序删除或重置。</p><h2>直接粘贴</h2><p>在目标软件中先点输入框，再选择 Prompt。快捷浮窗可在设置中开启，默认 ⌘⇧Space 唤出、Tab 确认。</p><p>若系统要求授权，请在应用设置的「Mac 直接粘贴权限」中检查，按提示为「应用程序」里的 Prompt Dock 开启辅助功能。</p><h2>版本说明</h2><p>本版本改进了浏览器输入框识别和选中文字替换，并保持快捷浮窗快速响应。</p><p>当前安装包未进行 Apple Developer ID 签名及公证，内置自动安装更新暂不可用，请通过项目发布页下载安装更新。</p>'));
fs.writeFileSync(path.join(resources, 'conclusion.html'), page('Prompt Dock 已安装', '<p>现在可以关闭安装器，在<b>应用程序</b>中打开 <b>Prompt Dock</b>。</p><p>也可以使用聚焦搜索「Prompt Dock」打开应用。</p><p>如果直接粘贴需要权限，请打开应用设置 → Mac 直接粘贴权限，按提示完成系统授权。</p>'));
run('/usr/bin/productbuild', ['--distribution', distribution, '--resources', resources, '--package-path', work, packageFile]);
const expanded = path.join(work, 'expanded');
run('/usr/sbin/pkgutil', ['--expand-full', packageFile, expanded]);
const installed = path.join(expanded, 'PromptDock.component.pkg/Payload/Applications/Prompt Dock.app');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
if (JSON.stringify(tree(app)) !== JSON.stringify(tree(installed))) throw Error('Expanded installer application differs from the tested app');
const evidence = path.join(output, 'evidence');
fs.mkdirSync(evidence, { recursive: true });
for (const name of ['build.log', 'components.plist', 'distribution.xml', 'requirements.plist']) fs.copyFileSync(path.join(work, name), path.join(evidence, name));
const manifest = { version, buildVersion: info.CFBundleVersion, arch, minimumMacOS: '12.0', inputApp: app, installPath: '/Applications/Prompt Dock.app', package: path.basename(packageFile), sha256: hash(packageFile), bytes: fs.statSync(packageFile).size, payloadMatchesTestedApp: true, appSignatureIntegrity: true, installerSigned: false, notarized: false, installScripts: false, relocatable: false, modifiesUserProfile: false, actualSystemInstallPerformed: false, work };
fs.writeFileSync(path.join(output, 'installer-verification.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ package: packageFile, sha256: manifest.sha256, bytes: manifest.bytes, verification: path.join(output, 'installer-verification.json') }, null, 2));
