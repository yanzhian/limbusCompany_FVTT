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
 * 【连击】一次对抗里双方可能反复交锋（拼点失败方扣 1 点行动值，行动值为 0
 * 时再输就吃伤害）。演出不是一次一收：黑条切进来后停留一段"连击窗口"
 * （CHAIN_GRACE），窗口内又开打就算同一条连击链——黑条不退场，中央甩出一枚
 * 「N 连击」字样。只有第一次与最后一次交锋会真的掷 DiceSoNice，中间几次数字
 * 只滚固定时长（ROLL_MS）就定格。
 *
 * 演出层挂在 body 上、pointer-events:none，不拦截任何操作。
 */

/** 分段：{ name: 显示名, value: 数值 } */
export class ClashTotalFX {

  static _root = null;

  /** 无骰子动画时，数字滚动的固定时长（ms，还会被 _speed() 缩放） */
  static ROLL_MS = 400;

  /** 连击窗口：上一次交锋结束后多久没有新交锋，黑条才退场 */
  static CHAIN_GRACE = 1200;

  /** 骰子图标：一般骰子用硬币正面，【不可摧毁】用不可摧毁的硬币 */
  static DICE_ICON = {
    default:     "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_正面.webp",
    unbreakable: "systems/limbusCompany_FVTT/assets/icons/Base_icon/不可摧毁的硬币.webp",
  };

  /** 破碎动画时长（ms） */
  static BREAK_MS = 100;

  /** 音效（占位空音频，替换同名文件即可换声） */
  static SFX = {
    tick:  "systems/limbusCompany_FVTT/assets/audio/clash_number_tick.wav",
    break: "systems/limbusCompany_FVTT/assets/audio/clash_coin_break.wav",
  };

  /**
   * 调试开关：控制台里 `ClashTotalFX.DEBUG = true` 打开，
   * 会把每次演出的硬币数、来源、行动值打进控制台。
   */
  static DEBUG = false;

  static _log(...args) {
    if (this.DEBUG) console.log("%c[LimbusFX]", "color:#34c8df;font-weight:bold", ...args);
  }

  /** 连击链状态 */
  static _chain = { active: false, combo: 0, timer: null, sides: [] };

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
      const common = {
        atkParts: msg.atkParts ?? [], defParts: msg.defParts ?? [], broadcast: false,
        atkDiceType: msg.atkDiceType ?? "default", defDiceType: msg.defDiceType ?? "default",
        atkCoins: msg.atkCoins ?? 0, defCoins: msg.defCoins ?? 0,
      };
      if (msg.mode === "solo") {
        const side = msg.side ?? "atk";
        await this.playSolo({
          side, parts: msg.parts ?? [], reroll: !!msg.reroll, label: msg.label ?? "",
          diceType: msg.diceType ?? "default", coins: msg.coins ?? 0, broadcast: false,
          startDice: () => [signals[side].promise],
        });
      } else {
        await this.play({
          ...common, rerollSides: msg.rerollSides ?? [], label: msg.label ?? "",
          // 远端不知道本次是否有骰子动画：有 clashFxSettle 就等，没有就按固定时长
          startDice: msg.withDice === false ? null
            : () => [signals.atk.promise, signals.def.promise],
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

  /** 播放一次音效（音频未就绪或被浏览器拦截时静默失败） */
  static _sfx(key, volume = 0.6) {
    const src = this.SFX[key];
    if (!src) return;
    try {
      const helper = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
      helper?.play?.({ src, volume, autoplay: true, loop: false }, false);
    } catch (err) { /* 忽略：音效不该影响演出 */ }
  }

  /* ─── DOM ─────────────────────────────────────────────────────────────── */

  static _ensureRoot() {
    if (this._root?.isConnected) return this._root;
    const el = document.createElement("div");
    el.id = "limbus-clash-fx";
    el.innerHTML = `
      <div class="lcfx-band lcfx-band--atk" data-side="atk">
        <div class="lcfx-col">
          <div class="lcfx-dice"></div>
          <div class="lcfx-row">
            <span class="lcfx-label">TOTAL</span>
            <span class="lcfx-num">0</span>
            <span class="lcfx-parts"></span>
            <span class="lcfx-reroll">公式重投</span>
          </div>
        </div>
      </div>
      <div class="lcfx-band lcfx-band--def" data-side="def">
        <div class="lcfx-col">
          <div class="lcfx-dice"></div>
          <div class="lcfx-row">
            <span class="lcfx-reroll">公式重投</span>
            <span class="lcfx-parts"></span>
            <span class="lcfx-num">0</span>
            <span class="lcfx-label">TOTAL</span>
          </div>
        </div>
      <div class="lcfx-combos"></div>`;
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

  /**
   * 清掉上一次交锋的数字与分段。
   * keepIn=true 时保留 is-in/is-active——连击链中黑条要一直挂在场上。
   */
  static _reset(sides = ["atk", "def"], keepIn = false) {
    for (const side of sides) {
      const band = this._band(side);
      band.classList.remove("win", "lose");
      if (!keepIn) band.classList.remove("is-in", "is-out", "is-active");
      band.querySelector(".lcfx-num").textContent = "0";
      band.querySelector(".lcfx-parts").replaceChildren();
      if (!keepIn) band.querySelector(".lcfx-dice").replaceChildren();
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
    this._sfx("tick");
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

  /* ─── 硬币条（TOTAL 上方）────────────────────────────────────────────
     硬币 = 行动值，也就是"还能输几次"。每输一次交锋碎一枚，与行动值同步。
     ──────────────────────────────────────────────────────────────────── */

  /** 按行动值在 TOTAL 上方摆出硬币 */
  static _buildDice(side, count = 0, type = "default") {
    const box = this._band(side).querySelector(".lcfx-dice");
    this._log(`建硬币条 ${side}：count=${count} type=${type}`);
    box.replaceChildren();
    for (let i = 0; i < Math.min(12, Math.max(0, count)); i++) {
      const img = document.createElement("img");
      img.className = "lcfx-die" + (type === "unbreakable" ? " lcfx-die--unbreak" : "");
      img.src = this.DICE_ICON[type] ?? this.DICE_ICON.default;
      img.dataset.type = type;
      box.appendChild(img);
    }
  }

  /** 交锋失败：毁掉末尾一枚硬币——一般硬币消失，不可摧毁碎裂后变暗留场 */
  static _breakDie(side) {
    const box = this._band(side).querySelector(".lcfx-dice");
    const alive = [...box.querySelectorAll(".lcfx-die:not(.is-broken)")];
    const die = alive.pop();
    this._log(`碎硬币 ${side}：${alive.length + (die ? 1 : 0)} 枚 → ${alive.length} 枚`);
    if (!die) return;
    this._sfx("break");
    die.classList.add("is-shatter");
    setTimeout(() => {
      die.classList.remove("is-shatter");
      if (die.dataset.type === "unbreakable") die.classList.add("is-broken");
      else die.remove();
    }, this.BREAK_MS);
  }

  /** 固定时长乱跳后定格（该次交锋没有骰子动画时用） */
  static _rollFor(numEl, finalValue) {
    this._sfx("tick");
    return new Promise(resolve => {
      const max = Math.max(30, Math.abs(finalValue) * 2);
      const end = performance.now() + Math.round(this.ROLL_MS * this._speed());
      const tick = (now) => {
        if (now < end) {
          numEl.textContent = Math.floor(Math.random() * max);
          return requestAnimationFrame(tick);
        }
        numEl.textContent = finalValue;
        numEl.classList.remove("settle");
        void numEl.offsetWidth;
        numEl.classList.add("settle");
        resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  /** 甩出一枚「N 连击」：中心附近随机落点，瞬间出现后缓慢淡出，互不等待 */
  static _combo(text, cls = "") {
    const box = this._ensureRoot().querySelector(".lcfx-combos");
    if (!box) return;
    const jitter = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--lcfx-combo-jitter")) || 50;
    const rand = () => ((Math.random() * 2 - 1) * jitter).toFixed(0);
    const el = document.createElement("div");
    el.className = "lcfx-combo " + cls;
    el.textContent = text;
    el.style.setProperty("--lcfx-cx", `${rand()}px`);
    el.style.setProperty("--lcfx-cy", `${rand()}px`);
    el.addEventListener("animationend", () => el.remove());
    box.appendChild(el);
  }

  /** 进入一次交锋：同一条连击链内黑条不重新切入，只清掉上一次的数字/分段 */
  static async _enterExchange(sides, { reroll = [], label = "", dice = {} } = {}) {
    const chain = this._chain;
    if (chain.timer) { clearTimeout(chain.timer); chain.timer = null; }
    if (!chain.active) { chain.active = true; chain.combo = 0; chain.sides = []; }

    const staying  = sides.filter(side => chain.sides.includes(side));
    const entering = sides.filter(side => !chain.sides.includes(side));
    this._reset(staying, true);
    this._reset(entering, false);
    for (const side of reroll) this._band(side).querySelector(".lcfx-reroll").classList.add("show");

    // 硬币条只在一侧首次入场时生成，连击途中沿用（会被逐次打碎）
    for (const side of entering) {
      const d = dice[side];
      if (d) this._buildDice(side, d.count, d.type);
    }
    chain.sides = [...new Set([...chain.sides, ...sides])];
    if (entering.length) await this._bandsIn(entering);

    chain.combo += 1;
    this._combo(label || `${chain.combo} 连击`, label ? "final" : "");
    return chain.combo;
  }

  /** 结束一次交锋：留出连击窗口，窗口内没有新交锋才退场 */
  static _exitExchange() {
    const chain = this._chain;
    if (chain.timer) clearTimeout(chain.timer);
    chain.timer = setTimeout(() => {
      const sides = chain.sides;
      chain.timer = null; chain.active = false; chain.combo = 0; chain.sides = [];
      this._bandsOut(sides);
    }, Math.round(this.CHAIN_GRACE * this._speed()));
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
    this._breakDie(loseSide);
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
  static async play({ atkParts = [], defParts = [], rerollSides = [], label = "",
                      atkDiceType = "default", defDiceType = "default",
                      atkCoins = 0, defCoins = 0,
                      startDice = null, broadcast = true } = {}) {
    if (!this._enabled()) { await startDice?.(); return; }

    const sides = ["atk", "def"];
    // 先让其他客户端把黑条切进来，双方同步开演
    if (broadcast) {
      this._emit({ type: "clashFxStart", mode: "play", atkParts, defParts, rerollSides, label,
                   atkDiceType, defDiceType, atkCoins, defCoins, withDice: !!startDice });
    }

    this._log("play()", { atkCoins, defCoins, atkDiceType, defDiceType, label,
                          withDice: !!startDice, broadcast });
    await this._enterExchange(sides, { reroll: rerollSides, label, dice: {
      atk: { count: atkCoins, type: atkDiceType },
      def: { count: defCoins, type: defDiceType },
    } });

    const atkNum = this._band("atk").querySelector(".lcfx-num");
    const defNum = this._band("def").querySelector(".lcfx-num");

    if (startDice) {
      // 有骰子动画的交锋（第一次与最后一次）：数字滚到各自骰子落定才定格
      const raw = (await startDice()) ?? [];
      const [atkSignal, defSignal] = this._wrapSignals(raw, sides, broadcast);
      await Promise.all([
        this._rollUntil(atkNum, atkParts[0]?.value ?? 0, atkSignal),
        this._rollUntil(defNum, defParts[0]?.value ?? 0, defSignal),
      ]);
    } else {
      // 连击中间的交锋：不掷骰子，数字滚固定时长
      await Promise.all([
        this._rollFor(atkNum, atkParts[0]?.value ?? 0),
        this._rollFor(defNum, defParts[0]?.value ?? 0),
      ]);
    }

    await this._sleep(260);
    const [atkTotal, defTotal] = await Promise.all([
      this._revealParts("atk", atkParts),
      this._revealParts("def", defParts),
    ]);

    await this._sleep(240);
    this._judge(atkTotal, defTotal);
    await this._sleep(500);
    this._exitExchange();
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
  static async playSolo({ side = "atk", parts = [], reroll = false, label = "",
                          diceType = "default", coins = 0,
                          startDice = null, broadcast = true } = {}) {
    if (!this._enabled()) { await startDice?.(); return; }

    const sides = [side];
    if (broadcast) this._emit({ type: "clashFxStart", mode: "solo", side, parts, reroll, label, diceType, coins });

    await this._enterExchange(sides, {
      reroll: reroll ? [side] : [], label,
      dice: { [side]: { count: coins, type: diceType } },
    });

    const [signal] = this._wrapSignals((await startDice?.()) ?? [], sides, broadcast);
    await this._rollUntil(this._band(side).querySelector(".lcfx-num"), parts[0]?.value ?? 0, signal);

    await this._sleep(260);
    await this._revealParts(side, parts);
    await this._sleep(600);
    this._exitExchange();
  }

}
