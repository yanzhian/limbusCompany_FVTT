/**
 * clash.mjs — 对抗流程管理器
 * 全流程：发起对抗 → 聊天框 → 进行对抗确认 → 进行对抗 → 拼点结算 → 承受
 */

import { SinResourceHUD } from "./sin-resource-hud.mjs";
import { ClashTotalFX }   from "./clash-total-fx.mjs";
import { ClashKnockback } from "./knockback.mjs";
import { ClashVFX }       from "./clash-vfx.mjs";
import {
  CustomBuffRegistry, resolveBuffHandler, FieldResourceRegistry,
  isTremorFamilyType, TREMOR_BASE_TYPE, TREMOR_DEPENDENT_TYPES,
} from "./custom-buffs.mjs";

export class ClashManager {

  /** 罪孽 → 技能边框图文件名前缀（见 _skillFrameIcon） */
  static SIN_FRAME_NAME = {
    wrath: "Wrath", lust: "Lust", sloth: "Sloth", gluttony: "Gluttony",
    gloom: "Gloom", pride: "Pride", envy: "Envy",
  };

  /**
   * 基础特殊类 BUFF：不存在"0层"或"0级"的这类 BUFF，_addBuff 会把传入的
   * 0 层数/0 强度自动订正为 1（见 _addBuff 内的判定）。
   * @type {Set<string>}
   */
  static ZERO_DEFAULT_BUFF_TYPES = new Set(["burn", "bleed", "rupture", "tremor", "sinking", "breathing"]);

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

  /**
   * 技能边框图路径：assets/icons/Skill/{罪孽首字母大写}_lv{等级}.webp。
   * 注意这些是【中空边框】而非技能图本身——技能自身的图用 item.img 垫在底层，
   * 边框叠在其上（基础技能为七边形框，EGO 为圆环框 E.G.O.webp）。
   * 目前由快捷 HUD 使用；拼点选择器改用方形图 + 罪孽色描边，不走边框图。
   * @param {Item|null} item
   * @returns {string} 图片路径；item 为空时返回空串
   */
  /**
   * 找出某个角色对应的「骰主」用户——DiceSoNice 以该用户的骰子皮肤渲染，
   * 这样对抗时能一眼分清哪堆骰子是谁的。
   * 优先：把该角色设为「所选角色」的玩家 → 拥有该角色 OWNER 权限的玩家 → 当前用户。
   */
  static _diceUserFor(actor) {
    if (!actor) return game.user;
    const users  = game.users?.contents ?? [];
    const byChar = users.find(u => !u.isGM && u.character?.id === actor.id);
    if (byChar) return byChar;
    const owner  = users.find(u => !u.isGM && actor.testUserPermission?.(u, "OWNER"));
    return owner ?? game.user;
  }

  /**
   * 同时播放多组骰子动画，各自使用其拥有者的 DSN 皮肤。
   * @param {{roll: Roll, actor: Actor}[]} entries
   */
  static async _showDice(entries = []) {
    if (!game.dice3d) return;
    const jobs = entries
      .filter(e => e?.roll)
      .map(e => game.dice3d
        .showForRoll(e.roll, ClashManager._diceUserFor(e.actor), true, null, false)
        .catch(() => {}));
    if (jobs.length) await Promise.all(jobs);
  }

  /**
   * 组装 TOTAL 演出用的分段。第一项是骰值（骰子动画停下时定格的数），
   * 其余依次为手动加值与各 BUFF 修正，累加结果与 _computeResolution 的
   * 有效骰数完全一致（atkTotal + diceMod + lvBonus / defTotal + diceMod + pwrMod + lvBonus）。
   *
   * @param {object} o
   * @param {Actor}  o.actor      本方角色
   * @param {Actor}  o.opponent   对方角色（算等级差）
   * @param {number} o.rollTotal  掷骰总点数（含手动加值）
   * @param {number} o.bonus      手动加值
   * @param {string} o.baseFormula 骰子公式（作为骰值那条的名字，如 "3D6"）
   * @param {string} o.category   本次使用技能的分类
   * @param {boolean} o.isDefender 是否为防守方
   * @returns {{name:string, value:number}[]}
   */
  static _buildTotalParts({ actor, opponent, rollTotal = 0, bonus = 0, baseFormula = "",
                            category = "", isDefender = false, includeClashPower = true }) {
    const gs = (a, t) => ClashManager._getBuffVal(a, t).stacks;
    const parts = [{ name: baseFormula || "骰值", value: (rollTotal ?? 0) - (bonus ?? 0) }];
    if (bonus) parts.push({ name: "加值", value: bonus });
    if (!actor) return parts;

    const ALL_DEF_CATS = new Set(["dodge", "block", "counter", "clashBlock", "clashCounter"]);
    const DEF_LEVEL_CATS = new Set(["dodge", "block", "clashBlock"]);
    const isDefCat = isDefender && ALL_DEF_CATS.has(category);

    // 骰数类 BUFF：守备技能看忍耐/破绽，其余看强壮/虚弱
    const push = (label, v) => { if (v) parts.push({ name: label, value: v }); };
    if (isDefCat) {
      push("忍耐", gs(actor, "endure"));
      push("破绽", -gs(actor, "breach"));
    } else {
      push("强壮", gs(actor, "strong"));
      push("虚弱", -gs(actor, "weak"));
    }
    // 承受（单方面攻击）不拼点，拼点威力↑↓不计入
    if (includeClashPower) push("拼点威力", gs(actor, "clashPowerUp") - gs(actor, "clashPowerDown"));

    // 等级差：每 3 级 +1，仅高的一方获得
    if (opponent) {
      const myLv = (isDefender && DEF_LEVEL_CATS.has(category))
        ? ClashManager._effDefLv(actor) : ClashManager._effAtkLv(actor);
      const oppCat = isDefender ? "" : category;
      const oppLv  = (!isDefender && DEF_LEVEL_CATS.has(oppCat))
        ? ClashManager._effDefLv(opponent) : ClashManager._effAtkLv(opponent);
      push("等级差", Math.floor(Math.max(0, myLv - oppLv) / 3));
    }
    return parts;
  }

  /**
   * 与 _showDice 相同，但不等待——返回每一项各自的 Promise，
   * 供 TOTAL 演出把"数字定格"对齐到各自骰子动画结束的那一刻。
   */
  static _showDiceEach(entries = []) {
    if (!game.dice3d) return entries.map(() => Promise.resolve());
    return entries.map(e => e?.roll
      ? game.dice3d.showForRoll(e.roll, ClashManager._diceUserFor(e.actor), true, null, false).catch(() => {})
      : Promise.resolve());
  }

  static _skillFrameIcon(item) {
    if (!item) return "";
    const base = "systems/limbusCompany_FVTT/assets/icons/Skill/";
    const sys  = item.system ?? {};
    if (sys.type === "ego") return `${base}E.G.O.webp`;
    const sinName = ClashManager.SIN_FRAME_NAME[sys.sinType];
    const lv      = Math.max(1, Math.min(3, sys.level ?? 1));
    return sinName ? `${base}${sinName}_lv${lv}.webp` : `${base}Normalsin.webp`;
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

  /**
   * 广播【流血/烧伤/破裂/沉沦/震颤】跳动伤害事件给所有已注册的场地资源。
   * 由 _processBleed / triggerBuff 效果分支 / 承伤结算中破裂沉沦震颤三处调用。
   * @param {string} buffType        跳动的状态 type（bleed/burn/rupture/sinking/tremor）
   * @param {number} intensity       该状态的强度
   * @param {number} [stacksConsumed=1] 本次消耗的层数
   */
  static async _tickFieldResources(buffType, intensity, stacksConsumed = 1) {
    for (const [name, def] of FieldResourceRegistry) {
      if (typeof def.onStatusTick !== "function") continue;
      // 只有已激活的场地资源才响应自动跳动事件——避免"血宴"这类靠背景标签
      // （triggerBackgroundTags，在 combatStart 时判定是否有对应背景在场）才
      // 出现的场地资源，因为任何角色触发一次流血/烧伤等跳动伤害就被无条件
      // 唤醒。显式的 Activity 效果「公用场地」仍可正常直接激活/操作，不受影响。
      if (!SinResourceHUD.isFieldResourceActive(name)) continue;
      try {
        await def.onStatusTick({
          buffType, intensity, stacksConsumed, name,
          addStacks: (delta) => SinResourceHUD.addFieldResourceStacks(name, delta),
        });
      } catch (err) {
        console.error(`ClashManager: 场地资源【${name}】onStatusTick 执行出错`, err);
      }
    }
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
    const before = ClashManager._getBuff(actor, type);
    const notify = async () => {
      const after = ClashManager._getBuff(actor, type);
      await ClashManager._dispatchBuffChange(actor, "onBuffLost", {
        type, amount, stacks: after?.stacks ?? 0, removed: !after,
      });
    };
    if (typeof actor.reduceBuffStacks === "function") {
      const r = await actor.reduceBuffStacks(type, amount);
      if (before) await notify();
      return r;
    }
    // 兜底：直接操作 buffs 数组
    const buffs = [...(actor.system?.buffs ?? [])];
    const idx   = buffs.findIndex(b => b.type === type);
    if (idx === -1) return;
    const next = Math.max(0, (buffs[idx].stacks ?? 1) - amount);
    const keepAtZero = resolveBuffHandler(buffs[idx])?.keepAtZero ?? false;
    if (next <= 0 && !keepAtZero) buffs.splice(idx, 1);
    else                          buffs[idx] = { ...buffs[idx], stacks: next };
    await ClashManager._safeDocUpdate(actor, { "system.buffs": buffs });
    await notify();
  }

  /**
   * 减少 BUFF 强度（如"每消耗4级【呼吸法】"），强度和层数都归零才自动移除。
   * 优先调用 actor.reduceBuffIntensity（如已定义），否则直接写 system.buffs。
   */
  static async _reduceBuffIntensity(actor, type, amount = 1) {
    if (!actor) return;
    if (typeof actor.reduceBuffIntensity === "function") {
      return actor.reduceBuffIntensity(type, amount);
    }
    // 兜底：直接操作 buffs 数组
    const buffs = [...(actor.system?.buffs ?? [])];
    const idx   = buffs.findIndex(b => b.type === type);
    if (idx === -1) return;
    const next   = Math.max(0, (buffs[idx].intensity ?? 0) - amount);
    const stacks = buffs[idx].stacks ?? 0;
    const keepAtZero = resolveBuffHandler(buffs[idx])?.keepAtZero ?? false;
    if (next <= 0 && stacks <= 0 && !keepAtZero) buffs.splice(idx, 1);
    else                                         buffs[idx] = { ...buffs[idx], intensity: next };
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
  /**
   * 只在一次对抗的第一次交锋结算的效果类型。
   * 它们直接改写技能物品自身（会被持久化），连击时重复执行就会累积。
   */
  static COMBO_ONCE_EFFECTS = new Set([
    "diceAdj", "diceFacesAdj", "baseValue", "weightAdj", "diceTypeChg",
  ]);

  static async _applyActivitiesAndEquip(item, trigger, ctx) {
    await ClashManager._applyActivities(item, trigger, ctx);
    const owner = ctx.owner ?? null;
    if (!owner) return;
    for (const eq of ClashManager._getEquippedItems(owner)) {
      await ClashManager._applyActivities(eq, trigger, ctx);
    }

    // ── 自定义 BUFF onHit 钩子（如【故土剑术】）─────────────────────────
    // 每次 [命中时] 结算（无论走哪条对抗路径，均汇聚于本方法）触发一次，
    // 按本次实际使用的 item 分类（斩击/打击/突刺）判断是否命中该 BUFF 的条件。
    // ClashManager 内部方法不直接暴露给 custom-buffs.mjs（避免循环 import），
    // 需要的操作一律通过 ctx 回调函数下发。
    if (trigger === "命中时") {
      for (const buff of foundry.utils.deepClone(owner.system?.buffs ?? [])) {
        const handler = resolveBuffHandler(buff);
        if (typeof handler?.onHit !== "function") continue;
        const hitMsg = await handler.onHit(owner, buff, {
          item,
          category: item?.system?.category ?? "",
          target:   ctx.other ?? null,
          addBuff:  (type, intensity, stacks, whenAdded) => ClashManager._addBuff(owner, type, intensity, stacks, whenAdded),
          // 给指定角色（通常是命中目标）加 BUFF，走 _safeDocUpdate 以支持跨所有权写入
          addBuffTo: (targetActor, type, intensity, stacks, whenAdded) =>
            ClashManager._addBuff(targetActor, type, intensity, stacks, whenAdded),
          getBuff:  (type) => ClashManager._getBuff(owner, type),
          // category：物理分类（slash/blunt/pierce）或空；sinType：罪孽类型或空。
          // 两者可同时给出，分别按物理抗性与罪孽抗性结算。
          dealDamage: async (targetActor, category, formula, sinType = "") => {
            if (!targetActor) return 0;
            const roll = new Roll(formula);
            await roll.evaluate();
            const physMult = category
              ? ClashManager._parseResistance(ClashManager._getEffectiveResistances(targetActor)[category] ?? "x1.0")
              : 1.0;
            const sinMult = sinType
              ? ClashManager._parseResistance(targetActor.system?.egoResistances?.[sinType] ?? "x1.0")
              : 1.0;
            const dmg = Math.max(0, Math.round(roll.total * physMult * sinMult));
            await ClashManager._applyAndSendTake(targetActor, dmg, { attacker: owner, category, sinType });
            return dmg;
          },
        });
        // 钩子返回的文本并入本次结算的活动消息
        if (typeof hitMsg === "string" && hitMsg) {
          (ctx._actMsgs ??= []).push({
            trigger: "命中时", itemName: handler.label ?? buff.name ?? buff.type, msgs: [hitMsg],
          });
        }
      }
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

    // 基础特殊类 BUFF（烧伤/流血/破裂/震颤/沉沦/呼吸法；充能是例外，不算在内）：不存在"0层"或"0级"的这类 BUFF，
    // 传入的层数/强度若为 0 一律视为 1（无论是新建还是叠加到已有 BUFF 上）。
    // 增益/减益（strong/weak/atkLevelUp 等）与自定义注册 BUFF 不受此规则影响。
    if (ClashManager.ZERO_DEFAULT_BUFF_TYPES.has(type)) {
      if (!(stacks    > 0)) stacks    = 1;
      if (!(intensity > 0)) intensity = 1;
    }

    // 【振幅转换】【振幅纠缠】依附于震颤存在：目标没有任何震颤族时无法施加
    if (TREMOR_DEPENDENT_TYPES.includes(type)) {
      if (ClashManager._tremorFamilyBuffs(actor).length === 0) return;
      // 两者互斥：施加其中一个时移除另一个
      const other = TREMOR_DEPENDENT_TYPES.find(t => t !== type);
      if ((actor.system?.buffs ?? []).some(b => b.type === other)) {
        await ClashManager._removeBuff(actor, other, { _internal: true });
      }
    }

    // 【振幅转换】：持有期间，任何震颤族的施加都并入当前那一种，而不是新起一条
    // ——保证震颤族始终只存在一种。合并口径与多条转换一致：层数、强度分别求和。
    // 合并后的类型：施加的是【特殊震颤】则转为该类型；施加的是普通【震颤】则
    // 保持现有类型（即普通震颤被现有的特殊震颤吸收）。
    // 持有【振幅纠缠】时并列存在，不做转换。
    if (isTremorFamilyType(type)) {
      const cur = actor.system?.buffs ?? [];
      const hasConvert  = cur.some(b => b.type === "amplitudeConvert");
      const hasEntangle = cur.some(b => b.type === "amplitudeEntangle");
      if (hasConvert && !hasEntangle) {
        const family  = ClashManager._tremorFamilyBuffs(actor);
        const existing = family.find(b => b.type !== TREMOR_BASE_TYPE) ?? family[0];
        const newType  = type !== TREMOR_BASE_TYPE ? type : existing?.type;
        if (newType && await ClashManager._convertTremorFamily(actor, newType, { stacks, intensity })) {
          await ClashManager._dispatchBuffChange(actor, "onBuffGained", { type: newType, intensity, stacks });
          return;
        }
      }
    }

    const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);

    // 查询自定义 BUFF 处理器（maxStacks / refreshOnGain）
    const customHandler = CustomBuffRegistry.get(type);
    const maxStacks     = customHandler?.maxStacks ?? Infinity;
    const refreshOnGain = customHandler?.refreshOnGain ?? false;

    // maxGainPerRound：本回合累计可获得的层数上限（与 maxStacks 无关，后者是同时存在的上限）。
    // 已获得量记在 actor flag 上，每轮结束时清空。
    const maxGainPerRound = customHandler?.maxGainPerRound ?? Infinity;
    let   gainFlagUpdate  = null;
    if (Number.isFinite(maxGainPerRound) && stacks > 0) {
      const gainMap = foundry.utils.deepClone(
        actor.getFlag?.("limbusCompany_FVTT", "buffRoundGain") ?? {}
      );
      const gained  = gainMap[type] ?? 0;
      const allowed = Math.max(0, maxGainPerRound - gained);
      if (allowed <= 0) return;              // 本回合该 BUFF 的获得额度已用尽
      stacks = Math.min(stacks, allowed);
      gainMap[type]  = gained + stacks;
      gainFlagUpdate = { "flags.limbusCompany_FVTT.buffRoundGain": gainMap };
    }

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
    await ClashManager._safeDocUpdate(actor, { "system.buffs": buffs, ...(gainFlagUpdate ?? {}) });
    await ClashManager._dispatchBuffChange(actor, "onBuffGained", { type, intensity, stacks });
  }

  /**
   * 跳动伤害（烧伤/流血/破裂等非对抗路径）的伤害修正钩子。
   * 与 _applyAndSendTake 里的 modifyIncomingDamage 是同一个钩子，只是这里没有攻击者，
   * 并且带上 source 供 BUFF 区分伤害来源。
   * @param {Actor}  actor
   * @param {number} damage
   * @param {string} source "burn" | "bleed" | "rupture" | …
   * @returns {{ damage: number, hpFloor: number, notes: string[] }}
   *          hpFloor：本次伤害不得把 HP 压到该值以下（0 = 无下限保护）
   */
  static applyTickDamageMods(actor, damage, source) {
    let dmg = damage, hpFloor = 0;
    const notes = [];
    for (const buff of foundry.utils.deepClone(actor?.system?.buffs ?? [])) {
      const handler = resolveBuffHandler(buff);
      if (typeof handler?.modifyIncomingDamage !== "function") continue;
      const result = handler.modifyIncomingDamage(actor, buff, { damage: dmg, attacker: null, source });
      if (!result || typeof result !== "object") continue;
      if (typeof result.damage  === "number") dmg     = result.damage;
      if (typeof result.hpFloor === "number") hpFloor = Math.max(hpFloor, result.hpFloor);
      if (result.note) notes.push(result.note);
    }
    return { damage: Math.max(0, dmg), hpFloor, notes };
  }

  /**
   * 套用跳动伤害的生命值下限保护：伤害不得把 HP 压到 floor 以下，
   * 但若 HP 本就低于 floor 也不会被"治疗"回去。
   */
  static applyHpFloor(oldHp, newHp, floor = 0) {
    if (!(floor > 0)) return Math.max(0, newHp);
    return Math.max(0, Math.max(newHp, Math.min(oldHp, floor)));
  }

  /* ─── 震颤族 / 震颤引爆 ─────────────────────────────────────────────── */

  /** 取角色身上全部还有层数的震颤族 BUFF（普通震颤 + 特殊震颤） */
  static _tremorFamilyBuffs(actor) {
    return (actor?.system?.buffs ?? []).filter(
      b => isTremorFamilyType(b.type) && (b.stacks ?? 0) > 0 && b.whenAdded !== "下回合"
    );
  }

  /**
   * 【振幅转换】：把角色身上现有的震颤族整体改写为 newType，强度与层数原样保留。
   * 已有多条时合并为一条（层数与强度分别取和），保证转换后震颤族只剩一种。
   * @returns {boolean} 是否发生了转换
   */
  static async _convertTremorFamily(actor, newType, extra = { stacks: 0, intensity: 0 }) {
    const buffs  = foundry.utils.deepClone(actor?.system?.buffs ?? []);
    const idxs   = buffs.map((b, i) => (isTremorFamilyType(b.type) && b.whenAdded !== "下回合") ? i : -1)
                        .filter(i => i >= 0);
    if (idxs.length === 0) return false;

    // 本次新施加的那一份也并进来（层数与强度分别求和）
    let stacks = extra?.stacks ?? 0, intensity = extra?.intensity ?? 0;
    for (const i of idxs) {
      stacks    += buffs[i].stacks    ?? 0;
      intensity += buffs[i].intensity ?? 0;
    }
    // 从后往前删，避免下标错位
    for (const i of [...idxs].reverse()) buffs.splice(i, 1);

    const iconBase = "systems/limbusCompany_FVTT/assets/icons/Buff_icon/";
    const label    = ClashManager._buffLabel(newType);
    buffs.push({
      id:        foundry.utils.randomID(),
      type:      newType,
      name:      label,
      icon:      `${iconBase}Custom_buffs/${label}.webp`,
      intensity,
      stacks,
      whenAdded: "本回合",
    });
    await ClashManager._safeDocUpdate(actor, { "system.buffs": buffs });
    return true;
  }

  /**
   * 震颤族全部消失时，连带移除依附其存在的 BUFF（【振幅转换】【振幅纠缠】）。
   * 每次引爆结束、以及回合结算后调用。
   */
  static async _cleanupTremorDependents(actor) {
    if (!actor) return;
    if (ClashManager._tremorFamilyBuffs(actor).length > 0) return;
    const buffs = actor.system?.buffs ?? [];
    if (!buffs.some(b => TREMOR_DEPENDENT_TYPES.includes(b.type))) return;
    await ClashManager._safeDocUpdate(actor, {
      "system.buffs": buffs.filter(b => !TREMOR_DEPENDENT_TYPES.includes(b.type)),
    });
  }

  /**
   * 【振幅纠缠】下的同步：所有【特殊震颤】的层数与强度跟随普通【震颤】。
   * 任何一次震颤族的增减之后调用；普通【震颤】不存在时不做任何事。
   */
  static async _syncTremorFamily(actor) {
    if (!actor) return;
    const cur = actor.system?.buffs ?? [];
    if (!cur.some(b => b.type === "amplitudeEntangle")) return;

    const base = cur.find(b => b.type === TREMOR_BASE_TYPE && b.whenAdded !== "下回合");
    if (!base) return;

    const buffs = foundry.utils.deepClone(cur);
    let changed = false;
    for (let i = buffs.length - 1; i >= 0; i--) {
      const b = buffs[i];
      if (b.type === TREMOR_BASE_TYPE || !isTremorFamilyType(b.type)) continue;
      if (b.whenAdded === "下回合") continue;
      if ((base.stacks ?? 0) <= 0) { buffs.splice(i, 1); changed = true; continue; }
      if (b.stacks !== base.stacks || b.intensity !== base.intensity) {
        b.stacks    = base.stacks;
        b.intensity = base.intensity;
        changed = true;
      }
    }
    if (changed) await ClashManager._safeDocUpdate(actor, { "system.buffs": buffs });
  }

  /**
   * 【获得/失去 BUFF】事件派发。
   * 角色身上**所有**注册 BUFF 的 onBuffGained / onBuffLost 都会收到通知
   * （不只是变化的那个），因此可以写"每当获得【烧伤】时…"这类联动。
   *
   *   onBuffGained(actor, buff, ctx) / onBuffLost(actor, buff, ctx)
   *   ctx = { type, intensity, stacks, removed }   // buff 是持有钩子的那一条
   *
   * _internal=true 的调用（同步/连带清理等系统自身发起的变动）不再派发，避免递归。
   */
  static async _dispatchBuffChange(actor, event, ctx) {
    if (!actor || ctx?._internal) return;
    for (const buff of foundry.utils.deepClone(actor.system?.buffs ?? [])) {
      const handler = resolveBuffHandler(buff);
      const fn = handler?.[event];
      if (typeof fn !== "function") continue;
      try {
        await fn(actor, buff, ctx);
      } catch (err) {
        console.error(`ClashManager: BUFF【${buff.name ?? buff.type}】${event} 执行出错`, err);
      }
    }
  }

  /**
   * 【骰子结果修正】自定义 BUFF 钩子。
   * 与 modifySpeedRoll（只管速度骰）互补，这里管的是拼点骰/防守骰的最终点数。
   *
   *   modifyDiceRoll(actor, buff, ctx) → 返回数字（新的总点数）或 { total, note }
   *   ctx = { roll, total, item, isDefense }
   *
   * 注意：为了让下游（聊天卡、initFlags.rollTotal、公式重投比对）全部拿到同一个值，
   * 这里直接改写 Roll 实例内部的 _total —— Foundry 的 roll.total 就是它的 getter。
   * 骰面本身不变，因此 DiceSoNice 的动画不受影响。
   *
   * @returns {{ total: number, notes: string[] }}
   */
  static applyDiceRollMods(actor, roll, { item = null, isDefense = false } = {}) {
    const notes = [];
    if (!actor || !roll) return { total: roll?.total ?? 0, notes };
    let total = roll.total ?? 0;
    for (const buff of foundry.utils.deepClone(actor.system?.buffs ?? [])) {
      const handler = resolveBuffHandler(buff);
      if (typeof handler?.modifyDiceRoll !== "function") continue;
      const result = handler.modifyDiceRoll(actor, buff, { roll, total, item, isDefense });
      if (typeof result === "number") total = result;
      else if (result && typeof result === "object") {
        if (typeof result.total === "number") total = result.total;
        if (result.note) notes.push(result.note);
      }
    }
    total = Math.max(0, Math.round(total));
    if (total !== roll.total) roll._total = total;
    return { total, notes };
  }

  /**
   * 【震颤】回合结束衰减：层数 -1。
   * 与引爆同样只扣「主承担者」（优先普通【震颤】）那一条，其余特殊震颤由
   * _syncTremorFamily 跟随；归零后连带清掉【振幅转换】【振幅纠缠】。
   * @returns {number} 衰减后主承担者剩余层数；无震颤时返回 -1
   */
  static async decayTremorFamily(actor) {
    const family = ClashManager._tremorFamilyBuffs(actor);
    if (family.length === 0) return -1;
    const primary = family.find(b => b.type === TREMOR_BASE_TYPE)
      ?? family.reduce((a, b) => ((b.intensity ?? 0) > (a.intensity ?? 0) ? b : a));

    await ClashManager._reduceBuffStacks(actor, primary.type, 1);
    await ClashManager._syncTremorFamily(actor);
    await ClashManager._cleanupTremorDependents(actor);
    return Math.max(0, (primary.stacks ?? 1) - 1);
  }

  /**
   * 【震颤引爆】统一入口——原先散落在 ④效果、承受结算、角色卡、【防御姿态】里的
   * 四份实现全部收敛到这里。
   *
   * 规则：
   * - 基础效果（混乱阈值前移「震颤强度」% + 消耗 1 层）每次引爆只结算一次，
   *   由普通【震颤】负责；没有普通【震颤】时（如【振幅转换】把它改写成了特殊震颤），
   *   由当前这条震颤族顶替。
   * - 每条【特殊震颤】再各跑一次自己的 onSeismicBlast 额外效果。
   * - 【振幅纠缠】下特殊震颤的层数/强度同步于【震颤】，因此只需消耗【震颤】的层数，
   *   随后 _syncTremorFamily 会把其余几条一并压到相同数值（归零则一起消失）。
   *
   * @param {Actor}  target
   * @param {number} times    引爆次数
   * @param {object} opts     { attacker }
   * @returns {{ blasts: number, msgs: string[] }}
   */
  static async seismicBlast(target, times = 1, { attacker = null } = {}) {
    const msgs = [];
    if (!target) return { blasts: 0, msgs };
    let blasts = 0;
    ClashTotalFX.tremorBurst();

    for (let n = 0; n < Math.max(1, Math.round(times)); n++) {
      // 每轮都重新读取：上一轮已经改过层数
      const actor  = game.actors.get(target.id) ?? target;
      const family = ClashManager._tremorFamilyBuffs(actor);
      if (family.length === 0) break;

      // 基础效果的承担者：优先普通【震颤】，否则取强度最高的一条
      const primary = family.find(b => b.type === TREMOR_BASE_TYPE)
        ?? family.reduce((a, b) => ((b.intensity ?? 0) > (a.intensity ?? 0) ? b : a));

      // ── 基础效果：混乱阈值前移（每次引爆仅一次）──
      const shifted = primary.intensity ?? 0;
      if (shifted > 0) {
        await (target.triggerSeismicBlast
          ? target.triggerSeismicBlast(shifted)
          : ClashManager._safeDocUpdate(target, {
              "system.chaosThresholds": (target.system?.chaosThresholds ?? []).map(t => ({
                percent:   Math.min(100, t.percent + shifted),
                triggered: t.triggered,
              })),
            }));
      }
      msgs.push(`【${ClashManager._buffLabel(primary.type)}】引爆：混乱阈值前移 <strong>${shifted}%</strong>。`);

      // ── 各【特殊震颤】的额外效果 ──
      for (const tb of family) {
        const handler = resolveBuffHandler(tb);
        if (typeof handler?.onSeismicBlast !== "function") continue;
        const line = await handler.onSeismicBlast(target, tb, {
          attacker,
          getBuff:    (type) => ClashManager._getBuff(target, type),
          addBuff:    (type, intensity, stacks, whenAdded) =>
            ClashManager._addBuff(target, type, intensity, stacks, whenAdded),
          dealDamage: async (tgtActor, category, formula, sinType = "") => {
            if (!tgtActor) return 0;
            const roll = new Roll(String(formula));
            await roll.evaluate();
            const physMult = category
              ? ClashManager._parseResistance(ClashManager._getEffectiveResistances(tgtActor)[category] ?? "x1.0")
              : 1.0;
            const sinMult = sinType
              ? ClashManager._parseResistance(tgtActor.system?.egoResistances?.[sinType] ?? "x1.0")
              : 1.0;
            const dmg = Math.max(0, Math.round(roll.total * physMult * sinMult));
            await ClashManager._applyAndSendTake(tgtActor, dmg, { attacker, takeLabel: "震颤引爆-承受", category, sinType });
            return dmg;
          },
        });
        if (typeof line === "string" && line) msgs.push(line);
      }

      // ── 消耗层数：只扣基础承担者那一条，其余由同步跟随 ──
      await ClashManager._reduceBuffStacks(target, primary.type, 1);
      await ClashManager._syncTremorFamily(target);
      await ClashManager._tickFieldResources(TREMOR_BASE_TYPE, shifted, 1);
      blasts++;
    }

    if (blasts > 0) await ClashManager._cleanupTremorDependents(target);
    return { blasts, msgs };
  }

  /** 移除角色所有指定类型的 BUFF。 */
  static async _removeBuff(actor, type, { _internal = false } = {}) {
    if (!actor || !type) return;
    const had = (actor.system?.buffs ?? []).some(b => b.type === type);
    if (typeof actor.removeBuffsByType === "function" && actor.canUserModify?.(game.user, "update")) {
      await actor.removeBuffsByType(type);
    } else {
      const buffs = (actor.system?.buffs ?? []).filter(b => b.type !== type);
      await ClashManager._safeDocUpdate(actor, { "system.buffs": buffs });
    }
    if (had) {
      await ClashManager._dispatchBuffChange(actor, "onBuffLost",
        { type, stacks: 0, removed: true, _internal });
    }
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
   * "bgTag" 是异步的（需 fromUuid 解析背景物品），因此本方法整体为 async，
   * 调用方需 await。
   * @param {string} targetType
   * @param {Actor|null} owner
   * @param {Actor|null} other
   * @param {{targetTag?:string, targetTagCount?:number}} [meta]  target==="bgTag" 时使用
   */
  static async _resolveTargets(targetType, owner, other, meta = {}) {
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

    if (targetType === "bgTag" || targetType === "bgTagOther") {
      // 背景标签：本队中"背景带有该标签"的角色数量 ≥ targetTagCount 时，
      // 这些角色均视为合法目标；数量不足则视为无目标（效果不生效）。
      // "bgTagOther" 与 "allTeamOther" 同理：先排除拥有者自己（自己不受益），
      // "数量≥N"这个门槛也是排除自己之后、剩下的其他带标签队友数量来判定——
      // 如"为其他背景标签为X的友方（至少2个）恢复…"，指的是"除自己外还有
      // ≥2 个带该标签的队友"。
      const tagName = (meta?.targetTag ?? "").trim();
      const minCount = Math.max(1, meta?.targetTagCount ?? 1);
      if (!tagName) return [];
      const poolIds = myIds.length ? myIds : (ownerId ? [ownerId] : []);
      const filteredIds = targetType === "bgTagOther" ? poolIds.filter(id => id !== ownerId) : poolIds;
      const candidates = toActors(filteredIds);
      const matched = [];
      for (const actor of candidates) {
        const tags = await ClashManager._getBackgroundTags(actor);
        if (tags.includes(tagName)) matched.push(actor);
      }
      return matched.length >= minCount ? matched : [];
    }

    switch (targetType) {
      case "allTeam":       return toActors(myIds);
      case "allTeamOther":  return toActors(myIds.filter(id => id !== ownerId));
      case "allEnemy":      return toActors(foeIds);
      case "allEnemyOther": return toActors(foeIds.filter(id => id !== ownerId));
      default:              return other ? [other] : [];
    }
  }

  /** 解析角色背景物品的标签数组（"/" 分隔），解析失败返回空数组 */
  static async _getBackgroundTags(actor) {
    const bgUuid = actor?.system?.background?.uuid;
    if (!bgUuid) return [];
    const bg = await fromUuid(bgUuid).catch(() => null);
    return String(bg?.system?.tags ?? "").split("/").map(t => t.trim()).filter(Boolean);
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

        // ── category 类型：检查"本次由 owner 实际使用的技能"的分类 ──────
        // 注意：该 Activity 可能挂在装备/被动物品上（通过 _applyActivitiesAndEquip 的
        // 已装备物品遍历触发），此时不能直接查 item 自身的分类（装备的 category 是
        // 自由文本，如"匕首"，根本不属于 slash/blunt/pierce）——需改查 ctx._currentItemId
        // 指向的、本次对抗中 owner 实际打出的技能。若取不到（如非对抗流程触发），
        // 退回检查 item 自身分类，保持向下兼容。
        if (pre.type === "category") {
          const actingItem = (owner?.items?.get?.(ctx._currentItemId ?? "")) ?? item;
          const cats = Array.isArray(pre.categories) ? pre.categories : [];
          if (cats.length === 0 || !cats.includes(actingItem?.system?.category)) { precondFail = true; break; }
          continue;
        }

        // ── useSkill 类型：检查"本次由 owner 实际使用的技能"的名称/标签/UUID ──
        // 同上，优先取 ctx._currentItemId 指向的实际使用技能，取不到时退回 item 自身。
        if (pre.type === "useSkill") {
          const actingItem = (owner?.items?.get?.(ctx._currentItemId ?? "")) ?? item;
          if (!ClashManager._matchSkillIdentity(actingItem, pre)) { precondFail = true; break; }
          continue;
        }

        // ── level 类型：检查"本次由 owner 实际使用的技能"的等级（1/2/3）──
        // 与 category/useSkill 同理，优先取 ctx._currentItemId 指向的实际使用技能。
        if (pre.type === "level") {
          const actingItem = (owner?.items?.get?.(ctx._currentItemId ?? "")) ?? item;
          const lvl = actingItem?.system?.level ?? 0;
          if (!ClashManager._cmp(lvl, pre.comparison ?? "eq", pre.level ?? 1)) { precondFail = true; break; }
          continue;
        }

        // ── baseAttr 类型：检查角色属性值 ──────────────────────────────
        if (pre.type === "baseAttr") {
          const precTgt = (pre.target ?? "self") === "self" ? owner : other;
          if (!precTgt) { precondFail = true; break; }
          const curVal   = ClashManager._getAttrVal(precTgt, pre.attrType ?? "hp");
          const threshold = ClashManager._parseThreshold(pre.attrValue ?? "0", precTgt, pre.attrType ?? "hp");
          if (!ClashManager._cmp(curVal, pre.comparison ?? "lt", threshold)) { precondFail = true; break; }
          continue;
        }

        // ── fieldResource 类型：检查公用场地当前层数（只读，不消耗）────
        if (pre.type === "fieldResource") {
          if (!pre.fieldName) { precondFail = true; break; }
          const have = SinResourceHUD.getFieldResourceStacks(pre.fieldName);
          if (!ClashManager._cmp(have, pre.comparison ?? "gte", pre.stacks ?? 0)) { precondFail = true; break; }
          continue;
        }

        // ── sinResource 类型：检查全局罪孽池当前点数（只读，不消耗）────
        if (pre.type === "sinResource") {
          if (!pre.sinType) { precondFail = true; break; }
          const have = SinResourceHUD.getSinValue(pre.sinType);
          if (!ClashManager._cmp(have, pre.comparison ?? "gte", pre.value ?? 0)) { precondFail = true; break; }
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
          // 每：维度可选"层数"（默认，向下兼容旧数据）或"强度"——
          // 如"目标每有 8 级【烧伤】"实际指的是强度而非层数，需按强度计算倍数。
          // 维度≥ N（N = pre.stacks）才满足，倍数 = floor(当前值 / N)，可选上限 maxTimes。
          // 注：不再额外检查"强度≥"门槛——"每"只关心倍数怎么算，不需要"拥有"式的额外强度阈值。
          const dim  = pre.perNDim === "intensity" ? "intensity" : "stacks";
          const n    = Math.max(1, pre.stacks ?? 1);
          if (!buff) { precondFail = true; break; }
          const haveVal = dim === "intensity" ? (buff.intensity ?? 0) : (buff.stacks ?? 0);
          if (haveVal < n) { precondFail = true; break; }
          let times = Math.floor(haveVal / n);
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
          const costTgts = await ClashManager._resolveTargets(cost.target ?? "self", owner, other, cost);
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
        } else if (cost.target === "field" && (cost.type === "forced" || cost.type === "perStack")) {
          // 公用场地：层数不足（每N层的 N）则跳过整条 Activity
          if (!cost.fieldName) { forcedFail = true; break; }
          const have = SinResourceHUD.getFieldResourceStacks(cost.fieldName);
          if (have < Math.max(1, cost.stacks ?? 1)) { forcedFail = true; break; }
        } else if (cost.target === "sin" && (cost.type === "forced" || cost.type === "perStack")) {
          // 罪孽资源：点数不足（每N点的 N）则跳过整条 Activity
          if (!cost.sinType) { forcedFail = true; break; }
          const have = SinResourceHUD.getSinValue(cost.sinType);
          if (have < Math.max(1, cost.value ?? 1)) { forcedFail = true; break; }
        } else if (cost.buff && (cost.type === "forced" || cost.type === "perStack")) {
          // 强制消耗 / 每：数值不足（每N的 N，维度可选层数/强度）则跳过整条 Activity
          const costBuffType = cost.buff === "custom" ? (cost.buffCustom || "custom") : cost.buff;
          const costDim = cost.type === "perStack" && cost.perNDim === "intensity" ? "intensity" : "stacks";
          const costTgts = await ClashManager._resolveTargets(cost.target ?? "self", owner, other, cost);
          if (costTgts.length === 0) { forcedFail = true; break; }
          for (const tgt of costTgts) {
            const existing = ClashManager._getBuff(tgt, costBuffType);
            const haveVal  = costDim === "intensity" ? (existing?.intensity ?? 0) : (existing?.stacks ?? 0);
            if (haveVal < Math.max(1, cost.stacks ?? 1)) { forcedFail = true; break; }
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
          const costTgts = await ClashManager._resolveTargets(cost.target ?? "self", owner, other, cost);
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
          const costTgts = await ClashManager._resolveTargets(cost.target ?? "self", owner, other, cost);
          if (cost.type === "perStack") {
            // 每：与前置条件的"每"一致——维度可选层数（默认，向下兼容旧数据）或强度，
            // 每 N 为 1 倍，倍数 = floor(数值/N)，可选最大倍数上限（maxTimes，0=无限），
            // 只消耗 倍数×N（如"每消耗4级【呼吸法】"应选强度维度）
            const tgt = costTgts[0];
            if (tgt) {
              const dim      = cost.perNDim === "intensity" ? "intensity" : "stacks";
              const existing = ClashManager._getBuff(tgt, costBuffType);
              const have     = dim === "intensity" ? (existing?.intensity ?? 0) : (existing?.stacks ?? 0);
              const n        = Math.max(1, cost.stacks ?? 1);
              let   times    = Math.floor(have / n);
              if ((cost.maxTimes ?? 0) > 0) times = Math.min(times, cost.maxTimes);
              if (dim === "intensity") {
                await ClashManager._reduceBuffIntensity(tgt, costBuffType, times * n);
              } else {
                await ClashManager._reduceBuffStacks(tgt, costBuffType, times * n);
              }
              perStackMultiplier = times;
            }
          } else if (cost.type !== "none") {
            for (const tgt of costTgts) {
              await ClashManager._reduceBuffStacks(tgt, costBuffType, cost.stacks ?? 1);
            }
          }
        } else if (cost.target === "field" && cost.fieldName) {
          // 公用场地：每 / 强制消耗 / 可选消耗（不足时可选消耗直接跳过，不报错）
          if (cost.type === "perStack") {
            const have  = SinResourceHUD.getFieldResourceStacks(cost.fieldName);
            const n     = Math.max(1, cost.stacks ?? 1);
            let   times = Math.floor(have / n);
            if ((cost.maxTimes ?? 0) > 0) times = Math.min(times, cost.maxTimes);
            await SinResourceHUD.consumeFieldResourceStacks(cost.fieldName, times * n);
            perStackMultiplier = times;
          } else if (cost.type !== "none") {
            await SinResourceHUD.consumeFieldResourceStacks(cost.fieldName, cost.stacks ?? 1);
          }
        } else if (cost.target === "sin" && cost.sinType) {
          // 罪孽资源：每 / 强制消耗 / 可选消耗（可选消耗不足时直接跳过，不报错）
          const consume = async (amount) => {
            if (amount > 0) await SinResourceHUD.consumeSins([{ sinType: cost.sinType, amount }]);
          };
          if (cost.type === "perStack") {
            const have  = SinResourceHUD.getSinValue(cost.sinType);
            const n     = Math.max(1, cost.value ?? 1);
            let   times = Math.floor(have / n);
            if ((cost.maxTimes ?? 0) > 0) times = Math.min(times, cost.maxTimes);
            await consume(times * n);
            perStackMultiplier = times;
          } else if (cost.type !== "none") {
            const need = cost.value ?? 1;
            if (SinResourceHUD.getSinValue(cost.sinType) >= need) await consume(need);
          }
        }
      }

      // ── 效果（effects）────────────────────────────────────────────────
      // 兼容 V1（单对象 effect）和 V2（数组 effects）
      const effects = Array.isArray(act.effects) ? act.effects
        : (act.effect ? [act.effect] : []);

      for (const eff of effects) {
        if (!eff?.type) continue;
        // 连击的第 2 次交锋起：改写技能本身的效果（骰数/面数/基础值/加重值/
        // 骰子类型）不再重复执行，否则每交锋一次就再加一遍，3d 会滚成 6d
        if (ctx._comboRound > 1 && ClashManager.COMBO_ONCE_EFFECTS.has(eff.type)) continue;
        const effTgts = await ClashManager._resolveTargets(eff.target ?? "self", owner, other, eff);
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

            // 【振幅转换】【振幅纠缠】可在编辑器里附带一个【特殊震颤】，
            // 一并施加（顺序：先振幅后震颤，这样转换/并列规则立刻生效）
            if (TREMOR_DEPENDENT_TYPES.includes(buffType) && eff.ampTremor) {
              // 传 0 层 0 级：转换态下等于纯粹改写类型（现有震颤的层数强度不变），
              // 并列（纠缠）态下新建的这条会由 _syncTremorFamily 同步到【震颤】的数值
              await ClashManager._addBuff(effTgt, eff.ampTremor, 0, 0, round);
              descStr += `，并施加【${ClashManager._buffLabel(eff.ampTremor)}】`;
            }
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
            // 行动值没有上限，只保证不为负
            const nv  = mode === "absolute" ? Math.max(0, val) : Math.max(0, cur + val);
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
          case "fieldResource": {
            // 公用场地：全局共享计数器，与角色/物品无关，忽略 effTgt 循环（同 diceTypeChg 等）
            const fieldName = eff.fieldName ?? "";
            if (!fieldName) { descStr = "公用场地效果：未填写场地名字"; break; }
            const { mode, value: rawVal } = await ClashManager._evalSignedValue(eff.value, eff.intensity);
            const val = _scaleVal(rawVal, mode);
            const cur = SinResourceHUD.getFieldResourceStacks(fieldName);
            if (mode === "absolute") {
              await SinResourceHUD.setFieldResourceStacks(fieldName, val);
              descStr = `场地【${fieldName}】层数 调整为 ${Math.max(0, val)}`;
            } else {
              await SinResourceHUD.addFieldResourceStacks(fieldName, val);
              descStr = `场地【${fieldName}】层数 ${val >= 0 ? "+" : ""}${val}（${cur} → ${Math.max(0, cur + val)}）`;
            }
            break;
          }
          case "seismicBlast": {
            // 对目标触发【震颤引爆】N 次（N = eff.value），具体规则见 ClashManager.seismicBlast
            const blastCount = Math.max(1, Math.round(Number(eff.value ?? 1)));
            const { blasts, msgs: blastMsgs } =
              await ClashManager.seismicBlast(effTgt, blastCount, { attacker: owner });
            for (const line of blastMsgs) msgs.push(line);
            descStr = blasts > 0
              ? `【${effTgt.name}】震颤引爆 ×${blasts}`
              : `【${effTgt.name}】无【震颤】状态，震颤引爆未触发`;
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
              // 【沉沦】：为目标造成 强度等级的理智伤害；理智因此跌至下限 5 时，
              // 额外造成 强度等级的【忧郁】罪孽伤害（按目标忧郁抗性结算，非 HP_DMG_BUFFS 通用公式）
              const sanityDmg = actualStacks * intensity;
              if (typeof effTgt.setSanity === "function") {
                await effTgt.setSanity((effTgt.system?.sanity?.value ?? 50) - sanityDmg);
              } else {
                const curSanity = effTgt.system?.sanity?.value ?? 50;
                await ClashManager._safeDocUpdate(effTgt, {
                  "system.sanity.value": Math.max(5, Math.min(95, curSanity - sanityDmg)),
                });
              }
              dmgNote = `，理智 -${sanityDmg}`;
              if ((effTgt.system?.sanity?.value ?? 50) === 5) {
                const gloomMult = ClashManager._parseResistance(effTgt.system?.egoResistances?.gloom ?? "x1.0");
                const gloomDmg  = Math.max(0, Math.round(intensity * gloomMult));
                if (gloomDmg > 0) {
                  const curHp = effTgt.system?.hp?.value ?? 0;
                  await ClashManager._safeDocUpdate(effTgt, { "system.hp.value": Math.max(0, curHp - gloomDmg) });
                  dmgNote += `，理智见底额外受到 ${gloomDmg} 点【忧郁】伤害`;
                }
              }
            }
            if (totalDmg > 0) {
              const curHp = effTgt.system?.hp?.value ?? 0;
              await ClashManager._safeDocUpdate(effTgt, { "system.hp.value": Math.max(0, curHp - totalDmg) });
            }

            const buffLabel = ClashManager._buffLabel(buffType);
            descStr = `【${effTgt.name}】触发 ${actualStacks} 层【${buffLabel}】${dmgNote}`;
            await ClashManager._tickFieldResources(buffType, intensity, actualStacks);
            break;
          }
          case "extraDamage": {
            // 追加伤害：按选定物理分类/罪孽类型乘抗性算出最终伤害数值，
            // 跳过的只是"第一次伤害"（拼点/骰数结算流程本身，不会二次拼点），
            // 但仍需走完整的承受结算管线（护盾吸收/混乱阈值判定/自定义BUFF承伤
            // 钩子如【百折不挠】等），因此改为调用 _applyAndSendTake 而非直接扣HP。
            const rawVal = await ClashManager._evalValue(eff.value);
            const scaled = _scaleVal(rawVal, "relative"); // 始终按倍数缩放（无绝对值语义）
            const physMult = eff.dmgCategory
              ? ClashManager._parseResistance(ClashManager._getEffectiveResistances(effTgt)[eff.dmgCategory] ?? "x1.0")
              : 1.0;
            const sinMult = eff.dmgSinType
              ? ClashManager._parseResistance(effTgt.system?.egoResistances?.[eff.dmgSinType] ?? "x1.0")
              : 1.0;
            const dmg = Math.max(0, Math.round(scaled * physMult * sinMult));
            const catLabel = eff.dmgCategory ? `【${ClashManager._catLabel(eff.dmgCategory)}】` : "";
            const sinLabel = eff.dmgSinType   ? `【${ClashManager._sinLabel(eff.dmgSinType)}】`   : "";
            descStr = `对【${effTgt.name}】造成 ${dmg} 点${catLabel}${sinLabel}追加伤害（结算详情见承受结算消息）`;
            if (dmg > 0) {
              await ClashManager._applyAndSendTake(effTgt, dmg, { attacker: owner, takeLabel: "追加伤害-承受",
                category: eff.dmgCategory ?? "", sinType: eff.dmgSinType ?? "", item });
            }
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
          case "relatedSkillConvert": {
            // 相关技能转换：将"本骰"（item）永久替换为角色背包/技能列表中按名字检索到的技能。
            // 旧版"随机/指定序号"（走 item.system.relatedSkill.pool 这个 UUID 池，需要互相
            // 套娃预先配置）已移除，改为直接按名字检索已拥有的技能，无需任何预配置，
            // 也不受合集包提取后 UUID 变化的影响。
            const relOwner = item?.parent ?? owner;
            if (!relOwner || !item) { descStr = "相关技能转换：找不到所属角色"; break; }

            const name = (eff.relSkillName ?? "").trim();
            if (!name) { descStr = "相关技能转换：未配置技能名字"; break; }
            const newItem = (relOwner.items ?? []).find(it => it.type === "skill" && it.name === name && it.id !== item.id);
            if (!newItem) { descStr = `相关技能转换：背包中找不到技能【${name}】`; break; }
            const replaced = await relOwner.replaceSkillSlot?.(item.id, newItem.id);
            if (replaced) relOwner.sheet?._replaceCombatBagSkill?.(item.id, newItem.id);
            descStr = replaced
              ? `【${item.name}】永久转换为【${newItem.name}】`
              : `相关技能转换：未找到【${item.name}】所在的技能槽位`;
            break;
          }
          case "useSkill": {
            // 由效果的【目标】来使用技能（target=自己时即 owner 本身）
            const useTgt  = effTgt ?? owner;
            let skillItem = null;
            if (eff.skillRef === "name") {
              // 按名字在角色背包/技能列表中检索：比 UUID 更稳定（合集包提取后 UUID 会变，名字不变）
              const name = (eff.skillName ?? "").trim();
              if (!name) { descStr = "useSkill：未配置技能名字"; break; }
              skillItem = (useTgt?.items ?? []).find(it => it.type === "skill" && it.name === name) ?? null;
              if (!skillItem) { descStr = `useSkill：背包中找不到技能【${name}】`; break; }
            } else {
              // 标签+等级：在目标的技能列表中按 tags / level 检索
              const tag = (eff.skillTag ?? "").trim();
              const lv  = parseInt(eff.skillLevel) || 0;
              if (!tag) { descStr = "useSkill：未配置技能标签"; break; }
              skillItem = ClashManager._findSkillByTagLevel(useTgt, tag, lv);
              if (!skillItem) {
                descStr = `useSkill：背包中找不到标签为【${tag}】${lv > 0 ? ` Lv.${lv}` : ""}的技能`;
                break;
              }
            }
            // 守备技能 → 触发其[使用时] Activities
            if (skillItem.system?.type === "defense") {
              await ClashManager._applyActivities(skillItem, "使用时", {
                owner: useTgt, atkActor: ctx.atkActor, defActor: ctx.defActor,
                _fireCounts: {}, _actMsgs: ctx._actMsgs ?? [],
              });
              descStr = `【${useTgt?.name ?? ""}】触发【${skillItem.name}】[使用时]`;
            } else {
              // 非守备技能 → 弹出对抗发起窗口（仅限有 AP 的场景，AP 不足则跳过）
              const curAP = useTgt?.system?.ap?.value ?? 0;
              if (useTgt && curAP <= 0) await ClashManager._safeDocUpdate(useTgt, { "system.ap.value": 1 });
              await ClashManager.showInitiateDialog(useTgt, skillItem, -2);
              descStr = `【${useTgt?.name ?? ""}】发起对抗：【${skillItem.name}】`;
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
      if ((limitType === "perTurn" || limitType === "perEncounter") && limitCount > 0 && owner) {
        const flagKey = limitType === "perTurn" ? "turnFireCounts" : "encounterFireCounts";
        const counts  = foundry.utils.deepClone(owner.getFlag?.("limbusCompany_FVTT", flagKey) ?? {});
        counts[actKey] = (counts[actKey] ?? 0) + 1;
        // setFlag 本质是 Actor update，跨所有权时需委托 GM
        await ClashManager._safeDocUpdate(owner, { [`flags.limbusCompany_FVTT.${flagKey}`]: counts });
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
  static async _flushActMsgs(actMsgs, speaker, { title = "" } = {}) {
    if (!actMsgs?.length) return;
    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: speaker }),
      content: ClashManager._buildActMsgContent(actMsgs, title),
    });
  }

  /** 构建活动效果汇总消息的 HTML 内容。指定 title 时始终折叠为一条摘要。 */
  static _buildActMsgContent(entries, title = "") {
    const rows = entries.map(({ trigger, itemName, ownerName, msgs }) => `
      <div style="margin-bottom:4px;">
        <span style="font-weight:bold;color:#C9A84C;">⚡ [${trigger}] ${ownerName && ownerName !== itemName ? `${ownerName}·` : ""}${itemName}</span>
        ${msgs.map(m => `<div style="color:#E8C9A2;padding-left:8px;">${m}</div>`).join("")}
      </div>`).join(ClashManager._goldDivider());
    const body = `<div style="font-size:.8rem;line-height:1.7;">${rows}</div>`;
    // 无标题且条目不多时直接平铺；否则折叠详情
    if (!title && entries.length <= 2) {
      return `<div class="limbus-clash-card">${body}</div>`;
    }
    const summaryLabel = title
      ? `▼ ${title}：详细信息（${entries.length} 条触发效果）`
      : `▼ 详细信息（${entries.length} 条触发效果）`;
    return `<div class="limbus-clash-card">
      <details>
        <summary style="cursor:pointer;font-size:.8rem;color:#C9A84C;font-weight:bold;user-select:none;list-style:none;">
          ${summaryLabel}
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

    const _bleedMods = ClashManager.applyTickDamageMods(actor, buff.intensity ?? 0, "bleed");
    const dmg   = _bleedMods.damage;
    const oldHp = actor.system.hp?.value ?? 0;
    const newHp = ClashManager.applyHpFloor(oldHp, oldHp - dmg, _bleedMods.hpFloor);

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
    await ClashManager._safeDocUpdate(actor, { "system.hp.value": newHp });
    await ClashManager._reduceBuffStacks(actor, "bleed");
    await ClashManager._tickFieldResources("bleed", dmg, 1);
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

  /**
   * @param {Actor}  actor
   * @param {Item}   item
   * @param {number} [slotIndex=-1]      >=0 从战斗槽触发（推进6-bag+扣AP）；-2 只扣AP
   * @param {string} [targetActorId=""]  指定目标角色 ID（HUD 拖拽到 token 时传入）；
   *                                     非空时只有该角色能对抗/承受
   */
  static async showInitiateDialog(actor, item, slotIndex = -1, targetActorId = "") {
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
              ClashManager.applyDiceRollMods(actor, roll, { item, isDefense: false });
              await ClashManager._sendInitiateMsg(actor, item, roll, full, slotIndex, targetActorId);

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

  static async _sendInitiateMsg(actor, item, roll, formula, slotIndex, targetActorId = "") {
    const sys        = item.system ?? {};
    const effectDesc = ClashManager._effectDesc(item);
    const targetName = targetActorId ? (game.actors.get(targetActorId)?.name ?? "") : "";

    const content = `
      <div class="limbus-clash-card" data-clash-type="initiate">
        ${ClashManager._chatHeader(actor, "发起对抗")}
        ${ClashManager._goldDivider()}
        ${ClashManager._skillRow(item)}
        ${targetName ? `<div style="font-size:.78rem;color:#B43822;margin-top:6px;">
          ⊘ 已指定目标：<strong>${targetName}</strong>（其他角色无法对抗/承受）
        </div>` : ""}
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
          targetActorId,
        },
      },
    });

    // 推进战斗槽（使用技能不再消耗行动值；流血改由 [攻击时]/[拼点时] 触发）
    if (slotIndex >= 0) {
      const sheet = actor.sheet;
      if (sheet?._combatBagState) sheet._animateCombatSkillUse?.(slotIndex);
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

    // 指定目标：发起时若拖拽到某个 token 上，则只有该角色能响应
    if (initFlags.targetActorId && defActor.id !== initFlags.targetActorId) {
      const tgtName = game.actors.get(initFlags.targetActorId)?.name ?? "指定目标";
      ui.notifications.warn(`本次对抗已指定目标【${tgtName}】，其他角色无法对抗`);
      return;
    }

    // 恐慌时只能用 EGO 响应；行动值不再是对抗门槛（它代表可承受的拼点失败次数）
    const isInPanic = !!ClashManager._getBuff(defActor, "panic");
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
    // 技能格：方形图 + 罪孽色描边（此处不使用罪孽边框图，图标更大更清晰）。
    // 悬停 Title 卡由 render 阶段统一挂载，这里不再写 title 原生提示，
    // 避免与 Title 卡重复弹两层。
    const octaSlotHtml = (item, extraClass = "", slotIdx = -1, disabled = false) => {
      if (!item) return `<div class="clash-pick-slot clash-pick-empty"></div>`;
      const sin = ClashManager._sinColor(item.system?.sinType);
      const cls = disabled ? "clash-pick-slot clash-pick-disabled" : `clash-pick-slot ${extraClass}`;
      return `
        <div class="${cls}" data-item-id="${item.id}" data-slot-index="${slotIdx}">
          <img src="${item.img}" style="border-color:${sin};" alt="${item.name}">
        </div>`;
    };

    /** EGO 槽（含等级名）；仅在该等级已配置技能时调用 */
    const circleSlotHtml = (item, grade = "") => {
      const sin = ClashManager._sinColor(item.system?.sinType);
      return `
        <div class="clash-pick-ego">
          <div class="clash-pick-slot" data-item-id="${item.id}" data-slot-index="-1">
            <img src="${item.img}" style="border-color:${sin};" alt="${item.name}">
          </div>
          ${grade ? `<span class="clash-pick-ego-grade">${grade}</span>` : ""}
        </div>`;
    };

    const panicNotice = panicMode
      ? `<div style="font-size:.75rem;color:#E8A444;text-align:center;padding:4px 0 6px;font-style:italic;">
           【陷入恐慌】只能使用 E.G.O 技能
         </div>`
      : "";

    // 顶部：两个已激活技能 + 守备技能，上下各一条金色渐变分割线
    const topRow = `
      ${panicNotice}
      ${ClashManager._goldDivider()}
      <div class="clash-pick-row">
        ${octaSlotHtml(active0, "clash-pick-active", 0, panicMode)}
        ${octaSlotHtml(active1, "clash-pick-active", 1, panicMode)}
        ${octaSlotHtml(defItem, "", -1, panicMode)}
      </div>
      ${ClashManager._goldDivider()}`;

    // 展开区：6-bag 剩余技能 + EGO 技能，统一按固定 3 列排布。
    // EGO 空等级不渲染（与快捷 HUD 的处理一致）。
    const expandedSlots = [
      ...restItems.map((it, j) => octaSlotHtml(it, "", 2 + j, panicMode)),
      ...egoEntries.filter(e => e.item).map(e => circleSlotHtml(e.item, e.grade)),
    ];
    const expandedHtml = expandedSlots.length ? `
      <div class="clash-pick-expanded" style="display:none;">
        <div class="clash-pick-grid">${expandedSlots.join("")}</div>
      </div>` : "";

    const content = `
      <div class="limbuscompany clash-pick-dialog">
        ${topRow}
        ${expandedSlots.length ? `
          <div class="clash-pick-expand-wrap">
            <button class="clash-pick-expand-btn" title="展开更多技能">▼</button>
          </div>` : ""}
        ${expandedHtml}
      </div>`;

    const dlg = new Dialog({
      title: "拼点对抗",
      content,
      buttons: {},
      render: (dlgHtml) => {
        // 悬停显示技能 Title 卡（与角色卡/快捷 HUD 同一套卡片）。
        // item-sheet.mjs 静态 import 了本文件，这里改用动态 import 规避循环依赖；
        // 卡片 controller 记录在 dlg 上，关闭弹窗时统一销毁，避免残留。
        import("../sheets/item-sheet.mjs").then(({ attachHoverableTitleCard, buildItemTitleCard }) => {
          dlg._pickCardCtrls = [];
          dlgHtml.find(".clash-pick-slot[data-item-id]").each((_i, el) => {
            const it = actor.items.get(el.dataset.itemId);
            if (!it) return;
            dlg._pickCardCtrls.push(attachHoverableTitleCard(el, () => buildItemTitleCard(it)));
          });
        }).catch(err => console.error("ClashManager: 挂载技能 Title 卡失败", err));

        // 展开/折叠
        dlgHtml.find(".clash-pick-expand-btn").on("click", (e) => {
          const $exp = dlgHtml.find(".clash-pick-expanded");
          const open = $exp.is(":visible");
          $exp.toggle(!open);
          $(e.currentTarget).text(open ? "▼" : "▲");
          // 展开/折叠后让弹窗高度重新自适应内容，否则会留白或被截断
          dlg.setPosition({ height: "auto" });
        });

        // 恐慌时禁用槽点击提示
        dlgHtml.on("click", ".clash-pick-disabled", () => {
          ui.notifications.warn("【陷入恐慌】无法使用基础或守备技能！");
        });

        // 选中技能（携带 slotIdx 供后续推进战斗袋）
        dlgHtml.on("click", ".clash-pick-slot:not(.clash-pick-empty):not(.clash-pick-disabled)", (e) => {
          const itemId  = e.currentTarget.dataset.itemId;
          const slotIdx = parseInt(e.currentTarget.dataset.slotIndex ?? "-1");
          const item    = actor.items.get(itemId);
          if (!item) return;
          dlg.close();
          onPick(item, slotIdx);
        });
      },
      close: () => {
        // 关闭弹窗时摘掉挂在 body 上的 Title 卡，避免残留在屏幕上
        dlg._pickCardCtrls?.forEach(c => c.close?.());
        dlg._pickCardCtrls = [];
      },
    }, { width: 360 });   // 容纳展开区 3 列 × --pick-slot(74px) + 间距

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
              ClashManager.applyDiceRollMods(defActor, roll, { item: defItem, isDefense: true });

              // TOTAL 演出与 DiceSoNice 推迟到 [攻击时/拼点时] 之后统一播放：
              // 那些效果可能改写骰子公式导致重投，先演一次就白演了。
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

    // 拼点结算所需的攻击方角色（提前获取，供 [使用时] 触发使用）
    const atkActor = game.actors.get(initFlags.attackerId);


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
    // 【流血】挂在 [攻击时] 与 [拼点时] 上，因此连击时每次交锋都会再发作一次
    await ClashManager._applyActivitiesAndEquip(atkItem, "攻击时", atkCtx);
    await ClashManager._applyActivitiesAndEquip(defItem,  "攻击时", defCtx);
    await ClashManager._processBleed(atkActor);
    await ClashManager._processBleed(defActor);
    await ClashManager._applyActivitiesAndEquip(atkItem, "拼点时", atkCtx);
    await ClashManager._applyActivitiesAndEquip(defItem,  "拼点时", defCtx);

    // ── [攻击时/拼点时] 可能修改骰子公式（diceAdj/diceFacesAdj/baseValue）──
    // 若公式与发起时不同，重新投骰，保留手动加值部分
    // 公式重投的骰子同样要有 DSN 动画，且攻守两边重投时一起入场
    const _rerollShow = [];
    // 手动加值部分（"+3" 之类）与基础公式：重投与演出都要用
    const atkBonusPart  = String(initFlags.formula ?? "").slice(String(atkBaseFormulaOrig ?? "").length);
    const atkBonusVal   = parseInt(atkBonusPart) || 0;
    const defBonusPart0 = String(defFormula ?? "").slice(String(defBaseFormulaOrig ?? "").length);
    const defBonusVal   = parseInt(defBonusPart0) || 0;

    let atkFinalTotal   = initFlags.rollTotal;
    let atkFinalFormula = initFlags.formula;
    let atkFinalBase    = atkBaseFormulaOrig;
    const newAtkBase = atkItem?.system?.diceFormula ?? atkBaseFormulaOrig;
    if (newAtkBase !== atkBaseFormulaOrig) {
      const newAtkFull = newAtkBase + atkBonusPart;
      const rerollAtk  = new Roll(newAtkFull);
      await rerollAtk.evaluate();
      atkFinalTotal   = rerollAtk.total;
      atkFinalFormula = newAtkFull;
      atkFinalBase    = newAtkBase;
      _rerollShow.push({ roll: rerollAtk, actor: atkActor, side: "atk" });
      _actMsgs.push({ trigger: "公式重投", itemName: atkItem?.name ?? "攻击方", msgs: [`公式变化（${atkBaseFormulaOrig} → ${newAtkBase}），重新投骰：${rerollAtk.result} = <b>${rerollAtk.total}</b>`] });
    }

    let defFinalTotal   = defRoll.total;
    let defFinalFormula = defFormula;
    let defFinalBase    = defBaseFormulaOrig;
    const newDefBase = defItem?.system?.diceFormula ?? defBaseFormulaOrig;
    if (newDefBase !== defBaseFormulaOrig) {
      const newDefFull = newDefBase + defBonusPart0;
      const rerollDef    = new Roll(newDefFull);
      await rerollDef.evaluate();
      defFinalTotal   = rerollDef.total;
      defFinalFormula = newDefFull;
      defFinalBase    = newDefBase;
      _rerollShow.push({ roll: rerollDef, actor: defActor, side: "def" });
      _actMsgs.push({ trigger: "公式重投", itemName: defItem?.name ?? "防守方", msgs: [`公式变化（${defBaseFormulaOrig} → ${newDefBase}），重新投骰：${rerollDef.result} = <b>${rerollDef.total}</b>`] });
    }

    // 演出用的最终骰：发生过公式重投的一方用重投后的骰
    const atkRollFx = _rerollShow.find(e => e.side === "atk")?.roll
      ?? (initFlags.rollData ? Roll.fromJSON(JSON.stringify(initFlags.rollData)) : null);
    const defRollFx = _rerollShow.find(e => e.side === "def")?.roll ?? defRoll;

    // 演出用的分段（闪避 / 格挡 / 反击共用）
    const _atkPartsFx = ClashManager._buildTotalParts({
      actor: atkActor, opponent: defActor,
      rollTotal: atkFinalTotal ?? 0, bonus: atkBonusVal,
      baseFormula: atkFinalBase ?? "", category: initFlags.category ?? "",
      isDefender: false,
    });
    const _defPartsFx = ClashManager._buildTotalParts({
      actor: defActor, opponent: atkActor,
      rollTotal: defFinalTotal ?? 0, bonus: defBonusVal,
      baseFormula: defFinalBase ?? "", category: defItem?.system?.category ?? "",
      isDefender: true,
    });
    const _coinsFx = {
      atk: atkActor?.system?.ap?.value ?? 0,
      def: defActor?.system?.ap?.value ?? 0,
    };
    const _diceTypeFx = {
      atk: atkItem?.system?.diceType ?? "default",
      def: defItem?.system?.diceType ?? "default",
    };
    const _rollsFx = { atk: atkRollFx, def: defRollFx };

    // 反击 / 格挡不是交锋，而是一前一后各骰一次：
    // 【格挡】防守方先出（先挡），【反击】进攻方先出（后反击）；命中的一方带命中声
    if (defCategory === "counter" || defCategory === "block") {
      await ClashTotalFX.playSequence({
        order:    defCategory === "block" ? ["def", "atk"] : ["atk", "def"],
        label:    defCategory === "block" ? "格挡" : "反击",
        parts:    { atk: _atkPartsFx, def: _defPartsFx },
        diceType: _diceTypeFx,
        coins:    _coinsFx,
        // 格挡：只有进攻方结算伤害；反击：双方都结算伤害
        hitOn:    defCategory === "block" ? ["atk"] : ["atk", "def"],
        startDice: (side) => ClashManager._showDiceEach([
          { roll: _rollsFx[side], actor: side === "atk" ? atkActor : defActor },
        ]),
      });
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

    // ── 闪避：双方同时出手，只拼一次，不消耗行动值也不碎硬币 ──────────
    if (defCategory === "dodge") {
      const atkEffFx = _atkPartsFx.reduce((a, p) => a + (p.value ?? 0), 0);
      const defEffFx = _defPartsFx.reduce((a, p) => a + (p.value ?? 0), 0);
      await ClashTotalFX.play({
        atkParts: _atkPartsFx, defParts: _defPartsFx,
        rerollSides: _rerollShow.map(e => e.side),
        atkCoins: _coinsFx.atk, defCoins: _coinsFx.def,
        atkDiceType: _diceTypeFx.atk, defDiceType: _diceTypeFx.def,
        noBreak: true,
        // 闪避失败（攻击方胜）才有命中声
        hitSfx: atkEffFx > defEffFx,
        startDice: () => ClashManager._showDiceEach([
          { roll: atkRollFx, actor: atkActor },
          { roll: defRollFx, actor: defActor },
        ]),
      });
    }
    // ── 连击：行动值决定还能输几次，输光了才由这一次的胜方结算伤害 ──────
    else {
      const combo = await ClashManager._runComboClash({
        atkActor, defActor, atkItem, defItem, atkCtx, defCtx,
        atkFormula: atkFinalBase ?? "", atkBonus: atkBonusVal,
        atkTotal0: atkFinalTotal ?? 0, atkRoll0: atkRollFx,
        atkCategory: initFlags.category ?? "",
        defFormula: defFinalBase ?? "", defBonus: defBonusVal,
        defTotal0: defFinalTotal ?? 0, defRoll0: defRollFx,
        defCategory,
        rerollSides: _rerollShow.map(e => e.side),
      });
      atkFinalTotal = combo.atkTotal;
      defFinalTotal = combo.defTotal;
    }
    // 连击后攻击方的骰值已变，结算卡片要用最后一次交锋的值
    const finalInitFlags = { ...effectiveInitFlags, rollTotal: atkFinalTotal };

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
        for (const buff of [...(winner.system?.buffs ?? [])]) {
          const handler = resolveBuffHandler(buff);
          if (typeof handler?.onClashWin === "function") {
            await handler.onClashWin(winner, loser, buff);
          }
        }
        // 败者侧的 onClashLose（与 onClashWin 对称）
        for (const buff of [...(loser.system?.buffs ?? [])]) {
          const handler = resolveBuffHandler(buff);
          if (typeof handler?.onClashLose === "function") {
            await handler.onClashLose(loser, winner, buff);
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

    await ClashManager._sendResolveMsg(resolution, finalInitFlags, defActor, defItem, defFormula, sanityNotes);

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

  /* ─── 阶段五a：连击（行动值决定的多次交锋）──────────────────────────── */

  /**
   * 连击：同一次对抗内的多次交锋。
   *
   * 行动值代表"还能承受几次拼点失败"：每次交锋输的一方扣 1 点行动值，双方
   * 重新骰掷再拼一次；若输的一方行动值已经是 0，交锋结束，由这一次的胜方
   * 结算伤害。
   *
   * 【不可摧毁】是个例外：它拼点失败照样能给对面造成伤害，所以只要它的币被
   * 打坏一枚，连击就当场结束——先由胜方结算伤害，随后再由【不可摧毁】那一方
   * 结算自己的反击伤害（见 _triggerUnbreakableCounter）。连击途中只重新结算 [拼点时]（连带【流血】），其余触发时机
   * （命中时 / 拼点成功失败 / 攻击后 等）仍然只在最后结算一次，不会滚雪球。
   *
   * DiceSoNice 只在第一次交锋播放；胜负决出后，再单独为胜方演一次
   * 【伤害计算】——点数就是决出胜负那一次的点数，不重掷，只是把用来结算
   * 伤害的那一掷郑重地摆出来。
   *
   * @returns {{atkTotal:number, defTotal:number, rounds:number}}
   *          最后一次交锋的骰值，用于最终结算
   */
  static async _runComboClash(ctx) {
    const { atkActor, defActor, atkItem, defItem, atkCtx, defCtx,
            atkFormula, atkBonus, atkTotal0, atkRoll0, atkCategory,
            defFormula, defBonus, defTotal0, defRoll0, defCategory,
            rerollSides = [] } = ctx;

    const partsOf = (side, total) => (side === "atk")
      ? ClashManager._buildTotalParts({
          actor: atkActor, opponent: defActor, rollTotal: total, bonus: atkBonus,
          baseFormula: atkFormula, category: atkCategory, isDefender: false })
      : ClashManager._buildTotalParts({
          actor: defActor, opponent: atkActor, rollTotal: total, bonus: defBonus,
          baseFormula: defFormula, category: defCategory, isDefender: true });
    const sum   = (parts) => parts.reduce((a, p) => a + (p.value ?? 0), 0);
    const apOf  = (actor) => actor?.system?.ap?.value ?? 0;

    const MAX_ROUNDS = 20;           // 平局不扣行动值，兜底防止死循环
    let round   = 0;
    let atkCur  = atkTotal0;
    let defCur  = defTotal0;
    let winSide = "";                // 决出胜负的一方
    let winRoll = null;              // 决胜那一掷（【伤害计算】沿用它，不重掷）
    let winParts = null;

    while (round < MAX_ROUNDS) {
      round++;
      // 开场把镜头推给进攻方，让所有人看着同一处开打
      if (round === 1) ClashVFX.broadcastPan(ClashVFX.centerOf(atkActor));
      let atkRoll = atkRoll0, defRoll = defRoll0;
      if (round > 1) {
        // 连击途中只重跑 [拼点时]（【流血】也挂在这里，会再发作一次）；
        // 改写技能自身的效果由 COMBO_ONCE_EFFECTS 拦下，不会重复累加
        atkCtx._comboRound = round;
        defCtx._comboRound = round;
        await ClashManager._applyActivitiesAndEquip(atkItem, "拼点时", atkCtx);
        await ClashManager._applyActivitiesAndEquip(defItem, "拼点时", defCtx);
        await ClashManager._processBleed(atkActor);
        await ClashManager._processBleed(defActor);
        atkCtx._comboRound = 1;
        defCtx._comboRound = 1;

        atkRoll = new Roll(atkFormula + (atkBonus ? `${atkBonus > 0 ? "+" : ""}${atkBonus}` : ""));
        defRoll = new Roll(defFormula + (defBonus ? `${defBonus > 0 ? "+" : ""}${defBonus}` : ""));
        await atkRoll.evaluate();
        await defRoll.evaluate();
        ClashManager.applyDiceRollMods(atkActor, atkRoll, { item: atkItem, isDefense: false });
        ClashManager.applyDiceRollMods(defActor, defRoll, { item: defItem, isDefense: true });
        atkCur = atkRoll.total ?? 0;
        defCur = defRoll.total ?? 0;
      }

      const aParts = partsOf("atk", atkCur);
      const dParts = partsOf("def", defCur);
      const aEff = sum(aParts), dEff = sum(dParts);
      ClashTotalFX._log(`连击第 ${round} 次：` +
        `攻 ${aEff}（行动值 ${apOf(atkActor)}，公式 ${atkFormula}）` +
        ` vs 守 ${dEff}（行动值 ${apOf(defActor)}，公式 ${defFormula}）`);

      await ClashTotalFX.play({
        atkParts: aParts, defParts: dParts,
        rerollSides: round === 1 ? rerollSides : [],
        // 硬币 = 行动值：还能输几次，每输一次碎一枚
        atkCoins: apOf(atkActor), defCoins: apOf(defActor),
        atkDiceType: atkItem?.system?.diceType ?? "default",
        defDiceType: defItem?.system?.diceType ?? "default",
        // DiceSoNice 只在第一次交锋掷，之后的交锋数字滚一下即可
        startDice: round === 1
          ? () => ClashManager._showDiceEach([
              { roll: atkRoll, actor: atkActor }, { roll: defRoll, actor: defActor },
            ])
          : null,
      });

      // 斥力：分出胜负后双方一起被震开，胜方随即瞬移追回贴身；
      // 撞墙的一方触发【震颤引爆】
      if (aEff !== dEff) {
        await ClashKnockback.repel({
          winner: aEff > dEff ? atkActor : defActor,
          loser:  aEff > dEff ? defActor : atkActor,
          winScore: Math.max(aEff, dEff),
          chase: true,
          onWallHit: (actor) => ClashManager.seismicBlast(actor, 1,
            { attacker: aEff > dEff ? atkActor : defActor }),
        });
      }

      if (aEff === dEff) continue;                  // 平局：不扣行动值，再拼一次

      const atkWon = aEff > dEff;
      const loser  = atkWon ? defActor : atkActor;
      // 【不可摧毁】：拼点失败照样能打回去，所以它的币只要坏掉一枚，连击当场结束
      const loserUnbreak =
        (atkWon ? defItem : atkItem)?.system?.diceType === "unbreakable";

      // 输掉这一次就要扣一点行动值（币碎一枚）——刀剑相击处炸一朵
      if (apOf(loser) > 0) {
        ClashVFX.broadcastBurst(ClashVFX.midPoint(atkActor, defActor));
        await ClashManager._safeDocUpdate(loser, { "system.ap.value": apOf(loser) - 1 });
      }

      // 行动值耗尽、或败方用的是【不可摧毁】：这一次定胜负
      if (loserUnbreak || apOf(loser) <= 0) {
        winSide  = atkWon ? "atk" : "def";
        winRoll  = atkWon ? atkRoll : defRoll;
        winParts = atkWon ? aParts : dParts;
        ClashTotalFX._log(loserUnbreak
          ? "【不可摧毁】的币被打坏，连击结束，随后由它反击"
          : "行动值耗尽，连击结束");
        break;
      }
    }

    // 胜负已定 → 单独为胜方演一次【伤害计算】：点数与决胜那次一致，不重掷，
    // 但这一掷会真的把骰子摆出来（DiceSoNice）
    if (winSide) {
      const winActor = winSide === "atk" ? atkActor : defActor;
      await ClashTotalFX.playSolo({
        side: winSide, parts: winParts, label: ClashTotalFX.LABEL_DAMAGE,
        coins: apOf(winActor),
        diceType: (winSide === "atk" ? atkItem : defItem)?.system?.diceType ?? "default",
        startDice: () => ClashManager._showDiceEach([{ roll: winRoll, actor: winActor }]),
      });

      // 最后一击同样有斥力，但胜方不再追击
      const loseActor = winSide === "atk" ? defActor : atkActor;
      await ClashKnockback.repel({
        winner: winActor, loser: loseActor,
        winScore: winParts.reduce((a, p) => a + (p.value ?? 0), 0),
        chase: false,
        onWallHit: (actor) => ClashManager.seismicBlast(actor, 1, { attacker: winActor }),
      });
    }

    return { atkTotal: atkCur, defTotal: defCur, rounds: round };
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
    if (Object.keys(update).length) await ClashManager._safeDocUpdate(actor, update);
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

    // 指定目标：发起时若拖拽到某个 token 上，则只有该角色能承受
    if (initFlags.targetActorId && selActor.id !== initFlags.targetActorId) {
      const tgtName = game.actors.get(initFlags.targetActorId)?.name ?? "指定目标";
      ui.notifications.warn(`本次对抗已指定目标【${tgtName}】，其他角色无法承受`);
      return;
    }

    const atkActor  = game.actors.get(initFlags.attackerId);
    const defActor  = selActor;
    // 单方面攻击（承受）的 TOTAL 演出：只有攻击方一条黑条，无胜负判定
    if (initFlags.rollData) {
      const takeRoll  = Roll.fromJSON(JSON.stringify(initFlags.rollData));
      const takeBase  = initFlags.baseFormula ?? initFlags.formula ?? "";
      const takeBonus = parseInt(String(initFlags.formula ?? "").slice(takeBase.length)) || 0;
      await ClashTotalFX.playSolo({
        side:  "atk",
        coins: atkActor?.system?.ap?.value ?? 0,
        parts: ClashManager._buildTotalParts({
          actor: atkActor, opponent: selActor,
          rollTotal: initFlags.rollTotal ?? 0, bonus: takeBonus,
          baseFormula: takeBase, category: initFlags.category ?? "",
          isDefender: false, includeClashPower: false,
        }),
        startDice: () => ClashManager._showDiceEach([{ roll: takeRoll, actor: atkActor }]),
      });
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
        // 重投同样走单条 TOTAL 演出，带【公式重投】标记
        await ClashTotalFX.playSolo({
          side:   "atk",
          reroll: true,
          coins:  atkActor?.system?.ap?.value ?? 0,
          parts:  ClashManager._buildTotalParts({
            actor: atkActor, opponent: baseActor,
            rollTotal: rerollAtk.total, bonus: parseInt(bonusPart) || 0,
            baseFormula: newAtkBase, category: initFlags.category ?? "",
            isDefender: false, includeClashPower: false,
          }),
          startDice: () => ClashManager._showDiceEach([{ roll: rerollAtk, actor: atkActor }]),
        });
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
    await ClashManager._applyAndSendTake(baseActor, finalDamage, { calcNotes, attacker: atkActor, hookMsgs: _buffHookMsgs2, category, sinType, item: atkItem2 });
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
    await ClashManager._applyAndSendTake(defActor, finalDamage, { calcNotes, attacker: atkActor, hookMsgs: _buffHookMsgsCl, category, sinType,
      item: atkActor?.items?.get(flags.itemId ?? "") ?? null });
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
        ${ClashManager._chatHeader(loserActor, "不可摧毁拼点失败反击")}
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
  static async _applyAndSendTake(actor, damage, { isSeismic = false, calcNotes = [], attacker = null, hookMsgs = null, takeLabel = "承受", category = "", sinType = "", item = null } = {}) {
    const sys   = actor.system;
    const maxHp = sys.hp?.max ?? 1;

    // ── 出手前：攻击方自定义 BUFF 的伤害修正钩子（与下方进入侧对称）──────
    // 返回 { damage?: number, note?: string } 覆盖本次打出的伤害。
    if (attacker) {
      for (const buff of foundry.utils.deepClone(attacker.system?.buffs ?? [])) {
        const handler = resolveBuffHandler(buff);
        if (typeof handler?.modifyOutgoingDamage !== "function") continue;
        const result = handler.modifyOutgoingDamage(attacker, buff, {
          damage, target: actor, category, sinType, item,
        });
        if (!result || typeof result !== "object") continue;
        if (typeof result.damage === "number") damage = Math.max(0, result.damage);
        if (result.note) calcNotes.push(result.note);
      }
    }

    // ── 受到伤害前：自定义 BUFF 伤害覆盖钩子（如【百折不挠】：伤害归零 + 生命值锁定）──
    // hpLockValue 非 null 时，本次结算跳过护盾/破裂/沉沦/震颤，HP 直接钉死为该值。
    let hpLockValue = null;
    for (const buff of foundry.utils.deepClone(actor.system?.buffs ?? [])) {
      const handler = resolveBuffHandler(buff);
      if (typeof handler?.modifyIncomingDamage !== "function") continue;
      const result = handler.modifyIncomingDamage(actor, buff, { damage, attacker, source: "clash" });
      if (result && typeof result === "object") {
        if (typeof result.damage === "number") damage = result.damage;
        if (typeof result.hpLock === "number")  hpLockValue = result.hpLock;
      }
    }

    // ── 受到伤害时 BUFF ────────────────────────────────────────────────────

    let ruptureDmg = 0, sanityDmg = 0, tremorTriggered = false, sinkingBuff = null;
    if (hpLockValue == null) {
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
      if (ruptureBuff && ruptureBuff.stacks > 0) {
        ruptureDmg = ruptureBuff.intensity ?? 0;
        await ClashManager._reduceBuffStacks(actor, "rupture");
        await ClashManager._tickFieldResources("rupture", ruptureBuff.intensity ?? 0, 1);
      }

      // 【沉沦】：增加强度点侵蚀度（降低理智），层数-1
      sinkingBuff = ClashManager._getBuff(actor, "sinking");
      if (sinkingBuff && sinkingBuff.stacks > 0) {
        sanityDmg = sinkingBuff.intensity ?? 0;
        await ClashManager._reduceBuffStacks(actor, "sinking");
        await ClashManager._tickFieldResources("sinking", sinkingBuff.intensity ?? 0, 1);
      }

      // 【震颤】：受到震颤引爆攻击时，混乱阈值前移强度值，层数-1
      if (isSeismic) {
        const { blasts } = await ClashManager.seismicBlast(actor, 1, { attacker });
        tremorTriggered = blasts > 0;
      }
    }

    // ── HP 结算（基础伤害 + 破裂附加；生命值锁定时直接钉死为 hpLockValue） ──
    const totalDmg = damage + ruptureDmg;
    const oldHp    = sys.hp?.value ?? 0;
    const newHp    = hpLockValue != null ? hpLockValue : Math.max(0, oldHp - totalDmg);

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

    // 更新 HP —— 承受方可能不属于当前玩家（如攻击方客户端结算反击伤害），
    // 必须走 _safeDocUpdate 由 GM 代理，否则会抛 lacks permission
    await ClashManager._safeDocUpdate(actor, { "system.hp.value": newHp });

    // 沉沦：更新理智值（setSanity 内部会检查恐慌状态）；
    // 若理智因此跌至下限 5，额外造成【沉沦】强度等级的【忧郁】罪孽伤害（按目标忧郁抗性结算）
    let sinkingGloomDmg = 0;
    if (sanityDmg > 0 && typeof actor.setSanity === "function") {
      await actor.setSanity((actor.system.sanity?.value ?? 50) - sanityDmg);
      if ((actor.system.sanity?.value ?? 50) === 5) {
        const gloomMult = ClashManager._parseResistance(actor.system?.egoResistances?.gloom ?? "x1.0");
        sinkingGloomDmg = Math.max(0, Math.round((sinkingBuff?.intensity ?? 0) * gloomMult));
        if (sinkingGloomDmg > 0) {
          const curHp2 = actor.system.hp?.value ?? 0;
          await ClashManager._safeDocUpdate(actor, { "system.hp.value": Math.max(0, curHp2 - sinkingGloomDmg) });
        }
      }
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

    // 沉沦忧郁追加伤害发生在 HP 结算之后，需将最终 HP 一并传给聊天框显示
    // （生命值锁定时 sinkingGloomDmg 恒为 0，finalHp 与 newHp 一致，仍钉死为 hpLockValue）
    const finalHp = Math.max(0, newHp - sinkingGloomDmg);
    await ClashManager._sendTakeMsg(actor, damage, oldHp, finalHp, maxHp, chaosTriggered,
      { ruptureDmg, sanityDmg, sinkingGloomDmg, tremorTriggered, chaosName, calcNotes, takeLabel });
  }

  static async _sendTakeMsg(actor, damage, oldHp, newHp, maxHp, chaosTriggered,
      { ruptureDmg = 0, sanityDmg = 0, sinkingGloomDmg = 0, tremorTriggered = false, chaosName = "陷入混乱", calcNotes = [], takeLabel = "承受" } = {}) {
    const hpPct    = Math.max(0, Math.round((newHp / maxHp) * 100));
    const totalDmg = damage + ruptureDmg + sinkingGloomDmg;
    const extraLines = [];
    if (ruptureDmg   > 0) extraLines.push(`【破裂】附加 +${ruptureDmg} 点固定伤害`);
    if (sanityDmg    > 0) extraLines.push(`【沉沦】附加 ${sanityDmg} 点侵蚀度（理智-${sanityDmg}）`);
    if (sinkingGloomDmg > 0) extraLines.push(`【沉沦】理智见底：额外受到 ${sinkingGloomDmg} 点【忧郁】伤害`);
    if (tremorTriggered)  extraLines.push(`【震颤】引爆：混乱阈值前移`);

    const content = `
      <div class="limbus-clash-card limbus-take-card"
           style="background:linear-gradient(180deg,#2D0509 0%,#1A0305 100%);"
           data-clash-type="take">
        ${ClashManager._chatHeader(actor, takeLabel)}
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
    // 格挡改为先给自己叠等同于格挡骰数的【护盾】，再由攻击方结算完整伤害：
    // 护盾在承受结算里逐点抵挡，用不完的部分会留到后面继续挡
    const finalDamage  = Math.max(0, rawDamage);
    if (defEffective > 0) await ClashManager._addBuff(defActor, "shield", 0, defEffective);

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
      `${defActor?.name ?? "?"} 获得 <strong>${defEffective}</strong> 层【护盾】`,
      `伤害 ${adjustedAtk}${resNote} → ${rawDamage} 点（由【护盾】逐点抵挡，未挡下的部分才会扣血）`,
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
          ${defEffective >= rawDamage ? `<div style="color:#6EE06E;font-weight:bold;">✓ 护盾足以挡下本次伤害！</div>` : ""}
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
      // 仅 character 参与反应（camp/loot/merchant 等容器型 Actor 的
      // 嵌入物品——如营地仓库存放的装备——不应触发反应）
      if (actor.type !== "character") continue;
      // 只处理当前用户拥有控制权的 actor，避免多端重复弹框
      if (!actor.isOwner) continue;
      for (const item of actor.items) {
        const activities = item.system?.activities ?? [];
        for (const act of activities) {
          if (act.trigger !== "反应") continue;
          const preconditions = Array.isArray(act.preconditions) ? act.preconditions
            : (act.precondition ? [act.precondition] : []);
          // AND 逻辑：所有前置条件均需满足
          let triggered = true;
          for (const pre of preconditions) {
            if (!await ClashManager._evalReactionPrecond(pre, actor, attacker, defender, lastSkillUuid)) {
              triggered = false;
              break;
            }
          }
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
  static async _evalReactionPrecond(pre, actor, attacker, defender, lastSkillUuid) {
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
      const dim = pre.perNDim === "intensity" ? "intensity" : "stacks";
      const haveVal = dim === "intensity" ? (found.intensity ?? 0) : (found.stacks ?? 0);
      const n = pre.stacks ?? 1;
      return n > 0 && (haveVal % n === 0);
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
      // lastSkillUuid 恒来自攻击方技能（广播时固定传 atkItem.uuid），故施放者视为 attacker
      if (!lastSkillUuid || !attacker) return false;
      const scope = await ClashManager._resolveTargets(pre.target ?? "self", actor, attacker, pre);
      if (!scope.some(a => a.id === attacker.id)) return false;
      if (pre.skillUuid) return pre.skillUuid.trim() === lastSkillUuid.trim();
      if (pre.skillNameOrTag) {
        const val = pre.skillNameOrTag.trim();
        if (!val) return false;
        const skillItem = await fromUuid(lastSkillUuid).catch(() => null);
        if (!skillItem) return false;
        if (skillItem.name === val) return true;
        const tags = String(skillItem.system?.tags ?? "").split("/").map(t => t.trim()).filter(Boolean);
        return tags.includes(val);
      }
      return false;
    }

    if (type === "category") {
      // 使用分类：检查本次对抗使用的技能（lastSkillUuid）分类是否命中所选项之一
      if (!lastSkillUuid) return false;
      const cats = Array.isArray(pre.categories) ? pre.categories : [];
      if (cats.length === 0) return false;
      const skillItem = await fromUuid(lastSkillUuid).catch(() => null);
      if (!skillItem) return false;
      return cats.includes(skillItem.system?.category);
    }

    if (type === "level") {
      // 使用等级：检查本次对抗使用的技能（lastSkillUuid）等级是否满足比较条件
      if (!lastSkillUuid) return false;
      const skillItem = await fromUuid(lastSkillUuid).catch(() => null);
      if (!skillItem) return false;
      return ClashManager._cmp(skillItem.system?.level ?? 0, pre.comparison ?? "eq", pre.level ?? 1);
    }

    return false;
  }

  /**
   * 判断某个技能/物品是否与"使用技能"前置条件描述的对象一致。
   * UUID 精确匹配优先；否则按 [技能名称] 或 [标签]（任一满足）匹配。
   * @param {Item} skillItem
   * @param {{skillUuid?:string, skillNameOrTag?:string}} pre
   */
  static _matchSkillIdentity(skillItem, pre) {
    if (!skillItem) return false;
    if (pre.skillUuid) return skillItem.uuid === pre.skillUuid.trim();
    if (pre.skillNameOrTag) {
      const val = pre.skillNameOrTag.trim();
      if (!val) return false;
      if (skillItem.name === val) return true;
      return ClashManager._itemTags(skillItem).includes(val);
    }
    return false;
  }

  /** 读取技能物品的标签数组（system.tags 兼容数组与"标签1/标签2"字符串两种存法） */
  static _itemTags(item) {
    const raw = item?.system?.tags;
    const arr = Array.isArray(raw) ? raw : String(raw ?? "").split("/");
    return arr.map(t => String(t).trim()).filter(Boolean);
  }

  /**
   * 在角色的技能列表中按 [标签] + [等级] 检索技能。
   * @param {Actor}  actor
   * @param {string} tag   技能标签（skill-tags，system.tags）
   * @param {number} level 技能等级（skill-level-badge，system.level）；0 = 不限
   * @returns {Item|null}  命中的第一个技能
   */
  static _findSkillByTagLevel(actor, tag, level = 0) {
    const key = String(tag ?? "").trim();
    if (!actor || !key) return null;
    return (actor.items ?? []).find(it =>
      it.type === "skill" &&
      ClashManager._itemTags(it).includes(key) &&
      (!(level > 0) || (it.system?.level ?? 0) === level)
    ) ?? null;
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
      if (eff?.skillRef === "name") {
        // 按名字在角色背包/技能列表中检索：比 UUID 更稳定（合集包提取后 UUID 会变，名字不变）
        const name = (eff.skillName ?? "").trim();
        if (!name) return;
        skillItem = (actor.items ?? []).find(it => it.type === "skill" && it.name === name) ?? null;
        if (!skillItem) {
          ui.notifications.warn(`反应：背包中找不到技能【${name}】`);
          return;
        }
      } else {
        // 标签+等级
        const tag = (eff?.skillTag ?? "").trim();
        const lv  = parseInt(eff?.skillLevel) || 0;
        if (!tag) return;
        skillItem = ClashManager._findSkillByTagLevel(actor, tag, lv);
        if (!skillItem) {
          ui.notifications.warn(`反应：背包中找不到标签为【${tag}】${lv > 0 ? ` Lv.${lv}` : ""}的技能`);
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
      if (curAP <= 0) await ClashManager._safeDocUpdate(actor, { "system.ap.value": 1 });
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

    // 玩家委托 GM 推进战斗轮次（Combat 文档玩家无写权限）
    // 由快捷 HUD 的"下个回合"按钮发起；GM 侧再次校验确实轮到该玩家控制的角色，
    // 防止其他客户端伪造消息抢跳回合。
    if (msg.type === "gmNextTurn") {
      if (!game.user.isGM) return;
      const combat = msg.combatId ? game.combats.get(msg.combatId) : game.combat;
      if (!combat?.started) return;
      const sender = msg.userId ? game.users.get(msg.userId) : null;
      const cur    = combat.combatant?.actor;
      if (!sender || !cur?.testUserPermission?.(sender, "OWNER")) {
        console.warn("[ClashManager] gmNextTurn: 发起者并非当前行动角色的拥有者，已忽略");
        return;
      }
      try {
        await combat.nextTurn();
      } catch (err) {
        console.error("[ClashManager] gmNextTurn 失败:", err);
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
