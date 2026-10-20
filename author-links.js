// Fixed, user-approved destinations. The renderer passes an ID, never a URL.
const AUTHOR_LINKS = Object.freeze({
  github: "https://github.com/Kesister",
  feedback: "https://kersss.notion.site/5cc968f36d944b1ab59abe70202e5147?source=copy_link"
});

function resolveAuthorLink(id) {
  return typeof id === "string" && Object.hasOwn(AUTHOR_LINKS, id) ? AUTHOR_LINKS[id] : null;
}

function authorInfo(version, platform, release, arch) {
  const system = ({ win32: "Windows", darwin: "macOS", linux: "Linux" })[platform] || platform;
  return { version, links: AUTHOR_LINKS, feedbackInfo: `Prompt Dock v${version}\n系统：${system} ${release} (${arch})` };
}

module.exports = { AUTHOR_LINKS, resolveAuthorLink, authorInfo };
