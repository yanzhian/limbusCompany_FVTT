/**
 * chaos-token-label.mjs — 【陷入混乱】token 悬浮字样
 *
 * 给场上所有处于【陷入混乱/+/++】状态的 token 在其中心叠一行大字，
 * 提示该单位当前正处于混乱（物理抗性大幅提升、行动值已清零）。
 *
 * 实现要点：标签是普通 HTML 元素，挂进 Foundry 的 `#hud` 层。`#hud` 由
 * `canvas.hud.align()` 跟随画布平移/缩放做 left/top/transform 同步，因此这里
 * 只需要用「画布坐标」定位，平移缩放会自动跟随，样式也就能交给 CSS 处理。
 */

export class ChaosTokenLabel {
  /** 标签容器（#hud 的子节点） */
  static _layer = null;

  /** 注册钩子（在 Hooks.once("ready") 中调用一次） */
  static init() {
    Hooks.on("canvasReady",  () => ChaosTokenLabel.refresh());
    Hooks.on("createToken",  () => ChaosTokenLabel.refresh());
    Hooks.on("deleteToken",  () => ChaosTokenLabel.refresh());
    // token 移动/缩放/隐藏后重新贴合
    Hooks.on("refreshToken", () => ChaosTokenLabel.refresh());
    // BUFF 变化在 actor 上，更新后重画
    Hooks.on("updateActor",  (_actor, changed) => {
      if (foundry.utils.hasProperty(changed, "system.buffs")) ChaosTokenLabel.refresh();
    });
  }

  /** 取得（必要时创建）标签容器 */
  static _getLayer() {
    if (this._layer?.isConnected) return this._layer;
    const hud = document.getElementById("hud");
    if (!hud) return null;
    const el = document.createElement("div");
    el.id = "limbus-chaos-labels";
    hud.appendChild(el);
    this._layer = el;
    return el;
  }

  /** 该 token 当前的混乱等级名（未混乱返回 ""） */
  static _chaosName(token) {
    const buffs = token?.actor?.system?.buffs ?? [];
    const types = CONFIG.LIMBUSCOMPANY?.CHAOS_TYPES ?? ["chaos", "chaos_plus", "chaos_double_plus"];
    const names = CONFIG.LIMBUSCOMPANY?.CHAOS_NAMES ?? ["陷入混乱", "陷入混乱+", "陷入混乱++"];
    // whenAdded === "下回合" 的尚未生效；"延续回合" 仍在生效中
    let level = 0;
    for (const b of buffs) {
      if (b.whenAdded === "下回合") continue;
      const idx = types.indexOf(b.type);
      if (idx >= 0) level = Math.max(level, idx + 1);
    }
    return level > 0 ? (names[level - 1] ?? "陷入混乱") : "";
  }

  /** 重绘全部标签 */
  static refresh() {
    const layer = this._getLayer();
    if (!layer) return;
    if (!canvas?.ready) { layer.replaceChildren(); return; }

    const frag = document.createDocumentFragment();
    for (const token of canvas.tokens?.placeables ?? []) {
      if (!token.visible || token.document?.hidden && !game.user.isGM) continue;
      const name = ChaosTokenLabel._chaosName(token);
      if (!name) continue;

      const el = document.createElement("div");
      el.className = "limbus-chaos-label";
      el.textContent = name;
      // 画布坐标定位；字号随 token 大小走，缩放由 #hud 的 transform 负责
      el.style.left     = `${token.x + token.w / 2}px`;
      el.style.top      = `${token.y + token.h / 2}px`;
      el.style.fontSize = `${Math.max(12, Math.round(token.w * 0.2))}px`;
      frag.appendChild(el);
    }
    layer.replaceChildren(frag);
  }
}
