/**
 * rulebook.mjs —— 规则书入口
 *
 * 在 Foundry 的【设置】侧边栏加一块「郊区幸存者」区，放两个按钮：
 *   · 规则书 —— 打开随系统分发的 docs/rulebook.html（新标签页）
 *   · 在线版 —— 打开托管在外部的同一份规则书
 *
 * 为什么本地那份是主入口：随系统走、跟着版本一起更新、不需要账号也不怕断网，
 * 玩家点一下就能看。在线版只是备用（换设备、手机上翻）。
 */

/** 随系统分发的规则书；相对路径由 Foundry 的静态文件服务直接提供 */
const LOCAL_PATH = "systems/limbusCompany_FVTT/docs/rulebook.html";

/**
 * 在线版地址。留空则不显示【在线版】按钮。
 * 注意：这个链接是否对玩家可见，取决于它在托管方那边的分享设置——
 * 没有公开分享的话，玩家点开会是"无权访问"。
 */
const ONLINE_URL = "https://claude.ai/code/artifact/610b6ce0-7722-48ac-b648-8692a436cd49";

/** 打开随系统分发的规则书 */
export function openRulebook() {
  window.open(LOCAL_PATH, "_blank", "noopener");
}

/** 打开在线版 */
export function openRulebookOnline() {
  if (!ONLINE_URL) return openRulebook();
  window.open(ONLINE_URL, "_blank", "noopener");
}

/**
 * 往【设置】侧边栏塞一块自己的按钮区。
 *
 * v13 的设置侧边栏是 ApplicationV2，渲染钩子给的是 HTMLElement；
 * 老版本给的是 jQuery。两种都兜住，免得换版本就静默不显示。
 */
function _injectSettingsButtons(app, html) {
  const root = html?.[0] ?? html;                 // jQuery → 原生元素
  if (!(root instanceof HTMLElement)) return;
  if (root.querySelector(".limbus-rulebook-block")) return;   // 重渲染时别插两遍

  const block = document.createElement("div");
  block.className = "limbus-rulebook-block";
  block.innerHTML = `
    <h4 class="divider">郊区幸存者</h4>
    <button type="button" data-action="limbus-rulebook">
      <i class="fas fa-book-open"></i> 规则书
    </button>
    ${ONLINE_URL ? `
    <button type="button" data-action="limbus-rulebook-online">
      <i class="fas fa-arrow-up-right-from-square"></i> 规则书（在线版）
    </button>` : ""}
  `;

  block.querySelector('[data-action="limbus-rulebook"]')
    ?.addEventListener("click", openRulebook);
  block.querySelector('[data-action="limbus-rulebook-online"]')
    ?.addEventListener("click", openRulebookOnline);

  // 优先插在「文档 / 帮助」那一块前面；找不到锚点就挂到末尾，
  // 总之不能因为 Foundry 改了侧边栏结构就整块消失。
  const anchor = root.querySelector("#settings-documentation")
              ?? root.querySelector(".settings-documentation")
              ?? root.querySelector("#settings-access");
  if (anchor) anchor.before(block);
  else root.append(block);
}

/** 注册入口：设置侧边栏按钮 + 快捷键 */
export function registerRulebook() {
  Hooks.on("renderSettings", _injectSettingsButtons);

  game.keybindings.register("limbusCompany_FVTT", "openRulebook", {
    name: "打开规则书",
    hint: "在新标签页打开随系统分发的规则书",
    editable: [{ key: "F1" }],
    onDown: () => { openRulebook(); return true; },
  });
}
