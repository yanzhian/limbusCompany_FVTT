/**
 * clash-vfx.mjs — 拼点小特效（破币 / 瞬移）
 *
 * 两种特效，都是纯 DOM + CSS，不依赖任何图片素材：
 *   ① 破币：两圈空心圆由小扩大淡出，上层再炸一圈火花。
 *      画在演出层（屏幕坐标），因为硬币本来就画在黑条上。
 *   ② 瞬移：沿"起点 → 终点"拉一束风线，起点留一个残影圆环。
 *      画在 #hud 层（画布坐标），跟着画布平移缩放走。
 *
 * 破币是各客户端各自演出时本地触发的，不必广播；瞬移与镜头推移由某一台机器
 * （多数时候是 GM）驱动，需要广播给所有人。
 */

export class ClashVFX {

  /** 系统 socket 频道（与 ClashManager 共用同一条） */
  static SOCKET = "system.limbusCompany_FVTT";

  /** 总开关 */
  static ENABLED = true;

  static _emit(payload) {
    try { game.socket?.emit?.(this.SOCKET, payload); } catch (err) { /* 单机或断线时忽略 */ }
  }

  /* ─── 图层 ────────────────────────────────────────────────────────────── */

  /** 屏幕坐标层（破币用，盖在黑条上） */
  static _screen = null;
  static _screenLayer() {
    if (this._screen?.isConnected) return this._screen;
    const el = document.createElement("div");
    el.id = "limbus-clash-vfx";
    document.body.appendChild(el);
    this._screen = el;
    return el;
  }

  /** 画布坐标层（瞬移用，挂进 #hud，由 canvas.hud.align() 带着走） */
  static _canvasLayer = null;
  static _hudLayer() {
    if (this._canvasLayer?.isConnected) return this._canvasLayer;
    const hud = document.getElementById("hud");
    if (!hud) return null;
    const el = document.createElement("div");
    el.id = "limbus-clash-vfx-canvas";
    hud.appendChild(el);
    this._canvasLayer = el;
    return el;
  }

  static _autoRemove(el, extraMs = 400) {
    el.addEventListener("animationend", () => el.remove());
    setTimeout(() => el.remove(), extraMs + 2000);
  }

  /* ─── ① 破币：空心圆 + 火花 ──────────────────────────────────────────── */

  /**
   * 在屏幕坐标处炸一朵。
   * @param {number} x 屏幕 X（px）
   * @param {number} y 屏幕 Y（px）
   */
  static burst(x, y) {
    if (!this.ENABLED) return;
    const layer = this._screenLayer();

    for (const cls of ["lcvfx-ring", "lcvfx-ring lcvfx-ring--inner"]) {
      const ring = document.createElement("div");
      ring.className = cls;
      ring.style.left = `${x}px`;
      ring.style.top  = `${y}px`;
      this._autoRemove(ring);
      layer.appendChild(ring);
    }

    const n = this.SPARK_COUNT;
    if (n <= 0) return;
    const box = document.createElement("div");
    box.className = "lcvfx-sparks";
    box.style.left = `${x}px`;
    box.style.top  = `${y}px`;
    for (let i = 0; i < n; i++) {
      const s = document.createElement("div");
      s.className = "lcvfx-spark";
      // 均匀分布再加一点随机，免得看着像时钟刻度
      s.style.setProperty("--a", `${(360 / n) * i + (Math.random() * 20 - 10)}deg`);
      s.style.setProperty("--d", `${this.SPARK_DIST * (0.7 + Math.random() * 0.6)}px`);
      s.style.animationDelay = `${Math.random() * 60}ms`;
      box.appendChild(s);
    }
    layer.appendChild(box);
    setTimeout(() => box.remove(), 1600);
  }

  /** 火花数量与飞出距离（其余参数在 CSS 变量里） */
  static SPARK_COUNT = 10;
  static SPARK_DIST  = 70;

  /** 直接对着某个 DOM 元素（比如黑条上的那枚硬币）炸 */
  static burstOn(el) {
    if (!el || !this.ENABLED) return;
    const r = el.getBoundingClientRect();
    this.burst(r.left + r.width / 2, r.top + r.height / 2);
  }

  /* ─── ② 瞬移：风线 + 残影 ────────────────────────────────────────────── */

  /**
   * 从 from 疾驰到 to（均为画布坐标）。
   */
  static dash(from, to) {
    if (!this.ENABLED) return;
    const layer = this._hudLayer();
    if (!layer || !from || !to) return;

    // 起点残影
    const ghost = document.createElement("div");
    ghost.className = "lcvfx-ghost";
    ghost.style.left = `${from.x}px`;
    ghost.style.top  = `${from.y}px`;
    const size = canvas?.grid?.size ?? 100;
    ghost.style.width = ghost.style.height = `${size}px`;
    this._autoRemove(ghost);
    layer.appendChild(ghost);

    // 风线
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const dash = document.createElement("div");
    dash.className = "lcvfx-dash";
    dash.style.left = `${from.x}px`;
    dash.style.top  = `${from.y}px`;
    dash.style.width = `${len}px`;
    dash.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI}deg)`;

    const n = this.WIND_LINES;
    for (let i = 0; i < n; i++) {
      const w = document.createElement("div");
      w.className = "lcvfx-wind";
      const off = (i / Math.max(1, n - 1) - 0.5) * this.WIND_SPREAD;
      const seg = len * (0.55 + Math.random() * 0.45);
      w.style.top   = `${off}px`;
      w.style.width = `${seg}px`;
      w.style.left  = `${Math.random() * (len - seg)}px`;
      w.style.animationDelay = `${Math.random() * 90}ms`;
      dash.appendChild(w);
    }
    layer.appendChild(dash);
    setTimeout(() => dash.remove(), 1600);
  }

  /** 风线条数与散布范围（其余参数在 CSS 变量里） */
  static WIND_LINES  = 9;
  static WIND_SPREAD = 46;

  /** 瞬移特效 + 广播给其他客户端 */
  static broadcastDash(from, to) {
    this.dash(from, to);
    this._emit({ type: "clashVfx", kind: "dash", from, to });
  }

  /* ─── 镜头 ────────────────────────────────────────────────────────────── */

  /** 把镜头推到某个画布坐标（缩放保持不变） */
  static panTo(point) {
    if (!point || !canvas?.ready) return;
    canvas.animatePan({ x: point.x, y: point.y, duration: this.PAN_MS });
  }
  static PAN_MS = 420;

  /** 镜头推移 + 广播（拼点开场把镜头给进攻方） */
  static broadcastPan(point) {
    this.panTo(point);
    this._emit({ type: "clashVfx", kind: "pan", point });
  }

  /** 取某个 Actor 在当前场景 token 的中心点 */
  static centerOf(actor) {
    if (!actor || !canvas?.ready) return null;
    const tokens = canvas.tokens?.placeables?.filter(t => t.actor?.id === actor.id) ?? [];
    const tok = tokens.find(t => t.controlled) ?? tokens[0];
    return tok ? { x: tok.center.x, y: tok.center.y } : null;
  }

  /* ─── socket ──────────────────────────────────────────────────────────── */

  static handleSocketMsg(msg) {
    if (msg?.type !== "clashVfx") return;
    if (msg.kind === "dash") this.dash(msg.from, msg.to);
    else if (msg.kind === "pan") this.panTo(msg.point);
  }
}
