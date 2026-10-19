# v0.11.0 Windows installer verification — 2026-10-19

## Scope

Based on the approved v0.11.0-beta.9, restore the rounded outlined badge around “Prompt Dock 作者”. Preserve the official Notion SVG and all production functionality. Publish a local Windows x64 NSIS installer, not a new portable build or a GitHub release.

Baseline snapshot: `../prompt-launcher-history/beta9-before-installer-20261019`.

The badge has a 1 px warm border, 6 px radius and 3 px / 8 px padding. Its identity row can wrap in a small window. Package and lockfile versions are now `0.11.0`. The changes in `main.js` are smoke-test assertions, diagnostics and a 220 ms screenshot compositor wait only.

## Preservation and data safety

- Byte-for-byte baseline comparisons passed for `author-links.js`, `preload.js`, `renderer.js`, `storage.js`, `index.html`, all seven quick-invocation source files, the app icon and the native quick-invocation/focus helper sources and executables. The WinHelper executable is unchanged. Native helpers were not rebuilt.
- App identity remains `prompt-dock` / `com.codex.promptdock` / `Prompt Dock`. Normal user-data location behavior is unchanged.
- NSIS remains a per-user installation wizard, with directory selection and desktop/start-menu shortcuts. `deleteAppDataOnUninstall` is false. The local builder implementation sets its deletion define only when this option is true; its uninstall template otherwise preserves data unless an explicit `--delete-app-data` flag is supplied. Manual deletion or external cleanup can still remove data.
- The package whitelist includes only reviewed program source and assets. No personal library, database, backup, QR image, test scripts or test profiles were included. Fresh users receive the existing generic built-in examples, not the author's content.
- No installer or uninstaller was executed against the real user profile. Testing used isolated synthetic profiles. No personal library was read or modified, and no upload or external form submission was performed.
- The previous beta.9 portable remains unchanged: SHA-256 `3887289f95f225bbbdfde29cd1e35ce2b1d6abb10870e37369f486d5a480a65e`.

## Verification

- `node --test tests/installer-config.test.js tests/author-links.test.js tests/slash-core.test.js`: 16/16 passed.
- `node --check main.js` and `git diff --check`: passed (pre-existing line-ending warning only).
- Source smoke: all 170 top-level boolean checks passed using an isolated temporary profile.
- Final packaged executable smoke: all 170 top-level boolean checks passed using another isolated temporary profile.
- The badge assertion initially required an exact computed `1px` border. Windows display scaling computes this as `0.666667px`; the test now accepts a positive thin border while the static unit test still requires the intended 1 px source rule. This was a test precision correction, not a production behavior change.
- Author badge and small-window layout were visually inspected. The final packaged compact screenshot shows the restored frame and v0.11.0. Header/footer bounds, scrolling and reopen-at-top assertions passed.
- All 14 packaged top-level JS/HTML/CSS files match workspace source; packaged version is 0.11.0. All three unpacked native executables match the unchanged release helpers.
- Final NSIS build completed successfully. A read-only `7z t` check of the actual Setup.exe reported `Everything is Ok` (10 archive files). This validates archive integrity, not a full install/uninstall round-trip.
- Installer product version is 0.11.0. Authenticode status is `NotSigned`; Windows may show an unknown publisher warning.

## Artifact

`dist-v0.11.0-installer/Prompt-Dock-0.11.0-Setup.exe`

- Bytes: 93,233,474
- SHA-256: `a284dba33b05f5b3771d66f74097f8c7b1ae3370e710e6230efade74c0fbdd89`
- Preview: `dist-v0.11.0-installer/author-page-preview.png`

Before installing, export a backup as a precaution and exit the old application from its tray menu. This build does not install itself or remove earlier portable packages.
