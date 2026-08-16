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
 * 【连击（回合内多次交锋）】
 * 一次攻击链里常常连着打好几次（例如【不可摧毁】拼点失败反击），演出不再
 * 一次一收：黑条切进来后会停留一小段"连击窗口"（CHAIN_GRACE），窗口内又
 * 开打就算同一条连击链——黑条不退场，中央甩出一枚「N 连击」字样，直到
 * 窗口内不再有新的交锋才整体退场。
 *
 * 数字也不再等 DiceSoNice：每次交锋照常发射 3D 骰子（不 await），数字只滚
 * 固定的 ROLL_MS 就定格，这样连击节奏不会被骰子动画的 5 秒拖住。
 *
 * 演出层挂在 body 上、pointer-events:none，不拦截任何操作。
 */

/** 分段：{ name: 显示名, value: 数值 } */
export class ClashTotalFX {

  static _root = null;

  /** 数字滚动时长（ms，实际还会被 _speed() 缩放）——不再等 DiceSoNice */
  static ROLL_MS = 400;

  /** 连击窗口：上一次交锋结束后多久没有新交锋，黑条才退场 */
  static CHAIN_GRACE = 1200;

  /** 骰子图标：一般骰子用硬币正面，【不可摧毁】用不可摧毁的硬币 */
  static DICE_ICON = {
    default:     "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_正面.webp",
    unbreakable: "systems/limbusCompany_FVTT/assets/icons/Base_icon/不可摧毁的硬币.webp",
  };

  /** 连击链状态 */
  static _chain = { active: false, combo: 0, timer: null, sides: [] };

  /** 系统 socket 频道（与 ClashManager 共用同一条） */
  static SOCKET = "system.limbusCompany_FVTT";

  static _emit(payload) {
    try { game.socket?.emit?.(this.SOCKET, payload); } catch (err) { /* 单机或断线时忽略 */ }
  }

  /**
   * 远端消息处理（由主入口的 socket 总分发调用）。
   * 发起演出的那台机器只负责广播"开始"与"某方骰子落定"，
   * 其余客户端据此播放同一套演出，定格时机与本地保持一致。
   */
  static async handleSocketMsg(msg) {
    if (msg?.type === "clashFxStart") {
      // 数字不再等骰子动画，远端按同样的固定时长跑即可，无需 settle 信号
      const common = {
        atkParts: msg.atkParts ?? [], defParts: msg.defParts ?? [], broadcast: false,
        atkDiceType: msg.atkDiceType ?? "default", defDiceType: msg.defDiceType ?? "default",
        label: msg.label ?? "",
      };
      if (msg.mode === "solo") {
        await this.playSolo({
          side: msg.side ?? "atk", parts: msg.parts ?? [], reroll: !!msg.reroll,
          diceType: msg.diceType ?? "default", label: msg.label ?? "", broadcast: false,
        });
      } else if (msg.mode === "reroll") {
        await this.playReroll({ ...common, rerollSides: msg.rerollSides ?? [] });
      } else {
        await this.play(common);
      }
      return;
    }
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
    await this._sleep(600);
    for (const side of sides) this._band(side).classList.remove("is-active");
  }

  /* ─── 骰子条 ──────────────────────────────────────────────────────────── */

  /** 从基础公式里读出骰数与面数，如 "3D6+2" → { count: 3, faces: 6 } */
  static _parseDice(formula = "") {
    const m = /(\d*)\s*[dD]\s*(\d+)/.exec(String(formula));
    if (!m) return { count: 0, faces: 6 };
    return { count: Math.min(12, Math.max(1, parseInt(m[1] || "1"))), faces: parseInt(m[2]) };
  }

  static _dieSrc(type) {
    return this.DICE_ICON[type] ?? this.DICE_ICON.default;
  }

  /** 按骰数在 TOTAL 上方摆出骰子图标 */
  static _buildDice(side, formula, type = "default") {
    const box = this._band(side).querySelector(".lcfx-dice");
    box.replaceChildren();
    const { count } = this._parseDice(formula);
    for (let i = 0; i < count; i++) {
      const img = document.createElement("img");
      img.className = "lcfx-die" + (type === "unbreakable" ? " lcfx-die--unbreak" : "");
      img.src = this._dieSrc(type);
      img.dataset.type = type;
      box.appendChild(img);
    }
  }

  /** 交锋失败：毁掉末尾一枚骰子——一般骰子消失，不可摧毁碎裂后变暗留场 */
  static _breakDie(side) {
    const box = this._band(side).querySelector(".lcfx-dice");
    const die = [...box.querySelectorAll(".lcfx-die:not(.is-broken)")].pop();
    if (!die) return;
    die.classList.add("is-shatter");
    setTimeout(() => {
      die.classList.remove("is-shatter");
      if (die.dataset.type === "unbreakable") die.classList.add("is-broken");
      else die.remove();
    }, 260);
  }

  /** 固定时长乱跳后定格（不等 DiceSoNice） */
  static _rollFor(numEl, finalValue) {
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
    const jitter = 50;
    const rand = () => ((Math.random() * 2 - 1) * jitter).toFixed(0);
    const el = document.createElement("div");
    el.className = "lcfx-combo " + cls;
    el.textContent = text;
    el.style.setProperty("--lcfx-cx", `${rand()}px`);
    el.style.setProperty("--lcfx-cy", `${rand()}px`);
    el.addEventListener("animationend", () => el.remove());
    box.appendChild(el);
  }

  /**
   * 进入一次交锋。同一条连击链内黑条不重新切入，只清掉上一次的数字/分段。
   * @returns {number} 本次是第几连击
   */
  static async _enterExchange(sides, { reroll = [], dice = {}, label = "" } = {}) {
    const chain = this._chain;
    if (chain.timer) { clearTimeout(chain.timer); chain.timer = null; }

    if (!chain.active) { chain.active = true; chain.combo = 0; chain.sides = []; }

    // 链中已在场的一侧保留黑条，只清数字；新出场的一侧完全重置后再切入
    const staying = sides.filter(side => chain.sides.includes(side));
    const entering = sides.filter(side => !chain.sides.includes(side));
    this._reset(staying, true);
    this._reset(entering, false);
    for (const side of reroll) this._band(side).querySelector(".lcfx-reroll").classList.add("show");

    // 骰子条只在一侧首次入场时生成，连击过程中沿用（会被逐次打碎）
    for (const side of entering) {
      const d = dice[side];
      if (d) this._buildDice(side, d.formula, d.type);
      else this._band(side).querySelector(".lcfx-dice").replaceChildren();
    }
    chain.sides = [...new Set([...chain.sides, ...sides])];
    if (entering.length) await this._bandsIn(entering);

    chain.combo += 1;
    this._combo(label || `${chain.combo} 连击`, label ? "reroll" : "");
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
   * @param {Function} opts.startDice  黑条切入后调用，需返回 [攻方Promise, 守方Promise]
   *                                   （即两边 DiceSoNice 动画各自的完成信号）
   */
  static async play({ atkParts = [], defParts = [], atkDiceType = "default", defDiceType = "default",
                      label = "", startDice = null, broadcast = true } = {}) {
    if (!this._enabled()) { await startDice?.(); return; }

    const sides = ["atk", "def"];
    // 先让其他客户端把黑条切进来，双方同步开演
    if (broadcast) this._emit({ type: "clashFxStart", mode: "play", atkParts, defParts, atkDiceType, defDiceType, label });

    await this._enterExchange(sides, { label, dice: {
      atk: { formula: atkParts[0]?.name ?? "", type: atkDiceType },
      def: { formula: defParts[0]?.name ?? "", type: defDiceType },
    } });

    // 骰子照常发射，但不 await——数字只滚固定时长就定格
    startDice?.();

    await Promise.all([
      this._rollFor(this._band("atk").querySelector(".lcfx-num"), atkParts[0]?.value ?? 0),
      this._rollFor(this._band("def").querySelector(".lcfx-num"), defParts[0]?.value ?? 0),
    ]);

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
  static async playSolo({ side = "atk", parts = [], reroll = false, diceType = "default",
                          label = "", startDice = null, broadcast = true } = {}) {
    if (!this._enabled()) { await startDice?.(); return; }

    const sides = [side];
    if (broadcast) this._emit({ type: "clashFxStart", mode: "solo", side, parts, reroll, diceType, label });

    await this._enterExchange(sides, {
      label,
      reroll: reroll ? [side] : [],
      dice: { [side]: { formula: parts[0]?.name ?? "", type: diceType } },
    });

    startDice?.();
    await this._rollFor(this._band(side).querySelector(".lcfx-num"), parts[0]?.value ?? 0);

    await this._sleep(260);
    await this._revealParts(side, parts);
    await this._sleep(500);
    this._exitExchange();
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
  static async playReroll({ atkParts = [], defParts = [], rerollSides = [],
                            atkDiceType = "default", defDiceType = "default",
                            startDice = null, broadcast = true } = {}) {
    if (!rerollSides.length) return;
    if (!this._enabled()) { await startDice?.(); return; }

    const sides = ["atk", "def"];
    const partsOf = (side) => (side === "atk" ? atkParts : defParts);

    if (broadcast) {
      this._emit({ type: "clashFxStart", mode: "reroll", atkParts, defParts, rerollSides, atkDiceType, defDiceType });
    }

    await this._enterExchange(sides, { reroll: rerollSides, dice: {
      atk: { formula: atkParts[0]?.name ?? "", type: atkDiceType },
      def: { formula: defParts[0]?.name ?? "", type: defDiceType },
    } });

    startDice?.();

    await Promise.all(sides.map(side => {
      const numEl = this._band(side).querySelector(".lcfx-num");
      const dice  = partsOf(side)[0]?.value ?? 0;
      // 重投方重滚；未重投方沿用原点数，直接显示
      if (rerollSides.includes(side)) return this._rollFor(numEl, dice);
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
    await this._sleep(600);
    this._exitExchange();
  }
}
