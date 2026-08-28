/**
 * token-ring-hud.mjs — Token 脚下的生命环 + HUD
 *
 * 原型见 scratchpad-hp-ring.html，这里是它的 Foundry 实装。
 *
 * **只对战斗追踪器里的参战单位、且战斗已开始时显示**——平时满屏的环与
 * BUFF 是噪音，没参战的路人也不该顶着血环。
 *
 * 画的东西（跟着 Token 移动/缩放）：
 *   · 多边形生命环：只占 [arcStart, arcEnd] 那一段，扣血时空缺从段首长出
 *   · 混乱阈值刻度：越过的变灰（对应 chaosThresholds[i].triggered）
 *   · 生命值数字 / 理智圆形徽章 / BUFF 图标行（每行 6 个，不足一行居中）
 *
 * 环是平躺在地面上的正多边形，按**真实透视**投影到屏幕（与原型同一套公式），
 * 所以近处自然变粗、远处变细——这一半是拉伸椭圆做不出来的。
 * tilt = 0 就是正俯视的正多边形。
 *
 * 所有尺寸以 100px 网格为基准（原型里 token 边长＝一格＝100px），
 * 实际按 canvas.grid.size / 100 缩放，换网格大小不用重调。
 */

/** 原型基准网格：一格 100px。CFG 里所有长度都是这个基准下的像素 */
const BASE_CELL = 100;

const BUFF_ICON_BASE = "systems/limbusCompany_FVTT/assets/icons/Buff_icon/";

/** 内置 BUFF 的图标文件名（与快捷 HUD 同一份表） */
const BUFF_ICON_MAP = {
  strong: "强壮.webp",   weak: "虚弱.webp",   endure: "忍耐.webp",  breach: "破绽.webp",
  swift: "迅捷.webp",    bind: "束缚.webp",   guard: "守护.webp",   fragile: "易损.webp",
  clashPowerUp: "拼点威力提升.webp", clashPowerDown: "拼点威力降低.webp",
  atkLevelUp: "攻击等级提升.webp",   atkLevelDown: "攻击等级降低.webp",
  defLevelUp: "防御等级提升.webp",   defLevelDown: "防御等级降低.webp",
  burn: "烧伤.webp",     bleed: "流血.webp",  tremor: "震颤.webp",  rupture: "破裂.webp",
  sinking: "沉沦.webp",  breathing: "呼吸法.webp", charge: "充能.webp",
  chaos: "陷入混乱.webp", panic: "陷入恐慌.webp",
};

/* 理智值配色：与快捷 HUD 同一套锚点，按数值在三点之间线性插值
   95 = #4F7A9C（蓝，清醒）／50 = #6A6A6A（灰，中间）／5 = #BF2B2A（红，濒临恐慌） */
const SANITY_STOPS = [
  { v:  5, c: [0xBF, 0x2B, 0x2A] },
  { v: 50, c: [0x6A, 0x6A, 0x6A] },
  { v: 95, c: [0x4F, 0x7A, 0x9C] },
];

/**
 * 理智值 → { bg, border }（PIXI 用的 0xRRGGBB 数值）。
 * 描边取底色的 0.62 倍亮度，与快捷 HUD 的圆一致。
 */
function sanityColors(value) {
  const v = Math.max(SANITY_STOPS[0].v, Math.min(SANITY_STOPS[2].v, Number(value) || 0));
  let rgb = SANITY_STOPS[SANITY_STOPS.length - 1].c;
  for (let i = 0; i < SANITY_STOPS.length - 1; i++) {
    const a = SANITY_STOPS[i], b = SANITY_STOPS[i + 1];
    if (v >= a.v && v <= b.v) {
      const t = (v - a.v) / (b.v - a.v);
      rgb = a.c.map((ch, k) => ch + (b.c[k] - ch) * t);
      break;
    }
  }
  const pack = (arr) => arr.reduce(
    (acc, ch) => (acc << 8) | Math.round(Math.max(0, Math.min(255, ch))), 0);
  return { bg: pack(rgb), border: pack(rgb.map(ch => ch * 0.62)) };
}

export class TokenRingHUD {
  /* ─── 配置（原型面板导出的那份） ──────────────────────────────────────── */

  static CFG = {
    // 长度单位＝「一格 100px 时的像素」，实际按 grid.size/100 缩放。
    // 环是平躺在地面上的**正多边形**，用真实透视投影压成扁的：
    // 半径与线宽都是地面平面内的尺寸，投影后近处自然变粗、远处变细。
    sides: 7, radius: 39, thickness: 19, tilt: 69, persp: 520,
    startDeg: 193, ccw: true,
    arcStart: 5, arcEnd: 50,
    showThres: true,
    // 各元素相对 Token 中心的偏移（基准网格下的 px）；ring 是环自己的位置
    pos: { ring: { x: -3, y: 42 },
           hp: { x: -39, y: 29 }, san: { x: 33, y: 30 }, buff: { x: 3, y: 85 } },
    // 颜色
    trackColor: 0xffffff, trackAlpha: 0.13,
    fillColor:  0xe03a3a, fillLowColor: 0xff2d2d, lowAt: 0.3,
    thresColor: 0xffffff, thresDoneColor: 0x7a6b8c,
    // HUD 尺寸（同样是基准网格下的 px）
    hpFont: 23, sanSize: 28, sanFont: 15,
    // BUFF 行
    buffIcon: 30, buffGap: 7, buffPerRow: 6,
  };

  static _enabled = true;

  /* ─── 注册 ────────────────────────────────────────────────────────────── */

  static init() {
    game.settings.register("limbusCompany_FVTT", "tokenRingHud", {
      name: "Token 生命环 HUD",
      hint: "遭遇战期间，为参战单位在 Token 脚下显示生命环、生命值、理智与 BUFF 图标。",
      scope: "client", config: true, type: Boolean, default: true,
      onChange: (v) => { TokenRingHUD._enabled = v; TokenRingHUD.refreshAll(); },
    });
  }

  static ready() {
    TokenRingHUD._enabled = game.settings.get("limbusCompany_FVTT", "tokenRingHud") ?? true;

    Hooks.on("drawToken",    (token) => TokenRingHUD.draw(token));
    Hooks.on("refreshToken", (token) => TokenRingHUD.draw(token));
    Hooks.on("destroyToken", (token) => TokenRingHUD._destroy(token));
    // 遭遇战开始/结束 → 整场重画（开战才显示，脱战即收起）
    Hooks.on("combatStart",  () => TokenRingHUD.refreshAll());
    Hooks.on("createCombat", () => TokenRingHUD.refreshAll());
    Hooks.on("updateCombat", () => TokenRingHUD.refreshAll());
    Hooks.on("deleteCombat", () => TokenRingHUD.refreshAll());
    // 参战名单增删 → 该 Token 的环要跟着出现/收起
    Hooks.on("createCombatant", () => TokenRingHUD.refreshAll());
    Hooks.on("deleteCombatant", () => TokenRingHUD.refreshAll());
    Hooks.on("canvasReady",  () => TokenRingHUD.refreshAll());
    // 选中/取消选中 → 只改层级，不用整个重画
    Hooks.on("controlToken", (token) => TokenRingHUD._applySort(token));
    Hooks.on("hoverToken",   (token) => TokenRingHUD._applySort(token));
    // 血量/理智/BUFF/混乱阈值变化 → 重画该角色的所有 Token
    Hooks.on("updateActor",  (actor) => TokenRingHUD.refreshActor(actor));

    TokenRingHUD.refreshAll();
  }

  /**
   * 层级：默认排在**自己这个 Token 之下**（sort - 1），于是上方单位的环与
   * BUFF 会被下方单位的立绘盖住；选中或悬停时抬到最高，需要看清就点一下。
   *
   * 覆盖层挂在 canvas.primary（立绘所在的组）里才可能被别的立绘遮住——
   * 挂在 Token 自己身上等于挂进 interface 层，那一层永远画在所有立绘之上。
   */
  static _applySort(token) {
    const box = token?._limbusRing;
    if (!box || box.destroyed) return;
    const doc = token.document;
    const on  = token.controlled || token.hover;
    box.elevation = doc?.elevation ?? 0;
    box.sort      = on ? 1e6 : (doc?.sort ?? 0) - 1;
    if (canvas?.primary) canvas.primary.sortDirty = true;
  }

  /**
   * 这个 Token 现在该不该显示生命环：**战斗已开始** 且 **它本人在战斗追踪器里**。
   *
   * · 判 `started` 而不是「战斗文档存在」：GM 把人拖进追踪器、还没点
   *   【开始战斗】的布置阶段不显示。
   * · 再按 tokenId 核对参战名单：同场景里的路人、场景装饰用的角色 Token
   *   没被拉进这场遭遇战，就不该顶着一圈血环。
   */
  static _showsFor(token) {
    const combat = game.combat;
    if (!combat?.started) return false;
    const id = token?.document?.id ?? token?.id;
    if (!id) return false;
    return (combat.combatants ?? []).some(c => c.tokenId === id);
  }

  static refreshAll() {
    for (const token of (canvas?.tokens?.placeables ?? [])) TokenRingHUD.draw(token);
  }

  static refreshActor(actor) {
    if (!actor) return;
    for (const token of (canvas?.tokens?.placeables ?? [])) {
      if (token.actor?.id === actor.id) TokenRingHUD.draw(token);
    }
  }

  /* ─── 几何 ────────────────────────────────────────────────────────────── */

  /* 地面平面内的正多边形顶点（半径 r，已按 scale 缩放） */
  static _polyAt(r, scale) {
    const c = TokenRingHUD.CFG;
    const rr = r * scale;
    const a0 = c.startDeg * Math.PI / 180;
    const step = (2 * Math.PI / c.sides) * (c.ccw ? -1 : 1);
    const pts = [];
    for (let i = 0; i < c.sides; i++) {
      const a = a0 + i * step;
      pts.push({ x: rr * Math.cos(a), y: rr * Math.sin(a) });
    }
    pts.push({ ...pts[0] });
    return pts;
  }

  /**
   * 地面 → 屏幕。就是旧原型那段 CSS 干的事：
   * rotateX(tilt) 得到 (x, y·cos, y·sin)，再按透视距离做除法。
   * 射影变换保直线，所以多边形的边投影后仍是直线，无需密集采样。
   */
  static _project(p, scale) {
    const c = TokenRingHUD.CFG;
    const t = c.tilt * Math.PI / 180;
    const P = c.persp * scale;
    const z = p.y * Math.sin(t);
    const k = P / Math.max(1, P - z);
    return { x: p.x * k, y: p.y * Math.cos(t) * k };
  }

  /** 折线各段长度与总长 */
  static _measure(pts) {
    const segs = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      segs.push(d); total += d;
    }
    return { segs, total };
  }

  /** 沿中心线走 dist：点、法线、落在第几条边上 */
  static _walk(pts, segs, dist) {
    let d = Math.max(0, dist);
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i] || i === segs.length - 1) {
        const t = segs[i] ? Math.min(1, d / segs[i]) : 0;
        const p0 = pts[i], p1 = pts[i + 1];
        const dx = p1.x - p0.x, dy = p1.y - p0.y;
        const m = Math.hypot(dx, dy) || 1;
        return { x: p0.x + dx * t, y: p0.y + dy * t, nx: -dy / m, ny: dx / m, seg: i };
      }
      d -= segs[i];
    }
    const l = pts[pts.length - 1];
    return { x: l.x, y: l.y, nx: 0, ny: 1, seg: segs.length - 1 };
  }

  /**
   * [d0,d1] 这一段的环带，返回投影后的多边形点列。
   * 环带必须**填充**而不是描边——描边的粗细是屏幕空间的，不会跟着透视变，
   * 近粗远细就没了（上一版就是栽在这儿）。
   * 正多边形整体外扩/内缩 t，得到的仍是同心正多边形，
   * 半径变化量 = t / cos(π/n)（顶点沿角平分线走），顶点可以直接取。
   */
  static _ribbon(d0, d1, scale) {
    const c = TokenRingHUD.CFG;
    if (!(d1 > d0)) return [];
    const half = c.thickness * scale / 2;
    const bump = half / Math.cos(Math.PI / c.sides);
    const mid   = TokenRingHUD._polyAt(c.radius, scale);
    const outer = TokenRingHUD._polyAt(c.radius + bump / scale, scale);
    const inner = TokenRingHUD._polyAt(c.radius - bump / scale, scale);
    const { segs } = TokenRingHUD._measure(mid);

    const s = TokenRingHUD._walk(mid, segs, d0);
    const e = TokenRingHUD._walk(mid, segs, d1);
    const O = [{ x: s.x + s.nx * half, y: s.y + s.ny * half }];
    const I = [{ x: s.x - s.nx * half, y: s.y - s.ny * half }];
    for (let v = s.seg + 1; v <= e.seg; v++) { O.push(outer[v]); I.push(inner[v]); }
    O.push({ x: e.x + e.nx * half, y: e.y + e.ny * half });
    I.push({ x: e.x - e.nx * half, y: e.y - e.ny * half });

    return [...O, ...I.reverse()].map(p => TokenRingHUD._project(p, scale));
  }

  static _fillPoly(g, poly, color, alpha = 1) {
    if (poly.length < 3) return;
    g.beginFill(color, alpha);
    g.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) g.lineTo(poly[i].x, poly[i].y);
    g.closePath();
    g.endFill();
  }

  /* ─── 绘制 ────────────────────────────────────────────────────────────── */

  static draw(token) {
    if (!token || token.destroyed) return;
    const actor = token.actor;
    if (!TokenRingHUD._enabled || !TokenRingHUD._showsFor(token) || actor?.type !== "character") {
      TokenRingHUD._destroy(token);
      return;
    }

    const c = TokenRingHUD.CFG;
    const scale = (canvas?.grid?.size ?? BASE_CELL) / BASE_CELL;

    let box = token._limbusRing;
    if (!box || box.destroyed) {
      box = new PIXI.Container();
      box.eventMode = "none";
      box.sortLayer = token.mesh?.sortLayer ?? 700;   // PrimaryCanvasObject 的 TOKENS 层
      token._limbusRing = box;
      // 优先挂进 primary（立绘所在的组），这样才可能被别的立绘遮住；
      // 拿不到就退回挂在 Token 上（行为同旧版：永远画在最上层）
      if (canvas?.primary) { box._inPrimary = true; canvas.primary.addChild(box); }
      else                 { box._inPrimary = false; token.addChild(box); }
    }
    box.removeChildren().forEach(ch => ch.destroy({ children: true }));
    // 不要反向旋转：Foundry 里 Token 的朝向作用在 token.mesh 上，
    // 这个容器本身从不旋转——反向转反而会让整套 HUD 跟着角色朝向甩。
    box.rotation = 0;
    // 挂在 primary 时用世界坐标（Token 的中心），挂在 Token 上时用局部坐标
    if (box._inPrimary) box.position.set(token.center?.x ?? 0, token.center?.y ?? 0);
    else                box.position.set((token.w ?? 0) / 2, (token.h ?? 0) / 2);
    box.visible = token.visible !== false;
    TokenRingHUD._applySort(token);

    TokenRingHUD._drawRing(box, actor, scale);
    TokenRingHUD._drawHp(box, actor, scale);
    TokenRingHUD._drawSan(box, actor, scale);
    TokenRingHUD._drawBuffs(box, actor, scale);
  }

  static _drawRing(box, actor, scale) {
    const c = TokenRingHUD.CFG;
    const mid = TokenRingHUD._polyAt(c.radius, scale);
    const { segs, total } = TokenRingHUD._measure(mid);
    if (!(total > 0)) return;

    const a = total * Math.min(c.arcStart, c.arcEnd) / 100;
    const b = total * Math.max(c.arcStart, c.arcEnd) / 100;
    const S = b - a;

    const hp    = actor.system?.hp?.value ?? 0;
    const hpMax = Math.max(1, actor.system?.hp?.max ?? 1);
    const pct   = Math.max(0, Math.min(1, hp / hpMax));

    const ring = c.pos.ring ?? { x: 0, y: 0 };
    const g = new PIXI.Graphics();
    g.position.set(ring.x * scale, ring.y * scale);
    // 轨道：整段
    TokenRingHUD._fillPoly(g, TokenRingHUD._ribbon(a, b, scale), c.trackColor, c.trackAlpha);
    // 填充：锚在段尾，空缺从段首长出
    if (pct > 0) {
      TokenRingHUD._fillPoly(g, TokenRingHUD._ribbon(a + S * (1 - pct), b, scale),
        pct <= c.lowAt ? c.fillLowColor : c.fillColor);
    }
    box.addChild(g);

    if (!c.showThres) return;
    // 混乱阈值刻度：横跨环带的一小段线，同样先在地面算再投影
    const half = c.thickness * scale / 2 + 4 * scale;
    const marks = new PIXI.Graphics();
    marks.position.set(ring.x * scale, ring.y * scale);
    for (const t of (actor.system?.chaosThresholds ?? [])) {
      const w = TokenRingHUD._walk(mid, segs, a + S * (1 - (t.percent ?? 0) / 100));
      const A = TokenRingHUD._project({ x: w.x + w.nx * half, y: w.y + w.ny * half }, scale);
      const B = TokenRingHUD._project({ x: w.x - w.nx * half, y: w.y - w.ny * half }, scale);
      marks.lineStyle({ width: Math.max(1, 2 * scale),
        color: t.triggered ? c.thresDoneColor : c.thresColor,
        alpha: t.triggered ? 0.5 : 0.85 });
      marks.moveTo(A.x, A.y);
      marks.lineTo(B.x, B.y);
    }
    box.addChild(marks);
  }

  static _text(str, style) {
    const t = new PIXI.Text(str, new PIXI.TextStyle(style));
    t.anchor.set(0.5);
    t.resolution = 2;
    return t;
  }

  static _drawHp(box, actor, scale) {
    const c = TokenRingHUD.CFG;
    const t = TokenRingHUD._text(String(Math.round(actor.system?.hp?.value ?? 0)), {
      fontFamily: "Impact, Arial Black, sans-serif",
      fontSize: c.hpFont * scale, fontWeight: "bold", fill: 0xff5a3c,
      stroke: 0x000000, strokeThickness: 3 * scale,
      dropShadow: true, dropShadowColor: 0xff3c28,
      dropShadowBlur: 6 * scale, dropShadowDistance: 0, dropShadowAlpha: 0.6,
    });
    t.position.set(c.pos.hp.x * scale, c.pos.hp.y * scale);
    box.addChild(t);
  }

  static _drawSan(box, actor, scale) {
    const c = TokenRingHUD.CFG;
    const san = actor.system?.sanity?.value ?? 50;
    const col = sanityColors(san);
    const r = c.sanSize * scale / 2;
    const g = new PIXI.Graphics();
    // 底色随理智在 红(5) → 灰(50) → 蓝(95) 之间渐变，与快捷 HUD 的理智球一致
    g.lineStyle({ width: Math.max(1, 2 * scale), color: col.border, alpha: 1 });
    g.beginFill(col.bg, 0.92);
    g.drawCircle(0, 0, r);
    g.endFill();
    g.position.set(c.pos.san.x * scale, c.pos.san.y * scale);
    box.addChild(g);

    const t = TokenRingHUD._text(String(Math.round(san)), {
      fontFamily: "system-ui, sans-serif",
      fontSize: c.sanFont * scale, fontWeight: "bold", fill: 0xffffff,
      stroke: 0x000000, strokeThickness: 2 * scale,
    });
    t.position.set(g.position.x, g.position.y);
    box.addChild(t);
  }

  static _buffIconPath(buff) {
    if (buff?.icon) return buff.icon;
    if (BUFF_ICON_MAP[buff?.type]) return BUFF_ICON_BASE + BUFF_ICON_MAP[buff.type];
    const name = buff?.name || buff?.type;
    return name ? `${BUFF_ICON_BASE}Custom_buffs/${name}.webp` : "";
  }

  static _drawBuffs(box, actor, scale) {
    const c = TokenRingHUD.CFG;
    const buffs = (actor.system?.buffs ?? []).filter(b => b?.type);
    if (!buffs.length) return;

    const size = c.buffIcon * scale;
    const gap  = c.buffGap * scale;
    const per  = c.buffPerRow;
    const originX = c.pos.buff.x * scale;
    const originY = c.pos.buff.y * scale;

    for (let i = 0; i < buffs.length; i++) {
      const row = Math.floor(i / per);
      const inRow = Math.min(per, buffs.length - row * per);   // 该行实际个数
      const col = i % per;
      // 不足一行（或最后一行）居中：整行宽度按实际个数算，再左移一半
      const rowW = inRow * size + (inRow - 1) * gap;
      const x = originX - rowW / 2 + col * (size + gap) + size / 2;
      // 第一行钉在 pos.buff.y，多出来的行**往下**排——不再整块纵向居中，
      // 否则加一排会把已经摆好的第一行顶上去
      const y = originY + row * (size + gap);

      const path = TokenRingHUD._buffIconPath(buffs[i]);
      if (!path) continue;
      const sp = PIXI.Sprite.from(path);
      sp.anchor.set(0.5);
      sp.width = size; sp.height = size;
      sp.position.set(x, y);
      box.addChild(sp);

      // 角标：右下＝层数、左下＝强度（等级）。两个都只在 >0 时画，
      // 免得没有强度概念的 BUFF（守护/易损那类）多出一个 0
      const badge = (txt, dx, fill) => {
        const n = TokenRingHUD._text(txt, {
          fontFamily: "system-ui, sans-serif",
          fontSize: 12 * scale, fontWeight: "bold", fill,
          stroke: 0x000000, strokeThickness: 3 * scale,
        });
        n.position.set(x + dx, y + size / 2 - 3 * scale);
        box.addChild(n);
      };
      const st = buffs[i].stacks ?? 0;
      const it = buffs[i].intensity ?? 0;
      if (st > 0) badge(String(st), size / 2 - 3 * scale, 0xffffff);
      if (it > 0) badge(String(it), -size / 2 + 3 * scale, 0xffd066);
    }
  }

  static _destroy(token) {
    const box = token?._limbusRing;
    if (!box) return;
    if (!box.destroyed) {
      box.parent?.removeChild(box);      // 挂在 primary 时不会随 Token 一起销毁
      box.destroy({ children: true });
    }
    delete token._limbusRing;
  }
}
