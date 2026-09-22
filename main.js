const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, Tray, nativeImage, net, protocol, screen, session, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn } = require("child_process");
const { createHash, randomUUID } = require("crypto");
const AdmZip = require("adm-zip");
const { IMAGE_SCHEME, PromptStorage, decodeDataImage, parseAssetUrl } = require("./storage");

let mainWindow;
let tray;
let activeShortcut = "";
let normalWindowBounds = null;
let pasteQueue = Promise.resolve();
let storage;
const IS_MAC = process.platform === "darwin";
const DEFAULT_SHORTCUT = IS_MAC ? "Command+Alt+P" : "Control+Alt+P";
let macHelper;
let macReply;
let macPermissionNoticeShown = false;
let windowSaveTimer;
let windowMode = false;
const MAX_PROMPT_IMAGES = 6;
const MAX_SOURCE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1600;
const SMOKE_TEST = process.env.PROMPT_DOCK_SMOKE_TEST === "1";
const testProfile = process.env.PROMPT_DOCK_USER_DATA;
if (testProfile) {
  if (!path.isAbsolute(testProfile)) throw new Error("PROMPT_DOCK_USER_DATA must be absolute");
  app.setPath("userData", testProfile);
}
if (SMOKE_TEST) {
  app.disableHardwareAcceleration();
  if (!testProfile) app.setPath("userData", path.join(app.getPath("temp"), `prompt-dock-smoke-test-${randomUUID()}`));
  process.on("unhandledRejection", (error) => {
    console.error(`SMOKE_FAIL:${error?.stack || error}`);
    app.exit(2);
  });
}
// Acquire the profile lock before opening storage or registering shortcuts.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
let pendingSecondLaunch = false;
app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingSecondLaunch = true;
    return;
  }
  revealLauncher();
});
protocol.registerSchemesAsPrivileged([{
  scheme: IMAGE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

function getStorage() {
  if (!storage) storage = new PromptStorage({
    userDataPath: app.getPath("userData"),
    initialState,
    nativeImage,
    hasTransparency: nativeImageHasTransparency,
    maxPromptImages: MAX_PROMPT_IMAGES
  });
  return storage;
}

function initialState() {
  const now = new Date().toISOString();
  return {
    settings: {
      shortcut: DEFAULT_SHORTCUT,
      newPromptShortcut: IS_MAC ? "Command+N" : "Control+N",
      directPaste: true,
      launchAtLogin: false,
      alwaysOnTop: false,
      leftCollapsed: false,
      rightCollapsed: false,
      compactMode: false,
      compactWindowSize: { width: 420, height: 520 },
      alwaysOnTopBeforeCompact: false,
      backupDirectory: "",
      lastBackupAt: "",
      privacyMode: false,
      privacyHideImages: false,
      collapsedTagGroups: [],
      paneWidths: { left: 190, right: null }
    },
    vocabulary: {
      collections: [{ id: "default", name: "默认词库", createdAt: now }],
      entries: [],
      settings: { separator: "comma" }
    },
    prompts: [
      {
        id: crypto.randomUUID(),
        title: "文章润色",
        content: "请润色我接下来提供的内容，使表达自然、结构清晰。保留原意，不要添加未经证实的信息。",
        usageNote: "适合已经有初稿、希望保留原意的文本；如有固定语气或字数要求，请在粘贴正文后继续补充。",
        tags: ["写作", "常用"],
        favorite: true,
        images: [],
        useCount: 0,
        createdAt: now,
        updatedAt: now
      },
      {
        id: crypto.randomUUID(),
        title: "代码审查",
        content: "请审查我接下来提供的代码，重点检查：正确性、安全性、边界条件和可维护性。先列出问题，再给出最小修改方案。",
        tags: ["编程"],
        favorite: false,
        images: [],
        useCount: 0,
        createdAt: now,
        updatedAt: now
      }
    ]
  };
}

function readState() {
  return getStorage().readState();
}

function normalizeStoredPrompt(prompt) {
  const legacyImage = typeof prompt?.image === "string" && prompt.image ? [prompt.image] : [];
  const images = (Array.isArray(prompt?.images) ? prompt.images : legacyImage)
    .filter((image) => typeof image === "string" && (image.startsWith("data:image/") || parseAssetUrl(image)))
    .slice(0, MAX_PROMPT_IMAGES);
  const { image, ...rest } = prompt || {};
  return { ...rest, images };
}

function writeState(state) {
  return getStorage().writeState(state);
}

function localDateStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTimeStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${localDateStamp(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function safeFileName(value, fallback = "Prompt图片") {
  const cleaned = String(value || "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim().replace(/[. ]+$/g, "");
  return cleaned.slice(0, 80) || fallback;
}

function nativeImageHasTransparency(image) {
  const bitmap = image.toBitmap();
  for (let index = 3; index < bitmap.length; index += 4) {
    if (bitmap[index] < 255) return true;
  }
  return false;
}

function optimizeNativeImage(image, preferPng = false) {
  if (!image || image.isEmpty()) throw new Error("无法读取图片");
  const original = image.getSize();
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(original.width, original.height));
  const optimized = scale < 1
    ? image.resize({
      width: Math.max(1, Math.round(original.width * scale)),
      height: Math.max(1, Math.round(original.height * scale)),
      quality: "best"
    })
    : image;
  const usePng = preferPng || nativeImageHasTransparency(optimized);
  const mime = usePng ? "png" : "jpeg";
  const buffer = usePng ? optimized.toPNG() : optimized.toJPEG(85);
  return `data:image/${mime};base64,${buffer.toString("base64")}`;
}

function optimizeImageBuffer(buffer) {
  if (!buffer?.length) throw new Error("图片文件为空");
  if (buffer.length > MAX_SOURCE_IMAGE_BYTES) throw new Error("单张图片不能超过 5 MB");
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return optimizeNativeImage(nativeImage.createFromBuffer(buffer), isPng);
}

function importImageBuffers(buffers) {
  const images = [];
  const errors = [];
  for (const raw of (Array.isArray(buffers) ? buffers : []).slice(0, MAX_PROMPT_IMAGES)) {
    try {
      images.push(optimizeImageBuffer(Buffer.from(raw)));
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { images, errors };
}

function createPromptDockArchive(state, destination) {
  const zip = new AdmZip();
  const addedImages = new Set();
  const prompts = state.prompts.map((prompt) => {
    const { imageThumbnails, ...exported } = prompt;
    exported.images = [];
    exported.imageRefs = (prompt.images || []).map((source) => {
      const image = getStorage().resolveImageSource(source);
      if (!image) return "";
      const hash = image.hash || createHash("sha256").update(image.buffer).digest("hex");
      const imageRef = `images/${hash}.${image.extension}`;
      if (!addedImages.has(imageRef)) {
        zip.addFile(imageRef, image.buffer);
        addedImages.add(imageRef);
      }
      return imageRef;
    }).filter(Boolean);
    return exported;
  });
  const manifest = {
    format: "prompt-dock",
    formatVersion: 4,
    appVersion: app.getVersion(),
    exportedAt: new Date().toISOString(),
    prompts,
    vocabulary: normalizeVocabulary(state.vocabulary)
  };
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  zip.writeZip(destination);
}

function promptContentHash(prompt) {
  const normalized = [
    String(prompt.title || "").trim().toLocaleLowerCase(),
    String(prompt.content || "").trim().replace(/\s+/g, " "),
    ...(Array.isArray(prompt.variants) ? prompt.variants : []).map((variant) =>
      `${String(variant.title || "").trim().toLocaleLowerCase()}\n${String(variant.content || "").trim().replace(/\s+/g, " ")}`
    )
  ].join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

function promptFullHash(prompt) {
  const normalized = {
    title: String(prompt.title || "").trim(),
    defaultVariantTitle: String(prompt.defaultVariantTitle || "默认版本").trim(),
    content: String(prompt.content || "").trim(),
    usageNote: String(prompt.usageNote || "").trim(),
    tags: [...new Set(Array.isArray(prompt.tags) ? prompt.tags : [])].sort(),
    favorite: Boolean(prompt.favorite),
    deletedAt: typeof prompt.deletedAt === "string" && prompt.deletedAt ? prompt.deletedAt : undefined,
    images: (prompt.images || []).map((image) => getStorage().imageContentKey(image)),
    variants: (Array.isArray(prompt.variants) ? prompt.variants : []).map((variant) => ({
      id: String(variant.id || ""),
      title: String(variant.title || "").trim(),
      content: String(variant.content || "").trim()
    }))
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function libraryFingerprint(prompts) {
  const compact = prompts.map((prompt) => ({
    id: prompt.id,
    full: promptFullHash(prompt)
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return createHash("sha256").update(JSON.stringify(compact)).digest("hex");
}

function normalizeVocabulary(value) {
  const now = new Date().toISOString();
  const collections = [];
  const collectionIds = new Set();
  for (const raw of (Array.isArray(value?.collections) ? value.collections : [])) {
    const name = String(raw?.name || "").trim();
    if (!name) continue;
    const id = String(raw?.id || randomUUID());
    if (collectionIds.has(id)) continue;
    collectionIds.add(id);
    collections.push({ id, name: name.slice(0, 40), createdAt: String(raw?.createdAt || now) });
  }
  if (!collections.length) {
    collections.push({ id: "default", name: "默认词库", createdAt: now });
    collectionIds.add("default");
  }
  const fallbackId = collections[0].id;
  const entries = [];
  const entryIds = new Set();
  for (const raw of (Array.isArray(value?.entries) ? value.entries : [])) {
    const text = String(raw?.text || "").trim();
    if (!text) continue;
    const id = String(raw?.id || randomUUID());
    if (entryIds.has(id)) continue;
    entryIds.add(id);
    entries.push({
      id,
      text: text.slice(0, 500),
      collectionId: collectionIds.has(String(raw?.collectionId || "")) ? String(raw.collectionId) : fallbackId,
      favorite: Boolean(raw?.favorite),
      useCount: Math.max(0, Number(raw?.useCount) || 0),
      lastUsed: typeof raw?.lastUsed === "string" ? raw.lastUsed : undefined,
      createdAt: String(raw?.createdAt || now),
      updatedAt: String(raw?.updatedAt || raw?.createdAt || now)
    });
  }
  const separator = ["comma", "space", "newline"].includes(value?.settings?.separator)
    ? value.settings.separator
    : "comma";
  return { collections, entries, settings: { separator } };
}

function vocabularyFingerprint(vocabulary) {
  const normalized = normalizeVocabulary(vocabulary);
  const compact = {
    collections: normalized.collections.map(({ id, name }) => ({ id, name })),
    entries: normalized.entries.map(({ id, text, collectionId, favorite }) => ({ id, text, collectionId, favorite }))
  };
  return createHash("sha256").update(JSON.stringify(compact)).digest("hex");
}

function mergeVocabulary(localValue, incomingValue) {
  const local = normalizeVocabulary(localValue);
  if (!incomingValue) {
    return {
      vocabulary: local,
      summary: { vocabularyEntriesAdded: 0, vocabularyCollectionsAdded: 0 }
    };
  }
  const incoming = normalizeVocabulary(incomingValue);
  const collectionByName = new Map(local.collections.map((item) => [item.name.toLocaleLowerCase(), item]));
  const collectionMap = new Map();
  let collectionsAdded = 0;
  for (const incomingCollection of incoming.collections) {
    let target = collectionByName.get(incomingCollection.name.toLocaleLowerCase());
    if (!target) {
      target = { ...incomingCollection, id: randomUUID() };
      local.collections.push(target);
      collectionByName.set(target.name.toLocaleLowerCase(), target);
      collectionsAdded += 1;
    }
    collectionMap.set(incomingCollection.id, target.id);
  }
  const keys = new Set(local.entries.map((entry) => `${entry.collectionId}\n${entry.text.trim().toLocaleLowerCase()}`));
  let entriesAdded = 0;
  for (const incomingEntry of incoming.entries) {
    const collectionId = collectionMap.get(incomingEntry.collectionId) || local.collections[0].id;
    const key = `${collectionId}\n${incomingEntry.text.trim().toLocaleLowerCase()}`;
    if (keys.has(key)) continue;
    keys.add(key);
    local.entries.push({ ...incomingEntry, id: randomUUID(), collectionId });
    entriesAdded += 1;
  }
  return { vocabulary: local, summary: { vocabularyEntriesAdded: entriesAdded, vocabularyCollectionsAdded: collectionsAdded } };
}

function pruneAutomaticBackups(directory) {
  if (!directory || !fs.existsSync(directory)) return;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 2);
  for (const name of fs.readdirSync(directory)) {
    if (!/^Prompt-Dock-auto-.*\.promptdock$/i.test(name)) continue;
    const filePath = path.join(directory, name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff.getTime()) fs.unlinkSync(filePath);
    } catch {}
  }
}

function createAutomaticBackup(state, reason = "daily") {
  const directory = String(state.settings.backupDirectory || "").trim();
  if (!directory) return { ok: false, skipped: true, message: "尚未设置备份路径" };
  fs.mkdirSync(directory, { recursive: true });
  const suffix = reason === "before-import"
    ? `${localTimeStamp()}-before-import`
    : localDateStamp();
  const destination = path.join(directory, `Prompt-Dock-auto-${suffix}.promptdock`);
  try {
    const disk = fs.statfsSync(directory);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    const imageBytes = getStorage().getStats().imageBytes;
    const metadataBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    const existingBytes = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
    const requiredBytes = Math.max(50 * 1024 * 1024, Math.ceil((imageBytes + metadataBytes) * 1.15));
    if (availableBytes + existingBytes < requiredBytes) {
      throw new Error(`备份磁盘空间不足，至少需要约 ${Math.ceil(requiredBytes / 1024 / 1024)} MB 可用空间`);
    }
  } catch (error) {
    if (/空间不足/.test(error.message)) throw error;
  }
  createPromptDockArchive(state, destination);
  pruneAutomaticBackups(directory);
  return { ok: true, path: destination, at: new Date().toISOString() };
}

function sanitizeImportedPrompt(prompt) {
  const now = new Date().toISOString();
  return normalizeStoredPrompt({
    id: typeof prompt.id === "string" && prompt.id ? prompt.id : randomUUID(),
    title: String(prompt.title || "未命名 Prompt"),
    defaultVariantTitle: String(prompt.defaultVariantTitle || "默认版本"),
    content: String(prompt.content || ""),
    usageNote: String(prompt.usageNote || ""),
    tags: [...new Set(Array.isArray(prompt.tags) ? prompt.tags.map(String) : [])],
    images: Array.isArray(prompt.images) ? prompt.images : undefined,
    image: typeof prompt.image === "string" ? prompt.image : "",
    favorite: Boolean(prompt.favorite),
    useCount: Number.isFinite(prompt.useCount) ? prompt.useCount : 0,
    lastUsed: typeof prompt.lastUsed === "string" ? prompt.lastUsed : undefined,
    createdAt: typeof prompt.createdAt === "string" ? prompt.createdAt : now,
    updatedAt: typeof prompt.updatedAt === "string" ? prompt.updatedAt : "",
    deletedAt: typeof prompt.deletedAt === "string" && prompt.deletedAt ? prompt.deletedAt : undefined,
    variants: (Array.isArray(prompt.variants) ? prompt.variants : []).map((variant, index) => ({
      id: typeof variant.id === "string" && variant.id ? variant.id : randomUUID(),
      title: String(variant.title || `变体 ${index + 1}`),
      content: String(variant.content || ""),
      useCount: Number.isFinite(variant.useCount) ? variant.useCount : 0,
      lastUsed: typeof variant.lastUsed === "string" ? variant.lastUsed : undefined,
      createdAt: typeof variant.createdAt === "string" ? variant.createdAt : now,
      updatedAt: typeof variant.updatedAt === "string" ? variant.updatedAt : now
    })).filter((variant) => variant.content.trim())
  });
}

function loadPromptDockFile(filePath) {
  if (path.extname(filePath).toLowerCase() === ".json") {
    const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(legacy.prompts)) throw new Error("文件中没有 Prompt 库");
    return {
      prompts: legacy.prompts.map(sanitizeImportedPrompt),
      vocabulary: legacy.vocabulary ? normalizeVocabulary(legacy.vocabulary) : null
    };
  }
  const zip = new AdmZip(filePath);
  const manifestEntry = zip.getEntry("manifest.json");
  if (!manifestEntry) throw new Error("缺少 manifest.json");
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
  if (manifest.format !== "prompt-dock" || !Array.isArray(manifest.prompts)) {
    throw new Error("不是有效的 Prompt Dock 备份");
  }
  const prompts = manifest.prompts.map((rawPrompt) => {
    const prompt = sanitizeImportedPrompt(rawPrompt);
    const imageRefs = Array.isArray(rawPrompt.imageRefs)
      ? rawPrompt.imageRefs
      : rawPrompt.imageRef ? [rawPrompt.imageRef] : [];
    prompt.images = imageRefs.slice(0, MAX_PROMPT_IMAGES).flatMap((imageRef) => {
      const imageEntry = zip.getEntry(String(imageRef));
      if (imageEntry) {
        const extension = path.extname(String(imageRef)).slice(1).toLowerCase();
        const mime = extension === "jpg" ? "jpeg" : extension;
        return [`data:image/${mime};base64,${imageEntry.getData().toString("base64")}`];
      }
      return [];
    });
    return prompt;
  });
  return {
    prompts,
    vocabulary: manifest.vocabulary ? normalizeVocabulary(manifest.vocabulary) : null
  };
}

function mergeImportedPrompts(localPrompts, incomingPrompts) {
  const merged = localPrompts.map((prompt) => ({ ...prompt }));
  const byId = new Map(merged.map((prompt, index) => [prompt.id, index]));
  const byContent = new Map(merged.map((prompt, index) => [promptContentHash(prompt), index]));
  const conflicts = [];
  const summary = { added: 0, updated: 0, skipped: 0, deduplicated: 0, conflicts: 0 };

  for (const incoming of incomingPrompts) {
    const sameIdIndex = byId.get(incoming.id);
    if (sameIdIndex !== undefined) {
      const local = merged[sameIdIndex];
      if (promptFullHash(local) === promptFullHash(incoming)) {
        summary.skipped += 1;
        continue;
      }
      const localTime = Date.parse(local.updatedAt || "");
      const incomingTime = Date.parse(incoming.updatedAt || "");
      if (Number.isFinite(localTime) && Number.isFinite(incomingTime) && incomingTime !== localTime) {
        if (incomingTime > localTime) {
          merged[sameIdIndex] = { ...incoming, useCount: Math.max(local.useCount || 0, incoming.useCount || 0) };
          byContent.delete(promptContentHash(local));
          byContent.set(promptContentHash(incoming), sameIdIndex);
          summary.updated += 1;
        } else {
          summary.skipped += 1;
        }
      } else {
        conflicts.push({ index: sameIdIndex, local, incoming });
      }
      continue;
    }

    const contentHash = promptContentHash(incoming);
    const duplicateIndex = byContent.get(contentHash);
    if (duplicateIndex !== undefined) {
      const local = merged[duplicateIndex];
      local.tags = [...new Set([...(local.tags || []), ...(incoming.tags || [])])];
      local.favorite = Boolean(local.favorite || incoming.favorite);
      if (!local.defaultVariantTitle && incoming.defaultVariantTitle) local.defaultVariantTitle = incoming.defaultVariantTitle;
      if (!local.usageNote && incoming.usageNote) local.usageNote = incoming.usageNote;
      if (!(local.images || []).length && (incoming.images || []).length) local.images = [...incoming.images];
      summary.deduplicated += 1;
      continue;
    }

    const nextIndex = merged.length;
    merged.push(incoming);
    byId.set(incoming.id, nextIndex);
    byContent.set(contentHash, nextIndex);
    summary.added += 1;
  }
  summary.conflicts = conflicts.length;
  return { merged, conflicts, summary };
}

function nativeHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "assets", "PromptDock.WinHelper.exe")
    : path.join(__dirname, "assets", "PromptDock.WinHelper.exe");
}

function runNativeHelper(args) {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(nativeHelperPath(), args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(output.trim()));
  });
}

async function showLauncher() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }
  revealLauncher();
}

function revealLauncher() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  ensureWindowOnScreen();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("launcher:focus-search");
}

function ensureWindowOnScreen() {
  const bounds = mainWindow.getBounds();
  const visible = screen.getAllDisplays().some(({ workArea }) => {
    const overlapWidth = Math.max(0, Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x));
    const overlapHeight = Math.max(0, Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y));
    return overlapWidth >= 120 && overlapHeight >= 80;
  });
  if (visible) return;
  const { workArea } = screen.getPrimaryDisplay();
  mainWindow.setBounds({
    x: workArea.x + Math.max(0, Math.round((workArea.width - bounds.width) / 2)),
    y: workArea.y + Math.max(0, Math.round((workArea.height - bounds.height) / 2)),
    width: Math.min(bounds.width, workArea.width),
    height: Math.min(bounds.height, workArea.height)
  });
}

function registerShortcut(shortcut) {
  if (!shortcut || typeof shortcut !== "string") {
    return { ok: false, message: "快捷键格式无效" };
  }
  if (shortcut === activeShortcut) return { ok: true, shortcut };
  let ok = false;
  try { ok = globalShortcut.register(shortcut, showLauncher); } catch {}
  if (!ok) return { ok: false, message: "快捷键无效或已被其他程序占用，请换一个组合。" };
  if (activeShortcut) globalShortcut.unregister(activeShortcut);
  activeShortcut = shortcut;
  return { ok: true, shortcut };
}

function createWindow() {
  const settings = readState().settings;
  const compactMode = Boolean(settings.compactMode);
  windowMode = compactMode;
  normalWindowBounds = settings.normalWindowBounds || null;
  const savedCompactSize = settings.compactWindowSize || {};
  const initialCompactWidth = Math.max(360, Number(savedCompactSize.width) || 420);
  const initialCompactHeight = Math.max(360, Number(savedCompactSize.height) || 520);
  mainWindow = new BrowserWindow({
    width: compactMode ? initialCompactWidth : Math.max(840, normalWindowBounds?.width || 1080),
    height: compactMode ? initialCompactHeight : Math.max(560, normalWindowBounds?.height || 700),
    minWidth: compactMode ? 360 : 840,
    minHeight: compactMode ? 360 : 560,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: "#f6f2ea",
    icon: path.join(__dirname, "assets", "logo.png"),
    alwaysOnTop: Boolean(settings.alwaysOnTop || compactMode),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (testProfile) mainWindow.on("page-title-updated", event => { event.preventDefault(); mainWindow.setTitle("Prompt Dock — 隔离测试"); });
  mainWindow.loadFile("index.html");
  mainWindow.on("resize", scheduleWindowSave);
  mainWindow.once("ready-to-show", () => {
    ensureWindowOnScreen();
    if (!SMOKE_TEST) mainWindow.show();
    if (pendingSecondLaunch) {
      pendingSecondLaunch = false;
      revealLauncher();
    }
  });
  mainWindow.webContents.once("did-finish-load", async () => {
    if (!SMOKE_TEST) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const backupVerification = process.env.PROMPT_DOCK_TEST_BACKUP
      ? require("./scripts/verify-backup")({ loadPromptDockFile, readState, writeState, mergeImportedPrompts, mergeVocabulary, createPromptDockArchive }, process.env.PROMPT_DOCK_TEST_BACKUP, app.getPath("userData")) : null;
    const stableFocusableWindow = mainWindow.isFocusable();
    const smokeState = readState();
    const smokeBackupDirectory = path.join(app.getPath("userData"), "backup-smoke");
    fs.mkdirSync(smokeBackupDirectory, { recursive: true });
    const archiveState = JSON.parse(JSON.stringify(smokeState));
    archiveState.vocabulary.entries.push({
      id: "archive-word",
      text: "电影感",
      collectionId: archiveState.vocabulary.collections[0].id,
      favorite: true,
      useCount: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const smokeImageData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const smokePortraitBitmap = Buffer.alloc(200 * 400 * 4);
    for (let index = 0; index < smokePortraitBitmap.length; index += 4) {
      smokePortraitBitmap[index] = 80;
      smokePortraitBitmap[index + 1] = 115;
      smokePortraitBitmap[index + 2] = 200;
      smokePortraitBitmap[index + 3] = 255;
    }
    const smokePortraitData = nativeImage.createFromBitmap(smokePortraitBitmap, { width: 200, height: 400, scaleFactor: 1 }).toDataURL();
    const migrationDirectory = path.join(app.getPath("userData"), `migration-smoke-${randomUUID()}`);
    fs.mkdirSync(migrationDirectory, { recursive: true });
    const legacyMigrationState = initialState();
    legacyMigrationState.prompts = [{ ...legacyMigrationState.prompts[0], images: [smokeImageData] }];
    fs.writeFileSync(path.join(migrationDirectory, "prompt-dock.json"), JSON.stringify(legacyMigrationState), "utf8");
    const migrationStorage = new PromptStorage({
      userDataPath: migrationDirectory,
      initialState,
      nativeImage,
      hasTransparency: nativeImageHasTransparency,
      maxPromptImages: MAX_PROMPT_IMAGES
    });
    const migratedState = migrationStorage.readState();
    const sqliteLegacyMigration = fs.existsSync(path.join(migrationDirectory, "prompt-dock.sqlite"))
      && migratedState.prompts[0].images[0].startsWith(`${IMAGE_SCHEME}://`)
      && migratedState.prompts[0].imageThumbnails[0].startsWith(`${IMAGE_SCHEME}://`)
      && migrationStorage.getMigrationInfo().backups.some((backup) => fs.existsSync(backup));
    migratedState.prompts.push({ ...migratedState.prompts[0], id: randomUUID() });
    const deduplicatedImageState = migrationStorage.writeState(migratedState);
    const externalImageDeduplication = migrationStorage.getStats().imageCount === 1
      && deduplicatedImageState.prompts.every((prompt) => prompt.images[0] === deduplicatedImageState.prompts[0].images[0]);
    deduplicatedImageState.prompts = [];
    migrationStorage.writeState(deduplicatedImageState);
    const orphanImageCleanup = migrationStorage.getStats().imageCount === 0;
    const bulkState = { settings: initialState().settings, prompts: Array.from({ length: 1200 }, (_, index) => ({
      id: randomUUID(),
      title: `批量测试 ${index + 1}`,
      content: `这是第 ${index + 1} 条数据库批量测试 Prompt。`,
      tags: ["批量"],
      favorite: false,
      images: [],
      variants: [],
      useCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })) };
    migrationStorage.writeState(bulkState);
    const largeLibrarySqliteWorks = migrationStorage.readState().prompts.length === 1200;
    const granularUsageResult = migrationStorage.recordPromptUse(bulkState.prompts[0].id, "default", new Date().toISOString());
    const granularUsageUpdate = granularUsageResult.ok
      && granularUsageResult.useCount === 1
      && migrationStorage.readState().prompts.length === 1200;
    const walCheckpointWorks = migrationStorage.checkpoint("PASSIVE");
    migrationStorage.close();
    archiveState.prompts[0].images = [smokeImageData, smokePortraitData];
    archiveState.prompts[0].defaultVariantTitle = "通用版";
    archiveState.prompts[0].usageNote = "归档中的使用说明";
    archiveState.prompts[1].deletedAt = "2026-07-30T00:00:00.000Z";
    const legacySingleImageMigrated = normalizeStoredPrompt({ id: "legacy-image", image: smokeImageData }).images[0] === smokeImageData;
    const imageOptimization = optimizeNativeImage(nativeImage.createFromDataURL(smokeImageData)).startsWith("data:image/");
    archiveState.prompts[0].variants = [{
      id: "smoke-variant",
      title: "精简版",
      content: "请精简下面的内容",
      useCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }];
    const storedArchiveState = writeState(archiveState);
    const externalImageStorage = storedArchiveState.prompts[0].images.every((image) => image.startsWith(`${IMAGE_SCHEME}://`))
      && storedArchiveState.prompts[0].imageThumbnails.every((image) => image.startsWith(`${IMAGE_SCHEME}://`))
      && getStorage().getStats().imageCount === 2;
    const statePayloadExcludesImageBytes = !JSON.stringify(storedArchiveState).includes(";base64,");
    const archivePath = path.join(smokeBackupDirectory, "round-trip.promptdock");
    createPromptDockArchive(storedArchiveState, archivePath);
    const roundTripArchive = loadPromptDockFile(archivePath);
    const roundTripPrompts = roundTripArchive.prompts;
    const duplicatePrompt = { ...roundTripPrompts[0], id: randomUUID() };
    const deduplicationTest = mergeImportedPrompts(archiveState.prompts, [duplicatePrompt]);
    const conflictPrompt = {
      ...smokeState.prompts[0],
      content: `${smokeState.prompts[0].content}\n冲突测试`,
      updatedAt: smokeState.prompts[0].updatedAt
    };
    const conflictTest = mergeImportedPrompts(smokeState.prompts, [conflictPrompt]);
    const newerPrompt = {
      ...conflictPrompt,
      updatedAt: new Date(Date.parse(smokeState.prompts[0].updatedAt) + 60_000).toISOString()
    };
    const newerVersionTest = mergeImportedPrompts(smokeState.prompts, [newerPrompt]);
    const backupState = JSON.parse(JSON.stringify(smokeState));
    backupState.settings.backupDirectory = smokeBackupDirectory;
    const automaticBackup = createAutomaticBackup(backupState);
    const expiredBackup = path.join(smokeBackupDirectory, "Prompt-Dock-auto-expired.promptdock");
    const retainedBackup = path.join(smokeBackupDirectory, "Prompt-Dock-auto-retained.promptdock");
    fs.writeFileSync(expiredBackup, "expired");
    fs.writeFileSync(retainedBackup, "retained");
    const expiredDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const retainedDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(expiredBackup, expiredDate, expiredDate);
    fs.utimesSync(retainedBackup, retainedDate, retainedDate);
    pruneAutomaticBackups(smokeBackupDirectory);
    const threeDayBackupRetention = !fs.existsSync(expiredBackup) && fs.existsSync(retainedBackup);
    const rememberedCompactSize = { width: 486, height: 612 };
    setCompactMode(true, rememberedCompactSize);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const capturedCompactSize = setCompactMode(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    setCompactMode(true, capturedCompactSize);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const restoredCompactBounds = mainWindow.getBounds();
    const compactSizeRestored = restoredCompactBounds.width === capturedCompactSize.width
      && restoredCompactBounds.height === capturedCompactSize.height;
    setCompactMode(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      state.prompts[0].images = ${JSON.stringify(storedArchiveState.prompts[0].images)};
      state.prompts[0].imageThumbnails = ${JSON.stringify(storedArchiveState.prompts[0].imageThumbnails)};
      state.prompts[0].defaultVariantTitle = "通用版";
      state.prompts[0].usageNote = "SMOKE_USAGE_NOTE：使用前请先准备参考材料。";
      state.prompts[0].variants = [{
        id: "smoke-variant",
        title: "精简版",
        content: "请精简下面的内容",
        useCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }];
      renderAll();
      previewPrompt(state.prompts[0].id);
      const usageNotePreviewWorks = !document.querySelector("#previewNote").classList.contains("hidden")
        && document.querySelector("#previewNoteText").textContent.includes("SMOKE_USAGE_NOTE");
      document.querySelector("#searchInput").value = "SMOKE_USAGE_NOTE";
      const usageNoteSearchWorks = filteredPrompts().some((prompt) => prompt.id === state.prompts[0].id);
      const smartSearchTarget = {
        id: "smart-search-target",
        title: "人物姿态参考",
        content: "适用于铅笔线稿练习",
        usageNote: "需要一张真人模特照片",
        tags: ["绘画/参考"],
        variants: [],
        updatedAt: new Date().toISOString()
      };
      const smartSearchDecoy = {
        id: "smart-search-decoy",
        title: "人物素材",
        content: "普通照片处理",
        usageNote: "",
        tags: [],
        variants: [],
        updatedAt: new Date().toISOString()
      };
      state.prompts.push(smartSearchTarget, smartSearchDecoy);
      document.querySelector("#searchInput").value = "[ 人物 模特 线稿 ]";
      const smartSearchResults = filteredPrompts();
      const multiKeywordFuzzySearchWorks = smartSearchResults.some((prompt) => prompt.id === smartSearchTarget.id)
        && !smartSearchResults.some((prompt) => prompt.id === smartSearchDecoy.id);
      const searchCrossesPromptFields = promptSearchScore(smartSearchTarget, searchQueryTokens("人物 模特 线稿")) >= 0;
      state.prompts = state.prompts.filter((prompt) => ![smartSearchTarget.id, smartSearchDecoy.id].includes(prompt.id));
      const untaggedFixture = {
        id: "untagged-filter-target",
        title: "待整理 Prompt",
        content: "尚未添加分类",
        usageNote: "",
        tags: [],
        variants: [],
        updatedAt: new Date().toISOString()
      };
      state.prompts.push(untaggedFixture);
      currentFilter = "untagged";
      document.querySelector("#searchInput").value = "";
      renderSidebar();
      const untaggedResults = filteredPrompts();
      const untaggedNavigationWorks = Boolean(document.querySelector("[data-filter='untagged']"))
        && Number(document.querySelector("#untaggedCount").textContent) >= 1
        && untaggedResults.some((prompt) => prompt.id === untaggedFixture.id)
        && untaggedResults.every((prompt) => !(prompt.tags || []).some((tag) => normalizeTagPath(tag)));
      state.prompts = state.prompts.filter((prompt) => prompt.id !== untaggedFixture.id);
      currentFilter = "all";
      document.querySelector("#searchInput").value = "";
      renderList();
      const modernIconSystem = document.querySelectorAll(".icon-sprite symbol").length >= 25
        && document.querySelectorAll("svg.ui-icon use").length >= 20
        && getComputedStyle(document.querySelector("svg.ui-icon")).pointerEvents === "none";
      const promptCopyCountBefore = state.prompts[0].useCount || 0;
      document.querySelector("#copyBtn").dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 220));
      const promptCopyPointerWorks = state.prompts[0].useCount === promptCopyCountBefore + 1;
      const protocolPreviewImage = document.querySelector("#previewImage");
      if (!protocolPreviewImage.complete) await new Promise((resolve) => protocolPreviewImage.addEventListener("load", resolve, { once: true }));
      const externalImageProtocolWorks = protocolPreviewImage.naturalWidth > 0
        && protocolPreviewImage.src.includes("/original/")
        && document.querySelector(".prompt-card .thumb img")?.src.includes("/thumbnail/");
      const multiImageGallery = document.querySelectorAll("#previewImageThumbnails .gallery-thumbnail").length === 2;
      document.querySelector("#sortMenuButton").click();
      const customSortMenuOpens = !document.querySelector("#sortMenuOptions").classList.contains("hidden");
      document.querySelector('#sortMenuOptions [data-sort="used"]').click();
      const customSortSelectionWorks = currentSort === "used"
        && document.querySelector('#sortMenuOptions [data-sort="used"]').classList.contains("active");
      applySort("updated");
      openLightbox(0);
      document.querySelector("#lightboxStage").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
      const lightboxWheelZoomWorks = lightboxZoom > 1;
      moveLightbox(1);
      const lightboxMultiImageNavigation = lightboxImageIndex === 1;
      const lightboxImage = document.querySelector("#lightboxImage");
      if (!lightboxImage.complete) await new Promise((resolve) => lightboxImage.addEventListener("load", resolve, { once: true }));
      const lightboxImageActionsAvailable = Boolean(document.querySelector("#lightboxCopyImage") && document.querySelector("#lightboxSaveImage"));
      const lightboxCopyRect = document.querySelector("#lightboxCopyImage").getBoundingClientRect();
      const lightboxCopyHitArea = lightboxCopyRect.width >= 100 && lightboxCopyRect.height >= 38;
      document.querySelector("#lightboxCopyImage").dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      const lightboxPointerCopyWorks = !imageCopyPending
        && document.querySelector("#toast").textContent.includes("图片已复制");
      lightboxImage.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 420, clientY: 320 }));
      const lightboxContextMenuAvailable = !document.querySelector("#imageContextMenu").classList.contains("hidden");
      hideFloatingMenus();
      const copiedLightboxImage = await window.promptDock.copyImage(currentLightboxImage());
      const savedLightboxImage = await window.promptDock.saveImage(currentLightboxImage(), state.prompts[0].title, 2);
      const lightboxCopySaveWorks = copiedLightboxImage.ok === true
        && savedLightboxImage.canceled === false
        && savedLightboxImage.path.endsWith("-02.png");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const lightboxStageRect = document.querySelector("#lightboxStage").getBoundingClientRect();
      const portraitRectAtFit = lightboxImage.getBoundingClientRect();
      const portraitLightboxKeepsAspect = lightboxImage.offsetHeight > lightboxImage.offsetWidth;
      const portraitLightboxFullyVisible = portraitRectAtFit.left >= lightboxStageRect.left - 1
        && portraitRectAtFit.top >= lightboxStageRect.top - 1
        && portraitRectAtFit.right <= lightboxStageRect.right + 1
        && portraitRectAtFit.bottom <= lightboxStageRect.bottom + 1;
      setLightboxZoom(.5);
      const portraitRectAtHalf = lightboxImage.getBoundingClientRect();
      const portraitLightboxHalfCentered = portraitRectAtHalf.top >= lightboxStageRect.top - 1
        && portraitRectAtHalf.bottom <= lightboxStageRect.bottom + 1
        && Math.abs((portraitRectAtHalf.left + portraitRectAtHalf.right) / 2 - (lightboxStageRect.left + lightboxStageRect.right) / 2) < 1
        && Math.abs((portraitRectAtHalf.top + portraitRectAtHalf.bottom) / 2 - (lightboxStageRect.top + lightboxStageRect.bottom) / 2) < 1;
      setLightboxZoom(2);
      panLightboxBy(0, 120);
      const portraitLightboxCanPan = lightboxPanY > 0 && lightboxImage.style.transform.includes("translate3d");
      document.querySelector("#imageLightbox").close();
      const smokeBytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
      const ipcImageImportResult = await window.promptDock.importImageBuffers([smokeBytes.buffer]);
      const imageBufferImportWorks = ipcImageImportResult.images.length === 1
        && ipcImageImportResult.images[0].startsWith("data:image/");
      const imagePasteApiAvailable = typeof window.promptDock.pasteImage === "function";
      state.prompts[0].tags = [...new Set([...(state.prompts[0].tags || []), "ChatGPT/项目", "ChatGPT/写作"])];
      state.prompts[1].tags = [...new Set([...(state.prompts[1].tags || []), "ChatGPT/项目"])];
      renderSidebar();
      const hierarchyRoot = document.querySelector('#tagList [data-tag-name="ChatGPT"][data-tag-scope="branch"]');
      const hierarchyChildren = [...document.querySelectorAll('#tagList [data-tag-scope="exact"][data-tag-name^="ChatGPT/"]')];
      const hierarchicalTagTreeWorks = Boolean(hierarchyRoot)
        && hierarchyRoot.querySelector("b").textContent === "2"
        && hierarchyChildren.length === 2
        && hierarchyChildren.some((button) => button.querySelector("span").textContent === "项目")
        && hierarchyChildren.every((button) => !button.querySelector("span").textContent.includes("ChatGPT/"));
      setFilter("tagtree:ChatGPT");
      const parentTagAggregatesChildren = filteredPrompts().length === 2;
      setFilter("tag:ChatGPT/写作");
      const childTagFiltersExactly = filteredPrompts().length === 1;
      await openNewPrompt();
      await new Promise((resolve) => setTimeout(resolve, 280));
      const newPromptInheritsSelectedTag = document.querySelector("#editorDialog").open
        && document.querySelector("#tagsField").value === "ChatGPT/写作"
        && document.activeElement === document.querySelector("#titleField");
      document.querySelector("#editorDialog").close();
      const tagViewTitle = document.querySelector("#viewTitle");
      const hierarchicalViewTitleWorks = !tagViewTitle.querySelector(".view-title-parent")
        && tagViewTitle.querySelector(".view-title-current")?.textContent === "写作"
        && document.querySelector("#resultMeta").textContent.includes("ChatGPT 下的子标签")
        && getComputedStyle(tagViewTitle).whiteSpace === "nowrap"
        && tagViewTitle.scrollHeight <= Math.ceil(parseFloat(getComputedStyle(tagViewTitle).lineHeight)) + 2;
      setFilter("all");
      document.querySelector('#tagList [data-tag-toggle="ChatGPT"]')?.click();
      const tagTreeCollapseWorks = document.querySelector('#tagList [data-tag-root="ChatGPT"] .tag-tree-children')?.classList.contains("hidden")
        && (state.settings.collapsedTagGroups || []).includes("chatgpt");
      document.querySelector('#tagList [data-tag-toggle="ChatGPT"]')?.click();
      const branchRenameProbe = [{ tags: ["ChatGPT/项目", "ChatGPT/写作"] }, { tags: ["ChatGPT", "其他"] }];
      const parentTagRenameCascades = replaceTagNameInPrompts(branchRenameProbe, "ChatGPT", "AI", true) === 2
        && branchRenameProbe[0].tags.includes("AI/项目")
        && branchRenameProbe[0].tags.includes("AI/写作")
        && branchRenameProbe[1].tags.includes("AI");
      const standaloneTagLabel = document.querySelector('#tagList [data-tag-root="写作"] .tag-root-filter span');
      const sidebarRect = document.querySelector(".sidebar").getBoundingClientRect();
      const childTagButton = document.querySelector('#tagList [data-tag-name="ChatGPT/项目"]');
      const childGuideStyle = getComputedStyle(childTagButton, "::before");
      const tagHierarchyVisualAlignment = standaloneTagLabel.getBoundingClientRect().left > sidebarRect.left + 20
        && standaloneTagLabel.getBoundingClientRect().right < sidebarRect.right - 10
        && childTagButton.querySelector("span").getBoundingClientRect().left > hierarchyRoot.querySelector("span").getBoundingClientRect().left
        && childGuideStyle.display === "none";
      const originalPaneWidths = { ...(state.settings.paneWidths || { left: 190, right: null }) };
      const originalLeftWidth = document.querySelector(".sidebar").getBoundingClientRect().width;
      const originalRightWidth = document.querySelector("#previewPanel").getBoundingClientRect().width;
      document.body.classList.add("pane-resizing");
      const resizedLeft = setPaneWidth("left", originalLeftWidth + 32);
      const resizedRight = setPaneWidth("right", originalRightWidth - 36);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const paneResizeDiagnostic = {
        originalLeftWidth,
        originalRightWidth,
        requestedLeft: resizedLeft,
        requestedRight: resizedRight,
        actualLeft: document.querySelector(".sidebar").getBoundingClientRect().width,
        actualRight: document.querySelector("#previewPanel").getBoundingClientRect().width,
        leftHandle: document.querySelector("#leftPaneResizer").getBoundingClientRect().width,
        rightHandle: document.querySelector("#rightPaneResizer").getBoundingClientRect().width
      };
      const paneResizeWorks = Math.abs(paneResizeDiagnostic.actualLeft - resizedLeft) < 1
        && Math.abs(paneResizeDiagnostic.actualRight - resizedRight) < 1
        && paneResizeDiagnostic.leftHandle === 6
        && paneResizeDiagnostic.rightHandle === 6;
      document.body.classList.remove("pane-resizing");
      await persist();
      const savedPaneWidths = (await window.promptDock.getState()).settings.paneWidths;
      paneResizeDiagnostic.savedPaneWidths = savedPaneWidths;
      const paneWidthsPersist = savedPaneWidths.left === resizedLeft && savedPaneWidths.right === resizedRight;
      state.settings.paneWidths = originalPaneWidths;
      applyPaneWidths();
      await persist();
      const tagList = document.querySelector("#tagList");
      tagList.insertAdjacentHTML("beforeend", Array.from({ length: 28 }, (_, index) =>
        \`<button class="nav-item"><span># 测试标签 \${index + 1}</span><b>1</b></button>\`
      ).join(""));
      const sidebarSection = document.querySelector(".sidebar-section");
      const settingsRect = document.querySelector("#settingsBtn").getBoundingClientRect();
      const settingsPinnedInViewport = settingsRect.bottom <= window.innerHeight && settingsRect.top >= 44;
      const sidebarTagsScrollable = sidebarSection.scrollHeight > sidebarSection.clientHeight;
      sidebarSection.dispatchEvent(new Event("scroll"));
      const scrollbarRevealOnScroll = sidebarSection.classList.contains("is-scrolling");
      const promptList = document.querySelector("#promptList");
      const originalPromptList = promptList.innerHTML;
      promptList.insertAdjacentHTML("beforeend", Array.from({ length: 20 }, () => originalPromptList).join(""));
      const promptListScrollable = promptList.scrollHeight > promptList.clientHeight
        && promptList.getBoundingClientRect().bottom <= window.innerHeight;
      renderAll();
      document.querySelector("#privacyModeBtn").click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const privacyModeMasksPromptText = document.body.classList.contains("privacy-mode")
        && parseFloat(getComputedStyle(document.querySelector(".prompt-card .card-body p")).height) <= 10
        && getComputedStyle(document.querySelector("#previewText")).color === "rgba(0, 0, 0, 0)"
        && getComputedStyle(document.querySelector("#previewNoteText")).color === "rgba(0, 0, 0, 0)";
      const privacyModePersists = (await window.promptDock.getState()).settings.privacyMode === true;
      state.settings.privacyHideImages = true;
      applyPrivacyMode();
      const privacyModeCanHideImages = getComputedStyle(document.querySelector(".prompt-card .thumb img")).visibility === "hidden";
      document.querySelector("#privacyModeBtn").click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      state.settings.privacyHideImages = false;
      await persist();
      const firstSidebarTag = document.querySelector("#tagList .tag-filter");
      firstSidebarTag?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 200 }));
      const tagContextMenuAvailable = !document.querySelector("#tagContextMenu").classList.contains("hidden")
        && !document.querySelector("#tagContextMenu [data-tag-menu-action='merge']").disabled
        && Boolean(document.querySelector("#tagContextMenu [data-tag-menu-action='delete'].context-menu-danger"));
      hideFloatingMenus();
      firstSidebarTag?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      const inlineTagRenameAvailable = Boolean(firstSidebarTag?.querySelector(".tag-rename-input"));
      firstSidebarTag?.querySelector(".tag-rename-input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const renameProbe = [{ tags: ["Alpha", "Beta"] }, { tags: ["Alpha"] }];
      const tagRenameMergeWorks = replaceTagNameInPrompts(renameProbe, "Alpha", "Beta") === 2
        && renameProbe[0].tags.length === 1
        && renameProbe.every((prompt) => prompt.tags[0] === "Beta");
      const childDeleteProbe = [{ tags: ["ChatGPT/项目", "人物"] }, { tags: ["ChatGPT/写作"] }];
      const childTagDeleteKeepsPrompts = removeTagFromPrompts(childDeleteProbe, "ChatGPT/项目") === 1
        && childDeleteProbe.length === 2
        && childDeleteProbe[0].tags.length === 1
        && childDeleteProbe[0].tags[0] === "人物";
      const branchDeleteProbe = [{ tags: ["ChatGPT/项目", "人物"] }, { tags: ["ChatGPT/写作"] }, { tags: ["ChatGPT"] }];
      const parentTagDeleteCascades = removeTagFromPrompts(branchDeleteProbe, "ChatGPT", true) === 3
        && branchDeleteProbe.length === 3
        && branchDeleteProbe[0].tags[0] === "人物"
        && branchDeleteProbe[1].tags.length === 0
        && branchDeleteProbe[2].tags.length === 0;
      openEditor(state.prompts[0]);
      const usageNoteEditorPrefillWorks = document.querySelector("#usageNoteField").value.includes("SMOKE_USAGE_NOTE");
      const customDefaultVariantTitle = document.querySelector("#defaultVariantTitleField").value === "通用版"
        && promptVersions(state.prompts[0])[0].title === "通用版";
      const tagInput = document.querySelector("#tagsField");
      const originalTagInput = tagInput.value;
      tagInput.focus();
      tagInput.setSelectionRange(tagInput.value.length, tagInput.value.length);
      document.execCommand("insertText", false, "光标测试");
      const tagInputFocusAndTypingWorks = document.activeElement === tagInput
        && tagInput.value.endsWith("光标测试")
        && getComputedStyle(tagInput).caretColor !== "rgba(0, 0, 0, 0)";
      tagInput.value = originalTagInput;
      tagInput.dispatchEvent(new Event("input", { bubbles: true }));
      toast("Prompt 已保存");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const toastAboveDialog = document.querySelector("#toast").matches(":popover-open")
        && document.querySelector("#editorDialog").open;
      const multiImageEditor = pendingImages.length === 2
        && document.querySelectorAll("#imageEditorList .image-editor-item").length === 2;
      const originalFirstImage = pendingImages[0];
      const dragTransfer = new DataTransfer();
      const firstImageHandle = document.querySelector('#imageEditorList [data-image-index="0"] .image-drag-handle');
      const secondImageCard = document.querySelector('#imageEditorList [data-image-index="1"]');
      const secondImageRect = secondImageCard.getBoundingClientRect();
      firstImageHandle.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dragTransfer }));
      secondImageCard.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dragTransfer, clientX: secondImageRect.right - 1 }));
      secondImageCard.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dragTransfer, clientX: secondImageRect.right - 1 }));
      const imageDragReorderWorks = pendingImages[1] === originalFirstImage
        && document.querySelectorAll("#imageEditorList .image-drag-handle[draggable='true']").length === 2;
      document.querySelector('#imageEditorList [data-image-index="1"] [data-image-action="cover"]')?.click();
      const coverSelectionWorks = document.querySelector('#imageEditorList [data-image-index="0"] .image-cover-badge')?.textContent === "封面";
      tagInput.value = "ChatGPT/";
      renderTagSuggestions();
      const hierarchySuggestion = document.querySelector('#tagSuggestions [data-tag="ChatGPT/项目"]');
      const hierarchicalTagSuggestionWorks = hierarchySuggestion?.querySelector("small")?.textContent === "ChatGPT"
        && hierarchySuggestion?.querySelector("span")?.textContent === "项目"
        && !hierarchySuggestion.textContent.includes("ChatGPT/项目");
      hierarchySuggestion?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
      const hierarchicalTagSuggestionSelectsPath = editorTags().includes("ChatGPT/项目");
      tagInput.value = originalTagInput;
      renderTagSuggestions();
      const catalogTag = [...allTagStats().values()].map((item) => item.tag).find((tag) => tag.length > 1);
      document.querySelector("#tagsField").value = catalogTag.slice(0, -1);
      renderTagSuggestions();
      const matchingTagSuggestion = [...document.querySelectorAll("#tagSuggestions .tag-suggestion.match")]
        .find((button) => button.dataset.tag === catalogTag);
      matchingTagSuggestion?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
      const tagAutoMatchWorks = editorTags().some((tag) => tag === catalogTag);
      const firstTagSuggestion = document.querySelector("#tagSuggestions [data-tag]");
      const tagsBeforeSuggestionClick = document.querySelector("#tagsField").value;
      firstTagSuggestion?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
      const tagSuggestionToggle = Boolean(firstTagSuggestion)
        && document.querySelector("#tagsField").value !== tagsBeforeSuggestionClick;
      const tagSuggestionKeepsFocus = document.activeElement === document.querySelector("#tagsField");
      const originalPendingVariants = pendingVariants;
      pendingVariants = [];
      renderVariantEditor();
      const variantEmptyStateFontIsCompact = parseFloat(getComputedStyle(document.querySelector(".variant-editor-empty")).fontSize) <= 13;
      pendingVariants = originalPendingVariants;
      renderVariantEditor();
      document.querySelector("#addVariantBtn").click();
      const addedVariantTitle = document.querySelector(".variant-editor-item:last-child .variant-title-input");
      addedVariantTitle.value = "详细版";
      addedVariantTitle.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector(".variant-editor-item:last-child [data-variant-action='up']").click();
      const editorVariantManagement = pendingVariants.length === 2 && pendingVariants[0].title === "详细版";
      const editorFormElement = document.querySelector("#editorForm");
      const editorScrollProbe = document.createElement("div");
      editorScrollProbe.style.height = "900px";
      editorScrollProbe.setAttribute("aria-hidden", "true");
      editorFormElement.insertBefore(editorScrollProbe, editorFormElement.querySelector(".dialog-actions"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const editorDialogElement = document.querySelector("#editorDialog");
      [editorFormElement, editorDialogElement].forEach((element) => { element.scrollTop = element.scrollHeight; });
      const editorWasScrolled = [editorFormElement, editorDialogElement].some((element) => element.scrollTop > 0);
      document.querySelector("#editorDialog").close();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: !IS_MAC, metaKey: IS_MAC, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      const ctrlKFocusesSearch = document.activeElement === document.querySelector("#searchInput");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: !IS_MAC, metaKey: IS_MAC, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      const newPromptShortcutWorks = document.querySelector("#editorDialog").open
        && document.querySelector("#titleField").value === "";
      const editorScrollDiagnostic = {
        editorWasScrolled,
        scrollTopAfterOpen: document.querySelector("#editorForm").scrollTop,
        dialogScrollTopAfterOpen: document.querySelector("#editorDialog").scrollTop,
        scrollHeight: document.querySelector("#editorForm").scrollHeight,
        clientHeight: document.querySelector("#editorForm").clientHeight
      };
      const editorReopensAtTop = editorScrollDiagnostic.scrollTopAfterOpen === 0
        && editorScrollDiagnostic.dialogScrollTopAfterOpen === 0;
      editorScrollProbe.remove();
      document.querySelector("#editorDialog").close();
      const firstBatchPrompt = state.prompts[0];
      const firstBatchUseCount = firstBatchPrompt.useCount || 0;
      document.querySelector("#batchModeBtn").click();
      const batchActionLabelsCompact = document.querySelector("#batchSelectAllBtn").textContent === "全选"
        && document.querySelector("#batchDeleteBtn span").textContent === "删除";
      const firstBatchCard = document.querySelector(\`.prompt-card[data-id="\${firstBatchPrompt.id}"]\`);
      firstBatchCard.click();
      const batchCardClickSelectsWithoutPaste = batchMode
        && batchSelection.has(firstBatchPrompt.id)
        && firstBatchPrompt.useCount === firstBatchUseCount;
      const secondBatchCard = document.querySelectorAll(".prompt-card")[1];
      secondBatchCard?.click();
      document.querySelector("#batchDeleteBtn").click();
      const batchDeleteConfirmationWorks = document.querySelector("#batchDeleteDialog").open
        && Number(document.querySelector("#batchDeleteCount").textContent) === batchSelection.size;
      document.querySelector('[data-close-dialog="batchDeleteDialog"]').click();
      const batchClearRemoved = !document.querySelector("#batchClearBtn");
      document.querySelector("#batchSelectAllBtn").click();
      const batchSelectAllCanClearVisible = batchSelection.size === 0;
      document.querySelector("#batchSelectAllBtn").click();
      const batchSelectAllWorks = filteredPrompts().length > 0
        && filteredPrompts().every((prompt) => batchSelection.has(prompt.id));
      document.querySelector("#batchModeBtn").click();
      const batchExitClearsSelection = !batchMode && batchSelection.size === 0;
      const firstCardBeforeCompact = document.querySelector(\`.prompt-card[data-id="\${state.prompts[0].id}"]\`);
      firstCardBeforeCompact.dispatchEvent(new MouseEvent("mouseenter"));
      const regularVariantListShown = document.querySelectorAll("#variantList .variant-option").length === 2;
      const variantUseCountBefore = state.prompts[0].variants[0].useCount || 0;
      await usePrompt("copy", "smoke-variant");
      const variantClickUsedPrompt = state.prompts[0].variants[0].useCount === variantUseCountBefore + 1;
      const settings = document.querySelector("#settingsDialog");
      document.querySelector("#settingsBtn").click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const settingsOpened = settings.open;
      document.querySelector("#recordNewPromptShortcutBtn").click();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: !IS_MAC, metaKey: IS_MAC, shiftKey: true, bubbles: true }));
      const newPromptShortcutRecorderWorks = document.querySelector("#newPromptShortcutField").value === (IS_MAC ? "Command+Shift+N" : "Control+Shift+N");
      document.querySelector("#newPromptShortcutField").value = DEFAULT_NEW_SHORTCUT;
      const newPromptShortcutConflictCheck = Boolean(validateNewPromptShortcut(IS_MAC ? "Command+K" : "Control+K"))
        && Boolean(validateNewPromptShortcut(state.settings.shortcut, state.settings.shortcut));
      document.querySelector("#authorBtn").click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const authorDialog = document.querySelector("#authorDialog");
      const authorAvatar = document.querySelector("#authorAvatar");
      const authorQrImage = document.querySelector("#authorQrImage");
      if (!authorAvatar.complete) await new Promise((resolve) => authorAvatar.addEventListener("load", resolve, { once: true }));
      if (!authorQrImage.complete) await new Promise((resolve) => authorQrImage.addEventListener("load", resolve, { once: true }));
      const authorPageWorks = authorDialog.open
        && authorAvatar.naturalWidth === 960
        && authorQrImage.naturalWidth === 950
        && document.querySelector("#authorAppVersion").textContent === "v${app.getVersion()}";
      document.querySelector("#authorQrButton").click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const authorQrDialog = document.querySelector("#authorQrDialog");
      const authorQrForm = authorQrDialog.querySelector("form");
      const authorQrLargeImage = authorQrDialog.querySelector("img");
      const authorQrFormRect = authorQrForm.getBoundingClientRect();
      const authorQrImageRect = authorQrLargeImage.getBoundingClientRect();
      const authorQrEnlarges = authorQrDialog.open && authorQrLargeImage.naturalHeight === 1295;
      const authorQrFullyVisible = authorQrImageRect.left >= authorQrFormRect.left - 1
        && authorQrImageRect.top >= authorQrFormRect.top - 1
        && authorQrImageRect.right <= authorQrFormRect.right + 1
        && authorQrImageRect.bottom <= authorQrFormRect.bottom + 1;
      const authorQrHasNoScroll = authorQrDialog.scrollHeight <= authorQrDialog.clientHeight + 1
        && authorQrForm.scrollHeight <= authorQrForm.clientHeight + 1
        && getComputedStyle(authorQrDialog).overflowY === "hidden"
        && getComputedStyle(authorQrForm).overflowY === "hidden";
      const authorQrKeepsAspect = getComputedStyle(authorQrLargeImage).objectFit === "contain"
        && Math.abs((authorQrLargeImage.naturalWidth / authorQrLargeImage.naturalHeight) - (950 / 1295)) < 0.01;
      const authorQrCloseButton = document.querySelector(".author-qr-close");
      const authorQrCloseRect = authorQrCloseButton.getBoundingClientRect();
      const authorQrCloseHitTarget = document.elementFromPoint(authorQrCloseRect.left + 3, authorQrCloseRect.top + 3);
      authorQrCloseButton.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
      const authorQrCloseHitAreaWorks = authorQrCloseRect.width >= 44
        && authorQrCloseRect.height >= 44
        && authorQrCloseHitTarget?.closest(".author-qr-close") === authorQrCloseButton
        && !authorQrDialog.open;
      if (authorQrDialog.open) authorQrDialog.close();
      document.querySelector('[data-close-dialog="authorDialog"]').click();
      const authorPageReturnDiagnostic = { settingsOpen: settings.open, authorOpen: authorDialog.open, qrOpen: document.querySelector("#authorQrDialog").open };
      const authorPageReturnsToSettings = authorPageReturnDiagnostic.settingsOpen
        && !authorPageReturnDiagnostic.authorOpen
        && !authorPageReturnDiagnostic.qrOpen;
      const cacheMaintenanceAvailable = Boolean(document.querySelector("#clearCacheBtn"))
        && typeof window.promptDock.clearCache === "function";
      const cacheClearResult = await window.promptDock.clearCache();
      const cacheMaintenanceWorks = cacheClearResult.ok === true && cacheClearResult.bytes === 0;
      document.querySelector('[data-close-dialog="settingsDialog"]').click();
      document.querySelector("#compactBtn").click();
      await new Promise((resolve) => setTimeout(resolve, 220));
      const compactEnabled = document.querySelector(".app-shell").classList.contains("compact-mode");
      const compactPaneResizersHidden = [...document.querySelectorAll(".pane-resizer")].every((handle) => getComputedStyle(handle).display === "none");
      document.querySelector("#toggleLeftBtn").click();
      const compactLeftDrawerShown = document.querySelector(".app-shell").classList.contains("compact-left-open");
      const compactRightControlHidden = document.querySelector("#toggleRightBtn").classList.contains("hidden");
      document.querySelector(".library").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const compactLeftDrawerDismissed = !document.querySelector(".app-shell").classList.contains("compact-left-open");
      const compactFirstCard = document.querySelector(\`.prompt-card[data-id="\${state.prompts[0].id}"]\`);
      compactFirstCard.dispatchEvent(new MouseEvent("mouseenter"));
      const compactVariantPopoverShown = !document.querySelector("#variantPopover").classList.contains("hidden")
        && document.querySelectorAll("#variantPopover button").length === 2;
      compactFirstCard.dispatchEvent(new MouseEvent("mouseleave"));
      await new Promise((resolve) => setTimeout(resolve, 190));
      const compactVariantPopoverDismissed = document.querySelector("#variantPopover").classList.contains("hidden");
      document.querySelector("#compactBtn").click();
      await new Promise((resolve) => setTimeout(resolve, 220));
      const firstCard = document.querySelector(".prompt-card");
      const firstPrompt = state.prompts.find((prompt) => prompt.id === firstCard.dataset.id);
      const useCountBefore = firstPrompt.useCount || 0;
      firstCard.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
      const batchDeleteProbe = { ...state.prompts[0], id: "batch-delete-probe", title: "批量删除测试", images: [], imageThumbnails: [] };
      state.prompts.push(batchDeleteProbe);
      setBatchMode(true);
      batchSelection.add(batchDeleteProbe.id);
      const batchDeletedCount = await deleteBatchSelection();
      const trashedBatchProbe = state.prompts.find((prompt) => prompt.id === batchDeleteProbe.id);
      const batchDeleteWorks = batchDeletedCount === 1
        && Boolean(trashedBatchProbe?.deletedAt)
        && !batchMode;
      setFilter("trash");
      renderSidebar();
      const recycleBinNavigationWorks = filteredPrompts().some((prompt) => prompt.id === batchDeleteProbe.id)
        && Number(document.querySelector("#trashCount").textContent) >= 1;
      const trashCard = document.querySelector(\`.prompt-card[data-id="\${batchDeleteProbe.id}"]\`);
      const trashUseCountBefore = trashedBatchProbe.useCount || 0;
      trashCard?.click();
      const trashCardDoesNotPaste = (trashedBatchProbe.useCount || 0) === trashUseCountBefore;
      const trashPreviewActionsAvailable = document.querySelector("#copyBtn span").textContent === "恢复"
        && document.querySelector("#pasteBtn span").textContent === "永久删除";
      document.querySelector("#trashNavItem").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 260 }));
      const emptyTrashContextMenuAvailable = !document.querySelector("#trashContextMenu").classList.contains("hidden")
        && !document.querySelector("#emptyTrashMenuBtn").disabled;
      hideFloatingMenus();
      const recycleRestoreWorks = await restorePrompt(trashedBatchProbe)
        && !state.prompts.find((prompt) => prompt.id === batchDeleteProbe.id)?.deletedAt;
      movePromptsToTrash([batchDeleteProbe.id]);
      const recyclePermanentDeleteWorks = permanentlyDeletePrompts([batchDeleteProbe.id]) === 1
        && !state.prompts.some((prompt) => prompt.id === batchDeleteProbe.id);
      await persist();
      setFilter("all");
      const vocabularyCollection = state.vocabulary.collections[0];
      const vocabularyMoveCollection = { id: "smoke-move-collection", name: "移动目标", createdAt: new Date().toISOString() };
      const vocabularyWord = { id: "smoke-word", text: "电影感", collectionId: vocabularyCollection.id, favorite: false, useCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const vocabularyWordTwo = { ...vocabularyWord, id: "smoke-word-two", text: "低机位" };
      const vocabularyDeleteProbe = { ...vocabularyWord, id: "smoke-word-delete", text: "批量删除探针" };
      state.vocabulary.collections.push(vocabularyMoveCollection);
      state.vocabulary.entries.push(vocabularyWord, vocabularyWordTwo, vocabularyDeleteProbe);
      await persist();
      setAppMode("vocabulary");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: !IS_MAC, metaKey: IS_MAC, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      const vocabularyCtrlKFocusesSearch = document.activeElement === document.querySelector("#vocabularySearchInput");
      const vocabularySearchUiWorks = document.querySelector("#vocabularySearchInput").placeholder === "搜索关键词"
        && document.querySelector("#vocabularyShortcutBadge").textContent === (IS_MAC ? "⌘ K" : "Ctrl K");
      const vocabularyDunhaoSplitWorks = "电影感、低机位、柔和光线".split(vocabularySplitter("smart")).length === 3
        && "电影感、低机位".split(vocabularySplitter("dunhao")).length === 2
        && Boolean(document.querySelector('#vocabularySplitMode option[value="dunhao"]'));
      openVocabularyBulkDialog();
      await new Promise((resolve) => setTimeout(resolve, 280));
      const bulkTextField = document.querySelector("#vocabularyBulkText");
      bulkTextField.setRangeText("焦点输入测试", 0, bulkTextField.value.length, "end");
      const vocabularyBulkInputFocusWorks = document.querySelector("#vocabularyBulkDialog").open
        && document.activeElement === bulkTextField
        && bulkTextField.value === "焦点输入测试"
        && getComputedStyle(bulkTextField).caretColor !== "rgba(0, 0, 0, 0)";
      document.querySelector("#vocabularyBulkDialog").close();
      openVocabularyCollectionDialog();
      await new Promise((resolve) => setTimeout(resolve, 280));
      const otherEditableDialogsFocusWorks = document.querySelector("#vocabularyCollectionDialog").open
        && document.activeElement === document.querySelector("#vocabularyCollectionName");
      document.querySelector("#vocabularyCollectionDialog").close();
      const vocabularyModeWorks = document.querySelector(".app-shell").classList.contains("vocabulary-mode")
        && !document.querySelector("#vocabularyWorkspace").classList.contains("hidden")
        && document.querySelectorAll(".vocabulary-word").length >= 2;
      const vocabularySidebarIsFocused = getComputedStyle(document.querySelector("#promptSidebarNav")).display === "none"
        && getComputedStyle(document.querySelector("#promptTagSection")).display === "none"
        && getComputedStyle(document.querySelector("#promptUtilityNav")).display === "none"
        && getComputedStyle(document.querySelector("#vocabularySidebarNav")).display !== "none"
        && document.querySelector("#vocabularyNavItem").classList.contains("active")
        && !document.querySelector("#promptLibraryNavItem").classList.contains("active");
      const vocabularyContextualActionWorks = document.querySelector("#mainActionLabel").textContent === "批量添加词条"
        && !document.querySelector("#newPromptBtn").hasAttribute("aria-keyshortcuts")
        && !document.querySelector(".vocabulary-collections");
      const vocabularyCollectionInSidebar = Boolean(document.querySelector('#vocabularySidebarNav [data-vocabulary-collection-id]'));
      const vocabularyWordButton = document.querySelector('[data-vocabulary-id="smoke-word"]');
      vocabularyWordButton.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 680, clientY: 320 }));
      const vocabularyFavoriteLabel = document.querySelector("#vocabularyWordMenu .menu-label");
      const vocabularyFavoriteMenuStable = getComputedStyle(vocabularyFavoriteLabel).whiteSpace === "nowrap"
        && vocabularyFavoriteLabel.getBoundingClientRect().height < 30
        && vocabularyFavoriteLabel.getBoundingClientRect().width > 30;
      hideFloatingMenus();
      document.querySelector('[data-vocabulary-favorite="smoke-word"]').click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const favoritedEntry = state.vocabulary.entries.find((entry) => entry.id === vocabularyWord.id);
      const vocabularyDirectFavoriteWorks = favoritedEntry.favorite === true
        && favoritedEntry.useCount === 0
        && document.querySelector('[data-vocabulary-id="smoke-word"]').classList.contains("favorite");
      setVocabularyInteractionMode("batch");
      document.querySelector('[data-vocabulary-id="smoke-word-two"]').click();
      document.querySelector("#vocabularyBatchMoveBtn").click();
      const vocabularyBatchMoveDialogWorks = document.querySelector("#vocabularyBatchMoveDialog").open
        && document.querySelector("#vocabularyBatchMoveCount").textContent === "1"
        && document.querySelector("#vocabularyBatchMoveCollection").value === vocabularyMoveCollection.id;
      document.querySelector("#vocabularyBatchMoveForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const vocabularyBatchMoveWorks = state.vocabulary.entries.find((entry) => entry.id === vocabularyWordTwo.id)?.collectionId === vocabularyMoveCollection.id
        && state.vocabulary.entries.find((entry) => entry.id === vocabularyWordTwo.id)?.text === vocabularyWordTwo.text
        && !vocabularyBatchMode
        && vocabularyBatchSelection.size === 0;
      setVocabularyInteractionMode("batch");
      document.querySelector('[data-vocabulary-id="smoke-word-delete"]').click();
      document.querySelector("#vocabularyBatchDeleteBtn").click();
      const vocabularyBatchDeleteConfirmationWorks = document.querySelector("#vocabularyBatchDeleteDialog").open
        && document.querySelector("#vocabularyBatchDeleteCount").textContent === "1";
      document.querySelector("#vocabularyBatchDeleteForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const vocabularyBatchDeleteWorks = !state.vocabulary.entries.some((entry) => entry.id === vocabularyDeleteProbe.id)
        && !vocabularyBatchMode
        && vocabularyBatchSelection.size === 0
        && state.vocabulary.collections.some((collection) => collection.id === vocabularyCollection.id);
      await handleVocabularyWordClick(vocabularyWord.id, document.querySelector('[data-vocabulary-id="smoke-word"]'));
      const vocabularySingleClickCopies = state.vocabulary.entries.find((entry) => entry.id === vocabularyWord.id).useCount === 1;
      vocabularyCombineMode = true;
      vocabularySelection.add(vocabularyWord.id);
      vocabularySelection.add(vocabularyWordTwo.id);
      renderVocabulary();
      const vocabularyCombinationWorks = document.querySelector("#vocabularyComposerPreview").textContent.includes("电影感")
        && document.querySelector("#vocabularyComposerPreview").textContent.includes("低机位")
        && !document.querySelector("#vocabularyComposer").classList.contains("hidden");
      const mergeProbe = { ...state.prompts[0], id: "merge-child-probe", tags: ["来源", "目标/子级"], images: [], imageThumbnails: [] };
      state.prompts.push(mergeProbe);
      openTagMergeDialog("来源", "branch");
      const childTagMergeTargetAvailable = Boolean(document.querySelector('[data-merge-target="目标/子级"]'));
      document.querySelector("#tagMergeDialog").close();
      const stablePreviewLayout = getComputedStyle(document.querySelector("#previewPanel")).overflowY === "hidden"
        && getComputedStyle(document.querySelector(".preview-scroll")).overflowY === "auto"
        && getComputedStyle(document.querySelector(".preview-actions")).position !== "sticky";
      state.vocabulary.entries = state.vocabulary.entries.filter((entry) => ![vocabularyWord.id, vocabularyWordTwo.id].includes(entry.id));
      state.vocabulary.collections = state.vocabulary.collections.filter((collection) => collection.id !== vocabularyMoveCollection.id);
      state.prompts = state.prompts.filter((prompt) => prompt.id !== mergeProbe.id);
      vocabularySelection.clear();
      vocabularyCombineMode = false;
      await persist();
      setAppMode("prompts");
      setFilter("all");
      return {
        title: document.title,
        promptCards: document.querySelectorAll(".prompt-card").length,
        logoLoaded: document.querySelector(".brand-logo")?.complete === true,
        layoutReady: Boolean(document.querySelector(".app-shell")),
        toolbarSvgIcons: document.querySelectorAll(".titlebar-tools svg").length,
        modernIconSystem,
        quickButtonRemoved: !document.querySelector("#quickPasteBtn"),
        compactEnabled,
        compactPaneResizersHidden,
        compactRestored: !document.querySelector(".app-shell").classList.contains("compact-mode"),
        compactLeftDrawerShown,
        compactLeftDrawerDismissed,
        compactRightControlHidden,
        regularVariantListShown,
        compactVariantPopoverShown,
        compactVariantPopoverDismissed,
        editorVariantManagement,
        externalImageProtocolWorks,
        multiImageGallery,
        customSortMenuOpens,
        customSortSelectionWorks,
        lightboxWheelZoomWorks,
        lightboxMultiImageNavigation,
        lightboxImageActionsAvailable,
        lightboxCopyHitArea,
        lightboxPointerCopyWorks,
        lightboxContextMenuAvailable,
        lightboxCopySaveWorks,
        portraitLightboxKeepsAspect,
        portraitLightboxFullyVisible,
        portraitLightboxHalfCentered,
        portraitLightboxCanPan,
        imageBufferImportWorks,
        imagePasteApiAvailable,
        multiImageEditor,
        imageDragReorderWorks,
        toastAboveDialog,
        coverSelectionWorks,
        ctrlKFocusesSearch,
        newPromptShortcutWorks,
        editorReopensAtTop,
        editorScrollDiagnostic,
        newPromptShortcutRecorderWorks,
        newPromptShortcutConflictCheck,
        authorPageWorks,
        authorQrEnlarges,
        authorQrFullyVisible,
        authorQrHasNoScroll,
        authorQrKeepsAspect,
        authorQrCloseHitAreaWorks,
        authorPageReturnsToSettings,
        authorPageReturnDiagnostic,
        usageNotePreviewWorks,
        usageNoteSearchWorks,
        multiKeywordFuzzySearchWorks,
        searchCrossesPromptFields,
        untaggedNavigationWorks,
        usageNoteEditorPrefillWorks,
        tagSuggestionToggle,
        tagSuggestionKeepsFocus,
        tagAutoMatchWorks,
        tagInputFocusAndTypingWorks,
        inlineTagRenameAvailable,
        tagContextMenuAvailable,
        tagRenameMergeWorks,
        childTagDeleteKeepsPrompts,
        parentTagDeleteCascades,
        hierarchicalTagTreeWorks,
        hierarchicalTagSuggestionWorks,
        hierarchicalTagSuggestionSelectsPath,
        parentTagAggregatesChildren,
        childTagFiltersExactly,
        hierarchicalViewTitleWorks,
        tagTreeCollapseWorks,
        parentTagRenameCascades,
        newPromptInheritsSelectedTag,
        tagHierarchyVisualAlignment,
        paneResizeWorks,
        paneResizeDiagnostic,
        paneWidthsPersist,
        customDefaultVariantTitle,
        variantEmptyStateFontIsCompact,
        privacyModeMasksPromptText,
        privacyModePersists,
        privacyModeCanHideImages,
        settingsPinnedInViewport,
        sidebarTagsScrollable,
        scrollbarRevealOnScroll,
        promptListScrollable,
        promptCopyPointerWorks,
        batchCardClickSelectsWithoutPaste,
        batchActionLabelsCompact,
        batchClearRemoved,
        batchSelectAllCanClearVisible,
        batchSelectAllWorks,
        batchDeleteConfirmationWorks,
        batchDeleteWorks,
        recycleBinNavigationWorks,
        trashCardDoesNotPaste,
        trashPreviewActionsAvailable,
        emptyTrashContextMenuAvailable,
        recycleRestoreWorks,
        recyclePermanentDeleteWorks,
        childTagMergeTargetAvailable,
        stablePreviewLayout,
        vocabularyModeWorks,
        vocabularyCtrlKFocusesSearch,
        vocabularySearchUiWorks,
        vocabularyDunhaoSplitWorks,
        vocabularyBulkInputFocusWorks,
        otherEditableDialogsFocusWorks,
        vocabularySidebarIsFocused,
        vocabularyContextualActionWorks,
        vocabularyCollectionInSidebar,
        vocabularyFavoriteMenuStable,
        vocabularyDirectFavoriteWorks,
        vocabularyBatchMoveDialogWorks,
        vocabularyBatchMoveWorks,
        vocabularyBatchDeleteConfirmationWorks,
        vocabularyBatchDeleteWorks,
        vocabularySingleClickCopies,
        vocabularyCombinationWorks,
        batchExitClearsSelection,
        variantClickUsedPrompt,
        singleClickUsedPrompt: firstPrompt.useCount === useCountBefore + 1,
        settingsOpened,
        cacheMaintenanceAvailable,
        cacheMaintenanceWorks,
        settingsClosed: !settings.open,
        inputFocusUsesNativeWindowActivation: typeof window.promptDock.enterInteractionMode === "undefined"
      };
    })()`);
    result.usageNoteExcludedFromClipboard = !clipboard.readText().includes("SMOKE_USAGE_NOTE");
    const mainUiScreenshotPath = path.join(app.getPath("userData"), "main-ui-smoke.png");
    fs.writeFileSync(mainUiScreenshotPath, (await mainWindow.webContents.capturePage()).toPNG());
    result.vocabularyVisualState = await mainWindow.webContents.executeJavaScript(`(() => {
      const collectionId = state.vocabulary.collections[0].id;
      const now = new Date().toISOString();
      state.vocabulary.collections.push({ id: "visual-target-collection", name: "人像摄影", createdAt: now });
      state.vocabulary.entries.push(
        { id: "visual-word-one", text: "电影感", collectionId, favorite: true, useCount: 8, createdAt: now, updatedAt: now },
        { id: "visual-word-two", text: "低机位", collectionId, favorite: false, useCount: 3, createdAt: now, updatedAt: now },
        { id: "visual-word-three", text: "柔和光线", collectionId, favorite: false, useCount: 1, createdAt: now, updatedAt: now }
      );
      setAppMode("vocabulary");
      document.querySelector('[data-vocabulary-id="visual-word-two"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 900, clientY: 390 }));
      return {
        appMode,
        shellClasses: document.querySelector(".app-shell").className,
        workspaceHidden: document.querySelector("#vocabularyWorkspace").classList.contains("hidden"),
        mainActionLabel: document.querySelector("#mainActionLabel").textContent,
        visibleWords: document.querySelectorAll(".vocabulary-word").length
      };
    })()`);
    mainWindow.showInactive();
    mainWindow.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const vocabularyScreenshotPath = path.join(app.getPath("userData"), "vocabulary-ui-smoke.png");
    fs.writeFileSync(vocabularyScreenshotPath, (await mainWindow.webContents.capturePage()).toPNG());
    await mainWindow.webContents.executeJavaScript(`(() => {
      hideFloatingMenus();
      setVocabularyInteractionMode("batch");
      document.querySelector('[data-vocabulary-id="visual-word-one"]').click();
      document.querySelector("#vocabularyBatchMoveBtn").click();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const vocabularyBatchMoveScreenshotPath = path.join(app.getPath("userData"), "vocabulary-batch-move-smoke.png");
    fs.writeFileSync(vocabularyBatchMoveScreenshotPath, (await mainWindow.webContents.capturePage()).toPNG());
    await mainWindow.webContents.executeJavaScript(`(() => {
      document.querySelector("#vocabularyBatchMoveDialog").close();
      setVocabularyInteractionMode("normal");
    })()`);
    await mainWindow.webContents.executeJavaScript(`(() => {
      state.vocabulary.entries = state.vocabulary.entries.filter((entry) => !entry.id.startsWith("visual-word-"));
      state.vocabulary.collections = state.vocabulary.collections.filter((collection) => collection.id !== "visual-target-collection");
      hideFloatingMenus();
      setAppMode("prompts");
      setFilter("all");
    })()`);
    result.vocabularyScreenshotCaptured = fs.existsSync(vocabularyScreenshotPath);
    result.vocabularyScreenshotPath = vocabularyScreenshotPath;
    result.vocabularyBatchMoveScreenshotCaptured = fs.existsSync(vocabularyBatchMoveScreenshotPath);
    result.vocabularyBatchMoveScreenshotPath = vocabularyBatchMoveScreenshotPath;
    await mainWindow.webContents.executeJavaScript(`(async () => {
      await openAuthorDialog();
      const images = [...document.querySelectorAll("#authorDialog img")];
      await Promise.all(images.filter((image) => !image.complete).map((image) => new Promise((resolve) => image.addEventListener("load", resolve, { once: true }))));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const authorScreenshotPath = path.join(app.getPath("userData"), "author-page-smoke.png");
    fs.writeFileSync(authorScreenshotPath, (await mainWindow.webContents.capturePage()).toPNG());
    await mainWindow.webContents.executeJavaScript("document.querySelector('#authorQrButton').click();");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const authorQrScreenshotPath = path.join(app.getPath("userData"), "author-qr-smoke.png");
    fs.writeFileSync(authorQrScreenshotPath, (await mainWindow.webContents.capturePage()).toPNG());
    await mainWindow.webContents.executeJavaScript("document.querySelector('#authorQrDialog').close(); document.querySelector('#authorDialog').close();");
    result.authorScreenshotCaptured = fs.existsSync(authorScreenshotPath);
    result.authorScreenshotPath = authorScreenshotPath;
    result.authorQrScreenshotCaptured = fs.existsSync(authorQrScreenshotPath);
    result.authorQrScreenshotPath = authorQrScreenshotPath;
    await mainWindow.webContents.executeJavaScript("openLightbox(0);");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const lightboxScreenshotPath = path.join(app.getPath("userData"), "lightbox-actions-smoke.png");
    fs.writeFileSync(lightboxScreenshotPath, (await mainWindow.webContents.capturePage()).toPNG());
    await mainWindow.webContents.executeJavaScript("document.querySelector('#imageLightbox').close();");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await mainWindow.webContents.executeJavaScript("state.settings.privacyMode = true; state.settings.privacyHideImages = false; applyPrivacyMode();");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const privacyScreenshotPath = path.join(app.getPath("userData"), "privacy-mode-smoke.png");
    fs.writeFileSync(privacyScreenshotPath, (await mainWindow.webContents.capturePage()).toPNG());
    await mainWindow.webContents.executeJavaScript("state.settings.privacyMode = false; applyPrivacyMode();");
    result.privacyScreenshotCaptured = fs.existsSync(privacyScreenshotPath);
    result.privacyScreenshotPath = privacyScreenshotPath;
    result.mainUiScreenshotCaptured = fs.existsSync(mainUiScreenshotPath);
    result.mainUiScreenshotPath = mainUiScreenshotPath;
    result.lightboxScreenshotCaptured = fs.existsSync(lightboxScreenshotPath);
    result.lightboxScreenshotPath = lightboxScreenshotPath;
    const batchScreenshotState = await mainWindow.webContents.executeJavaScript("setBatchMode(true); ({ batchMode, bodyClass: document.body.className, buttonActive: document.querySelector('#batchModeBtn').classList.contains('active'), toolbarVisible: !document.querySelector('#batchToolbar').classList.contains('hidden'), checkboxCount: document.querySelectorAll('.batch-checkbox').length });");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const batchScreenshotPath = path.join(app.getPath("userData"), "batch-mode-smoke.png");
    fs.writeFileSync(batchScreenshotPath, (await mainWindow.webContents.capturePage()).toPNG());
    await mainWindow.webContents.executeJavaScript("setBatchMode(false);");
    result.batchScreenshotCaptured = fs.existsSync(batchScreenshotPath);
    result.batchScreenshotPath = batchScreenshotPath;
    result.batchScreenshotState = batchScreenshotState;
    result.stableFocusableWindow = stableFocusableWindow;
    result.sqliteLegacyMigration = sqliteLegacyMigration;
    result.externalImageStorage = externalImageStorage;
    result.statePayloadExcludesImageBytes = statePayloadExcludesImageBytes;
    result.externalImageDeduplication = externalImageDeduplication;
    result.orphanImageCleanup = orphanImageCleanup;
    result.largeLibrarySqliteWorks = largeLibrarySqliteWorks;
    result.granularUsageUpdate = granularUsageUpdate;
    result.walCheckpointWorks = walCheckpointWorks;
    result.archiveRoundTrip = roundTripPrompts.length === archiveState.prompts.length
      && roundTripPrompts[0].images.length === 2
      && roundTripPrompts[0].images[0].startsWith("data:image/png;base64,")
      && roundTripPrompts[0].variants?.[0]?.title === "精简版"
      && roundTripPrompts[0].defaultVariantTitle === "通用版"
      && roundTripPrompts[0].usageNote === "归档中的使用说明"
      && roundTripPrompts[1].deletedAt === "2026-07-30T00:00:00.000Z";
    result.vocabularyArchiveRoundTrip = roundTripArchive.vocabulary.collections.length === archiveState.vocabulary.collections.length
      && roundTripArchive.vocabulary.entries.some((entry) => entry.text === "电影感" && entry.favorite);
    result.trashChangeDetectedForBackup = promptFullHash({ ...smokeState.prompts[0], deletedAt: "2026-07-30T00:00:00.000Z" })
      !== promptFullHash(smokeState.prompts[0]);
    result.legacySingleImageMigrated = legacySingleImageMigrated;
    result.imageOptimization = imageOptimization;
    result.contentDeduplication = deduplicationTest.summary.deduplicated === 1;
    result.conflictDetected = conflictTest.conflicts.length === 1;
    result.newerVersionUpdated = newerVersionTest.summary.updated === 1;
    result.automaticBackupCreated = automaticBackup.ok && fs.existsSync(automaticBackup.path);
    result.expiredBackupPruned = !fs.existsSync(expiredBackup);
    result.threeDayBackupRetention = threeDayBackupRetention;
    result.compactSizeRestored = compactSizeRestored;
    result.compactSizeDiagnostic = {
      remembered: rememberedCompactSize,
      captured: capturedCompactSize,
      restored: { width: restoredCompactBounds.width, height: restoredCompactBounds.height }
    };
    mainWindow.setOpacity(0);
    mainWindow.show();
    await mainWindow.webContents.executeJavaScript("document.querySelector('#minimizeBtn').click()");
    await new Promise((resolve) => setTimeout(resolve, 80));
    result.minimizeHidesToTray = !mainWindow.isVisible();
    result.windowsBackupVerification = backupVerification;
    revealLauncher();
    mainWindow.close();
    result.closeHidesWindow = !mainWindow.isVisible() && !mainWindow.isDestroyed();
    app.emit("activate");
    result.dockActivationRestoresWindow = mainWindow.isVisible();
    mainWindow.setSize(980, 650);
    saveWindowSize();
    const savedNormal = readState().settings.normalWindowBounds;
    result.normalWindowSizePersisted = savedNormal.width === 980 && savedNormal.height === 650;
    mainWindow.hide();
    const secondLaunch = new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 5000);
      app.once("second-instance", () => { clearTimeout(timeout); resolve(true); });
    });
    const duplicate = spawn(process.execPath, [__dirname], { env: process.env, stdio: "ignore" });
    const duplicateExit = new Promise(resolve => duplicate.once("exit", code => resolve(code)));
    result.secondInstanceRevealsExisting = await secondLaunch && mainWindow.isVisible();
    result.secondInstanceExitsCleanly = await duplicateExit === 0;
    const firstShortcut = IS_MAC ? "Command+Alt+F9" : "Control+Alt+F9";
    const occupiedShortcut = IS_MAC ? "Command+Alt+F10" : "Control+Alt+F10";
    const registered = registerShortcut(firstShortcut);
    globalShortcut.register(occupiedShortcut, () => {});
    const conflict = registerShortcut(occupiedShortcut);
    result.shortcutConflictKeepsPrevious = registered.ok && !conflict.ok && activeShortcut === firstShortcut && globalShortcut.isRegistered(firstShortcut);
    result.invalidShortcutDoesNotThrow = !registerShortcut("Not+A+Real+Key").ok;
    globalShortcut.unregister(occupiedShortcut);
    const failedChecks = Object.entries(result).filter(([, value]) => value === false).map(([key]) => key);
    mainWindow.setOpacity(1);
    fs.writeFileSync(path.join(app.getPath("userData"), "smoke-result.json"), JSON.stringify(result, null, 2));
    console.log(`SMOKE_OK:${JSON.stringify(result)}`);
    app.isQuitting = true;
    process.exitCode = failedChecks.length ? 2 : 0;
    app.quit();
  });
  mainWindow.on("close", (event) => {
    saveWindowSize();
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "logo.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Prompt Dock");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Prompt Dock", click: revealLauncher },
    { type: "separator" },
    { label: "退出", click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on("double-click", showLauncher);
}

function saveWindowSize() {
  clearTimeout(windowSaveTimer);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = mainWindow.getBounds();
  const state = readState();
  if (windowMode) state.settings.compactWindowSize = { width, height };
  else state.settings.normalWindowBounds = { width, height };
  writeState(state);
}
function scheduleWindowSave() {
  clearTimeout(windowSaveTimer);
  windowSaveTimer = setTimeout(saveWindowSize, 250);
}
function startMacHelper() {
  if (!IS_MAC) return;
  const executable = app.isPackaged ? path.join(process.resourcesPath, "PromptDock.MacHelper")
    : path.join(__dirname, "build", "PromptDock.MacHelper");
  macHelper = spawn(executable, [String(process.pid)], { stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  macHelper.stdout.on("data", chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const result = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (result.startsWith("TARGET:")) { if (testProfile) console.log(result); continue; }
      macReply?.(result);
    }
  });
  macHelper.on("error", () => { macReply?.("FAILED"); macHelper = null; });
  macHelper.on("exit", () => { macReply?.("FAILED"); macHelper = null; });
  macHelper.stdin.on("error", () => macReply?.("FAILED"));
}
async function simulatePasteShortcut() {
  if (IS_MAC) {
    if (!macHelper) return { ok: false, message: "内容已复制；Mac 粘贴助手不可用，请使用 ⌘V。" };
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => { macReply = null; resolve("FAILED"); }, 2500);
      macReply = value => { clearTimeout(timer); macReply = null; resolve(value); };
      macHelper.stdin.write("paste\n");
    });
    if (testProfile) console.log("MAC_PASTE_RESULT:", result);
    if (result === "PERMISSION" && !macPermissionNoticeShown && !process.env.PROMPT_DOCK_NATIVE_TEST) {
      macPermissionNoticeShown = true;
      const choice = await dialog.showMessageBox(mainWindow, {
        type: "info", title: "需要辅助功能权限", message: "内容已复制；直接粘贴需要你的授权。",
        detail: "在系统设置 → 隐私与安全性 → 辅助功能中启用 Prompt Dock。开发运行时可能显示 Electron 或 PromptDock.MacHelper。授权后先点击外部输入框，再回来点击 Prompt；也可以直接手动 ⌘V。",
        buttons: ["打开系统设置", "稍后，手动粘贴"], cancelId: 1
      });
      if (choice.response === 0) await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    }
    return { ok: result === "OK", message: result === "OK" ? "" : result === "PERMISSION"
      ? "内容已复制。请在系统设置 → 隐私与安全性 → 辅助功能中允许 Prompt Dock（开发时为 Electron／MacHelper），再重试；也可手动 ⌘V。"
      : result === "NO_TARGET" ? "内容已复制，请先点击外部应用的输入框，再点击 Prompt。" : "内容已复制；无法自动粘贴，请使用 ⌘V。" };
  }
  if (process.platform !== "win32") {
    return { ok: false, message: "当前系统暂不支持模拟粘贴" };
  }
  const result = await runNativeHelper(["paste"]);
  return {
    ok: result === "OK",
    keptVisible: mainWindow.isAlwaysOnTop(),
    message: result === "OK" ? "" : "无法模拟 Ctrl+V",
    diagnostic: SMOKE_TEST ? result : undefined
  };
}

function setCompactMode(enabled, requestedSize = null) {
  const next = Boolean(enabled);
  saveWindowSize();
  if (next && !windowMode) normalWindowBounds = mainWindow.getBounds();
  windowMode = next;
  if (next) {
    if (!normalWindowBounds) normalWindowBounds = mainWindow.getBounds();
    const current = mainWindow.getBounds();
    const display = screen.getDisplayMatching(current);
    const saved = requestedSize || readState().settings.compactWindowSize || {};
    const width = Math.min(display.workArea.width, Math.max(360, Number(saved.width) || 420));
    const height = Math.min(display.workArea.height, Math.max(360, Number(saved.height) || 520));
    mainWindow.setMinimumSize(360, 360);
    mainWindow.setBounds({
      x: current.x + Math.max(0, current.width - width),
      y: current.y,
      width,
      height
    }, true);
    mainWindow.setAlwaysOnTop(true, "floating");
    return { width, height };
  } else {
    const compactBounds = mainWindow.getBounds();
    const compactWindowSize = {
      width: Math.max(360, compactBounds.width),
      height: Math.max(360, compactBounds.height)
    };
    mainWindow.setMinimumSize(840, 560);
    mainWindow.setBounds(normalWindowBounds || {
      x: mainWindow.getBounds().x,
      y: mainWindow.getBounds().y,
      width: 1080,
      height: 700
    }, true);
    normalWindowBounds = null;
    return compactWindowSize;
  }
}

app.whenReady().then(() => {
  getStorage().ensureDatabase();
  protocol.handle(IMAGE_SCHEME, (request) => {
    const filePath = getStorage().assetPathFromUrl(request.url);
    if (!filePath) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
  startMacHelper();
  if (IS_MAC) Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "窗口", submenu: [{ label: "打开 Prompt Dock", click: revealLauncher }] }
  ]));
  createWindow();
  if (process.env.PROMPT_DOCK_NATIVE_TEST && testProfile) {
    mainWindow.webContents.once("did-finish-load", async () => {
      const output = path.join(testProfile, "native-pasted.txt");
      const target = spawn(process.env.PROMPT_DOCK_NATIVE_TEST, [output]);
      await new Promise(resolve => setTimeout(resolve, 1500));
      revealLauncher();
      await new Promise(resolve => setTimeout(resolve, 300));
      const expected = "Prompt Dock 原生粘贴测试 — isolated 123";
      clipboard.writeText(expected);
      const paste = await simulatePasteShortcut();
      await new Promise(resolve => setTimeout(resolve, 500));
      const passed = fs.existsSync(output) && fs.readFileSync(output, "utf8") === expected;
      fs.writeFileSync(path.join(testProfile, "native-result.json"), JSON.stringify({ paste, passed }));
      console.log("NATIVE_TEST:", { paste, passed });
      target.kill();
      app.quit();
    });
  }
  if (SMOKE_TEST) return;
  createTray();
  const state = readState();
  const result = registerShortcut(state.settings.shortcut || DEFAULT_SHORTCUT);
  if (!result.ok) {
    // A temporary conflict must never overwrite the user's saved preference.
    dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "快捷键暂时不可用",
      message: `无法注册唤出快捷键 ${state.settings.shortcut || DEFAULT_SHORTCUT}`,
      detail: "快捷键可能被其他程序占用。你的设置已保留，可以通过托盘打开 Prompt Dock，在设置中更换快捷键，或关闭冲突程序后重新启动。",
      buttons: ["知道了"]
    });
  }
});

app.on("window-all-closed", (event) => event.preventDefault());
app.on("activate", () => { if (mainWindow) revealLauncher(); });
app.on("before-quit", () => { app.isQuitting = true; saveWindowSize(); });
app.on("will-quit", () => {
  clearTimeout(windowSaveTimer);
  macHelper?.kill();
  globalShortcut.unregisterAll();
  storage?.close();
});

ipcMain.handle("state:get", () => readState());
ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("storage:migration-info", () => getStorage().getMigrationInfo());
ipcMain.handle("cache:status", async () => ({ bytes: await session.defaultSession.getCacheSize() }));
ipcMain.handle("cache:clear", async () => {
  await session.defaultSession.clearCache();
  return { ok: true, bytes: await session.defaultSession.getCacheSize() };
});
ipcMain.handle("prompt:record-use", (_, promptId, variantId, lastUsed) => {
  try {
    return getStorage().recordPromptUse(promptId, variantId, lastUsed);
  } catch (error) {
    return { ok: false, message: error.message };
  }
});
ipcMain.handle("vocabulary:record-use", (_, entryIds, lastUsed) => {
  try {
    return getStorage().recordVocabularyUse(entryIds, lastUsed);
  } catch (error) {
    return { ok: false, message: error.message, updated: [] };
  }
});
ipcMain.handle("state:save", (_, nextState) => {
  const previousState = readState();
  const libraryChanged = libraryFingerprint(previousState.prompts) !== libraryFingerprint(nextState.prompts)
    || vocabularyFingerprint(previousState.vocabulary) !== vocabularyFingerprint(nextState.vocabulary);
  nextState.settings.normalWindowBounds = previousState.settings.normalWindowBounds;
  let savedState = writeState(nextState);
  const lastBackupDay = savedState.settings.lastBackupAt
    ? localDateStamp(new Date(savedState.settings.lastBackupAt))
    : "";
  if (libraryChanged && savedState.settings.backupDirectory && lastBackupDay !== localDateStamp()) {
    try {
      const backup = createAutomaticBackup(savedState);
      if (backup.ok) {
        savedState.settings.lastBackupAt = backup.at;
        savedState = writeState(savedState);
      }
      return { ok: true, backup, state: savedState };
    } catch (error) {
      return { ok: true, state: savedState, backup: { ok: false, message: error.message } };
    }
  }
  return { ok: true, state: savedState };
});
ipcMain.handle("window:minimize", () => mainWindow.hide());
ipcMain.handle("window:hide", () => mainWindow.hide());
ipcMain.handle("window:set-always-on-top", (_, enabled) => {
  mainWindow.setAlwaysOnTop(Boolean(enabled), "floating");
  return { ok: true };
});
ipcMain.handle("window:set-compact-mode", (_, enabled, savedSize) => {
  const compactWindowSize = setCompactMode(enabled, savedSize);
  return { ok: true, compactWindowSize };
});
ipcMain.handle("window:get-bounds", () => mainWindow.getBounds());
ipcMain.handle("window:quit", () => {
  app.isQuitting = true;
  app.quit();
});
ipcMain.handle("clipboard:copy", (_, text) => {
  clipboard.writeText(String(text || ""));
  return { ok: true };
});
ipcMain.handle("clipboard:paste", (_, text) => {
  const requestedText = String(text || "");
  const operation = async () => {
    clipboard.writeText(requestedText);
    if (SMOKE_TEST) return { ok: true, keptVisible: true };
    if (!IS_MAC) {
      mainWindow.blur();
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
    return simulatePasteShortcut();
  };
  pasteQueue = pasteQueue.then(operation, operation);
  return pasteQueue;
});
ipcMain.handle("shortcut:set", (_, shortcut) => {
  const result = registerShortcut(shortcut);
  if (result.ok) {
    const state = readState();
    state.settings.shortcut = shortcut;
    writeState(state);
  }
  return result;
});
ipcMain.handle("image:choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 Prompt 图片",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true, images: [], errors: [] };
  const buffers = [];
  const errors = [];
  for (const filePath of result.filePaths.slice(0, MAX_PROMPT_IMAGES)) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_SOURCE_IMAGE_BYTES) throw new Error(`${path.basename(filePath)} 超过 5 MB`);
      buffers.push(fs.readFileSync(filePath));
    } catch (error) {
      errors.push(error.message);
    }
  }
  const imported = importImageBuffers(buffers);
  return { canceled: false, images: imported.images, errors: [...errors, ...imported.errors] };
});
ipcMain.handle("image:import-buffers", (_, buffers) => importImageBuffers(buffers));
ipcMain.handle("image:paste", () => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return { images: [], errors: ["剪贴板中没有图片"] };
  try {
    return { images: [optimizeNativeImage(image, true)], errors: [] };
  } catch (error) {
    return { images: [], errors: [error.message] };
  }
});
ipcMain.handle("image:copy", (_, source) => {
  try {
    const resolved = getStorage().resolveImageSource(source);
    if (!resolved?.buffer.length) return { ok: false, message: "无法读取当前图片" };
    const image = nativeImage.createFromBuffer(resolved.buffer);
    if (image.isEmpty()) return { ok: false, message: "当前图片格式无法复制到剪贴板" };
    if (!SMOKE_TEST) clipboard.writeImage(image);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});
ipcMain.handle("image:save", async (_, source, promptTitle, imageIndex) => {
  try {
    const resolved = getStorage().resolveImageSource(source);
    if (!resolved?.buffer.length) return { canceled: true, error: "无法读取当前图片" };
    const extension = resolved.extension === "jpeg" ? "jpg" : resolved.extension;
    const sequence = String(Math.max(1, Number(imageIndex) || 1)).padStart(2, "0");
    const defaultPath = `${safeFileName(promptTitle)}-${sequence}.${extension}`;
    if (SMOKE_TEST) return { canceled: false, path: defaultPath, bytes: resolved.buffer.length };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "图片另存为",
      defaultPath,
      filters: [{ name: `${extension.toUpperCase()} 图片`, extensions: [extension] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, resolved.buffer);
    return { canceled: false, path: result.filePath };
  } catch (error) {
    return { canceled: true, error: error.message };
  }
});
ipcMain.handle("backup:choose-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择自动备份目录",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return { canceled: false, directory: result.filePaths[0] };
});
ipcMain.handle("backup:run-now", (_, requestedDirectory) => {
  try {
    const state = readState();
    const directory = String(requestedDirectory || state.settings.backupDirectory || "").trim();
    if (!directory) return { ok: false, message: "请先设置备份路径" };
    state.settings.backupDirectory = directory;
    const backup = createAutomaticBackup(state);
    state.settings.lastBackupAt = backup.at;
    writeState(state);
    return backup;
  } catch (error) {
    return { ok: false, message: error.message };
  }
});
ipcMain.handle("backup:status", (_, requestedDirectory) => {
  const directory = String(requestedDirectory || "").trim();
  const storageStats = getStorage().getStats();
  if (!directory || !fs.existsSync(directory)) return { count: 0, bytes: 0, libraryBytes: storageStats.imageBytes, expectedThreeDayBytes: storageStats.imageBytes * 3, imageCount: storageStats.imageCount };
  let count = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^Prompt-Dock-auto-.*\.promptdock$/i.test(name)) continue;
    try {
      const stat = fs.statSync(path.join(directory, name));
      count += 1;
      bytes += stat.size;
    } catch {}
  }
  return { count, bytes, libraryBytes: storageStats.imageBytes, expectedThreeDayBytes: storageStats.imageBytes * 3, imageCount: storageStats.imageCount };
});
ipcMain.handle("data:export", async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出 Prompt Dock 备份",
    defaultPath: `Prompt-Dock-${localDateStamp()}.promptdock`,
    filters: [{ name: "Prompt Dock 备份", extensions: ["promptdock"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    createPromptDockArchive(readState(), result.filePath);
    return { canceled: false, path: result.filePath };
  } catch (error) {
    return { canceled: true, error: error.message };
  }
});
ipcMain.handle("data:import", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入并合并 Prompt 库",
    properties: ["openFile"],
    filters: [
      { name: "Prompt Dock 备份", extensions: ["promptdock"] },
      { name: "旧版 JSON 备份", extensions: ["json"] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  try {
    let current = readState();
    const incoming = loadPromptDockFile(result.filePaths[0]);
    const merge = mergeImportedPrompts(current.prompts, incoming.prompts);
    const vocabularyMerge = mergeVocabulary(current.vocabulary, incoming.vocabulary);
    if (merge.conflicts.length) {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: "question",
        title: "发现 Prompt 冲突",
        message: `有 ${merge.conflicts.length} 条 Prompt 在两台电脑上存在不同版本。`,
        detail: "请选择这些冲突的统一处理方式。其他可自动合并的 Prompt 不受影响。",
        buttons: ["保留本机版本", "使用导入版本", "两个都保留", "取消导入"],
        defaultId: 0,
        cancelId: 3,
        noLink: true
      });
      if (choice.response === 3) return { canceled: true };
      for (const conflict of merge.conflicts) {
        if (choice.response === 1) {
          merge.merged[conflict.index] = {
            ...conflict.incoming,
            useCount: Math.max(conflict.local.useCount || 0, conflict.incoming.useCount || 0)
          };
          merge.summary.updated += 1;
        } else if (choice.response === 2) {
          merge.merged.push({
            ...conflict.incoming,
            id: randomUUID(),
            title: `${conflict.incoming.title}（导入副本）`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          merge.summary.added += 1;
        } else {
          merge.summary.skipped += 1;
        }
      }
    }
    if (current.settings.backupDirectory) {
      try { createAutomaticBackup(current, "before-import"); } catch {}
    }
    current.prompts = merge.merged;
    current.vocabulary = vocabularyMerge.vocabulary;
    current = writeState(current);
    if (current.settings.backupDirectory) {
      try {
        const backup = createAutomaticBackup(current);
        current.settings.lastBackupAt = backup.at;
        current = writeState(current);
      } catch {}
    }
    return { canceled: false, state: current, summary: { ...merge.summary, ...vocabularyMerge.summary } };
  } catch (error) {
    return { canceled: true, error: `导入失败：${error.message}` };
  }
});
