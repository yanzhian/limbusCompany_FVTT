/**
 * clash-total-fx.mjs — 拼点 TOTAL 演出
 *
 * 双方确定技能、正式开骰时的全屏演出：
 *   ① 两条倾斜黑条切入（进攻方左下由下往上，防守方右上由上往下）
 *   ② 数字疯狂滚动 —— 与 DiceSoNice 动画同时开始
 *   ③ 各自的骰子动画播完时，数字定格在骰值上（谁先落定谁先停）
 *   ④ 分段揭示：骰值 → 手动加值 → 各 BUFF 修正，逐条浮现并累加成最终 TOTAL
 *   ⑤ 高亮胜方，黑条退场
 *
 * DiceSoNice 只在动画播完时兑现 Promise，没有逐帧读取骰面的接口，
 * 所以③是"跟着动画时长走"，而不是"数字实时反映骰面"。
 *
 * 演出层挂在 body 上、pointer-events:none，不拦截任何操作。
 */

/** 分段：{ name: 显示名, value: 数值 } */
export class ClashTotalFX {

  static _root = null;

  /* ─── DOM ─────────────────────────────────────────────────────────────── */

  static _ensureRoot() {
    if (this._root?.isConnected) return this._root;
    const el = document.createElement("div");
    el.id = "limbus-clash-fx";
    el.innerHTML = `
      <div class="lcfx-band lcfx-band--atk" data-side="atk">
        <span class="lcfx-label">TOTAL</span>
        <span class="lcfx-num">0</span>
        <span class="lcfx-parts"></span>
        <span class="lcfx-reroll">公式重投</span>
      </div>
      <div class="lcfx-band lcfx-band--def" data-side="def">
        <span class="lcfx-reroll">公式重投</span>
        <span class="lcfx-parts"></span>
        <span class="lcfx-num">0</span>
        <span class="lcfx-label">TOTAL</span>
      </div>`;
    document.body.appendChild(el);
    this._root = el;
    return el;
  }

  static _band(side) {
    return this._ensureRoot().querySelector(`.lcfx-band[data-side="${side}"]`);
  }

  static _enabled() {
    return game.settings?.get?.("limbusCompany_FVTT", "clashTotalFx") !== false;
  }

  /* ─── 基础动作 ────────────────────────────────────────────────────────── */

  static _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  static _reset(sides = ["atk", "def"]) {
    for (const side of sides) {
      const band = this._band(side);
      band.classList.remove("is-in", "is-out", "win", "lose", "is-active");
      band.querySelector(".lcfx-num").textContent = "0";
      band.querySelector(".lcfx-parts").replaceChildren();
      band.querySelector(".lcfx-reroll").classList.remove("show");
    }
  }

  static async _bandsIn(sides) {
    for (const [i, side] of sides.entries()) {
      if (i > 0) await this._sleep(90);
      const band = this._band(side);
      band.classList.add("is-active", "is-in");
    }
    await this._sleep(420);
  }

  static async _bandsOut(sides) {
    for (const [i, side] of [...sides].reverse().entries()) {
      if (i > 0) await this._sleep(90);
      const band = this._band(side);
      band.classList.remove("is-in");
      band.classList.add("is-out");
    }
    await this._sleep(360);
    for (const side of sides) this._band(side).classList.remove("is-active");
  }

  /** 一直乱跳，直到 signal 兑现（骰子动画播完）才定格在 finalValue */
  static _rollUntil(numEl, finalValue, signal) {
    return new Promise(resolve => {
      const max = Math.max(30, Math.abs(finalValue) * 2);
      let raf, done = false;
      const tick = () => {
        if (done) return;
        numEl.textContent = Math.floor(Math.random() * max);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      const settle = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        numEl.textContent = finalValue;
        numEl.classList.remove("settle");
        void numEl.offsetWidth;      // 重排以重启动画
        numEl.classList.add("settle");
        resolve();
      };
      Promise.resolve(signal).then(settle, settle);
      // 兜底：DiceSoNice 未安装或异常时最长滚 4 秒
      setTimeout(settle, 4000);
    });
  }

  static _bump(numEl, value) {
    numEl.textContent = value;
    numEl.classList.remove("bump");
    void numEl.offsetWidth;
    numEl.classList.add("bump");
  }

  /** 骰值已定格后：逐条浮现加值/BUFF 并累加，返回最终 TOTAL */
  static async _revealParts(side, parts) {
    const band    = this._band(side);
    const numEl   = band.querySelector(".lcfx-num");
    const partsEl = band.querySelector(".lcfx-parts");
    const gap     = 500;

    partsEl.replaceChildren();
    let sum = parts[0]?.value ?? 0;

    const chip = (part, isDice) => {
      const el = document.createElement("span");
      el.className = "lcfx-part"
        + (isDice ? " lcfx-part--dice" : (part.value < 0 ? " lcfx-part--neg" : ""));
      const sign = isDice ? "" : (part.value >= 0 ? "+" : "");
      // 用 textContent 而非 innerHTML：分段名可能来自骰子公式等外部字符串
      const nameEl = document.createElement("span");
      nameEl.className = "lcfx-pname";
      nameEl.textContent = part.name ?? "";
      const valEl = document.createElement("span");
      valEl.textContent = `${sign}${part.value}`;
      el.append(nameEl, valEl);
      partsEl.appendChild(el);
      requestAnimationFrame(() => el.classList.add("show"));
    };

    chip(parts[0] ?? { name: "", value: 0 }, true);
    this._bump(numEl, sum);

    for (const part of parts.slice(1)) {
      await this._sleep(gap);
      chip(part, false);
      sum += part.value;
      this._bump(numEl, sum);
    }
    return sum;
  }

  static _judge(atkTotal, defTotal) {
    if (atkTotal === defTotal) return;
    const winSide = atkTotal > defTotal ? "atk" : "def";
    const loseSide = winSide === "atk" ? "def" : "atk";
    this._band(winSide).classList.add("win");
    this._band(loseSide).classList.add("lose");
  }

  /* ─── 对外接口 ────────────────────────────────────────────────────────── */

  /**
   * 完整演出一次拼点。
   * @param {object}   opts
   * @param {object[]} opts.atkParts   进攻方分段，第一项为骰值
   * @param {object[]} opts.defParts   防守方分段
   * @param {Function} opts.startDice  黑条切入后调用，需返回 [攻方Promise, 守方Promise]
   *                                   （即两边 DiceSoNice 动画各自的完成信号）
   */
  static async play({ atkParts = [], defParts = [], startDice = null } = {}) {
    if (!this._enabled()) { await startDice?.(); return; }

    const sides = ["atk", "def"];
    this._reset(sides);
    await this._bandsIn(sides);

    // 黑条就位后才开骰——骰子动画与数字滚动同时进行
    const [atkSignal, defSignal] = (await startDice?.()) ?? [];

    await Promise.all([
      this._rollUntil(this._band("atk").querySelector(".lcfx-num"), atkParts[0]?.value ?? 0, atkSignal),
      this._rollUntil(this._band("def").querySelector(".lcfx-num"), defParts[0]?.value ?? 0, defSignal),
    ]);

    await this._sleep(260);
    const [atkTotal, defTotal] = await Promise.all([
      this._revealParts("atk", atkParts),
      this._revealParts("def", defParts),
    ]);

    await this._sleep(240);
    this._judge(atkTotal, defTotal);
    await this._sleep(1100);
    await this._bandsOut(sides);
  }

  /**
   * 公式重投的演出：两条黑条都在场，只有实际重投的那一方带【公式重投】标记并重滚，
   * 另一方保留原有点数直接显示，最后重新分出胜负——这样玩家能看清重投前后的对比。
   *
   * @param {object}   opts
   * @param {object[]} opts.atkParts     进攻方分段（重投方为重投后的值）
   * @param {object[]} opts.defParts     防守方分段
   * @param {string[]} opts.rerollSides  实际发生重投的一方或双方，如 ["atk"]
   * @param {Function} opts.startDice    返回与 rerollSides 等长的 Promise 数组
   */
  static async playReroll({ atkParts = [], defParts = [], rerollSides = [], startDice = null } = {}) {
    if (!rerollSides.length) return;
    if (!this._enabled()) { await startDice?.(); return; }

    const sides = ["atk", "def"];
    const partsOf = (side) => (side === "atk" ? atkParts : defParts);

    this._reset(sides);
    for (const side of rerollSides) {
      this._band(side).querySelector(".lcfx-reroll").classList.add("show");
    }
    await this._bandsIn(sides);

    const signals = (await startDice?.()) ?? [];

    await Promise.all(sides.map(side => {
      const numEl = this._band(side).querySelector(".lcfx-num");
      const dice  = partsOf(side)[0]?.value ?? 0;
      const idx   = rerollSides.indexOf(side);
      // 重投方：滚到自己的骰子动画播完；未重投方：沿用原点数，直接显示
      if (idx >= 0) return this._rollUntil(numEl, dice, signals[idx]);
      numEl.textContent = dice;
      return Promise.resolve();
    }));

    await this._sleep(260);
    const [atkTotal, defTotal] = await Promise.all([
      this._revealParts("atk", atkParts),
      this._revealParts("def", defParts),
    ]);

    await this._sleep(240);
    this._judge(atkTotal, defTotal);
    await this._sleep(1000);
    await this._bandsOut(sides);
  }
}
