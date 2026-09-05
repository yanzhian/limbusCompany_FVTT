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

// 三张素材都走 <img>：加载失败时能在控制台报出来，不会像 CSS 背景图那样静默消失
const CLOCK_IMG = "systems/limbusCompany_FVTT/assets/icons/GUI/turn_clock.webp";
const LINE_IMG  = "systems/limbusCompany_FVTT/assets/icons/GUI/turn_line.webp";
const WORD_IMG  = "systems/limbusCompany_FVTT/assets/icons/GUI/turn_word.webp";

/** 与 CSS 里最后那条注释保持一致：整段动画跑完需要多久（ms） */
const TOTAL_MS = 1280;

/** 回合开始音效：和横幅同时起，本地播放（各端自己触发，不广播） */
const TURN_SFX = "systems/limbusCompany_FVTT/assets/audio/turn.wav";

let _timer = null;

/** 播一次回合音效；音频未就绪或被浏览器拦截时静默失败 */
function _playTurnSfx() {
  try {
    const helper = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
    helper?.play?.({ src: TURN_SFX, volume: 0.7, autoplay: true, loop: false }, false);
  } catch (err) { /* 忽略：音效不该影响演出 */ }
}

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
    <div class="lc-tb-clock">
      <img src="${CLOCK_IMG}" alt="" draggable="false"
           onerror="console.warn('[limbus] 回合横幅：钟表素材加载失败', this.src);
                    this.closest('.lc-tb-clock').style.visibility='hidden'">
    </div>
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
  _playTurnSfx();
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
