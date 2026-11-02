/* =====================================================================
   Prompt Dock · motion.js —— 过渡动画辅助脚本
   ---------------------------------------------------------------------
   放在 renderer.js 之前加载：<script src="motion.js"></script>
   只做“表现层”的事情，不读写应用状态：
   1. 启动静音：读到设置、首次布局完成前不播放任何过渡
   2. 右栏：动画期间冻结预览区宽度（滑入/滑出时内容不被挤压重排）
   3. 拖动窗口边缘时临时关闭网格补间
   4. windowMorph()：标准窗口 ⇄ 小窗切换时“淡出 → 改尺寸 → 淡入”
   5. 标签树展开/收起的高度动画（标签树是整段重绘的，CSS 过渡无法生效）
   6. 切换筛选 / 排序 / 词库分组时列表轻微淡入
   对外暴露：window.PromptDockMotion = { windowMorph, isReady }
   ===================================================================== */
(() => {
  "use strict";

  const PANE_MS = 320;          // 与 motion.css 的 --motion-pane 保持一致
  const MORPH_OUT_MS = 100;
  const MORPH_IN_MS = 260;
  const EASE_OUT = "cubic-bezier(.22, 1, .36, 1)";
  const EASE_DRAWER = "cubic-bezier(.32, .72, 0, 1)";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const narrowLayout = window.matchMedia("(max-width: 900px)");

  let shell = null;
  let ready = false;
  let lastRightCollapsed = null;
  let lastVocabularyMode = null;
  let viewSwitchFrame = false;
  let freezeWidth = 0;
  let freezeTimer = 0;
  let resizeTimer = 0;
  let morphChain = Promise.resolve();
  let morphToken = 0;
  let pendingTagToggle = null;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextFrame = () => Promise.race([
    new Promise((resolve) => requestAnimationFrame(() => resolve())),
    wait(64),
  ]);
  const canAnimate = () => ready && !reduceMotion.matches;
  const isShown = (element) => Boolean(element && element.isConnected && element.getClientRects().length);

  /* ---------- 1. 启动静音 ---------- */
  function markReady() {
    if (ready || !shell) return;
    void shell.offsetWidth; // 在静音状态下按最终状态完成一次样式计算
    document.body.classList.remove("motion-booting");
    ready = true;
  }

  function scheduleReady() {
    requestAnimationFrame(() => requestAnimationFrame(markReady));
  }

  /* ---------- 2. 右栏 ---------- */
  // 用户拖过右栏宽度时（--right-pane-track 为像素值），收起轨道必须也是像素值才能插值
  function syncCollapsedTrack() {
    const custom = shell.style.getPropertyValue("--right-pane-track").trim();
    const current = shell.style.getPropertyValue("--right-pane-track-collapsed").trim();
    const wanted = custom ? "0px" : "";
    if (wanted === current) return;
    if (wanted) shell.style.setProperty("--right-pane-track-collapsed", wanted);
    else shell.style.removeProperty("--right-pane-track-collapsed");
  }

  // 展开后的预览区宽度（与 styles.css 的网格定义一致）
  function expectedPreviewWidth() {
    const custom = parseFloat(shell.style.getPropertyValue("--right-pane-track"));
    if (custom > 0) return custom;
    const leftTrack = parseFloat(getComputedStyle(shell).getPropertyValue("--left-pane-track")) || 190;
    const left = shell.classList.contains("left-collapsed") ? 0 : leftTrack + 6;
    const available = Math.max(0, shell.clientWidth - left - 6);
    const fr = available / 1.92;
    if (fr < 350) return Math.max(330, available - 350);
    return Math.max(330, fr * 0.92);
  }

  function clearPreviewFreeze() {
    clearTimeout(freezeTimer);
    freezeWidth = 0;
    if (!shell) return;
    shell.classList.remove("right-pane-animating");
    shell.style.removeProperty("--preview-freeze-width");
  }

  function animateRightPane(collapsing) {
    if (!canAnimate()
      || narrowLayout.matches
      || document.body.classList.contains("motion-instant")
      || document.body.classList.contains("pane-resizing")
      || shell.classList.contains("compact-mode")
      || shell.classList.contains("vocabulary-mode")) {
      clearPreviewFreeze();
      return;
    }
    const preview = shell.querySelector(".preview");
    if (!preview) return;
    let width;
    if (collapsing) {
      if (shell.classList.contains("right-pane-animating") && freezeWidth > 0) {
        width = freezeWidth; // 展开到一半又收起：沿用完整宽度
      } else {
        shell.style.removeProperty("--preview-freeze-width");
        width = preview.getBoundingClientRect().width; // 过渡起点 = 收起前的宽度
      }
    } else {
      width = expectedPreviewWidth();
    }
    freezeWidth = Math.max(0, Math.floor(width));
    if (!freezeWidth) {
      clearPreviewFreeze();
      return;
    }
    shell.style.setProperty("--preview-freeze-width", `${freezeWidth}px`);
    shell.classList.add("right-pane-animating");
    clearTimeout(freezeTimer);
    freezeTimer = setTimeout(clearPreviewFreeze, PANE_MS + 140);
  }

  function onShellMutation() {
    syncCollapsedTrack();
    if (!ready && shell.style.getPropertyValue("--left-pane-track")) scheduleReady();

    const vocabularyMode = shell.classList.contains("vocabulary-mode");
    if (lastVocabularyMode !== null && vocabularyMode !== lastVocabularyMode) {
      viewSwitchFrame = true; // 视图本身在淡入，这一帧不再叠加列表动画
      requestAnimationFrame(() => { viewSwitchFrame = false; });
    }
    lastVocabularyMode = vocabularyMode;

    const rightCollapsed = shell.classList.contains("right-collapsed");
    if (lastRightCollapsed !== null && rightCollapsed !== lastRightCollapsed) animateRightPane(rightCollapsed);
    lastRightCollapsed = rightCollapsed;
  }

  /* ---------- 3. 拖动窗口边缘 ---------- */
  function onWindowResize() {
    document.body.classList.add("window-resizing");
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => document.body.classList.remove("window-resizing"), 180);
  }

  /* ---------- 4. 标准窗口 ⇄ 小窗 ---------- */
  function waitForWindowSettle(before) {
    return new Promise((resolve) => {
      let quietTimer = 0;
      const finish = () => {
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        window.removeEventListener("resize", onResize);
        resolve();
      };
      const onResize = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 40); // macOS 的 setBounds 动画会连续触发 resize，等它停下
      };
      const maxTimer = setTimeout(finish, 900);
      window.addEventListener("resize", onResize);
      if (window.innerWidth !== before.width || window.innerHeight !== before.height) onResize();
      else quietTimer = setTimeout(finish, 180);
    });
  }

  /**
   * 包裹一次“改变窗口尺寸 + 应用布局”的操作：
   * 内容先淡出，task 执行期间布局瞬时完成，窗口尺寸稳定后再淡入。
   * task 抛错时同样会恢复显示，错误照常抛给调用方。
   */
  function windowMorph(task) {
    const run = async () => {
      if (!canAnimate() || !shell) return task();
      const token = ++morphToken;
      const classes = document.body.classList;
      classes.remove("morph-in");
      classes.add("window-morphing", "morph-out");
      try {
        await wait(MORPH_OUT_MS + 20);
        classes.add("motion-instant");
        const before = { width: window.innerWidth, height: window.innerHeight };
        const result = await task();
        await waitForWindowSettle(before);
        await nextFrame();
        return result;
      } finally {
        void shell.offsetWidth; // 在 motion-instant 下落定最终布局
        classes.remove("motion-instant", "morph-out");
        classes.add("morph-in");
        try {
          // Keep the caller's switching lock through the incoming fade/settle.
          await wait(MORPH_IN_MS + 120);
        } finally {
          if (token === morphToken) classes.remove("window-morphing", "morph-in");
        }
      }
    };
    const job = morphChain.then(run, run);
    morphChain = job.catch(() => {});
    return job;
  }

  /* ---------- 5. 标签树 ---------- */
  function onTagToggleCapture(event) {
    const toggle = event.target instanceof Element ? event.target.closest("[data-tag-toggle]") : null;
    if (!toggle || !canAnimate()) return;
    const group = toggle.closest(".tag-tree-group");
    const children = group ? group.querySelector(".tag-tree-children") : null;
    const wasOpen = isShown(children);
    pendingTagToggle = {
      key: toggle.dataset.tagToggle,
      wasOpen,
      ghost: wasOpen ? children.cloneNode(true) : null,
      height: wasOpen ? children.getBoundingClientRect().height : 0,
      at: performance.now(),
    };
  }

  function expandBlock(element) {
    const style = getComputedStyle(element);
    const height = element.getBoundingClientRect().height;
    element.style.overflow = "hidden";
    const animation = element.animate([
      { height: "0px", marginTop: "0px", marginBottom: "0px", opacity: 0, transform: "translateY(-4px)" },
      { height: `${height}px`, marginTop: style.marginTop, marginBottom: style.marginBottom, opacity: 1, transform: "none" },
    ], { duration: 260, easing: EASE_DRAWER });
    animation.finished.catch(() => {}).then(() => { element.style.overflow = ""; });
  }

  function collapseGhost(group, children, ghost, height) {
    ghost.classList.add("motion-ghost");
    ghost.classList.remove("hidden");
    ghost.hidden = false;
    ghost.inert = true;
    ghost.setAttribute("aria-hidden", "true");
    ghost.removeAttribute("id");
    ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    if (children) children.before(ghost); else group.append(ghost);
    ghost.style.overflow = "hidden";
    const style = getComputedStyle(ghost);
    const animation = ghost.animate([
      { height: `${height}px`, marginTop: style.marginTop, marginBottom: style.marginBottom, opacity: 1 },
      { height: "0px", marginTop: "0px", marginBottom: "0px", opacity: 0 },
    ], { duration: 220, easing: EASE_DRAWER, fill: "forwards" });
    animation.finished.catch(() => {}).then(() => ghost.remove());
  }

  function onTagListMutation() {
    const pending = pendingTagToggle;
    pendingTagToggle = null;
    if (!pending || performance.now() - pending.at > 600 || !canAnimate()) return;
    const toggle = [...document.querySelectorAll("#tagList [data-tag-toggle]")]
      .find((element) => element.dataset.tagToggle === pending.key);
    if (!toggle) return;
    const group = toggle.closest(".tag-tree-group");
    const children = group ? group.querySelector(".tag-tree-children") : null;
    const nowOpen = isShown(children);
    if (nowOpen === pending.wasOpen) return;
    const icon = toggle.querySelector("svg");
    if (icon) {
      icon.animate([
        { transform: pending.wasOpen ? "rotate(0deg)" : "rotate(-90deg)" },
        { transform: nowOpen ? "rotate(0deg)" : "rotate(-90deg)" },
      ], { duration: 240, easing: EASE_OUT });
    }
    if (nowOpen) expandBlock(children);
    else if (pending.ghost && group) collapseGhost(group, children, pending.ghost, pending.height);
  }

  /* ---------- 6. 列表切换淡入 ---------- */
  function fadeInList(...candidates) {
    if (!canAnimate() || viewSwitchFrame) return;
    const target = candidates.map((id) => document.getElementById(id)).find(isShown);
    if (!target) return;
    target.getAnimations().forEach((animation) => animation.cancel());
    target.animate([
      { opacity: 0, transform: "translateY(6px)" },
      { opacity: 1, transform: "none" },
    ], { duration: 240, easing: EASE_OUT });
  }

  function watchText(id, onChange) {
    const element = document.getElementById(id);
    if (!element) return;
    let last = element.textContent;
    new MutationObserver(() => {
      const text = element.textContent;
      if (text === last) return;
      last = text;
      onChange();
    }).observe(element, { childList: true, characterData: true, subtree: true });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    shell = document.querySelector(".app-shell");
    if (!shell || !document.body) return;
    document.body.classList.add("motion-booting");
    setTimeout(markReady, 3000); // 兜底：状态迟迟没加载也要恢复动画

    new MutationObserver(onShellMutation).observe(shell, { attributes: true, attributeFilter: ["class", "style"] });
    onShellMutation();

    // capture：保证先于 renderer.js 的 resize 监听执行（它会在 resize 时重算左右栏宽度）
    window.addEventListener("resize", onWindowResize, true);

    document.addEventListener("click", onTagToggleCapture, true);
    const tagList = document.getElementById("tagList");
    if (tagList) new MutationObserver(onTagListMutation).observe(tagList, { childList: true });

    watchText("viewTitle", () => fadeInList("promptList", "emptyState"));
    watchText("sortMenuLabel", () => fadeInList("promptList", "emptyState"));
    watchText("vocabularyViewTitle", () => fadeInList("vocabularyWords"));
  }

  window.PromptDockMotion = { windowMorph, isReady: () => ready };

  if (document.querySelector(".app-shell")) init();
  else document.addEventListener("DOMContentLoaded", init, { once: true });
})();
