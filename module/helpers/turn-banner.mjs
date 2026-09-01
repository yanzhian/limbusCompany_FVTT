/**
 * turn-banner.mjs —— 回合开始横幅
 *
 * 演出顺序（总时长见 CSS 末尾注释）：
 *   ① 黑条纵向展开 → ② 钟淡入、由大缩到正常并定住 → ③ 红线与 TURN、回合数出现
 *   → ④ 钟逆时针摆一下回正 → 整体淡出
 *
 * 纯 DOM + CSS 动画，挂在 body 上；播完自动移除。每个客户端各自播放
 * （由 updateCombat 钩子在各端触发），不走 socket。
 */

// 素材路径。钟走 CSS 背景图（见 styles 里的 .lc-tb-clock），
// 红线与 TURN 是 <img>，路径写在这里；缺图时该元素自动隐藏，其余照常播。
const LINE_IMG = "systems/limbusCompany_FVTT/assets/icons/GUI/turn_line.webp";
const WORD_IMG = "systems/limbusCompany_FVTT/assets/icons/GUI/turn_word.webp";

/** 与 CSS 里最后那条注释保持一致：整段动画跑完需要多久（ms） */
const TOTAL_MS = 1280;

let _timer = null;

/**
 * 播一次回合横幅。
 * @param {number} round 回合数（显示在 TURN 右侧）
 */
export function playTurnBanner(round) {
  // 上一条还没播完就又来一条：直接顶掉，避免叠在一起
  document.querySelectorAll(".lc-turn-banner").forEach(el => el.remove());
  clearTimeout(_timer);

  const el = document.createElement("div");
  el.className = "lc-turn-banner";
  el.innerHTML = `
    <div class="lc-tb-band"></div>
    <div class="lc-tb-clock"></div>
    <div class="lc-tb-line">
      <img src="${LINE_IMG}" alt="" draggable="false"
           onerror="this.closest('.lc-tb-line').style.visibility='hidden'">
    </div>
    <div class="lc-tb-text">
      <span class="lc-tb-word">
        <img src="${WORD_IMG}" alt="TURN" draggable="false"
             onerror="this.closest('.lc-tb-word').style.visibility='hidden'">
      </span>
      <span class="lc-tb-num">${Number(round) || 1}</span>
    </div>`;
  document.body.appendChild(el);

  // 先入 DOM 再加 play：否则动画的第一帧可能被跳过
  requestAnimationFrame(() => el.classList.add("play", "show"));
  _timer = setTimeout(() => el.remove(), TOTAL_MS + 80);
}

/**
 * 注册钩子：遭遇战开始、以及每次轮次推进时播放。
 * 各客户端自己判断，不需要 socket 广播。
 */
export function registerTurnBanner() {
  Hooks.on("updateCombat", (combat, changed) => {
    if (!combat?.started) return;
    if (changed?.round === undefined) return;      // 只在轮次变化时播
    if ((changed.round ?? 0) < 1) return;
    playTurnBanner(changed.round);
  });

  // 遭遇战刚开始（第 1 轮）：updateCombat 不一定带 round，单独兜一次
  Hooks.on("combatStart", (combat) => {
    if (!combat) return;
    playTurnBanner(combat.round || 1);
  });
}
