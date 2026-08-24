/**
 * 【大招就绪】十字星芒闪烁
 * ============================================================================
 * 临时技能转换（relDuration: "afterUse"）把强化形态换上槽位之后，那张大招就
 * 处于"待用"状态——但槽位上除了图标换了一张，没有任何提示。这个模块负责在
 * 就绪的图标上叠一层 X 形星芒闪烁，让 PL 一眼看见。
 *
 * 实现要点：
 * - **canvas 自绘**，不是 CSS 动画。数十颗星也只有一次合成，且形状（细长芒 +
 *   中心亮四角暗的渐变）用 CSS 做不出来。
 * - **单一 rAF 循环**驱动所有实例。每个技能槽各起一条循环的话，六个槽就是六
 *   条，白白烧帧。
 * - 画布**不溢出宿主**：图层取图标尺寸的 4/3（对应 100×100 图层 / 75×75 图标
 *   的实装比例），星芒落在这个范围内，不依赖祖先元素的 overflow。
 * - 表被 render 掉时 DOM 整个换掉，画布随之脱离文档；循环里检测
 *   `isConnected` 自行退租，不需要调用方手动清理。
 */

/** 调试台（sparkle-lab）定稿的参数 */
export const READY_SPARKLE = {
  count:        6,
  density:      0.34,
  area:         "center",
  spreadJitter: 0.55,
  size:         55,
  jitter:       0.6,
  aspect:       0.8,
  width:        2.1,
  angle:        45,
  speed:        0.5,
  stagger:      0.9,
  glow:         0.2,
  drift:        6,
  color:        "#E8CAA2",
};

/** 图层 / 图标 = 100 / 75。星芒的活动范围比图标本身大出这一圈。 */
const LAYER_RATIO = 100 / 75;

/** 参数是按 100×100 图层调的，挂到别的尺寸上时按短边等比缩放 */
const REFERENCE_LAYER = 100;

/* ─── 单一循环的实例表 ─────────────────────────────────────────────────── */

/** @type {Set<object>} */
const instances = new Set();
let   rafId     = 0;
let   lastTime  = 0;
let   clock     = 0;

function makeStars(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      t:  Math.random(), d:  Math.random(),
      u:  Math.random(), v:  Math.random(),
      ph: Math.random(), sz: Math.random(),
    });
  }
  return out;
}

/**
 * 解算一颗星在图层里的坐标。
 * 主轴位置按**序号均分**，再按 spreadJitter 掺入自己的随机数——
 * 抖动为 0 时完全等距，为 1 时退化成纯随机。
 */
function place(st, i, n, w, h, o) {
  const pad   = 2;
  const depth = o.density * Math.min(w, h) * 0.5;

  if (o.area === "fill") {
    const cols = Math.max(1, Math.round(Math.sqrt(n * w / Math.max(h, 1))));
    const rows = Math.ceil(n / cols);
    const cx = i % cols, cy = Math.floor(i / cols);
    const jx = (st.u - 0.5) * o.spreadJitter;
    const jy = (st.v - 0.5) * o.spreadJitter;
    return [
      pad + (w - pad * 2) * Math.min(0.999, Math.max(0, (cx + 0.5 + jx) / cols)),
      pad + (h - pad * 2) * Math.min(0.999, Math.max(0, (cy + 0.5 + jy) / rows)),
    ];
  }

  if (o.area === "center") {
    // 集中：绕中心成环，半径由密集度决定（越小越抱团）。
    // 角度按序号均分，所以不会挤成一坨；抖动只在自己那一份角度里晃。
    const cx  = w / 2, cy = h / 2;
    const ang = ((i + 0.5 + (st.t - 0.5) * o.spreadJitter) / n) * Math.PI * 2;
    const rad = Math.min(w, h) * 0.5 * o.density * (0.4 + st.d * 0.6);
    return [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad];
  }

  if (o.area === "corner") {
    const c   = i % 4;
    const box = depth + 10;
    const ex  = pad + (0.5 + (st.u - 0.5) * o.spreadJitter) * box;
    const ey  = pad + (0.5 + (st.v - 0.5) * o.spreadJitter) * box;
    return [(c === 0 || c === 3) ? ex : w - ex, (c < 2) ? ey : h - ey];
  }

  // 描边：沿周长等距走一圈，再按密集度往内缩
  const per = 2 * (w + h);
  let   p   = (((i + 0.5 + (st.t - 0.5) * o.spreadJitter) / n) + 1) % 1 * per;
  const inw = st.d * depth;
  if (p < w) return [p, inw];
  p -= w;
  if (p < h) return [w - inw, p];
  p -= h;
  if (p < w) return [w - p, h - inw];
  p -= w;
  return [inw, h - p];
}

/**
 * 画一颗四角星（角度 45° 即 "X"）。
 * 四根独立的针：芒宽是绝对像素、不随芒长缩放，所以芒拉多长都还是一根线。
 * 芒身的明暗靠一层径向渐变——中心实色，越往芒尖越透。
 */
function drawStar(ctx, x, y, r, o, alpha, scale) {
  if (alpha <= 0.003 || r <= 0.2) return;
  const rx = r * o.aspect;
  const ry = r;
  const hw = Math.max(0.14, o.width * scale / 2);

  ctx.save();
  ctx.translate(x, y);
  if (o.angle) ctx.rotate(o.angle * Math.PI / 180);
  ctx.globalAlpha = alpha;

  if (o.glow > 0) {
    const gr = Math.max(rx, ry) * 1.15;
    const g  = ctx.createRadialGradient(0, 0, 0, 0, 0, gr);
    g.addColorStop(0,    o.color + "AA");
    g.addColorStop(0.35, o.color + "33");
    g.addColorStop(1,    o.color + "00");
    ctx.globalAlpha = alpha * o.glow * 0.6;
    ctx.fillStyle   = g;
    ctx.beginPath();
    ctx.arc(0, 0, gr, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
  }

  const far  = Math.max(rx, ry);
  const body = ctx.createRadialGradient(0, 0, 0, 0, 0, far);
  body.addColorStop(0,    o.color);
  body.addColorStop(0.18, o.color);
  body.addColorStop(0.55, o.color + "B0");
  body.addColorStop(1,    o.color + "10");
  ctx.fillStyle = body;

  const needle = (lx, ly) => {
    const len = Math.hypot(lx, ly);
    const nx  = -ly / len * hw;
    const ny  =  lx / len * hw;
    ctx.moveTo(nx, ny);
    ctx.quadraticCurveTo(lx * 0.26 + nx * 0.28, ly * 0.26 + ny * 0.28, lx, ly);
    ctx.quadraticCurveTo(lx * 0.26 - nx * 0.28, ly * 0.26 - ny * 0.28, -nx, -ny);
    ctx.closePath();
  };

  ctx.beginPath();
  needle( rx, 0);
  needle(-rx, 0);
  needle(0,  ry);
  needle(0, -ry);
  ctx.fill();

  // 正中心的一点高光，压住渐变让核心更实
  const core = Math.max(0.6, r * 0.13);
  const cg   = ctx.createRadialGradient(0, 0, 0, 0, 0, core);
  cg.addColorStop(0, o.color);
  cg.addColorStop(1, o.color + "00");
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(0, 0, core, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function tick(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  for (const inst of instances) {
    // 宿主已经被 render 换掉：自行退租
    if (!inst.canvas.isConnected) { instances.delete(inst); continue; }
  }
  if (!instances.size) { rafId = 0; return; }

  clock += dt * READY_SPARKLE.speed;
  const o = READY_SPARKLE;

  for (const inst of instances) {
    const { ctx, w, h, stars, scale } = inst;
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < stars.length; i++) {
      const st    = stars[i];
      const phase = (clock * 0.8 + st.ph * o.stagger) % 1;
      const wave  = Math.sin(phase * Math.PI);
      const alpha = wave * wave;

      const [x, y0] = place(st, i, stars.length, w, h, o);
      const y = y0 - o.drift * scale * phase;
      const r = o.size * scale
              * (1 - o.jitter + st.sz * o.jitter * 2) * 0.5
              * (0.35 + alpha * 0.65);
      drawStar(ctx, x, y, r, o, alpha, scale);
    }
  }

  rafId = requestAnimationFrame(tick);
}

function ensureLoop() {
  if (rafId) return;
  lastTime = performance.now();
  rafId    = requestAnimationFrame(tick);
}

/* ─── 对外接口 ─────────────────────────────────────────────────────────── */

/**
 * 在一个图标元素上叠加"就绪"星芒。
 *
 * 画布挂在图标的**父元素**上，居中覆盖并向外扩到图标的 4/3 —— 所以父元素需要
 * 是 position:relative 且 overflow 可见。战斗页的 `.combat-skill-slot-wrap`、
 * SquadHUD 的 `.squad-member` 都满足；不满足时会退化成只覆盖图标本身。
 *
 * @param {HTMLElement} iconEl 图标元素（技能槽 / 头像）
 * @returns {HTMLCanvasElement|null}
 */
export function attachReadySparkle(iconEl) {
  if (!iconEl?.isConnected) return null;
  const host = iconEl.parentElement;
  if (!host) return null;

  // 同一个图标已经挂过就不重复挂（战斗槽会被反复重绘）
  if (iconEl.dataset.sparkleOn === "1") return null;
  iconEl.dataset.sparkleOn = "1";

  const iw = iconEl.offsetWidth  || 52;
  const ih = iconEl.offsetHeight || 52;
  const w  = Math.round(iw * LAYER_RATIO);
  const h  = Math.round(ih * LAYER_RATIO);
  // 参数按 100×100 图层调的，挂到小图标上整体等比缩小
  const scale = Math.min(w, h) / REFERENCE_LAYER;

  const canvas = document.createElement("canvas");
  canvas.className = "limbus-ready-sparkle";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  // 图层中心对齐图标中心
  Object.assign(canvas.style, {
    position:      "absolute",
    left:          (iconEl.offsetLeft - (w - iw) / 2) + "px",
    top:           (iconEl.offsetTop  - (h - ih) / 2) + "px",
    width:         w + "px",
    height:        h + "px",
    pointerEvents: "none",
    zIndex:        "5",
  });
  host.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  instances.add({ canvas, ctx, w, h, scale, stars: makeStars(READY_SPARKLE.count) });
  ensureLoop();
  return canvas;
}

/** 移除某个宿主下所有已挂的星芒画布，并清掉图标上的挂载标记 */
export function clearReadySparkles(root) {
  const el = root?.[0] ?? root;
  if (!el?.querySelectorAll) return;
  el.querySelectorAll("canvas.limbus-ready-sparkle").forEach(c => c.remove());
  el.querySelectorAll("[data-sparkle-on]").forEach(n => delete n.dataset.sparkleOn);
}

/**
 * 该角色当前处于"就绪"状态的技能 id 集合。
 * 直接读临时技能转换的登记：`to` 就是被换上槽位、还没被投出去的强化形态。
 * @param {Actor} actor
 * @returns {Set<string>}
 */
export function readySkillIds(actor) {
  const list = actor?.getFlag?.("limbusCompany_FVTT", "tempSkillConverts") ?? [];
  return new Set(list.filter(r => r?.until === "afterUse" && r?.to).map(r => r.to));
}

/**
 * 给一棵已渲染的 DOM 树里所有"就绪"的技能槽挂上星芒。
 * @param {HTMLElement|jQuery} html
 * @param {Actor} actor
 * @param {string} selector 槽位选择器（元素上需带 data-item-id）
 */
export function decorateReadySlots(html, actor, selector) {
  const root = html?.[0] ?? html;
  if (!root?.querySelectorAll) return;
  const ready = readySkillIds(actor);
  if (!ready.size) return;
  for (const el of root.querySelectorAll(selector)) {
    const id = el.dataset?.itemId;
    if (id && ready.has(id)) attachReadySparkle(el);
  }
}

/**
 * 先清后挂。战斗槽的 DOM 是复用的（`_renderCombatSlots` 只改 src 和
 * data-item-id，不重建元素），所以每次重绘都要把旧画布撤掉再按新内容挂，
 * 否则技能一换，星芒会留在错的槽上。
 * @param {HTMLElement|jQuery} html
 * @param {Actor} actor
 * @param {string} [selector]
 */
export function refreshReadySlots(html, actor, selector = ".combat-skill-slot[data-item-id]") {
  clearReadySparkles(html);
  decorateReadySlots(html, actor, selector);
}
