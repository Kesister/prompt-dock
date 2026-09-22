const IS_MAC = window.promptDock.platform === "darwin";
const DEFAULT_NEW_SHORTCUT = IS_MAC ? "Command+N" : "Control+N";
let state;
let selectedId = null;
let currentFilter = "all";
let currentSort = "updated";
let editingId = null;
let pendingImages = [];
let pendingVariants = [];
let activeVariantId = "default";
let previewImageIndex = 0;
let draggedImageIndex = null;
let lightboxImageIndex = 0;
let lightboxZoom = 1;
let lightboxPanX = 0;
let lightboxPanY = 0;
let lightboxPointer = null;
let recordingShortcut = null;
let variantPopoverTimer = null;
let compactSidebarOpen = false;
let compactSizeSaveTimer = null;
let tagContextName = "";
let tagContextButton = null;
let tagMergeSourceName = "";
let tagMergeSourceScope = "exact";
let tagDeleteName = "";
let tagDeleteScope = "exact";
let imageCopyPending = false;
let searchRenderTimer = null;
let vocabularySearchRenderTimer = null;
let editorFocusTimer = null;
let batchMode = false;
const batchSelection = new Set();
let appMode = "prompts";
let vocabularyFilter = "all";
let vocabularyCombineMode = false;
let vocabularyBatchMode = false;
let vocabularyContextId = "";
let vocabularyCollectionContextId = "";
const vocabularySelection = new Set();
const vocabularyBatchSelection = new Set();
const scrollFadeTimers = new WeakMap();
let persistQueue = Promise.resolve();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[char]));
const iconSvg = (name, className = "") => `<svg class="ui-icon ${className}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;

function normalizeTagPath(value) {
  return String(value || "").split("/").map((part) => part.trim()).filter(Boolean).join("/");
}

function tagPathParts(value) {
  const normalized = normalizeTagPath(value);
  const [root = "", ...rest] = normalized.split("/");
  return { full: normalized, root, child: rest.join("/") };
}

function tagDisplayLabel(value, separator = " › ") {
  const { root, child } = tagPathParts(value);
  return child ? `${root}${separator}${child}` : root;
}

function tagSuggestionMarkup(value) {
  const { root, child } = tagPathParts(value);
  return child
    ? `<small>${escapeHtml(root)}</small><span>${escapeHtml(child)}</span>`
    : `<span>${escapeHtml(root)}</span>`;
}

function tagTreeStats() {
  const roots = new Map();
  state.prompts.forEach((prompt) => {
    if (prompt.deletedAt) return;
    const promptRootKeys = new Set();
    (prompt.tags || []).forEach((rawTag) => {
      const { full, root, child } = tagPathParts(rawTag);
      if (!full || !root) return;
      const rootKey = root.toLocaleLowerCase();
      const node = roots.get(rootKey) || { root, count: 0, children: new Map() };
      roots.set(rootKey, node);
      if (!promptRootKeys.has(rootKey)) {
        node.count += 1;
        promptRootKeys.add(rootKey);
      }
      if (!child) return;
      const childKey = full.toLocaleLowerCase();
      const childNode = node.children.get(childKey) || { tag: full, child, count: 0 };
      childNode.count += 1;
      node.children.set(childKey, childNode);
    });
  });
  return roots;
}

function promptMatchesTagFilter(prompt, filter) {
  if (filter.startsWith("tagtree:")) {
    const rootKey = filter.slice(8).toLocaleLowerCase();
    return (prompt.tags || []).some((tag) => tagPathParts(tag).root.toLocaleLowerCase() === rootKey);
  }
  const tagKey = filter.slice(4).toLocaleLowerCase();
  return (prompt.tags || []).some((tag) => normalizeTagPath(tag).toLocaleLowerCase() === tagKey);
}

function normalizeSearchText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function searchQueryTokens(value) {
  return normalizeSearchText(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function promptSearchScore(prompt, tokens, normalizedQuery = "") {
  if (!tokens.length) return 0;
  const fields = [
    { value: prompt.title, weight: 12 },
    { value: (prompt.tags || []).map((tag) => `${tag} ${tagDisplayLabel(tag, " ")}`).join(" "), weight: 10 },
    { value: prompt.usageNote || "", weight: 8 },
    { value: prompt.content, weight: 6 },
    { value: (prompt.variants || []).map((variant) => variant.title || "").join(" "), weight: 9 },
    { value: (prompt.variants || []).map((variant) => variant.content || "").join(" "), weight: 5 }
  ].map((field) => ({ ...field, normalized: normalizeSearchText(field.value) }));

  let score = 0;
  for (const token of tokens) {
    let tokenScore = 0;
    for (const field of fields) {
      const index = field.normalized.indexOf(token);
      if (index < 0) continue;
      tokenScore = Math.max(tokenScore, field.weight + (index === 0 ? 3 : 0));
    }
    if (!tokenScore) return -1;
    score += tokenScore;
  }
  if (normalizedQuery && fields.some((field) => field.normalized.includes(normalizedQuery))) score += 8;
  return score;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  clearTimeout(toast.timer);
  clearTimeout(toast.hideTimer);
  if (!el.matches(":popover-open")) el.showPopover();
  requestAnimationFrame(() => el.classList.add("show"));
  toast.timer = setTimeout(() => {
    el.classList.remove("show");
    toast.hideTimer = setTimeout(() => {
      if (el.matches(":popover-open")) el.hidePopover();
    }, 190);
  }, 1800);
}

function bindReliableAction(button, action) {
  const run = () => Promise.resolve(action()).catch((error) => toast(error?.message || "操作失败"));
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    run();
  });
  button.addEventListener("click", (event) => {
    if (event.detail === 0) run();
  });
}

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshBackupStatus() {
  const directory = $("#backupDirectoryField").value.trim();
  const status = await window.promptDock.getBackupStatus(directory);
  $("#backupStatus").textContent = directory
    ? `${status.count} 份 · ${formatBytes(status.bytes)} · 预计3天 ${formatBytes(status.expectedThreeDayBytes)}`
    : `尚未设置 · 图库 ${formatBytes(status.libraryBytes)}`;
}

async function refreshCacheStatus() {
  try {
    const status = await window.promptDock.getCacheStatus();
    $("#cacheStatus").textContent = formatBytes(status.bytes || 0);
  } catch {
    $("#cacheStatus").textContent = "无法读取";
  }
}

function promptVersions(prompt) {
  return [
    { id: "default", title: prompt.defaultVariantTitle?.trim() || "默认版本", content: prompt.content, isDefault: true },
    ...(Array.isArray(prompt.variants) ? prompt.variants : [])
  ];
}

function selectedVersion(prompt, variantId = activeVariantId) {
  return promptVersions(prompt).find((variant) => variant.id === variantId) || promptVersions(prompt)[0];
}

function persist() {
  const task = persistQueue.catch(() => {}).then(async () => {
    const result = await window.promptDock.saveState(state);
    if (result?.state) state = result.state;
    return result;
  });
  persistQueue = task;
  return task;
}

function applyPrivacyMode() {
  const enabled = Boolean(state.settings.privacyMode);
  const hideImages = enabled && Boolean(state.settings.privacyHideImages);
  document.body.classList.toggle("privacy-mode", enabled);
  document.body.classList.toggle("privacy-hide-images", hideImages);
  const button = $("#privacyModeBtn");
  button.classList.toggle("active", enabled);
  button.setAttribute("aria-pressed", String(enabled));
  button.title = enabled ? "恢复显示 Prompt 内容" : "隐藏 Prompt 内容，方便安全截图";
  button.querySelector("span").textContent = enabled ? "内容已隐藏" : "截图隐私";
}

function applyLayout() {
  const shell = $(".app-shell");
  const compactMode = Boolean(state.settings.compactMode);
  const vocabularyMode = appMode === "vocabulary";
  shell.classList.toggle("vocabulary-mode", vocabularyMode);
  applyPaneWidths();
  shell.classList.toggle("left-collapsed", Boolean(state.settings.leftCollapsed));
  shell.classList.toggle("right-collapsed", Boolean(state.settings.rightCollapsed));
  shell.classList.toggle("compact-mode", compactMode);
  shell.classList.toggle("compact-left-open", compactMode && compactSidebarOpen);
  $("#toggleLeftBtn").classList.toggle("active", compactMode ? compactSidebarOpen : Boolean(state.settings.leftCollapsed));
  $("#toggleLeftBtn").title = compactMode
    ? (compactSidebarOpen ? "关闭导航抽屉" : "打开导航抽屉")
    : "收起或展开左栏";
  $("#toggleRightBtn").classList.toggle("active", Boolean(state.settings.rightCollapsed));
  $("#toggleRightBtn").classList.toggle("hidden", compactMode || vocabularyMode);
  $("#compactBtn").classList.toggle("active", Boolean(state.settings.compactMode));
  $("#pinBtn").classList.toggle("active", Boolean(state.settings.alwaysOnTop));
  $("#pinBtn").disabled = Boolean(state.settings.compactMode);
  $("#pinBtn").title = state.settings.compactMode ? "超小窗口模式会始终置顶" : "切换窗口置顶";
  if (!state.settings.compactMode) hideVariantPopover();
}

function clampPaneWidth(side, requested) {
  const shell = $(".app-shell");
  const shellWidth = shell.clientWidth || window.innerWidth;
  const otherPanel = side === "left" ? $("#previewPanel") : $(".sidebar");
  const otherCollapsed = side === "left" ? state.settings.rightCollapsed : state.settings.leftCollapsed;
  const otherWidth = otherCollapsed ? 0 : Math.round(otherPanel.getBoundingClientRect().width || (side === "left" ? 330 : 190));
  const minimum = side === "left" ? 180 : 300;
  const maximum = side === "left" ? 380 : 720;
  const available = Math.max(minimum, shellWidth - otherWidth - 362);
  return Math.round(Math.max(minimum, Math.min(Number(requested) || minimum, maximum, available)));
}

function applyPaneWidths() {
  if (!state?.settings) return;
  const shell = $(".app-shell");
  const widths = state.settings.paneWidths || {};
  const left = clampPaneWidth("left", widths.left || 190);
  shell.style.setProperty("--left-pane-track", `${left}px`);
  if (Number.isFinite(Number(widths.right)) && Number(widths.right) > 0) {
    const right = clampPaneWidth("right", widths.right);
    shell.style.setProperty("--right-pane-track", `${right}px`);
    $("#rightPaneResizer").setAttribute("aria-valuenow", String(right));
  } else {
    shell.style.removeProperty("--right-pane-track");
    $("#rightPaneResizer").removeAttribute("aria-valuenow");
  }
  $("#leftPaneResizer").setAttribute("aria-valuenow", String(left));
}

function setPaneWidth(side, requested) {
  state.settings.paneWidths ||= { left: 190, right: null };
  const width = clampPaneWidth(side, requested);
  state.settings.paneWidths[side] = width;
  const property = side === "left" ? "--left-pane-track" : "--right-pane-track";
  $(".app-shell").style.setProperty(property, `${width}px`);
  $(`#${side}PaneResizer`).setAttribute("aria-valuenow", String(width));
  return width;
}

function bindPaneResizer(side) {
  const handle = $(`#${side}PaneResizer`);
  const panel = side === "left" ? $(".sidebar") : $("#previewPanel");
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.settings.compactMode || window.innerWidth <= 900) return;
    if (side === "left" ? state.settings.leftCollapsed : state.settings.rightCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("pane-resizing");
    const move = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      setPaneWidth(side, startWidth + (side === "left" ? delta : -delta));
    };
    const finish = async () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.classList.remove("dragging");
      document.body.classList.remove("pane-resizing");
      await persist();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  });
  handle.addEventListener("keydown", async (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = panel.getBoundingClientRect().width;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    setPaneWidth(side, current + direction * (side === "left" ? 12 : -12));
    await persist();
  });
  handle.addEventListener("dblclick", async () => {
    state.settings.paneWidths ||= { left: 190, right: null };
    state.settings.paneWidths[side] = side === "left" ? 190 : null;
    applyPaneWidths();
    await persist();
    toast(`${side === "left" ? "左" : "右"}栏已恢复默认宽度`);
  });
}

function setCompactSidebarOpen(open) {
  compactSidebarOpen = Boolean(open);
  applyLayout();
}

async function toggleLayoutSetting(name) {
  state.settings[name] = !state.settings[name];
  applyLayout();
  await persist();
}

function filteredPrompts() {
  const query = normalizeSearchText($("#searchInput").value);
  const queryTokens = searchQueryTokens(query);
  let prompts = state.prompts.filter((prompt) => currentFilter === "trash" ? Boolean(prompt.deletedAt) : !prompt.deletedAt);
  if (currentFilter === "favorite") prompts = prompts.filter((p) => p.favorite);
  else if (currentFilter === "recent") prompts = prompts.filter((p) => p.lastUsed).sort((a, b) => (b.lastUsed || "").localeCompare(a.lastUsed || ""));
  else if (currentFilter === "untagged") prompts = prompts.filter((p) => !(p.tags || []).some((tag) => normalizeTagPath(tag)));
  else if (currentFilter.startsWith("tag:") || currentFilter.startsWith("tagtree:")) prompts = prompts.filter((p) => promptMatchesTagFilter(p, currentFilter));
  const relevance = new Map();
  if (queryTokens.length) prompts = prompts.filter((prompt) => {
    const score = promptSearchScore(prompt, queryTokens, query);
    relevance.set(prompt.id, score);
    return score >= 0;
  });
  const sort = currentSort;
  if (queryTokens.length) {
    prompts.sort((a, b) => (relevance.get(b.id) || 0) - (relevance.get(a.id) || 0)
      || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  } else if (currentFilter === "trash") {
    prompts.sort((a, b) => String(b.deletedAt || "").localeCompare(String(a.deletedAt || "")));
  } else if (!(currentFilter === "recent")) {
    prompts.sort((a, b) => sort === "title"
      ? a.title.localeCompare(b.title, "zh-CN")
      : sort === "used"
        ? (b.useCount || 0) - (a.useCount || 0)
        : (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }
  return prompts;
}

function renderSidebar() {
  ensureVocabularyState();
  const activePrompts = state.prompts.filter((prompt) => !prompt.deletedAt);
  const trashCount = state.prompts.length - activePrompts.length;
  $("#allCount").textContent = activePrompts.length;
  $("#favoriteCount").textContent = activePrompts.filter((prompt) => prompt.favorite).length;
  $("#recentCount").textContent = activePrompts.filter((prompt) => prompt.lastUsed).length;
  const untaggedCount = activePrompts.filter((prompt) => !(prompt.tags || []).some((tag) => normalizeTagPath(tag))).length;
  $("#untaggedCount").textContent = untaggedCount;
  $("#untaggedCount").closest(".nav-item").classList.toggle("empty-count", untaggedCount === 0);
  $("#trashCount").textContent = trashCount;
  $("#vocabularyCount").textContent = state.vocabulary.entries.length;
  $("#trashNavItem").classList.toggle("empty-count", trashCount === 0);
  const collapsed = new Set((state.settings.collapsedTagGroups || []).map((tag) => String(tag).toLocaleLowerCase()));
  const roots = [...tagTreeStats().values()].sort((a, b) => b.count - a.count || a.root.localeCompare(b.root, "zh-CN"));
  $("#tagList").innerHTML = roots.map((node) => {
    const rootKey = node.root.toLocaleLowerCase();
    const children = [...node.children.values()].sort((a, b) => b.count - a.count || a.child.localeCompare(b.child, "zh-CN"));
    const isCollapsed = children.length > 0 && collapsed.has(rootKey);
    const rootFilter = `tagtree:${node.root}`;
    return `
      <div class="tag-tree-group ${isCollapsed ? "collapsed" : ""}" data-tag-root="${escapeHtml(node.root)}">
        <div class="tag-tree-row ${children.length ? "has-children" : ""}">
          ${children.length ? `<button type="button" class="tag-tree-toggle" data-tag-toggle="${escapeHtml(node.root)}" aria-label="${isCollapsed ? "展开" : "收起"}${escapeHtml(node.root)}的子标签" aria-expanded="${!isCollapsed}">${iconSvg("chevron-down")}</button>` : ""}
          <button class="nav-item tag-filter tag-root-filter ${currentFilter.toLocaleLowerCase() === rootFilter.toLocaleLowerCase() ? "active" : ""}" data-filter="${escapeHtml(rootFilter)}" data-tag-name="${escapeHtml(node.root)}" data-tag-scope="branch" title="单击查看整个分组；双击或右键管理标签"><span># ${escapeHtml(node.root)}</span><b>${node.count}</b></button>
        </div>
        ${children.length ? `<div class="tag-tree-children ${isCollapsed ? "hidden" : ""}">${children.map((child) => {
          const childFilter = `tag:${child.tag}`;
          return `<button class="nav-item tag-filter tag-child-filter ${currentFilter.toLocaleLowerCase() === childFilter.toLocaleLowerCase() ? "active" : ""}" data-filter="${escapeHtml(childFilter)}" data-tag-name="${escapeHtml(child.tag)}" data-tag-scope="exact" title="${escapeHtml(child.tag)} · 双击或右键管理"><span>${escapeHtml(child.child)}</span><b>${child.count}</b></button>`;
        }).join("")}</div>` : ""}
      </div>`;
  }).join("");
  $$("[data-tag-toggle]").forEach((button) => button.addEventListener("click", async () => {
    const root = button.dataset.tagToggle;
    const key = root.toLocaleLowerCase();
    const next = new Set((state.settings.collapsedTagGroups || []).map((tag) => String(tag).toLocaleLowerCase()));
    if (next.has(key)) next.delete(key); else next.add(key);
    state.settings.collapsedTagGroups = [...next];
    renderSidebar();
    await persist();
  }));
  $$(".tag-filter").forEach((button) => {
    button.addEventListener("click", () => {
      if (!button.querySelector(".tag-rename-input")) setFilter(button.dataset.filter);
    });
    button.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startTagRename(button, button.dataset.tagName, button.dataset.tagScope);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showTagContextMenu(button, button.dataset.tagName, event.clientX, event.clientY, button.dataset.tagScope);
    });
    button.addEventListener("keydown", (event) => {
      if (!(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const rect = button.getBoundingClientRect();
      showTagContextMenu(button, button.dataset.tagName, rect.left + 20, rect.top + 20, button.dataset.tagScope);
    });
  });
}

function positionFloatingMenu(menu, x, y) {
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(50, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

function hideFloatingMenus() {
  $("#tagContextMenu").classList.add("hidden");
  $("#imageContextMenu").classList.add("hidden");
  $("#trashContextMenu").classList.add("hidden");
  $("#vocabularyWordMenu").classList.add("hidden");
  $("#vocabularyCollectionMenu").classList.add("hidden");
}

function showTagContextMenu(button, tagName, x, y, scope = "exact") {
  hideFloatingMenus();
  tagContextName = tagName;
  tagContextButton = button;
  button.dataset.tagScope = scope;
  const mergeCount = scope === "branch" ? tagTreeStats().size : allTagStats().size;
  $("#tagContextMenu [data-tag-menu-action='merge']").disabled = mergeCount < 2;
  positionFloatingMenu($("#tagContextMenu"), x, y);
  $("#tagContextMenu [data-tag-menu-action='rename']").focus();
}

function showTrashContextMenu(x, y) {
  hideFloatingMenus();
  const count = state.prompts.filter((prompt) => prompt.deletedAt).length;
  $("#emptyTrashMenuBtn").disabled = count === 0;
  positionFloatingMenu($("#trashContextMenu"), x, y);
  $("#emptyTrashMenuBtn").focus();
}

function renderTagMergeOptions() {
  const query = $("#tagMergeTargetField").value.trim().toLocaleLowerCase();
  const sourceKey = tagMergeSourceName.toLocaleLowerCase();
  const tags = [...allTagStats().values()];
  const matches = tags
    .filter((item) => {
      const key = item.tag.toLocaleLowerCase();
      if (key === sourceKey) return false;
      if (tagMergeSourceScope === "branch" && key.startsWith(`${sourceKey}/`)) return false;
      return !query || key.includes(query) || tagDisplayLabel(item.tag, " ").toLocaleLowerCase().includes(query);
    })
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN"));
  $("#tagMergeOptions").innerHTML = matches.length ? matches.map((item) => `
    <button type="button" data-merge-target="${escapeHtml(item.tag)}" title="${escapeHtml(tagDisplayLabel(item.tag, " / "))}">
      <span>${tagSuggestionMarkup(item.tag)}</span><small>${item.count}</small>
    </button>
  `).join("") : `<div class="tag-merge-empty">没有匹配的其他标签</div>`;
  $$("#tagMergeOptions [data-merge-target]").forEach((button) => button.addEventListener("click", () => {
    $("#tagMergeTargetField").value = button.dataset.mergeTarget;
    $$("#tagMergeOptions [data-merge-target]").forEach((item) => item.classList.toggle("selected", item === button));
    $("#tagMergeError").classList.add("hidden");
  }));
}

function focusEditableField(field, { select = false, resetDialogScroll = false } = {}) {
  if (!field) return;
  requestAnimationFrame(() => {
    const dialog = field.closest("dialog");
    if (!field.isConnected || (dialog && !dialog.open)) return;
    if (resetDialogScroll && dialog) {
      dialog.scrollTop = 0;
      const form = dialog.querySelector("form");
      if (form) form.scrollTop = 0;
    }
    field.focus({ preventScroll: true });
    if (select && typeof field.select === "function") field.select();
  });
}

function showEditableDialog(dialog, field, options) {
  if (!dialog || !field) return;
  if (!dialog.open) {
    field.setAttribute("autofocus", "");
    dialog.showModal();
    field.removeAttribute("autofocus");
  }
  focusEditableField(field, options);
}

function openTagMergeDialog(sourceTag, scope = "exact") {
  tagMergeSourceName = sourceTag;
  tagMergeSourceScope = scope;
  $("#tagMergeSource").textContent = `# ${tagDisplayLabel(sourceTag)}`;
  $("#tagMergeTargetField").value = "";
  $("#tagMergeError").classList.add("hidden");
  renderTagMergeOptions();
  showEditableDialog($("#tagMergeDialog"), $("#tagMergeTargetField"));
}

function replaceTagNameInPrompts(prompts, oldTag, newTag, includeDescendants = false) {
  const normalizedOld = normalizeTagPath(oldTag);
  const normalizedNew = normalizeTagPath(newTag);
  const oldKey = normalizedOld.toLocaleLowerCase();
  let changed = 0;
  prompts.forEach((prompt) => {
    const matches = (tag) => {
      const key = normalizeTagPath(tag).toLocaleLowerCase();
      return key === oldKey || (includeDescendants && key.startsWith(`${oldKey}/`));
    };
    if (!(prompt.tags || []).some(matches)) return;
    const seen = new Set();
    prompt.tags = prompt.tags.map((tag) => {
      const normalized = normalizeTagPath(tag);
      if (!matches(normalized)) return normalized;
      return includeDescendants ? `${normalizedNew}${normalized.slice(normalizedOld.length)}` : normalizedNew;
    }).filter((tag) => {
      const key = tag.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    prompt.updatedAt = new Date().toISOString();
    changed += 1;
  });
  return changed;
}

function removeTagFromPrompts(prompts, removingTag, includeDescendants = false) {
  const normalized = normalizeTagPath(removingTag);
  const removingKey = normalized.toLocaleLowerCase();
  let changed = 0;
  prompts.forEach((prompt) => {
    const originalTags = prompt.tags || [];
    const nextTags = originalTags.filter((tag) => {
      const key = normalizeTagPath(tag).toLocaleLowerCase();
      return key !== removingKey && !(includeDescendants && key.startsWith(`${removingKey}/`));
    });
    if (nextTags.length === originalTags.length) return;
    prompt.tags = nextTags;
    prompt.updatedAt = new Date().toISOString();
    changed += 1;
  });
  return changed;
}

function tagRemovalImpact(tagName, scope = "exact") {
  const key = normalizeTagPath(tagName).toLocaleLowerCase();
  const includeDescendants = scope === "branch";
  return state.prompts.filter((prompt) => (prompt.tags || []).some((tag) => {
    const tagKey = normalizeTagPath(tag).toLocaleLowerCase();
    return tagKey === key || (includeDescendants && tagKey.startsWith(`${key}/`));
  })).length;
}

function openTagDeleteDialog(tagName, scope = "exact") {
  tagDeleteName = tagName;
  tagDeleteScope = scope;
  const count = tagRemovalImpact(tagName, scope);
  const label = tagDisplayLabel(tagName, " / ");
  $("#tagDeleteTitle").textContent = scope === "branch" ? `删除“${label}”标签组？` : `删除“${label}”标签？`;
  $("#tagDeleteMessage").textContent = scope === "branch"
    ? `将从 ${count} 条 Prompt 中移除这个父标签及其所有子标签。Prompt 和图片不会被删除。`
    : `将从 ${count} 条 Prompt 中移除这个标签。Prompt 和图片不会被删除。`;
  $("#tagDeleteDialog").showModal();
}

function startTagRename(button, oldTag, scope = "exact") {
  if (button.querySelector(".tag-rename-input")) return;
  const label = button.querySelector("span");
  const originalMarkup = label.innerHTML;
  label.innerHTML = `<input class="tag-rename-input" maxlength="40" aria-label="修改标签名称">`;
  const input = label.querySelector("input");
  const oldParts = tagPathParts(oldTag);
  input.value = scope === "exact" && oldParts.child ? oldParts.child : oldParts.root;
  input.focus();
  input.select();
  let finished = false;
  const cancel = () => {
    if (finished) return;
    finished = true;
    label.innerHTML = originalMarkup;
  };
  const commit = async () => {
    if (finished) return;
    const typed = normalizeTagPath(input.value.trim().replace(/^#\s*/, ""));
    if (!typed || /[,，]/.test(typed)) {
      toast(!typed ? "标签名称不能为空" : "标签名称不能包含逗号");
      input.focus();
      return;
    }
    finished = true;
    const requested = scope === "exact" && oldParts.child && !typed.includes("/") ? `${oldParts.root}/${typed}` : typed;
    if (scope === "branch" && requested.includes("/")) {
      finished = false;
      toast("父标签名称不能包含 /；请直接填写父标签名称");
      input.focus();
      return;
    }
    const canonical = scope === "branch"
      ? tagTreeStats().get(requested.toLocaleLowerCase())?.root || requested
      : allTagStats().get(requested.toLocaleLowerCase())?.tag || requested;
    if (canonical.toLocaleLowerCase() === oldTag.toLocaleLowerCase() && canonical === oldTag) return renderSidebar();
    replaceTagNameInPrompts(state.prompts, oldTag, canonical, scope === "branch");
    if (scope === "branch") {
      const oldKey = oldTag.toLocaleLowerCase();
      if (currentFilter.toLocaleLowerCase() === `tagtree:${oldKey}`) currentFilter = `tagtree:${canonical}`;
      else if (currentFilter.toLocaleLowerCase().startsWith(`tag:${oldKey}/`)) currentFilter = `tag:${canonical}${currentFilter.slice(4 + oldTag.length)}`;
    } else if (currentFilter.toLocaleLowerCase() === `tag:${oldTag.toLocaleLowerCase()}`) currentFilter = `tag:${canonical}`;
    await persist();
    renderAll();
    toast(canonical.toLocaleLowerCase() === typed.toLocaleLowerCase() && canonical !== typed
      ? `已合并到标签“${canonical}”`
      : `标签已改为“${canonical}”`);
  };
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("dblclick", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") { event.preventDefault(); commit(); }
    if (event.key === "Escape") { event.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", commit);
}

function updateBatchToolbar() {
  const existingIds = new Set(state.prompts.map((prompt) => prompt.id));
  [...batchSelection].forEach((id) => { if (!existingIds.has(id)) batchSelection.delete(id); });
  const visible = filteredPrompts();
  const allVisibleSelected = visible.length > 0 && visible.every((prompt) => batchSelection.has(prompt.id));
  $("#batchSelectedCount").textContent = `已选择 ${batchSelection.size} 项`;
  $("#batchSelectAllBtn").textContent = allVisibleSelected ? "取消全选" : "全选";
  $("#batchSelectAllBtn").disabled = visible.length === 0;
  $("#batchDeleteBtn").disabled = batchSelection.size === 0;
}

function setBatchMode(enabled) {
  batchMode = Boolean(enabled);
  if (!batchMode) batchSelection.clear();
  document.body.classList.toggle("batch-mode", batchMode);
  $("#batchModeBtn").classList.toggle("active", batchMode);
  $("#batchModeBtn").setAttribute("aria-pressed", String(batchMode));
  $("#batchModeBtn").title = batchMode ? "退出批量管理" : "批量选择和管理 Prompt";
  $("#batchToolbar").classList.toggle("hidden", !batchMode);
  renderList();
  updateBatchToolbar();
}

function toggleBatchSelection(id, card) {
  if (batchSelection.has(id)) batchSelection.delete(id); else batchSelection.add(id);
  card?.classList.toggle("batch-selected", batchSelection.has(id));
  card?.setAttribute("aria-selected", String(batchSelection.has(id)));
  updateBatchToolbar();
}

function movePromptsToTrash(ids) {
  const moving = new Set(ids);
  const now = new Date().toISOString();
  let changed = 0;
  state.prompts.forEach((prompt) => {
    if (!moving.has(prompt.id) || prompt.deletedAt) return;
    prompt.deletedAt = now;
    prompt.updatedAt = now;
    changed += 1;
  });
  return changed;
}

async function restorePrompt(prompt) {
  if (!prompt?.deletedAt) return false;
  delete prompt.deletedAt;
  prompt.updatedAt = new Date().toISOString();
  selectedId = null;
  await persist();
  renderAll();
  toast(`已恢复“${prompt.title}”`);
  return true;
}

function permanentlyDeletePrompts(ids) {
  const deleting = new Set(ids);
  const before = state.prompts.length;
  state.prompts = state.prompts.filter((prompt) => !deleting.has(prompt.id));
  if (selectedId && deleting.has(selectedId)) selectedId = null;
  return before - state.prompts.length;
}

async function deleteBatchSelection() {
  const deleting = new Set(batchSelection);
  if (!deleting.size) return 0;
  const permanent = currentFilter === "trash";
  const deletedCount = permanent
    ? permanentlyDeletePrompts(deleting)
    : movePromptsToTrash(deleting);
  if (!permanent && selectedId && deleting.has(selectedId)) selectedId = null;
  await persist();
  if ($("#batchDeleteDialog").open) $("#batchDeleteDialog").close();
  setBatchMode(false);
  renderAll();
  toast(permanent ? `已永久删除 ${deletedCount} 条 Prompt` : `已将 ${deletedCount} 条 Prompt 移到回收站`);
  return deletedCount;
}

function renderList() {
  const prompts = filteredPrompts();
  let resultLabel = `${prompts.length} 个项目`;
  if (currentFilter.startsWith("tag:")) {
    const { root, child } = tagPathParts(currentFilter.slice(4));
    if (child) resultLabel = `${root} 下的子标签 · ${resultLabel}`;
  }
  $("#resultMeta").textContent = resultLabel;
  $("#promptList").classList.toggle("hidden", prompts.length === 0);
  $("#emptyState").classList.toggle("hidden", prompts.length !== 0);
  $("#emptyState h2").textContent = currentFilter === "trash" ? "回收站是空的" : "没有找到 Prompt";
  $("#emptyState p").textContent = currentFilter === "trash" ? "删除的 Prompt 会暂时保留在这里。" : "换个关键词，或者新建一个。";
  $("#promptList").innerHTML = prompts.map((prompt) => `
    <article class="prompt-card ${prompt.deletedAt ? "in-trash" : ""} ${!batchMode && prompt.id === selectedId ? "selected" : ""} ${batchSelection.has(prompt.id) ? "batch-selected" : ""}" data-id="${prompt.id}" ${batchMode ? 'tabindex="0" role="option"' : ""} aria-selected="${batchSelection.has(prompt.id)}">
      <span class="batch-checkbox">${iconSvg("check")}</span>
      <div class="thumb">${prompt.images?.[0] ? `<img src="${prompt.imageThumbnails?.[0] || prompt.images[0]}" alt="" loading="lazy" decoding="async">` : escapeHtml(prompt.title.slice(0, 1).toUpperCase())}</div>
      <div class="card-body">
        <h3>${escapeHtml(prompt.title)}${prompt.variants?.length ? `<span class="variant-count">${prompt.variants.length + 1} 个版本</span>` : ""}</h3>
        <p>${escapeHtml(prompt.content.replace(/\s+/g, " "))}</p>
        <div class="card-tags">${prompt.deletedAt ? `<span class="tag trash-status">待恢复</span>` : ""}${prompt.tags.slice(0, 3).map((tag) => `<span class="tag" title="${escapeHtml(tag)}">${escapeHtml(tagDisplayLabel(tag))}</span>`).join("")}</div>
      </div>
      <span class="star">${prompt.favorite ? iconSvg("star", "is-filled") : ""}</span>
    </article>
  `).join("");
  $$(".prompt-card").forEach((card) => {
    const inTrash = currentFilter === "trash";
    card.title = batchMode ? "单击选择或取消选择" : inTrash ? "单击查看，可在右栏恢复" : "单击直接粘贴到当前输入框";
    card.addEventListener("mouseenter", () => {
      previewPrompt(card.dataset.id);
      if (!inTrash && state.settings.compactMode) showVariantPopover(card, card.dataset.id);
    });
    card.addEventListener("mouseleave", () => {
      if (state.settings.compactMode) scheduleHideVariantPopover();
    });
    card.addEventListener("click", () => {
      if (batchMode) return toggleBatchSelection(card.dataset.id, card);
      previewPrompt(card.dataset.id);
      if (!inTrash) usePrompt("paste", "default");
    });
    card.addEventListener("keydown", (event) => {
      if (!batchMode || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      toggleBatchSelection(card.dataset.id, card);
    });
  });
  if (batchMode) updateBatchToolbar();
}

function renderPreview() {
  const prompt = state.prompts.find((p) => p.id === selectedId);
  $("#previewEmpty").classList.toggle("hidden", Boolean(prompt));
  $("#previewContent").classList.toggle("hidden", !prompt);
  if (!prompt) return;
  const inTrash = Boolean(prompt.deletedAt);
  $("#previewTitle").textContent = prompt.title;
  $("#previewTags").innerHTML = prompt.tags.map((tag) => `<span class="tag" title="${escapeHtml(tag)}">${escapeHtml(tagDisplayLabel(tag))}</span>`).join("");
  const usageNote = String(prompt.usageNote || "").trim();
  $("#previewNote").classList.toggle("hidden", !usageNote);
  $("#previewNoteText").textContent = usageNote;
  $("#favoriteBtn").innerHTML = iconSvg("star", prompt.favorite ? "is-filled" : "");
  $("#favoriteBtn").classList.toggle("active", Boolean(prompt.favorite));
  $("#favoriteBtn").classList.toggle("hidden", inTrash);
  $("#editBtn").innerHTML = inTrash ? iconSvg("restore") : iconSvg("edit");
  $("#editBtn").title = inTrash ? "恢复 Prompt" : "编辑";
  $("#editBtn").setAttribute("aria-label", inTrash ? "恢复 Prompt" : "编辑");
  $("#deleteBtn").title = inTrash ? "永久删除" : "移到回收站";
  $("#deleteBtn").setAttribute("aria-label", inTrash ? "永久删除" : "移到回收站");
  $("#copyBtn").innerHTML = inTrash
    ? `${iconSvg("restore")}<span>恢复</span>`
    : `${iconSvg("copy")}<span>复制</span>`;
  $("#pasteBtn").innerHTML = inTrash
    ? `${iconSvg("trash")}<span>永久删除</span>`
    : `${iconSvg("paste")}<span>直接粘贴</span>`;
  $("#pasteBtn").classList.toggle("trash-danger-action", inTrash);
  const versions = promptVersions(prompt);
  if (!versions.some((variant) => variant.id === activeVariantId)) activeVariantId = "default";
  renderPreviewImages(prompt);
  $("#variantList").classList.toggle("hidden", versions.length < 2);
  $("#variantList").innerHTML = versions.length < 2 ? "" : `
    <div class="variant-list-head"><b>版本与变体</b><span>${versions.length} 个</span></div>
    ${versions.map((variant) => `
      <button type="button" class="variant-option ${variant.id === activeVariantId ? "active" : ""}" data-variant-id="${escapeHtml(variant.id)}">
        <span><b>${escapeHtml(variant.title)}</b>${variant.isDefault ? "<small>原始 Prompt</small>" : "<small>变体</small>"}</span>
        <em>${inTrash ? "仅查看" : "单击粘贴"}</em>
      </button>
    `).join("")}`;
  $$("#variantList .variant-option").forEach((button) => {
    button.addEventListener("mouseenter", () => setPreviewVersion(button.dataset.variantId));
    button.addEventListener("click", () => inTrash ? setPreviewVersion(button.dataset.variantId) : usePrompt("paste", button.dataset.variantId));
  });
  renderActiveVersion(prompt);
}

function renderPreviewImages(prompt) {
  const images = prompt.images || [];
  if (previewImageIndex >= images.length) previewImageIndex = 0;
  $("#previewGallery").classList.toggle("hidden", images.length === 0);
  if (!images.length) return;
  $("#previewImage").src = images[previewImageIndex];
  $("#previewImageCount").textContent = `${previewImageIndex + 1} / ${images.length}`;
  $("#previousImageBtn").disabled = images.length < 2;
  $("#nextImageBtn").disabled = images.length < 2;
  $("#previewImageThumbnails").innerHTML = images.map((image, index) => `
    <button type="button" class="gallery-thumbnail ${index === previewImageIndex ? "active" : ""}" data-image-index="${index}" aria-label="查看第 ${index + 1} 张图片">
      <img src="${prompt.imageThumbnails?.[index] || image}" alt="">
    </button>
  `).join("");
  $$("#previewImageThumbnails [data-image-index]").forEach((button) => button.addEventListener("click", () => {
    previewImageIndex = Number(button.dataset.imageIndex);
    renderPreviewImages(prompt);
  }));
}

function lightboxImages() {
  return state.prompts.find((item) => item.id === selectedId)?.images || [];
}

function fitLightboxImage() {
  const stage = $("#lightboxStage");
  const image = $("#lightboxImage");
  if (!image.naturalWidth || !image.naturalHeight || !stage.clientWidth || !stage.clientHeight) return;
  const fitScale = Math.min(
    stage.clientWidth / image.naturalWidth,
    stage.clientHeight / image.naturalHeight
  );
  image.style.width = `${image.naturalWidth * fitScale}px`;
  image.style.height = `${image.naturalHeight * fitScale}px`;
  applyLightboxTransform();
}

function applyLightboxTransform() {
  const stage = $("#lightboxStage");
  const image = $("#lightboxImage");
  if (lightboxZoom > 1) {
    const maxX = Math.max(0, (image.offsetWidth * lightboxZoom - stage.clientWidth) / 2);
    const maxY = Math.max(0, (image.offsetHeight * lightboxZoom - stage.clientHeight) / 2);
    lightboxPanX = Math.max(-maxX, Math.min(maxX, lightboxPanX));
    lightboxPanY = Math.max(-maxY, Math.min(maxY, lightboxPanY));
  }
  image.style.transform = `translate3d(${lightboxPanX}px, ${lightboxPanY}px, 0) scale(${lightboxZoom})`;
  $("#lightboxZoomReset").textContent = `${Math.round(lightboxZoom * 100)}%`;
  stage.classList.toggle("zoomed", lightboxZoom > 1);
}

function panLightboxBy(deltaX, deltaY) {
  lightboxPanX += deltaX;
  lightboxPanY += deltaY;
  applyLightboxTransform();
}

function setLightboxZoom(nextZoom) {
  lightboxZoom = Math.min(6, Math.max(.5, Number(nextZoom) || 1));
  if (lightboxZoom <= 1) {
    lightboxPanX = 0;
    lightboxPanY = 0;
  }
  applyLightboxTransform();
}

function renderLightbox() {
  const images = lightboxImages();
  if (!images.length) return;
  lightboxImageIndex = (lightboxImageIndex + images.length) % images.length;
  $("#lightboxImage").src = images[lightboxImageIndex];
  $("#lightboxImageCount").textContent = `${lightboxImageIndex + 1} / ${images.length}`;
  $("#lightboxPrevious").disabled = images.length < 2;
  $("#lightboxNext").disabled = images.length < 2;
  lightboxPanX = 0;
  lightboxPanY = 0;
  setLightboxZoom(1);
  requestAnimationFrame(fitLightboxImage);
}

function openLightbox(index = previewImageIndex) {
  if (!lightboxImages().length) return;
  lightboxImageIndex = index;
  $("#imageLightbox").showModal();
  renderLightbox();
}

function moveLightbox(direction) {
  if (lightboxImages().length < 2) return;
  lightboxImageIndex += direction;
  renderLightbox();
}

function currentLightboxImage() {
  return lightboxImages()[lightboxImageIndex] || "";
}

async function copyCurrentLightboxImage() {
  if (imageCopyPending) return;
  const source = currentLightboxImage();
  if (!source) return;
  const button = $("#lightboxCopyImage");
  const label = button.querySelector("span");
  imageCopyPending = true;
  button.classList.add("busy");
  button.setAttribute("aria-busy", "true");
  if (label) label.textContent = "复制中";
  try {
    const result = await window.promptDock.copyImage(source);
    toast(result.ok ? "图片已复制到剪贴板" : (result.message || "图片复制失败"));
  } finally {
    imageCopyPending = false;
    button.classList.remove("busy");
    button.removeAttribute("aria-busy");
    if (label) label.textContent = "复制图片";
  }
}

async function saveCurrentLightboxImage() {
  const source = currentLightboxImage();
  const prompt = state.prompts.find((item) => item.id === selectedId);
  if (!source || !prompt) return;
  const result = await window.promptDock.saveImage(source, prompt.title, lightboxImageIndex + 1);
  if (result.error) return toast(result.error);
  if (!result.canceled) toast("图片已保存");
}

function showImageContextMenu(x, y) {
  hideFloatingMenus();
  positionFloatingMenu($("#imageContextMenu"), x, y);
  $("#imageContextMenu [data-image-menu-action='copy']").focus();
}

function renderActiveVersion(prompt) {
  const activeVersion = selectedVersion(prompt);
  $("#previewText").textContent = activeVersion.content;
  $$("#variantList .variant-option").forEach((button) => {
    button.classList.toggle("active", button.dataset.variantId === activeVariantId);
  });
}

function setPreviewVersion(variantId) {
  const prompt = state.prompts.find((p) => p.id === selectedId);
  if (!prompt || !promptVersions(prompt).some((variant) => variant.id === variantId)) return;
  activeVariantId = variantId;
  renderActiveVersion(prompt);
}

function hideVariantPopover() {
  clearTimeout(variantPopoverTimer);
  $("#variantPopover").classList.add("hidden");
  $("#variantPopover").innerHTML = "";
}

function scheduleHideVariantPopover() {
  clearTimeout(variantPopoverTimer);
  variantPopoverTimer = setTimeout(hideVariantPopover, 150);
}

function showVariantPopover(card, promptId) {
  clearTimeout(variantPopoverTimer);
  const prompt = state.prompts.find((item) => item.id === promptId);
  if (!prompt || !prompt.variants?.length) {
    hideVariantPopover();
    return;
  }
  const versions = promptVersions(prompt);
  const popover = $("#variantPopover");
  popover.innerHTML = `
    <div class="variant-popover-head"><b>${escapeHtml(prompt.title)}</b><span>${versions.length} 个版本</span></div>
    ${versions.map((variant) => `
      <button type="button" data-variant-id="${escapeHtml(variant.id)}">
        <span>${escapeHtml(variant.title)}</span>
        <small>${escapeHtml(variant.content.replace(/\s+/g, " ").slice(0, 58))}</small>
      </button>
    `).join("")}`;
  popover.classList.remove("hidden");
  const cardRect = card.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const left = Math.min(Math.max(10, cardRect.left), window.innerWidth - popoverRect.width - 10);
  let top = cardRect.bottom + 5;
  if (top + popoverRect.height > window.innerHeight - 10) {
    top = Math.max(50, cardRect.top - popoverRect.height - 5);
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.onmouseenter = () => clearTimeout(variantPopoverTimer);
  popover.onmouseleave = scheduleHideVariantPopover;
  popover.querySelectorAll("[data-variant-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedId = promptId;
      setPreviewVersion(button.dataset.variantId);
      hideVariantPopover();
      usePrompt("paste", button.dataset.variantId);
    });
  });
}

function ensureVocabularyState() {
  const now = new Date().toISOString();
  state.vocabulary ||= { collections: [], entries: [], settings: {} };
  state.vocabulary.collections = Array.isArray(state.vocabulary.collections) ? state.vocabulary.collections : [];
  state.vocabulary.entries = Array.isArray(state.vocabulary.entries) ? state.vocabulary.entries : [];
  state.vocabulary.settings ||= {};
  if (!state.vocabulary.collections.length) {
    state.vocabulary.collections.push({ id: "default", name: "默认词库", createdAt: now });
  }
  const validCollections = new Set(state.vocabulary.collections.map((item) => item.id));
  const fallback = state.vocabulary.collections[0].id;
  state.vocabulary.entries.forEach((entry) => {
    if (!validCollections.has(entry.collectionId)) entry.collectionId = fallback;
  });
  if (!["comma", "space", "newline"].includes(state.vocabulary.settings.separator)) {
    state.vocabulary.settings.separator = "comma";
  }
}

function vocabularyCollectionById(id) {
  ensureVocabularyState();
  return state.vocabulary.collections.find((item) => item.id === id);
}

function vocabularySeparatorText() {
  return ({ comma: ", ", space: " ", newline: "\n" })[$("#vocabularySeparator").value] || ", ";
}

function vocabularySplitter(mode) {
  if (mode === "newline") return /[\r\n]+/;
  if (mode === "comma") return /[,，]+/;
  if (mode === "dunhao") return /[、]+/;
  return /[\r\n,，、]+/;
}

function visibleVocabularyEntries() {
  ensureVocabularyState();
  const query = normalizeSearchText($("#vocabularySearchInput").value);
  let entries = [...state.vocabulary.entries];
  if (vocabularyFilter === "favorite") entries = entries.filter((entry) => entry.favorite);
  else if (vocabularyFilter === "recent") entries = entries.filter((entry) => entry.lastUsed);
  else if (vocabularyFilter.startsWith("collection:")) {
    const collectionId = vocabularyFilter.slice(11);
    entries = entries.filter((entry) => entry.collectionId === collectionId);
  }
  if (query) entries = entries.filter((entry) => normalizeSearchText(entry.text).includes(query));
  entries.sort((a, b) => vocabularyFilter === "recent"
    ? String(b.lastUsed || "").localeCompare(String(a.lastUsed || ""))
    : Number(b.favorite) - Number(a.favorite)
      || (b.useCount || 0) - (a.useCount || 0)
      || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return entries;
}

function vocabularyFilterTitle() {
  if (vocabularyFilter === "all") return "全部词条";
  if (vocabularyFilter === "favorite") return "收藏";
  if (vocabularyFilter === "recent") return "最近复制";
  return vocabularyCollectionById(vocabularyFilter.slice(11))?.name || "词库";
}

function updateVocabularyComposer() {
  const entries = state.vocabulary.entries.filter((entry) => vocabularySelection.has(entry.id));
  $("#vocabularyComposer").classList.toggle("hidden", !vocabularyCombineMode);
  $("#vocabularyComposerPreview").textContent = entries.length
    ? entries.map((entry) => entry.text).join(vocabularySeparatorText())
    : "请选择词条";
  $("#vocabularyCopyCombinedBtn").disabled = entries.length === 0;
  $("#vocabularyClearSelectionBtn").disabled = entries.length === 0;
}

function updateVocabularyBatchToolbar() {
  const existingIds = new Set(state.vocabulary.entries.map((entry) => entry.id));
  [...vocabularyBatchSelection].forEach((id) => { if (!existingIds.has(id)) vocabularyBatchSelection.delete(id); });
  const visible = visibleVocabularyEntries();
  const allVisibleSelected = visible.length > 0 && visible.every((entry) => vocabularyBatchSelection.has(entry.id));
  $("#vocabularyBatchToolbar").classList.toggle("hidden", !vocabularyBatchMode);
  $("#vocabularyBatchSelectedCount").textContent = `已选择 ${vocabularyBatchSelection.size} 项`;
  $("#vocabularyBatchSelectAllBtn").textContent = allVisibleSelected ? "取消全选" : "全选";
  $("#vocabularyBatchSelectAllBtn").disabled = visible.length === 0;
  $("#vocabularyBatchMoveBtn").disabled = vocabularyBatchSelection.size === 0;
  $("#vocabularyBatchDeleteBtn").disabled = vocabularyBatchSelection.size === 0;
}

function openVocabularyBatchMoveDialog() {
  const selectedEntries = state.vocabulary.entries.filter((entry) => vocabularyBatchSelection.has(entry.id));
  if (!selectedEntries.length) return;
  const sourceIds = new Set(selectedEntries.map((entry) => entry.collectionId));
  const commonSourceId = sourceIds.size === 1 ? selectedEntries[0].collectionId : "";
  const targets = state.vocabulary.collections.filter((collection) => collection.id !== commonSourceId);
  $("#vocabularyBatchMoveCount").textContent = selectedEntries.length;
  $("#vocabularyBatchMoveCollection").innerHTML = targets.length
    ? targets.map((collection) => `<option value="${escapeHtml(collection.id)}">${escapeHtml(collection.name)}</option>`).join("")
    : '<option value="">暂无其他词库</option>';
  $("#vocabularyBatchMoveCollection").disabled = targets.length === 0;
  $("#vocabularyBatchMoveConfirmBtn").disabled = targets.length === 0;
  $("#vocabularyBatchMoveHint").textContent = targets.length
    ? "只会改变所属分类，收藏、复制次数和内容都会保留。"
    : "请先在左侧新建另一个词库分类，再移动所选词条。";
  if (targets.length) showEditableDialog($("#vocabularyBatchMoveDialog"), $("#vocabularyBatchMoveCollection"));
  else $("#vocabularyBatchMoveDialog").showModal();
}

function setVocabularyInteractionMode(mode = "normal") {
  vocabularyCombineMode = mode === "combine";
  vocabularyBatchMode = mode === "batch";
  if (!vocabularyCombineMode) vocabularySelection.clear();
  if (!vocabularyBatchMode) vocabularyBatchSelection.clear();
  document.body.classList.toggle("vocabulary-combine-mode", vocabularyCombineMode);
  document.body.classList.toggle("vocabulary-batch-mode", vocabularyBatchMode);
  renderVocabulary();
}

async function toggleVocabularyFavorite(id) {
  const entry = state.vocabulary.entries.find((item) => item.id === id);
  if (!entry) return;
  entry.favorite = !entry.favorite;
  entry.updatedAt = new Date().toISOString();
  await persist();
  renderVocabulary();
  toast(entry.favorite ? "已收藏词条" : "已取消收藏");
}

function renderVocabulary() {
  ensureVocabularyState();
  const entries = visibleVocabularyEntries();
  const allCount = state.vocabulary.entries.length;
  $("#vocabularyCount").textContent = allCount;
  $("#vocabularyAllCount").textContent = allCount;
  $("#vocabularyFavoriteCount").textContent = state.vocabulary.entries.filter((entry) => entry.favorite).length;
  $("#vocabularyRecentCount").textContent = state.vocabulary.entries.filter((entry) => entry.lastUsed).length;
  $("#vocabularyViewTitle").textContent = vocabularyFilterTitle();
  $("#vocabularyMeta").textContent = `${entries.length} 个词条`;
  $("#vocabularyCombineBtn").setAttribute("aria-pressed", String(vocabularyCombineMode));
  $("#vocabularyCombineBtn span").textContent = vocabularyCombineMode ? "退出组合" : "组合模式";
  $("#vocabularyBatchBtn").setAttribute("aria-pressed", String(vocabularyBatchMode));
  $("#vocabularyBatchBtn span").textContent = vocabularyBatchMode ? "退出批量" : "批量管理";
  $("#vocabularySeparator").value = state.vocabulary.settings.separator;
  const counts = new Map();
  state.vocabulary.entries.forEach((entry) => counts.set(entry.collectionId, (counts.get(entry.collectionId) || 0) + 1));
  $("#vocabularyCollectionList").innerHTML = state.vocabulary.collections.map((collection) => `
    <button type="button" class="vocabulary-collection ${vocabularyFilter === `collection:${collection.id}` ? "active" : ""}" data-vocabulary-filter="collection:${escapeHtml(collection.id)}" data-vocabulary-collection-id="${escapeHtml(collection.id)}" title="右键管理词库">
      <span>${iconSvg("folder")}${escapeHtml(collection.name)}</span><b>${counts.get(collection.id) || 0}</b>
    </button>
  `).join("");
  $$(".vocabulary-collection[data-vocabulary-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.vocabularyFilter === vocabularyFilter);
    button.onclick = () => {
      vocabularyFilter = button.dataset.vocabularyFilter;
      renderVocabulary();
    };
  });
  $$('[data-vocabulary-collection-id]').forEach((button) => {
    button.oncontextmenu = (event) => {
      event.preventDefault();
      vocabularyCollectionContextId = button.dataset.vocabularyCollectionId;
      hideFloatingMenus();
      positionFloatingMenu($("#vocabularyCollectionMenu"), event.clientX, event.clientY);
    };
  });
  $("#vocabularyWords").innerHTML = entries.map((entry) => {
    const selected = vocabularyCombineMode ? vocabularySelection.has(entry.id) : vocabularyBatchSelection.has(entry.id);
    const actionTitle = vocabularyCombineMode ? "加入或移出组合" : vocabularyBatchMode ? "勾选或取消词条" : "单击复制；右键管理";
    return `
    <div role="button" tabindex="0" class="vocabulary-word ${entry.favorite ? "favorite" : ""} ${vocabularySelection.has(entry.id) ? "selected" : ""} ${vocabularyBatchSelection.has(entry.id) ? "batch-selected" : ""}" data-vocabulary-id="${escapeHtml(entry.id)}" title="${actionTitle}" aria-selected="${selected}">
      ${vocabularyCombineMode || vocabularyBatchMode ? iconSvg(selected ? "square-check" : "plus") : iconSvg("copy")}
      <span>${escapeHtml(entry.text)}</span>
      <button type="button" class="vocabulary-word-favorite" data-vocabulary-favorite="${escapeHtml(entry.id)}" aria-label="${entry.favorite ? "取消收藏" : "收藏"}" title="${entry.favorite ? "取消收藏" : "收藏"}">${iconSvg("star")}</button>
    </div>`;
  }).join("");
  $("#vocabularyEmpty").classList.toggle("hidden", entries.length > 0);
  $$("[data-vocabulary-id]").forEach((button) => {
    button.onclick = () => handleVocabularyWordClick(button.dataset.vocabularyId, button);
    button.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      handleVocabularyWordClick(button.dataset.vocabularyId, button);
    };
    button.oncontextmenu = (event) => {
      event.preventDefault();
      vocabularyContextId = button.dataset.vocabularyId;
      const entry = state.vocabulary.entries.find((item) => item.id === vocabularyContextId);
      $("#vocabularyWordMenu [data-vocabulary-action='favorite'] .menu-label").textContent = entry?.favorite ? "取消收藏" : "收藏";
      hideFloatingMenus();
      positionFloatingMenu($("#vocabularyWordMenu"), event.clientX, event.clientY);
    };
  });
  $$('[data-vocabulary-favorite]').forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleVocabularyFavorite(button.dataset.vocabularyFavorite);
  }));
  $$('[data-vocabulary-favorite]').forEach((button) => button.addEventListener("keydown", (event) => {
    event.stopPropagation();
  }));
  updateVocabularyComposer();
  updateVocabularyBatchToolbar();
}

async function markVocabularyUsed(ids) {
  const usedAt = new Date().toISOString();
  const result = await window.promptDock.recordVocabularyUse(ids, usedAt);
  if (!result?.ok) return;
  for (const update of result.updated || []) {
    const entry = state.vocabulary.entries.find((item) => item.id === update.id);
    if (entry) Object.assign(entry, update);
  }
}

async function handleVocabularyWordClick(id, button) {
  const entry = state.vocabulary.entries.find((item) => item.id === id);
  if (!entry) return;
  if (vocabularyBatchMode) {
    if (vocabularyBatchSelection.has(id)) vocabularyBatchSelection.delete(id); else vocabularyBatchSelection.add(id);
    renderVocabulary();
    return;
  }
  if (vocabularyCombineMode) {
    if (vocabularySelection.has(id)) vocabularySelection.delete(id); else vocabularySelection.add(id);
    renderVocabulary();
    return;
  }
  await window.promptDock.copy(entry.text);
  await markVocabularyUsed([id]);
  button?.classList.add("copied");
  if (button) {
    button.querySelector("svg use")?.setAttribute("href", "#icon-check");
    setTimeout(() => renderVocabulary(), 720);
  }
  toast(`已复制：${entry.text.length > 34 ? `${entry.text.slice(0, 34)}…` : entry.text}`);
}

function setAppMode(mode) {
  appMode = mode === "vocabulary" ? "vocabulary" : "prompts";
  if (batchMode && appMode === "vocabulary") setBatchMode(false);
  if (appMode === "prompts") {
    vocabularyCombineMode = false;
    vocabularyBatchMode = false;
    vocabularySelection.clear();
    vocabularyBatchSelection.clear();
    document.body.classList.remove("vocabulary-combine-mode", "vocabulary-batch-mode");
  }
  $("#vocabularyWorkspace").classList.toggle("hidden", appMode !== "vocabulary");
  $("#vocabularySidebarNav").classList.toggle("hidden", appMode !== "vocabulary");
  $("#vocabularyNavItem").classList.toggle("active", appMode === "vocabulary");
  $("#vocabularyNavItem").setAttribute("aria-selected", String(appMode === "vocabulary"));
  $("#promptLibraryNavItem").classList.toggle("active", appMode === "prompts");
  $("#promptLibraryNavItem").setAttribute("aria-selected", String(appMode === "prompts"));
  if (appMode === "vocabulary") {
    $$(".nav-item[data-filter]").forEach((item) => item.classList.remove("active"));
    renderVocabulary();
  }
  updateContextualMainAction();
  applyLayout();
  if (state.settings.compactMode) setCompactSidebarOpen(false);
}

function updateContextualMainAction() {
  const vocabularyMode = appMode === "vocabulary";
  $("#mainActionLabel").textContent = vocabularyMode ? "批量添加词条" : "新建 Prompt";
  $("#mainActionIcon").setAttribute("href", "#icon-plus");
  if (vocabularyMode) {
    $("#newPromptBtn").title = "批量添加词条";
    $("#newPromptBtn").removeAttribute("aria-keyshortcuts");
  } else {
    const shortcut = state.settings.newPromptShortcut || DEFAULT_NEW_SHORTCUT;
    $("#newPromptBtn").title = `新建 Prompt（${displayAccelerator(shortcut)}）`;
    $("#newPromptBtn").setAttribute("aria-keyshortcuts", normalizeAccelerator(shortcut));
  }
}

function openVocabularyBulkDialog() {
  fillVocabularyCollectionSelects();
  $("#vocabularyBulkText").value = "";
  showEditableDialog($("#vocabularyBulkDialog"), $("#vocabularyBulkText"));
}

function fillVocabularyCollectionSelects() {
  ensureVocabularyState();
  const options = state.vocabulary.collections.map((collection) => `<option value="${escapeHtml(collection.id)}">${escapeHtml(collection.name)}</option>`).join("");
  $("#vocabularyBulkCollection").innerHTML = options;
  $("#vocabularyEditCollection").innerHTML = options;
  if (vocabularyFilter.startsWith("collection:")) $("#vocabularyBulkCollection").value = vocabularyFilter.slice(11);
}

function openVocabularyCollectionDialog(collectionId = "") {
  const collection = vocabularyCollectionById(collectionId);
  $("#vocabularyCollectionId").value = collection?.id || "";
  $("#vocabularyCollectionName").value = collection?.name || "";
  $("#vocabularyCollectionHeading").textContent = collection ? "重命名词库" : "新建词库";
  showEditableDialog($("#vocabularyCollectionDialog"), $("#vocabularyCollectionName"), { select: Boolean(collection) });
}

function renderAll() {
  ensureVocabularyState();
  renderSidebar();
  $("#vocabularyNavItem").classList.toggle("active", appMode === "vocabulary");
  $("#vocabularyNavItem").setAttribute("aria-selected", String(appMode === "vocabulary"));
  $("#promptLibraryNavItem").classList.toggle("active", appMode === "prompts");
  $("#promptLibraryNavItem").setAttribute("aria-selected", String(appMode === "prompts"));
  if (appMode === "vocabulary") $$(".nav-item[data-filter]").forEach((item) => item.classList.remove("active"));
  renderList();
  renderPreview();
  applyLayout();
  applyPrivacyMode();
  $(".app-shell").classList.toggle("vocabulary-mode", appMode === "vocabulary");
  $("#vocabularyWorkspace").classList.toggle("hidden", appMode !== "vocabulary");
  $("#vocabularySidebarNav").classList.toggle("hidden", appMode !== "vocabulary");
  if (appMode === "vocabulary") renderVocabulary();
  document.body.classList.toggle("batch-mode", batchMode);
  $("#batchToolbar").classList.toggle("hidden", !batchMode);
  updateBatchToolbar();
  $("#shortcutBadge").textContent = IS_MAC ? "⌘ K" : "Ctrl K";
  $("#vocabularyShortcutBadge").textContent = IS_MAC ? "⌘ K" : "Ctrl K";
  $("#lightboxCopyImage").title = `复制图片（${IS_MAC ? "⌘C" : "Ctrl+C"}）`;
  updateContextualMainAction();
}

function selectPrompt(id) {
  selectedId = id;
  renderList();
  renderPreview();
  $(".preview-scroll").scrollTop = 0;
}

function previewPrompt(id) {
  if (selectedId === id) return;
  selectedId = id;
  activeVariantId = "default";
  previewImageIndex = 0;
  if (!batchMode) $$(".prompt-card").forEach((card) => card.classList.toggle("selected", card.dataset.id === id));
  renderPreview();
  $(".preview-scroll").scrollTop = 0;
}

function setFilter(filter) {
  appMode = "prompts";
  vocabularyCombineMode = false;
  vocabularyBatchMode = false;
  vocabularySelection.clear();
  vocabularyBatchSelection.clear();
  document.body.classList.remove("vocabulary-combine-mode", "vocabulary-batch-mode");
  $("#vocabularyWorkspace").classList.add("hidden");
  $("#vocabularySidebarNav").classList.add("hidden");
  $("#vocabularyNavItem").classList.remove("active");
  $("#vocabularyNavItem").setAttribute("aria-selected", "false");
  $("#promptLibraryNavItem").classList.add("active");
  $("#promptLibraryNavItem").setAttribute("aria-selected", "true");
  currentFilter = filter;
  if (batchMode) setBatchMode(false);
  const selectedPrompt = state.prompts.find((prompt) => prompt.id === selectedId);
  if (selectedPrompt && (filter === "trash") !== Boolean(selectedPrompt.deletedAt)) {
    selectedId = null;
    renderPreview();
  }
  $$(".nav-item[data-filter]").forEach((item) => item.classList.toggle("active", item.dataset.filter === filter));
  const rawTag = filter.startsWith("tagtree:") ? filter.slice(8) : filter.slice(4);
  const plainTitle = filter === "all" ? "全部 Prompt" : filter === "favorite" ? "收藏" : filter === "recent" ? "最近使用" : filter === "untagged" ? "无标签" : filter === "trash" ? "回收站" : "";
  if (plainTitle) {
    $("#viewTitle").textContent = plainTitle;
    $("#viewTitle").title = plainTitle;
  } else {
    const { root, child } = tagPathParts(rawTag);
    $("#viewTitle").innerHTML = `<span class="view-title-hash">#</span><span class="view-title-current">${escapeHtml(child || root)}</span>`;
    $("#viewTitle").title = `# ${tagDisplayLabel(rawTag, " / ")}`;
  }
  renderList();
  applyLayout();
  updateContextualMainAction();
  if (state.settings.compactMode) setCompactSidebarOpen(false);
}

function setSortMenuOpen(open) {
  $("#sortMenu").classList.toggle("open", open);
  $("#sortMenuOptions").classList.toggle("hidden", !open);
  $("#sortMenuButton").setAttribute("aria-expanded", String(open));
}

function applySort(sort) {
  const labels = { updated: "最近修改", used: "最常使用", title: "名称" };
  if (!labels[sort]) return;
  currentSort = sort;
  $("#sortMenuLabel").textContent = labels[sort];
  $$("#sortMenuOptions [data-sort]").forEach((button) => {
    const active = button.dataset.sort === sort;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  setSortMenuOpen(false);
  renderList();
}

function allTagStats() {
  const stats = new Map();
  state.prompts.forEach((prompt) => {
    if (prompt.deletedAt) return;
    (prompt.tags || []).forEach((rawTag) => {
      const tag = normalizeTagPath(rawTag);
      if (!tag) return;
      const key = tag.toLocaleLowerCase();
      const item = stats.get(key) || { tag, count: 0, latest: "" };
      item.count += 1;
      item.latest = [item.latest, prompt.lastUsed || prompt.updatedAt || ""].sort().at(-1);
      stats.set(key, item);
    });
  });
  return stats;
}

function uniqueCanonicalTags(tags) {
  const stats = allTagStats();
  const seen = new Set();
  return tags.map(normalizeTagPath).map((tag) => stats.get(tag.toLocaleLowerCase())?.tag || tag).filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function editorTags() {
  return uniqueCanonicalTags($("#tagsField").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean));
}

function activeTagQuery() {
  const value = $("#tagsField").value;
  if (/[,，]\s*$/.test(value)) return "";
  return value.split(/[,，]/).at(-1).trim();
}

function chooseEditorTag(tag) {
  clearTimeout(editorFocusTimer);
  const field = $("#tagsField");
  const parts = field.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  const query = activeTagQuery();
  const exactExisting = allTagStats().has(query.toLocaleLowerCase());
  if (query && !exactExisting && parts.length) parts[parts.length - 1] = tag;
  else {
    const index = parts.findIndex((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase());
    if (index >= 0) parts.splice(index, 1); else parts.push(tag);
  }
  field.value = uniqueCanonicalTags(parts).join(", ");
  renderTagSuggestions();
  field.focus();
}

function renderTagSuggestions() {
  const container = $("#tagSuggestions");
  const selected = editorTags();
  const selectedKeys = new Set(selected.map((tag) => tag.toLocaleLowerCase()));
  const recent = [];
  const recentKeys = new Set();
  [...state.prompts]
    .filter((prompt) => !prompt.deletedAt)
    .sort((a, b) => String(b.lastUsed || b.updatedAt || "").localeCompare(String(a.lastUsed || a.updatedAt || "")))
    .forEach((prompt) => (prompt.tags || []).forEach((tag) => {
      const key = tag.toLocaleLowerCase();
      if (recent.length < 4 && !recentKeys.has(key)) {
        recentKeys.add(key);
        recent.push(tag);
      }
    }));

  const stats = allTagStats();
  const query = activeTagQuery().toLocaleLowerCase();
  const matches = query ? [...stats.values()]
    .filter((item) => item.tag.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(!a.tag.toLocaleLowerCase().startsWith(query)) - Number(!b.tag.toLocaleLowerCase().startsWith(query)) || b.count - a.count)
    .slice(0, 6)
    .map((item) => item.tag) : [];
  const matchKeys = new Set(matches.map((tag) => tag.toLocaleLowerCase()));
  const common = [...stats.values()]
    .filter((item) => !recentKeys.has(item.tag.toLocaleLowerCase()) && !matchKeys.has(item.tag.toLocaleLowerCase()))
    .sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest) || a.tag.localeCompare(b.tag))
    .slice(0, 6)
    .map((item) => item.tag);

  const groups = [["匹配", matches], ["最近", recent.filter((tag) => !matchKeys.has(tag.toLocaleLowerCase()))], ["常用", common]].filter(([, tags]) => tags.length);
  container.classList.toggle("hidden", groups.length === 0);
  container.innerHTML = groups.map(([label, tags]) => `
    <div class="tag-suggestion-group">
      <span class="tag-suggestion-label">${label}</span>
      <div class="tag-suggestion-options">${tags.map((tag) => `
        <button type="button" class="tag-suggestion ${label === "匹配" ? "match" : ""} ${selectedKeys.has(tag.toLocaleLowerCase()) ? "selected" : ""}" data-tag="${escapeHtml(tag)}" title="${escapeHtml(tag)}">${tagSuggestionMarkup(tag)}</button>
      `).join("")}</div>
    </div>
  `).join("");
  $$("#tagSuggestions [data-tag]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      chooseEditorTag(button.dataset.tag);
    });
    button.addEventListener("click", (event) => {
      if (event.detail === 0) chooseEditorTag(button.dataset.tag);
    });
  });
}

function promptCreationContextTags() {
  if (appMode !== "prompts") return [];
  if (currentFilter.startsWith("tagtree:")) return [normalizeTagPath(currentFilter.slice(8))].filter(Boolean);
  if (currentFilter.startsWith("tag:")) return [normalizeTagPath(currentFilter.slice(4))].filter(Boolean);
  return [];
}

function openEditor(prompt, initialTags = []) {
  editingId = prompt?.id || null;
  pendingImages = [...(prompt?.images || [])];
  pendingVariants = (prompt?.variants || []).map((variant) => ({ ...variant }));
  $("#editorHeading").textContent = prompt ? "编辑 Prompt" : "新建 Prompt";
  $("#titleField").value = prompt?.title || "";
  $("#contentField").value = prompt?.content || "";
  $("#usageNoteField").value = prompt?.usageNote || "";
  $("#defaultVariantTitleField").value = prompt?.defaultVariantTitle || "默认版本";
  $("#tagsField").value = prompt ? (prompt.tags || []).join(", ") : uniqueCanonicalTags(initialTags).join(", ");
  renderTagSuggestions();
  renderImageEditor();
  renderVariantEditor();
  const editorForm = $("#editorForm");
  const editorDialog = $("#editorDialog");
  editorForm.scrollTop = 0;
  editorDialog.scrollTop = 0;
  showEditableDialog(editorDialog, $("#titleField"), { resetDialogScroll: true });
  requestAnimationFrame(() => {
    editorForm.scrollTop = 0;
    editorDialog.scrollTop = 0;
  });
  clearTimeout(editorFocusTimer);
  editorFocusTimer = setTimeout(() => {
    editorForm.scrollTop = 0;
    editorDialog.scrollTop = 0;
  }, 50);
}

function addPendingImages(images, errors = []) {
  const available = Math.max(0, 6 - pendingImages.length);
  const unique = (images || []).filter((image) => !pendingImages.includes(image));
  pendingImages.push(...unique.slice(0, available));
  renderImageEditor();
  if (unique.length > available) errors = [...errors, `最多只能添加 6 张图片`];
  if (errors.length) toast(errors[0]);
  else if (unique.length) toast(`已添加 ${Math.min(unique.length, available)} 张图片`);
}

function renderImageEditor() {
  $("#imageStatus").textContent = pendingImages.length
    ? `${pendingImages.length} / 6 张 · 第一张作为卡片封面，可拖动调整顺序`
    : "尚未添加图片";
  $("#chooseImageBtn").disabled = pendingImages.length >= 6;
  $("#imageEditorList").innerHTML = pendingImages.map((image, index) => `
    <div class="image-editor-item" data-image-index="${index}">
      <img src="${image}" alt="第 ${index + 1} 张图片">
      ${index === 0 ? `<span class="image-cover-badge">封面</span>` : ""}
      <span class="image-drag-handle" draggable="true" title="拖动调整顺序" aria-label="拖动第 ${index + 1} 张图片">${iconSvg("grip")}</span>
      <div class="image-editor-actions">
        <button type="button" data-image-action="cover" ${index === 0 ? "disabled" : ""}>设为封面</button>
        <button type="button" class="danger" data-image-action="delete">删除</button>
      </div>
    </div>
  `).join("");
  $$("#imageEditorList .image-editor-item").forEach((item) => {
    const index = Number(item.dataset.imageIndex);
    item.querySelector(".image-drag-handle").addEventListener("dragstart", (event) => {
      draggedImageIndex = index;
      item.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    });
    item.querySelector(".image-drag-handle").addEventListener("dragend", () => {
      draggedImageIndex = null;
      $$("#imageEditorList .image-editor-item").forEach((card) => card.classList.remove("dragging", "drop-before", "drop-after"));
    });
    item.addEventListener("dragover", (event) => {
      if (draggedImageIndex === null) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const after = event.clientX > item.getBoundingClientRect().left + item.offsetWidth / 2;
      item.classList.toggle("drop-before", !after);
      item.classList.toggle("drop-after", after);
    });
    item.addEventListener("dragleave", () => item.classList.remove("drop-before", "drop-after"));
    item.addEventListener("drop", (event) => {
      if (draggedImageIndex === null) return;
      event.preventDefault();
      event.stopPropagation();
      const after = item.classList.contains("drop-after");
      reorderPendingImage(draggedImageIndex, index, after);
      draggedImageIndex = null;
      renderImageEditor();
    });
    item.querySelectorAll("[data-image-action]").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.imageAction === "cover" && index > 0) {
        const [cover] = pendingImages.splice(index, 1);
        pendingImages.unshift(cover);
      }
      if (button.dataset.imageAction === "delete") pendingImages.splice(index, 1);
      renderImageEditor();
    }));
  });
}

function reorderPendingImage(fromIndex, targetIndex, after = false) {
  if (fromIndex < 0 || targetIndex < 0 || fromIndex >= pendingImages.length || targetIndex >= pendingImages.length) return;
  const [moved] = pendingImages.splice(fromIndex, 1);
  let insertionIndex = targetIndex + (after ? 1 : 0);
  if (fromIndex < insertionIndex) insertionIndex -= 1;
  pendingImages.splice(Math.max(0, Math.min(insertionIndex, pendingImages.length)), 0, moved);
}

async function importDroppedImages(files) {
  const imageFiles = [...files].filter((file) => file.type.startsWith("image/")).slice(0, 6);
  if (!imageFiles.length) return toast("请拖入图片文件");
  const buffers = await Promise.all(imageFiles.map((file) => file.arrayBuffer()));
  const result = await window.promptDock.importImageBuffers(buffers);
  addPendingImages(result.images, result.errors);
}

function renderVariantEditor() {
  const list = $("#variantEditorList");
  list.classList.toggle("empty", pendingVariants.length === 0);
  list.innerHTML = pendingVariants.length ? pendingVariants.map((variant, index) => `
    <div class="variant-editor-item" data-index="${index}">
      <div class="variant-editor-row">
        <input class="variant-title-input" maxlength="80" value="${escapeHtml(variant.title)}" placeholder="变体名称">
        <div class="variant-order-actions">
          <button type="button" class="icon-btn" data-variant-action="up" title="上移" aria-label="上移" ${index === 0 ? "disabled" : ""}>${iconSvg("arrow-up")}</button>
          <button type="button" class="icon-btn" data-variant-action="down" title="下移" aria-label="下移" ${index === pendingVariants.length - 1 ? "disabled" : ""}>${iconSvg("arrow-down")}</button>
          <button type="button" class="icon-btn danger" data-variant-action="delete" title="删除变体" aria-label="删除变体">${iconSvg("trash")}</button>
        </div>
      </div>
      <textarea class="variant-content-input" rows="5" placeholder="输入这个变体的 Prompt 内容…">${escapeHtml(variant.content)}</textarea>
    </div>
  `).join("") : `<div class="variant-editor-empty">还没有变体。添加后，悬停卡片即可选择不同版本。</div>`;
  $$(".variant-editor-item").forEach((item) => {
    const index = Number(item.dataset.index);
    item.querySelector(".variant-title-input").addEventListener("input", (event) => {
      pendingVariants[index].title = event.target.value;
    });
    item.querySelector(".variant-content-input").addEventListener("input", (event) => {
      pendingVariants[index].content = event.target.value;
    });
    item.querySelectorAll("[data-variant-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.variantAction;
        if (action === "delete") pendingVariants.splice(index, 1);
        if (action === "up" && index > 0) [pendingVariants[index - 1], pendingVariants[index]] = [pendingVariants[index], pendingVariants[index - 1]];
        if (action === "down" && index < pendingVariants.length - 1) [pendingVariants[index + 1], pendingVariants[index]] = [pendingVariants[index], pendingVariants[index + 1]];
        renderVariantEditor();
      });
    });
  });
}

async function usePrompt(mode, variantId = activeVariantId) {
  const prompt = state.prompts.find((p) => p.id === selectedId);
  if (!prompt) return;
  if (activeVariantId !== variantId) setPreviewVersion(variantId);
  const version = selectedVersion(prompt, variantId);
  const text = version.content;
  let result;
  if (mode === "paste") {
    result = await window.promptDock.paste(text);
    if (!result.ok) toast(result.message || "无法粘贴，请先点击目标输入框");
    else toast("已粘贴到当前输入框");
  } else {
    result = await window.promptDock.copy(text);
    if (!result.ok) toast(result.message || "复制失败");
    else toast("已复制到剪贴板");
  }
  if (!result?.ok) return;
  prompt.useCount = (prompt.useCount || 0) + 1;
  prompt.lastUsed = new Date().toISOString();
  if (!version.isDefault) {
    version.useCount = (version.useCount || 0) + 1;
    version.lastUsed = prompt.lastUsed;
  }
  const usage = await window.promptDock.recordPromptUse(prompt.id, version.id, prompt.lastUsed);
  if (usage?.ok) {
    prompt.useCount = usage.useCount;
    prompt.lastUsed = usage.lastUsed;
    if (!version.isDefault) version.useCount = usage.variantUseCount;
  } else {
    await persist();
  }
}

function eventToAccelerator(event) {
  const modifiers = [];
  if (IS_MAC && event.metaKey) modifiers.push("Command");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (!IS_MAC && event.metaKey) modifiers.push("Super");
  const ignored = ["Control", "Alt", "Shift", "Meta"];
  if (ignored.includes(event.key)) return "";
  let key = /^(Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code.replace(/^(Key|Digit)/, "") : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const names = { " ": "Space", Escape: "Esc", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
  key = names[key] || key;
  return modifiers.length ? [...modifiers, key].join("+") : "";
}

function normalizeAccelerator(value) {
  const command = IS_MAC ? "Command" : "Super";
  const aliases = { ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", win: "Super", meta: command, super: command, command: command, cmd: command };
  const parts = String(value || "").split("+").map((part) => part.trim()).filter(Boolean);
  const modifiers = IS_MAC ? ["Command", "Control", "Alt", "Shift"] : ["Control", "Alt", "Shift", "Super"];
  const mapped = parts.map((part) => aliases[part.toLocaleLowerCase()] || (part.length === 1 ? part.toUpperCase() : part));
  const key = mapped.find((part) => !modifiers.includes(part));
  return key ? [...modifiers.filter((modifier) => mapped.includes(modifier)), key].join("+") : "";
}

function displayAccelerator(value) {
  return normalizeAccelerator(value).replace("Control", IS_MAC ? "⌃" : "Ctrl").replace("Command", "⌘").replace("Alt", IS_MAC ? "⌥" : "Alt").replace("Shift", IS_MAC ? "⇧" : "Shift").replace("Super", "Win");
}

function eventMatchesAccelerator(event, accelerator) {
  return normalizeAccelerator(eventToAccelerator(event)) === normalizeAccelerator(accelerator);
}

function validateNewPromptShortcut(value, globalValue = state.settings.shortcut) {
  const normalized = normalizeAccelerator(value);
  if (!normalized) return "请录制一个包含修饰键的快捷键。";
  if (normalized === (IS_MAC ? "Command+K" : "Control+K")) return `${IS_MAC ? "⌘K" : "Ctrl+K"} 已用于聚焦搜索，请换一个组合键。`;
  if (normalized === normalizeAccelerator(globalValue)) return "不能与全局唤出快捷键相同。";
  return "";
}

async function openNewPrompt() {
  if ($("#editorDialog").open) return;
  if (batchMode) setBatchMode(false);
  if (state.settings.compactMode) setCompactSidebarOpen(false);
  openEditor(null, promptCreationContextTags());
}

async function openAuthorDialog() {
  const dialog = $("#authorDialog");
  $("#authorAppVersion").textContent = `v${await window.promptDock.getAppVersion()}`;
  dialog.scrollTop = 0;
  $("#authorForm").scrollTop = 0;
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => {
    dialog.scrollTop = 0;
    $("#authorForm").scrollTop = 0;
  });
}

$("#minimizeBtn").addEventListener("click", () => window.promptDock.minimize());
$("#hideBtn").addEventListener("click", () => window.promptDock.hide());
$("#toggleLeftBtn").addEventListener("click", () => {
  if (state.settings.compactMode) {
    setCompactSidebarOpen(!compactSidebarOpen);
    return;
  }
  toggleLayoutSetting("leftCollapsed");
});
$("#toggleRightBtn").addEventListener("click", () => toggleLayoutSetting("rightCollapsed"));
$("#compactBtn").addEventListener("click", async () => {
  const next = !state.settings.compactMode;
  compactSidebarOpen = false;
  if (!next) {
    const bounds = await window.promptDock.getWindowBounds();
    state.settings.compactWindowSize = { width: bounds.width, height: bounds.height };
  }
  if (next) {
    state.settings.alwaysOnTopBeforeCompact = Boolean(state.settings.alwaysOnTop);
    state.settings.alwaysOnTop = true;
  } else {
    state.settings.alwaysOnTop = Boolean(state.settings.alwaysOnTopBeforeCompact);
  }
  state.settings.compactMode = next;
  const result = await window.promptDock.setCompactMode(next, state.settings.compactWindowSize);
  if (result.compactWindowSize) state.settings.compactWindowSize = result.compactWindowSize;
  await window.promptDock.setAlwaysOnTop(state.settings.alwaysOnTop);
  await persist();
  applyLayout();
  toast(next ? "已进入超小置顶模式" : "已恢复标准窗口");
});
$("#pinBtn").addEventListener("click", async () => {
  if (state.settings.compactMode) return;
  state.settings.alwaysOnTop = !state.settings.alwaysOnTop;
  await window.promptDock.setAlwaysOnTop(state.settings.alwaysOnTop);
  await persist();
  applyLayout();
  toast(state.settings.alwaysOnTop ? "窗口已置顶" : "已取消置顶");
});
$("#privacyModeBtn").addEventListener("click", async () => {
  state.settings.privacyMode = !state.settings.privacyMode;
  applyPrivacyMode();
  await persist();
  toast(state.settings.privacyMode ? "Prompt 内容已安全隐藏" : "Prompt 内容已恢复显示");
});
$("#batchModeBtn").addEventListener("click", () => setBatchMode(!batchMode));
$("#batchSelectAllBtn").addEventListener("click", () => {
  const visibleIds = filteredPrompts().map((prompt) => prompt.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => batchSelection.has(id));
  visibleIds.forEach((id) => allSelected ? batchSelection.delete(id) : batchSelection.add(id));
  renderList();
});
$("#batchDeleteBtn").addEventListener("click", () => {
  if (!batchSelection.size) return;
  const permanent = currentFilter === "trash";
  $("#batchDeleteCount").textContent = batchSelection.size;
  $("#batchDeleteTitle").textContent = permanent ? "永久删除所选 Prompt？" : "将所选 Prompt 移到回收站？";
  $("#batchDeleteMessage").innerHTML = permanent
    ? `将永久删除 <b id="batchDeleteCount">${batchSelection.size}</b> 条 Prompt；此操作无法撤销，未使用的图片也会自动清理。`
    : `将移动 <b id="batchDeleteCount">${batchSelection.size}</b> 条 Prompt；之后仍可从回收站恢复。`;
  $("#batchDeleteConfirmBtn").textContent = permanent ? "永久删除" : "移到回收站";
  $("#batchDeleteDialog").showModal();
});
$("#batchDeleteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await deleteBatchSelection();
});
$("#trashNavItem").addEventListener("contextmenu", (event) => {
  event.preventDefault();
  showTrashContextMenu(event.clientX, event.clientY);
});
$("#trashNavItem").addEventListener("keydown", (event) => {
  if (!(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  const rect = $("#trashNavItem").getBoundingClientRect();
  showTrashContextMenu(rect.left + 24, rect.bottom - 4);
});
$("#emptyTrashMenuBtn").addEventListener("click", () => {
  hideFloatingMenus();
  const count = state.prompts.filter((prompt) => prompt.deletedAt).length;
  if (!count) return;
  $("#emptyTrashCount").textContent = count;
  $("#emptyTrashDialog").showModal();
});
$("#emptyTrashForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const deletedIds = state.prompts.filter((prompt) => prompt.deletedAt).map((prompt) => prompt.id);
  const count = permanentlyDeletePrompts(deletedIds);
  selectedId = null;
  await persist();
  $("#emptyTrashDialog").close();
  renderAll();
  toast(`已清空回收站，永久删除 ${count} 条 Prompt`);
});
$("#newPromptBtn").addEventListener("click", () => {
  if (appMode === "vocabulary") openVocabularyBulkDialog();
  else openNewPrompt();
});
$("#promptLibraryNavItem").addEventListener("click", () => setFilter(currentFilter));
$("#vocabularyNavItem").addEventListener("click", () => setAppMode("vocabulary"));
$("#vocabularyNewCollectionBtn").addEventListener("click", () => openVocabularyCollectionDialog());
$("#vocabularyCollectionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = $("#vocabularyCollectionId").value;
  const name = $("#vocabularyCollectionName").value.trim();
  if (!name) return;
  const duplicate = state.vocabulary.collections.some((item) => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (duplicate) return toast("已经有同名词库");
  if (id) {
    const collection = vocabularyCollectionById(id);
    if (collection) collection.name = name;
  } else {
    const collection = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
    state.vocabulary.collections.push(collection);
    vocabularyFilter = `collection:${collection.id}`;
  }
  await persist();
  $("#vocabularyCollectionDialog").close();
  renderAll();
  toast(id ? "词库已重命名" : "词库已创建");
});
$("#vocabularyBulkForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const collectionId = $("#vocabularyBulkCollection").value || state.vocabulary.collections[0].id;
  const source = $("#vocabularyBulkText").value;
  const mode = $("#vocabularySplitMode").value;
  const splitter = vocabularySplitter(mode);
  const candidates = source.split(splitter).map((item) => item.trim()).filter(Boolean).map((item) => item.slice(0, 500));
  const existing = new Set(state.vocabulary.entries.filter((entry) => entry.collectionId === collectionId).map((entry) => entry.text.toLocaleLowerCase()));
  const now = new Date().toISOString();
  const added = [];
  for (const text of candidates) {
    const key = text.toLocaleLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    added.push({ id: crypto.randomUUID(), text, collectionId, favorite: false, useCount: 0, createdAt: now, updatedAt: now });
  }
  if (!added.length) return toast("没有可添加的新词条");
  state.vocabulary.entries.push(...added);
  vocabularyFilter = `collection:${collectionId}`;
  await persist();
  $("#vocabularyBulkDialog").close();
  renderAll();
  toast(`已添加 ${added.length} 个词条${candidates.length > added.length ? `，去重 ${candidates.length - added.length} 个` : ""}`);
});
$("#vocabularyCombineBtn").addEventListener("click", () => {
  setVocabularyInteractionMode(vocabularyCombineMode ? "normal" : "combine");
});
$("#vocabularyBatchBtn").addEventListener("click", () => {
  setVocabularyInteractionMode(vocabularyBatchMode ? "normal" : "batch");
});
$("#vocabularyBatchSelectAllBtn").addEventListener("click", () => {
  const visible = visibleVocabularyEntries();
  const allVisibleSelected = visible.length > 0 && visible.every((entry) => vocabularyBatchSelection.has(entry.id));
  visible.forEach((entry) => {
    if (allVisibleSelected) vocabularyBatchSelection.delete(entry.id);
    else vocabularyBatchSelection.add(entry.id);
  });
  renderVocabulary();
});
$("#vocabularyBatchDeleteBtn").addEventListener("click", () => {
  if (!vocabularyBatchSelection.size) return;
  $("#vocabularyBatchDeleteCount").textContent = vocabularyBatchSelection.size;
  $("#vocabularyBatchDeleteDialog").showModal();
});
$("#vocabularyBatchDeleteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const selectedIds = new Set(vocabularyBatchSelection);
  const count = selectedIds.size;
  state.vocabulary.entries = state.vocabulary.entries.filter((entry) => !selectedIds.has(entry.id));
  selectedIds.forEach((id) => vocabularySelection.delete(id));
  await persist();
  $("#vocabularyBatchDeleteDialog").close();
  setVocabularyInteractionMode("normal");
  renderAll();
  toast(`已删除 ${count} 个词条`);
});
$("#vocabularyBatchMoveBtn").addEventListener("click", openVocabularyBatchMoveDialog);
$("#vocabularyBatchMoveForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const targetCollectionId = $("#vocabularyBatchMoveCollection").value;
  const targetCollection = vocabularyCollectionById(targetCollectionId);
  if (!targetCollection) return;
  const now = new Date().toISOString();
  let movedCount = 0;
  state.vocabulary.entries.forEach((entry) => {
    if (!vocabularyBatchSelection.has(entry.id) || entry.collectionId === targetCollectionId) return;
    entry.collectionId = targetCollectionId;
    entry.updatedAt = now;
    movedCount += 1;
  });
  if (!movedCount) {
    $("#vocabularyBatchMoveDialog").close();
    return toast("所选词条已经在这个词库中");
  }
  await persist();
  $("#vocabularyBatchMoveDialog").close();
  setVocabularyInteractionMode("normal");
  renderAll();
  toast(`已将 ${movedCount} 个词条移动至“${targetCollection.name}”`);
});
$("#vocabularySeparator").addEventListener("change", async () => {
  state.vocabulary.settings.separator = $("#vocabularySeparator").value;
  updateVocabularyComposer();
  await persist();
});
$("#vocabularyClearSelectionBtn").addEventListener("click", () => {
  vocabularySelection.clear();
  renderVocabulary();
});
$("#vocabularyCopyCombinedBtn").addEventListener("click", async () => {
  const entries = state.vocabulary.entries.filter((entry) => vocabularySelection.has(entry.id));
  if (!entries.length) return;
  const result = entries.map((entry) => entry.text).join(vocabularySeparatorText());
  await window.promptDock.copy(result);
  await markVocabularyUsed(entries.map((entry) => entry.id));
  toast(`已复制 ${entries.length} 个词条的组合结果`);
});
$("#vocabularySearchInput").addEventListener("input", () => {
  clearTimeout(vocabularySearchRenderTimer);
  vocabularySearchRenderTimer = setTimeout(renderVocabulary, 70);
});
$$("#vocabularyWordMenu [data-vocabulary-action]").forEach((button) => button.addEventListener("click", async () => {
  const action = button.dataset.vocabularyAction;
  const entry = state.vocabulary.entries.find((item) => item.id === vocabularyContextId);
  hideFloatingMenus();
  if (!entry) return;
  if (action === "favorite") {
    await toggleVocabularyFavorite(entry.id);
    return;
  }
  if (action === "edit") {
    fillVocabularyCollectionSelects();
    $("#vocabularyEditId").value = entry.id;
    $("#vocabularyEditText").value = entry.text;
    $("#vocabularyEditCollection").value = entry.collectionId;
    showEditableDialog($("#vocabularyEditDialog"), $("#vocabularyEditText"));
  }
  if (action === "delete" && confirm(`删除词条“${entry.text}”吗？`)) {
    state.vocabulary.entries = state.vocabulary.entries.filter((item) => item.id !== entry.id);
    vocabularySelection.delete(entry.id);
    vocabularyBatchSelection.delete(entry.id);
    await persist();
    renderAll();
    toast("词条已删除");
  }
}));
$("#vocabularyEditForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = $("#vocabularyEditId").value;
  const entry = state.vocabulary.entries.find((item) => item.id === id);
  const text = $("#vocabularyEditText").value.trim();
  const collectionId = $("#vocabularyEditCollection").value;
  if (!entry || !text) return;
  const duplicate = state.vocabulary.entries.some((item) => item.id !== id && item.collectionId === collectionId && item.text.toLocaleLowerCase() === text.toLocaleLowerCase());
  if (duplicate) return toast("这个词库中已经有相同词条");
  entry.text = text;
  entry.collectionId = collectionId;
  entry.updatedAt = new Date().toISOString();
  await persist();
  $("#vocabularyEditDialog").close();
  renderAll();
  toast("词条已保存");
});
$$("#vocabularyCollectionMenu [data-vocabulary-collection-action]").forEach((button) => button.addEventListener("click", async () => {
  const action = button.dataset.vocabularyCollectionAction;
  const collection = vocabularyCollectionById(vocabularyCollectionContextId);
  hideFloatingMenus();
  if (!collection) return;
  if (action === "rename") return openVocabularyCollectionDialog(collection.id);
  if (action === "delete") {
    if (state.vocabulary.collections.length < 2) return toast("至少需要保留一个词库");
    const count = state.vocabulary.entries.filter((entry) => entry.collectionId === collection.id).length;
    if (!confirm(`删除词库“${collection.name}”吗？其中 ${count} 个词条会移动到其他词库，不会被删除。`)) return;
    const fallback = state.vocabulary.collections.find((item) => item.id !== collection.id);
    state.vocabulary.entries.forEach((entry) => { if (entry.collectionId === collection.id) entry.collectionId = fallback.id; });
    state.vocabulary.collections = state.vocabulary.collections.filter((item) => item.id !== collection.id);
    if (vocabularyFilter === `collection:${collection.id}`) vocabularyFilter = `collection:${fallback.id}`;
    await persist();
    renderAll();
    toast(`词库已删除，${count} 个词条已移动到“${fallback.name}”`);
  }
}));
$("#authorBtn").addEventListener("click", openAuthorDialog);
$("#authorQrButton").addEventListener("click", () => {
  const dialog = $("#authorQrDialog");
  dialog.scrollTop = 0;
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => { dialog.scrollTop = 0; });
});
$(".author-qr-close").addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const dialog = $("#authorQrDialog");
  if (dialog.open) dialog.close();
});
$("#settingsBtn").addEventListener("click", () => {
  if (batchMode) setBatchMode(false);
  if (state.settings.compactMode) setCompactSidebarOpen(false);
  $("#shortcutField").value = state.settings.shortcut;
  $("#newPromptShortcutField").value = state.settings.newPromptShortcut || DEFAULT_NEW_SHORTCUT;
  $("#alwaysOnTopField").checked = Boolean(state.settings.alwaysOnTop);
  $("#alwaysOnTopField").disabled = Boolean(state.settings.compactMode);
  $("#privacyHideImagesField").checked = Boolean(state.settings.privacyHideImages);
  $("#backupDirectoryField").value = state.settings.backupDirectory || "";
  $("#shortcutHint").textContent = "点击“录制”，然后按下新的组合键。";
  $("#shortcutHint").classList.remove("error");
  $("#newPromptShortcutHint").textContent = `默认 ${IS_MAC ? "⌘N" : "Ctrl+N"}，不会影响其他软件的新建快捷键。`;
  $("#newPromptShortcutHint").classList.remove("error");
  $("#importResult").classList.add("hidden");
  $("#settingsDialog").showModal();
  refreshBackupStatus();
  refreshCacheStatus();
});
$$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => {
  const dialog = document.getElementById(button.dataset.closeDialog);
  if (dialog?.open) dialog.close();
}));
$$("#tagContextMenu [data-tag-menu-action]").forEach((button) => button.addEventListener("click", () => {
  const action = button.dataset.tagMenuAction;
  const sourceName = tagContextName;
  const sourceButton = tagContextButton;
  const sourceScope = sourceButton?.dataset.tagScope || "exact";
  hideFloatingMenus();
  if (action === "rename" && sourceButton?.isConnected) startTagRename(sourceButton, sourceName, sourceScope);
  if (action === "merge") openTagMergeDialog(sourceName, sourceScope);
  if (action === "delete") openTagDeleteDialog(sourceName, sourceScope);
}));
$("#tagMergeTargetField").addEventListener("input", () => {
  $("#tagMergeError").classList.add("hidden");
  renderTagMergeOptions();
});
$("#tagMergeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const typed = $("#tagMergeTargetField").value.trim().replace(/^#\s*/, "");
  const target = allTagStats().get(normalizeTagPath(typed).toLocaleLowerCase())?.tag;
  const error = $("#tagMergeError");
  const sourceKey = tagMergeSourceName.toLocaleLowerCase();
  const targetKey = target?.toLocaleLowerCase() || "";
  const ownDescendant = tagMergeSourceScope === "branch" && targetKey.startsWith(`${sourceKey}/`);
  if (!target || targetKey === sourceKey || ownDescendant) {
    error.textContent = !target
      ? "请选择一个已有标签"
      : ownDescendant
        ? "父标签组不能合并到它自己的子标签中"
        : "目标标签不能与原标签相同";
    error.classList.remove("hidden");
    return;
  }
  const source = tagMergeSourceName;
  const isBranch = tagMergeSourceScope === "branch";
  const changed = replaceTagNameInPrompts(state.prompts, source, target, isBranch);
  if (isBranch) {
    const sourceKey = source.toLocaleLowerCase();
    if (currentFilter.toLocaleLowerCase() === `tagtree:${sourceKey}`) currentFilter = `tagtree:${target}`;
    else if (currentFilter.toLocaleLowerCase().startsWith(`tag:${sourceKey}/`)) currentFilter = `tag:${target}${currentFilter.slice(4 + source.length)}`;
  } else if (currentFilter.toLocaleLowerCase() === `tag:${source.toLocaleLowerCase()}`) currentFilter = `tag:${target}`;
  await persist();
  $("#tagMergeDialog").close();
  renderAll();
  toast(`已将“${source}”合并到“${target}”，更新 ${changed} 条 Prompt`);
});
$("#tagDeleteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const source = tagDeleteName;
  const isBranch = tagDeleteScope === "branch";
  const sourceKey = normalizeTagPath(source).toLocaleLowerCase();
  const changed = removeTagFromPrompts(state.prompts, source, isBranch);
  if (isBranch) {
    state.settings.collapsedTagGroups = (state.settings.collapsedTagGroups || [])
      .filter((tag) => String(tag).toLocaleLowerCase() !== sourceKey);
  }
  const activeFilter = currentFilter.toLocaleLowerCase();
  const viewingRemovedTag = isBranch
    ? activeFilter === `tagtree:${sourceKey}` || activeFilter === `tag:${sourceKey}` || activeFilter.startsWith(`tag:${sourceKey}/`)
    : activeFilter === `tag:${sourceKey}`;
  await persist();
  $("#tagDeleteDialog").close();
  renderAll();
  if (viewingRemovedTag) setFilter("all");
  toast(`已删除标签“${tagDisplayLabel(source)}”，更新 ${changed} 条 Prompt`);
});
$$("dialog").forEach((dialog) => {
  dialog.addEventListener("close", () => {
    if (dialog.id === "settingsDialog") recordingShortcut = null;
    if (dialog.id === "editorDialog") {
      $("#editorForm").scrollTop = 0;
      dialog.scrollTop = 0;
    }
    if (dialog.id === "imageLightbox") hideFloatingMenus();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
});
$("#searchInput").addEventListener("input", () => {
  clearTimeout(searchRenderTimer);
  searchRenderTimer = setTimeout(renderList, 70);
});
$("#tagsField").addEventListener("input", renderTagSuggestions);
$("#tagsField").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== "Tab") return;
  const match = $("#tagSuggestions .tag-suggestion.match");
  if (match && activeTagQuery()) {
    event.preventDefault();
    chooseEditorTag(match.dataset.tag);
    return;
  }
  if (event.key === "Enter" && activeTagQuery()) {
    event.preventDefault();
    $("#tagsField").value = `${editorTags().join(", ")}, `;
    renderTagSuggestions();
  }
});
$("#tagsField").addEventListener("blur", () => {
  $("#tagsField").value = editorTags().join(", ");
  renderTagSuggestions();
});
$("#sortMenuButton").addEventListener("click", () => setSortMenuOpen(!$("#sortMenu").classList.contains("open")));
$("#sortMenuButton").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  setSortMenuOpen(true);
  $("#sortMenuOptions [data-sort].active")?.focus();
});
$$("#sortMenuOptions [data-sort]").forEach((button) => {
  button.addEventListener("click", () => applySort(button.dataset.sort));
  button.addEventListener("keydown", (event) => {
    const options = $$("#sortMenuOptions [data-sort]");
    const index = options.indexOf(button);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].focus();
    }
    if (event.key === "Escape") {
      setSortMenuOpen(false);
      $("#sortMenuButton").focus();
    }
  });
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#sortMenu")) setSortMenuOpen(false);
  if (!event.target.closest(".floating-context-menu")) hideFloatingMenus();
});
$$(".nav-item[data-filter]").forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.filter)));
$("#favoriteBtn").addEventListener("click", async () => {
  const prompt = state.prompts.find((p) => p.id === selectedId);
  if (!prompt || prompt.deletedAt) return;
  prompt.favorite = !prompt.favorite;
  prompt.updatedAt = new Date().toISOString();
  await persist(); renderAll();
});
$("#editBtn").addEventListener("click", async () => {
  const prompt = state.prompts.find((p) => p.id === selectedId);
  if (prompt?.deletedAt) return restorePrompt(prompt);
  openEditor(prompt);
});
$("#deleteBtn").addEventListener("click", async () => {
  const prompt = state.prompts.find((p) => p.id === selectedId);
  if (!prompt) return;
  const permanent = Boolean(prompt.deletedAt);
  if (!confirm(permanent ? `永久删除“${prompt.title}”吗？此操作无法撤销。` : `将“${prompt.title}”移到回收站吗？`)) return;
  if (permanent) permanentlyDeletePrompts([prompt.id]);
  else movePromptsToTrash([prompt.id]);
  selectedId = null;
  await persist();
  renderAll();
  toast(permanent ? "已永久删除" : "已移到回收站");
});
bindReliableAction($("#copyBtn"), () => {
  const prompt = state.prompts.find((item) => item.id === selectedId);
  return prompt?.deletedAt ? restorePrompt(prompt) : usePrompt("copy");
});
$("#pasteBtn").addEventListener("click", () => {
  const prompt = state.prompts.find((item) => item.id === selectedId);
  if (!prompt?.deletedAt) return usePrompt("paste");
  $("#deleteBtn").click();
});
$("#previousImageBtn").addEventListener("click", () => {
  const prompt = state.prompts.find((item) => item.id === selectedId);
  if (!prompt?.images?.length) return;
  previewImageIndex = (previewImageIndex - 1 + prompt.images.length) % prompt.images.length;
  renderPreviewImages(prompt);
});
$("#nextImageBtn").addEventListener("click", () => {
  const prompt = state.prompts.find((item) => item.id === selectedId);
  if (!prompt?.images?.length) return;
  previewImageIndex = (previewImageIndex + 1) % prompt.images.length;
  renderPreviewImages(prompt);
});
$("#previewImage").addEventListener("click", () => {
  openLightbox(previewImageIndex);
});
$("#lightboxPrevious").addEventListener("click", () => moveLightbox(-1));
$("#lightboxNext").addEventListener("click", () => moveLightbox(1));
$("#lightboxZoomIn").addEventListener("click", () => setLightboxZoom(lightboxZoom * 1.2));
$("#lightboxZoomOut").addEventListener("click", () => setLightboxZoom(lightboxZoom / 1.2));
$("#lightboxZoomReset").addEventListener("click", () => setLightboxZoom(1));
bindReliableAction($("#lightboxCopyImage"), copyCurrentLightboxImage);
$("#lightboxSaveImage").addEventListener("click", saveCurrentLightboxImage);
$("#lightboxImage").addEventListener("contextmenu", (event) => {
  event.preventDefault();
  showImageContextMenu(event.clientX, event.clientY);
});
$$("#imageContextMenu [data-image-menu-action]").forEach((button) => button.addEventListener("click", () => {
  const action = button.dataset.imageMenuAction;
  hideFloatingMenus();
  if (action === "copy") copyCurrentLightboxImage();
  if (action === "save") saveCurrentLightboxImage();
}));
$("#lightboxStage").addEventListener("wheel", (event) => {
  event.preventDefault();
  setLightboxZoom(lightboxZoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
}, { passive: false });
$("#lightboxStage").addEventListener("dblclick", () => setLightboxZoom(lightboxZoom > 1 ? 1 : 2));
$("#lightboxImage").addEventListener("load", fitLightboxImage);
new ResizeObserver(() => {
  if ($("#imageLightbox").open) fitLightboxImage();
}).observe($("#lightboxStage"));
$("#lightboxStage").addEventListener("pointerdown", (event) => {
  if (lightboxZoom <= 1 || event.button !== 0 || event.target.closest("button")) return;
  event.preventDefault();
  lightboxPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  $("#lightboxStage").setPointerCapture(event.pointerId);
  $("#lightboxStage").classList.add("panning");
});
$("#lightboxStage").addEventListener("pointermove", (event) => {
  if (!lightboxPointer || lightboxPointer.id !== event.pointerId) return;
  const deltaX = event.clientX - lightboxPointer.x;
  const deltaY = event.clientY - lightboxPointer.y;
  lightboxPointer.x = event.clientX;
  lightboxPointer.y = event.clientY;
  panLightboxBy(deltaX, deltaY);
});
function endLightboxPan(event) {
  if (!lightboxPointer || lightboxPointer.id !== event.pointerId) return;
  lightboxPointer = null;
  $("#lightboxStage").classList.remove("panning");
}
$("#lightboxStage").addEventListener("pointerup", endLightboxPan);
$("#lightboxStage").addEventListener("pointercancel", endLightboxPan);
$("#imageLightbox").addEventListener("keydown", (event) => {
  if ((IS_MAC ? event.metaKey : event.ctrlKey) && event.key.toLocaleLowerCase() === "c") {
    event.preventDefault();
    copyCurrentLightboxImage();
    return;
  }
  if (event.key === "ArrowLeft") moveLightbox(-1);
  if (event.key === "ArrowRight") moveLightbox(1);
  if (event.key === "+" || event.key === "=") setLightboxZoom(lightboxZoom * 1.2);
  if (event.key === "-") setLightboxZoom(lightboxZoom / 1.2);
  if (event.key === "0") setLightboxZoom(1);
});
$("#addVariantBtn").addEventListener("click", () => {
  const now = new Date().toISOString();
  pendingVariants.push({
    id: crypto.randomUUID(),
    title: `变体 ${pendingVariants.length + 1}`,
    content: "",
    useCount: 0,
    createdAt: now,
    updatedAt: now
  });
  renderVariantEditor();
  const lastContent = $("#variantEditorList .variant-editor-item:last-child .variant-content-input");
  lastContent?.focus();
});
$("#chooseImageBtn").addEventListener("click", async (event) => {
  event.stopPropagation();
  if (pendingImages.length >= 6) return toast("最多只能添加 6 张图片");
  const result = await window.promptDock.chooseImages();
  if (!result.canceled) addPendingImages(result.images, result.errors);
});
$("#imageDropZone").addEventListener("click", () => $("#chooseImageBtn").click());
$("#imageDropZone").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  $("#chooseImageBtn").click();
});
$("#editorDialog").addEventListener("dragover", (event) => {
  if (![...event.dataTransfer.items].some((item) => item.kind === "file")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  $("#imageDropZone").classList.add("drag-active");
});
$("#editorDialog").addEventListener("dragleave", (event) => {
  if (!$("#editorDialog").contains(event.relatedTarget)) $("#imageDropZone").classList.remove("drag-active");
});
$("#editorDialog").addEventListener("drop", async (event) => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  $("#imageDropZone").classList.remove("drag-active");
  await importDroppedImages(event.dataTransfer.files);
});
$("#editorDialog").addEventListener("paste", async (event) => {
  const hasImage = [...event.clipboardData.items].some((item) => item.type.startsWith("image/"));
  if (!hasImage) return;
  event.preventDefault();
  if (pendingImages.length >= 6) return toast("最多只能添加 6 张图片");
  const result = await window.promptDock.pasteImage();
  addPendingImages(result.images, result.errors);
});
$("#editorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const now = new Date().toISOString();
  const existing = state.prompts.find((p) => p.id === editingId);
  const next = {
    id: editingId || crypto.randomUUID(),
    title: $("#titleField").value.trim(),
    defaultVariantTitle: $("#defaultVariantTitleField").value.trim() || "默认版本",
    content: $("#contentField").value.trim(),
    usageNote: $("#usageNoteField").value.trim(),
    tags: editorTags(),
    images: [...pendingImages],
    favorite: existing?.favorite || false,
    useCount: existing?.useCount || 0,
    lastUsed: existing?.lastUsed,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    variants: pendingVariants.map((variant, index) => ({
      ...variant,
      id: variant.id || crypto.randomUUID(),
      title: variant.title.trim() || `变体 ${index + 1}`,
      content: variant.content.trim(),
      useCount: variant.useCount || 0,
      createdAt: variant.createdAt || now,
      updatedAt: now
    })).filter((variant) => variant.content)
  };
  if (!next.title || !next.content) return;
  if (existing) Object.assign(existing, next); else state.prompts.unshift(next);
  selectedId = next.id;
  await persist();
  $("#editorDialog").close();
  renderAll();
  toast(existing ? "Prompt 已更新" : "Prompt 已创建");
});
$("#recordShortcutBtn").addEventListener("click", () => {
  recordingShortcut = "global";
  $("#newPromptShortcutField").value = state.settings.newPromptShortcut || DEFAULT_NEW_SHORTCUT;
  $("#shortcutField").value = "请按下组合键…";
  $("#shortcutHint").textContent = IS_MAC ? "至少包含 ⌘、⌥、⇧ 或 ⌃ 中的一个。" : "至少包含 Ctrl、Alt、Shift 或 Win 中的一个。";
  $("#shortcutHint").classList.remove("error");
});
$("#recordNewPromptShortcutBtn").addEventListener("click", () => {
  recordingShortcut = "newPrompt";
  $("#shortcutField").value = state.settings.shortcut;
  $("#newPromptShortcutField").value = "请按下组合键…";
  $("#newPromptShortcutHint").textContent = "仅在 Prompt Dock 当前可操作时生效。";
  $("#newPromptShortcutHint").classList.remove("error");
});
$("#chooseBackupDirectoryBtn").addEventListener("click", async () => {
  const result = await window.promptDock.chooseBackupDirectory();
  if (result.canceled) return;
  $("#backupDirectoryField").value = result.directory;
  refreshBackupStatus();
});
$("#backupDirectoryField").addEventListener("change", refreshBackupStatus);
$("#backupNowBtn").addEventListener("click", async () => {
  const directory = $("#backupDirectoryField").value.trim();
  const result = await window.promptDock.runBackupNow(directory);
  if (!result.ok) {
    toast(result.message || "备份失败");
    return;
  }
  state.settings.backupDirectory = directory;
  state.settings.lastBackupAt = result.at;
  await refreshBackupStatus();
  toast("备份已完成");
});
$("#clearCacheBtn").addEventListener("click", async () => {
  const button = $("#clearCacheBtn");
  button.disabled = true;
  const result = await window.promptDock.clearCache();
  button.disabled = false;
  $("#cacheStatus").textContent = formatBytes(result.bytes || 0);
  toast("临时缓存已清理，Prompt 和图片未受影响");
});
window.addEventListener("keydown", (event) => {
  if (recordingShortcut) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      $("#shortcutField").value = state.settings.shortcut;
      $("#newPromptShortcutField").value = state.settings.newPromptShortcut || DEFAULT_NEW_SHORTCUT;
      recordingShortcut = null;
      return;
    }
    const accelerator = eventToAccelerator(event);
    if (accelerator) {
      const field = recordingShortcut === "global" ? $("#shortcutField") : $("#newPromptShortcutField");
      const hint = recordingShortcut === "global" ? $("#shortcutHint") : $("#newPromptShortcutHint");
      field.value = accelerator;
      hint.textContent = `已录制：${displayAccelerator(accelerator)}`;
      recordingShortcut = null;
    }
    return;
  }
  if (!event.repeat && !document.querySelector("dialog[open]")
    && eventMatchesAccelerator(event, state.settings.newPromptShortcut || DEFAULT_NEW_SHORTCUT)) {
    event.preventDefault();
    openNewPrompt();
    return;
  }
  if ((IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey && !event.shiftKey
    && event.key.toLocaleLowerCase() === "k" && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    const field = appMode === "vocabulary" ? $("#vocabularySearchInput") : $("#searchInput");
    field.focus({ preventScroll: true });
    field.select();
    return;
  }
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
    if (batchMode) setBatchMode(false);
    else if (appMode === "vocabulary" && $("#vocabularySearchInput").value) {
      $("#vocabularySearchInput").value = "";
      renderVocabulary();
    }
    else if ($("#searchInput").value) {
      $("#searchInput").value = "";
      renderList();
    } else if (state.settings.compactMode && compactSidebarOpen) setCompactSidebarOpen(false);
    else window.promptDock.hide();
  }
  if (event.key === "Enter" && document.activeElement === $("#searchInput")) {
    const first = filteredPrompts()[0];
    if (first && batchMode) {
      if (batchSelection.has(first.id)) batchSelection.delete(first.id); else batchSelection.add(first.id);
      renderList();
    } else if (first) selectPrompt(first.id);
  }
  if (event.key === "Enter" && document.activeElement === $("#vocabularySearchInput")) {
    const first = visibleVocabularyEntries()[0];
    if (first) handleVocabularyWordClick(first.id, $("[data-vocabulary-id='" + CSS.escape(first.id) + "']"));
  }
});
$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const shortcut = $("#shortcutField").value;
  const newPromptShortcut = normalizeAccelerator($("#newPromptShortcutField").value);
  const newPromptShortcutError = validateNewPromptShortcut(newPromptShortcut, shortcut);
  if (newPromptShortcutError) {
    $("#newPromptShortcutHint").textContent = newPromptShortcutError;
    $("#newPromptShortcutHint").classList.add("error");
    return;
  }
  const result = await window.promptDock.setShortcut(shortcut);
  if (!result.ok) {
    $("#shortcutHint").textContent = result.message;
    $("#shortcutHint").classList.add("error");
    return;
  }
  state.settings.shortcut = shortcut;
  state.settings.newPromptShortcut = newPromptShortcut;
  state.settings.alwaysOnTop = state.settings.compactMode ? true : $("#alwaysOnTopField").checked;
  state.settings.privacyHideImages = $("#privacyHideImagesField").checked;
  const previousBackupDirectory = state.settings.backupDirectory || "";
  state.settings.backupDirectory = $("#backupDirectoryField").value.trim();
  await window.promptDock.setAlwaysOnTop(state.settings.alwaysOnTop);
  await persist();
  if (state.settings.backupDirectory && state.settings.backupDirectory !== previousBackupDirectory) {
    const backup = await window.promptDock.runBackupNow(state.settings.backupDirectory);
    if (!backup.ok) {
      $("#shortcutHint").textContent = `备份路径不可用：${backup.message}`;
      $("#shortcutHint").classList.add("error");
      return;
    }
    state.settings.lastBackupAt = backup.at;
  }
  $("#settingsDialog").close();
  renderAll();
  toast("设置已保存");
});
$("#exportBtn").addEventListener("click", async () => {
  const result = await window.promptDock.exportData();
  if (result.error) return toast(result.error);
  if (!result.canceled) toast(".promptdock 已导出");
});
$("#importBtn").addEventListener("click", async () => {
  const result = await window.promptDock.importData();
  if (result.error) return toast(result.error);
  if (!result.canceled) {
    if (batchMode) setBatchMode(false);
    state = result.state;
    selectedId = null;
    renderAll();
    const summary = result.summary || {};
    const vocabularyPart = summary.vocabularyEntriesAdded ? ` · 词条 ${summary.vocabularyEntriesAdded}` : "";
    const message = `新增 ${summary.added || 0} · 更新 ${summary.updated || 0} · 去重 ${summary.deduplicated || 0} · 跳过 ${summary.skipped || 0} · 冲突 ${summary.conflicts || 0}${vocabularyPart}`;
    $("#importResult").textContent = message;
    $("#importResult").classList.remove("hidden");
    refreshBackupStatus();
    toast("导入合并完成");
  }
});
window.promptDock.onFocusSearch(() => {
  const field = appMode === "vocabulary" ? $("#vocabularySearchInput") : $("#searchInput");
  field.focus();
  field.select();
});
document.addEventListener("pointerdown", (event) => {
  if (state.settings.compactMode && compactSidebarOpen
    && !event.target.closest(".sidebar")
    && !event.target.closest("#toggleLeftBtn")) {
    setCompactSidebarOpen(false);
  }
});
document.addEventListener("scroll", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.classList) return;
  target.classList.add("is-scrolling");
  clearTimeout(scrollFadeTimers.get(target));
  scrollFadeTimers.set(target, setTimeout(() => target.classList.remove("is-scrolling"), 700));
}, true);
bindPaneResizer("left");
bindPaneResizer("right");

window.addEventListener("resize", () => {
  applyPaneWidths();
  if (!state?.settings?.compactMode) return;
  clearTimeout(compactSizeSaveTimer);
  compactSizeSaveTimer = setTimeout(async () => {
    if (!state?.settings?.compactMode) return;
    const bounds = await window.promptDock.getWindowBounds();
    state.settings.compactWindowSize = { width: bounds.width, height: bounds.height };
    await persist();
  }, 250);
});

(async function init() {
  const [loadedState, migration] = await Promise.all([
    window.promptDock.getState(),
    window.promptDock.getMigrationInfo()
  ]);
  state = loadedState;
  renderAll();
  if (migration?.performed) toast("数据已安全升级，旧版完整备份已保留");
})();
