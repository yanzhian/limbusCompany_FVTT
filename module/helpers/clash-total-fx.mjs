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

  /**
   * 音效（占位空音频，替换同名文件即可换声）
   * - add   骰子落定后，等级差/BUFF 等加值逐条浮现时，每条"当"一声
   * - break 硬币碎裂（3 个候选）
   * - win   败方已经没有硬币可碎，这一败即决出胜负（3 个候选）
   * - hit   【伤害计算】命中（3 个候选）
   * - tremor 【震颤引爆】
   * - chaos  进入【混乱阈值】
   * 数组即多个候选，每次随机挑一个，避免连击时听着重复。
   */
  static AUDIO = "systems/limbusCompany_FVTT/assets/audio";
  static SFX = {
    add:   `${ClashTotalFX.AUDIO}/clash_number_tick.wav`,
    break: [1, 2, 3].map(i => `${ClashTotalFX.AUDIO}/clash_coin_break_${i}.wav`),
    win:   [1, 2, 3].map(i => `${ClashTotalFX.AUDIO}/clash_win_${i}.wav`),
    hit:   [1, 2, 3].map(i => `${ClashTotalFX.AUDIO}/clash_hit_${i}.wav`),
    tremor: `${ClashTotalFX.AUDIO}/clash_tremor_burst.wav`,
    chaos:  `${ClashTotalFX.AUDIO}/clash_chaos.wav`,
  };

  /** 【伤害计算】那一次演出的中央字样 */
  static LABEL_DAMAGE = "伤害计算";

  /** 本次拼点中是否发生过【震颤引爆】——为真时【伤害计算】的命中声换成引爆声 */
  static _tremorPending = false;

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

  /**
   * 远端播放时，各方"骰子已落定"的等待句柄，按本次演出的 id 索引。
   * 一次连击会连着广播好几段演出，用单个槽位会被后来的覆盖，
   * 先前那段就只能傻等 15 秒兜底——PL 那边"很久之后才响"就是这么来的。
   */
  static _remoteSignals = new Map();

  /** 已经收到、但那段演出还在队列里没轮到播的落定信号 */
  static _settledEarly = new Set();

  /** 远端播放队列：广播来得比播得快，必须排队，否则几段演出会在同一块 DOM 上打架 */
  static _queue = Promise.resolve();

  static _enqueue(fn) {
    this._queue = this._queue.then(fn).catch(err => console.error("[LimbusFX]", err));
    return this._queue;
  }

  /** 本次演出的 id（广播与落定信号靠它配对） */
  static _fxId = 0;
  static _nextFxId() { return `${game.userId ?? "u"}-${++this._fxId}`; }

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
    if (msg?.type === "clashFxSfx") {
      this._sfx(msg.key, msg.volume ?? 0.8);
      return;
    }
    if (msg?.type === "clashFxSettle") {
      const slot = this._remoteSignals.get(msg.fxId);
      // 那段演出还排在队列里没开始播：先记下来，轮到它时立即落定
      if (slot) slot[msg.side]?.resolve();
      else this._settledEarly.add(`${msg.fxId}:${msg.side}`);
      return;
    }
    if (msg?.type !== "clashFxStart") return;

    // 排队播放：一次连击会连着广播好几段，必须一段播完再播下一段
    this._enqueue(async () => {
      const fxId    = msg.fxId ?? "";
      const signals = { atk: this._deferred(), def: this._deferred() };
      this._remoteSignals.set(fxId, signals);
      for (const side of ["atk", "def"]) {
        const key = `${fxId}:${side}`;
        if (this._settledEarly.delete(key)) signals[side].resolve();
      }
      // 兜底：本地那段若因故没发落定信号，也不至于卡住整条队列
      const guard = setTimeout(() => { signals.atk.resolve(); signals.def.resolve(); }, 15000);

      const common = {
        atkParts: msg.atkParts ?? [], defParts: msg.defParts ?? [], broadcast: false,
        atkDiceType: msg.atkDiceType ?? "default", defDiceType: msg.defDiceType ?? "default",
        atkCoins: msg.atkCoins ?? 0, defCoins: msg.defCoins ?? 0,
        noBreak: !!msg.noBreak, hitSfx: !!msg.hitSfx,
      };

      try {
        if (msg.mode === "solo") {
          const side = msg.side ?? "atk";
          await this.playSolo({
            side, parts: msg.parts ?? [], reroll: !!msg.reroll, label: msg.label ?? "",
            diceType: msg.diceType ?? "default", coins: msg.coins ?? 0, broadcast: false,
            startDice: () => [signals[side].promise],
          });
        } else if (msg.mode === "seq") {
          await this.playSequence({
            order: msg.order ?? ["def", "atk"], parts: msg.parts ?? {},
            diceType: msg.diceType ?? {}, coins: msg.coins ?? {},
            hitOn: msg.hitOn ?? [], label: msg.label ?? "", broadcast: false,
            startDice: (side) => [signals[side].promise],
          });
        } else {
          await this.play({
            ...common, rerollSides: msg.rerollSides ?? [], label: msg.label ?? "",
            // 该段本地没掷骰子时，远端也按固定时长滚，不必等落定信号
            startDice: msg.withDice === false ? null
              : () => [signals.atk.promise, signals.def.promise],
          });
        }
      } finally {
        clearTimeout(guard);
        this._remoteSignals.delete(fxId);
        this._settledEarly.delete(`${fxId}:atk`);
        this._settledEarly.delete(`${fxId}:def`);
      }
    });
  }

  /** 本地等待各方骰子动画，同时把"已落定"广播出去，让远端同步定格 */
  static _wrapSignals(signals, sides, broadcast, fxId = "") {
    return signals.map((p, i) => Promise.resolve(p).then(
      () => { if (broadcast) this._emit({ type: "clashFxSettle", side: sides[i], fxId }); },
      () => { if (broadcast) this._emit({ type: "clashFxSettle", side: sides[i], fxId }); },
    ));
  }

  /** 播放一次音效（音频未就绪或被浏览器拦截时静默失败） */
  static _sfx(key, volume = 0.6) {
    const entry = this.SFX[key];
    // 数组 = 多个候选音效，随机挑一个
    const src = Array.isArray(entry)
      ? entry[Math.floor(Math.random() * entry.length)]
      : entry;
    if (!src) return;
    try {
      const helper = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
      helper?.play?.({ src, volume, autoplay: true, loop: false }, false);
    } catch (err) { /* 忽略：音效不该影响演出 */ }
  }

  /**
   * 播放音效并广播给其他客户端。
   * 战斗结算大多只在一台机器上跑（常常是 GM 端），像【震颤引爆】【混乱阈值】
   * 这种全场都该听见的声音要走这里。
   */
  static broadcastSfx(key, volume = 0.8) {
    this._sfx(key, volume);
    this._emit({ type: "clashFxSfx", key, volume });
  }

  /**
   * 【震颤引爆】：引爆的当下就发声，同时记下标记——本次拼点的【伤害计算】
   * 不再播命中声（命中声被引爆声取代）。一次拼点里连爆多次也只响一次。
   */
  static tremorBurst() {
    if (this._chain.active && this._tremorPending) return;   // 本次拼点已经响过
    if (this._chain.active) this._tremorPending = true;
    this.broadcastSfx("tremor");
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

  /**
   * 演出节奏缩放。默认档就是原先的"极速"（约原始时长的 35%），
   * 另外两档分别是它的 3 倍时长与 1/3 时长。
   */
  static SPEED_BASE = 0.35;
  static _speed() {
    const mode = game.settings?.get?.("limbusCompany_FVTT", "clashTotalFxSpeed") ?? "standard";
    const mult = { slow: 3, standard: 1, fast: 1 / 3 }[mode] ?? 1;
    return this.SPEED_BASE * mult;
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

  /**
   * 交锋失败：毁掉末尾一枚硬币——一般硬币消失，不可摧毁碎裂后变暗留场。
   * @returns {boolean} 是否真的碎掉了一枚（已经没硬币可碎时返回 false）
   */
  static _breakDie(side) {
    const box = this._band(side).querySelector(".lcfx-dice");
    const alive = [...box.querySelectorAll(".lcfx-die:not(.is-broken)")];
    const die = alive.pop();
    this._log(`碎硬币 ${side}：${alive.length + (die ? 1 : 0)} 枚 → ${alive.length} 枚`);
    if (!die) return false;
    this._sfx("break");
    die.classList.add("is-shatter");
    setTimeout(() => {
      die.classList.remove("is-shatter");
      if (die.dataset.type === "unbreakable") die.classList.add("is-broken");
      else die.remove();
    }, this.BREAK_MS);
    return true;
  }

  /** 固定时长乱跳后定格（该次交锋没有骰子动画时用） */
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
    const root = this._ensureRoot();
    let box = root.querySelector(".lcfx-combos");
    if (!box) {
      box = document.createElement("div");
      box.className = "lcfx-combos";
      root.appendChild(box);
    }
    const jitter = parseFloat(getComputedStyle(root).getPropertyValue("--lcfx-combo-jitter")) || 80;
    const rand = () => ((Math.random() * 2 - 1) * jitter).toFixed(0);
    const el = document.createElement("div");
    el.className = "lcfx-combo " + cls;
    el.textContent = text;
    el.style.setProperty("--lcfx-cx", `${rand()}px`);
    el.style.setProperty("--lcfx-cy", `${rand()}px`);
    el.addEventListener("animationend", () => el.remove());
    box.appendChild(el);
    this._log(`连击字样「${text}」cls=${cls || "-"} 偏移 ${el.style.getPropertyValue("--lcfx-cx")},`
      + ` ${el.style.getPropertyValue("--lcfx-cy")}`);
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
      this._tremorPending = false;
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
  static async _revealParts(side, parts, withSfx = true) {
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
      if (withSfx) this._sfx("add");   // 每加一条"当"一声
      chip(part, false);
      sum += part.value;
      this._bump(numEl, sum);
    }
    return sum;
  }

  static _judge(atkTotal, defTotal, { allowBreak = true } = {}) {
    // 平局：谁也没输，但刀枪硬碰硬的那一声还是要有
    if (atkTotal === defTotal) { this._sfx("win"); return; }
    const winSide = atkTotal > defTotal ? "atk" : "def";
    const loseSide = winSide === "atk" ? "def" : "atk";
    this._band(winSide).classList.add("win");
    this._band(loseSide).classList.add("lose");
    // 闪避/守备/反击这类一次定输赢的对抗不碎硬币（也不消耗行动值）
    if (!allowBreak) { this._sfx("win"); return; }
    // 败方还有硬币 → 碎一枚（碎裂声）；已经没硬币可碎 → 这一败定胜负（胜负声）
    if (!this._breakDie(loseSide)) this._sfx("win");
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
                      atkCoins = 0, defCoins = 0, noBreak = false, hitSfx = false,
                      startDice = null, broadcast = true } = {}) {
    if (!this._enabled()) { await startDice?.(); return; }

    const sides = ["atk", "def"];
    const fxId  = this._nextFxId();
    // 先让其他客户端把黑条切进来，双方同步开演
    if (broadcast) {
      this._emit({ type: "clashFxStart", fxId, mode: "play", atkParts, defParts, rerollSides, label,
                   atkDiceType, defDiceType, atkCoins, defCoins, noBreak, hitSfx,
                   withDice: !!startDice });
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
      const [atkSignal, defSignal] = this._wrapSignals(raw, sides, broadcast, fxId);
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
    // 双方同时揭示，两串"当当当"叠在一起会互相盖住；只让分段更多的一方出声，
    // 这样听到的次数一定是两边里最多的那个，不会漏拍。
    const sfxSide = defParts.length > atkParts.length ? "def" : "atk";
    const [atkTotal, defTotal] = await Promise.all([
      this._revealParts("atk", atkParts, sfxSide === "atk"),
      this._revealParts("def", defParts, sfxSide === "def"),
    ]);

    await this._sleep(240);
    this._judge(atkTotal, defTotal, { allowBreak: !noBreak });
    // hitSfx：闪避失败之类"这一下真的打上了"的场合
    if (hitSfx && atkTotal !== defTotal) this._sfx(this._tremorPending ? "tremor" : "hit", 0.8);
    await this._sleep(500);
    this._exitExchange();
  }

  /**
   * 先后出手的演出：不是交锋，而是一方先骰、另一方再骰。
   * 【格挡】先显示防守方（先挡），【反击】先显示进攻方（后反击）。
   *
   * @param {string[]} opts.order     出场顺序，如 ["def", "atk"]
   * @param {object}   opts.parts     { atk: 分段[], def: 分段[] }
   * @param {object}   opts.diceType  { atk, def }
   * @param {object}   opts.coins     { atk, def } 行动值硬币数
   * @param {string[]} opts.hitOn     哪几方揭示完毕后播命中声
   * @param {string}   opts.label     中央字样
   * @param {Function} opts.startDice (side) => 该方的骰子动画
   */
  static async playSequence({ order = ["def", "atk"], parts = {}, diceType = {}, coins = {},
                              hitOn = [], label = "", startDice = null, broadcast = true } = {}) {
    if (!this._enabled()) { for (const side of order) startDice?.(side); return; }

    const fxId = this._nextFxId();
    if (broadcast) {
      this._emit({ type: "clashFxStart", fxId, mode: "seq", order, parts, diceType, coins, hitOn, label });
    }

    for (const [i, side] of order.entries()) {
      const sideParts = parts[side] ?? [];
      await this._enterExchange([side], {
        label: i === 0 ? label : "",
        dice:  { [side]: { count: coins[side] ?? 0, type: diceType[side] ?? "default" } },
      });
      const numEl = this._band(side).querySelector(".lcfx-num");
      const raw     = startDice?.(side);
      const rawOne  = Array.isArray(raw) ? raw[0] : raw;
      const [signal] = rawOne ? this._wrapSignals([rawOne], [side], broadcast, fxId) : [null];
      // 本地有骰子动画就等它落定，远端（无骰子）按固定时长滚
      if (signal) await this._rollUntil(numEl, sideParts[0]?.value ?? 0, signal);
      else        await this._rollFor(numEl, sideParts[0]?.value ?? 0);
      await this._sleep(200);
      await this._revealParts(side, sideParts);
      if (hitOn.includes(side)) this._sfx(this._tremorPending ? "tremor" : "hit", 0.8);
      await this._sleep(300);
    }

    await this._sleep(400);
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
    const fxId  = this._nextFxId();
    if (broadcast) this._emit({ type: "clashFxStart", fxId, mode: "solo", side, parts, reroll, label, diceType, coins });

    await this._enterExchange(sides, {
      reroll: reroll ? [side] : [], label,
      dice: { [side]: { count: coins, type: diceType } },
    });

    const [signal] = this._wrapSignals((await startDice?.()) ?? [], sides, broadcast, fxId);
    await this._rollUntil(this._band(side).querySelector(".lcfx-num"), parts[0]?.value ?? 0, signal);

    await this._sleep(260);
    await this._revealParts(side, parts);
    // 【伤害计算】：加值揭示完毕、真正落到伤害上时的命中声
    if (label === this.LABEL_DAMAGE) {
      // 本次拼点发生过【震颤引爆】：命中声静音，那一声由引爆声代表
      if (!this._tremorPending) this._sfx("hit", 0.8);
      this._tremorPending = false;
    }
    await this._sleep(600);
    this._exitExchange();
  }

}
