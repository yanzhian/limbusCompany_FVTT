/**
 * clash-vfx.mjs — 拼点小特效（破币 / 瞬移）
 *
 * 两种特效，都是纯 DOM + CSS，不依赖任何图片素材：
 *   ① 破币：两圈空心圆由小扩大淡出，上层再炸一圈火花。
 *      炸在场上两个 token 的正中间——刀剑相击的那一点，画在 #hud 层。
 *   ② 瞬移：沿"起点 → 终点"拉一束风线，起点留一个残影圆环。
 *      画在 #hud 层（画布坐标），跟着画布平移缩放走。
 *
 * 三者都由某一台机器（多数时候是 GM）驱动，需要广播给所有人。
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

  /** 画布坐标层（瞬移用，挂进 #hud，由 canvas.hud.align() 带着走） */
  static _canvasLayer = null;
  static _hudLayer() {
    if (this._canvasLayer?.isConnected) return this._canvasLayer;
    const hud = document.getElementById("hud");
    if (!hud) return null;
    const el = document.createElement("div");
    el.id = "limbus-clash-vfx-canvas";
    el.className = "lcvfx-layer";
    hud.appendChild(el);
    this._canvasLayer = el;
    return el;
  }

  /** 屏幕坐标层（角色卡 / 快捷 HUD 上的特效用，挂在 body 上） */
  static _screenLayer = null;
  static _uiLayer() {
    if (this._screenLayer?.isConnected) return this._screenLayer;
    const el = document.createElement("div");
    el.id = "limbus-clash-vfx-screen";
    el.className = "lcvfx-layer";
    document.body.appendChild(el);
    this._screenLayer = el;
    return el;
  }

  static _autoRemove(el, extraMs = 400) {
    el.addEventListener("animationend", () => el.remove());
    setTimeout(() => el.remove(), extraMs + 2000);
  }

  /* ─── ① 破币：空心圆 + 火花 ──────────────────────────────────────────── */

  /**
   * 在画布坐标处炸一朵（两个 token 的正中间）。
   * @param {{x: number, y: number}} point 画布坐标
   */
  static burst(point) {
    if (!this.ENABLED || !point) return;
    const layer = this._hudLayer();
    if (!layer) return;
    const { x, y } = point;
    // 尺寸跟着格子走，缩放画布时不会忽大忽小
    const size = (canvas?.grid?.size ?? 100) * this.BURST_SCALE;

    for (const cls of ["lcvfx-ring", "lcvfx-ring lcvfx-ring--inner"]) {
      const ring = document.createElement("div");
      ring.className = cls;
      ring.style.left = `${x}px`;
      ring.style.top  = `${y}px`;
      ring.style.width = ring.style.height = `${size}px`;
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
      s.style.setProperty("--d", `${size * 0.5 * (0.7 + Math.random() * 0.6)}px`);
      s.style.width = `${size * 0.32}px`;
      s.style.animationDelay = `${Math.random() * 60}ms`;
      box.appendChild(s);
    }
    layer.appendChild(box);
    setTimeout(() => box.remove(), 1600);
  }

  /**
   * 在屏幕坐标处炸一朵（界面元素用，比如 6bag 里被丢弃的技能）。
   * @param {number} x  clientX
   * @param {number} y  clientY
   * @param {number} size 圆环直径（px）
   */
  static burstAt(x, y, size = 90) {
    if (!this.ENABLED) return;
    const layer = this._uiLayer();
    if (!layer) return;

    for (const cls of ["lcvfx-ring", "lcvfx-ring lcvfx-ring--inner"]) {
      const ring = document.createElement("div");
      ring.className = cls;
      ring.style.left = `${x}px`;
      ring.style.top  = `${y}px`;
      ring.style.width = ring.style.height = `${size}px`;
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
      const sp = document.createElement("div");
      sp.className = "lcvfx-spark";
      sp.style.setProperty("--a", `${(360 / n) * i + (Math.random() * 20 - 10)}deg`);
      sp.style.setProperty("--d", `${size * 0.5 * (0.7 + Math.random() * 0.6)}px`);
      sp.style.width = `${size * 0.32}px`;
      sp.style.animationDelay = `${Math.random() * 60}ms`;
      box.appendChild(sp);
    }
    layer.appendChild(box);
    setTimeout(() => box.remove(), 1600);
  }

  /** 在某个 DOM 元素中心炸一朵（尺寸默认取元素外接尺寸的 1.4 倍） */
  static burstOnElement(el, scale = 1.4) {
    const node = el?.jquery ? el[0] : el;
    if (!node?.getBoundingClientRect) return;
    const r = node.getBoundingClientRect();
    if (!r.width && !r.height) return;
    this.burstAt(r.left + r.width / 2, r.top + r.height / 2, Math.max(r.width, r.height) * scale);
  }

  /** 火花数量 / 整体尺寸相对格子的倍数（其余参数在 CSS 变量里） */
  static SPARK_COUNT = 10;
  static BURST_SCALE = 1.5;

  /** 破币特效 + 广播给其他客户端 */
  static broadcastBurst(point) {
    this.burst(point);
    this._emit({ type: "clashVfx", kind: "burst", point });
  }

  /** 两个 Actor 的 token 连线中点——刀剑相击的那一点 */
  static midPoint(a, b) {
    const pa = this.centerOf(a), pb = this.centerOf(b);
    if (!pa || !pb) return null;
    return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
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

  /* ─── 容量扩散：累计 TOTAL 与 +N ────────────────────────────────────── */

  /** 常驻 TOTAL 数字（屏幕顶部中央），累计本次扩散打出的总伤害 */
  static _totalEl = null;
  static _totalBox() {
    if (this._totalEl?.isConnected) return this._totalEl;
    const layer = this._uiLayer();
    if (!layer) return null;
    const box = document.createElement("div");
    box.className = "lcvfx-totalbar";
    box.innerHTML = `<span class="k">TOTAL</span><span class="v">0</span><span class="combo"></span>`;
    layer.appendChild(box);
    this._totalEl = box;
    return box;
  }

  /** 显示 TOTAL（起始值 = 拼点那一击的伤害） */
  static totalShow(value = 0, hits = 1) {
    const box = this._totalBox();
    if (!box) return;
    box.classList.add("on");
    box.querySelector(".v").textContent = value;
    this._totalGlow(hits);
  }

  /** 辉光 / 连击徽标随命中次数增强（2 连开始亮，5 连拉满） */
  static _totalGlow(hits = 1) {
    const box = this._totalEl;
    if (!box) return;
    const g = Math.min(1, Math.max(0, (hits - 1) / 4));
    box.querySelector(".v").style.setProperty("--glow", g.toFixed(2));
    const c = box.querySelector(".combo");
    c.textContent = hits > 1 ? `${hits} 连击` : "";
    c.classList.toggle("on", hits > 1);
  }

  /** TOTAL 从 from 累加到 to（逐格往上走，不随机跳动） */
  static async totalTick(from, to, ms = 200, hits = 1) {
    const box = this._totalBox();
    if (!box) return;
    box.classList.add("on");
    const el = box.querySelector(".v");
    this._totalGlow(hits);
    el.classList.add("tick");
    const steps = Math.min(14, Math.max(1, to - from));
    for (let i = 1; i <= steps; i++) {
      el.textContent = Math.round(from + (to - from) * (i / steps));
      await new Promise(r => setTimeout(r, ms / steps));
    }
    el.textContent = to;
    setTimeout(() => el.classList.remove("tick"), 90);
  }

  /** 打完定格：闪一下白，随后淡出 */
  static totalFinish(holdMs = 1400) {
    const box = this._totalEl;
    if (!box) return;
    const el = box.querySelector(".v");
    el.classList.remove("finish");
    void el.offsetWidth;                 // 强制重排，动画可重复播放
    el.classList.add("finish");
    setTimeout(() => box.classList.remove("on"), holdMs);
  }

  /** 目标处飘出 +N（画布坐标） */
  static plus(point, value) {
    if (!this.ENABLED || !point) return;
    const layer = this._hudLayer();
    if (!layer) return;
    const el = document.createElement("div");
    el.className = "lcvfx-plus";
    el.style.left = `${point.x}px`;
    el.style.top  = `${point.y}px`;
    el.textContent = `+${value}`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 700);
  }

  /* 广播版本：容量扩散由发起方驱动，其他客户端跟着演 */
  static broadcastPlus(point, value) {
    this.plus(point, value);
    this._emit({ type: "clashVfx", kind: "plus", point, value });
  }
  static broadcastTotalShow(value, hits) {
    this.totalShow(value, hits);
    this._emit({ type: "clashVfx", kind: "totalShow", value, hits });
  }
  static broadcastTotalTick(from, to, ms, hits) {
    this._emit({ type: "clashVfx", kind: "totalTick", from, to, ms, hits });
    return this.totalTick(from, to, ms, hits);
  }
  static broadcastTotalFinish() {
    this.totalFinish();
    this._emit({ type: "clashVfx", kind: "totalFinish" });
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
    if (msg.kind === "burst") this.burst(msg.point);
    else if (msg.kind === "dash") this.dash(msg.from, msg.to);
    else if (msg.kind === "pan") this.panTo(msg.point);
    else if (msg.kind === "plus") this.plus(msg.point, msg.value);
    else if (msg.kind === "totalShow") this.totalShow(msg.value, msg.hits);
    else if (msg.kind === "totalTick") this.totalTick(msg.from, msg.to, msg.ms, msg.hits);
    else if (msg.kind === "totalFinish") this.totalFinish();
  }
}
