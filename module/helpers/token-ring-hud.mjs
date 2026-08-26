/**
 * token-ring-hud.mjs — Token 脚下的生命环 + HUD
 *
 * 原型见 scratchpad-hp-ring.html，这里是它的 Foundry 实装。
 *
 * 画的东西（全部挂在 Token 自己的 PIXI 容器上，跟着 Token 移动/缩放）：
 *   · 多边形生命环：只占 [arcStart, arcEnd] 那一段，扣血时空缺从段首长出
 *   · 混乱阈值刻度：越过的变灰（对应 chaosThresholds[i].triggered）
 *   · 生命值数字 / 理智圆形徽章 / BUFF 图标行（每行 6 个，不足一行居中）
 *
 * 「躺在地面上」是靠纵向半径小于横向半径做出来的——Foundry 的画布是
 * 正俯视 2D，没有真正的 3D，扁环就是这个视角下的等效结果。
 * 两个半径相等就是不压扁的正多边形。
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

export class TokenRingHUD {
  /* ─── 配置（原型面板导出的那份） ──────────────────────────────────────── */

  static CFG = {
    // 长度单位＝「一格 100px 时的像素」，实际按 grid.size/100 缩放。
    // 环是个椭圆多边形：横向、纵向半径分开给，两个相等即正多边形，
    // 纵向小于横向就是"贴地"的扁环——比给一个抽象的压扁百分比好调。
    sides: 7, radiusX: 83, radiusY: 31, thickness: 12,
    startDeg: 193, ccw: true,
    arcStart: 0, arcEnd: 50,
    showThres: true,
    // 各元素相对 Token 中心的偏移（基准网格下的 px）；ring 是环自己的位置
    pos: { ring: { x: 0, y: 0 },
           hp: { x: -81, y: -13 }, san: { x: 77, y: -11 }, buff: { x: 1, y: 88 } },
    // 颜色
    trackColor: 0xffffff, trackAlpha: 0.13,
    fillColor:  0xe03a3a, fillLowColor: 0xff2d2d, lowAt: 0.3,
    thresColor: 0xffffff, thresDoneColor: 0x7a6b8c,
    // BUFF 行
    buffIcon: 30, buffGap: 4, buffPerRow: 6,
  };

  static _enabled = true;

  /* ─── 注册 ────────────────────────────────────────────────────────────── */

  static init() {
    game.settings.register("limbusCompany_FVTT", "tokenRingHud", {
      name: "Token 生命环 HUD",
      hint: "在 Token 脚下显示生命环、生命值、理智与 BUFF 图标。",
      scope: "client", config: true, type: Boolean, default: true,
      onChange: (v) => { TokenRingHUD._enabled = v; TokenRingHUD.refreshAll(); },
    });
  }

  static ready() {
    TokenRingHUD._enabled = game.settings.get("limbusCompany_FVTT", "tokenRingHud") ?? true;

    Hooks.on("drawToken",    (token) => TokenRingHUD.draw(token));
    Hooks.on("refreshToken", (token) => TokenRingHUD.draw(token));
    Hooks.on("destroyToken", (token) => TokenRingHUD._destroy(token));
    // 血量/理智/BUFF/混乱阈值变化 → 重画该角色的所有 Token
    Hooks.on("updateActor",  (actor) => TokenRingHUD.refreshActor(actor));

    TokenRingHUD.refreshAll();
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

  /**
   * 椭圆多边形的顶点。
   * 与原型同一套：起点角 startDeg，ccw 决定步进方向；y 轴向下，
   * 所以角度递减看起来才是逆时针。
   */
  static _polygon(scale) {
    const c = TokenRingHUD.CFG;
    const rx = c.radiusX * scale, ry = c.radiusY * scale;
    const a0 = c.startDeg * Math.PI / 180;
    const step = (2 * Math.PI / c.sides) * (c.ccw ? -1 : 1);
    const pts = [];
    for (let i = 0; i < c.sides; i++) {
      const a = a0 + i * step;
      pts.push({ x: rx * Math.cos(a), y: ry * Math.sin(a) });
    }
    pts.push({ ...pts[0] });      // 闭合
    return pts;
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

  /** 沿折线走 dist 距离处的点与切线方向 */
  static _at(pts, segs, dist) {
    let d = Math.max(0, dist);
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i] || i === segs.length - 1) {
        const t = segs[i] ? Math.min(1, d / segs[i]) : 0;
        const p0 = pts[i], p1 = pts[i + 1];
        const dx = p1.x - p0.x, dy = p1.y - p0.y;
        const m = Math.hypot(dx, dy) || 1;
        return { x: p0.x + dx * t, y: p0.y + dy * t, tx: dx / m, ty: dy / m };
      }
      d -= segs[i];
    }
    const last = pts[pts.length - 1];
    return { x: last.x, y: last.y, tx: 1, ty: 0 };
  }

  /** 折线上 [d0, d1] 这一段的点列（用于只画环的一部分） */
  static _slice(pts, segs, d0, d1) {
    if (!(d1 > d0)) return [];
    const out = [TokenRingHUD._at(pts, segs, d0)];
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      const segEnd = acc + segs[i];
      if (segEnd > d0 && segEnd < d1) out.push(pts[i + 1]);
      acc = segEnd;
    }
    out.push(TokenRingHUD._at(pts, segs, d1));
    return out;
  }

  static _strokePolyline(g, poly, width, color, alpha = 1) {
    if (poly.length < 2) return;
    g.lineStyle({ width, color, alpha, cap: "butt", join: "miter" });
    g.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) g.lineTo(poly[i].x, poly[i].y);
  }

  /* ─── 绘制 ────────────────────────────────────────────────────────────── */

  static draw(token) {
    if (!token || token.destroyed) return;
    const actor = token.actor;
    if (!TokenRingHUD._enabled || actor?.type !== "character") {
      TokenRingHUD._destroy(token);
      return;
    }

    const c = TokenRingHUD.CFG;
    const scale = (canvas?.grid?.size ?? BASE_CELL) / BASE_CELL;

    let box = token._limbusRing;
    if (!box || box.destroyed) {
      box = new PIXI.Container();
      box.eventMode = "none";
      token._limbusRing = box;
      token.addChild(box);
    }
    box.removeChildren().forEach(ch => ch.destroy({ children: true }));
    // 不要反向旋转：Foundry 里 Token 的朝向作用在 token.mesh 上，
    // 这个容器本身从不旋转——反向转反而会让整套 HUD 跟着角色朝向甩。
    box.rotation = 0;
    box.position.set((token.w ?? 0) / 2, (token.h ?? 0) / 2);

    TokenRingHUD._drawRing(box, actor, scale);
    TokenRingHUD._drawHp(box, actor, scale);
    TokenRingHUD._drawSan(box, actor, scale);
    TokenRingHUD._drawBuffs(box, actor, scale);
  }

  static _drawRing(box, actor, scale) {
    const c = TokenRingHUD.CFG;
    const pts = TokenRingHUD._polygon(scale);
    const { segs, total } = TokenRingHUD._measure(pts);
    if (!(total > 0)) return;

    const a = total * Math.min(c.arcStart, c.arcEnd) / 100;
    const b = total * Math.max(c.arcStart, c.arcEnd) / 100;
    const S = b - a;

    const hp    = actor.system?.hp?.value ?? 0;
    const hpMax = Math.max(1, actor.system?.hp?.max ?? 1);
    const pct   = Math.max(0, Math.min(1, hp / hpMax));
    const width = c.thickness * scale;

    const ring = TokenRingHUD.CFG.pos.ring ?? { x: 0, y: 0 };
    const g = new PIXI.Graphics();
    g.position.set(ring.x * scale, ring.y * scale);
    // 轨道：整段
    TokenRingHUD._strokePolyline(g, TokenRingHUD._slice(pts, segs, a, b),
      width, c.trackColor, c.trackAlpha);
    // 填充：锚在段尾，空缺从段首长出
    if (pct > 0) {
      TokenRingHUD._strokePolyline(g, TokenRingHUD._slice(pts, segs, a + S * (1 - pct), b),
        width, pct <= c.lowAt ? c.fillLowColor : c.fillColor);
    }
    box.addChild(g);

    if (!c.showThres) return;
    // 混乱阈值刻度：与承受结算卡上的血条同一套映射
    const half = width / 2 + 4 * scale;
    const marks = new PIXI.Graphics();
    marks.position.set(ring.x * scale, ring.y * scale);
    for (const t of (actor.system?.chaosThresholds ?? [])) {
      const p = TokenRingHUD._at(pts, segs, a + S * (1 - (t.percent ?? 0) / 100));
      const nx = -p.ty, ny = p.tx;
      marks.lineStyle({ width: Math.max(1, 2 * scale),
        color: t.triggered ? c.thresDoneColor : c.thresColor,
        alpha: t.triggered ? 0.5 : 0.85 });
      marks.moveTo(p.x - nx * half, p.y - ny * half);
      marks.lineTo(p.x + nx * half, p.y + ny * half);
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
      fontSize: 30 * scale, fontWeight: "bold", fill: 0xff5a3c,
      stroke: 0x000000, strokeThickness: 3 * scale,
      dropShadow: true, dropShadowColor: 0xff3c28,
      dropShadowBlur: 6 * scale, dropShadowDistance: 0, dropShadowAlpha: 0.6,
    });
    t.position.set(c.pos.hp.x * scale, c.pos.hp.y * scale);
    box.addChild(t);
  }

  static _drawSan(box, actor, scale) {
    const c = TokenRingHUD.CFG;
    const r = 22 * scale;
    const g = new PIXI.Graphics();
    g.lineStyle({ width: Math.max(1, 1 * scale), color: 0x5b7fbf, alpha: 1 });
    g.beginFill(0x0c1428, 0.85);
    g.drawCircle(0, 0, r);
    g.endFill();
    g.position.set(c.pos.san.x * scale, c.pos.san.y * scale);
    box.addChild(g);

    const t = TokenRingHUD._text(String(Math.round(actor.system?.sanity?.value ?? 0)), {
      fontFamily: "system-ui, sans-serif",
      fontSize: 17 * scale, fontWeight: "bold", fill: 0xcfe4ff,
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
    const rows = Math.ceil(buffs.length / per);
    const originX = c.pos.buff.x * scale;
    const originY = c.pos.buff.y * scale;

    for (let i = 0; i < buffs.length; i++) {
      const row = Math.floor(i / per);
      const inRow = Math.min(per, buffs.length - row * per);   // 该行实际个数
      const col = i % per;
      // 不足一行（或最后一行）居中：整行宽度按实际个数算，再左移一半
      const rowW = inRow * size + (inRow - 1) * gap;
      const x = originX - rowW / 2 + col * (size + gap) + size / 2;
      const y = originY - (rows - 1) * (size + gap) / 2 + row * (size + gap);

      const path = TokenRingHUD._buffIconPath(buffs[i]);
      if (!path) continue;
      const sp = PIXI.Sprite.from(path);
      sp.anchor.set(0.5);
      sp.width = size; sp.height = size;
      sp.position.set(x, y);
      box.addChild(sp);

      // 层数角标（>1 才显示）
      const st = buffs[i].stacks ?? 0;
      if (st > 1) {
        const n = TokenRingHUD._text(String(st), {
          fontFamily: "system-ui, sans-serif",
          fontSize: 12 * scale, fontWeight: "bold", fill: 0xffffff,
          stroke: 0x000000, strokeThickness: 3 * scale,
        });
        n.position.set(x + size / 2 - 3 * scale, y + size / 2 - 3 * scale);
        box.addChild(n);
      }
    }
  }

  static _destroy(token) {
    const box = token?._limbusRing;
    if (!box) return;
    if (!box.destroyed) box.destroy({ children: true });
    delete token._limbusRing;
  }
}
