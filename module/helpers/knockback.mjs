/**
 * knockback.mjs — 拼点斥力（击退 / 追击 / 撞墙引爆）
 *
 * 冷兵器贴身对拼时，双方本来相距一格。每次交锋分出胜负后，按胜方的点数把
 * 败方往后击退：
 *   · 胜方点数 ≥ 10 / 20 / 30 → 败方被击退 1 / 2 / 3 格
 *   · 败方背后是墙就推不动 → 撞墙，触发【震颤引爆】
 *   · 随后胜方瞬移追上去，重新贴身（【伤害计算】那一下不追击）
 *
 * 只有"面对面"（正交相邻一格）才会触发；隔着距离的近战攻击不产生斥力。
 *
 * ── 远程武器（system.rangeType = "ranged"）另有一套 ─────────────────────
 *   · 远程方**不会被击退**——人在老远，推不动
 *   · 远程方获胜时**照样能把目标击退**，哪怕不贴身（沿连线方向推）
 *   · 远程方落败、而胜方是近战时，近战方会**瞬移到它面前**再结算
 * 这些判定全部在 repel() 内部按双方武器自动完成，调用方不必传参。
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
    // animate:false 只在本机生效，其他客户端仍会做补间——必须同时给 teleport:true，
    // 这个选项会随更新广播出去，各端都按"瞬移"处理，不再看到慢慢滑过去
    const opts = { animate: false, teleport: true };
    const doc = token.document;
    if (doc.canUserModify?.(game.user, "update")) {
      return doc.update(data, opts);
    }
    game.socket?.emit("system.limbusCompany_FVTT", {
      type: "gmDocUpdate", uuid: doc.uuid, data, options: opts,
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
   * 读一个角色当前装备武器的攻击方式。
   * 多把武器时优先取已激活（isActive）的那把，与 ClashManager._activeWeaponOf 同口径。
   * @returns {{ranged: boolean, range: number}}
   */
  static weaponRangeOf(actor) {
    const eq = actor?.system?.equipment ?? {};
    const weapons = [];
    for (let i = 0; i < 9; i++) {
      const id = eq[`slot${i}`];
      const it = id ? actor.items.get(id) : null;
      if (it && it.type === "equipment" && it.system?.subtype === "weapon") weapons.push(it);
    }
    const w = weapons.find(x => x.system?.isActive) ?? weapons[0];
    return {
      ranged: w?.system?.rangeType === "ranged",
      range:  Math.max(0, w?.system?.range ?? 1),
    };
  }

  /**
   * 让 token 瞬移到 target 的旁边（贴身），带风线。
   * @returns {boolean} 是否成功贴上
   */
  static async approach(token, target, { behind = false } = {}) {
    const gs = canvas.grid.size;
    const dir = this._dirTo(token.center, target.center);
    // 默认：首选正对着来的那一格；behind=true：绕到目标背后（自己这一侧的反面），
    // 免得站在人堆中间原地不动地挥刀，看着发呆
    const near = { x: target.center.x - dir.dx * gs, y: target.center.y - dir.dy * gs };
    const far  = { x: target.center.x + dir.dx * gs, y: target.center.y + dir.dy * gs };
    const side = [
      { x: target.center.x - gs, y: target.center.y },
      { x: target.center.x + gs, y: target.center.y },
      { x: target.center.x, y: target.center.y - gs },
      { x: target.center.x, y: target.center.y + gs },
    ].filter(p => Math.hypot(p.x - near.x, p.y - near.y) > gs * 0.5
               && Math.hypot(p.x - far.x,  p.y - far.y)  > gs * 0.5);
    // 侧面两格随机先后，连着打同一个人时不会每次都绕同一边
    if (side.length > 1 && Math.random() < 0.5) side.reverse();
    const spots = behind ? [far, ...side, near] : [near, ...side, far];
    for (const spot of spots) {
      if (Math.hypot(spot.x - token.center.x, spot.y - token.center.y) < gs * 0.5) return true;
      if (this._blocked(token, token.center, spot)) continue;
      ClashVFX.broadcastDash({ ...token.center }, spot);
      await this._teleport(token, spot);
      return true;
    }
    this._log("贴身路线被挡，目标周围没有空位");
    return false;
  }

  /**
   * 【援护防御】等场合：把 actor 的 token 挪到 target 身旁的空位。
   * 与击退模式无关，因此不看世界设定，始终可用。
   */
  static async moveNextTo(actor, target) {
    if (!canvas?.ready) return false;
    const tok = this._tokenOf(actor);
    const tgt = this._tokenOf(target);
    if (!tok || !tgt) return false;
    return this.approach(tok, tgt);
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

    const winTok  = this._tokenOf(winner);
    const loseTok = this._tokenOf(loser);
    if (!winTok || !loseTok) return;

    const winRanged  = this.weaponRangeOf(winner).ranged;
    const loseRanged = this.weaponRangeOf(loser).ranged;

    // 面对面才有斥力
    let facing = this._facing(winTok, loseTok);

    // 近战胜方 vs 远程败方：不贴身就先瞬移到它面前，再做最后结算
    // （反击的 approachFirst 也走这条路）
    if (!facing && (approachFirst || (!winRanged && loseRanged))) {
      await this._wait(this.DELAY_CHASE);
      if (await this.approach(winTok, loseTok)) facing = this._facing(winTok, loseTok);
    }

    // 点数不够就只是贴身，不产生击退
    const cells = this.cellsFor(winScore);
    if (cells <= 0) return;

    // 远程方落败：人在老远，推不动
    if (loseRanged && !facing) { this._log("败方是远程且未贴身，不受击退"); return; }
    if (loseRanged) { this._log("败方持远程武器，不受击退"); return; }

    // 远程方获胜：哪怕隔着距离也能把目标推开，沿"胜方 → 败方"的连线方向
    if (!facing && winRanged) {
      const dir = this._dirTo(winTok.center, loseTok.center);
      facing = { dx: dir.dx, dy: dir.dy };
      this._log("远程胜方：隔空击退");
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
    // 远程胜方不追——把人推远正是它想要的
    if (!chase || winRanged) return;
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
