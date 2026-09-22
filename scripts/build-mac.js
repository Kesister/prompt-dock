const { execFileSync } = require('child_process');
const fs = require('fs');
if (process.platform !== 'darwin') throw new Error('Build on macOS');
fs.mkdirSync('build', { recursive: true });
execFileSync('xcrun', ['swiftc', '-module-cache-path', 'build/module-cache', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`, '-O', 'assets/PromptDock.MacHelper.swift', '-o', 'build/PromptDock.MacHelper'], { stdio: 'inherit' });
