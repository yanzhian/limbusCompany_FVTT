/**
 * vfx-stage.mjs —— 攻击特效在 Foundry 里的舞台
 *
 * 一块铺满视口的 canvas，**每帧**按 canvas.stage 的世界变换重投影，
 * 所以特效存的是世界坐标、跟着地图平移缩放走，放大时也不糊
 *（挂进 #hud 让 Foundry 用 CSS 缩放的话，位图会被拉花）。
 *
 * 【为什么按罪孽分成好几块画布】
 * 罪孽色靠色相旋转实现，而 CSS filter 是**整块画布**的属性。攻守两方同时
 * 在中点对撞时要各染各的色，就必须分开画。所以按罪孽各留一块，用到才建。
 *
 * 【为什么不动镜头】
 * 震动只作用在特效自己身上（见 attack-vfx.mjs 的 draw）。接 canvas.stage.pivot
 * 会跟玩家的平移打架，异常一次就永久偏，而且每个客户端视野不同、震幅不一。
 *
 * 对外三个入口，都由 ClashVFX 广播后在各客户端调用：
 *   VfxStage.strike(...)  一次攻击（可连挥）
 *   VfxStage.clash(...)   一次交锋对撞
 *   VfxStage.clear()      清场（脱战 / 关闭演出）
 */

import { AttackVFX, sinFilter } from "./attack-vfx.mjs";

const NS = "limbusCompany_FVTT";

export class VfxStage {

  /** 罪孽 → { canvas, engine }；用到哪个罪孽才建哪块 */
  static _decks = new Map();
  static _root = null;

  /* ─── 设置读取 ─────────────────────────────────────────────────────────── */

  /** 世界设定【演出特效】：full / lite / off */
  static get level() {
    try { return game.settings.get(NS, "vfxLevel") ?? "full"; }
    catch { return "full"; }
  }

  /** 客户端设定【特效震动】：只抖特效自己，不动镜头 */
  static get shakeOn() {
    try { return game.settings.get(NS, "vfxShake") !== false; }
    catch { return true; }
  }

  /**
   * 特效整体缩放。招式是按「一格 100px」画的，所以跟着场景格子走——
   * 不然一格 50px 的场景里，一刀能扫掉半张地图。
   */
  static get scale() {
    let k = 1;
    try { k = game.settings.get(NS, "vfxScale") ?? 1; } catch { /* 用默认 */ }
    const grid = canvas?.grid?.size ?? 100;
    return (grid / 100) * k;
  }

  static get enabled() { return this.level !== "off" && !!canvas?.ready; }

  /* ─── 图层 ─────────────────────────────────────────────────────────────── */

  static _mount() {
    if (this._root?.isConnected) return this._root;
    const el = document.createElement("div");
    el.id = "limbus-vfx-stage";
    // 盖在画布之上、界面之下；一律不吃鼠标
    Object.assign(el.style, {
      position: "fixed", inset: "0", pointerEvents: "none", zIndex: "60",
    });
    document.body.appendChild(el);
    this._root = el;
    this._decks.clear();
    return el;
  }

  /** 取（或建）某个罪孽的那块画布 */
  static _deck(sin) {
    const key = sin || "default";
    const hit = this._decks.get(key);
    if (hit?.canvas?.isConnected) return hit;

    const root = this._mount();
    const cv = document.createElement("canvas");
    Object.assign(cv.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%",
      pointerEvents: "none",
    });
    // 色相旋转：白色芯不受影响，所以高光始终是白的
    if (sin) cv.style.filter = sinFilter(sin);
    root.appendChild(cv);

    const engine = new WorldAttackVFX(cv);
    engine.scale = this.scale;
    engine.garnishOn = true;
    const deck = { canvas: cv, engine };
    this._decks.set(key, deck);
    return deck;
  }

  static clear() {
    for (const { engine } of this._decks.values()) {
      engine.clear();
      engine.sparksList = [];
    }
  }

  static destroy() {
    for (const { engine } of this._decks.values()) engine.destroy();
    this._decks.clear();
    this._root?.remove();
    this._root = null;
  }

  /* ─── 播放 ─────────────────────────────────────────────────────────────── */

  /**
   * 一次攻击。落点是**世界坐标**，语义是「打在这里」。
   * @param {object} o
   * @param {string} o.sin       罪孽（决定颜色）
   * @param {string} o.category  slash / strike / thrust
   * @param {number} o.x @param {number} o.y  世界坐标
   * @param {number} o.aim       朝向弧度（攻方 → 守方）
   * @param {number} [o.swings]  连挥几次（= 骰式里的骰子数量）
   */
  static strike({ sin, category = "slash", x, y, aim = 0, swings = 1 }) {
    if (!this.enabled) return;
    const { engine } = this._deck(sin);
    const lite = this.level === "lite";
    engine.scale = this.scale;
    engine.aim = aim;
    engine.vfxLevel = this.level;
    engine.g.shake.amp = this.shakeOn ? 7 : 0;

    const n = Math.max(1, Math.min(8, swings | 0));
    for (let j = 0; j < n; j++) {
      // 每击落点沿垂直方向错开，连挥才不像同一帧复读
      const k = (j - (n - 1) / 2) * 13 * this.scale;
      const px = x + Math.sin(aim) * k, py = y - Math.cos(aim) * k;
      if (j === 0) engine.play(category, px, py);
      else setTimeout(() => engine.play(category, px, py), j * (lite ? 90 : 135));
    }
  }

  /**
   * 一次交锋：双方同时朝中点挥出，兵器在那里撞上。
   * 火花与破币等到两边**都**够到中点才放。
   */
  static clash({ sinA, sinD, catA = "slash", catD = "slash", x, y, aim = 0, coin = false }) {
    if (!this.enabled) return;
    const a = this._deck(sinA).engine, d = this._deck(sinD).engine;
    for (const [e, ang] of [[a, aim], [d, aim + Math.PI]]) {
      e.scale = this.scale;
      e.aim = ang;
      e.vfxLevel = this.level;
      e.g.shake.amp = this.shakeOn ? 7 : 0;
    }
    a.play(catA, x, y);
    d.play(catD, x, y);

    const wait = Math.max(this._contactMs(a), this._contactMs(d));
    setTimeout(() => {
      a.clashAt(x, y, aim, { side: -1, power: 1.05 });
      d.clashAt(x, y, aim, { side: 1, coin, power: 0.95 });
    }, wait);
  }

  /** 这一发实际打中的时刻（毫秒）。招式各不相同，火花必须踩在那一帧上 */
  static _contactMs(fx) {
    const h = fx.effects.at(-1)?.hits?.[0];
    if (!h) return 90;
    return (h.at ?? 0) + (h.family === "slash" ? fx.contact(h) : (h.contactAt ?? 60));
  }
}

/**
 * 世界坐标版：每帧把画布的基础变换换成 canvas.stage 的世界变换，
 * 于是 effects 里存的 x/y 直接就是世界坐标，平移缩放全自动跟随。
 */
class WorldAttackVFX extends AttackVFX {

  /**
   * fit 原本按画布尺寸算（调参台是固定舞台）。到了场景里应该跟着格子走，
   * 否则同一招在不同缩放的场景里大小乱跳。
   */
  get fit() { return this.scale; }

  draw() {
    const c = this.ctx;
    if (!c) return;
    // 先用单位变换清干净整块位图，再换成世界变换
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const t = canvas?.stage?.worldTransform;
    if (!t) return;
    const k = this.dpr;
    c.setTransform(t.a * k, t.b * k, t.c * k, t.d * k, t.tx * k, t.ty * k);

    const ready = !!this.g;
    c.save();
    if (ready && this.garnishOn && this.shake > 0.004) {
      // 只抖特效自己：这一层平移在世界变换之内，镜头一动不动
      const n = performance.now(), s = this.shake;
      const inv = 1 / (canvas?.stage?.scale?.x || 1);   // 抖动幅度按屏幕像素算
      c.translate(Math.sin(n * 0.091) * this.g.shake.amp * 1.5 * s * inv,
                  Math.cos(n * 0.139) * this.g.shake.amp * s * inv);
    }
    for (const e of this.effects) this.drawSequence(e, this.time - e.start, false);
    if (ready && this.garnishOn) this.drawGarnish();
    c.restore();
  }
}
