/**
 * linkify.mjs — 物品描述文本自动替换核心逻辑
 *
 * 三种记号各管各的：
 *   【XXX】 → BUFF 图标+名字的可悬停 chip（悬停显示 BUFF Title 卡）
 *   "XXX"  → 物品引用的可悬停 chip（悬停按名字搜索世界物品/合集包，显示物品 Title 卡）
 *   [XXX]  → 触发时机静态标签（按类别着色，不可悬停搜索）
 *
 * 独立成模块（而非只做成 Handlebars helper）是因为 item-sheet.mjs 里手工拼装
 * HTML 字符串构建的 Title 卡（buildItemTitleCard/buildBuffTitleCard）也要用到
 * 同一份逻辑；两处共用同一个函数，避免维护两份正则。
 *
 * 用 DOM TreeWalker 只处理文本节点（而非对整段 HTML 字符串做正则替换），
 * 避免匹配到标签属性里本来就存在的双引号（class="..."/style="..." 等），
 * 那样会把属性值当成"物品名"误替换，破坏原有 HTML 结构。
 */

const TRIGGER_COLORS = { "激活": "blue", "拼点胜利": "orange", "拼点失败": "red" };

/**
 * @param {string} raw  原始 HTML（通常来自 ProseMirror 富文本字段）
 * @returns {string} 替换后的 HTML 字符串
 */
export function linkifyHtml(raw) {
  const s = String(raw ?? "");
  if (!s.trim()) return s;

  const triggerSet = new Set([...(CONFIG.LIMBUSCOMPANY?.ACTIVITY_TRIGGERS ?? []), "激活"]);
  const pattern = /【([^【】]+)】|"([^"]+)"|\[([^\[\]]+)\]/g;

  const container = document.createElement("div");
  container.innerHTML = s;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const textNode of textNodes) {
    const text = textNode.nodeValue;
    if (!/[【"\[]/.test(text)) continue; // 快速跳过不含任何目标符号的文本节点

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(text))) {
      if (m.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));

      if (m[1] !== undefined) {
        const span = document.createElement("span");
        span.className = "desc-buff-chip";
        span.dataset.buffName = m[1];
        span.textContent = `【${m[1]}】`;
        frag.appendChild(span);
      } else if (m[2] !== undefined) {
        const span = document.createElement("span");
        span.className = "desc-item-chip";
        span.dataset.itemName = m[2];
        span.textContent = `"${m[2]}"`;
        frag.appendChild(span);
      } else {
        const trimmed = m[3].trim();
        if (triggerSet.has(trimmed)) {
          const span = document.createElement("span");
          span.className = `desc-trigger-chip trigger-${TRIGGER_COLORS[trimmed] ?? "green"}`;
          span.textContent = `[${m[3]}]`;
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(m[0])); // 未知方括号内容：原样保留
        }
      }
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    textNode.parentNode.replaceChild(frag, textNode);
  }

  return container.innerHTML;
}
