/**
 * knockback.mjs — 拼点斥力（击退 / 追击 / 撞墙引爆）
 *
 * 冷兵器贴身对拼时，双方本来相距一格。每次交锋分出胜负后，按胜方的点数产生
 * 斥力把两人一起震开：
 *   · 胜方点数 ≥ 10 / 20 / 30 → 双方各被震退 1 / 2 / 3 格
 *   · 谁背后是墙就推不动 → 撞墙，触发【震颤引爆】
 *   · 随后只有胜方瞬移追击，重新贴到败方身边（【伤害计算】那一下不追击）
 *
 * 只有"面对面"（正交相邻一格）才会触发；隔着距离的攻击视为远程，不产生斥力。
 * 移动一律是瞬移——不做补间，避免和拼点演出的节奏打架。
 *
 * 墙体判定走 Foundry 的移动多边形后端（只看 wall.move，因此窗户之类"能看不能
 * 过"的墙也能正确区分）。
 */

export class ClashKnockback {

  /** 胜方点数达到多少 → 震退几格（从大到小匹配） */
  static THRESHOLDS = [
    { score: 30, cells: 3 },
    { score: 20, cells: 2 },
    { score: 10, cells: 1 },
  ];

  /** 总开关：想临时关掉整套斥力，把它置为 false 即可 */
  static ENABLED = true;

  static _log(...args) {
    const { ClashTotalFX } = globalThis;
    if (ClashTotalFX?.DEBUG) console.log("%c[Knockback]", "color:#E8C9A2;font-weight:bold", ...args);
  }

  /** 该点数对应的震退格数 */
  static cellsFor(score = 0) {
    return this.THRESHOLDS.find(t => score >= t.score)?.cells ?? 0;
  }

  /** 取该 Actor 在当前场景里的 token（优先激活的那一个） */
  static _tokenOf(actor) {
    if (!actor || !canvas?.ready) return null;
    const tokens = canvas.tokens?.placeables?.filter(t => t.actor?.id === actor.id) ?? [];
    return tokens.find(t => t.controlled) ?? tokens[0] ?? null;
  }

  /** 两个 token 是否正交相邻一格（面对面）；返回 null 表示不相邻 */
  static _facing(a, b) {
    const gs = canvas?.grid?.size ?? 100;
    const dx = Math.round((b.center.x - a.center.x) / gs);
    const dy = Math.round((b.center.y - a.center.y) / gs);
    if (Math.abs(dx) + Math.abs(dy) !== 1) return null;   // 只认正交贴身
    return { dx, dy };
  }

  /** 目标格是否走不过去（墙 / 出界 / 已有其他 token） */
  static _blocked(token, fromCenter, toCenter) {
    const backend = CONFIG.Canvas?.polygonBackends?.move;
    if (backend?.testCollision?.(fromCenter, toCenter, { type: "move", mode: "any" })) return true;

    const d = canvas.dimensions;
    if (toCenter.x < d.sceneX || toCenter.y < d.sceneY
      || toCenter.x > d.sceneX + d.sceneWidth || toCenter.y > d.sceneY + d.sceneHeight) return true;

    const gs = canvas.grid.size;
    return canvas.tokens.placeables.some(t => t.id !== token.id
      && Math.hypot(t.center.x - toCenter.x, t.center.y - toCenter.y) < gs * 0.5);
  }

  /** 瞬移到指定中心点（跨所有权时委托 GM 执行） */
  static async _teleport(token, center) {
    const data = {
      x: Math.round(center.x - token.w / 2),
      y: Math.round(center.y - token.h / 2),
    };
    const doc = token.document;
    if (doc.canUserModify?.(game.user, "update")) {
      return doc.update(data, { animate: false });
    }
    game.socket?.emit("system.limbusCompany_FVTT", {
      type: "gmDocUpdate", uuid: doc.uuid, data,
    });
    // 委托出去之后本地拿不到结果，给远端留一点应用时间
    await new Promise(r => setTimeout(r, 120));
  }

  /**
   * 把一个 token 沿 (dx, dy) 方向推 cells 格。
   * @returns {boolean} 是否撞墙（一格都没推动或中途被拦下）
   */
  static async _push(token, dx, dy, cells) {
    const gs = canvas.grid.size;
    let center = { ...token.center };
    let moved = 0;
    for (let i = 0; i < cells; i++) {
      const next = { x: center.x + dx * gs, y: center.y + dy * gs };
      if (this._blocked(token, center, next)) return true;   // 撞墙
      center = next;
      moved++;
    }
    if (moved) await this._teleport(token, center);
    return false;
  }

  /**
   * 一次交锋结束后的斥力结算。
   *
   * @param {object}  opts
   * @param {Actor}   opts.winner    本次交锋的胜方
   * @param {Actor}   opts.loser     本次交锋的败方
   * @param {number}  opts.winScore  胜方点数（决定震退几格）
   * @param {boolean} opts.chase     胜方是否追击（【伤害计算】那一下传 false）
   * @param {Function} opts.onWallHit 撞墙回调：(actor) => Promise，用来触发【震颤引爆】
   */
  static async repel({ winner, loser, winScore = 0, chase = true, onWallHit = null } = {}) {
    if (!this.ENABLED || !canvas?.ready) return;

    const cells = this.cellsFor(winScore);
    if (cells <= 0) return;

    const winTok  = this._tokenOf(winner);
    const loseTok = this._tokenOf(loser);
    if (!winTok || !loseTok) return;

    // 面对面才有斥力，隔空对拼视为远程
    const facing = this._facing(winTok, loseTok);
    if (!facing) { this._log("双方并非贴身，跳过斥力"); return; }

    this._log(`斥力：点数 ${winScore} → 各震退 ${cells} 格`);

    // ① 双方一起被震开，各自朝远离对方的方向
    const wallLose = await this._push(loseTok,  facing.dx,  facing.dy, cells);
    const wallWin  = await this._push(winTok,  -facing.dx, -facing.dy, cells);

    // ② 撞墙 → 【震颤引爆】
    for (const [actor, hit] of [[loser, wallLose], [winner, wallWin]]) {
      if (hit && typeof onWallHit === "function") await onWallHit(actor);
    }

    // ③ 只有胜方追击，瞬移贴回败方身边（【伤害计算】那一下不追）
    if (!chase) return;
    const gs = canvas.grid.size;
    const target = {
      x: loseTok.center.x - facing.dx * gs,
      y: loseTok.center.y - facing.dy * gs,
    };
    if (Math.hypot(target.x - winTok.center.x, target.y - winTok.center.y) < gs * 0.5) return;
    if (this._blocked(winTok, winTok.center, target)) { this._log("追击路线被挡"); return; }
    await this._teleport(winTok, target);
  }
}
