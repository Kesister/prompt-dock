const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') throw new Error('Build the slash helper on Windows.');
const root = path.resolve(__dirname, '..');
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const args = ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/out:' + path.join(root, 'assets', 'PromptDock.SlashHelper.exe'),
  '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
  ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(f => '/reference:' + path.join(framework, 'WPF', f)),
  path.join(root, 'assets', 'PromptDock.SlashHelper.cs')];
const result = spawnSync(path.join(framework, 'csc.exe'), args, { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status || 0;
