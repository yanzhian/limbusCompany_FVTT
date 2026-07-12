/**
 * clash.mjs — 对抗流程管理器
 * 全流程：发起对抗 → 聊天框 → 进行对抗确认 → 进行对抗 → 拼点结算 → 承受
 */

import { SinResourceHUD } from "./sin-resource-hud.mjs";
import { CustomBuffRegistry, resolveBuffHandler } from "./custom-buffs.mjs";

export class ClashManager {

  /* ─── 工具函数 ─────────────────────────────────────────────────────────── */

  /**
   * 将效果值解析为数字。若 val 包含骰子公式（如 "1D6+2"），则通过 Roll 求值；
   * 否则直接转换为 Number。
   * @param {string|number} val
   * @returns {Promise<number>}
   */
  static async _evalValue(val) {
    if (val === undefined || val === null || val === "") return 0;
    const n = Number(val);
    if (!Number.isNaN(n)) return n;
    // 包含骰子公式，用 Foundry Roll 求值
    try {
      const roll = new Roll(String(val));
      await roll.evaluate();
      return roll.total ?? 0;
    } catch (e) {
      console.warn("ClashManager._evalValue: 无法解析值", val, e);
      return 0;
    }
  }

  /**
   * 解析"相关数值"字段的符号语义：
   * - 无符号纯数字（如 "3"）→ 绝对赋值（mode:"absolute"）
   * - 带显式符号（如 "+3" / "-3"）→ 相对调整（mode:"relative"）
   * - 骰子公式（如 "1D4+2"）或其他表达式 → 始终视为相对调整
   * - 旧数据缺少 value 字段时，回退使用 intensity（数字），保持相对调整语义
   * @param {string|number} value
   * @param {number} [intensity]
   * @returns {Promise<{mode: "absolute"|"relative", value: number}>}
   */
  static async _evalSignedValue(value, intensity) {
    if (value === undefined || value === null) {
      return { mode: "relative", value: Math.round(Number(intensity ?? 0)) || 0 };
    }
    const str = String(value).trim();
    if (str === "") return { mode: "relative", value: 0 };
    const m = /^([+-]?)(\d+(?:\.\d+)?)$/.exec(str);
    if (m) {
      const [, sign, num] = m;
      const n = Number(num);
      if (sign === "") return { mode: "absolute", value: Math.round(n) };
      return { mode: "relative", value: Math.round(sign === "-" ? -n : n) };
    }
    const evaluated = Math.round(await ClashManager._evalValue(str));
    return { mode: "relative", value: evaluated };
  }

  static _catIcon(cat) {
    return CONFIG.LIMBUSCOMPANY?.CATEGORY_ICON_PATHS?.[cat] ?? "";
  }

  static _catLabel(cat) {
    return CONFIG.LIMBUSCOMPANY?.CATEGORY_LABELS_ZH?.[cat] ?? cat ?? "";
  }

  static _sinLabel(sinType) {
    return CONFIG.LIMBUSCOMPANY?.SIN_LABELS_ZH?.[sinType] ?? sinType ?? "";
  }

  static _sinColor(sinType) {
    return CONFIG.LIMBUSCOMPANY?.SIN_COLORS?.[sinType] ?? "#E8CAA2";
  }

  static _parseResistance(resStr) {
    if (!resStr) return 1.0;
    const m = String(resStr).match(/x?([0-9.]+)/i);
    return m ? parseFloat(m[1]) : 1.0;
  }

  /**
   * 返回角色的实际物理抗性（含上装 resistanceAdj 覆盖），
   * 与 actor-sheet.mjs getData() 中 displayResistances 逻辑完全一致。
   */
  static _getEffectiveResistances(actor) {
    const sys          = actor?.system ?? {};
    // 陷入混乱时，物理抗性强制提升（优先级最高，无视装备；仅本回合生效的混乱才计入）
    const buffs = (sys.buffs ?? []).filter(b => b.whenAdded !== "下回合");
    if (buffs.some(b => b.type === "chaos_double_plus")) return { slash: "x3.0", blunt: "x3.0", pierce: "x3.0" };
    if (buffs.some(b => b.type === "chaos_plus"))        return { slash: "x2.5", blunt: "x2.5", pierce: "x2.5" };
    if (buffs.some(b => b.type === "chaos"))             return { slash: "x2.0", blunt: "x2.0", pierce: "x2.0" };
    const equippedItems = Object.values(sys.equipment ?? {})
      .map(id => (id ? actor.items.get(id) : null))
      .filter(item => item?.type === "equipment");
    const upper = equippedItems.find(eq => eq.system?.subtype === "upper");
    const base = upper?.system?.resistanceAdj
      ? {
          slash:  upper.system.resistanceAdj.slash  ?? sys.resistances?.slash  ?? "x1.0",
          blunt:  upper.system.resistanceAdj.blunt  ?? sys.resistances?.blunt  ?? "x1.0",
          pierce: upper.system.resistanceAdj.pierce ?? sys.resistances?.pierce ?? "x1.0",
        }
      : {
          slash:  sys.resistances?.slash  ?? "x1.0",
          blunt:  sys.resistances?.blunt  ?? "x1.0",
          pierce: sys.resistances?.pierce ?? "x1.0",
        };
    // 自定义 BUFF modifyResistances 钩子：允许注册的 BUFF 修改物理抗性
    // 钩子签名：modifyResistances(actor, buff, res) → 返回新的 res 对象或直接原地修改
    for (const buff of buffs) {
      const handler = resolveBuffHandler(buff);
      if (typeof handler?.modifyResistances === "function") {
        const result = handler.modifyResistances(actor, buff, base);
        if (result && typeof result === "object") Object.assign(base, result);
      }
    }
    return base;
  }

  static _getBuff(actor, type) {
    // 只取"本回合"有效的 BUFF；"下回合"的尚未生效，不参与本回合计算
    return (actor?.system?.buffs ?? []).find(b => b.type === type && b.whenAdded !== "下回合") ?? null;
  }

  /**
   * 安全更新文档：若当前用户无权限，通过 socket 委托 GM 执行。
   * 用于跨所有权的 Actor/Item 更新（如攻击方客户端更新防御方 Actor/Item）。
   */
  static async _safeDocUpdate(doc, data) {
    if (!doc) return;
    if (doc.canUserModify?.(game.user, "update")) {
      return doc.update(data);
    }
    game.socket?.emit("system.limbusCompany_FVTT", {
      type: "gmDocUpdate",
      uuid: doc.uuid,
      data,
    });
  }

  static _getBuffVal(actor, type) {
    const b = ClashManager._getBuff(actor, type);
    return { intensity: b?.intensity ?? 0, stacks: b?.stacks ?? 0 };
  }

  /** 有效攻击等级（含装备 atkAdj + atk.extra + BUFF 层数） */
  static _effAtkLv(actor) {
    if (!actor) return 0;
    const sys = actor.system ?? {};
    const equipAdj = Object.values(sys.equipment ?? {})
      .map(id => id ? actor.items.get(id) : null)
      .filter(item => item?.type === "equipment")
      .reduce((s, eq) => s + Number(eq.system?.atkAdj ?? 0), 0);
    const gs = (t) => ClashManager._getBuffVal(actor, t).stacks;
    return (sys.atk?.base ?? 0) + (sys.atk?.extra ?? 0) + equipAdj
         + gs("atkLevelUp") - gs("atkLevelDown");
  }

  /** 有效防御等级（含装备 defAdj + def.extra + BUFF 层数） */
  static _effDefLv(actor) {
    if (!actor) return 0;
    const sys = actor.system ?? {};
    const equipAdj = Object.values(sys.equipment ?? {})
      .map(id => id ? actor.items.get(id) : null)
      .filter(item => item?.type === "equipment")
      .reduce((s, eq) => s + Number(eq.system?.defAdj ?? 0), 0);
    const gs = (t) => ClashManager._getBuffVal(actor, t).stacks;
    return (sys.def?.base ?? 0) + (sys.def?.extra ?? 0) + equipAdj
         + gs("defLevelUp") - gs("defLevelDown");
  }

  /**
   * 减少 BUFF 层数，归零时自动移除。
   * 优先调用 actor.reduceBuffStacks（如已定义），否则直接写 system.buffs。
   */
  static async _reduceBuffStacks(actor, type, amount = 1) {
    if (!actor) return;
    if (typeof actor.reduceBuffStacks === "function") {
      return actor.reduceBuffStacks(type, amount);
    }
    // 兜底：直接操作 buffs 数组
    const buffs = [...(actor.system?.buffs ?? [])];
    const idx   = buffs.findIndex(b => b.type === type);
    if (idx === -1) return;
    const next = Math.max(0, (buffs[idx].stacks ?? 1) - amount);
    if (next <= 0) buffs.splice(idx, 1);
    else           buffs[idx] = { ...buffs[idx], stacks: next };
    return ClashManager._safeDocUpdate(actor, { "system.buffs": buffs });
  }

  /** 将 BUFF 类型键转换为中文显示名称。 */
  /** 返回 actor 装备格中所有已装入的物品（slot0–slot8）。 */
  static _getEquippedItems(actor) {
    if (!actor) return [];
    const eq = actor.system?.equipment ?? {};
    const items = [];
    for (let i = 0; i < 9; i++) {
      const id   = eq[`slot${i}`];
      const item = id ? actor.items.get(id) : null;
      if (item) items.push(item);
    }
    return items;
  }

  /** 对 item 触发 trigger，同时对 ctx.owner 装备格中所有物品也触发同一 trigger。
   *  "受到伤害时" 各路径已单独处理装备格循环，不应使用此方法。 */
  static async _applyActivitiesAndEquip(item, trigger, ctx) {
    await ClashManager._applyActivities(item, trigger, ctx);
    const owner = ctx.owner ?? null;
    if (!owner) return;
    for (const eq of ClashManager._getEquippedItems(owner)) {
      await ClashManager._applyActivities(eq, trigger, ctx);
    }
  }

  static _buffLabel(type) {
    const labels = {
      strong:"强壮", weak:"虚弱", endure:"忍耐", breach:"破绽",
      swift:"迅捷", bind:"束缚", guard:"守护", fragile:"易损",
      clashPowerUp:"拼点威力提升", clashPowerDown:"拼点威力降低",
      atkLevelUp:"攻击等级提升",   atkLevelDown:"攻击等级降低",
      defLevelUp:"防御等级提升",   defLevelDown:"防御等级降低",
      burn:"烧伤", bleed:"流血", tremor:"震颤", rupture:"破裂",
      sinking:"沉沦", breathing:"呼吸法", charge:"充能",
      chaos:"陷入混乱", panic:"陷入恐慌",
    };
    // 检查自定义 BUFF 注册表
    if (CustomBuffRegistry.has(type)) {
      return CustomBuffRegistry.get(type).label ?? type;
    }
    return labels[type] ?? type;
  }

  /** 给角色添加或叠加 BUFF。已有同类型则层数和强度均累加；无则新增。 */
  static async _addBuff(actor, type, intensity = 1, stacks = 1, whenAdded = "本回合") {
    if (!actor || !type) return;
    const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);

    // 查询自定义 BUFF 处理器（maxStacks / refreshOnGain）
    const customHandler = CustomBuffRegistry.get(type);
    const maxStacks     = customHandler?.maxStacks ?? Infinity;
    const refreshOnGain = customHandler?.refreshOnGain ?? false;

    // 按 type + whenAdded 精确匹配，防止本/下回合同类 BUFF 错误合并
    const idx   = buffs.findIndex(b => b.type === type && (b.whenAdded ?? "本回合") === whenAdded);
    if (idx >= 0) {
      if (refreshOnGain) {
        // 刷新：层数替换（不叠加），强度也替换
        buffs[idx].stacks    = Math.min(stacks, maxStacks);
        buffs[idx].intensity = intensity;
      } else {
        buffs[idx].stacks    = Math.min((buffs[idx].stacks ?? 0) + stacks, maxStacks);
        buffs[idx].intensity = (buffs[idx].intensity ?? 0) + intensity;
      }
      if (!buffs[idx].name) buffs[idx].name = ClashManager._buffLabel(type);
    } else {
      // 与 actor.addBuff 字段结构保持一致，确保状态栏正常显示
      const iconBase = "systems/limbusCompany_FVTT/assets/icons/Buff_icon/";
      const iconName = ClashManager._buffLabel(type);
      // 注册表自定义 BUFF 图标放在 Custom_buffs/ 子目录下
      const isCustomRegistered = CustomBuffRegistry.has(type);
      const icon = isCustomRegistered
        ? `${iconBase}Custom_buffs/${iconName}.webp`
        : (iconName !== type ? `${iconBase}${iconName}.webp` : `${iconBase}Custom_buffs/${type}.webp`);
      buffs.push({
        id:        foundry.utils.randomID(),
        type,
        name:      iconName,
        icon,
        intensity,
        stacks:    Math.min(stacks, maxStacks),
        whenAdded,
      });
    }
    await ClashManager._safeDocUpdate(actor, { "system.buffs": buffs });
  }

  /** 移除角色所有指定类型的 BUFF。 */
  static async _removeBuff(actor, type) {
    if (!actor || !type) return;
    if (typeof actor.removeBuffsByType === "function" && actor.canUserModify?.(game.user, "update")) {
      return actor.removeBuffsByType(type);
    }
    const buffs = (actor.system?.buffs ?? []).filter(b => b.type !== type);
    await ClashManager._safeDocUpdate(actor, { "system.buffs": buffs });
  }

  /**
   * 拼点胜负后理智变化。
   * 胜者：+round(10 × 1.2^(本轮胜利次数-1))，通过 actor flag "clashWinsThisRound" 追踪。
   * 败者：-(10 + max(0, 败者等级 - 胜者等级))，等级差为 actor.system.level 的直接差值。
   * @returns {{ gainNote:string, lossNote:string }}
   */
  static async _applySanityFromClash(winner, loser) {
    let gainNote = "";
    let lossNote = "";

    if (winner?.type === "character") {
      const prevWins  = (winner.getFlag?.("limbusCompany_FVTT", "clashWinsThisRound") ?? 0);
      await winner.setFlag?.("limbusCompany_FVTT", "clashWinsThisRound", prevWins + 1);
      const gain      = Math.round(10 * Math.pow(1.2, prevWins));
      const oldSanity = winner.system?.sanity?.value ?? 50;
      await winner.setSanity?.(oldSanity + gain);
      const roundNote = prevWins > 0 ? `，本轮第 ${prevWins + 1} 次拼点胜利` : "";
      gainNote = `<span style="color:#6EE06E">⬆ ${winner.name} 理智 +${gain}${roundNote}</span>`;
    }

    if (loser?.type === "character") {
      const winLv   = winner?.system?.level  ?? 0;
      const losLv   = loser.system?.level    ?? 0;
      const extra   = Math.max(0, losLv - winLv);
      const loss    = 10 + extra;
      const oldSanity = loser.system?.sanity?.value ?? 50;
      await loser.setSanity?.(oldSanity - loss);
      const lvNote = extra > 0 ? `，等级差 +${extra}（${losLv}-${winLv}）` : "";
      lossNote = `<span style="color:#E84444">⬇ ${loser.name} 理智 -${loss}（基础 10${lvNote}）</span>`;
    }

    return { gainNote, lossNote };
  }

  /**
   * 根据目标类型解析实际 Actor 列表。
   * "self"/"target" 返回单体数组；群体目标从队伍设置读取。
   */
  static _resolveTargets(targetType, owner, other) {
    if (targetType === "self")   return owner ? [owner] : [];
    if (targetType === "target") return other ? [other] : [];

    const ownerId = owner?.id;
    let team1Ids = [], team2Ids = [];
    try { team1Ids = game.settings.get("limbusCompany_FVTT", "squadTeam1") ?? []; } catch { /* 未注册时忽略 */ }
    try { team2Ids = game.settings.get("limbusCompany_FVTT", "squadTeam2") ?? []; } catch { /* 未注册时忽略 */ }

    const inTeam1  = team1Ids.includes(ownerId);
    const inTeam2  = !inTeam1 && team2Ids.includes(ownerId);
    const myIds    = inTeam1 ? team1Ids : inTeam2 ? team2Ids : [];
    const foeIds   = inTeam1 ? team2Ids : inTeam2 ? team1Ids : [];
    const toActors = ids => ids.map(id => game.actors.get(id)).filter(Boolean);

    switch (targetType) {
      case "allTeam":       return toActors(myIds);
      case "allTeamOther":  return toActors(myIds.filter(id => id !== ownerId));
      case "allEnemy":      return toActors(foeIds);
      case "allEnemyOther": return toActors(foeIds.filter(id => id !== ownerId));
      default:              return other ? [other] : [];
    }
  }

  /**
   * 执行 item.system.activities 中与 trigger 匹配的效果。
   * @param {Item}   item     携带活动效果的技能物品（攻击方或防守方的技能）
   * @param {string} trigger  触发时机（如 "使用时"、"命中时"）
   * @param {object} ctx      执行上下文
   * @param {Actor}  ctx.owner  使用该 item 的角色（攻击方或防守方）
   * @param {Actor}  [ctx.other]   对立方角色（可为 null）
   * @param {Actor}  [ctx.atkActor] 攻击方（用于最终上下文判断）
   * @param {Actor}  [ctx.defActor] 防守方
   * @param {object} [ctx._fireCounts]  每轮次数计数器（调用方传入同一对象以跨 trigger 共享）
   */
  static async _applyActivities(item, trigger, ctx = {}) {
    const acts = item?.system?.activities;
    if (!Array.isArray(acts) || acts.length === 0) return;

    const owner  = ctx.owner  ?? ctx.atkActor ?? null;
    const other  = ctx.other  ?? (owner === ctx.atkActor ? ctx.defActor : ctx.atkActor) ?? null;
    ctx._fireCounts = ctx._fireCounts ?? {};

    const msgs = [];

    for (const act of acts) {
      if (!act?.trigger || act.trigger !== trigger) continue;

      // ── 次数限制（perTurn / perEncounter）────────────────────────────────
      const limitType  = act.limit?.type;
      const limitCount = act.limit?.count ?? 0;
      const actKey     = `${item.id}_${act.name ?? trigger}`;
      if (limitType === "perTurn" && limitCount > 0) {
        const counts = owner?.getFlag?.("limbusCompany_FVTT", "turnFireCounts") ?? {};
        if ((counts[actKey] ?? 0) >= limitCount) continue;
      }
      if (limitType === "perEncounter" && limitCount > 0) {
        const counts = owner?.getFlag?.("limbusCompany_FVTT", "encounterFireCounts") ?? {};
        if ((counts[actKey] ?? 0) >= limitCount) continue;
      }

      // ── 前置条件 ─────────────────────────────────────────────────────
      // 兼容 V1（单对象 precondition）和 V2（数组 preconditions）
      const preconditions = Array.isArray(act.preconditions) ? act.preconditions
        : (act.precondition ? [act.precondition] : []);
      let precondFail = false;
      // 每类前置条件按 floor(层数/N) 计算倍数，传递给后续效果（与 cost.type==="perStack" 共用倍数变量）
      let precondMultiplier = 1;
      for (const pre of preconditions) {
        if (!pre) continue;

        // ── baseAttr 类型：检查角色属性值 ──────────────────────────────
        if (pre.type === "baseAttr") {
          const precTgt = (pre.target ?? "self") === "self" ? owner : other;
          if (!precTgt) { precondFail = true; break; }
          const curVal   = ClashManager._getAttrVal(precTgt, pre.attrType ?? "hp");
          const threshold = ClashManager._parseThreshold(pre.attrValue ?? "0", precTgt, pre.attrType ?? "hp");
          if (!ClashManager._cmp(curVal, pre.comparison ?? "lt", threshold)) { precondFail = true; break; }
          continue;
        }

        if (!pre.buff) continue;
        const preBuffType = pre.buff === "custom" ? (pre.buffCustom || "custom") : pre.buff;
        const precTgt = pre.target === "self" ? owner : other;
        const buff    = precTgt ? ClashManager._getBuff(precTgt, preBuffType) : null;

        if (pre.type === "buffCompare") {
          // 【比较值】：BUFF 层数或强度（compareDim）与指定值比较（未拥有视为 0）
          const have = (pre.compareDim ?? "stacks") === "intensity"
            ? (buff?.intensity ?? 0) : (buff?.stacks ?? 0);
          if (!ClashManager._cmp(have, pre.comparison ?? "eq", pre.stacks ?? 0)) { precondFail = true; break; }
          continue;
        }

        if (pre.type === "perN") {
          // 每：层数 ≥ N（N = pre.stacks）才满足，倍数 = floor(当前层数 / N)，可选上限 maxTimes
          const n = Math.max(1, pre.stacks ?? 1);
          if (!buff || (buff.stacks ?? 0) < n) { precondFail = true; break; }
          if ((pre.intensity ?? 0) > 0 && (buff.intensity ?? 0) < pre.intensity) { precondFail = true; break; }
          let times = Math.floor((buff.stacks ?? 0) / n);
          if ((pre.maxTimes ?? 0) > 0) times = Math.min(times, pre.maxTimes);
          precondMultiplier *= times;
        } else {
          // 【拥有】（默认）：达到指定强度/层数阈值即满足
          if (!buff) { precondFail = true; break; }
          if ((pre.intensity ?? 0) > 0 && (buff.intensity ?? 0) < pre.intensity) { precondFail = true; break; }
          if ((pre.stacks    ?? 0) > 0 && (buff.stacks    ?? 0) < pre.stacks)    { precondFail = true; break; }
        }
      }
      if (precondFail) continue;

      // ── 消耗（cost） ─────────────────────────────────────────────────
      // 兼容 V1（单对象 cost）和 V2（数组 costs）
      const costs = Array.isArray(act.costs) ? act.costs
        : (act.cost ? [act.cost] : []);

      // 强制消耗：先校验资源是否充足，不足则跳过整条 Activity
      let forcedFail = false;
      for (const cost of costs) {
        if (!cost) continue;
        if (cost.type === "attribute") {
          // 基础属性消耗：始终视为强制
          const costTgts = ClashManager._resolveTargets(cost.target ?? "self", owner, other);
          if (costTgts.length === 0) { forcedFail = true; break; }
          const need = cost.value ?? 1;
          for (const tgt of costTgts) {
            const sys = tgt.system;
            let have = 0;
            if      (cost.attrType === "hp")     have = sys.hp?.value     ?? 0;
            else if (cost.attrType === "sanity")  have = sys.sanity?.value ?? 0;
            else if (cost.attrType === "ap")      have = sys.ap?.value     ?? 0;
            if (have < need) { forcedFail = true; break; }
          }
        } else if (cost.type === "discard") {
          // 验证丢弃目标是否存在于战斗槽
          const ownerSheet = owner?.sheet;
          const bagState = ownerSheet?._combatBagState;
          if (!bagState) { forcedFail = true; break; }
          const mode = cost.discardMode ?? "level";
          if (mode === "level") {
            const level = cost.discardLevel ?? 1;
            const found = [0, 1].some(i => {
              const id = bagState.slots[i];
              if (!id) return false;
              const sk = owner.items.get(id);
              return sk && (sk.system?.level ?? 1) === level;
            });
            if (!found) { forcedFail = true; break; }
          } else if (mode === "another") {
            const currentId = ctx._currentItemId ?? "";
            const found = [0, 1].some(i => bagState.slots[i] && bagState.slots[i] !== currentId);
            if (!found) { forcedFail = true; break; }
          } else if (mode === "reserve") {
            if (!bagState.slots[2]) { forcedFail = true; break; }
          }
        } else if (cost.buff && (cost.type === "forced" || cost.type === "perStack")) {
          // 强制消耗 / 每：层数不足（每N层的 N）则跳过整条 Activity
          const costBuffType = cost.buff === "custom" ? (cost.buffCustom || "custom") : cost.buff;
          const costTgts = ClashManager._resolveTargets(cost.target ?? "self", owner, other);
          if (costTgts.length === 0) { forcedFail = true; break; }
          for (const tgt of costTgts) {
            const existing = ClashManager._getBuff(tgt, costBuffType);
            if ((existing?.stacks ?? 0) < Math.max(1, cost.stacks ?? 1)) { forcedFail = true; break; }
          }
        }
        if (forcedFail) break;
      }
      if (forcedFail) continue;

      // 倍数默认取自每前置条件计算结果；若另有 perStack 消耗，会在下方覆盖为实际消耗层数
      let perStackMultiplier = precondMultiplier;
      let _discardedItemId = null;
      for (const cost of costs) {
        if (!cost) continue;
        if (cost.type === "discard") {
          const ownerSheet = owner?.sheet;
          if (ownerSheet?._discardCombatSkill) {
            const mode  = cost.discardMode ?? "level";
            const level = cost.discardLevel ?? 1;
            const currentId = ctx._currentItemId ?? item?.id ?? "";
            const { discardedId } = await ownerSheet._discardCombatSkill(mode, level, currentId);
            _discardedItemId = discardedId;
            // 触发被丢弃技能的【丢弃时】活动
            if (discardedId) {
              const discardedItem = owner.items.get(discardedId);
              if (discardedItem) {
                await ClashManager._applyActivities(discardedItem, "丢弃时", {
                  owner,
                  atkActor: ctx.atkActor ?? owner,
                  defActor: ctx.defActor ?? (other ?? owner),
                  _fireCounts: ctx._fireCounts ?? {},
                  _actMsgs:   ctx._actMsgs   ?? [],
                });
              }
            }
          }
          continue;
        } else if (cost.type === "attribute") {
          // 消耗基础属性
          const costTgts = ClashManager._resolveTargets(cost.target ?? "self", owner, other);
          const need = cost.value ?? 1;
          for (const tgt of costTgts) {
            const sys = tgt.system;
            if (cost.attrType === "hp") {
              await tgt.update({ "system.hp.value": Math.max(0, (sys.hp?.value ?? 0) - need) });
            } else if (cost.attrType === "sanity") {
              await tgt.update({ "system.sanity.value": Math.max(5, Math.min(95, (sys.sanity?.value ?? 50) - need)) });
            } else if (cost.attrType === "ap") {
              await tgt.update({ "system.ap.value": Math.max(0, (sys.ap?.value ?? 0) - need) });
            }
          }
        } else if (cost.buff) {
          const costBuffType = cost.buff === "custom" ? (cost.buffCustom || "custom") : cost.buff;
          const costTgts = ClashManager._resolveTargets(cost.target ?? "self", owner, other);
          if (cost.type === "perStack") {
            // 每：与前置条件的"每"一致——每 N 层为 1 倍，倍数 = floor(层数/N)，
            // 可选最大倍数上限（maxTimes，0=无限），只消耗 倍数×N 层
            const tgt = costTgts[0];
            if (tgt) {
              const existing = ClashManager._getBuff(tgt, costBuffType);
              const have     = existing?.stacks ?? 0;
              const n        = Math.max(1, cost.stacks ?? 1);
              let   times    = Math.floor(have / n);
              if ((cost.maxTimes ?? 0) > 0) times = Math.min(times, cost.maxTimes);
              await ClashManager._reduceBuffStacks(tgt, costBuffType, times * n);
              perStackMultiplier = times;
            }
          } else if (cost.type !== "none") {
            for (const tgt of costTgts) {
              await ClashManager._reduceBuffStacks(tgt, costBuffType, cost.stacks ?? 1);
            }
          }
        }
      }

      // ── 效果（effects）────────────────────────────────────────────────
      // 兼容 V1（单对象 effect）和 V2（数组 effects）
      const effects = Array.isArray(act.effects) ? act.effects
        : (act.effect ? [act.effect] : []);

      for (const eff of effects) {
        if (!eff?.type) continue;
        const effTgts = ClashManager._resolveTargets(eff.target ?? "self", owner, other);
        if (effTgts.length === 0) continue;

        for (const effTgt of effTgts) {

        // BUFF 型效果用 intensity/stacks；数值型效果用 value
        // 若存在每前置条件/消耗，stacks 和 数值型 val 均乘以倍数
        const intensity = Number(eff.intensity ?? eff.value ?? 1);
        const stacks    = Number(eff.stacks    ?? 1) * perStackMultiplier;
        const buffType  = eff.buff === "custom" ? (eff.buffCustom || "custom") : (eff.buff || "");
        // 数值型效果（非BUFF）的 perN 倍数：绝对值模式不放大，相对值模式放大
        const _scaleVal = (rawVal, mode) =>
          (mode === "absolute" || perStackMultiplier === 1) ? rawVal : rawVal * perStackMultiplier;

        let descStr = "";
        switch (eff.type) {
          case "addBuff": {
            const round = eff.round ?? "本回合";
            if (round === "本回合和下回合") {
              // 分别写入两条同类 BUFF，本回合立即生效，下回合在回合结束时晋升
              await ClashManager._addBuff(effTgt, buffType, intensity, stacks, "本回合");
              await ClashManager._addBuff(effTgt, buffType, intensity, stacks, "下回合");
            } else {
              await ClashManager._addBuff(effTgt, buffType, intensity, stacks, round);
            }
            const roundLabel = round === "本回合" ? "" : `（${round}）`;
            descStr = `为【${effTgt.name}】添加 ${stacks} 层 ${buffType}（强度 ${intensity}）${roundLabel}`;
            break;
          }
          case "removeBuff":
            await ClashManager._removeBuff(effTgt, buffType);
            descStr = `移除【${effTgt.name}】的 ${buffType}`;
            break;
          case "hpAdj": {
            const { mode, value: rawVal } = await ClashManager._evalSignedValue(eff.value, eff.intensity);
            const val = _scaleVal(rawVal, mode);
            const cur = effTgt.system?.hp?.value ?? 0;
            const max = effTgt.system?.hp?.max   ?? 1;
            const nv  = mode === "absolute"
              ? Math.max(0, Math.min(max, val))
              : Math.max(0, Math.min(max, cur + val));
            await ClashManager._safeDocUpdate(effTgt, { "system.hp.value": nv });
            descStr = mode === "absolute"
              ? `【${effTgt.name}】HP 调整为 ${nv}`
              : `【${effTgt.name}】HP ${val >= 0 ? "+" : ""}${val}（${cur} → ${nv}）`;
            break;
          }
          case "sanityAdj": {
            const { mode, value: rawVal } = await ClashManager._evalSignedValue(eff.value, eff.intensity);
            const val    = _scaleVal(rawVal, mode);
            const cur    = effTgt.system?.sanity?.value ?? 50;
            const target = mode === "absolute" ? val : cur + val;
            if (typeof effTgt.setSanity === "function" && effTgt.canUserModify?.(game.user, "update")) {
              await effTgt.setSanity(target);
            } else {
              await ClashManager._safeDocUpdate(effTgt, { "system.sanity.value": Math.max(5, Math.min(95, target)) });
            }
            descStr = mode === "absolute"
              ? `【${effTgt.name}】理智 调整为 ${Math.max(5, Math.min(95, target))}`
              : `【${effTgt.name}】理智 ${val >= 0 ? "+" : ""}${val}`;
            break;
          }
          case "atkAdj": {
            const val = Number(eff.value ?? eff.intensity ?? 0) * perStackMultiplier;
            const cur = effTgt.system?.atk?.extra ?? 0;
            await ClashManager._safeDocUpdate(effTgt, { "system.atk.extra": cur + val });
            descStr = `【${effTgt.name}】攻击等级 ${val >= 0 ? "+" : ""}${val}`;
            break;
          }
          case "defAdj": {
            const val = Number(eff.value ?? eff.intensity ?? 0) * perStackMultiplier;
            const cur = effTgt.system?.def?.extra ?? 0;
            await ClashManager._safeDocUpdate(effTgt, { "system.def.extra": cur + val });
            descStr = `【${effTgt.name}】防御等级 ${val >= 0 ? "+" : ""}${val}`;
            break;
          }
          case "apAdj": {
            const { mode, value: rawVal } = await ClashManager._evalSignedValue(eff.value, eff.intensity);
            const val = _scaleVal(rawVal, mode);
            const cur = effTgt.system?.ap?.value ?? 0;
            const max = effTgt.system?.ap?.max   ?? 3;
            const nv  = mode === "absolute"
              ? Math.max(0, Math.min(max, val))
              : Math.max(0, Math.min(max, cur + val));
            await ClashManager._safeDocUpdate(effTgt, { "system.ap.value": nv });
            descStr = mode === "absolute"
              ? `【${effTgt.name}】行动值 调整为 ${nv}`
              : `【${effTgt.name}】行动值 ${val >= 0 ? "+" : ""}${val}（${cur} → ${nv}）`;
            break;
          }
          case "weightAdj": {
            const { mode, value: rawVal } = await ClashManager._evalSignedValue(eff.value, eff.intensity);
            const val = _scaleVal(rawVal, mode);
            const cur = item.system?.weight ?? 0;
            const nv  = mode === "absolute" ? Math.max(0, val) : Math.max(0, cur + val);
            await ClashManager._safeDocUpdate(item, { "system.weight": nv });
            descStr = mode === "absolute"
              ? `【${item.name}】加重值 调整为 ${nv}`
              : `【${item.name}】加重值 ${val >= 0 ? "+" : ""}${val}（${cur} → ${nv}）`;
            break;
          }
          case "diceAdj": {
            // 骰数：累加或赋值骰子数量，下限 1
            const { mode, value: rawVal } = await ClashManager._evalSignedValue(eff.value, eff.intensity);
            const val = _scaleVal(rawVal, mode);
            const cur = item.system?.diceCount ?? 1;
            const nv  = mode === "absolute" ? Math.max(1, val) : Math.max(1, cur + val);
            await ClashManager._safeDocUpdate(item, { "system.diceCount": nv });
            descStr = mode === "absolute"
              ? `【${item.name}】骰数 调整为 ${nv}d`
              : `【${item.name}】骰数 ${val >= 0 ? "+" : ""}${val}（${cur}d → ${nv}d）`;
            break;
          }
          case "diceFacesAdj": {
            // 面数：累加或赋值骰子面数，下限 2
            const { mode, value: rawVal } = await ClashManager._evalSignedValue(eff.value, eff.intensity);
            const val = _scaleVal(rawVal, mode);
            const cur = item.system?.diceFaces ?? 4;
            const nv  = mode === "absolute" ? Math.max(2, val) : Math.max(2, cur + val);
            await ClashManager._safeDocUpdate(item, { "system.diceFaces": nv });
            descStr = mode === "absolute"
              ? `【${item.name}】面数 d${cur} → d${nv}`
              : `【${item.name}】面数 ${val >= 0 ? "+" : ""}${val}（d${cur} → d${nv}）`;
            break;
          }
          case "baseValue": {
            // 基础值：累加或赋值固定加值，允许负数
            const { mode, value: rawVal } = await ClashManager._evalSignedValue(eff.value, eff.intensity);
            const val = _scaleVal(rawVal, mode);
            const cur = item.system?.baseValue ?? 0;
            const nv  = mode === "absolute" ? val : cur + val;
            await ClashManager._safeDocUpdate(item, { "system.baseValue": nv });
            descStr = mode === "absolute"
              ? `【${item.name}】基础值 调整为 ${nv}`
              : `【${item.name}】基础值 ${val >= 0 ? "+" : ""}${val}（${cur} → ${nv}）`;
            break;
          }
          case "seismicBlast": {
            // 对目标触发【震颤引爆】N次（N = eff.value）
            // 每次引爆：消耗目标1层【震颤】，所有混乱阈值前移【震颤强度】%
            const blastCount = Math.max(1, Math.round(Number(eff.value ?? 1)));
            const tremorBuff = ClashManager._getBuff(effTgt, "tremor");
            if (!tremorBuff || (tremorBuff.stacks ?? 0) <= 0) {
              descStr = `【${effTgt.name}】无【震颤】状态，震颤引爆未触发`;
              break;
            }
            const tremorIntensity = tremorBuff.intensity ?? 1;
            let actualBlasts = 0;
            for (let bi = 0; bi < blastCount; bi++) {
              const currentTremor = ClashManager._getBuff(
                game.actors.get(effTgt.id) ?? effTgt, "tremor"
              );
              if (!currentTremor || (currentTremor.stacks ?? 0) <= 0) break;
              await (effTgt.triggerSeismicBlast
                ? effTgt.triggerSeismicBlast(tremorIntensity)
                : (async () => {
                    const tList = (effTgt.system?.chaosThresholds ?? []).map(t => ({
                      percent:   Math.min(100, t.percent + tremorIntensity),
                      triggered: t.triggered,
                    }));
                    await ClashManager._safeDocUpdate(effTgt, { "system.chaosThresholds": tList });
                  })()
              );
              await ClashManager._reduceBuffStacks(effTgt, "tremor", 1);
              actualBlasts++;
            }
            descStr = actualBlasts > 0
              ? `【${effTgt.name}】震颤引爆 ×${actualBlasts}，混乱阈值各前移 ${tremorIntensity}%`
              : `【${effTgt.name}】震颤引爆未触发（震颤层数不足）`;
            break;
          }
          case "randomBuff": {
            // 从 buffPool 中随机不重复抽取 count 个 BUFF 添加（每项有独立 intensity/stacks）
            const pool  = eff.buffPool ?? [];
            if (!pool.length) { descStr = "随机BUFF：未配置BUFF池"; break; }
            const count = Math.min(Math.max(1, Math.round(Number(eff.count ?? 1))), pool.length);
            // Fisher-Yates 部分洗牌取前 count 项
            const shuffled = pool.slice();
            for (let i = 0; i < count; i++) {
              const j = i + Math.floor(Math.random() * (shuffled.length - i));
              [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            const chosen = shuffled.slice(0, count);
            const round  = eff.round ?? "本回合";
            const appliedLabels = [];
            for (const entry of chosen) {
              const b = entry.buff === "custom" ? (entry.buffCustom?.trim() || "custom") : (entry.buff ?? "");
              const n = entry.intensity ?? 1;
              const s = entry.stacks ?? 1;
              if (round === "本回合和下回合") {
                await ClashManager._addBuff(effTgt, b, n, s, "本回合");
                await ClashManager._addBuff(effTgt, b, n, s, "下回合");
              } else {
                await ClashManager._addBuff(effTgt, b, n, s, round);
              }
              appliedLabels.push(`【${ClashManager._buffLabel(b)}】×${s}`);
            }
            const roundLabel = round === "本回合" ? "" : `（${round}）`;
            descStr = `为【${effTgt.name}】随机添加 ${appliedLabels.join("、")}${roundLabel}`;
            break;
          }
          case "triggerBuff": {
            // 触发目标/自身身上 N 层指定BUFF：消耗层数，并立即造成对应伤害
            // 震颤不参与此效果（使用 seismicBlast）
            const buffType = eff.trigBuff === "custom"
              ? (eff.trigBuffCustom?.trim() ?? "")
              : (eff.trigBuff ?? "");
            if (!buffType) { descStr = `触发BUFF：未指定BUFF类型`; break; }

            const wantStacks  = Math.max(1, Math.round(Number(eff.trigStacks ?? 1)));
            const existBuff   = ClashManager._getBuff(effTgt, buffType);
            if (!existBuff || (existBuff.stacks ?? 0) <= 0) {
              descStr = `【${effTgt.name}】无【${ClashManager._buffLabel(buffType)}】，触发未生效`;
              break;
            }

            const actualStacks = Math.min(wantStacks, existBuff.stacks ?? 0);
            const intensity    = existBuff.intensity ?? 0;
            await ClashManager._reduceBuffStacks(effTgt, buffType, actualStacks);

            // 各特殊BUFF对应的即时伤害规则
            const HP_DMG_BUFFS = new Set(["burn", "bleed", "rupture"]);
            let totalDmg = 0;
            let dmgNote  = "";
            if (HP_DMG_BUFFS.has(buffType) && intensity > 0) {
              totalDmg = actualStacks * intensity;
              dmgNote  = `，受到 ${totalDmg} 点伤害（${actualStacks}×${intensity}）`;
            } else if (buffType === "sinking" && intensity > 0) {
              const sanity = effTgt.system?.sanity?.value ?? 50;
              totalDmg = actualStacks * intensity * sanity;
              dmgNote  = `，受到 ${totalDmg} 点理智伤害（${actualStacks}×${intensity}×${sanity}）`;
            }
            if (totalDmg > 0) {
              const curHp = effTgt.system?.hp?.value ?? 0;
              await ClashManager._safeDocUpdate(effTgt, { "system.hp.value": Math.max(0, curHp - totalDmg) });
            }

            const buffLabel = ClashManager._buffLabel(buffType);
            descStr = `【${effTgt.name}】触发 ${actualStacks} 层【${buffLabel}】${dmgNote}`;
            break;
          }
          case "diceTypeChg": {
            const newDiceType = eff.diceTypeVal ?? "normal";
            if (item) {
              await ClashManager._safeDocUpdate(item, { "system.diceType": newDiceType });
              const label = newDiceType === "unbreakable" ? "不可摧毁" : "一般骰子";
              descStr = `【${item.name}】骰子类型变更为【${label}】`;
            }
            break;
          }
          case "useSkill": {
            let skillItem = null;
            if (eff.skillRef === "equipped") {
              const slot  = eff.skillSlot ?? "basic";
              const level = Math.max(1, parseInt(eff.skillLevel) || 1);
              if (slot === "defense") {
                const defId = owner?.system?.skills?.defense;
                skillItem = defId ? owner?.items?.get(defId) : null;
              } else {
                const basicSlots = owner?.system?.skills?.basic ?? [];
                skillItem = basicSlots[level - 1] ? owner?.items?.get(basicSlots[level - 1]) : null;
              }
              if (!skillItem) {
                const lbl = slot === "defense" ? "守备技能" : `Lv.${level} 基础技能`;
                descStr = `未找到已装备的${lbl}`;
                break;
              }
            } else {
              const uuid = eff.skillUuid ?? "";
              if (!uuid) { descStr = "useSkill：未配置技能UUID"; break; }
              skillItem = await fromUuid(uuid).catch(() => null);
              if (!skillItem) { descStr = `useSkill：找不到技能 ${uuid}`; break; }
            }
            // 守备技能 → 触发其[使用时] Activities
            if (skillItem.system?.type === "defense") {
              await ClashManager._applyActivities(skillItem, "使用时", {
                owner, atkActor: ctx.atkActor, defActor: ctx.defActor,
                _fireCounts: {}, _actMsgs: ctx._actMsgs ?? [],
              });
              descStr = `触发【${skillItem.name}】[使用时]`;
            } else {
              // 非守备技能 → 弹出对抗发起窗口（仅限有 AP 的场景，AP 不足则跳过）
              const curAP = owner?.system?.ap?.value ?? 0;
              if (owner && curAP <= 0) await owner.update({ "system.ap.value": 1 });
              await ClashManager.showInitiateDialog(owner, skillItem, -2);
              descStr = `发起对抗：【${skillItem.name}】`;
            }
            break;
          }
          default:
            // relatedSkillConvert 等其他特殊效果暂不在此处理
            descStr = `${eff.type} 效果触发`;
            break;
        }

        const actName = act.name ? `${act.name}：` : "";
        if (descStr) msgs.push(`${actName}${descStr}`);
        } // end for effTgt
      }

      // 记录触发次数（写入 actor flags 以实现跨 action 持久化）
      if ((limitType === "perTurn" || limitType === "perEncounter") && limitCount > 0 && owner?.setFlag) {
        const flagKey = limitType === "perTurn" ? "turnFireCounts" : "encounterFireCounts";
        const counts  = foundry.utils.deepClone(owner.getFlag?.("limbusCompany_FVTT", flagKey) ?? {});
        counts[actKey] = (counts[actKey] ?? 0) + 1;
        await owner.setFlag("limbusCompany_FVTT", flagKey, counts);
      }
    }

    if (msgs.length === 0) return;

    // 若 ctx 提供了共享收集桶，则延迟汇总（避免一次对抗产生多条 ChatMessage 触发 Foundry 清理竞态）
    if (Array.isArray(ctx._actMsgs)) {
      ctx._actMsgs.push({ trigger, itemName: item?.name ?? "", ownerName: owner?.name ?? "", msgs });
      return;
    }

    // 无收集桶时立即发（兼容 [使用时] 等独立触发场景）
    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: owner }),
      content: ClashManager._buildActMsgContent([{ trigger, itemName: item?.name ?? "", msgs }]),
    });
  }

  /**
   * 将收集桶中的活动消息一次性发出（一次对抗只发一条汇总 ChatMessage）。
   * @param {object[]} actMsgs  ctx._actMsgs 数组
   * @param {Actor}    speaker  消息发言人（通常为攻击方）
   */
  static async _flushActMsgs(actMsgs, speaker) {
    if (!actMsgs?.length) return;
    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: speaker }),
      content: ClashManager._buildActMsgContent(actMsgs),
    });
  }

  /** 构建活动效果汇总消息的 HTML 内容。 */
  static _buildActMsgContent(entries) {
    const rows = entries.map(({ trigger, itemName, msgs }) => `
      <div style="margin-bottom:4px;">
        <span style="font-weight:bold;color:#C9A84C;">⚡ [${trigger}] ${itemName}</span>
        ${msgs.map(m => `<div style="color:#E8C9A2;padding-left:8px;">${m}</div>`).join("")}
      </div>`).join(ClashManager._goldDivider());
    // 超过 2 个触发条目时折叠详情
    const body = `<div style="font-size:.8rem;line-height:1.7;">${rows}</div>`;
    if (entries.length <= 2) {
      return `<div class="limbus-clash-card">${body}</div>`;
    }
    return `<div class="limbus-clash-card">
      <details>
        <summary style="cursor:pointer;font-size:.8rem;color:#C9A84C;font-weight:bold;user-select:none;list-style:none;">
          ▼ 详细信息（${entries.length} 条触发效果）
        </summary>
        ${body}
      </details>
    </div>`;
  }

  /**
   * 包装 ChatMessage.create()，捕获 Foundry v13 自动清理竞态产生的"does not exist"错误，
   * 避免 Uncaught (in promise) 污染控制台。
   */
  static async _safeChatCreate(data) {
    try {
      return await ChatMessage.create(data);
    } catch (err) {
      // 忽略 Foundry 内部消息清理竞态错误（"ChatMessage X does not exist!"）
      if (err?.message?.includes("does not exist")) return null;
      throw err;
    }
  }

  /**
   * 处理【流血】：持有 bleed 的角色执行攻击动作时，受到强度点固定伤害，层数-1。
   * @param {Actor} actor  持有 bleed 的攻击方/响应方
   * @returns {number} 实际造成的流血伤害（0 = 未触发）
   */
  static async _processBleed(actor) {
    const buff = ClashManager._getBuff(actor, "bleed");
    if (!buff || buff.stacks <= 0) return 0;

    const dmg   = buff.intensity ?? 0;
    const oldHp = actor.system.hp?.value ?? 0;
    const newHp = Math.max(0, oldHp - dmg);

    const maxHpForBleed      = actor.system.hp?.max ?? 1;
    const _BC_TYPES          = ["chaos", "chaos_plus", "chaos_double_plus"];
    const _BC_NAMES          = ["陷入混乱", "陷入混乱+", "陷入混乱++"];
    const bleedChaosCount    = (actor.system.chaosThresholds ?? []).filter(
      t => !t.triggered && newHp <= maxHpForBleed * t.percent / 100
    ).length;
    const bleedExistingType  = (actor.system.buffs ?? []).find(b => _BC_TYPES.includes(b.type))?.type;
    const bleedCurrentLevel  = bleedExistingType ? (_BC_TYPES.indexOf(bleedExistingType) + 1) : 0;
    const bleedNewLevel      = Math.min(3, bleedCurrentLevel + bleedChaosCount);
    const bleedChaosName     = _BC_NAMES[bleedNewLevel - 1] ?? "陷入混乱";
    await actor.update({ "system.hp.value": newHp });
    await ClashManager._reduceBuffStacks(actor, "bleed");
    if (actor.checkAndTriggerChaos) await actor.checkAndTriggerChaos(newHp, oldHp, { silent: true });

    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="limbuscompany chat-clash">
        <strong>${actor.name}</strong>【流血】发作：受到 <strong>${dmg}</strong> 点固定伤害。
        （HP ${oldHp} → ${newHp}）${bleedChaosCount > 0 ? `　<span style='color:#E84444;font-weight:bold;'>——【${bleedChaosName}】！</span>` : ""}
      </div>`,
    });
    return dmg;
  }

  static _effectDesc(item) {
    const sys = item?.system ?? {};
    const manualDesc = sys.effectDesc ?? "";

    const actLines = [];
    if (Array.isArray(sys.activities)) {
      for (const act of sys.activities) {
        if (!act.trigger) continue;
        const effStr = ClashManager._actStr(act);
        if (effStr) actLines.push(`[${act.trigger}] ${effStr}`);
      }
    }

    // 无任何描述：返回空字符串
    if (!manualDesc && !actLines.length) return "";

    // 手写描述直接显示；Activity 自动描述折叠隐藏
    const manualHtml = manualDesc
      ? `<div style="color:#9A8462;">${manualDesc}</div>`
      : "";
    const actHtml = actLines.length
      ? `<details style="margin-top:2px;">
           <summary style="cursor:pointer;color:#6A7A5A;font-size:.75rem;list-style:none;">
             ▸ 技能效果详情
           </summary>
           ${actLines.map(l => `<div style="color:#6A7A5A;padding-left:6px;">${l}</div>`).join("")}
         </details>`
      : "";

    return manualHtml + actHtml;
  }

  static _actStr(act) {
    // 兼容 V1（单对象 effect）和 V2（数组 effects）
    const eff = act.effect ?? (Array.isArray(act.effects) ? act.effects[0] : null);
    if (!eff?.type) return "";
    const t   = eff.type;
    const tgt = eff.target === "self" ? "自己" : "目标";
    const buffName = eff.buff === "custom" ? (eff.buffCustom || "自定义") : ClashManager._buffLabel(eff.buff ?? "");
    if (t === "addBuff")    return `为${tgt}添加 ${eff.stacks ?? 1} 层 ${buffName}`;
    if (t === "removeBuff") return `移除${tgt}的${buffName}`;
    if (t === "hpAdj")    { const v = eff.value ?? eff.intensity ?? 0; return `${tgt}生命值 ${v >= 0 ? "+" : ""}${v}`; }
    if (t === "sanityAdj"){ const v = eff.value ?? eff.intensity ?? 0; return `${tgt}理智 ${v >= 0 ? "+" : ""}${v}`; }
    if (t === "apAdj")       { const v = eff.value ?? eff.intensity ?? 0; return `${tgt}行动值 ${v >= 0 ? "+" : ""}${v}`; }
    if (t === "weightAdj")   { const v = eff.value ?? eff.intensity ?? 0; return `技能加重值 ${v >= 0 ? "+" : ""}${v}`; }
    if (t === "diceAdj")     { const v = eff.value ?? eff.intensity ?? 0; return `技能骰数 ${v >= 0 ? "+" : ""}${v}`; }
    if (t === "diceFacesAdj"){ const v = eff.value ?? eff.intensity ?? 0; return `技能面数 → d${v}`; }
    if (t === "baseValue")   { const v = eff.value ?? eff.intensity ?? 0; return `技能基础值 ${v >= 0 ? "+" : ""}${v}`; }
    if (t === "seismicBlast") return `对${tgt}触发震颤引爆 ×${eff.value ?? 1}`;
    if (t === "triggerBuff") {
      const bn = eff.trigBuff === "custom" ? (eff.trigBuffCustom || "自定义") : ClashManager._buffLabel(eff.trigBuff ?? "");
      return `触发${tgt} ${eff.trigStacks ?? 1} 层 ${bn}`;
    }
    if (t === "randomBuff") {
      const pool  = (eff.buffPool ?? []).map(e => ClashManager._buffLabel(e.buff ?? "")).join("、");
      const count = eff.count ?? 1;
      return `为${tgt}随机抽取 ${count} 个BUFF（${pool || "未配置"}）`;
    }
    if (t === "diceTypeChg") {
      const label = eff.diceTypeVal === "unbreakable" ? "不可摧毁" : "一般骰子";
      return `技能骰子类型变更为【${label}】`;
    }
    return "";
  }

  static _goldDivider() {
    return `<div style="height:1px;margin:8px 0;background:linear-gradient(90deg,transparent 0%,#C9A84C 30%,#C9A84C 70%,transparent 100%);"></div>`;
  }

  static _chatHeader(actor, title) {
    const img  = actor?.img ?? "icons/svg/mystery-man.svg";
    const name = actor?.name ?? "未知";
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <img src="${img}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;border:2px solid #C9A84C;flex-shrink:0;" alt="">
        <div>
          <div style="font-size:20px;font-weight:bold;color:#E8C9A2;">${title}</div>
          <div style="font-size:13px;color:#E8CAA1;">${name}</div>
        </div>
      </div>`;
  }

  static _skillRow(item) {
    const sys      = item?.system ?? {};
    const catIcon  = ClashManager._catIcon(sys.category);
    const catLabel = ClashManager._catLabel(sys.category);
    const sinColor = ClashManager._sinColor(sys.sinType);
    const formula  = sys.diceFormula ?? "1d4";
    return `
      <div style="display:flex;align-items:center;gap:12px;margin:8px 0;">
        <img src="${item.img}" style="width:50px;height:50px;object-fit:cover;border:2px solid ${sinColor};flex-shrink:0;" alt="${item.name}">
        <div>
          <div style="font-size:16px;font-weight:bold;color:#E8C9A2;">${item.name}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:3px;">
            ${catIcon ? `<img src="${catIcon}" style="width:16px;height:16px;" alt="${catLabel}">` : ""}
            <span style="font-size:16px;color:#EBBD68;">${formula.toUpperCase()}</span>
          </div>
        </div>
      </div>`;
  }

  /* ─── 阶段一：发起对抗弹窗 ────────────────────────────────────────────── */

  static async showInitiateDialog(actor, item, slotIndex = -1) {
    const sys      = item.system ?? {};
    const formula  = sys.diceFormula ?? "1d4";
    const catIcon  = ClashManager._catIcon(sys.category);
    const catLabel = ClashManager._catLabel(sys.category);
    const isEgo    = sys.type === "ego";
    const cfg      = CONFIG.LIMBUSCOMPANY ?? {};

    // ── 恐慌状态检查：恐慌时只能使用 EGO 技能 ──────────────────────────
    const isInPanic = !!ClashManager._getBuff(actor, "panic");
    if (isInPanic && !isEgo) {
      ui.notifications.warn(`【陷入恐慌】${actor.name} 只能使用 E.G.O 技能！`);
      return false;
    }

    // ── EGO 消耗预览 HTML ────────────────────────────────────────────────
    let egoCostHtml = "";
    if (isEgo) {
      const sinCost    = sys.sinCost    ?? [];
      const sanityCost = sys.sanityCost ?? 0;
      // 恐慌时：罪孽资源 ×1.5，理智消耗豁免
      const effectiveSinCost      = isInPanic ? sinCost.map(e => ({ ...e, amount: Math.ceil(e.amount * 1.5) })) : sinCost;
      const effectiveSanityCost   = isInPanic ? 0 : sanityCost;
      const sinParts   = effectiveSinCost.map(({ sinType, amount }) => {
        const icon     = cfg.SIN_ICON_PATHS?.[sinType] ?? "";
        const cur      = SinResourceHUD.getSins()[sinType] ?? 0;
        const ok       = cur >= amount;
        const origAmt  = sinCost.find(e => e.sinType === sinType)?.amount ?? amount;
        const suffix   = isInPanic && amount !== origAmt
          ? `<span style="font-size:.65rem;color:#E88844;"> ×1.5</span>` : "";
        return `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:6px;
                              color:${ok ? "#C89E70" : "#E84444"};">
          ${icon ? `<img src="${icon}" style="width:16px;height:16px;border-radius:50%;vertical-align:middle;">` : ""}
          <strong>${amount}</strong>${suffix}<span style="font-size:.7rem;color:#9A8462;">(${cur})</span>
        </span>`;
      }).join("");
      const sanCur  = actor.system?.sanity?.value ?? 50;
      const sanOk   = effectiveSanityCost <= 0 || (sanCur - effectiveSanityCost) >= 5;
      const sanPart = isInPanic && sanityCost > 0
        ? `<span style="color:#9A8462;margin-left:4px;font-style:italic;"></span>`
        : effectiveSanityCost > 0
          ? `<span style="color:${sanOk ? "#C89E70" : "#E84444"};margin-left:4px;">
               理智 -${effectiveSanityCost}（当前 ${sanCur}）
             </span>`
          : "";
      const panicNote = isInPanic
        ? `<div style="font-size:.7rem;color:#E8A444;margin-bottom:4px;">【陷入恐慌】罪孽消耗 ×1.5，侵蚀状态</div>`
        : "";
      if (panicNote || sinParts || sanPart) {
        egoCostHtml = `<div style="margin-bottom:10px;padding:6px 8px;border-radius:3px;
                                    background:rgba(30,15,5,0.6);border:1px solid #3A2510;">
          ${panicNote}<span style="font-size:.7rem;color:#9A8462;margin-right:6px;">EGO消耗：</span>
          ${sinParts}${sanPart}
        </div>`;
      }
    }

    const content = `
      <div class="limbuscompany clash-dialog-v2">
        <div style="font-size:24px;font-weight:bold;color:#E8C9A2;margin-bottom:8px;">${item.name}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
          ${catIcon ? `<img src="${catIcon}" style="width:24px;height:24px;" alt="${catLabel}">` : ""}
          <span style="font-size:24px;color:#EBBD68;">${formula.toUpperCase()}</span>
        </div>
        ${egoCostHtml}
        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:.75rem;color:#9A8462;margin-bottom:4px;">加值修正</label>
          <input type="text" name="bonus" placeholder="±N 或 1d4+2"
                 style="width:100%;box-sizing:border-box;background:#1A1208;
                        color:#E8C9A2;font-size:.85rem;padding:6px 8px;border-radius:3px;outline:none;">
        </div>
      </div>`;
// border:1px solid #C9A84C;
    return new Promise(resolve => {
      new Dialog({
        title: "发起对抗",
        content,
        buttons: {
          clash: {
            label: "发起对抗",
            callback: async (dlg) => {
              const bonusStr = dlg.find("[name='bonus']").val()?.trim() || "";
              const bonus    = parseInt(bonusStr) || 0;
              const full     = bonus !== 0 ? `${formula}${bonus >= 0 ? "+" : ""}${bonus}` : formula;

              // ── EGO 前置检查：罪孽资源 + 理智（恐慌时罪孽×1.5、免理智）──
              if (isEgo) {
                const sinCost         = sys.sinCost ?? [];
                const sanityCost      = sys.sanityCost ?? 0;
                const effectiveSinCost = isInPanic
                  ? sinCost.map(e => ({ ...e, amount: Math.ceil(e.amount * 1.5) }))
                  : sinCost;
                const effectiveSanityCost = isInPanic ? 0 : sanityCost;
                if (!SinResourceHUD.canAffordSins(effectiveSinCost)) {
                  ui.notifications.warn("罪孽资源不足，无法使用此 EGO 技能！");
                  resolve(false);
                  return;
                }
                const sanCur = actor.system?.sanity?.value ?? 50;
                if (effectiveSanityCost > 0 && (sanCur - effectiveSanityCost) < 5) {
                  ui.notifications.warn(`理智不足（当前 ${sanCur}，需消耗 ${effectiveSanityCost}，最低保持 5）！`);
                  resolve(false);
                  return;
                }
                // 扣除罪孽资源
                await SinResourceHUD.consumeSins(effectiveSinCost);
                // 扣除理智（恐慌时跳过）
                if (effectiveSanityCost > 0) {
                  await actor.setSanity?.((sanCur - effectiveSanityCost));
                }
              }

              const roll = new Roll(full);
              await roll.evaluate();
              await ClashManager._sendInitiateMsg(actor, item, roll, full, slotIndex);

              // EGO 技能使用后，将 egoResistanceAdj 应用到角色的罪孽抗性
              if (isEgo) {
                await ClashManager._applyEgoResistanceChanges(actor, item);
              }

              // ── 技能使用后：获取对应罪孽资源 +1 ─────────────────────────
              const sinType = sys.sinType;
              if (sinType) {
                await SinResourceHUD.addSin(sinType, 1);
              }

              resolve(true);
            },
          },
          cancel: { label: "取消", callback: () => resolve(false) },
        },
        default: "clash",
        render: (dlg) => {
          dlg.closest(".dialog").find(".dialog-button.clash").css({
            background: "#5F3E22", color: "#E8C9A2", border: "none",
            "font-size": "1rem", "font-weight": "bold",
            padding: "8px 0", width: "100%", cursor: "pointer",
          });
        },
      }).render(true);
    });
  }

  /* ─── 阶段二：发起对抗聊天框 ──────────────────────────────────────────── */

  static async _sendInitiateMsg(actor, item, roll, formula, slotIndex) {
    const sys        = item.system ?? {};
    const effectDesc = ClashManager._effectDesc(item);

    const content = `
      <div class="limbus-clash-card" data-clash-type="initiate">
        ${ClashManager._chatHeader(actor, "发起对抗")}
        ${ClashManager._goldDivider()}
        ${ClashManager._skillRow(item)}
        <div class="clash-action-row" style="display:flex;gap:8px;margin-top:8px;margin-bottom:4px;">
          <button class="clash-btn-clash"
                  style="width:50px;height:30px;background:#5F3E22;color:#E8C9A2;
                         cursor:pointer;font-size:.85rem;border-radius:2px;">对抗</button>
          <button class="clash-btn-take"
                  style="width:50px;height:30px;background:#B84444;color:#fff;
                         border:none;cursor:pointer;font-size:.85rem;border-radius:2px;">承受</button>
        </div>
        ${ClashManager._goldDivider()}
        ${effectDesc ? `<div style="font-size:.8rem;line-height:1.5;">${effectDesc}</div>` : ""}
      </div>`;
// border:1px solid #C9A84C;
    const msg = await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor }),
      content,
      flags: {
        limbusCompany_FVTT: {
          type:        "clash-initiate",
          attackerId:  actor.id,
          itemId:      item.id,
          itemUuid:    item.uuid ?? "",
          rollTotal:   roll.total,
          rollData:    roll.toJSON(),
          formula,
          baseFormula: sys.diceFormula ?? "1d4",
          itemName:    item.name,
          itemImg:     item.img,
          category:    sys.category ?? "",
          sinType:     sys.sinType  ?? "",
          weight:      sys.weight   ?? 1,
          effectDesc,
          slotIndex,
        },
      },
    });

    // 流血：发起者执行攻击动作时触发
    await ClashManager._processBleed(actor);


    // 推进战斗槽 + 扣 AP
    // slotIndex >= 0：从战斗槽触发，推进 6-bag + 扣 AP（延迟动画后）
    // slotIndex === -2：从技能列表/右键触发，只扣 AP，不推进 bag
    if (slotIndex >= 0) {
      const sheet = actor.sheet;
      if (sheet?._combatBagState) {
        sheet._animateCombatSkillUse?.(slotIndex);
        setTimeout(async () => {
          const ap = actor.system.ap?.value ?? 0;
          if (ap > 0) await actor.update({ "system.ap.value": ap - 1 });
        }, 700);
      }
    } else if (slotIndex === -2) {
      const ap = actor.system.ap?.value ?? 0;
      if (ap > 0) await actor.update({ "system.ap.value": ap - 1 });
    }
  }

  /* ─── 阶段三：进行对抗技能选择弹窗（玩家B） ─────────────────────────── */

  static showRespondDialog(msgId, initFlags) {
    // 防守方：当前用户控制的角色
    const defActor =
      game.user.character ??
      canvas.tokens?.controlled?.[0]?.actor ??
      null;

    if (!defActor) {
      ui.notifications.warn("请先选中你的角色 Token 或在用户设置中指定角色");
      return;
    }

    // 发起方自己不能作为防守方响应自己的对抗
    if (defActor.id === initFlags.attackerId) {
      ui.notifications.warn("发起对抗的角色不能对自己的发起进行对抗");
      return;
    }

    // 恐慌时只能用 EGO 响应（不需要 AP）；普通情况 AP 不足则无法对抗
    const isInPanic = !!ClashManager._getBuff(defActor, "panic");
    if ((defActor.system.ap?.value ?? 0) <= 0 && !isInPanic) {
      ui.notifications.warn(`${defActor.name} 行动值不足，无法进行对抗`);
      return;
    }
    if (isInPanic) {
      const cfg    = CONFIG.LIMBUSCOMPANY ?? {};
      const hasEgo = (cfg.EGO_GRADES ?? []).some(grade => {
        const egoId = defActor.system.skills?.ego?.[grade];
        return egoId && defActor.items.get(egoId);
      });
      if (!hasEgo) {
        ui.notifications.warn(`【陷入恐慌】${defActor.name} 没有可用的 E.G.O 技能，只能承受伤害！`);
        return;
      }
    }

    ClashManager._buildPickerDialog(defActor, (chosenItem, slotIdx) => {
      ClashManager.showPerformDialog(defActor, chosenItem, msgId, initFlags, slotIdx);
    }, isInPanic);
  }

  static _buildPickerDialog(actor, onPick, panicMode = false) {
    const sheet    = actor.sheet;
    const bagState = sheet?._combatBagState;
    const sys      = actor.system;
    const basicIds = sys.skills?.basic ?? [];
    const cfg      = CONFIG.LIMBUSCOMPANY ?? {};

    // 顶部3格：激活1 / 激活2 / 守备
    const slot0Id   = bagState?.slots?.[0] ?? basicIds[0] ?? null;
    const slot1Id   = bagState?.slots?.[1] ?? basicIds[1] ?? null;
    const defenseId = sys.skills?.defense ?? null;

    const getItem = (id) => id ? actor.items.get(id) : null;

    const active0  = getItem(slot0Id);
    const active1  = getItem(slot1Id);
    const defItem  = getItem(defenseId);

    // 剩余基础技能格（bag槽 2-5，或直接取 equip 数组）
    const restIds = bagState
      ? bagState.slots.slice(2).filter(Boolean)
      : basicIds.slice(2).filter(Boolean);
    const restItems = restIds.map(id => getItem(id)).filter(Boolean);

    // EGO 技能
    const egoEntries = (cfg.EGO_GRADES ?? []).map(grade => ({
      grade,
      item: getItem(sys.skills?.ego?.[grade] ?? null),
    }));

    // ─── slot HTML 工厂 ───
    // slotIdx: 对应 bagState.slots 的下标（-1 = 守备/EGO，不属于 6-bag）
    const octaSlotHtml = (item, extraClass = "", slotIdx = -1, disabled = false) => {
      if (!item) {
        return `<div class="clash-pick-slot clash-pick-empty" style="width:52px;height:52px;"></div>`;
      }
      const sin = ClashManager._sinColor(item.system?.sinType);
      if (disabled) {
        return `
          <div class="clash-pick-slot clash-pick-disabled" data-item-id="${item.id}" data-slot-index="${slotIdx}"
               title="${item.name}（恐慌中无法使用）"
               style="position:relative;width:52px;height:52px;cursor:not-allowed;flex-shrink:0;
                      opacity:0.35;filter:grayscale(1);">
            <img src="${item.img}"
                 style="width:52px;height:52px;object-fit:cover;border:2px solid ${sin};"
                 alt="${item.name}">
          </div>`;
      }
      const hasRel = !!(item.system?.relatedSkill?.itemUuid);
      return `
        <div class="clash-pick-slot ${extraClass}" data-item-id="${item.id}" data-slot-index="${slotIdx}" title="${item.name}"
             style="position:relative;width:52px;height:52px;cursor:pointer;flex-shrink:0;">
          <img src="${item.img}"
               style="width:52px;height:52px;object-fit:cover;border:2px solid ${sin};"
               alt="${item.name}">
          ${hasRel ? `<button class="clash-pick-rel" data-base-id="${item.id}"
                               title="切换相关技能"
                               style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;
                                      border-radius:50%;border:1px solid #C9A84C;background:none;
                                      color:#9A8462;font-size:9px;cursor:pointer;padding:0;
                                      line-height:16px;text-align:center;">↺</button>` : ""}
        </div>`;
    };

    const circleSlotHtml = (item, grade = "") => {
      const sin = item ? ClashManager._sinColor(item.system?.sinType) : "#3A2A18";
      const opacity = item ? "1" : "0.3";
      return `
        <div style="display:flex;flex-direction:column;align-items:center;gap:3px;">
          ${item
            ? `<div class="clash-pick-slot" data-item-id="${item.id}" data-slot-index="-1" title="${item.name}"
                    style="width:52px;height:52px;border-radius:50%;overflow:hidden;
                           border:2px solid ${sin};cursor:pointer;flex-shrink:0;">
                 <img src="${item.img}" style="width:100%;height:100%;object-fit:cover;" alt="${item.name}">
               </div>`
            : `<div style="width:52px;height:52px;border-radius:50%;border:2px solid #3A2A18;opacity:.3;"></div>`
          }
          ${grade ? `<span style="font-size:9px;color:${item ? "#9A8462" : "#4A3A28"};">${grade}</span>` : ""}
        </div>`;
    };

    const panicNotice = panicMode
      ? `<div style="font-size:.75rem;color:#E8A444;text-align:center;padding:4px 0 6px;font-style:italic;">
           【陷入恐慌】只能使用 E.G.O 技能
         </div>`
      : "";

    const topRow = `
      ${panicNotice}
      <div style="display:flex;gap:16px;justify-content:center;padding:10px 0 28px;">
        ${octaSlotHtml(active0, "clash-pick-active", 0, panicMode)}
        ${octaSlotHtml(active1, "clash-pick-active", 1, panicMode)}
        ${octaSlotHtml(defItem, "", -1, panicMode)}
      </div>`;

    const expandedHtml = `
      <div class="clash-pick-expanded" style="display:none;">
        ${ClashManager._goldDivider()}
        <div style="display:flex;flex-wrap:wrap;gap:16px;justify-content:center;padding:8px 0 16px;">
          ${restItems.map((it, j) => octaSlotHtml(it, "", 2 + j, panicMode)).join("")}
        </div>
        ${egoEntries.some(e => e.item) ? `
          <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;padding:4px 0 8px;">
            ${egoEntries.map(e => circleSlotHtml(e.item, e.grade)).join("")}
          </div>` : ""}
      </div>`;

    const content = `
      <div class="limbuscompany clash-pick-dialog" style="min-width:260px;">
        ${topRow}
        <div style="text-align:center;margin-bottom:6px;">
          <button class="clash-pick-expand-btn"
                  style="background:none;border:none;color:#C9A84C;font-size:1.3rem;cursor:pointer;">▼</button>
        </div>
        ${expandedHtml}
      </div>`;

    const dlg = new Dialog({
      title: "拼点对抗",
      content,
      buttons: {},
      render: (dlgHtml) => {
        // 展开/折叠
        dlgHtml.find(".clash-pick-expand-btn").on("click", (e) => {
          const $exp = dlgHtml.find(".clash-pick-expanded");
          const open = $exp.is(":visible");
          $exp.toggle(!open);
          $(e.currentTarget).text(open ? "▼" : "▲");
        });

        // 恐慌时禁用槽点击提示
        dlgHtml.on("click", ".clash-pick-disabled", () => {
          ui.notifications.warn("【陷入恐慌】无法使用基础或守备技能！");
        });

        // 选中技能（携带 slotIdx 供后续推进战斗袋）
        dlgHtml.on("click", ".clash-pick-slot:not(.clash-pick-empty):not(.clash-pick-disabled)", (e) => {
          if ($(e.target).hasClass("clash-pick-rel")) return; // 不触发 related toggle
          const itemId  = e.currentTarget.dataset.itemId;
          const slotIdx = parseInt(e.currentTarget.dataset.slotIndex ?? "-1");
          const item    = actor.items.get(itemId);
          if (!item) return;
          dlg.close();
          onPick(item, slotIdx);
        });

        // 切换相关技能
        dlgHtml.on("click", ".clash-pick-rel", (e) => {
          e.stopPropagation();
          const $btn   = $(e.currentTarget);
          const baseId = $btn.data("base-id");
          const base   = actor.items.get(baseId);
          if (!base) return;
          const relUuid = base.system?.relatedSkill?.itemUuid;
          if (!relUuid) return;

          $btn.toggleClass("rel-active");
          const $slot = $btn.closest(".clash-pick-slot");

          if ($btn.hasClass("rel-active")) {
            const relItem = typeof fromUuidSync !== "undefined" ? fromUuidSync(relUuid) : null;
            if (relItem) {
              $slot.data("item-id", relItem.id).attr("data-item-id", relItem.id);
              $slot.find("img").attr("src", relItem.img);
              $btn.css("color", "#6EE06E").css("border-color", "#6EE06E");
            }
          } else {
            $slot.data("item-id", baseId).attr("data-item-id", baseId);
            $slot.find("img").attr("src", base.img);
            $btn.css("color", "#9A8462").css("border-color", "#C9A84C");
          }
        });
      },
    }, { width: 320 });

    dlg.render(true);
  }

  /* ─── 阶段四：进行对抗弹窗（与发起对抗一致，标题/按钮不同） ─────────── */

  static async showPerformDialog(defActor, defItem, initMsgId, initFlags, slotIdx = -1) {
    const sys       = defItem.system ?? {};
    const formula   = sys.diceFormula ?? "1d4";
    const catIcon   = ClashManager._catIcon(sys.category);
    const catLabel  = ClashManager._catLabel(sys.category);
    const isEgo     = sys.type === "ego";
    const isInPanic = isEgo && !!ClashManager._getBuff(defActor, "panic");

    const content = `
      <div class="limbuscompany clash-dialog-v2">
        <div style="font-size:24px;font-weight:bold;color:#E8C9A2;margin-bottom:8px;">${defItem.name}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
          ${catIcon ? `<img src="${catIcon}" style="width:24px;height:24px;" alt="${catLabel}">` : ""}
          <span style="font-size:24px;color:#EBBD68;">${formula.toUpperCase()}</span>
        </div>
        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:.75rem;color:#9A8462;margin-bottom:4px;">加值修正</label>
          <input type="text" name="bonus" placeholder="±N 或 1d4+2"
                 style="width:100%;box-sizing:border-box;background:#1A1208;
                        color:#E8C9A2;font-size:.85rem;padding:6px 8px;border-radius:3px;outline:none;">
        </div>
      </div>`;
// border:1px solid #C9A84C;
    return new Promise(resolve => {
      new Dialog({
        title: "进行对抗",
        content,
        buttons: {
          perform: {
            label: "进行对抗",
            callback: async (dlg) => {
              // ── 防守方使用 EGO 时的前置检查（含恐慌调整）────────────────
              if (isEgo) {
                const sinCost          = sys.sinCost ?? [];
                const sanityCost       = sys.sanityCost ?? 0;
                const effectiveSinCost = isInPanic
                  ? sinCost.map(e => ({ ...e, amount: Math.ceil(e.amount * 1.5) }))
                  : sinCost;
                const effectiveSanityCost = isInPanic ? 0 : sanityCost;
                if (!SinResourceHUD.canAffordSins(effectiveSinCost)) {
                  ui.notifications.warn("罪孽资源不足，无法使用此 EGO 技能！");
                  resolve(false);
                  return;
                }
                const sanCur = defActor.system?.sanity?.value ?? 50;
                if (effectiveSanityCost > 0 && (sanCur - effectiveSanityCost) < 5) {
                  ui.notifications.warn(`理智不足（当前 ${sanCur}，需消耗 ${effectiveSanityCost}，最低保持 5）！`);
                  resolve(false);
                  return;
                }
                await SinResourceHUD.consumeSins(effectiveSinCost);
                if (effectiveSanityCost > 0) {
                  await defActor.setSanity?.((sanCur - effectiveSanityCost));
                }
              }

              const bonusStr = dlg.find("[name='bonus']").val()?.trim() || "";
              const bonus    = parseInt(bonusStr) || 0;
              const full     = bonus !== 0 ? `${formula}${bonus >= 0 ? "+" : ""}${bonus}` : formula;
              const roll     = new Roll(full);
              await roll.evaluate();
              // DiceSoNice: A 先骰 → B 再骰，顺序播放动画
              if (game.dice3d && initFlags.rollData) {
                const atkRoll = Roll.fromJSON(JSON.stringify(initFlags.rollData));
                await game.dice3d.showForRoll(atkRoll, game.user, true, null, false);
                await game.dice3d.showForRoll(roll,    game.user, true, null, false);
              }
              await ClashManager._sendResponseAndResolve(
                defActor, defItem, roll, full, initMsgId, initFlags, slotIdx
              );
              // 进行对抗确认后：+1 对应 sinType 罪孽
              const sinType = sys.sinType;
              if (sinType) await SinResourceHUD.addSin(sinType, 1);
              resolve(true);
            },
          },
          cancel: { label: "取消", callback: () => resolve(false) },
        },
        default: "perform",
        render: (dlg) => {
          dlg.closest(".dialog").find(".dialog-button.perform").css({
            background: "#5F3E22", color: "#E8C9A2", border: "none",
            "font-size": "1rem", "font-weight": "bold",
            padding: "8px 0", width: "100%", cursor: "pointer",
          });
        },
      }).render(true);
    });
  }

  /* ─── 阶段五：进行对抗聊天框 + 自动拼点结算 ─────────────────────────── */

  static async _sendResponseAndResolve(defActor, defItem, defRoll, defFormula, initMsgId, initFlags, slotIdx = -1) {
    // 非 GM 玩家无权直接更新 GM 控制的 Actor（攻击方），委托 GM 执行整个结算流程
    if (!game.user.isGM) {
      console.log("[ClashManager] 非GM玩家，通过 ChatMessage 委托 GM 执行对抗结算 | defActor:", defActor.id, "| defItem:", defItem.id);
      const payload = JSON.parse(JSON.stringify({
        defActorId:   defActor.id,
        defItemId:    defItem.id,
        defRollTotal: defRoll.total,
        defFormula,
        initMsgId,
        initFlags,
        slotIdx,
      }));
      // 创建仅 GM 可见的空白触发消息，GM 端的 createChatMessage hook 捕获并处理
      await ChatMessage.create({
        content: "",
        whisper: game.users.filter(u => u.active && u.isGM).map(u => u.id),
        flags: { limbusCompany_FVTT: { type: "clashResolveTrigger", ...payload } },
      });
      return;
    }

    const sys        = defItem.system ?? {};
    const effectDesc = ClashManager._effectDesc(defItem);

    // 进行对抗聊天框（对抗按钮置灰，无承受按钮）
    const responseContent = `
      <div class="limbus-clash-card" data-clash-type="response">
        ${ClashManager._chatHeader(defActor, "进行对抗")}
        ${ClashManager._goldDivider()}
        ${ClashManager._skillRow(defItem)}
        <div style="display:flex;gap:8px;margin-top:8px;margin-bottom:4px;">
          <button disabled style="width:50px;height:30px;background:#3A3028;color:#6A5A48;
                                  border:1px solid #4A3820;font-size:.85rem;cursor:not-allowed;
                                  border-radius:2px;">对抗</button>
        </div>
        ${ClashManager._goldDivider()}
        ${effectDesc ? `<div style="font-size:.8rem;line-height:1.5;">${effectDesc}</div>` : ""}
      </div>`;

    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: defActor }),
      content: responseContent,
      flags: {
        limbusCompany_FVTT: {
          type:       "clash-response",
          defenderId: defActor.id,
          itemId:     defItem.id,
          rollTotal:  defRoll.total,
          formula:    defFormula,
          itemName:   defItem.name,
          itemImg:    defItem.img,
          category:   sys.category ?? "",
          sinType:    sys.sinType  ?? "",
        },
      },
    });

    // 流血：防守方进行对抗也是攻击动作，同样触发
    await ClashManager._processBleed(defActor);

    // 拼点结算所需的攻击方角色（提前获取，供 [使用时] 触发使用）
    const atkActor = game.actors.get(initFlags.attackerId);


    // 扣防守方 AP（恐慌时使用 EGO 免 AP 消耗）
    const defIsEgo     = (defItem.system?.type === "ego");
    const defIsInPanic = defIsEgo && !!ClashManager._getBuff(defActor, "panic");
    if (!defIsInPanic) {
      const defAp = defActor.system.ap?.value ?? 0;
      if (defAp > 0) await defActor.update({ "system.ap.value": defAp - 1 });
    }

    // 推进防守方战斗袋（技能消失，后面的技能填充）
    if (slotIdx >= 0) {
      const sheet = defActor.sheet;
      if (sheet?._combatBagState) sheet._animateCombatSkillUse?.(slotIdx);
    }

    // 拼点结算
    const defCategory = sys.category ?? "";

    // 攻击方技能物品（用于 activity 触发）
    // 若技能由反应的 UUID 触发（非角色自有物品），需通过 fromUuid 回退查找
    const atkItem = atkActor?.items?.get(initFlags.itemId)
      ?? (initFlags.itemUuid ? await fromUuid(initFlags.itemUuid).catch(() => null) : null)
      ?? null;
    // 共享的 perTurn 计数器（攻守双方共用，本次对抗内全程共享）
    // _actMsgs：汇总本次对抗所有 activity 消息，结束时统一发一条，避免并发 create 导致 Foundry 清理竞态
    const _fc      = {};
    const _actMsgs = [];
    const atkCtx = { atkActor, defActor, owner: atkActor, other: defActor, _fireCounts: _fc, _actMsgs, _currentItemId: atkItem?.id ?? "" };
    const defCtx = { atkActor, defActor, owner: defActor, other: atkActor, _fireCounts: _fc, _actMsgs, _currentItemId: defItem?.id ?? "" };

    // 在任何 activity 触发前，记录攻守双方当前骰子公式（用于之后检测公式变化后重投）
    const atkBaseFormulaOrig = initFlags.baseFormula ?? initFlags.formula;
    const defBaseFormulaOrig = defItem?.system?.diceFormula ?? defFormula;

    // ── [攻击前]：玩家B点击【对抗】后，拼点/结算前触发 ──────────────────
    await ClashManager._applyActivitiesAndEquip(atkItem, "攻击前", atkCtx);
    await ClashManager._applyActivitiesAndEquip(defItem, "攻击前", defCtx);

    // ── [攻击时] / [拼点时]：无论对抗类型，攻击时效果均应在此触发 ───────
    await ClashManager._applyActivitiesAndEquip(atkItem, "攻击时", atkCtx);
    await ClashManager._applyActivitiesAndEquip(atkItem, "拼点时", atkCtx);
    await ClashManager._applyActivitiesAndEquip(defItem,  "攻击时", defCtx);
    await ClashManager._applyActivitiesAndEquip(defItem,  "拼点时", defCtx);

    // ── [攻击时/拼点时] 可能修改骰子公式（diceAdj/diceFacesAdj/baseValue）──
    // 若公式与发起时不同，重新投骰，保留手动加值部分
    let atkFinalTotal   = initFlags.rollTotal;
    let atkFinalFormula = initFlags.formula;
    const newAtkBase = atkItem?.system?.diceFormula ?? atkBaseFormulaOrig;
    if (newAtkBase !== atkBaseFormulaOrig) {
      const bonusPart  = initFlags.formula.slice(atkBaseFormulaOrig.length); // 手动加值部分，如 "+3" 或 ""
      const newAtkFull = newAtkBase + bonusPart;
      const rerollAtk  = new Roll(newAtkFull);
      await rerollAtk.evaluate();
      atkFinalTotal   = rerollAtk.total;
      atkFinalFormula = newAtkFull;
      _actMsgs.push({ trigger: "公式重投", itemName: atkItem?.name ?? "攻击方", msgs: [`公式变化（${atkBaseFormulaOrig} → ${newAtkBase}），重新投骰：${rerollAtk.result} = <b>${rerollAtk.total}</b>`] });
    }

    let defFinalTotal   = defRoll.total;
    let defFinalFormula = defFormula;
    const newDefBase = defItem?.system?.diceFormula ?? defBaseFormulaOrig;
    if (newDefBase !== defBaseFormulaOrig) {
      const defBonusPart = defFormula.slice(defBaseFormulaOrig.length); // 手动加值部分
      const newDefFull   = newDefBase + defBonusPart;
      const rerollDef    = new Roll(newDefFull);
      await rerollDef.evaluate();
      defFinalTotal   = rerollDef.total;
      defFinalFormula = newDefFull;
      _actMsgs.push({ trigger: "公式重投", itemName: defItem?.name ?? "防守方", msgs: [`公式变化（${defBaseFormulaOrig} → ${newDefBase}），重新投骰：${rerollDef.result} = <b>${rerollDef.total}</b>`] });
    }

    // 汇总 [攻击时/拼点时] 后所有可能被修改的攻击方字段，统一覆盖 initFlags
    // 目前覆盖字段：rollTotal / formula（骰子公式变化重投）、weight（weightAdj 修改加重值）
    const atkWeightCur = atkItem?.system?.weight ?? initFlags.weight;
    const effectiveInitFlags = (
      atkFinalTotal   !== initFlags.rollTotal ||
      atkFinalFormula !== initFlags.formula   ||
      atkWeightCur    !== initFlags.weight
    ) ? { ...initFlags, rollTotal: atkFinalTotal, formula: atkFinalFormula, weight: atkWeightCur }
      : initFlags;

    // 构造最终防守骰对象（含公式重投后的 total）
    const defFinalRoll = defFinalTotal !== defRoll.total
      ? { ...defRoll, total: defFinalTotal }
      : defRoll;

    // 反击/防御：不走拼点流程，直接结算
    if (defCategory === "counter") {
      await ClashManager._resolveDirectCounter(atkActor, defActor, effectiveInitFlags, defItem, defFinalRoll, defFinalFormula);
      // 反击：守方拼点胜/主动命中攻方，攻方拼点败/被命中
      await ClashManager._applyActivitiesAndEquip(defItem,  "拼点成功", defCtx);
      await ClashManager._applyActivitiesAndEquip(atkItem,  "拼点失败", atkCtx);
      // 双方互相命中（攻方命中守方 + 守方反击命中攻方）
      await ClashManager._applyActivitiesAndEquip(atkItem,  "命中时", atkCtx);
      await ClashManager._applyActivitiesAndEquip(defItem,  "命中时", defCtx);
      await ClashManager._applyActivitiesAndEquip(atkItem,  "攻击后", atkCtx);
      await ClashManager._applyActivitiesAndEquip(defItem,  "攻击后", defCtx);
      await ClashManager._flushActMsgs(_actMsgs, atkActor);
      await ClashManager._broadcastAndCheckReactions({ lastSkillUuid: atkItem?.uuid ?? null, attacker: atkActor, defender: defActor });
      return;
    }
    if (defCategory === "block") {
      await ClashManager._resolveDirectBlock(atkActor, defActor, effectiveInitFlags, defItem, defFinalRoll, defFinalFormula);
      // 格挡：攻方命中守方（守方未命中攻方）
      await ClashManager._applyActivitiesAndEquip(atkItem,  "命中时", atkCtx);
      await ClashManager._applyActivitiesAndEquip(atkItem,  "攻击后", atkCtx);
      await ClashManager._applyActivitiesAndEquip(defItem,  "攻击后", defCtx);
      await ClashManager._flushActMsgs(_actMsgs, atkActor);
      await ClashManager._broadcastAndCheckReactions({ lastSkillUuid: atkItem?.uuid ?? null, attacker: atkActor, defender: defActor });
      return;
    }

    const resolution = ClashManager._computeResolution({
      atkActor,    atkTotal:    atkFinalTotal,   atkFormula:  atkFinalFormula,
      atkItemName: initFlags.itemName, atkItemImg: initFlags.itemImg,
      atkCategory: initFlags.category ?? "",           atkSinType:  initFlags.sinType ?? "",
      defActor,    defTotal:    defFinalTotal,          defFormula:  defFinalFormula,
      defItemName: defItem.name,       defItemImg: defItem.img,
      defCategory,                                     defSinType:  sys.sinType ?? "",
    });

    // 呼吸暴击触发：层数-1
    if (resolution.breatheCrit && resolution.winner) {
      await ClashManager._reduceBuffStacks(resolution.winner, "breathing");
    }

    // 闪避成功：恢复防守方 1 AP（不扣 AP，恢复之前已扣的那 1 点）
    if (resolution.dodgeWin) {
      const curAp = defActor.system.ap?.value ?? 0;
      const maxAp = defActor.system.ap?.max ?? 3;
      await defActor.update({ "system.ap.value": Math.min(curAp + 1, maxAp) });
    }

    // ── [拼点成功/失败] / [命中时] / [暴击命中时] / [受到伤害时] ────────
    const { atkWins, isTie, dodgeWin, breatheCrit } = resolution;
    // 【不可摧毁】反击暂存，稍后在 _sendResolveMsg 后触发
    let _unbreakableCounterArgs = null;
    if (!isTie) {
      if (atkWins) {
        // 攻击方拼点胜
        await ClashManager._applyActivitiesAndEquip(atkItem, "拼点成功", atkCtx);
        await ClashManager._applyActivitiesAndEquip(defItem,  "拼点失败", defCtx);
        // 【不可摧毁】：防守方拼点失败后自动反击攻击方（延迟到 _sendResolveMsg 后）
        if (defItem?.system?.diceType === "unbreakable") {
          _unbreakableCounterArgs = [defItem, defActor, atkActor, defCtx];
        }
        // 命中（攻击方对防守方造成伤害）
        if (!dodgeWin) {
          await ClashManager._applyActivitiesAndEquip(atkItem, "命中时", atkCtx);
          if (breatheCrit) {
            await ClashManager._applyActivitiesAndEquip(atkItem, "暴击命中时", atkCtx);
          }
          // 防守方受到伤害（技能 + 装备格物品）
          await ClashManager._applyActivities(defItem, "受到伤害时", defCtx);
          for (const eq of ClashManager._getEquippedItems(defActor)) {
            await ClashManager._applyActivities(eq, "受到伤害时", defCtx);
          }
        }
      } else {
        // 防守方拼点胜（攻击方落败）
        await ClashManager._applyActivitiesAndEquip(atkItem, "拼点失败", atkCtx);
        await ClashManager._applyActivitiesAndEquip(defItem,  "拼点成功", defCtx);
        // 【不可摧毁】：攻击方拼点失败后自动反击防守方（延迟到 _sendResolveMsg 后）
        if (atkItem?.system?.diceType === "unbreakable") {
          _unbreakableCounterArgs = [atkItem, atkActor, defActor, atkCtx];
        }
        // 防守方命中攻击方（闪避胜利不造成伤害，其余胜利均命中）
        if (!dodgeWin) {
          await ClashManager._applyActivitiesAndEquip(defItem, "命中时", defCtx);
          // 攻击方受到伤害（技能 + 装备格物品）
          await ClashManager._applyActivities(atkItem, "受到伤害时", atkCtx);
          for (const eq of ClashManager._getEquippedItems(atkActor)) {
            await ClashManager._applyActivities(eq, "受到伤害时", atkCtx);
          }
        }
      }

      // ── 自定义 BUFF onClashWin 钩子 ────────────────────────────────────
      // 胜者的所有 BUFF 中，若有注册 onClashWin 的自定义 BUFF，则对败者触发
      const winner = atkWins ? atkActor : defActor;
      const loser  = atkWins ? defActor : atkActor;
      if (winner && loser) {
        for (const buff of (winner.system?.buffs ?? [])) {
          const handler = resolveBuffHandler(buff);
          if (typeof handler?.onClashWin === "function") {
            await handler.onClashWin(winner, loser);
          }
        }
      }
    }

    // ── 拼点理智变化（非平局、非闪避胜利时结算）──────────────────────────
    const sanityNotes = [];
    if (!isTie && !dodgeWin) {
      const { gainNote, lossNote } = await ClashManager._applySanityFromClash(
        resolution.winner, resolution.loser
      );
      if (gainNote) sanityNotes.push(gainNote);
      if (lossNote) sanityNotes.push(lossNote);
    }

    await ClashManager._sendResolveMsg(resolution, effectiveInitFlags, defActor, defItem, defFormula, sanityNotes);

    // 【不可摧毁】反击消息在拼点对抗结果之后发出
    if (_unbreakableCounterArgs) {
      await ClashManager._triggerUnbreakableCounter(..._unbreakableCounterArgs);
    }

    // ── [攻击后]：结算完对抗结果后触发 ────────────────────────────────
    await ClashManager._applyActivitiesAndEquip(atkItem, "攻击后", atkCtx);
    await ClashManager._applyActivitiesAndEquip(defItem,  "攻击后", defCtx);

    // 统一发出本次对抗所有 activity 通知（汇总为一条，避免并发清理竞态）
    await ClashManager._flushActMsgs(_actMsgs, atkActor);
    await ClashManager._broadcastAndCheckReactions({ lastSkillUuid: atkItem?.uuid ?? null, attacker: atkActor, defender: defActor });
  }

  /* ─── 阶段五b：拼点结算逻辑 ────────────────────────────────────────────── */

  static _computeResolution({ atkActor, atkTotal, atkFormula, atkItemName, atkItemImg, atkCategory, atkSinType,
                               defActor, defTotal, defFormula, defItemName, defItemImg, defCategory, defSinType }) {

    // ── 技能分类分组 ──────────────────────────────────────────────────────
    // 守备技能（全部）→ 使用忍耐/破绽调整骰数
    const ALL_DEF_CATS   = new Set(["dodge","block","counter","clashBlock","clashCounter"]);
    // 使用防御等级（而非攻击等级）进行等级差比较的守备技能（不含反击系列）
    const DEF_LEVEL_CATS = new Set(["dodge","block","clashBlock"]);
    const PHYS_CATS      = new Set(["slash","blunt","pierce"]);
    const SIN_TYPES      = new Set(["wrath","lust","sloth","gluttony","gloom","pride","envy"]);

    // ── BUFF 辅助 ─────────────────────────────────────────────────────────
    // 骰数/等级类 BUFF 均使用 stacks（层数）；守护/易损使用 intensity（强度）
    const gs = (actor, type) => ClashManager._getBuffVal(actor, type).stacks;
    const gi = (actor, type) => ClashManager._getBuffVal(actor, type).intensity;

    // ── 各方等级（攻击方始终用 atkLv；防守方：DEF型技能用 defLv，其余用 atkLv）
    const atkSideLv = ClashManager._effAtkLv(atkActor);
    const defSideLv = DEF_LEVEL_CATS.has(defCategory)
      ? ClashManager._effDefLv(defActor) : ClashManager._effAtkLv(defActor);

    // 等级差加值（仅等级高的一方获得，差值每3级 +1 有效骰数）
    const atkLvBonus = Math.floor(Math.max(0, atkSideLv - defSideLv) / 3);
    const defLvBonus = Math.floor(Math.max(0, defSideLv - atkSideLv) / 3);

    // ── 各方有效骰数（骰子结果 + BUFF 修正 + 等级差加值）────────────────
    // 攻击方（基础/EGO 技能）：强壮/虚弱 + 拼点威力提升/降低 + 等级差
    const atkDiceMod = gs(atkActor, "strong")       - gs(atkActor, "weak")
                     + gs(atkActor, "clashPowerUp")  - gs(atkActor, "clashPowerDown");

    // 防守方：守备技能 → 忍耐/破绽；基础/EGO → 强壮/虚弱；两者都再加拼点威力 + 等级差
    const defIsDefCat = ALL_DEF_CATS.has(defCategory);
    const defDiceMod  = defIsDefCat
      ? (gs(defActor, "endure")  - gs(defActor, "breach"))
      : (gs(defActor, "strong")  - gs(defActor, "weak"));
    const defPwrMod   = gs(defActor, "clashPowerUp") - gs(defActor, "clashPowerDown");

    const atkEffective = atkTotal + atkDiceMod + atkLvBonus;
    const defEffective = defTotal + defDiceMod + defPwrMod + defLvBonus;

    // ── 胜负判定（基于含等级差的有效骰数）───────────────────────────────
    const isTie    = atkEffective === defEffective;
    const atkWins  = atkEffective >= defEffective; // 平局暂时归攻击方，由 isTie 旗标覆盖显示
    const winner   = atkWins ? atkActor : defActor;
    const loser    = atkWins ? defActor : atkActor;
    const winScore = atkWins ? atkEffective : defEffective;
    const winCat   = atkWins ? atkCategory  : defCategory;
    const winSin   = atkWins ? atkSinType   : defSinType;

    // ── 呼吸（breathing）：命中方判定暴击（在抗性计算之前） ──────────────
    // 暴击判定先于抗性，critMult 作为额外倍率参与 winScore 计算，
    // 触发时层数-1 由调用方执行
    // 平局时不触发暴击
    const breatheBuff = isTie ? null : ClashManager._getBuff(winner, "breathing");
    let   breatheCrit = false;
    let   critMult    = 1.0;
    if (breatheBuff && breatheBuff.stacks > 0) {
      const critChance = (breatheBuff.intensity ?? 1) * 0.05;
      breatheCrit = Math.random() < critChance;
      if (breatheCrit) critMult = 1.5;
    }

    // ── 物理抗性（含上装 resistanceAdj 覆盖）────────────────────────────
    const effRes     = loser ? ClashManager._getEffectiveResistances(loser) : {};
    const physResStr = PHYS_CATS.has(winCat) ? (effRes[winCat] ?? "x1.0") : "x1.0";
    const physMult   = ClashManager._parseResistance(physResStr);

    // ── 罪孽抗性 ─────────────────────────────────────────────────────────
    const sinResStr = (loser && SIN_TYPES.has(winSin))
      ? (loser.system?.egoResistances?.[winSin] ?? "x1.0")
      : "x1.0";
    const sinMult   = ClashManager._parseResistance(sinResStr);

    // ── 守护/易损（使用 stacks 层数，在抗性前加减骰数，之后再乘以抗性倍率）──
    const guard   = gs(loser, "guard");
    const fragile = gs(loser, "fragile");

    // ── 最终伤害 ──────────────────────────────────────────────────────────
    // 计算顺序：winScore → critMult → +易损-守护 → ×physMult × sinMult
    // 易损/守护先修正骰数，再由抗性倍率整体放大/缩小
    const totalMult    = critMult * physMult * sinMult;
    const adjustedBase = Math.max(0, Math.round(winScore * critMult) + fragile - guard);

    // 闪避：拼点成功 → 无伤害；平局 → 无伤害（再次骰掷）
    const dodgeWin  = defCategory === "dodge" && !atkWins && !isTie;

    let finalDamage;
    if (isTie) {
      finalDamage = 0;
    } else if (dodgeWin) {
      finalDamage = 0;
    } else if (defCategory === "clashBlock") {
      if (!atkWins) {
        // 强化防御拼点成功：完全格挡，无伤害
        finalDamage = 0;
      } else {
        // 强化防御拼点失败：伤害减去格挡骰数
        finalDamage = Math.max(0, Math.round(adjustedBase * physMult * sinMult) - defEffective);
      }
    } else {
      finalDamage = Math.max(0, Math.round(adjustedBase * physMult * sinMult));
    }

    // ── 结算说明 ──────────────────────────────────────────────────────────
    const loserName = loser?.name ?? "?";
    const notes     = [];

    notes.push(`本次对抗：${atkActor?.name ?? "?"} vs ${defActor?.name ?? "?"}`);
    notes.push(`结算结果：`);

    // 攻击方骰数（有 BUFF 或等级差时展示修正过程）
    const atkModParts = [];
    if (atkDiceMod !== 0) atkModParts.push(`BUFF(${atkDiceMod >= 0 ? "+" : ""}${atkDiceMod})`);
    if (atkLvBonus  > 0)  atkModParts.push(`等级差(+${atkLvBonus})`);
    const atkBuffStr = atkModParts.length > 0
      ? `+${atkModParts.join("+")}=${atkEffective}` : "";
    notes.push(`　${atkActor?.name ?? "?"}：${atkFormula.toUpperCase()}=${atkTotal} ${atkBuffStr}`.trim());

    // 防守方骰数
    const defModParts = [];
    if ((defDiceMod + defPwrMod) !== 0) defModParts.push(`BUFF(${(defDiceMod + defPwrMod) >= 0 ? "+" : ""}${defDiceMod + defPwrMod})`);
    if (defLvBonus > 0) defModParts.push(`等级差(+${defLvBonus})`);
    const defBuffStr = defModParts.length > 0
      ? `+${defModParts.join("+")}=${defEffective}` : "";
    notes.push(`　${defActor?.name ?? "?"}：${defFormula.toUpperCase()}=${defTotal} ${defBuffStr}`.trim());

    // 等级差说明
    if (atkLvBonus > 0) notes.push(`（攻击方等级 ${atkSideLv} vs 防守方等级 ${defSideLv}，等级差 ${atkSideLv - defSideLv}，拼点+${atkLvBonus}）`);
    if (defLvBonus > 0) notes.push(`（防守方等级 ${defSideLv} vs 攻击方等级 ${atkSideLv}，等级差 ${defSideLv - atkSideLv}，拼点+${defLvBonus}）`);

    if (isTie) {
      notes.push(`平局！（${atkEffective} = ${defEffective}）需要再次骰掷`);
    } else {
      notes.push(`${winner?.name ?? "?"} 获胜，${loserName} 败北`);

      // 呼吸暴击注释（在易损/守护和抗性之前）
      const critBase = Math.round(winScore * critMult);
      if (breatheCrit) notes.push(`【呼吸】触发暴击！×1.5 → ${critBase}`);

      // 易损/守护注释（在抗性之前）
      const showEffects = !dodgeWin && !(defCategory === "clashBlock" && !atkWins);
      if (showEffects && fragile > 0) notes.push(`【易损】+${fragile} 层：${critBase} → ${critBase + fragile}（抗性前）`);
      if (showEffects && guard   > 0) notes.push(`【守护】-${guard} 层：${critBase + fragile} → ${adjustedBase}（抗性前）`);

      // 守备技能特殊说明 + 抗性说明
      const resParts = [];
      if (physMult !== 1.0) resParts.push(`${ClashManager._catLabel(winCat)}${physMult > 1 ? "弱性" : "抗性"}×${physMult}`);
      if (sinMult  !== 1.0) resParts.push(`${ClashManager._sinLabel(winSin)} 抗性×${sinMult}`);

      if (dodgeWin) {
        notes.push(`${defActor?.name ?? "?"} 闪避成功！攻击无效`);
      } else if (defCategory === "clashBlock" && !atkWins) {
        notes.push(`${defActor?.name ?? "?"} 格挡成功！攻击完全抵消`);
      } else if (defCategory === "clashBlock" && atkWins) {
        const baseNote = resParts.length > 0
          ? `基础 ${adjustedBase} 由于 ${resParts.join(" + ")} 受到伤害` : `受到伤害`;
        notes.push(`${loserName} ${baseNote}，格挡减免 ${defEffective}，最终 ${finalDamage} 点`);
      } else {
        notes.push(resParts.length > 0
          ? `${loserName} 由于 ${resParts.join(" + ")} 受到 ${finalDamage} 点伤害`
          : `${loserName} 受到 ${finalDamage} 点伤害`);
      }
    }

    return {
      atkWins, isTie, winner, loser,
      atkTotal: atkEffective, defTotal: defEffective, winScore,
      atkItemName, atkItemImg, atkFormula, atkActor,
      defItemName, defItemImg, defFormula, defActor,
      finalDamage, notes, breatheCrit, dodgeWin, defCategory,
    };
  }

  /* ─── 阶段五c：拼点结算聊天框 ──────────────────────────────────────────── */

  static async _sendResolveMsg(res, initFlags, defActor, defItem, defFormula, sanityNotes = []) {
    const {
      atkWins, isTie, atkTotal, defTotal,
      atkItemName, atkItemImg, atkFormula, atkActor,
      defItemName, defItemImg,
      loser, finalDamage, notes, dodgeWin, defCategory: resDC,
    } = res;

    const defCat = resDC ?? defItem?.system?.category ?? "";
    const isClashCounterWin = !atkWins && !isTie && defCat === "clashCounter";
    const isClashBlockWin   = !atkWins && !isTie && defCat === "clashBlock";
    const isDodgeWin        = !!dodgeWin;
    const noTake            = isDodgeWin || isClashBlockWin;

    const resolveTitle = isTie             ? "平局"
                       : isClashCounterWin ? "⚔️ 强化反击"
                       : isDodgeWin        ? "闪避成功"
                       : isClashBlockWin   ? "格挡成功"
                       : "拼点对抗";

    const atkTotalStyle = isTie
      ? "font-size:2rem;font-weight:bold;color:#C9A84C;"
      : atkWins
        ? "font-size:2rem;font-weight:bold;color:#E8C9A2;"
        : "font-size:2rem;font-weight:bold;color:#B84444;";
    const defTotalStyle = isTie
      ? "font-size:2rem;font-weight:bold;color:#C9A84C;"
      : !atkWins
        ? "font-size:2rem;font-weight:bold;color:#E8C9A2;"
        : "font-size:2rem;font-weight:bold;color:#B84444;";
    const cmp = isTie ? "=" : (atkTotal > defTotal ? ">" : "<");

    // 再次骰掷所需数据（存入 flags 供按钮回调使用）
    const rerollData = isTie ? {
      atkActorId:  atkActor?.id  ?? "",
      atkFormula:  atkFormula    ?? "",
      atkItemName, atkItemImg,
      atkCategory: initFlags.category ?? "",
      atkSinType:  initFlags.sinType  ?? "",
      atkWeight:   initFlags.weight   ?? 1,
      atkRollBase: initFlags.rollTotal ?? 0,
      atkItemId:   initFlags.itemId   ?? "",
      atkItemUuid: initFlags.itemUuid ?? "",
      defActorId:  defActor?.id  ?? "",
      defFormula:  defFormula    ?? "",
      defItemName, defItemImg,
      defCategory: defCat,
      defSinType:  defItem?.system?.sinType ?? "",
      defItemId:   defItem?.id ?? "",
    } : null;

    // 加重扩散信息：仅攻击方胜且非平局才携带
    const weightSpread = atkWins && !isTie ? {
      attackerId: atkActor?.id      ?? "",
      rollTotal:  initFlags.rollTotal ?? 0,
      category:   initFlags.category  ?? "",
      sinType:    initFlags.sinType   ?? "",
      weight:     initFlags.weight    ?? 1,
      itemId:     initFlags.itemId    ?? "",
      itemName:   initFlags.itemName  ?? "",
      itemImg:    initFlags.itemImg   ?? "",
    } : null;

    const takeSection = isTie
      ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
           <button class="clash-btn-reroll"
                   style="padding:4px 16px;height:30px;background:#5F3E22;color:#E8C9A2;
                          border:1px solid #C9A84C;cursor:pointer;font-size:.85rem;border-radius:2px;flex-shrink:0;">
             再次骰掷
           </button>
           <span style="font-size:.7rem;color:#6A5A48;">平局！双方重新骰掷</span>
         </div>`
      : noTake
        ? `<div style="padding:4px 0;">
             <span style="font-size:.85rem;color:#6EE06E;font-weight:bold;">✓ 防守成功，无伤害</span>
           </div>`
        : `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
             <button class="clash-btn-apply-damage"
                     data-target-actor-id="${loser?.id ?? ""}"
                     data-damage="${finalDamage}"
                     style="width:48px;height:30px;background:#B84444;color:#fff;
                            border:none;cursor:pointer;font-size:.85rem;border-radius:2px;flex-shrink:0;">承受</button>
             <span style="font-size:.7rem;color:#6A5A48;">先选中 Token，再点击按钮扣除 ${finalDamage} 点生命值</span>
           </div>`;

    const content = `
      <div class="limbus-clash-card" data-clash-type="resolve">
        ${ClashManager._chatHeader(atkActor ?? { img: "", name: "?" }, resolveTitle)}
        ${ClashManager._goldDivider()}
        <div style="display:flex;align-items:flex-start;gap:12px;margin:8px 0;">
          <div style="flex:1;text-align:center;">
            <div style="font-size:12px;color:#9A8462;margin-bottom:4px;">${atkActor?.name ?? "?"}</div>
            <img src="${atkItemImg ?? ""}" style="width:50px;height:50px;object-fit:cover;display:block;margin:0 auto;" alt="">
            <div style="font-size:12px;color:#E8C9A2;margin-top:4px;">${atkItemName ?? ""}</div>
            <div style="font-size:11px;color:#EBBD68;">${atkFormula ?? ""}</div>
          </div>
          <div style="align-self:center;font-size:1.6rem;font-weight:bold;color:#C9A84C;padding:0 4px;">${isClashCounterWin ? "⚔️" : "VS"}</div>
          <div style="flex:1;text-align:center;">
            <div style="font-size:12px;color:#9A8462;margin-bottom:4px;">${defActor?.name ?? "?"}</div>
            <img src="${defItemImg ?? ""}" style="width:50px;height:50px;object-fit:cover;display:block;margin:0 auto;" alt="">
            <div style="font-size:12px;color:#E8C9A2;margin-top:4px;">${defItemName ?? ""}</div>
            <div style="font-size:11px;color:#EBBD68;">${defFormula ?? ""}</div>
          </div>
        </div>
        ${ClashManager._goldDivider()}
        <div style="text-align:center;margin:8px 0;">
          <div style="font-size:14px;color:#C9A84C;margin-bottom:6px;">拼点结算</div>
          <div style="display:flex;align-items:center;justify-content:center;gap:14px;">
            <span style="${atkTotalStyle}">${atkTotal}</span>
            <span style="font-size:1.5rem;color:#C9A84C;">${cmp}</span>
            <span style="${defTotalStyle}">${defTotal}</span>
          </div>
        </div>
        ${ClashManager._goldDivider()}
        <div style="font-size:.8rem;color:#9A8462;line-height:1.7;margin:4px 0 8px;">
          ${notes.map(n => `<div>${n}</div>`).join("")}
        </div>
        ${sanityNotes.length ? `
        <div class="limbus-sanity-toggle-row"
             style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:4px 0 0;user-select:none;">
          <div style="flex:1;height:1px;background:linear-gradient(to right,transparent,#C9A84C);"></div>
          <span class="limbus-sanity-toggle"
                style="font-size:.72rem;color:#C9A84C;padding:0 4px;line-height:1;">▼ 理智</span>
          <div style="flex:1;height:1px;background:linear-gradient(to left,transparent,#C9A84C);"></div>
        </div>
        <div class="limbus-sanity-section"
             style="display:none;font-size:.8rem;line-height:1.8;padding:4px 6px;
                    background:rgba(0,0,0,.25);border-radius:3px;margin-bottom:4px;">
          ${sanityNotes.map(n => `<div>${n}</div>`).join("")}
        </div>` : ""}
        ${takeSection}
      </div>`;

    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: atkActor }),
      content,
      flags: {
        limbusCompany_FVTT: {
          type:          "clash-resolve",
          targetActorId: loser?.id ?? "",
          damage:        finalDamage,
          rerollData,
          weightSpread,
        },
      },
    });
  }

  /* ─── EGO 罪孽抗性修改 ────────────────────────────────────────────────── */

  static async _applyEgoResistanceChanges(actor, item) {
    const adj = item.system?.egoResistanceAdj;
    if (!adj?.length) return;
    const VALID = CONFIG.LIMBUSCOMPANY?.RESISTANCE_VALUES ?? ["x0.5","x1.0","x2.0","x2.5","x3.0"];
    const update = {};
    for (const { sinType, multiplier } of adj) {
      if (!sinType || !VALID.includes(multiplier)) continue;
      update[`system.egoResistances.${sinType}`] = multiplier;
    }
    if (Object.keys(update).length) await actor.update(update);
  }

  /* ─── 再次骰掷（平局时重新计算） ─────────────────────────────────────── */

  static async rerollClash(rerollData) {
    if (!rerollData) return;
    const {
      atkActorId, atkFormula, atkItemName, atkItemImg, atkCategory, atkSinType,
      defActorId, defFormula, defItemName, defItemImg, defCategory, defSinType,
    } = rerollData;

    const atkActor = game.actors.get(atkActorId);
    const defActor = game.actors.get(defActorId);
    if (!atkActor || !defActor) {
      ui.notifications.warn("找不到对抗双方角色，无法再次骰掷");
      return;
    }

    const atkRoll = new Roll(atkFormula);
    const defRoll = new Roll(defFormula);
    await atkRoll.evaluate();
    await defRoll.evaluate();

    const resolution = ClashManager._computeResolution({
      atkActor,    atkTotal:    atkRoll.total,  atkFormula,
      atkItemName, atkItemImg,  atkCategory,    atkSinType,
      defActor,    defTotal:    defRoll.total,  defFormula,
      defItemName, defItemImg,  defCategory,    defSinType,
    });

    // 呼吸暴击（再次骰掷后也检查）
    if (resolution.breatheCrit && resolution.winner) {
      await ClashManager._reduceBuffStacks(resolution.winner, "breathing");
    }
    if (resolution.dodgeWin) {
      const curAp = defActor.system.ap?.value ?? 0;
      const maxAp = defActor.system.ap?.max ?? 3;
      await defActor.update({ "system.ap.value": Math.min(curAp + 1, maxAp) });
    }

    await ClashManager._sendResolveMsg(resolution,
      {
        category:  atkCategory,
        sinType:   atkSinType,
        weight:    rerollData.atkWeight   ?? 1,
        rollTotal: rerollData.atkRollBase ?? atkRoll.total,
        itemId:    rerollData.atkItemId   ?? "",
        itemName:  atkItemName,
        itemImg:   atkItemImg,
      },
      defActor,
      { img: defItemImg, name: defItemName, system: { category: defCategory, sinType: defSinType } },
      defFormula,
    );

    // ── 平局重投后触发 Activity（仅 GM 执行，拥有全部 Actor 写权限） ──
    if (!game.user.isGM) return;

    const { atkWins, isTie: newIsTie, dodgeWin, breatheCrit } = resolution;
    if (newIsTie) return; // 再次平局，等待下一次重投

    const atkItemDoc = atkActor?.items?.get(rerollData.atkItemId)
      ?? (rerollData.atkItemUuid ? await fromUuid(rerollData.atkItemUuid).catch(() => null) : null)
      ?? null;
    const defItemDoc = defActor?.items?.get(rerollData.defItemId) ?? null;

    const _fc2      = {};
    const _actMsgs2 = [];
    const atkCtx2 = { atkActor, defActor, owner: atkActor, other: defActor, _fireCounts: _fc2, _actMsgs: _actMsgs2, _currentItemId: atkItemDoc?.id ?? "" };
    const defCtx2 = { atkActor, defActor, owner: defActor, other: atkActor, _fireCounts: _fc2, _actMsgs: _actMsgs2, _currentItemId: defItemDoc?.id ?? "" };

    let _unbreakableCounterArgs2 = null;
    if (atkWins) {
      await ClashManager._applyActivitiesAndEquip(atkItemDoc, "拼点成功", atkCtx2);
      await ClashManager._applyActivitiesAndEquip(defItemDoc,  "拼点失败", defCtx2);
      // 【不可摧毁】：防守方拼点失败后自动反击（延迟到 _sendResolveMsg 后，此处已在其后）
      if (defItemDoc?.system?.diceType === "unbreakable") {
        _unbreakableCounterArgs2 = [defItemDoc, defActor, atkActor, defCtx2];
      }
      if (!dodgeWin) {
        await ClashManager._applyActivitiesAndEquip(atkItemDoc, "命中时", atkCtx2);
        if (breatheCrit) {
          await ClashManager._applyActivitiesAndEquip(atkItemDoc, "暴击命中时", atkCtx2);
        }
        await ClashManager._applyActivities(defItemDoc, "受到伤害时", defCtx2);
        for (const eq of ClashManager._getEquippedItems(defActor)) {
          await ClashManager._applyActivities(eq, "受到伤害时", defCtx2);
        }
      }
    } else {
      await ClashManager._applyActivitiesAndEquip(atkItemDoc, "拼点失败", atkCtx2);
      await ClashManager._applyActivitiesAndEquip(defItemDoc,  "拼点成功", defCtx2);
      // 【不可摧毁】：攻击方拼点失败后自动反击（延迟到 _sendResolveMsg 后，此处已在其后）
      if (atkItemDoc?.system?.diceType === "unbreakable") {
        _unbreakableCounterArgs2 = [atkItemDoc, atkActor, defActor, atkCtx2];
      }
      if (!dodgeWin) {
        await ClashManager._applyActivitiesAndEquip(defItemDoc, "命中时", defCtx2);
        await ClashManager._applyActivities(atkItemDoc, "受到伤害时", atkCtx2);
        for (const eq of ClashManager._getEquippedItems(atkActor)) {
          await ClashManager._applyActivities(eq, "受到伤害时", atkCtx2);
        }
      }
    }

    if (_unbreakableCounterArgs2) {
      await ClashManager._triggerUnbreakableCounter(..._unbreakableCounterArgs2);
    }

    await ClashManager._flushActMsgs(_actMsgs2, atkActor);
  }

  /* ─── 阶段六：直接承受（跳过对抗，玩家B点聊天框承受） ────────────────── */

  static async handleDirectTake(initFlags) {
    const selActor =
      game.user.character ??
      canvas.tokens?.controlled?.[0]?.actor ??
      null;

    if (!selActor) {
      ui.notifications.warn("请先选中承受伤害的角色 Token");
      return;
    }

    // 发起方不能承受自己发起的攻击
    if (selActor.id === initFlags.attackerId) {
      ui.notifications.warn("发起对抗的角色不能承受自己的攻击，请由目标玩家操作");
      return;
    }

    const atkActor  = game.actors.get(initFlags.attackerId);
    const defActor  = selActor;
    // DiceSoNice: 承受时先播攻击方骰子动画
    if (game.dice3d && initFlags.rollData) {
      const atkRoll = Roll.fromJSON(JSON.stringify(initFlags.rollData));
      await game.dice3d.showForRoll(atkRoll, game.user, true, null, false);
    }
    const rollTotal = initFlags.rollTotal ?? 0;
    const category  = initFlags.category ?? "";
    const sinType   = initFlags.sinType  ?? "";
    const PHYS_CATS = ["slash", "blunt", "pierce"];
    const SIN_TYPES = ["wrath","lust","sloth","gluttony","gloom","pride","envy"];
    const PHYS_LABELS = { slash: "斩击", blunt: "打击", pierce: "突刺" };
    const SIN_LABELS  = { wrath:"暴怒", lust:"色欲", sloth:"怠惰",
                          gluttony:"暴食", gloom:"忧郁", pride:"傲慢", envy:"嫉妒" };

    const gs = (actor, type) => ClashManager._getBuffVal(actor, type).stacks;
    const gi = (actor, type) => ClashManager._getBuffVal(actor, type).intensity;

    // 优先使用 base actor（确保角色卡与 linked tokens 同步）
    const baseActor = game.actors.get(selActor.id) ?? selActor;

    // ── Activity 触发（承受路径）—— 必须在伤害计算之前，公式可能被修改 ─────
    const atkItem2  = atkActor?.items?.get(initFlags.itemId)
      ?? (initFlags.itemUuid ? await fromUuid(initFlags.itemUuid).catch(() => null) : null)
      ?? null;
    const _fc2      = {};
    const _actMsgs2 = [];
    const atkCtx2 = { atkActor, defActor: baseActor, owner: atkActor, other: baseActor, _fireCounts: _fc2, _actMsgs: _actMsgs2, _currentItemId: atkItem2?.id ?? "" };
    const defCtx2 = { atkActor, defActor: baseActor, owner: baseActor, other: atkActor, _fireCounts: _fc2, _actMsgs: _actMsgs2, _currentItemId: "" };

    // 记录触发前原始公式，用于检测变化后重投
    const atkBaseFormulaOrig2 = initFlags.baseFormula ?? initFlags.formula;

    // [攻击前] [攻击时]
    await ClashManager._applyActivitiesAndEquip(atkItem2, "攻击前", atkCtx2);
    await ClashManager._applyActivitiesAndEquip(atkItem2, "攻击时", atkCtx2);

    // [攻击时] 可能修改骰子公式（diceAdj/diceFacesAdj/baseValue），检测并重投
    let finalRollTotal = rollTotal;
    {
      const newAtkBase = atkItem2?.system?.diceFormula ?? atkBaseFormulaOrig2;
      if (newAtkBase !== atkBaseFormulaOrig2) {
        const bonusPart  = (initFlags.formula ?? "").slice(atkBaseFormulaOrig2.length);
        const newAtkFull = newAtkBase + bonusPart;
        const rerollAtk  = new Roll(newAtkFull);
        await rerollAtk.evaluate();
        finalRollTotal = rerollAtk.total;
        _actMsgs2.push({
          trigger:  "公式重投",
          itemName: atkItem2?.name ?? "攻击方",
          msgs:     [`公式变化（${atkBaseFormulaOrig2} → ${newAtkBase}），重新投骰：${rerollAtk.result} = <b>${rerollAtk.total}</b>`],
        });
      }
    }

    // [命中时]：承受始终命中
    await ClashManager._applyActivitiesAndEquip(atkItem2, "命中时", atkCtx2);

    // ── 攻击方 BUFF 修正（承受不拼点，拼点威力↑↓不计入）──────────────────
    const strong  = atkActor ? gs(atkActor, "strong") : 0;
    const weak    = atkActor ? gs(atkActor, "weak")   : 0;
    const atkDiceMod = strong - weak;

    // ── 等级差加值（防御等级 > 攻击等级时无加成）──────────────────────────
    const atkLv   = atkActor ? ClashManager._effAtkLv(atkActor) : 0;
    const defLv   = ClashManager._effDefLv(defActor);
    const lvBonus = Math.floor(Math.max(0, atkLv - defLv) / 3);

    // ── 有效骰数（使用重投后的 finalRollTotal）─────────────────────────────
    const effectiveAtk = finalRollTotal + atkDiceMod + lvBonus;

    // ── 守护（层数）/ 易损（层数） ──────────────────────────────────────
    const guard   = gs(defActor, "guard");
    const fragile = gs(defActor, "fragile");
    const adjustedAtk = Math.max(0, effectiveAtk + fragile - guard);

    // ── 物理抗性 & 罪孽抗性 ────────────────────────────────────────────
    const effRes    = ClashManager._getEffectiveResistances(defActor);
    const physResStr = PHYS_CATS.includes(category) ? (effRes[category] ?? "x1.0") : "x1.0";
    const sinResStr  = SIN_TYPES.includes(sinType)
      ? (defActor.system?.egoResistances?.[sinType] ?? "x1.0") : "x1.0";
    const physMult = ClashManager._parseResistance(physResStr);
    const sinMult  = ClashManager._parseResistance(sinResStr);

    // ── 最终伤害 ──────────────────────────────────────────────────────────
    const finalDamage = Math.max(0, Math.round(adjustedAtk * physMult * sinMult));

    // ── 逐步结算说明 ──────────────────────────────────────────────────────
    const calcNotes = [];
    let step = finalRollTotal;

    calcNotes.push(`骰点结果：${step}`);

    if (atkDiceMod !== 0) {
      const parts = [];
      if (strong > 0) parts.push(`强壮+${strong}`);
      if (weak   > 0) parts.push(`虚弱-${weak}`);
      step += atkDiceMod;
      calcNotes.push(`攻击方BUFF（${parts.join("，")}）→ 有效骰数 ${step}`);
    }

    if (lvBonus > 0) {
      step += lvBonus;
      calcNotes.push(`等级差加值（攻Lv${atkLv} vs 防Lv${defLv}，差${atkLv - defLv}，+${lvBonus}）→ ${step}`);
    } else if (defLv > atkLv) {
      calcNotes.push(`等级差：防御等级${defLv} > 攻击等级${atkLv}，无加成`);
    }

    if (fragile > 0 || guard > 0) {
      const prev = step;
      step = adjustedAtk;
      const parts = [];
      if (fragile > 0) parts.push(`易损+${fragile}`);
      if (guard   > 0) parts.push(`守护-${guard}`);
      calcNotes.push(`${parts.join("，")}：${prev} → ${step}`);
    }

    if (physMult !== 1.0 || sinMult !== 1.0) {
      const resParts = [];
      if (physMult !== 1.0) resParts.push(`${PHYS_LABELS[category] ?? category}抗性${physResStr}`);
      if (sinMult  !== 1.0) resParts.push(`${SIN_LABELS[sinType]  ?? sinType}罪孽抗性${sinResStr}`);
      calcNotes.push(`${resParts.join(" × ")}：${step} → ${finalDamage}`);
    }

    // [暴击命中时]：检查攻击方是否有【呼吸法】触发暴击
    const breatheBuff2 = atkActor ? ClashManager._getBuff(atkActor, "breathing") : null;
    if (breatheBuff2 && breatheBuff2.stacks > 0) {
      const critChance = (breatheBuff2.intensity ?? 0) * 0.05;
      if (Math.random() < critChance) {
        await ClashManager._reduceBuffStacks(atkActor, "breathing");
        await ClashManager._applyActivitiesAndEquip(atkItem2, "暴击命中时", atkCtx2);
      }
    }

    // [受到伤害时]：承受方受伤（技能 + 装备格物品）
    await ClashManager._applyActivities(atkItem2, "受到伤害时", defCtx2);
    for (const eq of ClashManager._getEquippedItems(baseActor)) {
      await ClashManager._applyActivities(eq, "受到伤害时", defCtx2);
    }

    const _buffHookMsgs2 = [];
    await ClashManager._applyAndSendTake(baseActor, finalDamage, { calcNotes, attacker: atkActor, hookMsgs: _buffHookMsgs2 });
    if (_buffHookMsgs2.length) {
      _actMsgs2.push({ trigger: "受到伤害时", itemName: baseActor.name, msgs: _buffHookMsgs2 });
    }

    // [攻击后]：结算完毕
    await ClashManager._applyActivitiesAndEquip(atkItem2, "攻击后", atkCtx2);

    // 统一发出本次承受所有 activity 通知
    await ClashManager._flushActMsgs(_actMsgs2, atkActor);
    await ClashManager._broadcastAndCheckReactions({ lastSkillUuid: atkItem2?.uuid ?? null, attacker: atkActor, defender: defActor });

    // 若选中的是非 linked token actor，额外同步该 token 的 HP
    if (selActor !== baseActor && selActor.isToken) {
      const th = selActor.system?.hp?.value ?? 0;
      await selActor.update({ "system.hp.value": Math.max(0, th - finalDamage) });
    }

    // ── 加重扩散：weight>=2 时发出额外承受卡 ──────────────────────────────
    const weight = initFlags.weight ?? 1;
    if (weight >= 2) {
      await ClashManager._sendWeightSpreadCard(initFlags, atkActor);
    }
  }

  /* ─── 加重扩散承受 ──────────────────────────────────────────────────────── */

  /** 构建加重扩散卡 HTML（remainingUses 可变，复用于更新消息内容）。 */
  static _buildWeightSpreadContent(flags, remainingUses, atkActor) {
    const actor      = atkActor ?? game.actors.get(flags.attackerId);
    const btnDisabled = remainingUses <= 0;
    const btnStyle   = btnDisabled
      ? "background:#555;color:#888;border:none;cursor:not-allowed;opacity:.6;"
      : "background:#B84444;color:#fff;border:none;cursor:pointer;";
    const btnLabel   = btnDisabled ? "（已用尽）" : `承受（×${remainingUses}）`;
    return `
      <div class="limbus-clash-card" data-clash-type="weight-spread">
        ${ClashManager._chatHeader(actor, "加重扩散")}
        ${ClashManager._goldDivider()}
        <div style="font-size:.85rem;color:#E8C9A2;margin:4px 0 6px;">
          ⚔️ <strong>${flags.itemName ?? "技能"}</strong> 加重命中！<br>
          <span style="color:#C9A84C;">扩散承受剩余：<strong>${remainingUses}</strong> 次</span>
        </div>
        <div style="margin-bottom:4px;">
          <button class="clash-btn-weight-take"
                  style="height:30px;padding:0 14px;${btnStyle}font-size:.85rem;border-radius:2px;"
                  ${btnDisabled ? "disabled" : ""}>
            ${btnLabel}
          </button>
        </div>
        <div style="font-size:.72rem;color:#9A8462;margin-top:2px;">选中目标 Token 后点击按钮进行扩散承受</div>
        ${ClashManager._goldDivider()}
      </div>`;
  }

  /** 发送加重扩散承受聊天卡。 */
  static async _sendWeightSpreadCard(initFlags, atkActor) {
    const remainingUses = (initFlags.weight ?? 1) - 1;
    const spreadFlags = {
      type:          "clash-weight-spread",
      attackerId:    initFlags.attackerId,
      itemId:        initFlags.itemId,
      itemName:      initFlags.itemName,
      itemImg:       initFlags.itemImg,
      rollTotal:     initFlags.rollTotal,
      category:      initFlags.category,
      sinType:       initFlags.sinType,
      remainingUses,
    };
    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: atkActor }),
      content: ClashManager._buildWeightSpreadContent(spreadFlags, remainingUses, atkActor),
      flags:   { limbusCompany_FVTT: spreadFlags },
    });
  }

  /** 玩家选中 Token 后点击扩散卡承受按钮的处理逻辑。 */
  static async handleWeightTake(msgId, flags) {
    if ((flags.remainingUses ?? 0) <= 0) {
      ui.notifications.warn("扩散承受次数已用尽");
      return;
    }

    const selActor = game.user.character ?? canvas.tokens?.controlled?.[0]?.actor ?? null;
    if (!selActor) {
      ui.notifications.warn("请先选中承受伤害的 Token");
      return;
    }
    if (selActor.id === flags.attackerId) {
      ui.notifications.warn("发起对抗的角色不能承受自己的攻击");
      return;
    }

    const atkActor = game.actors.get(flags.attackerId);
    const defActor = game.actors.get(selActor.id) ?? selActor;

    const rollTotal = flags.rollTotal ?? 0;
    const category  = flags.category  ?? "";
    const sinType   = flags.sinType   ?? "";
    const PHYS_CATS   = ["slash", "blunt", "pierce"];
    const SIN_TYPES   = ["wrath","lust","sloth","gluttony","gloom","pride","envy"];
    const PHYS_LABELS = { slash: "斩击", blunt: "打击", pierce: "突刺" };
    const SIN_LABELS  = { wrath:"暴怒", lust:"色欲", sloth:"怠惰",
                          gluttony:"暴食", gloom:"忧郁", pride:"傲慢", envy:"嫉妒" };

    const gs = (actor, type) => ClashManager._getBuffVal(actor, type).stacks;

    // 攻击方 BUFF 修正
    const strong     = atkActor ? gs(atkActor, "strong") : 0;
    const weak       = atkActor ? gs(atkActor, "weak")   : 0;
    const atkDiceMod = strong - weak;

    // 等级差
    const atkLv   = atkActor ? ClashManager._effAtkLv(atkActor) : 0;
    const defLv   = ClashManager._effDefLv(defActor);
    const lvBonus = Math.floor(Math.max(0, atkLv - defLv) / 3);

    // 有效骰数
    const effectiveAtk = rollTotal + atkDiceMod + lvBonus;

    // 守护 / 易损
    const guard       = gs(defActor, "guard");
    const fragile     = gs(defActor, "fragile");
    const adjustedAtk = Math.max(0, effectiveAtk + fragile - guard);

    // 物理抗性 & 罪孽抗性
    const effRes     = ClashManager._getEffectiveResistances(defActor);
    const physResStr = PHYS_CATS.includes(category) ? (effRes[category] ?? "x1.0") : "x1.0";
    const sinResStr  = SIN_TYPES.includes(sinType)
      ? (defActor.system?.egoResistances?.[sinType] ?? "x1.0") : "x1.0";
    const physMult   = ClashManager._parseResistance(physResStr);
    const sinMult    = ClashManager._parseResistance(sinResStr);

    const finalDamage = Math.max(0, Math.round(adjustedAtk * physMult * sinMult));

    // 结算说明
    const calcNotes = [`骰点结果：${rollTotal}（加重扩散）`];
    let step = rollTotal;
    if (atkDiceMod !== 0) {
      step += atkDiceMod;
      const parts = [];
      if (strong > 0) parts.push(`强壮+${strong}`);
      if (weak   > 0) parts.push(`虚弱-${weak}`);
      calcNotes.push(`攻击方BUFF（${parts.join("，")}）→ 有效骰数 ${step}`);
    }
    if (lvBonus > 0) {
      step += lvBonus;
      calcNotes.push(`等级差（攻Lv${atkLv} vs 防Lv${defLv}，差${atkLv - defLv}，+${lvBonus}）→ ${step}`);
    } else if (defLv > atkLv) {
      calcNotes.push(`等级差：防御等级${defLv} > 攻击等级${atkLv}，无加成`);
    }
    if (fragile > 0 || guard > 0) {
      const prev  = step;
      step = adjustedAtk;
      const parts = [];
      if (fragile > 0) parts.push(`易损+${fragile}`);
      if (guard   > 0) parts.push(`守护-${guard}`);
      calcNotes.push(`${parts.join("，")}：${prev} → ${step}`);
    }
    if (physMult !== 1.0 || sinMult !== 1.0) {
      const resParts = [];
      if (physMult !== 1.0) resParts.push(`${PHYS_LABELS[category] ?? category}抗性${physResStr}`);
      if (sinMult  !== 1.0) resParts.push(`${SIN_LABELS[sinType]  ?? sinType}罪孽抗性${sinResStr}`);
      calcNotes.push(`${resParts.join(" × ")}：${step} → ${finalDamage}`);
    }

    const _buffHookMsgsCl = [];
    await ClashManager._applyAndSendTake(defActor, finalDamage, { calcNotes, attacker: atkActor, hookMsgs: _buffHookMsgsCl });
    if (_buffHookMsgsCl.length) {
      _actMsgs2.push({ trigger: "受到伤害时", itemName: defActor.name, msgs: _buffHookMsgsCl });
    }

    // 若是非 linked token，额外同步 HP
    if (selActor !== defActor && selActor.isToken) {
      const cur = selActor.system?.hp?.value ?? 0;
      await selActor.update({ "system.hp.value": Math.max(0, cur - finalDamage) });
    }

    // 更新扩散卡剩余次数
    const newRemaining = (flags.remainingUses ?? 1) - 1;
    const message = game.messages.get(msgId);
    if (message) {
      const newFlags  = { ...flags, remainingUses: newRemaining };
      const newContent = ClashManager._buildWeightSpreadContent(newFlags, newRemaining, atkActor);
      await message.update({ flags: { limbusCompany_FVTT: newFlags }, content: newContent });
    }
  }

  /* ─── 【不可摧毁】拼点失败触发反击 ──────────────────────────────────── */

  /**
   * 若 loserItem 的 diceType 为 "unbreakable"，在拼点失败后自动对 targetActor 发起反击：
   * - 变动值（面数）固定为 1：NdF+B → 每颗骰子固定投出 1 点 → 确定值 = 骰数N + 基础值B
   * - 反击最终值 = (骰数 + 基础值) + BUFF（强壮/虚弱） × 抗性（守护/易损）
   * - 可触发 loserItem 的 [命中时] / [暴击命中时] 效果
   */
  static async _triggerUnbreakableCounter(loserItem, loserActor, targetActor, loserCtx) {
    if (!loserItem || loserItem.system?.diceType !== "unbreakable") return;
    if (!loserActor || !targetActor) return;

    // 解析技能公式，提取骰数（N）和基础值（B）
    // 支持格式：NdF、NdF+B、NdF-B（F=面数，被替换为1，故每骰=1点）
    const baseFormula = loserItem.system?.diceFormula ?? "1d4";
    const m = /^(\d+)[dD](\d+)\s*([+-]\s*\d+)?$/.exec(baseFormula.trim());
    let rollBase;
    let formulaDisplay;
    if (m) {
      const diceCount = parseInt(m[1]) || 1;
      const modifier  = m[3] ? parseInt(m[3].replace(/\s/g, "")) : 0;
      rollBase       = diceCount + modifier;          // 每骰面数=1 → NdF+B = N×1+B
      formulaDisplay = `${diceCount}d1+${modifier} = ${diceCount}×1${modifier >= 0 ? "+" : ""}${modifier} = ${rollBase}`;
    } else {
      // 公式无法解析时回退为纯数值求值
      const r = new Roll(baseFormula);
      await r.evaluate();
      rollBase       = r.total;
      formulaDisplay = `${baseFormula} = ${rollBase}`;
    }

    // BUFF 修正（以失败方为攻击方：强壮/虚弱）
    const gs = (actor, type) => ClashManager._getBuffVal(actor, type).stacks;
    const strong  = gs(loserActor, "strong");
    const weak    = gs(loserActor, "weak");
    const buffMod = strong - weak;
    const adjusted = rollBase + buffMod;

    // 目标（胜利方）的守护/易损 + 物理/罪孽抗性
    const cat = loserItem.system?.category ?? "";
    const sin = loserItem.system?.sinType  ?? "";
    const PHYS_CATS = new Set(["slash", "blunt", "pierce"]);
    const SIN_TYPES = new Set(["wrath","lust","sloth","gluttony","gloom","pride","envy"]);
    const effRes     = ClashManager._getEffectiveResistances(targetActor);
    const physResStr = PHYS_CATS.has(cat) ? (effRes[cat] ?? "x1.0") : "x1.0";
    const physMult   = ClashManager._parseResistance(physResStr);
    const sinResStr  = SIN_TYPES.has(sin)
      ? (targetActor.system?.egoResistances?.[sin] ?? "x1.0") : "x1.0";
    const sinMult    = ClashManager._parseResistance(sinResStr);
    const guard   = gs(targetActor, "guard");
    const fragile = gs(targetActor, "fragile");
    const adjustedBase = Math.max(0, adjusted + fragile - guard);
    const finalDmg     = Math.max(0, Math.round(adjustedBase * physMult * sinMult));

    // 呼吸暴击判定
    const breatheBuff = ClashManager._getBuff(loserActor, "breathing");
    let breatheCrit = false;
    if (breatheBuff && breatheBuff.stacks > 0) {
      breatheCrit = Math.random() < (breatheBuff.intensity ?? 1) * 0.05;
      if (breatheCrit) await ClashManager._reduceBuffStacks(loserActor, "breathing");
    }

    // 触发 [命中时] / [暴击命中时]
    await ClashManager._applyActivitiesAndEquip(loserItem, "命中时", loserCtx);
    if (breatheCrit) await ClashManager._applyActivitiesAndEquip(loserItem, "暴击命中时", loserCtx);

    // 构建结算说明
    const calcNotes = [`【不可摧毁】反击（变动值=1）：${formulaDisplay}`];
    if (buffMod !== 0) calcNotes.push(`BUFF(强壮${strong}-虚弱${weak}=${buffMod >= 0 ? "+" : ""}${buffMod}) → ${adjusted}`);
    if (fragile > 0 || guard > 0) calcNotes.push(`易损(+${fragile})/守护(-${guard}) → ${adjustedBase}`);
    if (physMult !== 1.0 || sinMult !== 1.0) calcNotes.push(`抗性(${physResStr}×${sinResStr}) → ${finalDmg}`);
    if (breatheCrit) calcNotes.push(`【呼吸】暴击！`);

    // 发送反击触发聊天头（伤害消息由 _applyAndSendTake 单独发送）
    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: loserActor }),
      content: `<div class="limbuscompany chat-clash">
        ${ClashManager._chatHeader(loserActor, "不可摧毁 · 拼点失败反击")}
        <div style="margin:4px 0 2px;font-size:.82rem;">
          <strong>${loserItem.name}</strong>（不可摧毁骰）触发，对
          <strong>${targetActor.name}</strong> 发起反击
          ${breatheCrit ? `<span style="color:#FFD066;font-weight:bold;">　暴击！</span>` : ""}
        </div>
      </div>`,
    });

    // 对目标造成伤害（包含破裂/沉沦/护盾/混乱等完整结算）
    const hookMsgs = [];
    await ClashManager._applyAndSendTake(targetActor, finalDmg, { attacker: loserActor, calcNotes, hookMsgs });
  }

  /* ─── 阶段七：承受结算（应用伤害 + 发送聊天框） ─────────────────────── */

  static async handleApplyDamage(targetActorId, damage) {
    // 优先使用 flags 记录的 base actor（更新后 linked tokens 自动同步）
    const baseActor = game.actors.get(targetActorId);
    const selToken  = canvas.tokens?.controlled?.[0];
    const selActor  = selToken?.actor;
    const actor     = baseActor ?? selActor;

    if (!actor) {
      ui.notifications.warn("找不到目标角色，请先选中 Token");
      return;
    }

    await ClashManager._applyAndSendTake(actor, damage);

    // 若选中的是非 linked token actor（与 base actor 为不同文档），额外同步该 token 的 HP
    if (selActor && selActor !== actor && selActor.isToken) {
      const th = selActor.system?.hp?.value ?? 0;
      await selActor.update({ "system.hp.value": Math.max(0, th - damage) });
    }
  }

  /**
   * @param {Actor}  actor
   * @param {number} damage      基础伤害（拼点/直接承受计算后的值）
   * @param {object} [opts]
   * @param {boolean} [opts.isSeismic=false]  是否为【震颤引爆】类型攻击
   */
  static async _applyAndSendTake(actor, damage, { isSeismic = false, calcNotes = [], attacker = null, hookMsgs = null } = {}) {
    const sys   = actor.system;
    const maxHp = sys.hp?.max ?? 1;

    // ── 受到伤害时 BUFF ────────────────────────────────────────────────────

    // 【护盾】：每层抵挡 1 点伤害，先于其他伤害结算，剩余伤害再穿透
    const shieldBuff = ClashManager._getBuff(actor, "shield");
    if (shieldBuff && (shieldBuff.stacks ?? 0) > 0 && damage > 0) {
      const absorbed   = Math.min(shieldBuff.stacks, damage);
      const remaining  = shieldBuff.stacks - absorbed;
      damage = damage - absorbed;
      const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);
      const si = buffs.findIndex(b => b.id === shieldBuff.id);
      if (si >= 0) {
        if (remaining <= 0) buffs.splice(si, 1);
        else buffs[si] = { ...buffs[si], stacks: remaining };
        await ClashManager._safeDocUpdate(actor, { "system.buffs": buffs });
      }
      if (hookMsgs) {
        hookMsgs.push(`【护盾】吸收 <strong>${absorbed}</strong> 点伤害（剩余 <strong>${remaining}</strong> 层）`);
      }
    }

    // 【破裂】：附加强度点固定伤害，层数-1
    const ruptureBuff = ClashManager._getBuff(actor, "rupture");
    let ruptureDmg = 0;
    if (ruptureBuff && ruptureBuff.stacks > 0) {
      ruptureDmg = ruptureBuff.intensity ?? 0;
      await ClashManager._reduceBuffStacks(actor, "rupture");
    }

    // 【沉沦】：增加强度点侵蚀度（降低理智），层数-1
    const sinkingBuff = ClashManager._getBuff(actor, "sinking");
    let sanityDmg = 0;
    if (sinkingBuff && sinkingBuff.stacks > 0) {
      sanityDmg = sinkingBuff.intensity ?? 0;
      await ClashManager._reduceBuffStacks(actor, "sinking");
    }

    // 【震颤】：受到震颤引爆攻击时，混乱阈值前移强度值，层数-1
    let tremorTriggered = false;
    if (isSeismic) {
      const tremorBuff = ClashManager._getBuff(actor, "tremor");
      if (tremorBuff && tremorBuff.stacks > 0) {
        await actor.triggerSeismicBlast?.(tremorBuff.intensity ?? 0);
        await ClashManager._reduceBuffStacks(actor, "tremor");
        tremorTriggered = true;
      }
    }

    // ── HP 结算（基础伤害 + 破裂附加） ────────────────────────────────────
    const totalDmg = damage + ruptureDmg;
    const oldHp    = sys.hp?.value ?? 0;
    const newHp    = Math.max(0, oldHp - totalDmg);

    // 提前判断混乱阈值（用于聊天框显示，含升级逻辑）
    const _CHAOS_TYPES  = ["chaos", "chaos_plus", "chaos_double_plus"];
    const _CHAOS_NAMES  = ["陷入混乱", "陷入混乱+", "陷入混乱++"];
    const thresholds    = sys.chaosThresholds ?? [];
    const chaosCount    = thresholds.filter(t => !t.triggered && newHp <= maxHp * t.percent / 100).length;
    const chaosTriggered = chaosCount > 0;
    const existingChaosType  = (sys.buffs ?? []).find(b => _CHAOS_TYPES.includes(b.type))?.type;
    const currentChaosLevel  = existingChaosType ? (_CHAOS_TYPES.indexOf(existingChaosType) + 1) : 0;
    const newChaosLevel      = Math.min(3, currentChaosLevel + chaosCount);
    const chaosName          = _CHAOS_NAMES[newChaosLevel - 1] ?? "陷入混乱";

    // 更新 HP
    await actor.update({ "system.hp.value": newHp });

    // 沉沦：更新理智值（setSanity 内部会检查恐慌状态）
    if (sanityDmg > 0 && typeof actor.setSanity === "function") {
      await actor.setSanity((actor.system.sanity?.value ?? 50) - sanityDmg);
    }

    // 触发混乱效果（silent=true：混乱信息已在取血消息中展示，无需额外聊天框，避免双次 ChatMessage.create 触发 Foundry 清理竞态）
    if (chaosTriggered && actor.checkAndTriggerChaos) {
      await actor.checkAndTriggerChaos(newHp, oldHp, { silent: true });
    }

    // ── 自定义 BUFF onTakeDamage 钩子 ────────────────────────────────────
    const _hookLines = [];
    for (const buff of foundry.utils.deepClone(actor.system?.buffs ?? [])) {
      const handler = resolveBuffHandler(buff);
      if (typeof handler?.onTakeDamage === "function") {
        const result = await handler.onTakeDamage(actor, buff, { attacker });
        if (typeof result === "string" && result) _hookLines.push(result);
      }
    }
    // 将钩子消息合并到调用方提供的 hookMsgs 数组（供 _flushActMsgs 汇总）
    if (hookMsgs && _hookLines.length) {
      for (const line of _hookLines) hookMsgs.push(line);
    }

    await ClashManager._sendTakeMsg(actor, damage, oldHp, newHp, maxHp, chaosTriggered,
      { ruptureDmg, sanityDmg, tremorTriggered, chaosName, calcNotes });
  }

  static async _sendTakeMsg(actor, damage, oldHp, newHp, maxHp, chaosTriggered,
      { ruptureDmg = 0, sanityDmg = 0, tremorTriggered = false, chaosName = "陷入混乱", calcNotes = [] } = {}) {
    const hpPct    = Math.max(0, Math.round((newHp / maxHp) * 100));
    const totalDmg = damage + ruptureDmg;
    const extraLines = [];
    if (ruptureDmg   > 0) extraLines.push(`【破裂】附加 +${ruptureDmg} 点固定伤害`);
    if (sanityDmg    > 0) extraLines.push(`【沉沦】附加 ${sanityDmg} 点侵蚀度（理智-${sanityDmg}）`);
    if (tremorTriggered)  extraLines.push(`【震颤】引爆：混乱阈值前移`);

    const content = `
      <div class="limbus-clash-card limbus-take-card"
           style="background:linear-gradient(180deg,#2D0509 0%,#1A0305 100%);"
           data-clash-type="take">
        ${ClashManager._chatHeader(actor, "承受")}
        ${ClashManager._goldDivider()}
        ${calcNotes.length > 0 ? `
        <div style="margin:6px 0 4px;padding:5px 7px;background:rgba(0,0,0,.25);border-radius:3px;">
          <div style="font-size:.65rem;font-weight:bold;color:#C9A84C;margin-bottom:3px;letter-spacing:.05em;">结算说明</div>
          ${calcNotes.map(n => `<div style="font-size:.72rem;color:#9A8462;line-height:1.55;">${n}</div>`).join("")}
        </div>
        ${ClashManager._goldDivider()}` : ""}
        <div style="text-align:center;margin:10px 0;">
          <div style="font-size:16px;font-weight:bold;color:#E8C9A2;margin-bottom:6px;">生命值结算</div>
          <div style="font-size:13px;color:#E8CAA1;margin-bottom:10px;">
            ${actor.name} 受到了 ${totalDmg} 点伤害
            ${ruptureDmg > 0 ? `（基础 ${damage} + 破裂 ${ruptureDmg}）` : ""}
          </div>
          <div style="display:flex;align-items:center;justify-content:center;gap:18px;">
            <span style="font-size:2rem;font-weight:bold;color:#E8C9A2;">${oldHp}</span>
            <span style="font-size:1.5rem;color:#C9A84C;">→</span>
            <span style="font-size:2rem;font-weight:bold;color:#B84444;">${newHp}</span>
          </div>
        </div>
        ${ClashManager._goldDivider()}
        ${extraLines.length > 0
          ? `<div style="font-size:.8rem;color:#9A8462;margin-bottom:4px;">
               ${extraLines.map(l => `<div>${l}</div>`).join("")}
             </div>`
          : ""}
        ${chaosTriggered
          ? `<div style="text-align:center;font-size:.85rem;color:#E84444;font-weight:bold;margin-bottom:6px;">
               伤害超过混乱阈值——【${chaosName}】
             </div>`
          : ""}
        <div style="background:#1A0305;border-radius:3px;overflow:hidden;height:10px;margin:4px 0;">
          <div style="height:100%;background:${chaosTriggered ? "#B84444" : "#C9A84C"};width:${hpPct}%;transition:width .3s;"></div>
        </div>
        <div style="text-align:center;font-size:.75rem;color:#9A8462;margin-top:3px;">
          ${newHp} / ${maxHp}
        </div>
      </div>`;

    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor }),
      content,
      flags: { limbusCompany_FVTT: { type: "clash-take" } },
    });
  }

  /* ─── 直接反击（counter）结算 ──────────────────────────────────────────── */

  /**
   * 反击：双方直接受伤，不进行拼点。含 BUFF 和攻防等级差值。
   * - 防守方（使用反击技能）受到攻击方有效骰数×抗性的伤害
   * - 攻击方受到防守方有效骰数×罪孽抗性的反击伤害
   */
  static async _resolveDirectCounter(atkActor, defActor, initFlags, defItem, defRoll, defFormula) {
    const atkCategory = initFlags.category ?? "";
    const atkSinType  = initFlags.sinType  ?? "";
    const defSinType  = defItem.system?.sinType ?? "";
    const PHYS_CATS   = ["slash", "blunt", "pierce"];
    const SIN_TYPES   = ["wrath","lust","sloth","gluttony","gloom","pride","envy"];
    const gs = (actor, type) => ClashManager._getBuffVal(actor, type).stacks;
    const gi = (actor, type) => ClashManager._getBuffVal(actor, type).intensity;

    // ── 等级差（反击的防守方使用攻击等级） ───────────────────────────────
    const atkLv      = ClashManager._effAtkLv(atkActor);
    const defLv      = ClashManager._effAtkLv(defActor); // 反击属于攻击型，用攻击等级
    const atkLvBonus = Math.floor(Math.max(0, atkLv - defLv) / 3);
    const defLvBonus = Math.floor(Math.max(0, defLv - atkLv) / 3);

    // ── BUFF 修正 ─────────────────────────────────────────────────────────
    // 攻击方：强壮/虚弱 + 拼点威力
    const atkDiceMod = gs(atkActor, "strong") - gs(atkActor, "weak")
                     + gs(atkActor, "clashPowerUp") - gs(atkActor, "clashPowerDown");
    // 防守方（反击视为守备技能）：忍耐/破绽 + 拼点威力
    const defDiceMod = gs(defActor, "endure") - gs(defActor, "breach")
                     + gs(defActor, "clashPowerUp") - gs(defActor, "clashPowerDown");

    const atkEffective = initFlags.rollTotal + atkDiceMod + atkLvBonus;
    const defEffective = defRoll.total       + defDiceMod + defLvBonus;

    // ── 抗性 ─────────────────────────────────────────────────────────────
    const defRes      = ClashManager._getEffectiveResistances(defActor);
    const atkPhysMult = PHYS_CATS.includes(atkCategory)
      ? ClashManager._parseResistance(defRes[atkCategory]) : 1.0;
    const atkSinMult  = SIN_TYPES.includes(atkSinType)
      ? ClashManager._parseResistance(defActor.system?.egoResistances?.[atkSinType] ?? "x1.0") : 1.0;
    const defSinMult  = SIN_TYPES.includes(defSinType)
      ? ClashManager._parseResistance(atkActor.system?.egoResistances?.[defSinType] ?? "x1.0") : 1.0;

    // ── 守护/易损（stacks 层数，在抗性前加减骰数）各自适用 ───────────────
    const defFragile    = gs(defActor, "fragile");
    const defGuard      = gs(defActor, "guard");
    const atkFragile    = gs(atkActor, "fragile");
    const atkGuard      = gs(atkActor, "guard");
    // 易损/守护先修正骰数，再乘抗性
    const adjAtkEff     = Math.max(0, atkEffective + defFragile - defGuard);
    const adjDefEff     = Math.max(0, defEffective + atkFragile - atkGuard);

    const damageToDefActor = Math.max(0, Math.round(adjAtkEff * atkPhysMult * atkSinMult));
    const damageToAtkActor = Math.max(0, Math.round(adjDefEff * defSinMult));

    // ── 说明文字 ─────────────────────────────────────────────────────────
    const atkModStr = (() => {
      const parts = [];
      if (atkDiceMod !== 0) parts.push(`BUFF${atkDiceMod >= 0 ? "+" : ""}${atkDiceMod}`);
      if (atkLvBonus  > 0)  parts.push(`等级差+${atkLvBonus}`);
      return parts.length ? ` +${parts.join("+")}→${atkEffective}` : "";
    })();
    const defModStr = (() => {
      const parts = [];
      if (defDiceMod !== 0) parts.push(`BUFF${defDiceMod >= 0 ? "+" : ""}${defDiceMod}`);
      if (defLvBonus  > 0)  parts.push(`等级差+${defLvBonus}`);
      return parts.length ? ` +${parts.join("+")}→${defEffective}` : "";
    })();
    const defResNote = atkPhysMult !== 1.0 || atkSinMult !== 1.0
      ? `（${[
          atkPhysMult !== 1.0 ? `${ClashManager._catLabel(atkCategory)}${atkPhysMult > 1 ? "弱性" : "抗性"}×${atkPhysMult}` : "",
          atkSinMult  !== 1.0 ? `${ClashManager._sinLabel(atkSinType)} 抗性×${atkSinMult}` : "",
        ].filter(Boolean).join(" + ")}）` : "";
    const atkResNote = defSinMult !== 1.0
      ? `（${ClashManager._sinLabel(defSinType)} 抗性×${defSinMult}）` : "";

    const defFGStr = (() => {
      const p = [];
      if (defFragile > 0) p.push(`易损+${defFragile}`);
      if (defGuard   > 0) p.push(`守护-${defGuard}`);
      return p.length ? `，${p.join("，")}→${adjAtkEff}（抗性前）` : "";
    })();
    const atkFGStr = (() => {
      const p = [];
      if (atkFragile > 0) p.push(`易损+${atkFragile}`);
      if (atkGuard   > 0) p.push(`守护-${atkGuard}`);
      return p.length ? `，${p.join("，")}→${adjDefEff}（抗性前）` : "";
    })();

    const noteLines = [
      `${atkActor?.name ?? "?"}（攻击）：${initFlags.formula?.toUpperCase() ?? ""}=${initFlags.rollTotal}${atkModStr}`,
      `${defActor?.name ?? "?"}（反击）：${defFormula?.toUpperCase() ?? ""}=${defRoll.total}${defModStr}`,
      `${defActor?.name ?? "?"} 受到 ${damageToDefActor} 点伤害${defFGStr}${defResNote}`,
      `${atkActor?.name ?? "?"} 受到反击 ${damageToAtkActor} 点伤害${atkFGStr}${atkResNote}`,
    ];
    if (atkLvBonus > 0) noteLines.push(`（攻击方等级 ${atkLv} vs 防守方等级 ${defLv}，等级差 ${atkLv - defLv}，+${atkLvBonus}）`);
    if (defLvBonus > 0) noteLines.push(`（防守方等级 ${defLv} vs 攻击方等级 ${atkLv}，等级差 ${defLv - atkLv}，反击+${defLvBonus}）`);

    const atkItemImg = initFlags.itemImg ?? "";

    const content = `
      <div class="limbus-clash-card" data-clash-type="counter">
        ${ClashManager._chatHeader(defActor, "反击")}
        ${ClashManager._goldDivider()}
        <div style="display:flex;align-items:flex-start;gap:12px;margin:8px 0;">
          <div style="flex:1;text-align:center;">
            <div style="font-size:12px;color:#9A8462;margin-bottom:4px;">${atkActor?.name ?? "?"}</div>
            <img src="${atkItemImg}" style="width:50px;height:50px;object-fit:cover;display:block;margin:0 auto;" alt="">
            <div style="font-size:12px;color:#EBBD68;">${initFlags.formula?.toUpperCase() ?? ""}=${atkEffective}</div>
          </div>
          <div style="align-self:center;font-size:1.6rem;font-weight:bold;color:#E84444;padding:0 4px;">⚔️</div>
          <div style="flex:1;text-align:center;">
            <div style="font-size:12px;color:#9A8462;margin-bottom:4px;">${defActor?.name ?? "?"}</div>
            <img src="${defItem.img ?? ""}" style="width:50px;height:50px;object-fit:cover;display:block;margin:0 auto;" alt="${defItem.name}">
            <div style="font-size:12px;color:#EBBD68;">${defFormula?.toUpperCase() ?? ""}=${defEffective}</div>
          </div>
        </div>
        ${ClashManager._goldDivider()}
        <div style="font-size:.8rem;color:#9A8462;line-height:1.7;margin:4px 0 8px;">
          ${noteLines.map(n => `<div>${n}</div>`).join("")}
        </div>
        ${ClashManager._goldDivider()}
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <button class="clash-btn-apply-damage"
                  data-target-actor-id="${defActor?.id ?? ""}"
                  data-damage="${damageToDefActor}"
                  style="flex:1;min-width:80px;height:30px;background:#B84444;color:#fff;
                         border:none;cursor:pointer;font-size:.8rem;border-radius:2px;">
            ${defActor?.name ?? "?"} 承受 ${damageToDefActor}
          </button>
          <button class="clash-btn-apply-damage"
                  data-target-actor-id="${atkActor?.id ?? ""}"
                  data-damage="${damageToAtkActor}"
                  style="flex:1;min-width:80px;height:30px;background:#7A2222;color:#fff;
                         border:none;cursor:pointer;font-size:.8rem;border-radius:2px;">
            ${atkActor?.name ?? "?"} 承受反击 ${damageToAtkActor}
          </button>
        </div>
      </div>`;

    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: defActor }),
      content,
      flags: {
        limbusCompany_FVTT: {
          type:           "clash-counter",
          defActorId:     defActor?.id ?? "",
          atkActorId:     atkActor?.id ?? "",
          damageToDefActor,
          damageToAtkActor,
        },
      },
    });
  }

  /* ─── 直接防御（block）结算 ────────────────────────────────────────────── */

  /**
   * 防御（格挡）：防守方直接受伤，格挡骰数减少伤害。
   * 含 BUFF（强壮/忍耐/破绽）和攻防等级差值。
   * 最终伤害 = max(0, round(atkEffective × 抗性) − defEffective + 易损 - 守护)
   */
  static async _resolveDirectBlock(atkActor, defActor, initFlags, defItem, defRoll, defFormula) {
    const atkCategory = initFlags.category ?? "";
    const atkSinType  = initFlags.sinType  ?? "";
    const PHYS_CATS   = ["slash", "blunt", "pierce"];
    const SIN_TYPES   = ["wrath","lust","sloth","gluttony","gloom","pride","envy"];
    const gs = (actor, type) => ClashManager._getBuffVal(actor, type).stacks;
    const gi = (actor, type) => ClashManager._getBuffVal(actor, type).intensity;

    // ── 等级差（防御技能用 effDefLv 比较）────────────────────────────────
    const atkLv      = ClashManager._effAtkLv(atkActor);
    const defLv      = ClashManager._effDefLv(defActor);
    const atkLvBonus = Math.floor(Math.max(0, atkLv - defLv) / 3);
    const defLvBonus = Math.floor(Math.max(0, defLv - atkLv) / 3);

    // ── BUFF 修正 ─────────────────────────────────────────────────────────
    // 攻击方：强壮/虚弱 + 拼点威力
    const atkDiceMod = gs(atkActor, "strong") - gs(atkActor, "weak")
                     + gs(atkActor, "clashPowerUp") - gs(atkActor, "clashPowerDown");
    // 防守方：忍耐/破绽（格挡是守备技能）+ 拼点威力
    const defDiceMod = gs(defActor, "endure") - gs(defActor, "breach")
                     + gs(defActor, "clashPowerUp") - gs(defActor, "clashPowerDown");

    const atkEffective = initFlags.rollTotal + atkDiceMod + atkLvBonus;
    const defEffective = defRoll.total       + defDiceMod + defLvBonus;

    // ── 抗性 ─────────────────────────────────────────────────────────────
    const defRes      = ClashManager._getEffectiveResistances(defActor);
    const atkPhysMult = PHYS_CATS.includes(atkCategory)
      ? ClashManager._parseResistance(defRes[atkCategory]) : 1.0;
    const atkSinMult  = SIN_TYPES.includes(atkSinType)
      ? ClashManager._parseResistance(defActor.system?.egoResistances?.[atkSinType] ?? "x1.0") : 1.0;

    // ── 守护/易损（stacks 层数，在抗性前加减骰数）───────────────────────
    const fragile      = gs(defActor, "fragile");
    const guard        = gs(defActor, "guard");
    // 易损/守护先修正攻击方骰数，再乘抗性
    const adjustedAtk  = Math.max(0, atkEffective + fragile - guard);
    const rawDamage    = Math.round(adjustedAtk * atkPhysMult * atkSinMult);
    const finalDamage  = Math.max(0, rawDamage - defEffective);

    // ── 说明文字 ─────────────────────────────────────────────────────────
    const resNote = atkPhysMult !== 1.0 || atkSinMult !== 1.0
      ? `（${[
          atkPhysMult !== 1.0 ? `${ClashManager._catLabel(atkCategory)}${atkPhysMult > 1 ? "弱性" : "抗性"}×${atkPhysMult}` : "",
          atkSinMult  !== 1.0 ? `${ClashManager._sinLabel(atkSinType)} 抗性×${atkSinMult}` : "",
        ].filter(Boolean).join(" + ")}）` : "";

    const atkModStr = (() => {
      const parts = [];
      if (atkDiceMod !== 0) parts.push(`BUFF${atkDiceMod >= 0 ? "+" : ""}${atkDiceMod}`);
      if (atkLvBonus  > 0)  parts.push(`等级差+${atkLvBonus}`);
      return parts.length ? ` +${parts.join("+")}→${atkEffective}` : "";
    })();
    const defModStr = (() => {
      const parts = [];
      if (defDiceMod !== 0) parts.push(`忍耐/破绽${defDiceMod >= 0 ? "+" : ""}${defDiceMod}`);
      if (defLvBonus  > 0)  parts.push(`等级差+${defLvBonus}`);
      return parts.length ? ` +${parts.join("+")}→${defEffective}` : "";
    })();

    const fragileGuardStr = (() => {
      const parts = [];
      if (fragile > 0) parts.push(`易损+${fragile}`);
      if (guard   > 0) parts.push(`守护-${guard}`);
      return parts.length ? ` ${parts.join("，")}→${adjustedAtk}（抗性前）` : "";
    })();

    const notes = [
      `${atkActor?.name ?? "?"}：${initFlags.formula?.toUpperCase() ?? ""}=${initFlags.rollTotal}${atkModStr}${fragileGuardStr}`,
      `${defActor?.name ?? "?"} 格挡：${defFormula?.toUpperCase() ?? ""}=${defRoll.total}${defModStr}`,
      `伤害 ${adjustedAtk}${resNote} → ${rawDamage} − 格挡 ${defEffective} = ${finalDamage} 点`,
    ];
    if (atkLvBonus > 0) notes.push(`（攻击方等级 ${atkLv} vs 防守方等级 ${defLv}，等级差 ${atkLv - defLv}，+${atkLvBonus}）`);
    if (defLvBonus > 0) notes.push(`（防守方等级 ${defLv} vs 攻击方等级 ${atkLv}，等级差 ${defLv - atkLv}，格挡+${defLvBonus}）`);

    const atkItemImg = initFlags.itemImg ?? "";

    const content = `
      <div class="limbus-clash-card" data-clash-type="block">
        ${ClashManager._chatHeader(defActor, "防御（格挡）")}
        ${ClashManager._goldDivider()}
        <div style="display:flex;align-items:flex-start;gap:12px;margin:8px 0;">
          <div style="flex:1;text-align:center;">
            <div style="font-size:12px;color:#9A8462;margin-bottom:4px;">${atkActor?.name ?? "?"}</div>
            <img src="${atkItemImg}" style="width:50px;height:50px;object-fit:cover;display:block;margin:0 auto;" alt="">
            <div style="font-size:12px;color:#EBBD68;">${initFlags.formula?.toUpperCase() ?? ""}=${atkEffective}</div>
          </div>
          <div style="align-self:center;font-size:1.6rem;font-weight:bold;color:#6699CC;padding:0 4px;">🛡️</div>
          <div style="flex:1;text-align:center;">
            <div style="font-size:12px;color:#9A8462;margin-bottom:4px;">${defActor?.name ?? "?"}</div>
            <img src="${defItem.img ?? ""}" style="width:50px;height:50px;object-fit:cover;display:block;margin:0 auto;" alt="${defItem.name}">
            <div style="font-size:12px;color:#EBBD68;">${defFormula?.toUpperCase() ?? ""}=${defEffective}</div>
          </div>
        </div>
        ${ClashManager._goldDivider()}
        <div style="font-size:.8rem;color:#9A8462;line-height:1.7;margin:4px 0 8px;">
          ${notes.map(n => `<div>${n}</div>`).join("")}
          ${finalDamage === 0 ? `<div style="color:#6EE06E;font-weight:bold;">✓ 格挡完全抵消伤害！</div>` : ""}
        </div>
        ${ClashManager._goldDivider()}
        ${finalDamage > 0
          ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
               <button class="clash-btn-apply-damage"
                       data-target-actor-id="${defActor?.id ?? ""}"
                       data-damage="${finalDamage}"
                       style="width:48px;height:30px;background:#B84444;color:#fff;
                              border:none;cursor:pointer;font-size:.85rem;border-radius:2px;flex-shrink:0;">承受</button>
               <span style="font-size:.7rem;color:#6A5A48;">扣除 ${finalDamage} 点生命值</span>
             </div>`
          : `<div style="padding:4px 0;">
               <span style="font-size:.85rem;color:#6EE06E;font-weight:bold;">✓ 格挡成功，无伤害</span>
             </div>`}
      </div>`;

    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: defActor }),
      content,
      flags: {
        limbusCompany_FVTT: {
          type:          "clash-block",
          targetActorId: defActor?.id ?? "",
          damage:        finalDamage,
        },
      },
    });
  }

  /* ─── 反应系统 ─────────────────────────────────────────────────────────── */

  /**
   * 广播反应检查到所有客户端，同时在本客户端运行。
   * 由 GM 结算完成后调用。
   */
  static async _broadcastAndCheckReactions({ lastSkillUuid = null, attacker = null, defender = null } = {}) {
    const data = {
      lastSkillUuid,
      attackerId: attacker?.id ?? null,
      defenderId: defender?.id ?? null,
    };
    // 广播给其他所有客户端
    game.socket.emit("system.limbusCompany_FVTT", { type: "reactionCheck", data });
    // 本客户端（GM）也运行一次，仅处理 GM 自己拥有的 actor
    await ClashManager._checkAndOfferReactions({ lastSkillUuid, attacker, defender });
  }

  /**
   * 检查场上所有 Token 是否有"反应"类 Activity 可触发。
   * 只对当前用户拥有控制权的 actor 弹出确认框（防止多个客户端重复弹框）。
   * @param {{ lastSkillUuid?: string, attacker?: Actor|null, defender?: Actor|null }} ctx
   */
  static async _checkAndOfferReactions({ lastSkillUuid = null, attacker = null, defender = null } = {}) {
    if (!canvas?.tokens?.placeables) return;
    for (const token of canvas.tokens.placeables) {
      const actor = token.actor;
      if (!actor) continue;
      // 只处理当前用户拥有控制权的 actor，避免多端重复弹框
      if (!actor.isOwner) continue;
      for (const item of actor.items) {
        const activities = item.system?.activities ?? [];
        for (const act of activities) {
          if (act.trigger !== "反应") continue;
          const preconditions = Array.isArray(act.preconditions) ? act.preconditions
            : (act.precondition ? [act.precondition] : []);
          // AND 逻辑：所有前置条件均需满足
          const triggered = preconditions.length === 0
            || preconditions.every(pre =>
                ClashManager._evalReactionPrecond(pre, actor, attacker, defender, lastSkillUuid)
              );
          if (!triggered) continue;
          // 检查次数限制
          const limitOk = ClashManager._checkLimit(act, item, actor);
          if (!limitOk) continue;
          // 弹出询问框
          const confirmed = await Dialog.confirm({
            title: "反应触发",
            content: `<p><strong>${actor.name}</strong> 的 <strong>「${item.name}」</strong> 中的反应 <em>「${act.name}」</em> 可以触发。</p><p>是否使用？</p>`,
            defaultYes: false,
          });
          if (!confirmed) continue;
          // 执行效果
          for (const eff of (act.effects ?? [])) {
            await ClashManager._applyReactionEff(eff, item, actor, attacker, defender);
          }
          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div class="limbuscompany chat-clash">
              <strong>${actor.name}</strong> 触发反应「${act.name}」
              （来自 <strong>${item.name}</strong>）。
            </div>`,
          });
        }
      }
    }
  }

  /**
   * 判断单个前置条件是否满足。
   * @param {object} pre
   * @param {Actor} actor     装备物品的角色
   * @param {Actor|null} attacker
   * @param {Actor|null} defender
   * @param {string|null} lastSkillUuid  本次对抗使用的技能 UUID
   * @returns {boolean}
   */
  static _evalReactionPrecond(pre, actor, attacker, defender, lastSkillUuid) {
    const type = pre?.type ?? "hasBuff";
    // 确定被检查的目标角色（群体目标取攻/守方）
    const targetActor = (pre?.target === "target" || pre?.target === "allEnemy" || pre?.target === "allEnemyOther")
      ? (defender ?? attacker)
      : actor;

    if (type === "hasBuff") {
      if (!targetActor || !pre.buff) return false;
      const buffs  = targetActor.system?.buffs ?? [];
      const found  = buffs.find(b => b.type === pre.buff || b.name === pre.buff);
      if (!found) return false;
      if ((pre.intensity ?? 0) > 0 && (found.intensity ?? 0) < pre.intensity) return false;
      if ((pre.stacks   ?? 0) > 0 && (found.stacks   ?? 0) < pre.stacks)   return false;
      return true;
    }

    if (type === "perN") {
      if (!targetActor || !pre.buff) return false;
      const buffs = targetActor.system?.buffs ?? [];
      const found = buffs.find(b => b.type === pre.buff || b.name === pre.buff);
      if (!found) return false;
      const n = pre.stacks ?? 1;
      return n > 0 && ((found.stacks ?? 0) % n === 0);
    }

    if (type === "buffCompare") {
      if (!targetActor || !pre.buff) return false;
      const buffs = targetActor.system?.buffs ?? [];
      const found = buffs.find(b => b.type === pre.buff || b.name === pre.buff);
      const have  = (pre.compareDim ?? "stacks") === "intensity"
        ? (found?.intensity ?? 0) : (found?.stacks ?? 0);
      return ClashManager._cmp(have, pre.comparison ?? "eq", pre.stacks ?? 0);
    }

    if (type === "baseAttr") {
      if (!targetActor) return false;
      const curVal = ClashManager._getAttrVal(targetActor, pre.attrType ?? "hp");
      const threshold = ClashManager._parseThreshold(pre.attrValue ?? "0", targetActor, pre.attrType ?? "hp");
      return ClashManager._cmp(curVal, pre.comparison ?? "lt", threshold);
    }

    if (type === "useSkill") {
      if (!pre.skillUuid || !lastSkillUuid) return false;
      return pre.skillUuid.trim() === lastSkillUuid.trim();
    }

    return false;
  }

  /** 获取角色属性当前值（hp/sanity/ap） */
  static _getAttrVal(actor, attrType) {
    if (attrType === "hp")     return actor.system?.hp?.value     ?? 0;
    if (attrType === "sanity") return actor.system?.sanity?.value ?? 0;
    if (attrType === "ap")     return actor.system?.ap?.value     ?? 0;
    return 0;
  }

  /** 将 "50" 或 "5%" 解析为绝对值 */
  static _parseThreshold(val, actor, attrType) {
    const str = String(val ?? "0").trim();
    if (str.endsWith("%")) {
      const pct = parseFloat(str) / 100;
      let max = 0;
      if (attrType === "hp")     max = actor.system?.hp?.max     ?? 100;
      if (attrType === "sanity") max = 95;
      if (attrType === "ap")     max = actor.system?.ap?.max     ?? 3;
      return Math.round(pct * max);
    }
    return parseFloat(str) || 0;
  }

  /** 比较两个数值 */
  static _cmp(a, op, b) {
    switch (op) {
      case "gt":  return a > b;
      case "gte": return a >= b;
      case "lt":  return a < b;
      case "lte": return a <= b;
      case "eq":  return a === b;
    }
    return false;
  }

  /** 检查 Activity 次数限制（不计数，仅检查） */
  static _checkLimit(act, item, actor) {
    if (!act.limit || act.limit.type === "unlimited") return true;
    // 简单起见：如果没有火次计数存储，始终允许（计数由 _applyActivities 管理）
    return true;
  }

  /**
   * 检查某物品的指定触发时机是否全部被次数限制锁定。
   * 返回 { blocked: boolean, reasons: string[] }
   * blocked=true 意味着该 trigger 下所有 activity 均已达到限制，本次使用无任何效果。
   */
  static _checkAllActivitiesBlocked(item, trigger, actor) {
    const acts = (item?.system?.activities ?? []).filter(a => a?.trigger === trigger);
    if (acts.length === 0) return { blocked: false, reasons: [] };

    const reasons = [];
    let blockedCount = 0;

    for (const act of acts) {
      const limitType  = act.limit?.type;
      const limitCount = act.limit?.count ?? 0;
      if (!limitType || limitType === "unlimited" || limitCount <= 0) continue;

      const actKey = `${item.id}_${act.name ?? trigger}`;
      if (limitType === "perTurn") {
        const counts = actor?.getFlag?.("limbusCompany_FVTT", "turnFireCounts") ?? {};
        if ((counts[actKey] ?? 0) >= limitCount) {
          blockedCount++;
          reasons.push(`【${act.name || trigger}】本回合已使用 ${limitCount} 次`);
        }
      } else if (limitType === "perEncounter") {
        const counts = actor?.getFlag?.("limbusCompany_FVTT", "encounterFireCounts") ?? {};
        if ((counts[actKey] ?? 0) >= limitCount) {
          blockedCount++;
          reasons.push(`【${act.name || trigger}】本场对局已使用 ${limitCount} 次`);
        }
      }
    }

    // 所有有限制的 activity 都被锁定，且没有无限制的 activity
    const hasUnlimited = acts.some(a => !a.limit?.type || a.limit.type === "unlimited" || !(a.limit?.count > 0));
    const blocked = !hasUnlimited && blockedCount === acts.length;
    return { blocked, reasons };
  }

  /**
   * 执行反应效果（useSkill 型：以该技能发起对抗，无需消耗行动值）
   * 其余效果类型通过创建临时活动条目走 _applyActivities 路径。
   */
  static async _applyReactionEff(eff, item, actor, attacker, defender) {
    const type = eff?.type ?? "";
    if (type === "useSkill") {
      let skillItem = null;
      if (eff?.skillRef === "equipped") {
        // 从拥有者已装备技能中查找
        const slot  = eff.skillSlot ?? "basic";
        const level = Math.max(1, parseInt(eff.skillLevel) || 1);
        if (slot === "defense") {
          const defId = actor.system?.skills?.defense;
          skillItem = defId ? actor.items.get(defId) : null;
        } else {
          const basicSlots = actor.system?.skills?.basic ?? [];
          const slotId = basicSlots[level - 1];
          skillItem = slotId ? actor.items.get(slotId) : null;
        }
        if (!skillItem) {
          const label = slot === "defense" ? "守备技能" : `Lv.${level} 基础技能`;
          ui.notifications.warn(`反应：未找到已装备的${label}`);
          return;
        }
      } else {
        const skillUuid = eff?.skillUuid ?? "";
        if (!skillUuid) return;
        skillItem = await fromUuid(skillUuid).catch(() => null);
        if (!skillItem) {
          ui.notifications.warn(`反应：找不到技能 ${skillUuid}`);
          return;
        }
      }
      // 守备技能：触发其"使用时" Activities，不发起对抗
      if (skillItem.system?.type === "defense") {
        await ClashManager._applyActivities(skillItem, "使用时", {
          owner: actor, atkActor: actor, defActor: defender ?? attacker,
          _fireCounts: {}, _actMsgs: [],
        });
        return;
      }
      // 非守备技能：发起对抗（反应触发，不消耗行动值：临时置 AP 为足够大再还原）
      const curAP = actor.system?.ap?.value ?? 0;
      if (curAP <= 0) await actor.update({ "system.ap.value": 1 });
      await ClashManager.showInitiateDialog(actor, skillItem, -2);
      return;
    }
    // 其他效果类型：构造只含此效果的临时活动，走 _applyActivities 路径
    const fakeItem = {
      id: item.id,
      name: item.name,
      img:  item.img,
      system: {
        activities: [{
          id: foundry.utils.randomID(),
          name: "反应效果",
          trigger: "__reaction__",
          preconditions: [],
          costs: [],
          effects: [eff],
          limit: { type: "unlimited", count: 0 },
        }],
      },
    };
    await ClashManager._applyActivities(fakeItem, "__reaction__", {
      owner: actor, atkActor: actor, defActor: defender ?? attacker,
      _fireCounts: {}, _actMsgs: [],
    });
  }

  /* ─── Socket 消息处理：由主入口统一注册单一监听器后调用 ─────────────── */

  /** 处理 socket 消息（clashResolve / activityActivate / reactionCheck） */
  static async handleSocketMsg(msg) {
    // 反应检查广播：所有客户端均处理，各自只弹出自己拥有控制权的 actor 的对话框
    if (msg.type === "reactionCheck") {
      const { lastSkillUuid, attackerId, defenderId } = msg.data ?? {};
      const attacker = attackerId ? game.actors.get(attackerId) : null;
      const defender = defenderId ? game.actors.get(defenderId) : null;
      await ClashManager._checkAndOfferReactions({ lastSkillUuid, attacker, defender });
      return;
    }

    // 玩家无权限时委托 GM 执行任意文档更新（跨所有权 Actor/Item 写入）
    if (msg.type === "gmDocUpdate") {
      if (!game.user.isGM) return;
      try {
        const doc = msg.uuid ? await fromUuid(msg.uuid) : null;
        if (doc) await doc.update(msg.data);
      } catch (err) {
        console.error("[ClashManager] gmDocUpdate 失败:", err);
      }
      return;
    }

    // 玩家委托GM执行物品 [使用时] Activity（群体目标需GM权限更新其他Actor）
    if (msg.type === "activityActivate") {
      if (!game.user.isGM) return;
      const actor = game.actors.get(msg.actorId);
      const item  = actor?.items.get(msg.itemId);
      if (!actor || !item) return;
      await ClashManager._applyActivities(item, msg.trigger ?? "使用时", {
        owner: actor, atkActor: actor, defActor: null, _fireCounts: {},
      });
      return;
    }

    if (msg.type !== "clashResolve") return;
    console.log("[ClashManager] 收到 clashResolve socket 消息 | isGM:", game.user.isGM, "| data:", msg.data);
    if (!game.user.isGM) return;
    try {
      const { defActorId, defItemId, defRollTotal, defFormula, initMsgId, initFlags, slotIdx } = msg.data;
      const defActor = game.actors.get(defActorId);
      const defItem  = defActor?.items.get(defItemId);
      if (!defActor || !defItem) {
        console.error("[ClashManager] clashResolve: 找不到 defActor/defItem", { defActorId, defItemId });
        ui.notifications?.error("对抗结算出错：找不到角色或技能，请检查控制台");
        return;
      }
      console.log("[ClashManager] GM 开始执行对抗结算 | defActor:", defActor.name, "| defItem:", defItem.name);
      // 重建只含 total 的 roll 代理对象（结算流程仅使用 .total）
      const defRoll = { total: defRollTotal };
      await ClashManager._sendResponseAndResolve(
        defActor, defItem, defRoll, defFormula, initMsgId, initFlags, slotIdx ?? -1
      );
    } catch (err) {
      console.error("[ClashManager] clashResolve 结算出错:", err);
      ui.notifications?.error("对抗结算出错，请检查控制台日志");
    }
  }
}
