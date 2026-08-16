/**
 * clash-total-fx.mjs — 拼点 TOTAL 演出
 *
 * 一次对抗只演一次：发起/对抗时不演，等 [攻击时/拼点时] 这些可能改写骰子
 * 公式的效果都结算完（必要时已重投）之后，用最终生效的骰值演一遍——真正
 * 重投过的一方额外带【公式重投】标记。
 *
 * 演出流程：
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

  /** 系统 socket 频道（与 ClashManager 共用同一条） */
  static SOCKET = "system.limbusCompany_FVTT";

  /** 远端播放时，各方"骰子已落定"的等待句柄 */
  static _remoteSignals = null;

  static _emit(payload) {
    try { game.socket?.emit?.(this.SOCKET, payload); } catch (err) { /* 单机或断线时忽略 */ }
  }

  static _deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
  }

  /**
   * 远端消息处理（由主入口的 socket 总分发调用）。
   * 发起演出的那台机器只负责广播"开始"与"某方骰子落定"，
   * 其余客户端据此播放同一套演出，定格时机与本地保持一致。
   */
  static async handleSocketMsg(msg) {
    if (msg?.type === "clashFxStart") {
      const signals = { atk: this._deferred(), def: this._deferred() };
      this._remoteSignals = signals;
      const common = { atkParts: msg.atkParts ?? [], defParts: msg.defParts ?? [], broadcast: false };
      if (msg.mode === "solo") {
        const side = msg.side ?? "atk";
        await this.playSolo({
          side, parts: msg.parts ?? [], reroll: !!msg.reroll, broadcast: false,
          startDice: () => [signals[side].promise],
        });
      } else {
        await this.play({
          ...common, rerollSides: msg.rerollSides ?? [],
          startDice: () => [signals.atk.promise, signals.def.promise],
        });
      }
      this._remoteSignals = null;
      return;
    }
    if (msg?.type === "clashFxSettle") {
      this._remoteSignals?.[msg.side]?.resolve();
    }
  }

  /** 本地等待各方骰子动画，同时把"已落定"广播出去，让远端同步定格 */
  static _wrapSignals(signals, sides, broadcast) {
    return signals.map((p, i) => Promise.resolve(p).then(
      () => { if (broadcast) this._emit({ type: "clashFxSettle", side: sides[i] }); },
      () => { if (broadcast) this._emit({ type: "clashFxSettle", side: sides[i] }); },
    ));
  }

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

  /** 演出节奏缩放：一回合常有多次拼点，默认按"快速"跑 */
  static _speed() {
    const mode = game.settings?.get?.("limbusCompany_FVTT", "clashTotalFxSpeed") ?? "fast";
    return { standard: 1, fast: 0.6, turbo: 0.35 }[mode] ?? 0.6;
  }

  /* ─── 基础动作 ────────────────────────────────────────────────────────── */

  /** 停顿：按当前节奏缩放（骰子动画本身不受影响，它由 DiceSoNice 控制） */
  static _sleep(ms) { return new Promise(r => setTimeout(r, Math.round(ms * this._speed()))); }

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
      // 兜底：DiceSoNice 未安装或信号丢失时不至于一直滚下去。
      // 必须明显长于骰子动画时长，否则数字会在骰子还在滚时提前定死。
      setTimeout(settle, 15000);
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
    const gap     = 500;   // 实际间隔由 _sleep 按节奏缩放

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
   * @param {string[]} opts.rerollSides 因公式变化真正重投过的一方或双方，带【公式重投】标记
   * @param {Function} opts.startDice  黑条切入后调用，需返回 [攻方Promise, 守方Promise]
   *                                   （即两边 DiceSoNice 动画各自的完成信号）
   */
  static async play({ atkParts = [], defParts = [], rerollSides = [], startDice = null, broadcast = true } = {}) {
    if (!this._enabled()) { await startDice?.(); return; }

    const sides = ["atk", "def"];
    // 先让其他客户端把黑条切进来，双方同步开演
    if (broadcast) this._emit({ type: "clashFxStart", mode: "play", atkParts, defParts, rerollSides });

    this._reset(sides);
    for (const side of rerollSides) {
      this._band(side).querySelector(".lcfx-reroll").classList.add("show");
    }
    await this._bandsIn(sides);

    // 黑条就位后才开骰——骰子动画与数字滚动同时进行
    const raw = (await startDice?.()) ?? [];
    const [atkSignal, defSignal] = this._wrapSignals(raw, sides, broadcast);

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
    await this._sleep(800);
    await this._bandsOut(sides);
  }

  /**
   * 单方面攻击（承受）的演出：只有攻击方一条黑条，没有胜负判定。
   *
   * @param {object}   opts
   * @param {string}   opts.side      哪一侧出场，默认 "atk"
   * @param {object[]} opts.parts     分段，第一项为骰值
   * @param {boolean}  opts.reroll    是否标记【公式重投】
   * @param {Function} opts.startDice 返回 [该方 DiceSoNice 动画的 Promise]
   */
  static async playSolo({ side = "atk", parts = [], reroll = false, startDice = null, broadcast = true } = {}) {
    if (!this._enabled()) { await startDice?.(); return; }

    const sides = [side];
    if (broadcast) this._emit({ type: "clashFxStart", mode: "solo", side, parts, reroll });

    this._reset(sides);
    if (reroll) this._band(side).querySelector(".lcfx-reroll").classList.add("show");
    await this._bandsIn(sides);

    const [signal] = this._wrapSignals((await startDice?.()) ?? [], sides, broadcast);
    await this._rollUntil(this._band(side).querySelector(".lcfx-num"), parts[0]?.value ?? 0, signal);

    await this._sleep(260);
    await this._revealParts(side, parts);
    await this._sleep(900);
    await this._bandsOut(sides);
  }

}
