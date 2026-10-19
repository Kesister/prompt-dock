// Pure search/settings logic shared by the controller and regression tests.
const normalize = value => String(value || "").normalize("NFKC").toLocaleLowerCase().trim();
const defaults = { enabled: false, shortcut: "Control+Alt+Space", confirm: "Tab" };
function settings(value = {}) {
  if (!value || typeof value !== "object") value = {};
  // Keep the existing settings key and shortcut; obsolete trigger/scope fields are ignored.
  return { enabled: value.enabled === true,
    shortcut: typeof value.shortcut === "string" ? value.shortcut.trim() : defaults.shortcut,
    confirm: value.confirm === "Enter" ? "Enter" : "Tab" };
}
function search(prompts, query, limit = 7) {
  const q = normalize(query), tokens = q.match(/[\p{L}\p{N}]+/gu) || [];
  return prompts.filter(p => !p.deletedAt).map(p => {
    const fields = [[p.alias, 30], [p.title, 16], [(p.tags || []).join(" "), 12], [p.usageNote, 7], [p.content, 5],
      [(p.variants || []).map(v => `${v.title} ${v.content}`).join(" "), 6]].map(([v, w]) => [normalize(v), w]);
    let score = 0;
    for (const token of tokens) {
      const best = Math.max(0, ...fields.map(([v, w]) => v.includes(token) ? w + (v.startsWith(token) ? 3 : 0) : 0));
      if (!best) return null;
      score += best;
    }
    if (q && normalize(p.alias) === q) score += 100;
    return { p, score };
  }).filter(Boolean).sort((a,b) => b.score - a.score || Number(b.p.favorite) - Number(a.p.favorite)
    || String(b.p.lastUsed || "").localeCompare(String(a.p.lastUsed || "")) || (b.p.useCount || 0) - (a.p.useCount || 0))
    .slice(0, limit).map(({p}) => ({ id: p.id, title: p.title, alias: p.alias || "", tags: p.tags || [],
      summary: String(p.content || "").replace(/\s+/g, " ").slice(0, 90),
      variants: [{ id: "default", title: p.defaultVariantTitle || "默认版本" }, ...(p.variants || []).map(v => ({ id:v.id, title:v.title }))] }));
}
module.exports = { defaults, settings, search };
