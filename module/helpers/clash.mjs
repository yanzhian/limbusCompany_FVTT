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
                            category = "", counterType = "", sinType = "",
                            isDefender = false, includeClashPower = true }) {
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

    // 条件威力（斩/打/突 + 七宗罪各一对）：本骰对得上才计入，攻守骰都吃
    for (const p of ClashManager._condPowerParts(actor, { category, counterType, sinType })) {
      parts.push(p);
    }

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
    return entries.map(e => {
      // 只有真正的 Roll 才喂给 DiceSoNice——委托 GM 结算时防守骰可能只是
      // 一个 { total } 的替身对象，丢进去会在 DiceNotation 里炸
      const roll = e?.roll;
      if (!roll || !Array.isArray(roll.dice)) return Promise.resolve();
      try {
        return game.dice3d.showForRoll(roll, ClashManager._diceUserFor(e.actor), true, null, false)
          .catch(() => {});
      } catch (err) {
        console.warn("[ClashManager] DiceSoNice 播放失败，已跳过:", err);
        return Promise.resolve();
      }
    });
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
  static async _safeDocUpdate(doc, data, options = {}) {
    if (!doc) return;
    if (doc.canUserModify?.(game.user, "update")) {
      return doc.update(data, options);
    }
    game.socket?.emit("system.limbusCompany_FVTT", {
      type: "gmDocUpdate",
      uuid: doc.uuid,
      data,
      options,
    });
  }

  /**
   * 安全删除文档：若当前用户无权限，通过 socket 委托 GM 执行。
   * 与 _safeDocUpdate 成对——玩家把营地容器里的物品取走时，
   * 源物品属于营地 Actor，玩家删不掉，只能请 GM 代劳。
   */
  static async _safeDocDelete(doc) {
    if (!doc) return;
    if (doc.canUserModify?.(game.user, "delete")) {
      return doc.delete();
    }
    game.socket?.emit("system.limbusCompany_FVTT", {
      type: "gmDocDelete",
      uuid: doc.uuid,
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

  /**
   * 本骰的**物理分类**（斩/打/突）。
   * 攻击骰直接看 category；守备骰里只有【反击】【可拼点反击】带物理类型，
   * 看 counterType；闪避与格挡没有物理类型，返回空串。
   */
  static _physCatOf({ category = "", counterType = "" } = {}) {
    if (["slash", "blunt", "pierce"].includes(category)) return category;
    if (category === "counter" || category === "clashCounter") return counterType || "";
    return "";
  }

  /**
   * 【条件威力】BUFF 的有效骰数修正：与强壮/虚弱同为每层 ±1，
   * 但只有本骰的物理分类 / 罪孽对得上才计入（见 config 的 COND_POWER_BUFFS）。
   * 攻击骰与守备骰都吃，含反击与可拼点反击。
   * @returns {{name:string, value:number}[]} 明细（供 TOTAL 分段展示，无修正则为空数组）
   */
  static _condPowerParts(actor, meta = {}) {
    if (!actor) return [];
    const M = CONFIG.LIMBUSCOMPANY?.COND_POWER_BUFFS ?? {};
    const gs = (t) => ClashManager._getBuffVal(actor, t).stacks;
    const keys = [ClashManager._physCatOf(meta), meta.sinType ?? ""];
    const parts = [];
    for (const key of keys) {
      const d = M[key];
      if (!d) continue;
      const up = gs(d.up), down = gs(d.down);
      if (up)   parts.push({ name: `${d.label}威力提升`, value:  up });
      if (down) parts.push({ name: `${d.label}威力降低`, value: -down });
    }
    return parts;
  }

  /** 上面那些明细的合计值（结算用） */
  static _condPowerMod(actor, meta = {}) {
    return ClashManager._condPowerParts(actor, meta).reduce((s, p) => s + p.value, 0);
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
  /**
   * 「已装备」前置的匹配：名称 / 标签 / 分类三个筛选条件都是可选的，
   * 填了的才检查，多个同时填则需全部命中（AND）。
   * @param {Item}   item 装备格里的物品
   * @param {object} pre  { equipName, equipTag, equipCategory }
   */
  static _matchEquipFilter(item, pre) {
    if (!item) return false;
    const name = String(pre?.equipName ?? "").trim();
    const tag  = String(pre?.equipTag ?? "").trim();
    const cat  = String(pre?.equipCategory ?? "").trim();
    if (name && item.name !== name) return false;
    if (cat  && String(item.system?.category ?? "").trim() !== cat) return false;
    if (tag) {
      if (!ClashManager._itemTags(item).includes(tag)) return false;
    }
    // 三个都没填 = 只要装备格里有东西就算
    return true;
  }

  /**
   * 取装备格里指定部位的装备（武器/上装/下装/饰品）。
   * 部位用 subtype 判定；武器/饰品可能有多件，返回全部。
   * @param {Actor}  actor
   * @param {string} slot  weapon / upper / lower / accessory；空 = 不限部位
   */
  static _getEquippedBySlot(actor, slot) {
    const list = ClashManager._getEquippedItems(actor);
    if (!slot) return list;
    return list.filter(it => (it.system?.subtype ?? "") === slot);
  }

  /**
   * 【范围修改】的落点：当前**已装备的武器**。
   * 多把武器时优先取已激活（isActive）的那把，没有激活标记就取第一把。
   */
  static _activeWeaponOf(actor) {
    const weapons = ClashManager._getEquippedBySlot(actor, "weapon");
    if (!weapons.length) return null;
    return weapons.find(w => w.system?.isActive) ?? weapons[0];
  }

  /** 该角色装备格里符合条件的装备件数 */
  static _countEquipped(actor, pre) {
    return ClashManager._getEquippedItems(actor)
      .filter(it => ClashManager._matchEquipFilter(it, pre)).length;
  }

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

  /**
   * 【跳动伤害】的统一落地（与烧伤/流血同一条道）。
   *
   * 与 _applyAndSendTake（攻击伤害）的区别——这才是"DOT 不触发 DOT"的落点：
   *   · **不**吃护盾，**不**触发【破裂】【沉沦】，**不**发独立的承受聊天卡
   *   · **不**广播 onAllyHpDamage（那条只认"承受结算"出来的攻击伤害）
   *   · 仍走 applyTickDamageMods（BUFF 的伤害修正 / 生命值下限保护）
   *   · 仍检查混乱阈值 —— 与烧伤、流血保持一致
   *
   * @param {string} source 伤害来源标识，透传给 modifyIncomingDamage / beforeChaos
   * @returns {Promise<number>} 实际掉的血量
   */
  static async _applyTickDamage(actor, amount, { source = "tick" } = {}) {
    if (!actor || !(amount > 0)) return 0;
    const mods  = ClashManager.applyTickDamageMods(actor, amount, source);
    const dmg   = Math.max(0, Math.round(mods.damage));
    if (dmg <= 0) return 0;
    const oldHp = actor.system?.hp?.value ?? 0;
    const newHp = ClashManager.applyHpFloor(oldHp, oldHp - dmg, mods.hpFloor);
    await ClashManager._safeDocUpdate(actor, { "system.hp.value": newHp });
    if (actor.checkAndTriggerChaos) {
      await actor.checkAndTriggerChaos(newHp, oldHp, { silent: true, source });
    }
    return oldHp - newHp;
  }

  /**
   * 【受到攻击】的队伍广播：任一友方（含受伤者自己）被打掉体力时，通知**本队所有人**
   * 身上带 onAllyHpDamage 钩子的 BUFF。
   *
   * 与 onTakeDamage 的区别：onTakeDamage 只通知受伤者自己身上的 BUFF，
   * 这个通知的是整队——用于「友方受到攻击时我获得…」这类挂在别人身上也生效的 BUFF。
   *
   * **只在攻击伤害上广播**（对抗、反击、承受、容量扩散、追加伤害），
   * 烧伤/流血/破裂这类跳动伤害不算"受到攻击"，不走这里。
   *
   * 边界（都是有意为之，别再往回补）：
   * · 【破裂】的附加固定伤害**算**——它并进了主伤害的 totalDmg，本来就在 amount 里
   * · 【沉沦】理智见底追加的忧郁伤害**不算**——那更像沉沦自己的跳动伤害，
   *   它在本方法调用之后才扣 HP，不计入 amount
   * · 效果编辑器的 hpAdj、以 HP 为代价的 attribute 消耗**都不算**（不是挨打）
   * · 非 linked token 的 HP 镜像同步不是第二次伤害事件，不要在那里再广播一遍
   *
   * @param {Actor} victim   实际掉血的人
   * @param {number} amount  实际掉的血量（护盾吸收、下限保护之后的真实数字；0 不广播）
   * @param {Actor|null} attacker 攻击者
   */
  static async _dispatchAllyHpDamage(victim, amount, attacker = null) {
    if (!victim || !(amount > 0)) return;
    const team = await ClashManager._resolveTargets("allTeam", victim, null);
    // 不在任何小队里时至少通知受伤者自己
    const scope = team.length ? team : [victim];
    for (const ally of scope) {
      for (const buff of foundry.utils.deepClone(ally.system?.buffs ?? [])) {
        const handler = resolveBuffHandler(buff);
        if (typeof handler?.onAllyHpDamage !== "function") continue;
        await handler.onAllyHpDamage(ally, buff, {
          victim, amount, attacker,
          addBuff:   (type, i, st, when) => ClashManager._addBuff(ally, type, i, st, when),
          addBuffTo: (tgt, type, i, st, when) => ClashManager._addBuff(tgt, type, i, st, when),
          getBuff:   (type) => ClashManager._getBuff(ally, type),
        });
      }
    }
  }

  /**
   * [攻击时] 的 BUFF 钩子派发（与 `[攻击时]` Activity 同一时点）。
   * 用于"攻击时把自己转成别的 BUFF"这类效果；返回字符串则并入活动消息。
   * @param {Actor} actor 出这一骰的人
   * @param {Item}  item  本次使用的技能/物品
   */
  static async _dispatchOnAttack(actor, item, ctx) {
    if (!actor) return;
    for (const buff of foundry.utils.deepClone(actor.system?.buffs ?? [])) {
      const handler = resolveBuffHandler(buff);
      if (typeof handler?.onAttack !== "function") continue;
      const note = await handler.onAttack(actor, buff, {
        item,
        category:    item?.system?.category    ?? "",
        counterType: item?.system?.counterType ?? "",
        sinType:     item?.system?.sinType     ?? "",
        addBuff:   (type, i, st, when) => ClashManager._addBuff(actor, type, i, st, when),
        addBuffTo: (tgt, type, i, st, when) => ClashManager._addBuff(tgt, type, i, st, when),
        getBuff:   (type) => ClashManager._getBuff(actor, type),
      });
      if (typeof note === "string" && note) {
        (ctx?._actMsgs ?? []).push({
          trigger: "攻击时",
          itemName: handler.label ?? buff.name ?? buff.type,
          msgs: [note],
        });
      }
    }
  }

  /**
   * [受到伤害时] 的统一派发：受伤者的技能 + 装备格物品的 Activity，
   * 外加自定义 BUFF 的 onTakeDamage 钩子（返回字符串则并入本次结算的活动消息）。
   * @param {Item}  item     受伤方本次用的技能（可能为 null）
   * @param {Actor} actor    受伤的人
   * @param {Actor} attacker 打伤他的人
   */
  static async _dispatchTakeDamage(item, actor, attacker, ctx) {
    if (item) await ClashManager._applyActivities(item, "受到伤害时", ctx);
    for (const eq of ClashManager._getEquippedItems(actor)) {
      await ClashManager._applyActivities(eq, "受到伤害时", ctx);
    }
    for (const buff of foundry.utils.deepClone(actor?.system?.buffs ?? [])) {
      const handler = resolveBuffHandler(buff);
      if (typeof handler?.onTakeDamage !== "function") continue;
      const note = await handler.onTakeDamage(actor, buff, {
        attacker,
        addBuff:   (type, i, st, when) => ClashManager._addBuff(actor, type, i, st, when),
        addBuffTo: (tgt, type, i, st, when) => ClashManager._addBuff(tgt, type, i, st, when),
        getBuff:   (type) => ClashManager._getBuff(actor, type),
      });
      if (typeof note === "string" && note) {
        (ctx?._actMsgs ?? []).push({
          trigger: "受到伤害时",
          itemName: handler.label ?? buff.name ?? buff.type,
          msgs: [note],
        });
      }
    }
  }

  /**
   * 该物品此刻是否"在场上生效"——决定它的 [反应] 要不要参与检查。
   *
   * · 装备：必须在装备格（slot0~8）里，背包里躺着的不算
   *   （不然谁包里有一件，谁就被问一次）
   * · 技能与其他类型：不作限制。技能不一定装在槽里——【援护防御】专属技能、
   *   由反应/效果调用的衍生技能都是搁在技能列表里备用的，照样要能触发。
   */
  static _isItemInPlay(actor, item) {
    if (!actor || !item) return false;
    if (item.type === "equipment") {
      return ClashManager._getEquippedItems(actor).some(it => it.id === item.id);
    }
    return true;
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

  /**
   * 数值会被「每 N」倍数缩放的效果类型。
   * 倍数为 0（一倍都不够）时，这些效果整条跳过——不然 addBuff 会加 0 层、
   * seismicBlast 会被 Math.max(1,…) 兜底成 1 次，全是错的。
   * 不在这个集合里的效果（diceTypeChg / removeBuff / rangeChg / triggerBuff…）
   * 与倍数无关，0 倍时照常执行。
   */
  static PER_SCALED_EFFECTS = new Set([
    "addBuff", "randomBuff", "hpAdj", "sanityAdj", "apAdj", "atkAdj", "defAdj",
    "weightAdj", "diceAdj", "diceFacesAdj", "baseValue",
    "fieldResource", "seismicBlast", "extraDamage",
  ]);

  static async _applyActivitiesAndEquip(item, trigger, ctx) {
    await ClashManager._applyActivities(item, trigger, ctx);
    const owner = ctx.owner ?? null;
    if (!owner) return;
    for (const eq of ClashManager._getEquippedItems(owner)) {
      await ClashManager._applyActivities(eq, trigger, ctx);
    }

    // ── 自定义 BUFF onHit 钩子（如【本国剑术】）─────────────────────────
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
          // 本次实际打出的那张骰的罪孽（花札三色靠它判色）
          sinType:  item?.system?.sinType ?? "",
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
    // 注意：效果编辑器里的自定义 BUFF 是以中文名当 type 传进来的（如 "怨恨纹身"），
    // 只按 type 精确查注册表会查不到，导致 maxStacks / maxGainPerRound 形同虚设。
    // 这里补一次按显示名的回退匹配。
    const customHandler = CustomBuffRegistry.get(type)
      ?? resolveBuffHandler({ type, name: ClashManager._buffLabel(type) });
    const maxStacks     = customHandler?.maxStacks    ?? Infinity;
    const maxIntensity  = customHandler?.maxIntensity ?? Infinity;
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
      if (allowed <= 0) {
        // 本回合该 BUFF 的获得额度已用尽。这里以前是静默 return，
        // 结果是"技能明明写了加 6 层却一层没加"且毫无提示，很难查。
        // 只提示自己能改的角色，免得群体效果刷屏。
        if (actor?.isOwner) {
          ui.notifications?.info(
            `【${customHandler?.label ?? ClashManager._buffLabel(type)}】本回合已达获得上限（${maxGainPerRound} 层）。`);
        }
        return;
      }
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
        buffs[idx].intensity = Math.min(intensity, maxIntensity);
      } else {
        buffs[idx].stacks    = Math.min((buffs[idx].stacks ?? 0) + stacks, maxStacks);
        buffs[idx].intensity = Math.min((buffs[idx].intensity ?? 0) + intensity, maxIntensity);
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
        intensity: Math.min(intensity, maxIntensity),
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
          // 【震颤】是一种特殊 DOT（触发条件是"被引爆"），因此它打出来的伤害
          // 走**跳动通道**而非承受结算：不触发【破裂】【沉沦】，也不计入
          // 【寄宿怨恨的剑鞘】那类"受到攻击"的统计。抗性照常结算。
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
            return ClashManager._applyTickDamage(tgtActor, dmg, { source: "tremor" });
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
   * @param {{targetTag?:string, targetTagCount?:number, targetTagMax?:number}} [meta]
   *        target==="bgTag" 时使用；targetTagMax=0 表示人数不限
   * @param {object|null} [ctx] Activity 上下文，target==="covered" 时用来取被援护的队友
   */
  static async _resolveTargets(targetType, owner, other, meta = {}, ctx = null) {
    if (targetType === "self")   return owner ? [owner] : [];
    if (targetType === "target") return other ? [other] : [];
    // 【援护防御】顶上来时，被自己替下的那个队友（没走援护流程时无目标）
    if (targetType === "covered") return ctx?.coveredForActor ? [ctx.coveredForActor] : [];

    const ownerId = owner?.id;
    let team1Ids = [], team2Ids = [];
    try { team1Ids = game.settings.get("limbusCompany_FVTT", "squadTeam1") ?? []; } catch { /* 未注册时忽略 */ }
    try { team2Ids = game.settings.get("limbusCompany_FVTT", "squadTeam2") ?? []; } catch { /* 未注册时忽略 */ }

    const inTeam1  = team1Ids.includes(ownerId);
    const inTeam2  = !inTeam1 && team2Ids.includes(ownerId);
    const myIds    = inTeam1 ? team1Ids : inTeam2 ? team2Ids : [];
    const foeIds   = inTeam1 ? team2Ids : inTeam2 ? team1Ids : [];
    const toActors = ids => ids.map(id => game.actors.get(id)).filter(Boolean);

    // 至多人数：0 = 不限；超出时随机抽 N 人——战场本来就乱，谁被顾上是随机的
    const capMulti = (list) => {
      const maxN = Math.max(0, meta?.targetTagMax ?? 0);
      return maxN > 0 ? ClashManager._pickRandom(list, maxN) : list;
    };

    if (targetType === "bgTag" || targetType === "bgTagOther") {
      // 背景标签：本队中"背景带有该标签"的角色数量 ≥ targetTagCount 时，
      // 这些角色均视为合法目标；数量不足则视为无目标（效果不生效）。
      // "bgTagOther" 与 "allTeamOther" 同理：先排除拥有者自己（自己不受益），
      // "数量≥N"这个门槛也是排除自己之后、剩下的其他带标签队友数量来判定——
      // 如"为其他背景标签为X的友方（至少2个）恢复…"，指的是"除自己外还有
      // ≥2 个带该标签的队友"。
      // targetTagMax：最多对几人生效，0 = 不限；超出时按队伍顺序取前 N 人
      const tagName = (meta?.targetTag ?? "").trim();
      const minCount = Math.max(1, meta?.targetTagCount ?? 1);
      const maxCount = Math.max(0, meta?.targetTagMax ?? 0);
      if (!tagName) return [];
      const poolIds = myIds.length ? myIds : (ownerId ? [ownerId] : []);
      const filteredIds = targetType === "bgTagOther" ? poolIds.filter(id => id !== ownerId) : poolIds;
      const candidates = toActors(filteredIds);
      const matched = [];
      for (const actor of candidates) {
        const tags = await ClashManager._getBackgroundTags(actor);
        if (tags.includes(tagName)) matched.push(actor);
      }
      if (matched.length < minCount) return [];
      return maxCount > 0 ? ClashManager._pickRandom(matched, maxCount) : matched;
    }

    switch (targetType) {
      // 群体目标同样支持「至多人数」上限（0 = 不限，超出时按队伍顺序取前 N 人）
      case "allTeam":       return capMulti(toActors(myIds));
      case "allTeamOther":  return capMulti(toActors(myIds.filter(id => id !== ownerId)));
      case "allEnemy":      return capMulti(toActors(foeIds));
      case "allEnemyOther": return capMulti(toActors(foeIds.filter(id => id !== ownerId)));
      default:              return other ? [other] : [];
    }
  }

  /**
   * 从候选里随机抽 n 个（Fisher-Yates 洗牌后取前 n）。
   * n ≥ 候选数时原样返回。
   */
  static _pickRandom(list, n) {
    if (!Array.isArray(list) || n >= list.length) return list;
    const pool = [...list];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, n);
  }

  /** 解析角色背景物品的标签数组（"/" 分隔），解析失败返回空数组 */
  static async _getBackgroundTags(actor) {
    const bgUuid = actor?.system?.background?.uuid;
    if (!bgUuid) return [];
    const bg = await fromUuid(bgUuid).catch(() => null);
    return ClashManager._itemTags(bg);
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
      const actKey     = ClashManager._actCountKey(item, act, trigger);
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
      // 多个「每」前置是 AND 关系：都要满足才触发，倍数取其中最小的那个
      const perMultipliers = [];
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

        // ── useSin 类型：检查"本次实际打出的骰"的罪孽属性 ─────────────────
        // 与 category 同理：装备格触发时要看 ctx._currentItemId 指向的技能，
        // 取不到才退回 item 自身（如技能卡自己写的效果）。
        if (pre.type === "useSin") {
          const actingItem = (owner?.items?.get?.(ctx._currentItemId ?? "")) ?? item;
          const sins = Array.isArray(pre.sinTypes) ? pre.sinTypes
                     : (pre.sinType ? [pre.sinType] : []);
          if (!sins.length || !sins.includes(actingItem?.system?.sinType)) { precondFail = true; break; }
          continue;
        }

        // ── useSkill 类型：检查"本次由 owner 实际使用的技能"的名称/标签/UUID ──
        // 同上，优先取 ctx._currentItemId 指向的实际使用技能，取不到时退回 item 自身。
        if (pre.type === "useSkill") {
          const actingItem = (owner?.items?.get?.(ctx._currentItemId ?? "")) ?? item;
          if (!ClashManager._matchSkillIdentity(actingItem, pre)) { precondFail = true; break; }
          continue;
        }

        // ── level 类型（旧数据）：已并入 useSkill 的"等级"字段，保留兼容。
        // 编辑器打开旧数据时会自动转成 useSkill，存一次就不再走这里。
        if (pre.type === "level") {
          const actingItem = (owner?.items?.get?.(ctx._currentItemId ?? "")) ?? item;
          const lvl = actingItem?.system?.level ?? 0;
          if (!ClashManager._cmp(lvl, pre.comparison ?? "eq", pre.level ?? 1)) { precondFail = true; break; }
          continue;
        }

        // ── equipped 类型：检查装备格里符合条件的装备件数 ───────────────
        // 名称/标签/分类三个筛选可任意组合；"每 N 件"模式下件数还会变成后续
        // 效果的倍数（与 perN 共用 precondMultiplier）。
        if (pre.type === "equipped") {
          const precTgt = (pre.target ?? "self") === "self" ? owner : other;
          if (!precTgt) { precondFail = true; break; }
          const have = ClashManager._countEquipped(precTgt, pre);
          const need = Math.max(1, pre.count ?? 1);
          if (have < need) { precondFail = true; break; }
          if (pre.perEach) {
            let times = Math.floor(have / need);
            if ((pre.maxTimes ?? 0) > 0) times = Math.min(times, pre.maxTimes);
            perMultipliers.push(times);
          }
          continue;
        }

        // ── equipSlotCategory 类型（编辑器里叫【装备分类】）───────────────
        // 「若你 <部位> 的分类为 <X>」。分类可用 / 分隔多个，任一命中即可；
        // 部位留空 = 不限部位，只要装备格里有任意一件符合分类即可。
        if (pre.type === "equipSlotCategory") {
          const precTgt = (pre.target ?? "self") === "self" ? owner : other;
          if (!precTgt) { precondFail = true; break; }
          const wanted = String(pre.equipCategory ?? "")
            .split("/").map(x => x.trim()).filter(Boolean);
          const list = ClashManager._getEquippedBySlot(precTgt, pre.equipSlot ?? "");
          if (!list.length) { precondFail = true; break; }
          if (wanted.length) {
            const hit = list.some(it =>
              wanted.includes(String(it.system?.category ?? "").trim()));
            if (!hit) { precondFail = true; break; }
          }
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

        // ── allyTag 类型：检查"场上有没有符合条件的友方"────────────────
        // 用于「若有其他背景带有X的友方 → …」这类条件：目标沿用同一套群体
        // 目标（bgTag / bgTagOther / allTeamOther…），人数门槛复用 targetTagCount。
        // _resolveTargets 在人数不足时本就返回空数组，所以这里只需判空。
        if (pre.type === "allyTag") {
          const allies = await ClashManager._resolveTargets(
            pre.target ?? "bgTagOther", owner, other, pre, ctx);
          if (!allies.length) { precondFail = true; break; }
          // 「每有 1 名符合条件的友方」也可以当倍数用
          if (pre.perEach) {
            let times = allies.length;
            if ((pre.maxTimes ?? 0) > 0) times = Math.min(times, pre.maxTimes);
            perMultipliers.push(times);
          }
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
          perMultipliers.push(times);
        } else if (pre.type === "noBuff") {
          // 【未拥有】：【拥有】的反面——目标满足"拥有"的条件时本条不成立
          const has = !!buff
            && !((pre.intensity ?? 0) > 0 && (buff.intensity ?? 0) < pre.intensity)
            && !((pre.stacks    ?? 0) > 0 && (buff.stacks    ?? 0) < pre.stacks);
          if (has) { precondFail = true; break; }
        } else {
          // 【拥有】（默认）：达到指定强度/层数阈值即满足
          if (!buff) { precondFail = true; break; }
          if ((pre.intensity ?? 0) > 0 && (buff.intensity ?? 0) < pre.intensity) { precondFail = true; break; }
          if ((pre.stacks    ?? 0) > 0 && (buff.stacks    ?? 0) < pre.stacks)    { precondFail = true; break; }
        }
      }
      if (precondFail) continue;
      if (perMultipliers.length) precondMultiplier = Math.min(...perMultipliers);

      // ── 消耗（cost） ─────────────────────────────────────────────────
      // 兼容 V1（单对象 cost）和 V2（数组 costs）
      const costs = Array.isArray(act.costs) ? act.costs
        : (act.cost ? [act.cost] : []);

      // 强制消耗：先校验资源是否充足，不足则跳过整条 Activity
      let forcedFail = false;
      // 丢弃消耗的预检查要按顺序模拟：两条【丢弃 Lv.1】不能靠同一张牌都判过。
      // 同时冻结"宣言时"的槽位快照——本次结算只认宣言那一刻的激活槽，
      // 中途补位顶上来的牌不会被后面的丢弃消耗吃掉。
      let discardSim = null;
      // 宣言时可被丢弃的槽位下标（激活槽 0/1 + 预备槽 2）。牌是会重复的，
      // 光记 id 认不出"补位顶上来的那张恰好同名"，所以按位置跟踪：
      // 每丢掉一格，右边的下标整体 -1，尾部补进来的新牌永远不在表里。
      let declaredIdx = [0, 1, 2];
      let declaredIdxExec = [0, 1, 2];
      for (const cost of costs) {
        if (!cost) continue;
        if (cost.type === "attribute") {
          // 基础属性消耗：始终视为强制
          const costTgts = await ClashManager._resolveTargets(cost.target ?? "self", owner, other, cost, ctx);
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
          // 验证丢弃目标是否存在于战斗槽（按顺序模拟，前一条丢掉的牌不能再被后一条算上）
          const bagState = owner?.sheet?._combatBagState;
          if (!bagState) { forcedFail = true; break; }
          if (!discardSim) discardSim = { slots: [...bagState.slots], pool: [...(bagState.pool ?? [])] };
          const selfId = ctx._currentItemId ?? item?.id ?? "";
          const idxs = ClashManager._findDiscardSlots(owner, discardSim.slots, cost, selfId, declaredIdx);
          if (!idxs.length) { forcedFail = true; break; }
          // 模拟丢弃：从后往前删，每删一张就在尾部补一张
          //（预备池空了则补一张未知牌，不参与等级判定）
          for (const idx of [...idxs].reverse()) {
            discardSim.slots.splice(idx, 1);
            discardSim.slots.push(discardSim.pool.shift() ?? null);
            declaredIdx = ClashManager._shiftDeclaredIdx(declaredIdx, idx);
          }
        } else if (cost.type === "random") {
          // 随机消耗：与强制消耗同级——候选池里一条都付不起就跳过整条 Activity
          const pool = Array.isArray(cost.randomPool) ? cost.randomPool.filter(e => e?.buff) : [];
          if (!pool.length) { forcedFail = true; break; }
          const costTgts = await ClashManager._resolveTargets(cost.target ?? "self", owner, other, cost, ctx);
          if (costTgts.length === 0) { forcedFail = true; break; }
          for (const tgt of costTgts) {
            const ok = pool.some(e => {
              const type     = e.buff === "custom" ? (e.buffCustom || "custom") : e.buff;
              const existing = ClashManager._getBuff(tgt, type);
              const have     = e.dim === "intensity" ? (existing?.intensity ?? 0) : (existing?.stacks ?? 0);
              return have >= Math.max(1, e.amount ?? 1);
            });
            if (!ok) { forcedFail = true; break; }
          }
          if (forcedFail) break;
        } else if (cost.target === "field" && cost.type === "forced") {
          // 公用场地·强制消耗：层数不足则跳过整条 Activity
          //（【每】不再拦截：不足 1 倍时倍数为 0，只让随倍数缩放的效果失效，见下方）
          if (!cost.fieldName) { forcedFail = true; break; }
          const have = SinResourceHUD.getFieldResourceStacks(cost.fieldName);
          if (have < Math.max(1, cost.stacks ?? 1)) { forcedFail = true; break; }
        } else if (cost.target === "sin" && cost.type === "forced") {
          // 罪孽资源·强制消耗：点数不足则跳过整条 Activity
          if (!cost.sinType) { forcedFail = true; break; }
          const have = SinResourceHUD.getSinValue(cost.sinType);
          if (have < Math.max(1, cost.value ?? 1)) { forcedFail = true; break; }
        } else if (cost.buff && cost.type === "forced") {
          // 强制消耗：数值不足则跳过整条 Activity（层数与强度分别校验，填了哪个就要够哪个）
          // ·【扣光】（consumeAll）：语义是"有多少扣多少"，一律放行，0 也不阻断
          // ·【每】同样不再拦截，理由见上
          if (cost.consumeAll) continue;
          const costBuffType = cost.buff === "custom" ? (cost.buffCustom || "custom") : cost.buff;
          const costTgts = await ClashManager._resolveTargets(cost.target ?? "self", owner, other, cost, ctx);
          if (costTgts.length === 0) { forcedFail = true; break; }
          for (const tgt of costTgts) {
            const existing = ClashManager._getBuff(tgt, costBuffType);
            const haveS = existing?.stacks    ?? 0;
            const haveI = existing?.intensity ?? 0;
            {
              const needS = cost.stacks    ?? 0;
              const needI = cost.intensity ?? 0;
              // 两个都没填时按老规矩当作"扣 1 层"
              if (!needS && !needI) { if (haveS < 1) { forcedFail = true; break; } }
              if (needS > 0 && haveS < needS) { forcedFail = true; break; }
              if (needI > 0 && haveI < needI) { forcedFail = true; break; }
            }
          }
        }
        if (forcedFail) break;
      }
      if (forcedFail) continue;

      // 倍数默认取自「每」前置条件；若另有 perStack 消耗，消耗算出的倍数一并参与，
      // 全部取最小——前置与消耗都是"必须同时成立"的条件，能跑几倍看最紧的那一个
      const costMultipliers = [];
      let perStackMultiplier = precondMultiplier;
      let _discardedItemId = null;
      for (const cost of costs) {
        if (!cost) continue;
        if (cost.type === "random") {
          // 随机消耗：从候选池中随机抽一条可支付的候选来扣（每条候选各自指定 BUFF 与维度：层/级）
          // 例：随机消耗 1 层 或 1 级【生蝶·亡蝶】= 两条候选，同 BUFF、维度分别为 stacks / intensity。
          // 强制：候选全都不足时整条 Activity 不成立（已在上面的预检查里拦下）。
          const pool = Array.isArray(cost.randomPool) ? cost.randomPool.filter(e => e?.buff) : [];
          if (!pool.length) continue;
          const costTgts = await ClashManager._resolveTargets(cost.target ?? "self", owner, other, cost, ctx);
          for (const tgt of costTgts) {
            const affordable = pool.filter(e => {
              const type     = e.buff === "custom" ? (e.buffCustom || "custom") : e.buff;
              const existing = ClashManager._getBuff(tgt, type);
              const have     = e.dim === "intensity" ? (existing?.intensity ?? 0) : (existing?.stacks ?? 0);
              return have >= Math.max(1, e.amount ?? 1);
            });
            if (!affordable.length) continue;
            const pick     = affordable[Math.floor(Math.random() * affordable.length)];
            const pickType = pick.buff === "custom" ? (pick.buffCustom || "custom") : pick.buff;
            const amount   = Math.max(1, pick.amount ?? 1);
            if (pick.dim === "intensity") {
              await ClashManager._reduceBuffIntensity(tgt, pickType, amount);
            } else {
              await ClashManager._reduceBuffStacks(tgt, pickType, amount);
            }
          }
        } else if (cost.type === "discard") {
          const ownerSheet = owner?.sheet;
          if (ownerSheet?._discardCombatSkill) {
            const mode  = cost.discardMode ?? "level";
            const level = cost.discardLevel ?? 1;
            const currentId = ctx._currentItemId ?? item?.id ?? "";
            const { discardedIds = [], slotIndices = [] } =
              await ownerSheet._discardCombatSkill(mode, level, currentId, declaredIdxExec);
            for (const idx of [...slotIndices].reverse()) {
              declaredIdxExec = ClashManager._shiftDeclaredIdx(declaredIdxExec, idx);
            }
            const discardedId = discardedIds[0] ?? null;
            _discardedItemId = discardedId;
            // 触发被丢弃技能的【丢弃时】活动——两张一起丢时也只触发一次
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
          const costTgts = await ClashManager._resolveTargets(cost.target ?? "self", owner, other, cost, ctx);
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
          const costTgts = await ClashManager._resolveTargets(cost.target ?? "self", owner, other, cost, ctx);
          if (cost.type === "perStack") {
            // 每：与前置条件的"每"一致——维度可选层数（默认，向下兼容旧数据）或强度，
            // 每 N 为 1 倍，倍数 = floor(数值/N)，可选最大倍数上限（maxTimes，0=无限），
            // 只消耗 倍数×N（如"每消耗4级【呼吸法】"应选强度维度）
            // 群体目标时逐个扣（与预检查"人人都要够"保持一致），
            // 倍数取所有目标里最小的那个——扣得最少的人决定这次能跑几倍
            const dim = cost.perNDim === "intensity" ? "intensity" : "stacks";
            const n   = Math.max(1, cost.stacks ?? 1);
            const each = [];
            for (const tgt of costTgts) {
              const existing = ClashManager._getBuff(tgt, costBuffType);
              const have     = dim === "intensity" ? (existing?.intensity ?? 0) : (existing?.stacks ?? 0);
              let   times    = Math.floor(have / n);
              if ((cost.maxTimes ?? 0) > 0) times = Math.min(times, cost.maxTimes);
              // 不足 1 倍时 times = 0：什么都不扣（也不再让整条 Activity 失败）
              if (times > 0) {
                if (dim === "intensity") {
                  await ClashManager._reduceBuffIntensity(tgt, costBuffType, times * n);
                } else {
                  await ClashManager._reduceBuffStacks(tgt, costBuffType, times * n);
                }
              }
              each.push(times);
            }
            // 一个目标都没有 = 0 倍（而不是"没这条消耗"，那会让效果按满额跑）
            costMultipliers.push(each.length ? Math.min(...each) : 0);
          } else if (cost.consumeAll) {
            // 扣光：整条 BUFF 直接移除（有多少扣多少，一条都没有也不算失败）。
            // 「消耗所有 X」请用这个，不要再写 stacks: 99 —— 大数走的是强制消耗，
            // 预检查要求真的有 99 层，永远付不起，整条 Activity 会被静默跳过。
            for (const tgt of costTgts) {
              if (ClashManager._getBuff(tgt, costBuffType)) {
                await ClashManager._removeBuff(tgt, costBuffType);
              }
            }
          } else if (cost.type !== "none") {
            // 强制消耗：层数与强度分别扣，填了哪个扣哪个（都没填按扣 1 层）
            const needS = cost.stacks    ?? 0;
            const needI = cost.intensity ?? 0;
            for (const tgt of costTgts) {
              if (needI > 0) await ClashManager._reduceBuffIntensity(tgt, costBuffType, needI);
              if (needS > 0) await ClashManager._reduceBuffStacks(tgt, costBuffType, needS);
              if (!needS && !needI) await ClashManager._reduceBuffStacks(tgt, costBuffType, 1);
            }
          }
        } else if (cost.target === "field" && cost.fieldName) {
          // 公用场地：每 / 强制消耗 / 可选消耗（不足时可选消耗直接跳过，不报错）
          if (cost.type === "perStack") {
            const have  = SinResourceHUD.getFieldResourceStacks(cost.fieldName);
            const n     = Math.max(1, cost.stacks ?? 1);
            let   times = Math.floor(have / n);
            if ((cost.maxTimes ?? 0) > 0) times = Math.min(times, cost.maxTimes);
            if (times > 0) await SinResourceHUD.consumeFieldResourceStacks(cost.fieldName, times * n);
            costMultipliers.push(times);
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
            costMultipliers.push(times);
          } else if (cost.type !== "none") {
            const need = cost.value ?? 1;
            if (SinResourceHUD.getSinValue(cost.sinType) >= need) await consume(need);
          }
        }
      }

      if (costMultipliers.length) {
        perStackMultiplier = Math.min(precondMultiplier, ...costMultipliers);
      }

      // ── 效果（effects）────────────────────────────────────────────────
      // 兼容 V1（单对象 effect）和 V2（数组 effects）
      const effects = Array.isArray(act.effects) ? act.effects
        : (act.effect ? [act.effect] : []);

      for (const eff of effects) {
        if (!eff?.type) continue;
        // 连击的第 2 次交锋起：改写技能本身的效果（骰数/面数/基础值/攻击容量/
        // 骰子类型）不再重复执行，否则每交锋一次就再加一遍，3d 会滚成 6d
        if (ctx._comboRound > 1 && ClashManager.COMBO_ONCE_EFFECTS.has(eff.type)) continue;
        // 「每 N」一倍都不够时（倍数 0）：只跳过随倍数缩放的效果，
        // 不随倍数走的效果（转换骰子类型、移除 BUFF 等）照常执行。
        // 例：「消耗所有【炎蝶之棺】回 20 血；每消耗 3 级【烧伤】回 1D6；转成烙印」
        // ——没有烧伤时该少回 1D6，而不是连固定回血和转换一起消失。
        if (perStackMultiplier === 0 && ClashManager.PER_SCALED_EFFECTS.has(eff.type)) continue;
        const effTgts = await ClashManager._resolveTargets(eff.target ?? "self", owner, other, eff, ctx);
        if (effTgts.length === 0) continue;

        for (const effTgt of effTgts) {

        // BUFF 型效果用 intensity/stacks；数值型效果用 value
        // 「每」的倍数对强度与层数一视同仁（两者都只是计数），数值型 val 同样放大
        const intensity = Number(eff.intensity ?? eff.value ?? 1) * perStackMultiplier;
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
            await ClashManager._stashItemMod(item, "system.weight");
            await ClashManager._safeDocUpdate(item, { "system.weight": nv });
            descStr = mode === "absolute"
              ? `【${item.name}】攻击容量 调整为 ${nv}`
              : `【${item.name}】攻击容量 ${val >= 0 ? "+" : ""}${val}（${cur} → ${nv}）`;
            break;
          }
          case "diceAdj": {
            // 骰数：累加或赋值骰子数量，下限 1
            const { mode, value: rawVal } = await ClashManager._evalSignedValue(eff.value, eff.intensity);
            const val = _scaleVal(rawVal, mode);
            const cur = item.system?.diceCount ?? 1;
            const nv  = mode === "absolute" ? Math.max(1, val) : Math.max(1, cur + val);
            await ClashManager._stashItemMod(item, "system.diceCount");
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
            await ClashManager._stashItemMod(item, "system.diceFaces");
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
            await ClashManager._stashItemMod(item, "system.baseValue");
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
            // 次数同样吃「每」的倍数（"每 2 级【光札】引爆 1 次"）
            const blastCount = Math.max(1, Math.round(Number(eff.value ?? 1) * perStackMultiplier));
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
              await ClashManager._applyAndSendTake(effTgt, dmg, { attacker: owner, takeLabel: "追加伤害",
                category: eff.dmgCategory ?? "", sinType: eff.dmgSinType ?? "", item });
            }
            break;
          }
          case "diceTypeChg": {
            const newDiceType = eff.diceTypeVal ?? "normal";
            if (item) {
              await ClashManager._stashItemMod(item, "system.diceType");
              await ClashManager._safeDocUpdate(item, { "system.diceType": newDiceType });
              const label = newDiceType === "unbreakable" ? "不可摧毁" : "一般骰子";
              descStr = `【${item.name}】骰子类型变更为【${label}】`;
            }
            break;
          }
          case "rangeChg": {
            // 【范围修改】只作用于**当前装备的武器**，其他部位一律忽略。
            // 这是持久改动（不随攻击后还原）——"拉弓姿势"要一直保持到
            // 玩家自己换回来，所以写进武器数据，权限不足时转交 GM 代执行。
            const weapon = ClashManager._activeWeaponOf(effTgt ?? owner);
            if (!weapon) { descStr = "范围修改：没有已装备的武器"; break; }
            const mode = eff.rangeMode === "ranged" ? "ranged" : "melee";
            const val  = Math.max(0, parseInt(eff.rangeValue ?? 1) || 0);
            await ClashManager._safeDocUpdate(weapon, {
              "system.rangeType": mode,
              "system.range":     val,
            });
            const ft = (val * 5 + 2.5).toFixed(1);
            descStr = `【${weapon.name}】转为${mode === "ranged" ? "远程" : "近战"}，`
              + `攻击范围 ${val} 格（${ft}ft）`;
            break;
          }
          case "relatedSkillConvert": {
            // 相关技能转换：将"本骰"（item）永久替换为角色背包/技能列表中按名字检索到的技能。
            // 旧版"随机/指定序号"（需要在技能上预先配置一个 UUID 池、互相套娃）已移除，
            // 改为直接按名字检索已拥有的技能，无需任何预配置，
            // 也不受合集包提取后 UUID 变化的影响。
            const relOwner = item?.parent ?? owner;
            if (!relOwner || !item) { descStr = "相关技能转换：找不到所属角色"; break; }

            const name = (eff.relSkillName ?? "").trim();
            if (!name) { descStr = "相关技能转换：未配置技能名字"; break; }
            const newItem = (relOwner.items ?? []).find(it => it.type === "skill" && it.name === name && it.id !== item.id);
            if (!newItem) { descStr = `相关技能转换：背包中找不到技能【${name}】`; break; }
            // 转换时长：permanent（默认，老数据）/ afterUse（转换后的技能被用掉一次）/
            //           afterClash（本次结算后）/ endOfTurn（本回合结束时）
            const relUntil = ["afterUse", "afterClash", "endOfTurn"].includes(eff.relDuration)
              ? eff.relDuration : "";
            // 槽位要在替换**之前**定位：还原按槽位记账，基础槽与守备槽同时被换成
            // 同一个强化形态时，按 id 还原会把两个槽一起改掉
            const relSlot  = relUntil ? (relOwner.findSkillSlot?.(item.id) ?? null) : null;
            const replaced = await relOwner.replaceSkillSlot?.(item.id, newItem.id);
            if (replaced) relOwner.sheet?._replaceCombatBagSkill?.(item.id, newItem.id);
            // 临时转换：登记还原任务。**只有真的发生了替换才登记**——
            // 若槽位里本来就是目标技能（比如已被另一条"永久转换"换上去了），
            // replaceSkillSlot 返回 false，这里什么都不记，到点也就不会把别人的永久状态还原掉。
            if (replaced && relUntil) {
              await ClashManager._pushTempSkillConvert(relOwner, item.id, newItem.id, relUntil, relSlot);
            }
            const relUntilLabel = relUntil === "afterUse"   ? "（使用一次后还原）"
                                : relUntil === "afterClash" ? "（本次结算后还原）"
                                : relUntil === "endOfTurn"  ? "（本回合结束时还原）" : "永久";
            descStr = replaced
              ? `【${item.name}】${relUntil ? "临时" : relUntilLabel}转换为【${newItem.name}】${relUntil ? relUntilLabel : ""}`
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
              // reactTarget 预锁这次对抗打谁（与 _applyReactionEff 同名同义）：
              //   attacker ＝本次结算的攻击方（如 [拼点失败] 时反打赢了自己的那个人）
              //   defender ＝本次结算的防守方（补刀友方正在打的目标）
              //   none / 不填 ＝不指定，谁都能响应
              const rt = eff.reactTarget ?? "none";
              let tgtId = "";
              if      (rt === "attacker") tgtId = ctx.atkActor?.id ?? "";
              else if (rt === "defender") tgtId = ctx.defActor?.id ?? "";
              // 指定目标不能是自己，否则发出的对抗卡没人能响应
              if (tgtId === useTgt?.id) tgtId = "";
              await ClashManager.showInitiateDialog(useTgt, skillItem, -2, tgtId);
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
    const _BC_TYPES          = CONFIG.LIMBUSCOMPANY?.CHAOS_TYPES ?? ["chaos", "chaos_plus", "chaos_double_plus"];
    const _BC_NAMES          = CONFIG.LIMBUSCOMPANY?.CHAOS_NAMES ?? ["陷入混乱", "陷入混乱+", "陷入混乱++"];
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
    if (t === "weightAdj")   { const v = eff.value ?? eff.intensity ?? 0; return `技能攻击容量 ${v >= 0 ? "+" : ""}${v}`; }
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

  /**
   * 生命值结算块：先前生命值（含蓝色护盾） → 现在生命值，血条带混乱阈值刻度，
   * 下接若干条触发行。承受结算与容量扩散共用，后者传 sm:true 用 40px 缩小版。
   *
   * @param {object}  o
   * @param {Actor}   o.actor
   * @param {number}  o.oldHp    结算前生命值
   * @param {number}  o.newHp    结算后生命值
   * @param {number}  o.maxHp
   * @param {number}  [o.shield] 结算前的护盾层数（蓝色写在先前生命值上）
   * @param {{k:string,v:string}[]} [o.triggers] 触发行
   * @param {boolean} [o.sm]     40px 缩小版
   */
  static _hpBlock({ actor, oldHp, newHp, maxHp, shield = 0, triggers = [], sm = false }) {
    const pct  = (v) => Math.max(0, Math.min(100, (v / Math.max(1, maxHp)) * 100));
    const now  = pct(newHp);
    const lost = Math.max(0, pct(oldHp) - now);

    // 混乱阈值刻度：已击穿的压成灰色
    const thrs = (actor?.system?.chaosThresholds ?? [])
      .map(t => `<div class="thr${t.triggered ? " fired" : ""}" style="left:${t.percent}%"></div>`)
      .join("");

    const num = `<span class="lc-hp-num">
      <span class="from">${oldHp}${shield > 0 ? `<span class="sh">+${shield}</span>` : ""}</span>
      <span class="arw">→</span><span class="to">${newHp}</span>
      <span class="max">/ ${maxHp}</span>
    </span>`;

    const head = sm
      ? `<div class="row40">
           <img src="${actor?.img ?? "icons/svg/mystery-man.svg"}" alt="">
           <span class="who">${actor?.name ?? ""}</span>
           ${num}
         </div>`
      : num;

    const trigRows = triggers.length
      ? `<div class="lc-take-trig">${triggers
          .map(t => `<div class="r"><span class="k">${t.k}</span><span class="v">${t.v}</span></div>`)
          .join("")}</div>`
      : "";

    return `<div class="lc-hp-blk${sm ? " sm" : ""}">
      ${head}
      <div class="lc-hp-bar">
        <div class="fill" style="width:${now.toFixed(1)}%"></div>
        ${lost > 0 ? `<div class="ghost" style="left:${now.toFixed(1)}%;width:${lost.toFixed(1)}%"></div>` : ""}
        ${thrs}
      </div>
      ${trigRows}
    </div>`;
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
      // 罪孽消耗两形态共用；理智消耗已按形态投影在 sys.sanityCost 上。
      // 没配置侵蚀形态的旧 EGO 沿用老规矩：恐慌时免理智。
      const hasCorrode            = ClashManager._hasCorrodeForm(sys);
      const effectiveSinCost      = sinCost;
      const effectiveSanityCost   = (isInPanic && !hasCorrode) ? 0 : sanityCost;
      const sinParts   = effectiveSinCost.map(({ sinType, amount }) => {
        const icon     = cfg.SIN_ICON_PATHS?.[sinType] ?? "";
        const cur      = SinResourceHUD.getSins()[sinType] ?? 0;
        const ok       = cur >= amount;
        const suffix   = "";
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
        ? `<div style="font-size:.7rem;color:#E8A444;margin-bottom:4px;">【陷入恐慌】E.G.O 进入【侵蚀】形态${
            hasCorrode ? "" : "（本 E.G.O 未设定侵蚀数据，沿用觉醒形态并免除理智消耗）"}</div>`
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
                const sanityCost      = sys.sanityCost ?? 0;
                const effectiveSinCost = sys.sinCost ?? [];
                const effectiveSanityCost =
                  (isInPanic && !ClashManager._hasCorrodeForm(sys)) ? 0 : sanityCost;
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
    // 【无法拼点】：被锁定的目标只能【承受】——不渲染【对抗】按钮，也不问【援护防御】
    const noClash    = !!sys.noClash;

    const content = `
      <div class="limbus-clash-card" data-clash-type="initiate">
        ${ClashManager._chatHeader(actor, "发起对抗")}
        ${ClashManager._goldDivider()}
        ${ClashManager._skillRow(item)}
        ${targetName ? `<div style="font-size:.78rem;color:#B43822;margin-top:6px;">
          ⊘ 已指定目标：<strong>${targetName}</strong>（其他角色无法对抗/承受）
        </div>` : ""}
        ${noClash ? `<div style="font-size:.78rem;color:#B43822;margin-top:6px;">
          ⊘ 本技能【无法拼点】：只能承受，守备技能与【援护防御】均不可对抗
        </div>` : ""}
        <div class="clash-action-row" style="display:flex;gap:8px;margin-top:8px;margin-bottom:4px;">
          ${noClash ? "" : `<button class="clash-btn-clash"
                  style="width:50px;height:30px;background:#5F3E22;color:#E8C9A2;
                         cursor:pointer;font-size:.85rem;border-radius:2px;">对抗</button>`}
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
          noClash,
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

    // 【援护防御】：被锁定的目标行动值为 0 时，问问队友要不要顶上来
    // （【无法拼点】优先级最高：顶上去也只是换个人承受，因此直接不问）
    if (!noClash) {
      await ClashManager._offerCoverDefense(msg?.id ?? "", msg?.flags?.limbusCompany_FVTT ?? {});
    }
  }

  /* ─── 【援护防御】：替队友接下这次对抗 ─────────────────────────────────
     指定了目标、且该目标行动值为 0（自己已经无法再接下任何一次拼点失败）时，
     持有【援护防御】的队友可以消耗 1 层，用背包里标了【援护防御】的专属技能
     顶上去——挪到攻击者身旁的空位，并把这次对抗的指定目标改成自己。      */

  /** 广播询问（各客户端只处理自己拥有控制权的角色，避免多端重复弹框） */
  static async _offerCoverDefense(msgId, initFlags) {
    if (!msgId || !initFlags?.targetActorId) return;
    game.socket?.emit("system.limbusCompany_FVTT", { type: "coverOffer", msgId, initFlags });
    await ClashManager._checkCoverDefense(msgId, initFlags);
  }

  /** 调试日志（控制台里 ClashTotalFX.DEBUG = true 打开） */
  static _coverLog(...args) {
    if (globalThis.ClashTotalFX?.DEBUG) {
      console.log("%c[援护防御]", "color:#6EC1E4;font-weight:bold", ...args);
    }
  }

  /**
   * 这个角色该由本客户端来弹窗吗？
   * 有在线玩家拥有该角色 → 只让那位玩家弹；否则（NPC/离线）→ 交给 GM。
   * 不这样分派的话，GM 对所有角色都是 owner，会和玩家各弹一次。
   */
  static _shouldPromptFor(actor) {
    const playerOwners = game.users.filter(u => !u.isGM && u.active
      && actor.testUserPermission?.(u, "OWNER"));
    if (playerOwners.length) return !game.user.isGM && actor.isOwner;
    return game.user.isGM;
  }

  /** 【援护防御】的 BUFF：按 type 找，找不到再按名字兜底（手动添加成自定义 BUFF 的情况） */
  static _coverBuffOf(actor) {
    return (actor?.system?.buffs ?? []).find(b =>
      (b.type === "coverDefense" || b.name === "援护防御") && b.whenAdded !== "下回合") ?? null;
  }

  /** 本机检查：自己控制的角色里有谁能援护 */
  static async _checkCoverDefense(msgId, initFlags) {
    // 【无法拼点】兜底：socket 广播过来的也要拦（顶上去也只是换个人承受）
    if (initFlags?.noClash) return;
    const target = game.actors.get(initFlags?.targetActorId ?? "");
    if (!target) { ClashManager._coverLog("没有指定目标，跳过"); return; }
    // 只有"目标已经扛不住了"才需要援护
    if ((target.system?.ap?.value ?? 0) > 0) {
      ClashManager._coverLog(`目标 ${target.name} 行动值 ${target.system?.ap?.value}，无需援护`);
      return;
    }

    for (const actor of game.actors.contents) {
      if (actor.type !== "character") continue;
      if (actor.id === target.id || actor.id === initFlags.attackerId) continue;

      const buff = ClashManager._coverBuffOf(actor);
      if (!buff || (buff.stacks ?? 0) <= 0) continue;

      if (!ClashManager._shouldPromptFor(actor)) {
        ClashManager._coverLog(`${actor.name} 有【援护防御】，但该由其控制者弹窗，本机跳过`);
        continue;
      }

      const skills = actor.items.filter(i => i.type === "skill" && i.system?.coverDefense);
      ClashManager._coverLog(`${actor.name}：${buff.stacks} 层，专属技能 ${skills.length} 个`);
      if (!skills.length) {
        ui.notifications?.warn(`${actor.name} 持有【援护防御】，但背包里没有标记为【援护防御】的专属技能`);
        continue;
      }

      const picked = await ClashManager._pickCoverSkill(actor, target, skills);
      if (!picked) continue;

      await ClashManager._performCoverDefense(actor, picked, msgId, initFlags);
      return;   // 一次对抗只允许一个人顶上
    }
  }

  /** 选技能弹窗：列出背包里所有【援护防御】专属技能 */
  static async _pickCoverSkill(actor, target, skills) {
    const rows = skills.map(sk => `
      <label style="display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;">
        <input type="radio" name="cover-skill" value="${sk.id}">
        <img src="${sk.img}" style="width:32px;height:32px;object-fit:cover;border-radius:3px;" alt="">
        <span style="flex:1;">
          <span style="color:#E8C9A2;">${sk.name}</span>
          <span style="color:#9A8462;font-size:.75rem;"> ${(sk.system?.diceFormula ?? "").toUpperCase()}</span>
        </span>
      </label>`).join("");

    return new Promise(resolve => {
      new Dialog({
        title: "【援护防御】触发",
        content: `<div class="limbuscompany">
          <div style="font-size:.85rem;color:#E8C9A2;margin-bottom:6px;">
            <strong>${target.name}</strong> 行动值已耗尽且被锁定为目标。
          </div>
          <div style="font-size:.8rem;color:#9A8462;margin-bottom:8px;">
            <strong>${actor.name}</strong> 可消耗 1 层【援护防御】顶上去，选择要使用的专属技能：
          </div>
          ${rows}
        </div>`,
        buttons: {
          ok: {
            label: "援护",
            callback: (html) => {
              const id = html.find("input[name='cover-skill']:checked").val();
              resolve(id ? actor.items.get(id) : null);
            },
          },
          cancel: { label: "不援护", callback: () => resolve(null) },
        },
        default: "ok",
        close: () => resolve(null),
      }).render(true);
    });
  }

  /** 消耗层数 → 挪到攻击者身旁 → 改写指定目标 → 打开进行对抗弹窗 */
  static async _performCoverDefense(actor, skill, msgId, initFlags) {
    // 按实际存在的 type 扣层（手动添加成自定义 BUFF 时 type 可能不是 coverDefense）
    const buff = ClashManager._coverBuffOf(actor);
    await ClashManager._reduceBuffStacks(actor, buff?.type ?? "coverDefense", 1);

    const attacker = game.actors.get(initFlags.attackerId ?? "");
    if (attacker) await ClashKnockback.moveNextTo(actor, attacker);

    // 强制改写这次对抗的指定目标：后续所有校验都以聊天卡的 flags 为准
    const newFlags = { ...initFlags, targetActorId: actor.id, coveredForId: initFlags.targetActorId };
    const msg = game.messages.get(msgId);
    if (msg) {
      await ClashManager._safeDocUpdate(msg, {
        "flags.limbusCompany_FVTT.targetActorId": actor.id,
        "flags.limbusCompany_FVTT.coveredForId": initFlags.targetActorId,
      });
    }

    const covered = game.actors.get(initFlags.targetActorId ?? "");
    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="limbuscompany chat-clash">
        <strong>${actor.name}</strong> 发动【援护防御】，替 <strong>${covered?.name ?? "队友"}</strong>
        接下这次对抗（使用 <strong>${skill.name}</strong>）。
      </div>`,
    });

    await ClashManager.showPerformDialog(actor, skill, msgId, newFlags, -1);
  }

  /* ─── 阶段三：进行对抗技能选择弹窗（玩家B） ─────────────────────────── */

  static showRespondDialog(msgId, initFlags) {
    // 【无法拼点】：兜底——任何路径进来都拦住，只能走【承受】
    if (initFlags?.noClash) {
      ui.notifications?.warn("这张技能【无法拼点】，只能承受。");
      return;
    }
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

    // 行动值为 0：再也接不下任何一次拼点失败，因此不能再用普通技能硬拼，
    // 但仍可以用【守备技能】应战（闪避/格挡/反击等）。
    // 这只影响"被动应战"这条路——自己回合主动使用技能不看行动值。
    const apExhausted = (defActor.system?.ap?.value ?? 0) <= 0;

    // 恐慌时只能用 EGO 响应
    const isInPanic = !!ClashManager._getBuff(defActor, "panic");

    // 恐慌 + 行动值为 0：恐慌把可用手段压缩成只剩 E.G.O，而行动值为 0 时对抗
    // 用不了 E.G.O（只能用守备技能，恐慌又不给用），于是彻底接不下这一击。
    // 注意：这只卡"被动应战"，自己回合主动出击照样能放 E.G.O。
    if (isInPanic && apExhausted) {
      ui.notifications.warn(`【陷入恐慌】${defActor.name} 行动值为 0，无法用 E.G.O 对抗，只能承受伤害！`);
      return;
    }

    if (apExhausted) {
      const defSkillId = defActor.system?.skills?.defense ?? null;
      if (!defSkillId || !defActor.items.get(defSkillId)) {
        ui.notifications.warn(`${defActor.name} 行动值为 0 且没有装备守备技能，只能承受伤害`);
        return;
      }
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
    }, isInPanic, apExhausted);
  }

  /**
   * 技能选择弹窗。
   * @param {boolean} panicMode     陷入恐慌：只能选 E.G.O
   * @param {boolean} defenseOnly   行动值为 0：只能选守备技能
   */
  static _buildPickerDialog(actor, onPick, panicMode = false, defenseOnly = false) {
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
      : defenseOnly
      ? `<div style="font-size:.75rem;color:#6EC1E4;text-align:center;padding:4px 0 6px;font-style:italic;">
           行动值为 0：只能使用【守备技能】应战
         </div>`
      : "";

    // 顶部：两个已激活技能 + 守备技能，上下各一条金色渐变分割线
    const topRow = `
      ${panicNotice}
      ${ClashManager._goldDivider()}
      <div class="clash-pick-row">
        ${octaSlotHtml(active0, "clash-pick-active", 0, panicMode || defenseOnly)}
        ${octaSlotHtml(active1, "clash-pick-active", 1, panicMode || defenseOnly)}
        ${octaSlotHtml(defItem, "", -1, panicMode)}
      </div>
      ${ClashManager._goldDivider()}`;

    // 展开区：6-bag 剩余技能 + EGO 技能，统一按固定 3 列排布。
    // EGO 空等级不渲染（与快捷 HUD 的处理一致）。
    const expandedSlots = [
      ...restItems.map((it, j) => octaSlotHtml(it, "", 2 + j, panicMode || defenseOnly)),
      // 行动值为 0 时 E.G.O 也不能用（它不是守备技能）
      ...egoEntries.filter(e => e.item)
        .map(e => defenseOnly ? octaSlotHtml(e.item, "", -1, true) : circleSlotHtml(e.item, e.grade)),
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

        // 被禁用的槽：说明为什么点不了
        dlgHtml.on("click", ".clash-pick-disabled", () => {
          ui.notifications.warn(panicMode
            ? "【陷入恐慌】无法使用基础或守备技能！"
            : "行动值为 0：只能使用【守备技能】应战");
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
                const sanityCost       = sys.sanityCost ?? 0;
                const effectiveSinCost = sys.sinCost ?? [];
                const effectiveSanityCost =
                  (isInPanic && !ClashManager._hasCorrodeForm(sys)) ? 0 : sanityCost;
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

              // 推进防守方战斗袋（技能消失，后面的技能填充）。
              // 战斗袋状态是各客户端本地的，必须在防守方自己这台机器上推进——
              // _sendResponseAndResolve 对非 GM 玩家会把结算整个委托给 GM，
              // 放在那里推的是 GM 端的状态，玩家自己的 6-bag 纹丝不动。
              if (slotIdx >= 0) {
                const defSheet = defActor.sheet;
                if (defSheet?._combatBagState) defSheet._animateCombatSkillUse?.(slotIdx);
              }

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
        // 带上完整骰子数据，GM 端重建真 Roll 才能播 DiceSoNice
        defRollData:  (typeof defRoll.toJSON === "function") ? defRoll.toJSON() : null,
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
    // 【援护防御】顶上来时被替下的那个队友（target:"covered" 用它）
    const coveredForActor = initFlags.coveredForId ? (game.actors.get(initFlags.coveredForId) ?? null) : null;
    const atkCtx = { atkActor, defActor, owner: atkActor, other: defActor, coveredForActor, _fireCounts: _fc, _actMsgs, _currentItemId: atkItem?.id ?? "" };
    const defCtx = { atkActor, defActor, owner: defActor, other: atkActor, coveredForActor, _fireCounts: _fc, _actMsgs, _currentItemId: defItem?.id ?? "" };

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
    await ClashManager._dispatchOnAttack(atkActor, atkItem, atkCtx);
    await ClashManager._dispatchOnAttack(defActor, defItem, defCtx);
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
      ClashManager.applyDiceRollMods(atkActor, rerollAtk, { item: atkItem, isDefense: false });
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
      ClashManager.applyDiceRollMods(defActor, rerollDef, { item: defItem, isDefense: true });
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
      sinType: initFlags.sinType ?? "",
      isDefender: false,
    });
    const _defPartsFx = ClashManager._buildTotalParts({
      actor: defActor, opponent: atkActor,
      rollTotal: defFinalTotal ?? 0, bonus: defBonusVal,
      baseFormula: defFinalBase ?? "", category: defItem?.system?.category ?? "",
      counterType: defItem?.system?.counterType ?? "", sinType: defItem?.system?.sinType ?? "",
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

    // ── 出手前的站位 ────────────────────────────────────────────────────
    // 近战武器（含长矛/锁链这种范围 >1 的）在拼点前瞬移到目标身旁，之后一切照旧；
    // 远程武器**不移动**，隔着距离直接开拼——击退与追击的差异见 knockback.mjs。
    if (canvas?.ready) {
      const atkTok0 = ClashManager._tokenOfActor(atkActor);
      const defTok0 = ClashManager._tokenOfActor(defActor);
      if (atkTok0 && defTok0 && !ClashKnockback.weaponRangeOf(atkActor).ranged) {
        await ClashKnockback.approach(atkTok0, defTok0);
      }
    }

    const _sumParts = (parts) => parts.reduce((a, p) => a + (p.value ?? 0), 0);
    const _atkEffFx = _sumParts(_atkPartsFx);
    const _defEffFx = _sumParts(_defPartsFx);
    const _burstMid = () => ClashVFX.broadcastBurst(ClashVFX.midPoint(atkActor, defActor));

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
        // 各方"当当当"结算完，紧接着就打出自己的击退
        onSideDone: async (side) => {
          if (side === "atk") {
            // 反击：进攻方照常把守方打退；格挡：挡住了就不推，没挡住才推
            if (defCategory === "block" && _atkEffFx <= _defEffFx) return;
            _burstMid();
            await ClashKnockback.repel({
              winner: atkActor, loser: defActor, winScore: _atkEffFx, chase: false,
              onWallHit: (a) => ClashManager.seismicBlast(a, 1, { attacker: atkActor }),
            });
          } else if (defCategory === "counter") {
            // 反击方反手扑回来，再把进攻方打退
            _burstMid();
            await ClashKnockback.repel({
              winner: defActor, loser: atkActor, winScore: _defEffFx,
              chase: false, approachFirst: true,
              onWallHit: (a) => ClashManager.seismicBlast(a, 1, { attacker: defActor }),
            });
          }
        },
      });
    }

    // 汇总 [攻击时/拼点时] 后所有可能被修改的攻击方字段，统一覆盖 initFlags
    // 目前覆盖字段：rollTotal / formula（骰子公式变化重投）、weight（weightAdj 修改攻击容量）
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
      await ClashManager._restoreAllItemMods(atkItem, defItem);
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
      await ClashManager._restoreAllItemMods(atkItem, defItem);
      await ClashManager._flushActMsgs(_actMsgs, atkActor);
      await ClashManager._broadcastAndCheckReactions({ lastSkillUuid: atkItem?.uuid ?? null, attacker: atkActor, defender: defActor });
      return;
    }

    // ── 闪避：双方同时出手，只拼一次，不消耗行动值也不碎硬币 ──────────
    if (defCategory === "dodge") {
      const atkEffFx = _atkEffFx, defEffFx = _defEffFx;
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
      // 闪避成功不击退；没闪过才被推开一次，且攻方不追击
      if (atkEffFx > defEffFx) {
        _burstMid();
        await ClashKnockback.repel({
          winner: atkActor, loser: defActor, winScore: atkEffFx, chase: false,
          onWallHit: (a) => ClashManager.seismicBlast(a, 1, { attacker: atkActor }),
        });
      }
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
      defCounterType: sys.counterType ?? "",
    });

    // 呼吸暴击触发：层数-1
    if (resolution.breatheCrit && resolution.winner) {
      await ClashManager._reduceBuffStacks(resolution.winner, "breathing");
    }

    // ── [拼点成功/失败] / [命中时] / [暴击命中时] / [受到伤害时] ────────
    const { atkWins, dodgeWin, breatheCrit } = resolution;
    // 【不可摧毁】反击暂存，稍后在 _sendResolveMsg 后触发
    let _unbreakableCounterArgs = null;
    {
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
          await ClashManager._dispatchTakeDamage(defItem, defActor, atkActor, defCtx);
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
          await ClashManager._dispatchTakeDamage(atkItem, atkActor, defActor, atkCtx);
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
    if (!dodgeWin) {
      const { gainNote, lossNote } = await ClashManager._applySanityFromClash(
        resolution.winner, resolution.loser
      );
      if (gainNote) sanityNotes.push(gainNote);
      if (lossNote) sanityNotes.push(lossNote);
    }

    // ── [攻击后]：结算完对抗结果后触发 ────────────────────────────────
    // 必须在建卡**之前**跑完：详细信息要连 [攻击后] 一起收进折叠区，
    // 建完卡再回头 update 一次太脆（占位符被清洗、跨客户端权限都会让它静默失败）。
    // 骰值改动只影响 item，resolution 里的点数早就算好了，不受影响。
    await ClashManager._applyActivitiesAndEquip(atkItem, "攻击后", atkCtx);
    await ClashManager._applyActivitiesAndEquip(defItem,  "攻击后", defCtx);
    await ClashManager._restoreAllItemMods(atkItem, defItem);

    await ClashManager._sendResolveMsg(
      resolution, finalInitFlags, defActor, defItem, defFormula, sanityNotes, _actMsgs);

    // 【不可摧毁】反击消息在拼点对抗结果之后发出
    if (_unbreakableCounterArgs) {
      await ClashManager._triggerUnbreakableCounter(..._unbreakableCounterArgs);
    }

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
          baseFormula: atkFormula, category: atkCategory,
          sinType: atkItem?.system?.sinType ?? "",
          isDefender: false })
      : ClashManager._buildTotalParts({
          actor: defActor, opponent: atkActor, rollTotal: total, bonus: defBonus,
          baseFormula: defFormula, category: defCategory,
          counterType: defItem?.system?.counterType ?? "",
          sinType:     defItem?.system?.sinType     ?? "",
          isDefender: true });
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

      // 最后一击：刀剑相击处同样炸一朵，随后只震退、不追击
      const loseActor = winSide === "atk" ? defActor : atkActor;
      ClashVFX.broadcastBurst(ClashVFX.midPoint(atkActor, defActor));
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
                               defActor, defTotal, defFormula, defItemName, defItemImg, defCategory, defSinType,
                               atkCounterType = "", defCounterType = "" }) {

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
                     + gs(atkActor, "clashPowerUp")  - gs(atkActor, "clashPowerDown")
                     + ClashManager._condPowerMod(atkActor, {
                         category: atkCategory, counterType: atkCounterType, sinType: atkSinType });

    // 防守方：守备技能 → 忍耐/破绽；基础/EGO → 强壮/虚弱；两者都再加拼点威力 + 等级差
    const defIsDefCat = ALL_DEF_CATS.has(defCategory);
    const defDiceMod  = (defIsDefCat
      ? (gs(defActor, "endure")  - gs(defActor, "breach"))
      : (gs(defActor, "strong")  - gs(defActor, "weak")))
      + ClashManager._condPowerMod(defActor, {
          category: defCategory, counterType: defCounterType, sinType: defSinType });
    const defPwrMod   = gs(defActor, "clashPowerUp") - gs(defActor, "clashPowerDown");

    const atkEffective = atkTotal + atkDiceMod + atkLvBonus;
    const defEffective = defTotal + defDiceMod + defPwrMod + defLvBonus;

    // ── 胜负判定（基于含等级差的有效骰数）───────────────────────────────
    // 平局不再是一种独立结果：
    // ·连击路径（_runComboClash）本来就把平局当作"不扣行动值、再拼一次"，
    //   循环到分出胜负为止，返回上来的点数不可能相等；
    // ·闪避只拼一次、也不扣行动值，所以平局判**闪避成功**（躲开了，无伤害）——
    //   闪避判定的是"够不够快躲开"，不需要决出胜负。
    // 其余极端情况（连拼 20 次兜底）平局归攻击方。
    const atkWins  = (defCategory === "dodge")
      ? atkEffective > defEffective          // 闪避：平局算守方躲开
      : atkEffective >= defEffective;
    const winner   = atkWins ? atkActor : defActor;
    const loser    = atkWins ? defActor : atkActor;
    const winScore = atkWins ? atkEffective : defEffective;
    const winCat   = atkWins ? atkCategory  : defCategory;
    const winSin   = atkWins ? atkSinType   : defSinType;

    // ── 呼吸（breathing）：命中方判定暴击（在抗性计算之前） ──────────────
    // 暴击判定先于抗性，critMult 作为额外倍率参与 winScore 计算，
    // 触发时层数-1 由调用方执行
    const breatheBuff = ClashManager._getBuff(winner, "breathing");
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

    // 闪避：拼点成功或平局 → 躲开，无伤害
    const dodgeWin  = defCategory === "dodge" && !atkWins;

    let finalDamage;
    if (dodgeWin) {
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

    if (dodgeWin && atkEffective === defEffective) {
      notes.push(`平局 → ${defActor?.name ?? "?"} 闪避成功（无伤害）`);
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
      atkWins, winner, loser,
      atkTotal: atkEffective, defTotal: defEffective, winScore,
      atkItemName, atkItemImg, atkFormula, atkActor,
      defItemName, defItemImg, defFormula, defActor,
      finalDamage, notes, breatheCrit, dodgeWin, defCategory,
    };
  }

  /* ─── 阶段五c：拼点结算聊天框 ──────────────────────────────────────────── */

  static async _sendResolveMsg(res, initFlags, defActor, defItem, defFormula, sanityNotes = [], actMsgs = []) {
    const {
      atkWins, atkTotal, defTotal,
      atkItemName, atkItemImg, atkFormula, atkActor,
      defItemName, defItemImg,
      loser, finalDamage, notes, dodgeWin, defCategory: resDC,
    } = res;

    const defCat = resDC ?? defItem?.system?.category ?? "";
    const isClashCounterWin = !atkWins && defCat === "clashCounter";
    const isClashBlockWin   = !atkWins && defCat === "clashBlock";
    const isDodgeWin        = !!dodgeWin;
    const noTake            = isDodgeWin || isClashBlockWin;

    const resolveTitle = isClashCounterWin ? "⚔️ 强化反击"
                       : isDodgeWin        ? "闪避成功"
                       : isClashBlockWin   ? "格挡成功"
                       : "拼点对抗";

    const atkTotalStyle = atkWins
      ? "font-size:2rem;font-weight:bold;color:#E8C9A2;"
      : "font-size:2rem;font-weight:bold;color:#B84444;";
    const defTotalStyle = !atkWins
      ? "font-size:2rem;font-weight:bold;color:#E8C9A2;"
      : "font-size:2rem;font-weight:bold;color:#B84444;";
    // 闪避平局时两边点数相等，显示 "=" 但结果是守方躲开
    const cmp = atkTotal === defTotal ? "=" : (atkTotal > defTotal ? ">" : "<");


    // 容量扩散信息：谁打出伤害就带谁的攻击容量。
    // 攻击方获胜 → 用攻击技能；反击/可拼点反击获胜 → 用守备技能（守备技能同样有攻击容量）。
    const isCounterWin = !atkWins && (defCat === "counter" || defCat === "clashCounter");
    const weightSpread = atkWins ? {
      attackerId: atkActor?.id      ?? "",
      rollTotal:  initFlags.rollTotal ?? 0,
      category:   initFlags.category  ?? "",
      sinType:    initFlags.sinType   ?? "",
      weight:     initFlags.weight    ?? 1,
      itemId:     initFlags.itemId    ?? "",
      itemName:   initFlags.itemName  ?? "",
      itemImg:    initFlags.itemImg   ?? "",
    } : isCounterWin ? {
      attackerId: defActor?.id ?? "",
      rollTotal:  res.defTotal ?? 0,
      category:   defItem?.system?.counterType ?? defItem?.system?.category ?? "",
      sinType:    defItem?.system?.sinType ?? "",
      weight:     defItem?.system?.weight  ?? 1,
      itemId:     defItem?.id   ?? "",
      itemName:   defItemName   ?? "",
      itemImg:    defItemImg    ?? "",
    } : null;

    // 结算结果：直接扣血，不需要人再选一次 Token（handleApplyDamage 本来就优先用
    // flags 里的目标 id）。重新骰掷仅 GM 可见——玩家能随意重摇结果，规则就没意义了。
    const isGM = game.user?.isGM ?? false;
    const takeSection = noTake
        ? `<div style="padding:4px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
             <span style="font-size:.85rem;color:#6EE06E;font-weight:bold;">✓ 防守成功，无伤害</span>
             ${isGM ? `<button class="clash-btn-redo lc-btn dim"
                       style="margin-left:auto;height:30px;padding:0 14px;background:#241B12;color:#9A8462;
                              border:1px solid #5A3A1A;border-radius:2px;cursor:pointer;font-size:.85rem;">重新骰掷</button>` : ""}
           </div>`
        : `<div class="lc-btn-row" style="display:flex;gap:8px;align-items:stretch;">
             <button class="clash-btn-settle lc-btn primary"
                     data-target-actor-id="${loser?.id ?? ""}"
                     data-damage="${finalDamage}"
                     style="flex:1;height:30px;padding:0 14px;background:#5F3E22;color:#E8C9A2;
                            border:1px solid #C9A84C;border-radius:2px;cursor:pointer;font-size:.85rem;">
               结算结果
             </button>
             ${isGM ? `<button class="clash-btn-redo lc-btn dim"
                       style="height:30px;padding:0 14px;background:#241B12;color:#9A8462;
                              border:1px solid #5A3A1A;border-radius:2px;cursor:pointer;font-size:.85rem;">重新骰掷</button>` : ""}
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
        ${ClashManager._buildDetailsFold(actMsgs)}
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

    return await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: atkActor }),
      content,
      flags: {
        limbusCompany_FVTT: {
          type:          "clash-resolve",
          targetActorId: loser?.id ?? "",
          damage:        finalDamage,
          weightSpread,
          // 整局重掷所需：重新骰一次双方，再跑一遍完整流程（仅 GM）
          redoData: {
            defActorId: defActor?.id ?? "",
            defItemId:  defItem?.id  ?? "",
            defFormula: defFormula   ?? "",
            initFlags,
          },
        },
      },
    });
  }

  /* ─── 详细信息：按触发时机排序，注入拼点对抗卡的折叠区 ───────────────── */

  /** 卡面上的触发时机顺序，详细信息按它排序 */
  static TRIGGER_ORDER = [
    "攻击前", "攻击时", "拼点时", "拼点成功", "拼点失败",
    "命中时", "暴击命中时", "攻击后",
  ];

  /**
   * 「▼ 详细信息」折叠区：本次对抗收集到的全部 activity 消息，按卡面的触发时机排序。
   * 建卡时直接拼进去——早先是建完卡再 msg.update() 注入，那条路太脆：
   * 占位符会被清洗、跨客户端还有写权限问题，失败时整块静默消失。
   * @param {object[]} actMsgs
   */
  static _buildDetailsFold(actMsgs) {
    if (!actMsgs?.length) return "";

    const order = ClashManager.TRIGGER_ORDER;
    const rank  = (t) => { const i = order.indexOf(t); return i < 0 ? order.length : i; };

    // 同一触发时机的多条合并到一组，组间按卡面顺序排
    const groups = new Map();
    for (const e of actMsgs) {
      if (!groups.has(e.trigger)) groups.set(e.trigger, []);
      for (const m of (e.msgs ?? [])) {
        const src = `${e.ownerName && e.ownerName !== e.itemName ? `${e.ownerName}·` : ""}${e.itemName ?? ""}`;
        groups.get(e.trigger).push({ m, src });
      }
    }
    const n = [...groups.values()].reduce((a, v) => a + v.length, 0);
    if (!n) return "";

    const body = [...groups.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(([trigger, rows]) => `
        <div class="lc-trig-g">
          <div class="k">${trigger}</div>
          ${rows.map(r => `<div class="v">${r.m}${r.src ? ` <span class="src">· ${r.src}</span>` : ""}</div>`).join("")}
        </div>`).join("");

    return `
      <div class="limbus-detail-toggle-row"
           style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:6px 0 0;user-select:none;">
        <div style="flex:1;height:1px;background:linear-gradient(to right,transparent,#C9A84C);"></div>
        <span class="limbus-detail-toggle"
              style="font-size:.72rem;color:#C9A84C;padding:0 4px;line-height:1;">▼ 详细信息（${n}）</span>
        <div style="flex:1;height:1px;background:linear-gradient(to left,transparent,#C9A84C);"></div>
      </div>
      <div class="limbus-detail-section"
           style="display:none;font-size:.8rem;line-height:1.8;padding:6px 8px;
                  background:rgba(0,0,0,.25);border-radius:3px;margin:4px 0 0;">
        ${body}
      </div>`;
  }

  /** 丢掉 removed 这一格之后，"宣言时就在场"的下标表怎么变（右边整体左移一格） */
  static _shiftDeclaredIdx(list = [], removed = 0) {
    return list.filter(i => i !== removed).map(i => (i > removed ? i - 1 : i));
  }

  /**
   * 在战斗袋里定位这条【丢弃】消耗要丢的槽位。
   *
   * 规则：只看激活槽 0/1（预备模式看槽 2）；触发这条消耗的技能永远不会丢弃自己，
   * 【等级】模式也只是判断"另一张"是不是该等级。
   * 【等级】模式下 0/1 两格都符合时两张一起丢——但【丢弃时】只触发一次。
   * 【等级】可以写成多个（"2/3" 或 [2,3]），表示"Lv.2 或 Lv.3"，任一命中即丢。
   *
   * @param {number[]|null} declaredIdx 还剩哪些"宣言时就在场"的槽位下标。
   *        给了就只认这些位置，本次结算中途补位顶上来的新牌不会被后面的消耗吃掉。
   * @returns {number[]} 命中的槽位下标（升序）；空数组表示没有可丢的牌
   */
  static _findDiscardSlots(owner, slots = [], cost = {}, selfId = "", declaredIdx = null) {
    const ok = (i) => !declaredIdx || declaredIdx.includes(i);
    const mode = cost.discardMode ?? "level";
    if (mode === "reserve") {
      const id = slots[2];
      return (id && id !== selfId && ok(2)) ? [2] : [];
    }
    const levels = ClashManager._parseDiscardLevels(cost.discardLevel);
    const hits   = [];
    for (let i = 0; i <= 1; i++) {
      const id = slots[i];
      if (!id || id === selfId) continue;          // 永远不丢自己
      if (!ok(i)) continue;                        // 宣言之后才顶上来的牌不算
      if (mode === "another") return [i];          // 【另一个】只丢一张
      const sk = owner?.items?.get(id);
      if (sk && levels.includes(sk.system?.level ?? 1)) hits.push(i);
    }
    return hits;
  }

  /**
   * 【丢弃·等级】的等级值解析。
   * 单个等级写数字（2）；"或"关系写成 "2/3"（也接受 "、"「,」空格 分隔）或数组 [2,3]。
   * @returns {number[]} 至少含一个等级；解析不出东西时退回 [1]
   */
  static _parseDiscardLevels(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? 1).split(/[^0-9]+/);
    const out  = list.map(v => parseInt(v)).filter(v => Number.isInteger(v) && v > 0);
    return out.length ? [...new Set(out)] : [1];
  }

  /* ─── 本次攻击内的临时骰面改动 ─────────────────────────────────────── */

  /** 会写回物品、因而需要打完还原的字段 */
  static TEMP_MOD_PATHS = [
    "system.diceCount", "system.diceFaces", "system.baseValue",
    "system.weight", "system.diceType",
  ];

  /**
   * 改动前把原值记到物品 flag 上（同一次攻击里只记第一次的原值），
   * 供 [攻击后] 结束时还原——这四个字段一律只在本次攻击内有效。
   */
  static async _stashItemMod(item, path) {
    if (!item) return;
    const cur = item.getFlag?.("limbusCompany_FVTT", "tempMods") ?? {};
    if (Object.prototype.hasOwnProperty.call(cur, path)) return;   // 已经记过原值
    const orig = foundry.utils.getProperty(item, path);
    await ClashManager._safeDocUpdate(item, {
      [`flags.limbusCompany_FVTT.tempMods`]: { ...cur, [path]: orig },
    });
  }

  /** 一次攻击结束：把临时改动过的骰数/面数/基础值/攻击容量还原回去 */
  static async _restoreItemMods(item) {
    if (!item) return;
    const mods = item.getFlag?.("limbusCompany_FVTT", "tempMods");
    if (!mods || !Object.keys(mods).length) return;
    const update = { "flags.limbusCompany_FVTT.-=tempMods": null };
    for (const [path, orig] of Object.entries(mods)) {
      if (ClashManager.TEMP_MOD_PATHS.includes(path)) update[path] = orig;
    }
    await ClashManager._safeDocUpdate(item, update);
  }

  /** 攻防双方的技能与装备格物品一起还原 */
  static async _restoreAllItemMods(...items) {
    const actors = new Set();
    for (const item of items) {
      if (!item) continue;
      await ClashManager._restoreItemMods(item);
      for (const eq of ClashManager._getEquippedItems(item.parent ?? null)) {
        await ClashManager._restoreItemMods(eq);
      }
      if (item.parent) actors.add(item.parent);
    }
    // 骰子数值还原完，顺带处理临时技能转换的还原。
    // 放在这里 = [攻击后] 已经派发完，临时形态该做的事都做完了。
    // 先「使用一次后还原」——这次真正投出去的就是 items 里的这几张；
    // 再「本次结算后还原」，把这次结算里刚换上、并不打算留到下次的那些收回。
    for (const item of items) {
      if (!item?.parent) continue;
      await ClashManager._revertTempSkillConvertsOnUse(item.parent, item.id);
    }
    for (const actor of actors) {
      await ClashManager._revertTempSkillConverts(actor, "afterClash");
    }
  }

  /* ─── 临时技能转换的还原登记 ─────────────────────────────────────────────
   * 【相关技能转换】默认是永久的，还原要靠目标技能自己再写一条转换回去。
   * 但那条"转回去"挂在**目标技能**上，它分不清自己是被哪条路径换上来的——
   * 永久转换和临时转换共用同一个强化形态时，任何一次使用都会把两边一起还原。
   * 所以还原改成挂在**转换这一侧**：谁临时换的，谁负责到点换回去。
   * 记录写在角色 flag 上（跨 action 持久化），栈式：后进先出地还原。
   * ──────────────────────────────────────────────────────────────────── */
  static TEMP_CONVERT_FLAG = "tempSkillConverts";

  static async _pushTempSkillConvert(actor, fromId, toId, until, slot = null) {
    if (!actor || !fromId || !toId) return;
    const list = foundry.utils.deepClone(
      actor.getFlag?.("limbusCompany_FVTT", ClashManager.TEMP_CONVERT_FLAG) ?? []);
    list.push({ from: fromId, to: toId, until, slot });
    await ClashManager._safeDocUpdate(actor,
      { [`flags.limbusCompany_FVTT.${ClashManager.TEMP_CONVERT_FLAG}`]: list });
  }

  /** 按记录把一个槽位还原回去（有槽位记账就按槽位，老数据回退到按 id） */
  static async _applyTempConvertRevert(actor, rec) {
    let ok = false;
    if (rec?.slot?.kind) ok = await actor.setSkillSlot?.(rec.slot, rec.from);
    else                 ok = await actor.replaceSkillSlot?.(rec.to, rec.from);
    if (ok) actor.sheet?._replaceCombatBagSkill?.(rec.to, rec.from);
    return ok;
  }

  /**
   * 还原到期的临时技能转换。
   * @param {Actor}  actor
   * @param {string} until  "afterClash" / "endOfTurn"；传 "all" 还原全部（长休、脱战等）
   */
  static async _revertTempSkillConverts(actor, until) {
    if (!actor) return;
    const list = actor.getFlag?.("limbusCompany_FVTT", ClashManager.TEMP_CONVERT_FLAG) ?? [];
    if (!list.length) return;
    const due  = [];
    const keep = [];
    for (const rec of list) {
      (until === "all" || rec?.until === until ? due : keep).push(rec);
    }
    if (!due.length) return;
    // 后进先出：多层临时转换时按相反顺序剥回去，中间状态才不会错位
    for (const rec of [...due].reverse()) await ClashManager._applyTempConvertRevert(actor, rec);
    await ClashManager._safeDocUpdate(actor,
      { [`flags.limbusCompany_FVTT.${ClashManager.TEMP_CONVERT_FLAG}`]: keep });
  }

  /**
   * 「使用一次后还原」：转换出来的形态被真正用掉一次（作为攻方或守方的骰参与了
   * 一次结算）之后还原。
   *
   * 关键点：**所有指向同一个形态的记录一起还原**。基础技能槽和守备技能槽都被换成
   * 了同一张强化技能时，它整体只是"一次"资源——任一边用掉，另一边也跟着还原回去，
   * 而不是各留各的。按槽位记账，所以两个槽各自回到各自原来的技能。
   *
   * @param {Actor}  actor
   * @param {string} usedItemId  本次结算里真正投出去的那张技能的 id
   */
  static async _revertTempSkillConvertsOnUse(actor, usedItemId) {
    if (!actor || !usedItemId) return;
    const list = actor.getFlag?.("limbusCompany_FVTT", ClashManager.TEMP_CONVERT_FLAG) ?? [];
    if (!list.length) return;
    const due  = list.filter(r => r?.until === "afterUse" && r?.to === usedItemId);
    if (!due.length) return;
    const keep = list.filter(r => !due.includes(r));
    for (const rec of [...due].reverse()) await ClashManager._applyTempConvertRevert(actor, rec);
    await ClashManager._safeDocUpdate(actor,
      { [`flags.limbusCompany_FVTT.${ClashManager.TEMP_CONVERT_FLAG}`]: keep });
  }

  /* ─── EGO 罪孽抗性修改 ────────────────────────────────────────────────── */

  /**
   * EGO 的两种形态：消耗理智的【觉醒】、陷入恐慌的【侵蚀】。
   * 罪孽消耗与罪孽抗性两形态共用；类型 / 骰数 / 攻击容量 / 理智消耗 / 描述 /
   * 激活效果各自独立，由 SkillData.prepareDerivedData 按持有者是否恐慌
   * 直接投影到 item.system 上，因此这里读 sys.* 拿到的已经是当前形态的值。
   *
   * @returns {boolean} 该 EGO 是否配置了侵蚀形态数据
   */
  static _hasCorrodeForm(sys = {}) {
    return !!sys.corrode?.initialized;
  }

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

  /* ─── 整局重掷（仅 GM，剧情关卡放水用）───────────────────────────────── */

  /**
   * 把这一场对抗从头再打一遍：双方重新骰掷，完整流程再走一次。
   *
   * ⚠️ 这是**重打**，不是撤销。上一次已经发生的事不会回滚——加出去的 BUFF、
   * 扣掉的资源、已经引爆的震颤都还在，重打一遍还会再来一次。回滚做不干净
   * （很多效果不可逆），所以这里选择诚实地重打，由 GM 自行裁定要不要手动收拾。
   * 也因此它只给 GM：玩家能随意重摇自己不满意的结果，规则就没意义了。
   */
  static async redoClash(redoData) {
    if (!game.user?.isGM) {
      ui.notifications?.warn("只有 GM 可以重新骰掷。");
      return;
    }
    if (!redoData?.initFlags) return;

    const { defActorId, defItemId, defFormula, initFlags } = redoData;
    const defActor = game.actors.get(defActorId ?? "");
    const defItem  = defActor?.items?.get(defItemId ?? "");
    if (!defActor || !defItem) {
      ui.notifications?.warn("找不到防守方或其技能，无法重新骰掷。");
      return;
    }

    // 攻击方：按原公式重骰，写回 initFlags.rollTotal
    const atkFormula = initFlags.formula ?? initFlags.diceFormula ?? "";
    const flags2 = foundry.utils.deepClone(initFlags);
    if (atkFormula) {
      const atkRoll = await new Roll(atkFormula).evaluate();
      flags2.rollTotal = atkRoll.total;
    }

    // 防守方：按原公式重骰
    const defRoll = await new Roll(defFormula || "1d4").evaluate();

    await ClashManager._sendResponseAndResolve(
      defActor, defItem, defRoll, defFormula, initFlags.msgId ?? "", flags2, -1);
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
          sinType: initFlags.sinType ?? "",
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
    const coveredForActor = initFlags.coveredForId ? (game.actors.get(initFlags.coveredForId) ?? null) : null;
    const atkCtx2 = { atkActor, defActor: baseActor, owner: atkActor, other: baseActor, coveredForActor, _fireCounts: _fc2, _actMsgs: _actMsgs2, _currentItemId: atkItem2?.id ?? "" };
    const defCtx2 = { atkActor, defActor: baseActor, owner: baseActor, other: atkActor, coveredForActor, _fireCounts: _fc2, _actMsgs: _actMsgs2, _currentItemId: "" };

    // 记录触发前原始公式，用于检测变化后重投
    const atkBaseFormulaOrig2 = initFlags.baseFormula ?? initFlags.formula;

    // [攻击前] [攻击时]
    await ClashManager._applyActivitiesAndEquip(atkItem2, "攻击前", atkCtx2);
    await ClashManager._applyActivitiesAndEquip(atkItem2, "攻击时", atkCtx2);
    await ClashManager._dispatchOnAttack(atkActor, atkItem2, atkCtx2);

    // [攻击时] 可能修改骰子公式（diceAdj/diceFacesAdj/baseValue），检测并重投
    let finalRollTotal = rollTotal;
    {
      const newAtkBase = atkItem2?.system?.diceFormula ?? atkBaseFormulaOrig2;
      if (newAtkBase !== atkBaseFormulaOrig2) {
        const bonusPart  = (initFlags.formula ?? "").slice(atkBaseFormulaOrig2.length);
        const newAtkFull = newAtkBase + bonusPart;
        const rerollAtk  = new Roll(newAtkFull);
        await rerollAtk.evaluate();
        ClashManager.applyDiceRollMods(atkActor, rerollAtk, { item: atkItem2, isDefense: false });
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
            sinType: initFlags.sinType ?? "",
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
    const atkDiceMod = strong - weak
      + ClashManager._condPowerMod(atkActor, {
          category: atkItem2?.system?.category ?? initFlags.category ?? "",
          sinType:  atkItem2?.system?.sinType  ?? initFlags.sinType  ?? "" });

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

    // [受到伤害时]：承受方受伤（技能 + 装备格物品 + BUFF 的 onTakeDamage）
    await ClashManager._dispatchTakeDamage(atkItem2, baseActor, atkActor, defCtx2);

    // 单方面攻击（承受）：不拼点，只把对方打退一次，攻击方不追击
    ClashVFX.broadcastBurst(ClashVFX.midPoint(atkActor, baseActor));
    await ClashKnockback.repel({
      winner: atkActor, loser: baseActor, winScore: step, chase: false,
      onWallHit: (a) => ClashManager.seismicBlast(a, 1, { attacker: atkActor }),
    });

    // [攻击后]：必须在建卡之前跑完，详细信息才收得全（与拼点对抗卡同理）
    await ClashManager._applyActivitiesAndEquip(atkItem2, "攻击后", atkCtx2);
    await ClashManager._restoreAllItemMods(atkItem2);

    // 单方面攻击卡：与拼点对抗卡同一套流程——先把结果摆出来，
    // 扣血、破裂/沉沦/震颤引爆等等都等【结算结果】按下去才发生。
    await ClashManager._sendDirectTakeMsg({
      actMsgs: _actMsgs2,
      atkActor, defActor: baseActor, item: atkItem2,
      finalDamage, calcNotes, initFlags,
      weightSpread: (initFlags.weight ?? 1) >= 2 ? {
        attackerId: atkActor?.id     ?? "",
        rollTotal:  initFlags.rollTotal ?? 0,
        category:   initFlags.category  ?? "",
        sinType:    initFlags.sinType   ?? "",
        weight:     initFlags.weight    ?? 1,
        itemId:     initFlags.itemId    ?? "",
        itemName:   initFlags.itemName  ?? "",
        itemImg:    initFlags.itemImg   ?? "",
      } : null,
    });

    await ClashManager._broadcastAndCheckReactions({ lastSkillUuid: atkItem2?.uuid ?? null, attacker: atkActor, defender: defActor });
  }

  /**
   * 单方面攻击卡：在【发起对抗】阶段直接点【承受】走的就是这条路。
   * 结构与拼点对抗卡一致，只是没有对手那一侧，也没有胜负——
   * 头像标题 → 技能 → 结算数字 → 详细信息 → 结算结果 / 重新骰掷。
   */
  static async _sendDirectTakeMsg({ atkActor, defActor, item, finalDamage,
                                    calcNotes = [], initFlags = {}, weightSpread = null,
                                    actMsgs = [] }) {
    const isGM = game.user?.isGM ?? false;
    const img  = item?.img ?? initFlags.itemImg ?? "";
    const name = item?.name ?? initFlags.itemName ?? "技能";
    const sys  = item?.system ?? {};
    const meta = [ClashManager._catLabel(sys.category), sys.diceFormula]
      .filter(Boolean).join(" · ");

    const content = `
      <div class="limbus-clash-card" data-clash-type="direct-take">
        ${ClashManager._chatHeader(atkActor ?? { img: "", name: "?" }, "单方面攻击")}
        ${ClashManager._goldDivider()}

        <div style="display:flex;align-items:center;gap:10px;">
          <img src="${img}" style="width:50px;height:50px;object-fit:cover;flex-shrink:0;" alt="">
          <div style="min-width:0;">
            <div style="font-size:13px;color:#E8C9A2;">${defActor?.name ?? "?"}</div>
            <div style="font-size:12px;color:#9A8462;">${name}${meta ? `　<span style="color:#EBBD68;">${meta}</span>` : ""}</div>
          </div>
        </div>

        ${ClashManager._goldDivider()}
        <div style="text-align:center;margin:8px 0;">
          <div style="font-size:14px;color:#C9A84C;margin-bottom:6px;">结算</div>
          <div style="font-size:2rem;font-weight:bold;color:#B84444;">${finalDamage}</div>
        </div>

        ${ClashManager._goldDivider()}
        ${ClashManager._buildDetailsFold(actMsgs)}
        ${calcNotes.length ? `
        <div style="font-size:.8rem;color:#9A8462;line-height:1.7;margin:4px 0 8px;">
          ${calcNotes.map(n => `<div>${n}</div>`).join("")}
        </div>` : ""}

        ${ClashManager._goldDivider()}
        <div class="lc-btn-row" style="display:flex;gap:8px;align-items:stretch;">
          <button class="clash-btn-settle lc-btn primary"
                  data-target-actor-id="${defActor?.id ?? ""}"
                  data-damage="${finalDamage}"
                  style="flex:1;height:30px;padding:0 14px;background:#5F3E22;color:#E8C9A2;
                         border:1px solid #C9A84C;border-radius:2px;cursor:pointer;font-size:.85rem;">
            结算结果
          </button>
          ${isGM ? `<button class="clash-btn-redo lc-btn dim"
                    style="height:30px;padding:0 14px;background:#241B12;color:#9A8462;
                           border:1px solid #5A3A1A;border-radius:2px;cursor:pointer;font-size:.85rem;">重新骰掷</button>` : ""}
        </div>
      </div>`;

    return await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: atkActor }),
      content,
      flags: {
        limbusCompany_FVTT: {
          type:          "clash-resolve",   // 复用拼点对抗卡的按钮处理器
          targetActorId: defActor?.id ?? "",
          damage:        finalDamage,
          weightSpread,
          directRedo:    { initFlags },
        },
      },
    });
  }

  /**
   * 单方面攻击的整局重掷（仅 GM）。攻击方按原公式重骰一次，再走一遍承受流程。
   * 与 redoClash 一样是**重打不是撤销**，已发生的效果不回滚。
   */
  static async redoDirectTake(directRedo) {
    if (!game.user?.isGM) {
      ui.notifications?.warn("只有 GM 可以重新骰掷。");
      return;
    }
    const initFlags = directRedo?.initFlags;
    if (!initFlags) return;

    const flags2  = foundry.utils.deepClone(initFlags);
    const formula = initFlags.formula ?? "";
    if (formula) {
      const roll = await new Roll(formula).evaluate();
      flags2.rollTotal = roll.total;
      flags2.rollData  = (typeof roll.toJSON === "function") ? roll.toJSON() : null;
    }
    await ClashManager.handleDirectTake(flags2);
  }

  /* ─── 容量扩散承受 ──────────────────────────────────────────────────────── */

  /** 构建容量扩散卡 HTML（remainingUses / hits 变化时复用于更新消息内容）。 */
  static _buildWeightSpreadContent(flags, remainingUses, atkActor) {
    const actor       = atkActor ?? game.actors.get(flags.attackerId);
    const btnDisabled = remainingUses <= 0 || !!flags.running;
    const btnStyle    = btnDisabled
      ? "background:#2A2521;color:#6A5A48;border:1px solid #3A3227;cursor:not-allowed;"
      : "background:#5F3E22;color:#E8C9A2;border:1px solid #C9A84C;cursor:pointer;";
    const btnLabel    = flags.running ? "扩散中…" : remainingUses <= 0 ? "（已用尽）" : `结算结果（×${remainingUses}）`;

    // 容量方块：拼点那一击本身占 1 点
    const cap  = flags.weight ?? 1;
    const used = cap - 1 - remainingUses;
    const sqs  = Array.from({ length: cap }, (_, i) => {
      const spent = i <= used;
      return `<span style="display:inline-block;width:9px;height:9px;transform:rotate(45deg);
        margin-right:4px;border:1px solid ${spent ? "#443A2A" : "#6B5822"};
        background:${spent ? "#2A2521" : "#C9A84C"};"></span>`;
    }).join("");

    const modeLabel = flags.spreadMode === "spray" ? "广域乱射" : "链式扩散";
    const ft        = ((flags.spreadRange ?? 1) * 5 + 2.5).toFixed(1);
    const indisLabel = flags.indiscriminate
      ? `<span style="font-size:.62rem;color:#B84444;margin-left:6px;font-weight:bold;">无差别攻击</span>`
      : "";
    const modeLine  = cap >= 2
      ? `<span style="font-size:.62rem;color:#C9A84C;margin-left:6px;">${modeLabel} · ${ft}ft</span>${indisLabel}`
      : indisLabel;

    // 战果：每个目标一个 40px 缩小版结算块（与承受结算卡同构，小一档）
    const hits  = flags.hits ?? [];
    const total = hits.reduce((a2, h) => a2 + (h.dmg ?? 0), 0);
    const log = hits.length
      ? hits.map(h => {
          const tgt = game.actors.get(h.actorId);
          return ClashManager._hpBlock({
            actor:  tgt ?? { name: h.name, img: "icons/svg/mystery-man.svg" },
            oldHp:  h.oldHp ?? 0, newHp: h.newHp ?? 0, maxHp: h.maxHp ?? 1,
            triggers: [
              ...(h.note ? [{ k: "命中", v: h.note }] : []),
              ...(h.trg ?? []),
            ],
            sm: true,
          });
        }).join("")
      : `<div style="color:#5B4F40;font-size:.7rem;font-style:italic;padding:2px 0;">尚无战果</div>`;

    return `
      <div class="limbus-clash-card" data-clash-type="weight-spread">
        ${ClashManager._chatHeader(actor, "容量扩散")}
        ${ClashManager._goldDivider()}
        <div class="lc-spread-meta">
          <span class="sk">【${flags.itemName ?? "技能"}】</span>容量扩散
          <span class="mode">　${modeLabel} · <span class="ft">${ft}ft</span></span>${indisLabel}
        </div>
        <div style="margin:4px 0 0;">
          <span style="font-size:.62rem;color:#9A8462;margin-right:4px;">攻击容量</span>${sqs}
        </div>
        ${ClashManager._goldDivider()}
        ${log}
        ${hits.length ? `<div style="border-top:1px solid #3A3227;margin-top:6px;padding-top:3px;
            font-size:.68rem;color:#9A8462;">合计
            <span style="color:#B84444;font-weight:bold;">${total}</span> · 命中 ${hits.length} 次</div>` : ""}
        ${ClashManager._goldDivider()}
        <div class="lc-btn-row" style="display:flex;gap:8px;align-items:stretch;">
          <button class="clash-btn-weight-take"
                  style="flex:1;height:30px;padding:0 14px;${btnStyle}font-size:.85rem;border-radius:2px;"
                  ${btnDisabled ? "disabled" : ""}>
            ${btnLabel}
          </button>
        </div>
        <div style="font-size:.62rem;color:#6A5A48;margin-top:4px;">
          ${cap >= 2
            ? (flags.spreadMode === "spray" ? "范围内随机抽取，可能重复命中" : "范围内逐个打过去，不重复")
            : "点击自动结算这一次扩散"}
        </div>
      </div>`;
  }

  /** 发送容量扩散承受聊天卡。 */
  static async _sendWeightSpreadCard(initFlags, atkActor, firstHit = null) {
    const remainingUses = (initFlags.weight ?? 1) - 1;
    const atkItem = atkActor?.items?.get(initFlags.itemId ?? "") ?? null;
    const spreadFlags = {
      type:          "clash-weight-spread",
      attackerId:    initFlags.attackerId,
      itemId:        initFlags.itemId,
      itemName:      initFlags.itemName,
      itemImg:       initFlags.itemImg,
      rollTotal:     initFlags.rollTotal,
      category:      initFlags.category,
      sinType:       initFlags.sinType,
      weight:        initFlags.weight ?? 1,
      spreadMode:    atkItem?.system?.spreadMode  ?? "chain",
      spreadRange:   atkItem?.system?.spreadRange ?? 1,
      indiscriminate: !!atkItem?.system?.indiscriminate,
      anchorId:      firstHit?.actorId ?? initFlags.firstTargetId ?? "",
      hits:          firstHit ? [firstHit] : [],
      remainingUses,
    };
    await ClashManager._safeChatCreate({
      speaker: ChatMessage.getSpeaker({ actor: atkActor }),
      content: ClashManager._buildWeightSpreadContent(spreadFlags, remainingUses, atkActor),
      flags:   { limbusCompany_FVTT: spreadFlags },
    });
  }

  /**
   * 单个扩散目标的伤害计算（与拼点伤害同一套：强壮/虚弱 → 等级差 → 易损/守护 → 抗性）
   * @returns {{ finalDamage: number, calcNotes: string[], resNote: string }}
   */
  static _spreadDamage(atkActor, defActor, { rollTotal = 0, category = "", sinType = "" } = {}) {
    const PHYS_CATS   = ["slash", "blunt", "pierce"];
    const SIN_TYPES   = ["wrath","lust","sloth","gluttony","gloom","pride","envy"];
    const PHYS_LABELS = { slash: "斩击", blunt: "打击", pierce: "突刺" };
    const SIN_LABELS  = { wrath:"暴怒", lust:"色欲", sloth:"怠惰",
                          gluttony:"暴食", gloom:"忧郁", pride:"傲慢", envy:"嫉妒" };
    const gs = (actor, type) => ClashManager._getBuffVal(actor, type).stacks;

    const strong     = atkActor ? gs(atkActor, "strong") : 0;
    const weak       = atkActor ? gs(atkActor, "weak")   : 0;
    const atkDiceMod = strong - weak
      + ClashManager._condPowerMod(atkActor, { category, sinType });

    const atkLv   = atkActor ? ClashManager._effAtkLv(atkActor) : 0;
    const defLv   = ClashManager._effDefLv(defActor);
    const lvBonus = Math.floor(Math.max(0, atkLv - defLv) / 3);

    const effectiveAtk = rollTotal + atkDiceMod + lvBonus;
    const guard        = gs(defActor, "guard");
    const fragile      = gs(defActor, "fragile");
    const adjustedAtk  = Math.max(0, effectiveAtk + fragile - guard);

    const effRes     = ClashManager._getEffectiveResistances(defActor);
    const physResStr = PHYS_CATS.includes(category) ? (effRes[category] ?? "x1.0") : "x1.0";
    const sinResStr  = SIN_TYPES.includes(sinType)
      ? (defActor.system?.egoResistances?.[sinType] ?? "x1.0") : "x1.0";
    const physMult   = ClashManager._parseResistance(physResStr);
    const sinMult    = ClashManager._parseResistance(sinResStr);
    const finalDamage = Math.max(0, Math.round(adjustedAtk * physMult * sinMult));

    const calcNotes = [`骰点结果：${rollTotal}（容量扩散）`];
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
    }
    if (fragile > 0 || guard > 0) {
      const prev = step;
      step = adjustedAtk;
      const parts = [];
      if (fragile > 0) parts.push(`易损+${fragile}`);
      if (guard   > 0) parts.push(`守护-${guard}`);
      calcNotes.push(`${parts.join("，")}：${prev} → ${step}`);
    }
    const resParts = [];
    if (physMult !== 1.0) resParts.push(`${PHYS_LABELS[category] ?? category}抗性${physResStr}`);
    if (sinMult  !== 1.0) resParts.push(`${SIN_LABELS[sinType]  ?? sinType}罪孽抗性${sinResStr}`);
    if (resParts.length) calcNotes.push(`${resParts.join(" × ")}：${step} → ${finalDamage}`);

    return { finalDamage, calcNotes, resNote: resParts.join(" × ") };
  }

  /* ─── 容量扩散：自动连续结算 ─────────────────────────────────────────── */

  /** 攻击方 token（优先控制中的那一个） */
  static _tokenOfActor(actor) {
    if (!actor || !canvas?.ready) return null;
    const list = canvas.tokens?.placeables?.filter(t => t.actor?.id === actor.id) ?? [];
    return list.find(t => t.controlled) ?? list[0] ?? null;
  }

  /**
   * 某个角色的敌对阵营 actor id 列表（与效果编辑器【敌对全部】同一套：
   * 走世界设定里的小队编成 squadTeam1 / squadTeam2）。
   * @returns {string[]|null} null 表示没配小队，调用方退回 token 阵营判断
   */
  static _foeIdsOf(actorId) {
    let t1 = [], t2 = [];
    try { t1 = game.settings.get("limbusCompany_FVTT", "squadTeam1") ?? []; } catch { /* 未注册 */ }
    try { t2 = game.settings.get("limbusCompany_FVTT", "squadTeam2") ?? []; } catch { /* 未注册 */ }
    if (!t1.length && !t2.length) return null;
    if (t1.includes(actorId)) return t2;
    if (t2.includes(actorId)) return t1;
    return null;
  }

  /** 切比雪夫格距（1 格 = 5ft；半径 N → N×5+2.5 ft） */
  static _cellDist(a, b) {
    const gs = canvas?.grid?.size ?? 100;
    return Math.max(
      Math.round(Math.abs(a.center.x - b.center.x) / gs),
      Math.round(Math.abs(a.center.y - b.center.y) / gs),
    );
  }

  /**
   * 点击【承受】：按技能配置的扩散方式自动连续结算，直到打满攻击容量。
   *  链式扩散：以上一个受害者为中心，范围内不重复的敌人逐个打
   *  广域乱射：以拼点对手为中心，范围内随机抽（可能重复）
   * 每一发：攻击方瞬移到目标身边空位 → TOTAL 累加（无骰子动画）→ 结算伤害
   */
  static async handleWeightTake(msgId, flags) {
    let remaining = flags.remainingUses ?? 0;
    if (remaining <= 0) { ui.notifications.warn("扩散承受次数已用尽"); return; }
    if (flags.running)  return;

    const atkActor = game.actors.get(flags.attackerId);
    const atkTok   = ClashManager._tokenOfActor(atkActor);
    if (!atkTok) { ui.notifications.warn("找不到攻击方 Token，无法进行容量扩散"); return; }

    const msg  = game.messages.get(msgId);
    const mode = flags.spreadMode  ?? "chain";
    const rng  = Math.max(1, flags.spreadRange ?? 1);
    const hits = [...(flags.hits ?? [])];
    const setCard = async (extra = {}) => {
      if (!msg) return;
      const f = { ...flags, hits, remainingUses: remaining, ...extra };
      await ClashManager._safeDocUpdate(msg, {
        flags: { limbusCompany_FVTT: f },
        content: ClashManager._buildWeightSpreadContent(f, remaining, atkActor),
      });
    };
    await setCard({ running: true });

    // 镜头给攻击方 + 亮出当前累计 TOTAL
    let total = hits.reduce((a, h) => a + (h.dmg ?? 0), 0);
    ClashVFX.broadcastPan({ ...atkTok.center });
    await ClashTotalFX.spreadOpen({ label: "容量扩散", total });

    // 【无差别攻击】：敌我不分，范围内所有人（含友方）都算候选目标，只排除攻击者自己
    const indiscriminate = !!flags.indiscriminate;
    const foeIds      = indiscriminate ? null : ClashManager._foeIdsOf(atkActor?.id ?? "");
    let   started     = false;
    // 扩散全程共用一份触发计数与消息表：次数限制按整次扩散算，消息最后统一发
    const fireCounts  = {};
    const actMsgs     = [];
    const hitActorIds = new Set(hits.map(h => h.actorId));
    let anchorId = flags.anchorId || hits[0]?.actorId || "";

    while (remaining > 0) {
      const anchorTok = ClashManager._tokenOfActor(game.actors.get(anchorId)) ?? atkTok;
      const centerTok = (mode === "spray")
        ? (ClashManager._tokenOfActor(game.actors.get(flags.hits?.[0]?.actorId ?? anchorId)) ?? anchorTok)
        : anchorTok;

      const cands = (canvas.tokens?.placeables ?? []).filter(t => {
        if (!t.actor || t.id === atkTok.id || t.actor.id === atkActor?.id) return false;
        if ((t.actor.system?.hp?.value ?? 0) <= 0) return false;
        // 敌对判定：优先用小队编成，没配小队才退回 token 阵营
        if (!indiscriminate) {
          if (foeIds) { if (!foeIds.includes(t.actor.id)) return false; }
          else if (t.document.disposition === atkTok.document.disposition) return false;
        }
        if (ClashManager._cellDist(centerTok, t) > rng) return false;
        if (mode === "chain" && hitActorIds.has(t.actor.id)) return false;          // 链式不重复
        return true;
      });
      if (!cands.length) {
        console.warn("[容量扩散] 范围内没有可打的目标", {
          模式: mode, 范围格数: rng, 中心: centerTok?.actor?.name,
          敌对名单: foeIds, 场上Token: (canvas.tokens?.placeables ?? []).map(t => ({
            名字: t.actor?.name, id: t.actor?.id, 格距: ClashManager._cellDist(centerTok, t),
          })),
        });
        if (!started) {
          ui.notifications.info(indiscriminate
            ? `容量扩散（无差别攻击）：范围内（${rng} 格）没有其他可打的单位`
            : foeIds
              ? `容量扩散：范围内（${rng} 格）没有其他敌对目标`
              : "容量扩散：未编成小队，改用 Token 阵营判断，范围内没有敌对目标");
        }
        break;
      }
      started = true;

      const tgtTok = (mode === "spray")
        ? cands[Math.floor(Math.random() * cands.length)]
        : cands[0];
      const tgtActor = tgtTok.actor;

      // ① 瞬移到目标身边（风线由 approach 负责）
      // 乱射：绕到目标背后，一发一发换位置；链式：正面扑上去
      await ClashKnockback.approach(atkTok, tgtTok, { behind: mode === "spray" });
      await new Promise(r => setTimeout(r, ClashManager.SPREAD_STEP_MS));

      // ② 伤害计算（乱射每发重投，链式沿用拼点骰点）
      let roll = flags.rollTotal ?? 0;
      if (mode === "spray") {
        const item = atkActor?.items?.get(flags.itemId ?? "");
        const fml  = item?.system?.diceFormula;
        if (fml) { const r = new Roll(fml); await r.evaluate(); roll = r.total; }
      }
      const { finalDamage, calcNotes, resNote } =
        ClashManager._spreadDamage(atkActor, tgtActor, {
          rollTotal: roll, category: flags.category, sinType: flags.sinType,
        });

      // ③ TOTAL 累加 + 目标处 +N
      ClashVFX.broadcastPlus({ ...tgtTok.center }, finalDamage);
      ClashVFX.broadcastBurst({ ...tgtTok.center });
      await ClashTotalFX.spreadTick({
        from: total, to: total + finalDamage, ms: ClashManager.SPREAD_TOTAL_MS,
        combo: `${hits.length + 1} 连击`,
      });
      total += finalDamage;

      // ④ 本骰的 [命中时] / [暴击命中时]：每一发扩散都算一次命中
      const atkItem = atkActor?.items?.get(flags.itemId ?? "") ?? null;
      if (atkItem) {
        const hitCtx = {
          atkActor, defActor: tgtActor, owner: atkActor, other: tgtActor,
          _fireCounts: fireCounts, _actMsgs: actMsgs, _currentItemId: atkItem.id,
        };
        await ClashManager._applyActivitiesAndEquip(atkItem, "命中时", hitCtx);
        // 【呼吸法】暴击判定：每层强度 5% 概率，触发后消耗 1 层
        const breathe = ClashManager._getBuff(atkActor, "breathing");
        if (breathe && (breathe.stacks ?? 0) > 0
            && Math.random() < (breathe.intensity ?? 0) * 0.05) {
          await ClashManager._reduceBuffStacks(atkActor, "breathing");
          await ClashManager._applyActivitiesAndEquip(atkItem, "暴击命中时", hitCtx);
        }
      }

      // ⑤ 落账（静默：不发独立承受卡，结果记在扩散卡上）
      const take = await ClashManager._applyAndSendTake(tgtActor, finalDamage, {
        calcNotes, attacker: atkActor, takeLabel: "容量扩散-承受", silent: true,
        category: flags.category, sinType: flags.sinType, item: atkItem,
      });
      // 触发行：与承受结算卡同一套写法
      const trg = [];
      if (take?.ruptureDmg)      trg.push({ k: "破裂触发", v: `附加 <b>${take.ruptureDmg}</b> 点固定伤害` });
      if (take?.sanityDmg)       trg.push({ k: "沉沦触发", v: `${take.sanityDmg} 点侵蚀度（理智 −${take.sanityDmg}）` });
      if (take?.sinkingGloomDmg) trg.push({ k: "沉沦触发", v: `理智见底，额外承受 <b>${take.sinkingGloomDmg}</b> 点【忧郁】伤害` });
      if (take?.tremorTriggered) trg.push({ k: "震颤引爆", v: "消耗 1 层【震颤】，混乱阈值前移" });
      hits.push({
        actorId: tgtActor.id, name: tgtActor.name, dmg: finalDamage,
        // 血条所需：结算前后生命值与上限
        oldHp: take?.oldHp ?? 0, newHp: take?.finalHp ?? 0, maxHp: take?.maxHp ?? 1,
        trg,
        note: [mode === "spray" ? `骰 ${roll}` : "", resNote].filter(Boolean).join(" · "),
      });
      hitActorIds.add(tgtActor.id);
      if (mode === "chain") anchorId = tgtActor.id;     // 链式：锚点前移
      remaining--;
      await setCard({ running: remaining > 0 });
      await new Promise(r => setTimeout(r, 90));
    }

    ClashTotalFX.spreadClose();
    await ClashManager._flushActMsgs(actMsgs, atkActor);
    await setCard({ running: false, anchorId });
  }

  /** 容量扩散的节奏（ms）：瞬移到位后的停顿 / TOTAL 累加时长 */
  static SPREAD_STEP_MS  = 220;
  static SPREAD_TOTAL_MS = 200;

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
    const buffMod = strong - weak
      + ClashManager._condPowerMod(loserActor, {
          category:    loserItem.system?.category    ?? "",
          counterType: loserItem.system?.counterType ?? "",
          sinType:     loserItem.system?.sinType     ?? "" });
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

    // 收集护盾吸收、onTakeDamage 等 BUFF 钩子消息——【结算结果】按钮这条路径上
    // 没有别的地方会汇总它们，不收就彻底没人报了
    const hookMsgs = [];
    await ClashManager._applyAndSendTake(actor, damage, { hookMsgs });

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
  static async _applyAndSendTake(actor, damage, { isSeismic = false, calcNotes = [], attacker = null, hookMsgs = null, takeLabel = "承受结算", category = "", sinType = "", item = null, silent = false } = {}) {
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
    let shieldBefore = 0;
    if (hpLockValue == null) {
      // 【护盾】：每层抵挡 1 点伤害，先于其他伤害结算，剩余伤害再穿透
      const shieldBuff = ClashManager._getBuff(actor, "shield");
      shieldBefore = shieldBuff?.stacks ?? 0;   // 供承受卡显示「50+8」的那个 +8
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
    const _CHAOS_TYPES  = CONFIG.LIMBUSCOMPANY?.CHAOS_TYPES ?? ["chaos", "chaos_plus", "chaos_double_plus"];
    const _CHAOS_NAMES  = CONFIG.LIMBUSCOMPANY?.CHAOS_NAMES ?? ["陷入混乱", "陷入混乱+", "陷入混乱++"];
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
    await ClashManager._dispatchAllyHpDamage(actor, oldHp - newHp, attacker);

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
    // silent：不发独立的承受卡，把结果交回调用方自己记账（容量扩散用）
    if (!silent) {
      await ClashManager._sendTakeMsg(actor, damage, oldHp, finalHp, maxHp, chaosTriggered,
        { ruptureDmg, sanityDmg, sinkingGloomDmg, tremorTriggered, chaosName, calcNotes, takeLabel,
          shieldBefore, hookMsgs });
    }
    return { damage, oldHp, finalHp, maxHp, chaosTriggered, chaosName,
             ruptureDmg, sanityDmg, sinkingGloomDmg, tremorTriggered };
  }

  /**
   * 承受结算卡。
   * 卡头（50px 圆头像 + 标题 + 角色名）与金色分割线沿用原有美术；
   * 主体换成「生命值一行 + 带混乱阈值刻度的血条 + 触发行」。
   *
   * 「伤害超过混乱阈值」不再写成文字——阈值刻度在血条上看得见，
   * 击穿的演出交给 VFX。
   */
  static async _sendTakeMsg(actor, damage, oldHp, newHp, maxHp, chaosTriggered,
      { ruptureDmg = 0, sanityDmg = 0, sinkingGloomDmg = 0, tremorTriggered = false,
        chaosName = "陷入混乱", calcNotes = [], takeLabel = "承受结算",
        shieldBefore = 0, hookMsgs = null } = {}) {

    const triggers = [];
    if (ruptureDmg > 0) {
      triggers.push({ k: "破裂触发", v: `附加 <b>${ruptureDmg}</b> 点固定伤害` });
    }
    if (sanityDmg > 0) {
      triggers.push({ k: "沉沦触发", v: `${sanityDmg} 点侵蚀度（理智 −${sanityDmg}）` });
    }
    if (sinkingGloomDmg > 0) {
      triggers.push({ k: "沉沦触发", v: `理智见底，额外承受 <b>${sinkingGloomDmg}</b> 点【忧郁】伤害` });
    }
    if (tremorTriggered) {
      triggers.push({ k: "震颤引爆", v: "消耗 1 层【震颤】，混乱阈值前移" });
    }
    // 追加伤害走的是独立的一次承受结算，takeLabel 会带「追加伤害」
    if (takeLabel.includes("追加伤害")) {
      triggers.unshift({ k: "追加伤害", v: `承受 <b>${damage}</b> 点` });
    }
    // BUFF 钩子（护盾吸收、onTakeDamage 等）。烧伤这类也可能由技能效果在此刻触发，
    // 所以不写死类型，来什么列什么。
    for (const m of (hookMsgs ?? [])) triggers.push({ k: "效果触发", v: m });

    const content = `
      <div class="limbus-clash-card limbus-take-card"
           style="background:linear-gradient(180deg,#2D0509 0%,#1A0305 100%);"
           data-clash-type="take">
        ${ClashManager._chatHeader(actor, takeLabel)}
        ${ClashManager._goldDivider()}
        ${ClashManager._hpBlock({ actor, oldHp, newHp, maxHp, shield: shieldBefore, triggers })}
        ${calcNotes.length ? `
        <div style="margin:8px 0 0;padding:5px 7px;background:rgba(0,0,0,.25);border-radius:3px;">
          <div style="font-size:.65rem;font-weight:bold;color:#C9A84C;margin-bottom:3px;letter-spacing:.05em;">结算说明</div>
          ${calcNotes.map(n => `<div style="font-size:.72rem;color:#9A8462;line-height:1.55;">${n}</div>`).join("")}
        </div>` : ""}
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
    // 攻击方：强壮/虚弱 + 拼点威力 + 条件威力
    const atkDiceMod = gs(atkActor, "strong") - gs(atkActor, "weak")
                     + gs(atkActor, "clashPowerUp") - gs(atkActor, "clashPowerDown")
                     + ClashManager._condPowerMod(atkActor, {
                         category: initFlags.category ?? "", sinType: initFlags.sinType ?? "" });
    // 防守方（反击视为守备技能）：忍耐/破绽 + 拼点威力 + 条件威力（物理类型看 counterType）
    const defDiceMod = gs(defActor, "endure") - gs(defActor, "breach")
                     + gs(defActor, "clashPowerUp") - gs(defActor, "clashPowerDown")
                     + ClashManager._condPowerMod(defActor, {
                         category:    defItem.system?.category    ?? "",
                         counterType: defItem.system?.counterType ?? "",
                         sinType:     defItem.system?.sinType     ?? "" });

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
    // 攻击方：强壮/虚弱 + 拼点威力 + 条件威力
    const atkDiceMod = gs(atkActor, "strong") - gs(atkActor, "weak")
                     + gs(atkActor, "clashPowerUp") - gs(atkActor, "clashPowerDown")
                     + ClashManager._condPowerMod(atkActor, {
                         category: initFlags.category ?? "", sinType: initFlags.sinType ?? "" });
    // 防守方：忍耐/破绽（格挡是守备技能）+ 拼点威力 + 条件威力
    // 格挡没有物理类型，所以这里只可能吃到罪孽那 7 条
    const defDiceMod = gs(defActor, "endure") - gs(defActor, "breach")
                     + gs(defActor, "clashPowerUp") - gs(defActor, "clashPowerDown")
                     + ClashManager._condPowerMod(defActor, {
                         category:    defItem.system?.category    ?? "",
                         counterType: defItem.system?.counterType ?? "",
                         sinType:     defItem.system?.sinType     ?? "" });

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
        // 反应只认"正在场上生效"的物品：装备必须真的装上了。
        // 否则背包里躺着的任何一件装备都会跟着弹框（连没装备的人也会被问）
        if (!ClashManager._isItemInPlay(actor, item)) continue;
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
          // 先记账再执行：效果里可能又发起一次对抗，届时会重新走一遍反应检查，
          // 不先扣次数就会自己触发自己
          await ClashManager._bumpLimit(act, item, actor);
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

    if (type === "useSin") {
      // 反应链路：lastSkillUuid 指向触发者刚打出的那张骰
      const sins = Array.isArray(pre.sinTypes) ? pre.sinTypes : (pre.sinType ? [pre.sinType] : []);
      if (!sins.length) return false;
      const skill = lastSkillUuid ? await fromUuid(lastSkillUuid).catch(() => null) : null;
      return sins.includes(skill?.system?.sinType);
    }

    if (type === "noBuff") {
      // 【未拥有】：【拥有】的反面
      if (!targetActor || !pre.buff) return false;
      const buffs = targetActor.system?.buffs ?? [];
      const found = buffs.find(b => b.type === pre.buff || b.name === pre.buff);
      if (!found) return true;
      if ((pre.intensity ?? 0) > 0 && (found.intensity ?? 0) < pre.intensity) return true;
      if ((pre.stacks    ?? 0) > 0 && (found.stacks    ?? 0) < pre.stacks)    return true;
      return false;
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

    if (type === "equipped") {
      if (!targetActor) return false;
      const have = ClashManager._countEquipped(targetActor, pre);
      return have >= Math.max(1, pre.count ?? 1);
    }

    if (type === "background") {
      // 背景：检查所选一方的"背景名称"或"背景标签"是否匹配
      const want = String(pre.bgName ?? "").trim();
      if (!want || !targetActor) return false;
      const bgUuid = targetActor.system?.background?.uuid;
      const bg = bgUuid ? await fromUuid(bgUuid).catch(() => null) : null;
      if (!bg) return false;
      if (bg.name === want) return true;
      const tags = await ClashManager._getBackgroundTags(targetActor);
      return tags.includes(want);
    }

    if (type === "useSkill") {
      // lastSkillUuid 恒来自攻击方技能（广播时固定传 atkItem.uuid），故施放者视为 attacker
      if (!lastSkillUuid || !attacker) return false;
      const scope = await ClashManager._resolveTargets(pre.target ?? "self", actor, attacker, pre);
      if (!scope.some(a => a.id === attacker.id)) return false;
      const skillItem = await fromUuid(lastSkillUuid).catch(() => null);
      return ClashManager._matchSkillIdentity(skillItem, pre);
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
      // 旧数据：使用等级已并入 useSkill 的"等级"字段，此分支仅作兼容
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
  /**
   * 【使用技能】前置的匹配：名称/标签 与 技能等级 都是可选的，
   * 填了的才检查，两个都填则需同时满足（如"标签「黑兽」的 Lv.3 技能"）。
   * 两个都没填视为不成立，避免"任何技能都触发"的误配置。
   * skillUuid 是旧数据字段，仍然兼容读取。
   */
  static _matchSkillIdentity(skillItem, pre) {
    if (!skillItem) return false;

    const val = String(pre.skillNameOrTag ?? "").trim();
    const lvl = parseInt(pre.skillLevel) || 0;
    const uuid = String(pre.skillUuid ?? "").trim();
    if (!val && !lvl && !uuid) return false;

    if (uuid && skillItem.uuid !== uuid) return false;
    if (lvl && (skillItem.system?.level ?? 0) !== lvl) return false;
    if (val) {
      if (skillItem.name !== val && !ClashManager._itemTags(skillItem).includes(val)) return false;
    }
    return true;
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

  /**
   * 活动的计数键——所有读写计数的地方都走这里，保证共用同一份计数。
   *
   * 按**物品名**而非 item.id 计数：同名的两张牌 / 两件装备共用一份次数，
   * 「一回合 1 次」才是名副其实的"这个技能一回合 1 次"，而不是"每张牌各 1 次"。
   * 代价是不同物品若起了同名效果会互相抢次数——起名时注意区分即可。
   */
  static _actCountKey(item, act, trigger = "反应") {
    return `${item?.name ?? ""}_${act?.name ?? trigger}`;
  }

  /**
   * 次数限制检查（perTurn / perEncounter）。
   * 反应走的是 _checkAndOfferReactions 这条独立路径，不经过 _applyActivities，
   * 因此计数必须在这里自己读、自己写（写在 _bumpLimit）。
   */
  static _checkLimit(act, item, actor) {
    const limitType  = act?.limit?.type;
    const limitCount = act?.limit?.count ?? 0;
    if (!limitType || limitType === "unlimited" || limitCount <= 0) return true;
    const flagKey = limitType === "perTurn" ? "turnFireCounts"
                  : limitType === "perEncounter" ? "encounterFireCounts" : null;
    if (!flagKey) return true;
    const counts = actor?.getFlag?.("limbusCompany_FVTT", flagKey) ?? {};
    return (counts[ClashManager._actCountKey(item, act)] ?? 0) < limitCount;
  }

  /** 记录一次触发（与 _applyActivities 写的是同一份 flag） */
  static async _bumpLimit(act, item, actor) {
    const limitType  = act?.limit?.type;
    const limitCount = act?.limit?.count ?? 0;
    if (!limitType || limitType === "unlimited" || limitCount <= 0 || !actor) return;
    const flagKey = limitType === "perTurn" ? "turnFireCounts"
                  : limitType === "perEncounter" ? "encounterFireCounts" : null;
    if (!flagKey) return;
    const counts = foundry.utils.deepClone(actor.getFlag?.("limbusCompany_FVTT", flagKey) ?? {});
    const key    = ClashManager._actCountKey(item, act);
    counts[key]  = (counts[key] ?? 0) + 1;
    await ClashManager._safeDocUpdate(actor, { [`flags.limbusCompany_FVTT.${flagKey}`]: counts });
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

      const actKey = ClashManager._actCountKey(item, act, trigger);
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
      // reactTarget 决定这一击打谁：
      //   defender（默认）＝触发者攻击的那个目标（例如友方打谁我就补刀谁）
      //   attacker        ＝触发这次反应的人本身
      //   none            ＝不指定，谁都能响应
      const curAP = actor.system?.ap?.value ?? 0;
      if (curAP <= 0) await ClashManager._safeDocUpdate(actor, { "system.ap.value": 1 });
      const reactTarget = eff?.reactTarget ?? "defender";
      let tgtId = "";
      if (reactTarget === "defender") tgtId = defender?.id ?? "";
      else if (reactTarget === "attacker") tgtId = attacker?.id ?? "";
      // 指定目标不能是自己，否则发出的对抗卡没人能响应
      if (tgtId === actor.id) tgtId = "";
      await ClashManager.showInitiateDialog(actor, skillItem, -2, tgtId);
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
    if (msg.type === "coverOffer") {
      await ClashManager._checkCoverDefense(msg.msgId, msg.initFlags);
      return;
    }

    if (msg.type === "reactionCheck") {
      const { lastSkillUuid, attackerId, defenderId } = msg.data ?? {};
      const attacker = attackerId ? game.actors.get(attackerId) : null;
      const defender = defenderId ? game.actors.get(defenderId) : null;
      await ClashManager._checkAndOfferReactions({ lastSkillUuid, attacker, defender });
      return;
    }

    // 玩家无权限时委托 GM 执行文档删除（与 gmDocUpdate 成对）
    if (msg.type === "gmDocDelete") {
      if (!game.user.isGM) return;
      try {
        const doc = msg.uuid ? await fromUuid(msg.uuid) : null;
        if (doc) await doc.delete();
      } catch (err) {
        console.error("[ClashManager] gmDocDelete 失败:", err);
      }
      return;
    }

    // 玩家无权限时委托 GM 执行任意文档更新（跨所有权 Actor/Item 写入）
    if (msg.type === "gmDocUpdate") {
      if (!game.user.isGM) return;
      try {
        const doc = msg.uuid ? await fromUuid(msg.uuid) : null;
        if (doc) await doc.update(msg.data, msg.options ?? {});
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
      const { defActorId, defItemId, defRollTotal, defRollData, defFormula, initMsgId, initFlags, slotIdx } = msg.data;
      const defActor = game.actors.get(defActorId);
      const defItem  = defActor?.items.get(defItemId);
      if (!defActor || !defItem) {
        console.error("[ClashManager] clashResolve: 找不到 defActor/defItem", { defActorId, defItemId });
        ui.notifications?.error("对抗结算出错：找不到角色或技能，请检查控制台");
        return;
      }
      console.log("[ClashManager] GM 开始执行对抗结算 | defActor:", defActor.name, "| defItem:", defItem.name);
      // 重建只含 total 的 roll 代理对象（结算流程仅使用 .total）
      // 有完整骰子数据就重建真 Roll（DiceSoNice 需要），否则退回只含 total 的替身
      let defRoll = { total: defRollTotal };
      if (defRollData) {
        try { defRoll = Roll.fromJSON(JSON.stringify(defRollData)); }
        catch (err) { console.warn("[ClashManager] 防守骰重建失败，退回替身对象:", err); }
      }
      await ClashManager._sendResponseAndResolve(
        defActor, defItem, defRoll, defFormula, initMsgId, initFlags, slotIdx ?? -1
      );
    } catch (err) {
      console.error("[ClashManager] clashResolve 结算出错:", err);
      ui.notifications?.error("对抗结算出错，请检查控制台日志");
    }
  }
}
