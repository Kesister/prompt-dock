const fs = require("fs");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const IMAGE_SCHEME = "prompt-dock-image";
const THUMBNAIL_EDGE = 360;

function safeExtension(value) {
  const extension = String(value || "png").toLowerCase().replace("jpeg", "jpg").replace("svg+xml", "svg");
  return ["png", "jpg", "webp", "gif", "svg"].includes(extension) ? extension : "png";
}

function decodeDataImage(dataUrl) {
  const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(dataUrl || ""));
  if (!match) return null;
  return { extension: safeExtension(match[1]), buffer: Buffer.from(match[2], "base64") };
}

function parseAssetUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== `${IMAGE_SCHEME}:` || url.hostname !== "asset") return null;
    const [, kind, filename] = url.pathname.split("/");
    const match = /^([a-f0-9]{64})\.([a-z0-9]+)$/i.exec(filename || "");
    if (!match || !["original", "thumbnail"].includes(kind)) return null;
    return { kind, hash: match[1].toLowerCase(), extension: safeExtension(match[2]) };
  } catch {
    return null;
  }
}

function atomicWrite(filePath, buffer) {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, buffer);
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    if (!fs.existsSync(filePath)) throw error;
  }
}

class PromptStorage {
  constructor({ userDataPath, initialState, nativeImage, hasTransparency, maxPromptImages = 6 }) {
    this.userDataPath = userDataPath;
    this.initialState = initialState;
    this.nativeImage = nativeImage;
    this.hasTransparency = hasTransparency;
    this.maxPromptImages = maxPromptImages;
    this.database = null;
    this.migrationInfo = { performed: false, backups: [] };
    this.writeOperations = 0;
  }

  databasePath() {
    return path.join(this.userDataPath, "prompt-dock.sqlite");
  }

  legacyPath() {
    return path.join(this.userDataPath, "prompt-dock.json");
  }

  originalDirectory() {
    return path.join(this.userDataPath, "images", "original");
  }

  thumbnailDirectory() {
    return path.join(this.userDataPath, "images", "thumbnails");
  }

  assetUrl(hash, extension, kind = "original") {
    return `${IMAGE_SCHEME}://asset/${kind}/${hash}.${safeExtension(extension)}`;
  }

  ensureDatabase() {
    if (this.database) return this.database;
    fs.mkdirSync(this.userDataPath, { recursive: true });
    const databaseExisted = fs.existsSync(this.databasePath());
    this.database = new DatabaseSync(this.databasePath());
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA wal_autocheckpoint = 500;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vocabulary (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        position INTEGER NOT NULL,
        touched INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS images (
        hash TEXT PRIMARY KEY,
        extension TEXT NOT NULL,
        thumbnail_extension TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prompt_images (
        prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        image_hash TEXT NOT NULL REFERENCES images(hash),
        position INTEGER NOT NULL,
        PRIMARY KEY (prompt_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_images_hash ON prompt_images(image_hash);
    `);
    this.database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')").run();

    const promptCount = Number(this.database.prepare("SELECT COUNT(*) AS count FROM prompts").get().count);
    const hasSettings = Boolean(this.database.prepare("SELECT 1 AS found FROM settings WHERE id = 1").get());
    if (!databaseExisted || (!promptCount && !hasSettings)) {
      const migrated = this.readLegacyState();
      this.writeState(migrated || this.initialState());
    }
    return this.database;
  }

  readLegacyState() {
    const legacyPath = this.legacyPath();
    if (!fs.existsSync(legacyPath)) return null;
    try {
      const saved = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
      if (!Array.isArray(saved.prompts)) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const localBackup = path.join(this.userDataPath, `prompt-dock-before-sqlite-${stamp}.json`);
      fs.copyFileSync(legacyPath, localBackup);
      this.migrationInfo = { performed: true, backups: [localBackup] };
      const backupDirectory = String(saved.settings?.backupDirectory || "").trim();
      if (backupDirectory) {
        try {
          fs.mkdirSync(backupDirectory, { recursive: true });
          const externalBackup = path.join(backupDirectory, `Prompt-Dock-before-sqlite-${stamp}.json`);
          fs.copyFileSync(legacyPath, externalBackup);
          this.migrationInfo.backups.push(externalBackup);
        } catch {}
      }
      const defaults = this.initialState();
      return {
        ...saved,
        settings: { ...defaults.settings, ...(saved.settings || {}) },
        prompts: saved.prompts.map((prompt) => this.normalizeLegacyPrompt(prompt))
      };
    } catch {
      return null;
    }
  }

  normalizeLegacyPrompt(prompt) {
    const legacyImage = typeof prompt?.image === "string" && prompt.image ? [prompt.image] : [];
    const images = (Array.isArray(prompt?.images) ? prompt.images : legacyImage)
      .filter((image) => typeof image === "string" && (image.startsWith("data:image/") || parseAssetUrl(image)))
      .slice(0, this.maxPromptImages);
    const { image, imageThumbnails, ...rest } = prompt || {};
    return { ...rest, images };
  }

  makeThumbnail(buffer, sourceExtension = "png") {
    const source = this.nativeImage.createFromBuffer(buffer);
    if (!source || source.isEmpty()) return { buffer, extension: safeExtension(sourceExtension), width: 0, height: 0 };
    const size = source.getSize();
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(size.width, size.height));
    const thumbnail = scale < 1 ? source.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: "best"
    }) : source;
    const transparent = this.hasTransparency(thumbnail);
    return {
      buffer: transparent ? thumbnail.toPNG() : thumbnail.toJPEG(76),
      extension: transparent ? "png" : "jpg",
      width: size.width,
      height: size.height
    };
  }

  storeImageSource(source) {
    const existingAsset = parseAssetUrl(source);
    if (existingAsset) {
      const row = this.ensureDatabase().prepare("SELECT hash, extension, thumbnail_extension FROM images WHERE hash = ?").get(existingAsset.hash);
      if (row) return row;
    }
    const decoded = decodeDataImage(source);
    if (!decoded?.buffer.length) return null;
    const hash = createHash("sha256").update(decoded.buffer).digest("hex");
    const existing = this.ensureDatabase().prepare("SELECT hash, extension, thumbnail_extension FROM images WHERE hash = ?").get(hash);
    if (existing) return existing;
    const extension = safeExtension(decoded.extension);
    const thumbnail = this.makeThumbnail(decoded.buffer, extension);
    atomicWrite(path.join(this.originalDirectory(), `${hash}.${extension}`), decoded.buffer);
    atomicWrite(path.join(this.thumbnailDirectory(), `${hash}.${thumbnail.extension}`), thumbnail.buffer);
    this.database.prepare(`
      INSERT OR IGNORE INTO images
      (hash, extension, thumbnail_extension, byte_size, width, height, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(hash, extension, thumbnail.extension, decoded.buffer.length, thumbnail.width, thumbnail.height, new Date().toISOString());
    return { hash, extension, thumbnail_extension: thumbnail.extension };
  }

  readState() {
    const database = this.ensureDatabase();
    const defaults = this.initialState();
    let settings = defaults.settings;
    try {
      const row = database.prepare("SELECT data_json FROM settings WHERE id = 1").get();
      if (row) settings = { ...settings, ...JSON.parse(row.data_json) };
    } catch {}

    let vocabulary = defaults.vocabulary || { collections: [], entries: [], settings: {} };
    try {
      const row = database.prepare("SELECT data_json FROM vocabulary WHERE id = 1").get();
      if (row) {
        const saved = JSON.parse(row.data_json);
        vocabulary = {
          collections: Array.isArray(saved?.collections) ? saved.collections : vocabulary.collections,
          entries: Array.isArray(saved?.entries) ? saved.entries : vocabulary.entries,
          settings: { ...(vocabulary.settings || {}), ...(saved?.settings || {}) }
        };
      }
    } catch {}

    const imageRows = database.prepare(`
      SELECT pi.prompt_id, pi.position, i.hash, i.extension, i.thumbnail_extension
      FROM prompt_images pi JOIN images i ON i.hash = pi.image_hash
      ORDER BY pi.prompt_id, pi.position
    `).all();
    const imagesByPrompt = new Map();
    for (const row of imageRows) {
      const item = imagesByPrompt.get(row.prompt_id) || { images: [], thumbnails: [] };
      item.images.push(this.assetUrl(row.hash, row.extension, "original"));
      item.thumbnails.push(this.assetUrl(row.hash, row.thumbnail_extension, "thumbnail"));
      imagesByPrompt.set(row.prompt_id, item);
    }

    const prompts = database.prepare("SELECT id, data_json FROM prompts ORDER BY position, rowid").all().map((row) => {
      const data = JSON.parse(row.data_json);
      const imageData = imagesByPrompt.get(row.id) || { images: [], thumbnails: [] };
      return { ...data, id: row.id, images: imageData.images, imageThumbnails: imageData.thumbnails };
    });
    return { settings, prompts, vocabulary };
  }

  writeState(state) {
    const database = this.ensureDatabase();
    const defaults = this.initialState();
    const settings = { ...defaults.settings, ...(state?.settings || {}) };
    const vocabulary = {
      collections: Array.isArray(state?.vocabulary?.collections) ? state.vocabulary.collections : (defaults.vocabulary?.collections || []),
      entries: Array.isArray(state?.vocabulary?.entries) ? state.vocabulary.entries : (defaults.vocabulary?.entries || []),
      settings: { ...(defaults.vocabulary?.settings || {}), ...(state?.vocabulary?.settings || {}) }
    };
    const records = (Array.isArray(state?.prompts) ? state.prompts : []).map((rawPrompt, position) => {
      const prompt = this.normalizeLegacyPrompt(rawPrompt);
      const refs = (prompt.images || []).map((source) => this.storeImageSource(source)).filter(Boolean);
      const { images, imageThumbnails, ...data } = prompt;
      data.id = String(data.id || randomUUID());
      return { id: data.id, data, refs, position };
    });

    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        INSERT INTO settings (id, data_json) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json
        WHERE settings.data_json <> excluded.data_json
      `).run(JSON.stringify(settings));
      database.prepare(`
        INSERT INTO vocabulary (id, data_json) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json
        WHERE vocabulary.data_json <> excluded.data_json
      `).run(JSON.stringify(vocabulary));
      const upsertPrompt = database.prepare(`
        INSERT INTO prompts (id, data_json, position, touched) VALUES (?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET
          data_json = excluded.data_json,
          position = excluded.position
        WHERE prompts.data_json <> excluded.data_json OR prompts.position <> excluded.position
      `);
      const currentImages = database.prepare("SELECT image_hash FROM prompt_images WHERE prompt_id = ? ORDER BY position");
      const deletePromptImages = database.prepare("DELETE FROM prompt_images WHERE prompt_id = ?");
      const insertPromptImage = database.prepare("INSERT INTO prompt_images (prompt_id, image_hash, position) VALUES (?, ?, ?)");
      database.exec("CREATE TEMP TABLE IF NOT EXISTS write_seen_prompts (id TEXT PRIMARY KEY); DELETE FROM write_seen_prompts");
      const markPromptSeen = database.prepare("INSERT INTO write_seen_prompts (id) VALUES (?)");
      for (const record of records) {
        markPromptSeen.run(record.id);
        upsertPrompt.run(record.id, JSON.stringify(record.data), record.position);
        const current = currentImages.all(record.id).map((row) => row.image_hash);
        const next = record.refs.map((ref) => ref.hash);
        if (JSON.stringify(current) !== JSON.stringify(next)) {
          deletePromptImages.run(record.id);
          record.refs.forEach((ref, position) => insertPromptImage.run(record.id, ref.hash, position));
        }
      }
      database.exec("DELETE FROM prompts WHERE NOT EXISTS (SELECT 1 FROM write_seen_prompts seen WHERE seen.id = prompts.id)");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    this.cleanupOrphanImages();
    this.noteWrite();
    return this.readState();
  }

  recordPromptUse(promptId, variantId = "default", lastUsed = new Date().toISOString()) {
    const database = this.ensureDatabase();
    const row = database.prepare("SELECT data_json FROM prompts WHERE id = ?").get(String(promptId || ""));
    if (!row) return { ok: false, message: "Prompt 不存在" };
    const prompt = JSON.parse(row.data_json);
    prompt.useCount = (Number(prompt.useCount) || 0) + 1;
    prompt.lastUsed = String(lastUsed || new Date().toISOString());
    let variantUseCount = 0;
    if (variantId && variantId !== "default" && Array.isArray(prompt.variants)) {
      const variant = prompt.variants.find((item) => item.id === variantId);
      if (variant) {
        variant.useCount = (Number(variant.useCount) || 0) + 1;
        variant.lastUsed = prompt.lastUsed;
        variantUseCount = variant.useCount;
      }
    }
    database.prepare("UPDATE prompts SET data_json = ? WHERE id = ?").run(JSON.stringify(prompt), String(promptId));
    this.noteWrite();
    return { ok: true, useCount: prompt.useCount, lastUsed: prompt.lastUsed, variantUseCount };
  }

  recordVocabularyUse(entryIds, lastUsed = new Date().toISOString()) {
    const database = this.ensureDatabase();
    const ids = new Set((Array.isArray(entryIds) ? entryIds : [entryIds]).map(String));
    if (!ids.size) return { ok: false, updated: [] };
    const defaults = this.initialState();
    const row = database.prepare("SELECT data_json FROM vocabulary WHERE id = 1").get();
    const vocabulary = row ? JSON.parse(row.data_json) : (defaults.vocabulary || { collections: [], entries: [], settings: {} });
    const updated = [];
    vocabulary.entries = (Array.isArray(vocabulary.entries) ? vocabulary.entries : []).map((entry) => {
      if (!ids.has(String(entry.id))) return entry;
      const next = { ...entry, useCount: (Number(entry.useCount) || 0) + 1, lastUsed: String(lastUsed || new Date().toISOString()) };
      updated.push({ id: next.id, useCount: next.useCount, lastUsed: next.lastUsed });
      return next;
    });
    database.prepare(`
      INSERT INTO vocabulary (id, data_json) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json
    `).run(JSON.stringify(vocabulary));
    this.noteWrite();
    return { ok: true, updated };
  }

  noteWrite() {
    this.writeOperations += 1;
    if (this.writeOperations % 100 === 0) this.checkpoint("PASSIVE");
  }

  checkpoint(mode = "PASSIVE") {
    const safeMode = ["PASSIVE", "RESTART", "TRUNCATE"].includes(mode) ? mode : "PASSIVE";
    try {
      this.ensureDatabase().exec(`PRAGMA wal_checkpoint(${safeMode})`);
      return true;
    } catch {
      return false;
    }
  }

  cleanupOrphanImages() {
    const database = this.ensureDatabase();
    const orphans = database.prepare(`
      SELECT i.hash, i.extension, i.thumbnail_extension
      FROM images i LEFT JOIN prompt_images pi ON pi.image_hash = i.hash
      WHERE pi.image_hash IS NULL
    `).all();
    const remove = database.prepare("DELETE FROM images WHERE hash = ?");
    for (const orphan of orphans) {
      remove.run(orphan.hash);
      try { fs.unlinkSync(path.join(this.originalDirectory(), `${orphan.hash}.${orphan.extension}`)); } catch {}
      try { fs.unlinkSync(path.join(this.thumbnailDirectory(), `${orphan.hash}.${orphan.thumbnail_extension}`)); } catch {}
    }
    return orphans.length;
  }

  resolveImageSource(source) {
    const decoded = decodeDataImage(source);
    if (decoded) return { ...decoded, hash: createHash("sha256").update(decoded.buffer).digest("hex") };
    const asset = parseAssetUrl(source);
    if (!asset) return null;
    const row = this.ensureDatabase().prepare("SELECT extension, thumbnail_extension FROM images WHERE hash = ?").get(asset.hash);
    if (!row) return null;
    const extension = asset.kind === "thumbnail" ? row.thumbnail_extension : row.extension;
    const directory = asset.kind === "thumbnail" ? this.thumbnailDirectory() : this.originalDirectory();
    const filePath = path.join(directory, `${asset.hash}.${extension}`);
    if (!fs.existsSync(filePath)) return null;
    return { extension, buffer: fs.readFileSync(filePath), hash: asset.hash, filePath };
  }

  assetPathFromUrl(value) {
    const asset = parseAssetUrl(value);
    if (!asset) return null;
    const row = this.ensureDatabase().prepare("SELECT extension, thumbnail_extension FROM images WHERE hash = ?").get(asset.hash);
    if (!row) return null;
    const extension = asset.kind === "thumbnail" ? row.thumbnail_extension : row.extension;
    const directory = asset.kind === "thumbnail" ? this.thumbnailDirectory() : this.originalDirectory();
    const filePath = path.resolve(directory, `${asset.hash}.${extension}`);
    const expectedRoot = `${path.resolve(directory)}${path.sep}`;
    return filePath.startsWith(expectedRoot) && fs.existsSync(filePath) ? filePath : null;
  }

  imageContentKey(source) {
    const asset = parseAssetUrl(source);
    if (asset) return asset.hash;
    const decoded = decodeDataImage(source);
    return decoded ? createHash("sha256").update(decoded.buffer).digest("hex") : String(source || "");
  }

  getMigrationInfo() {
    return this.migrationInfo;
  }

  getStats() {
    const database = this.ensureDatabase();
    const row = database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM images").get();
    return { imageCount: Number(row.count), imageBytes: Number(row.bytes), databasePath: this.databasePath() };
  }

  close() {
    if (!this.database) return;
    try { this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    try { this.database.close(); } catch {}
    this.database = null;
  }
}

module.exports = {
  IMAGE_SCHEME,
  PromptStorage,
  decodeDataImage,
  parseAssetUrl
};
