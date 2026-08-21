/**
 * clash-flow-edge.mjs — TOTAL 黑条的流动边框
 *
 * 在每条黑条**朝向屏幕中心**的那条长边上，画一条会流动的金色流体带：
 * 上下两条边各自独立起伏（撕裂感），边缘被随流体一起走的缺口啃出参差，
 * 鼓包处带高光核 —— 整体是"液态金属被推着走"而不是"渐变图案在平移"。
 *
 * 与 ClashTotalFX 的关系：本模块只负责画，出场/退场/破币的时机由
 * ClashTotalFX 在 _bandsIn / _bandsOut / _reset / _breakDie 里调进来。
 *
 * 几何要点：黑条是 260vmax 宽且 rotate 过的，两端都在屏幕外。canvas 作为
 * 黑条的子元素跟着一起转，但**只覆盖屏幕可见的那一段**（FLOW_SPAN），
 * 不然要逐帧算 260vmax 宽的路径，纯属浪费。
 */

export class ClashFlowEdge {
  /* ─── 观感参数（原型 flow-band.html 调出来的一套） ──────────────────── */

  static P = {
    thick:  21,     // 粗细
    speed:  0.82,   // 常态流速
    visc:   0.64,   // 粘稠度：厚度鼓包的深浅
    tear:   0.78,   // 撕裂：上下沿各自独立起伏的程度
    hole:   1.50,   // 镂空：边缘缺口的深度与数量
    amp:    4,      // 起伏：中心线摆动幅度
    dens:   2.4,    // 疏密：行波的空间频率
    glow:   0.0,    // 辉光（0 = 不加 shadowBlur，最省）
    burstX: 8.5,    // 破币提速倍率
    burstT: 0.40,   // 破币变细系数
    burstMs: 420,   // 破币持续时长
  };

  /** canvas 覆盖的宽度（vmax）。屏幕最宽 100vmax，留足旋转后的余量 */
  static FLOW_SPAN = 120;
  /** canvas 相对黑条左端的偏移（vmax）。黑条 left:-60vmax，宽 260vmax */
  static FLOW_LEFT = 52;

  static _states = new Map();   // side → { canvas, ctx, w, h, dpr }
  static _raf     = null;
  static _phase   = 0;
  static _last    = 0;
  static _boost   = 1;
  static _thinT   = 1;
  static _thin    = 1;
  static _until   = 0;
  static _active  = new Set();

  /* ─── 生命周期 ─────────────────────────────────────────────────────── */

  /**
   * 给某条黑条挂上 canvas（幂等，重复调用只会取到已有的那块）。
   * @param {HTMLElement} band  .lcfx-band 元素
   * @param {"atk"|"def"} side
   */
  static attach(band, side) {
    if (!band) return null;
    let cv = band.querySelector(".lcfx-flow");
    if (!cv) {
      cv = document.createElement("canvas");
      cv.className = "lcfx-flow";
      band.appendChild(cv);
    }
    const st = this._states.get(side) ?? {};
    st.canvas = cv;
    st.ctx    = cv.getContext("2d");
    this._states.set(side, st);
    this._resize(side);
    return cv;
  }

  /** 开始渲染某一侧（黑条切入时调） */
  static start(side, band) {
    this.attach(band, side);
    this._active.add(side);
    if (!this._raf) {
      this._last = performance.now();
      this._raf  = requestAnimationFrame(t => this._frame(t));
    }
  }

  /** 停止某一侧；全部停掉时连 rAF 一起撤，不留空转 */
  static stop(side) {
    this._active.delete(side);
    const st = this._states.get(side);
    if (st?.ctx) st.ctx.clearRect(0, 0, st.w, st.h);
    if (this._active.size === 0 && this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
      this._boost = 1; this._thinT = 1; this._thin = 1;
    }
  }

  static stopAll() {
    for (const side of [...this._active]) this.stop(side);
  }

  /** 硬币破碎：瞬间提速 + 收细，到点立刻回落 */
  static burst() {
    this._boost = this.P.burstX;
    this._thinT = this.P.burstT;
    this._until = performance.now() + this.P.burstMs;
  }

  /* ─── 画布尺寸 ─────────────────────────────────────────────────────── */

  static _resize(side) {
    const st = this._states.get(side);
    if (!st?.canvas) return;
    // 黑条是 rotate 过的，getBoundingClientRect 给的是外接矩形而非元素自身尺寸，
    // 这里必须用 offsetWidth/Height（布局尺寸，不受 transform 影响）
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w   = Math.max(1, st.canvas.offsetWidth);
    const h   = Math.max(1, st.canvas.offsetHeight);
    if (st.w === w && st.h === h && st.dpr === dpr) return;
    st.w = w; st.h = h; st.dpr = dpr;
    st.canvas.width  = Math.round(w * dpr);
    st.canvas.height = Math.round(h * dpr);
    st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ─── 主循环 ───────────────────────────────────────────────────────── */

  static _frame(now) {
    const dt = Math.min(50, now - this._last);
    this._last = now;

    if (now > this._until) { this._boost = 1; this._thinT = 1; }
    // 厚度做一点跟随，免得 21px → 8px 的跳变太生硬
    this._thin += (this._thinT - this._thin) * Math.min(1, dt / 60);
    this._phase += dt * 0.006 * this.P.speed * this._boost;

    for (const side of this._active) this._draw(side);

    this._raf = this._active.size ? requestAnimationFrame(t => this._frame(t)) : null;
  }

  /**
   * 流向：顺时针 —— 屏幕上沿向右、下沿向左。
   * 守方黑条在上（dir=+1），攻方在下（dir=-1）。
   */
  static _dirOf(side) {
    return side === "def" ? 1 : -1;
  }

  static _draw(side) {
    const st = this._states.get(side);
    if (!st?.ctx) return;
    this._resize(side);
    const { ctx, w: W, h: H } = st;
    ctx.clearRect(0, 0, W, H);

    const cy  = H / 2;
    const dir = this._dirOf(side);
    const ph  = this._phase * dir;
    const th  = this.P.thick * this._thin;

    // 底衬：一条极暗的常亮线，流体没经过的地方也不至于完全空掉
    ctx.strokeStyle = "rgba(253,239,142,.09)";
    ctx.lineWidth = Math.max(1, this.P.thick * 0.12);
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();

    const glow = this._boost > 1 ? this.P.glow * 1.6 : this.P.glow;

    // 双股缠绕：主股 + 一股更快更细的副股
    this._strand(ctx, W, { cy, thick: th, amp: this.P.amp, ph,
      kw: .62, kt: 1.0, seed: 0, alpha: .92, glow });
    this._strand(ctx, W, { cy, thick: th * .72, amp: this.P.amp * 1.35, ph: ph + 2.6,
      kw: .83, kt: 1.45, seed: 1.9, speedMul: 1.28, body: "#FFD86A", alpha: .72, glow });

    this._erode(ctx, W, cy, th, ph, dir);
  }

  /** 一股流体：上下两条边各自独立起伏，鼓包处带高光核 */
  static _strand(ctx, W, o) {
    const { cy, thick, amp, ph, kw, kt, seed = 0, speedMul = 1,
            body = "#FDEF8E", core = "#FFFFFF", alpha = 1, glow = 0 } = o;
    const P = this.P;
    const step = 5, pts = [];

    for (let x = -step; x <= W + step; x += step) {
      const u = x / 180 * P.dens, p = ph * speedMul;

      const mid = cy
        + amp * Math.sin(u * kw - p)
        + amp * .45 * Math.sin(u * kw * 2.3 + p * .6 + seed);

      // 厚度行波：三个频率叠加 → 一段鼓一段瘪
      const wv = Math.sin(u * kt - p * 1.15)
               + Math.sin(u * kt * 1.7 - p * 1.55 + 2.1 + seed) * .6
               + Math.sin(u * kt * .43 - p * .75 + 4.2) * .8;
      const n = (wv / 2.4 + 1) / 2;
      const t = thick * (1 - P.visc + P.visc * (.15 + .85 * n));

      // 撕裂：上下沿各叠一套独立的高频扰动
      const tu = Math.sin(u * kt * 2.9 - p * 1.9 + seed)       * .5
               + Math.sin(u * kt * 5.3 - p * 2.7 + seed * 2)   * .3;
      const tb = Math.sin(u * kt * 3.3 - p * 2.1 + seed + 3.7) * .5
               + Math.sin(u * kt * 6.1 - p * 3.1 + seed * 1.6) * .3;
      const e = P.tear * t * .55;

      pts.push({ x, top: mid - t / 2 + tu * e, bot: mid + t / 2 + tb * e, mid, t, n });
    }

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].top);
    for (const q of pts) ctx.lineTo(q.x, q.top);
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].bot);
    ctx.closePath();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = body;
    if (glow > 0) { ctx.shadowColor = body; ctx.shadowBlur = 16 * glow; }
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < pts.length - 1; i++) {
      const q = pts[i];
      if (q.n < .5) continue;
      ctx.beginPath(); ctx.moveTo(q.x, q.mid); ctx.lineTo(pts[i + 1].x, pts[i + 1].mid);
      ctx.lineWidth = Math.max(.8, q.t * .26);
      ctx.strokeStyle = core;
      ctx.globalAlpha = alpha * (q.n - .5) / .5 * .9;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  /**
   * 镂空：只从上下两条边往里啃，中间不破。
   * 圆心压在边线略靠外的位置，所以椭圆只有内侧小半覆盖到带子上，
   * 啃出来的是缺口而不是窟窿；每个缺口有自己的呼吸相位，时大时小。
   */
  static _erode(ctx, W, cy, thick, ph, dir) {
    const P = this.P;
    if (P.hole <= 0) return;
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";

    const N = Math.round(W / 90 * P.hole * 2.4);
    const span = W + 500;
    for (let i = 0; i < N; i++) {
      const s  = i * 2.399963;                    // 黄金角散布，避免排成规则的一串
      const sp = .7 + .6 * Math.abs(Math.sin(s));
      let x = ((i / N + ph * .012 * sp) % 1) * span - 250;
      if (x < -250) x += span;                    // ph 为负时取模会落到负区
      if (dir < 0) x = span - 250 - x;

      // 跟主流股同一条中心线，缺口才会咬在真正的边上
      const u = x / 180 * P.dens;
      const mid = cy + P.amp * Math.sin(u * .62 - ph)
                     + P.amp * .45 * Math.sin(u * .62 * 2.3 + ph * .6);

      const side  = (i % 2) ? 1 : -1;             // 交替咬上沿 / 下沿
      const pulse = .35 + .65 * (.5 + .5 * Math.sin(ph * 1.6 + s * 2.7));
      const rx = thick * (.30 + .70 * Math.abs(Math.sin(s * 3.1))) * pulse;
      const ry = thick * (.30 + .40 * Math.abs(Math.cos(s * 2.2))) * pulse * P.hole;

      ctx.beginPath();
      ctx.ellipse(x, mid + side * (thick / 2 + ry * .55), rx, ry,
                  Math.sin(s) * .25, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }
}
