/**
 * knockback.mjs — 拼点斥力（击退 / 追击 / 撞墙引爆）
 *
 * 冷兵器贴身对拼时，双方本来相距一格。每次交锋分出胜负后，按胜方的点数把
 * 败方往后击退：
 *   · 胜方点数 ≥ 10 / 20 / 30 → 败方被击退 1 / 2 / 3 格
 *   · 败方背后是墙就推不动 → 撞墙，触发【震颤引爆】
 *   · 随后胜方瞬移追上去，重新贴身（【伤害计算】那一下不追击）
 *
 * 只有"面对面"（正交相邻一格）才会触发；隔着距离的攻击视为远程，不产生斥力。
 * 移动一律是瞬移——不做补间，避免和拼点演出的节奏打架。
 *
 * 墙体判定走 Foundry 的移动多边形后端（只看 wall.move，因此窗户之类"能看不能
 * 过"的墙也能正确区分）。
 */

import { ClashVFX } from "./clash-vfx.mjs";

export class ClashKnockback {

  /** 胜方点数达到多少 → 震退几格（从大到小匹配） */
  static THRESHOLDS = [
    { score: 30, cells: 3 },
    { score: 20, cells: 2 },
    { score: 10, cells: 1 },
  ];

  /** 代码侧的临时开关（控制台调试用）；正式开关是世界设定【击退模式】 */
  static ENABLED = true;

  /** 是否启用：世界设定【击退模式】与本地开关都为真才生效 */
  static get active() {
    if (!this.ENABLED) return false;
    return game.settings?.get?.("limbusCompany_FVTT", "knockbackMode") !== false;
  }

  /** 判定落定 → 击退 之间的停顿（ms） */
  static DELAY_RECOIL = 160;

  /** 击退 → 胜方追击 之间的停顿（ms） */
  static DELAY_CHASE = 100;

  /**
   * 胜方是否也被反冲后退。默认 false——只有目标被击退，胜方站桩后追击，
   * 双方一起后退再一起贴回来看着像在跳恰恰。
   */
  static RECOIL_WINNER = false;

  static _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

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
   * @returns {{hitWall: boolean, center: {x: number, y: number}}}
   *          hitWall = 是否被墙/出界/他人拦下；center = 推完后的中心点
   *          （委托 GM 移动时本地 token.center 未必立刻刷新，追击要用这个值）
   */
  static async _push(token, dx, dy, cells) {
    const gs = canvas.grid.size;
    let center = { ...token.center };
    let moved = 0, hitWall = false;
    for (let i = 0; i < cells; i++) {
      const next = { x: center.x + dx * gs, y: center.y + dy * gs };
      // 撞上了就停在这儿——之前推的那几格照样算数（离墙 2 格却要退 3 格时，
      // 应该退满 2 格再撞墙，而不是一格都不动）
      if (this._blocked(token, center, next)) { hitWall = true; break; }
      center = next;
      moved++;
    }
    if (moved) await this._teleport(token, center);
    return { hitWall, moved, center };
  }

  /** 从 from 指向 to 的主轴正交方向 */
  static _dirTo(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    return Math.abs(dx) >= Math.abs(dy)
      ? { dx: Math.sign(dx) || 1, dy: 0 }
      : { dx: 0, dy: Math.sign(dy) || 1 };
  }

  /**
   * 让 token 瞬移到 target 的旁边（贴身），带风线。
   * @returns {boolean} 是否成功贴上
   */
  static async approach(token, target) {
    const gs = canvas.grid.size;
    const dir = this._dirTo(token.center, target.center);
    const spot = {
      x: target.center.x - dir.dx * gs,
      y: target.center.y - dir.dy * gs,
    };
    if (Math.hypot(spot.x - token.center.x, spot.y - token.center.y) < gs * 0.5) return true;
    if (this._blocked(token, token.center, spot)) { this._log("贴身路线被挡"); return false; }
    ClashVFX.broadcastDash({ ...token.center }, spot);
    await this._teleport(token, spot);
    return true;
  }

  /**
   * 一次交锋结束后的斥力结算。
   *
   * @param {object}  opts
   * @param {Actor}   opts.winner    本次交锋的胜方
   * @param {Actor}   opts.loser     本次交锋的败方
   * @param {number}  opts.winScore  胜方点数（决定震退几格）
   * @param {boolean} opts.chase     胜方是否追击（【伤害计算】那一下传 false）
   * @param {boolean} opts.approachFirst 不贴身时先扑过去再打（反击用）
   * @param {Function} opts.onWallHit 撞墙回调：(actor) => Promise，用来触发【震颤引爆】
   */
  static async repel({ winner, loser, winScore = 0, chase = true,
                       approachFirst = false, onWallHit = null } = {}) {
    if (!this.active || !canvas?.ready) return;

    const cells = this.cellsFor(winScore);
    if (cells <= 0) return;

    const winTok  = this._tokenOf(winner);
    const loseTok = this._tokenOf(loser);
    if (!winTok || !loseTok) return;

    // 面对面才有斥力，隔空对拼视为远程
    let facing = this._facing(winTok, loseTok);
    if (!facing && approachFirst) {
      // 反击：被打退开了，反手扑回去
      await this._wait(this.DELAY_CHASE);
      if (await this.approach(winTok, loseTok)) facing = this._facing(winTok, loseTok);
    }
    if (!facing) { this._log("双方并非贴身，跳过斥力"); return; }

    this._log(`斥力：点数 ${winScore} → 击退 ${cells} 格`);
    await this._wait(this.DELAY_RECOIL);

    // ① 把目标往后击退（facing 是"胜方 → 败方"的方向）
    const pushed = await this._push(loseTok, facing.dx, facing.dy, cells);

    // 可选：胜方也被反冲后退（默认关闭）
    let winRecoil = { hitWall: false };
    if (this.RECOIL_WINNER) winRecoil = await this._push(winTok, -facing.dx, -facing.dy, cells);

    // ② 撞墙 → 【震颤引爆】
    for (const [actor, hit] of [[loser, pushed.hitWall], [winner, winRecoil.hitWall]]) {
      if (hit && typeof onWallHit === "function") await onWallHit(actor);
    }

    // ③ 胜方瞬移追上去，重新贴身（【伤害计算】那一下不追）
    if (!chase) return;
    await this._wait(this.DELAY_CHASE);
    const gs = canvas.grid.size;
    // 用推算出来的坐标，而不是 token.center——委托 GM 移动时本地未必已经刷新
    const target = {
      x: pushed.center.x - facing.dx * gs,
      y: pushed.center.y - facing.dy * gs,
    };
    if (Math.hypot(target.x - winTok.center.x, target.y - winTok.center.y) < gs * 0.5) return;
    if (this._blocked(winTok, winTok.center, target)) { this._log("追击路线被挡"); return; }
    // 疾驰的风线（全场可见）
    ClashVFX.broadcastDash({ ...winTok.center }, target);
    await this._teleport(winTok, target);
  }
}
