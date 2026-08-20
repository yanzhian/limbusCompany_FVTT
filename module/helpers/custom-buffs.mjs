/**
 * custom-buffs.mjs — 自定义 BUFF 扩展通道
 *
 * 用法：
 *   import { registerCustomBuff } from "./custom-buffs.mjs";
 *
 *   registerCustomBuff("myBuff", {
 *     label:         "显示名称",
 *     maxStacks:     4,          // 可选：最大层数上限（超出则截断）
 *     maxIntensity:  5,          // 可选：最大强度上限（超出则截断）
 *     maxGainPerRound: 20,       // 可选：本回合累计可获得的层数上限（与 maxStacks 无关；
 *                                //       计数记在 actor flag buffRoundGain 上，每轮结束清空）
 *     refreshOnGain: true,       // 可选：获得时刷新（不叠加层数，直接替换）
 *     keepAtZero:    true,       // 可选：层数减至 0 时不自动清除（仍以 0 层留在状态栏，
 *                                //       需手动 removeBuff 或其他效果移除）
 *     onRoundEnd(actor, buff) {},           // 回合结束时回调 → 返回 Promise
 *     onRoundStart(actor, buff) {},         // 回合开始时回调（在同一轮的 onRoundEnd 之后执行，
 *                                             // 因此回合结束时被移除的 BUFF 不会再触发）；
 *                                             // 返回字符串则并入「回合开始时」折叠汇总消息
 *     modifySpeedRoll(actor, ctx) {},       // 速度骰结果修正 → 返回最终 total（Number）
 *     onClashWin(carrier, opponent, buff) {},  // 拼点胜利时回调 → 返回 Promise
 *     onClashLose(carrier, winner, buff) {},   // 拼点失败时回调（与 onClashWin 对称）
 *     onBuffGained(actor, buff, ctx) {},    // 该角色获得任意 BUFF 后调用（不只是自己这条），
 *                                             // ctx = { type, intensity, stacks }
 *     onBuffLost(actor, buff, ctx) {},      // 该角色失去/减少任意 BUFF 后调用，
 *                                             // ctx = { type, amount, stacks, removed }
 *     modifyDiceRoll(actor, buff, ctx) {},  // 拼点骰/防守骰结果修正 → 返回数字或 { total, note }；
 *                                             // ctx = { roll, total, item, isDefense }
 *     beforeChaos(actor, buff, ctx) {},     // 混乱触发前检查 → 返回 { immune: bool }；
 *                                             // ctx = { source }，source 为伤害来源（"burn"/"bleed"/…）
 *     modifyResistances(actor, buff, res) {}, // 修改物理抗性：res = { slash, blunt, pierce }（"xN.0" 字符串），
 *                                             // 可原地修改或返回部分覆盖对象（如 { slash: "x2.0" }）；
 *                                             // 陷入混乱的强制抗性优先级更高，混乱时不会调用此钩子
 *     modifyIncomingDamage(actor, buff, ctx) {}, // 受到伤害结算前调用，
 *                                             // ctx = { damage, attacker, source }；
 *                                             // source："clash"=对抗伤害，"burn"/"bleed"/"rupture"=跳动伤害
 *                                             // 返回 { damage?, hpLock?, hpFloor?, note? }：
 *                                             //   damage  覆盖本次伤害
 *                                             //   hpLock  生命值锁定（跳过护盾/破裂/沉沦/震颤，HP 直接钉死；仅对抗路径）
 *                                             //   hpFloor 本次伤害不得把 HP 压到该值以下（仅跳动伤害路径）
 *     modifyOutgoingDamage(actor, buff, ctx) {}, // 自己打出伤害前调用（与 modifyIncomingDamage 对称），
 *                                             // ctx = { damage, target, category, sinType, item }；
 *                                             // 返回 { damage?, note? }
 *     onHit(actor, buff, ctx) {},            // 自己任意技能/装备 [命中时] 结算后调用（异步），
 *                                             // ctx = { item, category, target,
 *                                             //          addBuff(type,intensity,stacks,whenAdded),
 *                                             //          addBuffTo(targetActor,type,intensity,stacks,whenAdded),
 *                                             //          getBuff(type),
 *                                             //          dealDamage(targetActor, category, rollFormula, sinType) }
 *                                             // dealDamage 的 category（物理分类）与 sinType（罪孽）均可留空，
 *                                             // 分别按物理抗性 / 罪孽抗性结算
 *                                             // 返回字符串则并入本次结算的 ⚡ 活动消息
 *   });
 *
 * 以上所有钩子均为可选。未提供的钩子不会被调用。
 */

/** @type {Map<string, object>} */
export const CustomBuffRegistry = new Map();

/**
 * 注册一个自定义 BUFF 处理器。
 * @param {string} type     BUFF 的 type 字符串标识（与 actor.system.buffs[].type 一致）
 * @param {object} handler  处理器配置对象（见文件头注释）
 */
export function registerCustomBuff(type, handler) {
  CustomBuffRegistry.set(type, { type, ...handler });
}

/**
 * 根据 buff 对象查找自定义处理器。
 * 优先按 buff.type 精确匹配；若未找到，则按 buff.name 与注册 label 模糊匹配。
 * 这样 type="custom" name="防御姿态" 与 type="defensiveStance" 都能找到处理器。
 * @param {{ type: string, name?: string }} buff
 * @returns {object|null}
 */
export function resolveBuffHandler(buff) {
  if (!buff) return null;
  // 1. 精确类型匹配
  const direct = CustomBuffRegistry.get(buff.type);
  if (direct) return direct;
  // 2. 按显示名称（label / name）回退匹配
  if (buff.name) {
    for (const handler of CustomBuffRegistry.values()) {
      if (handler.label === buff.name) return handler;
    }
  }
  return null;
}

/**
 * 将 buff 的 type 规范化为注册表 key。
 * 当用户以自定义方式输入中文标签时（如 "防御姿态"），自动解析为注册 type。
 * @param {string} type   当前 type 值
 * @param {string} [name] 显示名称（用于回退匹配）
 * @returns {string} 规范化后的 type
 */
export function normalizeBuffType(type, name = "") {
  if (CustomBuffRegistry.has(type)) return type;
  const target = name || type;
  for (const [regType, handler] of CustomBuffRegistry.entries()) {
    if (handler.label === target) return regType;
  }
  return type;
}

/**
 * 安全写入：目标文档可能不属于当前玩家（例如防守方客户端要改攻击方），
 * 一律走 ClashManager._safeDocUpdate，由它在无权限时通过 socket 委托 GM 执行。
 * clash.mjs 静态 import 了本文件，所以这里只能动态 import。
 */
async function _safeUpdate(doc, data) {
  if (!doc) return;
  const { ClashManager } = await import("./clash.mjs");
  return ClashManager._safeDocUpdate(doc, data);
}

/* ─── 震颤族（普通震颤 + 特殊震颤） ─────────────────────────────────────── */

/**
 * 「特殊震颤」是一类会被【震颤引爆】当作震颤对待的 BUFF：同样有层数/强度，
 * 引爆时同样消耗 1 层、把目标混乱阈值前移自身强度，区别是可以再挂一段额外效果。
 * 注册方式：registerCustomBuff("xxx", { specialTremor: true, onSeismicBlast(...) })
 *
 *   onSeismicBlast(target, buff, ctx) → 返回一行说明文本（可选），并入引爆消息
 *     ctx = { attacker,
 *             getBuff(type),                                     // 读 target 身上的 BUFF
 *             addBuff(type, intensity, stacks, whenAdded),       // 给 target 加 BUFF
 *             dealDamage(targetActor, category, formula, sinType) }
 */
export const TREMOR_BASE_TYPE = "tremor";

/** 该 type 是否属于震颤族（普通震颤或任一特殊震颤） */
export function isTremorFamilyType(type) {
  if (type === TREMOR_BASE_TYPE) return true;
  return CustomBuffRegistry.get(type)?.specialTremor === true;
}

/** 全部已注册的特殊震颤 type */
export function specialTremorTypes() {
  return [...CustomBuffRegistry.entries()]
    .filter(([, h]) => h?.specialTremor === true)
    .map(([t]) => t);
}

/** 依附于震颤存在的 BUFF：震颤族全部消失时，它们也一并消失 */
export const TREMOR_DEPENDENT_TYPES = ["amplitudeConvert", "amplitudeEntangle"];

/* ─── 内置自定义 BUFF ───────────────────────────────────────────────────── */

/**
 * 【援护防御】
 * 逻辑主体在 ClashManager（_checkCoverDefense / _performCoverDefense）里，
 * 这里注册只为两件事：给它一个层数上限，以及让它出现在自定义 BUFF 名单中。
 * 不挂 onRoundEnd —— 它要能跨回合攒着，否则后排永远用不上。
 */
registerCustomBuff("coverDefense", {
  label:     "援护防御",
  maxStacks: 3,
  description: "友方被锁定为目标、且该友方行动值为 0 时：可消耗 1 层顶上去替他接下这次对抗\n"
    + "· 使用背包里标有【援护防御】的专属技能（不需装备），瞬移到攻击者身旁的空位\n"
    + "· 强制把攻击者的目标改为自己\n"
    + "· 不会自动消失，可跨回合累积，最多 3 层",
});


/**
 * 【防御姿态】
 * - 最大值：4 层
 * - 获得层数时刷新（替换），不叠加
 * - 回合结束时层数减少 1，减至 0 时移除
 * - 使本单位速度值固定为最小值
 * - 拼点胜利时，使目标震颤引爆
 * - 不会因受到伤害而陷入混乱
 */
registerCustomBuff("defensiveStance", {
  label: "防御姿态",
  description: "- 最大值：2 层\n- 获得层数时刷新（替换），不叠加\n- 回合结束时层数减少 1，减至 0 时移除\n- 使本单位速度值固定为最小值\n- 拼点胜利时，使目标震颤引爆\n- 不会因受到伤害而陷入混乱",
  maxStacks:     2,
  refreshOnGain: true,

  /** 回合结束：层数-1，归零时移除 */
  async onRoundEnd(actor, buff) {
    const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);
    const idx   = buffs.findIndex(b => b.id === buff.id);
    if (idx < 0) return;
    const newStacks = (buffs[idx].stacks ?? 1) - 1;
    if (newStacks <= 0) {
      buffs.splice(idx, 1);
      await _safeUpdate(actor, { "system.buffs": buffs });
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="limbuscompany chat-clash"><strong>${actor.name}</strong>【防御姿态】已消散。</div>`,
      });
    } else {
      buffs[idx].stacks = newStacks;
      await _safeUpdate(actor, { "system.buffs": buffs });
    }
  },

  /**
   * 速度修正：固定返回最小值（1 + modifier，即 speedMin）
   * ctx = { modifier: number }
   */
  modifySpeedRoll(actor, ctx) {
    const modifier = ctx?.modifier ?? 0;
    return 1 + modifier; // speedMin
  },

  /**
   * 拼点胜利时：对 opponent 触发震颤引爆（消耗其 1 层震颤）
   * 若目标无震颤层则不触发（不报错）
   */
  async onClashWin(carrier, opponent) {
    if (!opponent) return;
    // 统一走 ClashManager.seismicBlast：特殊震颤 / 振幅纠缠的规则一并生效
    const { ClashManager } = await import("./clash.mjs");
    const { blasts, msgs } = await ClashManager.seismicBlast(opponent, 1, { attacker: carrier });
    if (blasts <= 0) return;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: carrier }),
      content: `<div class="limbuscompany chat-clash">
        <strong>${carrier.name}</strong>【防御姿态】触发：对 <strong>${opponent.name}</strong> 震颤引爆！<br>
        ${msgs.join("<br>")}
      </div>`,
    });
  },

  /** 免疫因受到伤害触发的混乱（beforeChaos 返回 { immune: true }） */
  beforeChaos(actor, _buff) {
    return { immune: true };
  },
});

/**
 * 【蝶】
 * - 最大值：10 层
 * - 受到伤害时，消耗 1 层，为目标恢复 1D6 理智值，为自己添加 1 层【沉沦2】
 */
registerCustomBuff("butterfly", {
  label:       "蝶",
  maxStacks:   10,
  description: "- 最大值：10 层\n- 受到伤害时，消耗 1 层，为目标恢复 1D6 的理智值，为自己添加 1 层【沉沦2】",

  async onTakeDamage(actor, buff, ctx) {
    if ((buff.stacks ?? 0) <= 0) return;

    // 在同一个 buffs 快照上完成：蝶-1层 + 沉沦+1层，合并为一次 update
    const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);
    const idx   = buffs.findIndex(b => b.id === buff.id);
    if (idx < 0) return;
    const newStacks = (buffs[idx].stacks ?? 1) - 1;
    if (newStacks <= 0) {
      buffs.splice(idx, 1);
    } else {
      buffs[idx].stacks = newStacks;
    }

    // 沉沦 +1 层（强度 2）
    const si = buffs.findIndex(b => b.type === "sinking");
    if (si >= 0) {
      buffs[si].stacks = (buffs[si].stacks ?? 0) + 1;
    } else {
      buffs.push({
        id:        foundry.utils.randomID(),
        type:      "sinking",
        name:      "沉沦",
        intensity: 2,
        stacks:    1,
        whenAdded: "本回合",
      });
    }
    await _safeUpdate(actor, { "system.buffs": buffs });

    // 为伤害来源（attacker）恢复 1D6 理智
    const target = ctx?.attacker ?? null;
    let sanHeal = 0;
    if (target) {
      const healRoll = new Roll("1d6");
      await healRoll.evaluate();
      sanHeal = healRoll.total;
      const curSan = target.system?.sanity?.value ?? 50;
      const newSan = Math.min(95, curSan + sanHeal);
      await _safeUpdate(target, { "system.sanity.value": newSan });
    }

    // 返回消息文本，由 _applyAndSendTake 收集后并入 ⚡ 活动消息
    return `【蝶】触发（剩余 <strong>${newStacks}</strong> 层）：`
      + (target ? ` 为 <strong>${target.name}</strong> 恢复 <strong>${sanHeal}</strong> 点理智。` : "")
      + ` 自身获得 1 层【沉沦】（强度 2）。`;
  },
});

/**
 * 【百折不挠】
 * - 最大值：1 层
 * - 获得层数时刷新（替换），不叠加
 * - 回合结束时层数减少 1，归零时移除
 * - 本回合生命值锁定为 1，且受到伤害为 0
 */
registerCustomBuff("indomitable", {
  label:         "百折不挠",
  description:   "- 最大值：1 层\n- 获得层数时刷新（替换），不叠加\n- 回合结束时层数减少 1，归零时移除\n- 本回合生命值锁定为 1，且受到伤害为 0",
  maxStacks:     1,
  refreshOnGain: true,

  /** 受到伤害前：伤害归零 + 生命值锁定为 1（跳过护盾/破裂/沉沦/震颤结算） */
  modifyIncomingDamage(_actor, _buff, _ctx) {
    return { damage: 0, hpLock: 1 };
  },

  async onRoundEnd(actor, buff) {
    const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);
    const idx   = buffs.findIndex(b => b.id === buff.id);
    if (idx < 0) return;
    const newStacks = (buffs[idx].stacks ?? 1) - 1;
    if (newStacks <= 0) {
      buffs.splice(idx, 1);
    } else {
      buffs[idx].stacks = newStacks;
    }
    await _safeUpdate(actor, { "system.buffs": buffs });
  },
});

/**
 * 【故土剑术】
 * - 最大值：2 层
 * - 获得层数时刷新（替换），不叠加
 * - 回合结束时层数减少 1，归零时移除
 * - 自己"斩击"分类的技能[命中时]：为自己添加 5 级【呼吸法】，
 *   之后每有 5 级【呼吸法】强度，对目标造成 1D4 的斩击伤害（最多 2 次）
 */
registerCustomBuff("nativeSwordArt", {
  label:         "故土剑术",
  description:   "- 最大值：2 层\n- 获得层数时刷新（替换），不叠加\n- 回合结束时层数减少 1，归零时移除\n- 自己\"斩击\"类型的骰子[命中时]：为自己添加 5 级【呼吸法】，每有 5 级【呼吸法】对目标造成 1D4 的斩击伤害（最多2次）",
  maxStacks:     2,
  refreshOnGain: true,

  async onRoundEnd(actor, buff) {
    const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);
    const idx   = buffs.findIndex(b => b.id === buff.id);
    if (idx < 0) return;
    const newStacks = (buffs[idx].stacks ?? 1) - 1;
    if (newStacks <= 0) {
      buffs.splice(idx, 1);
    } else {
      buffs[idx].stacks = newStacks;
    }
    await _safeUpdate(actor, { "system.buffs": buffs });
  },

  /**
   * [命中时]（仅本次使用的技能分类为"斩击"才触发）：
   * 为自己添加 5 级（强度5）呼吸法，随后按呼吸法当前强度，每 5 点对目标
   * 造成 1D4 斩击伤害，最多 2 次（即呼吸法强度达到 10 时封顶）。
   * ClashManager 内部方法不直接 import（避免与 clash.mjs 循环依赖），
   * 所需操作全部通过 ctx 回调（addBuff/getBuff/dealDamage）下发。
   */
  async onHit(_actor, _buff, ctx) {
    if ((ctx?.category ?? "") !== "slash") return;

    await ctx.addBuff?.("breathing", 5, 1, "本回合");

    const target = ctx?.target ?? null;
    if (!target) return;
    const breathing = ctx.getBuff?.("breathing");
    const times = Math.min(2, Math.floor((breathing?.intensity ?? 0) / 5));
    for (let i = 0; i < times; i++) {
      await ctx.dealDamage?.(target, "slash", "1d4");
    }
  },
});

/* ─── 基础 BUFF 描述注册（仅 label + description，逻辑由 clash.mjs 内置处理）── */

registerCustomBuff("tremor", {
  label: "震颤",
  description: "受到造成【震颤引爆】的攻击时，混乱阈值前移等同于本效果强度的数值。\n回合结束后，本效果的层数减少 1 层。",
});

registerCustomBuff("seismicBlast", {
  label: "震颤引爆",
  description: "使目标的混乱阈值前移与震颤强度相同的数值。",
});

registerCustomBuff("sinking", {
  label: "沉沦",
  description: "[受到伤害时]：失去数值等同于本效果强度的固定理智值点数。\n效果生效后，本效果的层数减少 1 层。",
});

registerCustomBuff("burn", {
  label: "烧伤",
  description: "[回合结束时]：减少 1 层【烧伤】层数，受到【烧伤】强度的固定伤害。",
});

registerCustomBuff("rupture", {
  label: "破裂",
  description: "[受到伤害时]：减少 1 层【破裂】层数，受到【破裂】强度的固定伤害。",
});

registerCustomBuff("bleed", {
  label: "流血",
  description: "[攻击时]：减少 1 层【流血】层数，受到【流血】强度的固定伤害。",
});

registerCustomBuff("charge", {
  label:     "充能",
  description: "·特殊技能需要消耗层数。\n·最大值：20 层。\n[回合结束时]：减少 1 层【充能】层数。",
  maxStacks: 20,
});

registerCustomBuff("breathing", {
  label: "呼吸法",
  description: "[命中时]：本次攻击根据强度×5%的概率暴击，如果暴击则减少 1 层【呼吸法】层数。\n[回合结束时]：减少 1 层【呼吸法】层数。",
});

registerCustomBuff("bullet", {
  label: "子弹",
  description: "·特殊技能需要消耗层数。",
});

registerCustomBuff("shield", {
  label: "护盾",
  description: "受到伤害时：每层抵挡 1 点伤害（先于其他伤害结算）。\n回合结束时：移除全部护盾层数。\n护盾可以超出生命值上限存在。",

  /** 回合结束：清除全部护盾 */
  async onRoundEnd(actor, buff) {
    const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);
    const idx   = buffs.findIndex(b => b.id === buff.id);
    if (idx < 0) return;
    buffs.splice(idx, 1);
    await _safeUpdate(actor, { "system.buffs": buffs });
    // await ChatMessage.create({
    //   speaker: ChatMessage.getSpeaker({ actor }),
    //   content: `<div class="limbuscompany chat-clash"><strong>${actor.name}</strong> 的【护盾】在回合结束时消散。</div>`,
    // });
  },
});

/**
 * 【刺入之矢】
 * - 最大值：1 层
 * - 持有时斩击抗性强制为 x2.0
 */
registerCustomBuff("piercingArrow", {
  label:       "刺入之矢",
  description: "- 最大值：1 层\n- 将自己的斩击抗性转换为 x2.0",
  maxStacks:   1,

  modifyResistances(_actor, _buff, _res) {
    return { slash: "x2.0" };
  },
});

/**
 * 【血炎】
 * - 最大值：3 层
 * - 回合结束时层数 -1，归零时移除
 */
registerCustomBuff("bloodFlame", {
  label:         "血炎",
  description:   "- 最大值：3 层\n- 获得层数时刷新（替换），不叠加\n- 回合结束时层数减少 1，归零时移除\n- 不会因【烧伤】伤害而陷入混乱",
  maxStacks:     3,
  refreshOnGain: true,

  /** 仅免疫来自烧伤的混乱触发 */
  beforeChaos(_actor, _buff, ctx) {
    if (ctx?.source === "burn") return { immune: true };
  },

  async onRoundEnd(actor, buff) {
    const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);
    const idx   = buffs.findIndex(b => b.id === buff.id);
    if (idx < 0) return;
    const newStacks = (buffs[idx].stacks ?? 1) - 1;
    if (newStacks <= 0) {
      buffs.splice(idx, 1);
    } else {
      buffs[idx].stacks = newStacks;
    }
    await _safeUpdate(actor, { "system.buffs": buffs });
  },
});

/* ─── 花札三色：【松上鹤】/【芒上月】/【青染樱】────────────────────────────
 * 定事务所的核心资源。三张牌各对应一种颜色与罪孽，命中时打出的骰若是同色罪孽，
 * 就给自己的【光札】+1 级。三张牌本身只是"手里握着哪张花札"，不叠层。
 * ───────────────────────────────────────────────────────────────────────── */

/** 花札通用：命中时若本骰罪孽对上颜色 → 光札 +1 级 */
function makeFlowerCard({ label, color, sin, sinLabel }) {
  return {
    label,
    description: `- 花札·${color}\n- 命中时若本骰为【${sinLabel}】，为自己的【光札】强度 +1`,
    maxStacks: 1,
    async onHit(actor, buff, ctx) {
      if (ctx?.sinType !== sin) return "";
      await ctx.addBuff("光札", 1, 0, "本回合");
      return `【${label}】对上【${sinLabel}】——【光札】强度 +1`;
    },
  };
}

registerCustomBuff("craneOnPine",  makeFlowerCard({ label: "松上鹤", color: "红", sin: "gluttony", sinLabel: "暴食" }));
registerCustomBuff("moonOnSusuki", makeFlowerCard({ label: "芒上月", color: "黄", sin: "sloth",    sinLabel: "怠惰" }));
registerCustomBuff("indigoSakura", makeFlowerCard({ label: "青染樱", color: "蓝", sin: "gloom",    sinLabel: "忧郁" }));

/**
 * 【光札】
 * - 纯计数资源：最大 3 层、强度最高 5 级
 * - 用效果编辑器写成自定义 BUFF「光札」也会命中这条上限（按名称回退匹配）
 */
registerCustomBuff("lightCard", {
  label:        "光札",
  description:  "- 纯计数资源\n- 最大 3 层、强度上限 5 级",
  maxStacks:    3,
  maxIntensity: 5,
});

/**
 * 【怨恨纹身】
 * - 最大值：15 层
 */
registerCustomBuff("resentmentTattoo", {
  label:       "怨恨纹身",
  description: "- 最大值：15 层",
  maxStacks:   15,
});

/**
 * 【复仇账簿】
 * - 最大值：20 层
 */
registerCustomBuff("vengeanceLedger", {
  label:       "复仇账簿",
  description: "- 最大值：20 层",
  maxStacks:   20,
});

/* ─── 【炎蝶之棺】/【黎明之火】——共用被动 + 各自主动 ───────────────────── */

/**
 * 两者共用的被动部分：
 * - 最大 30 层，每回合最多获得 20 层
 * - 不会因【烧伤】伤害陷入混乱
 * - 【烧伤】伤害不会使自身生命值降至 1 点以下
 * - 自身受到的【烧伤】伤害 -50%（向下取整）
 */
const FLAME_SHARED = {
  maxStacks:        30,
  maxGainPerRound:  20,

  /** 免疫【烧伤】造成的混乱触发 */
  beforeChaos(_actor, _buff, ctx) {
    if (ctx?.source === "burn") return { immune: true };
  },

  /** 烧伤伤害减半（向下取整），且不会把生命值压到 1 点以下 */
  modifyIncomingDamage(_actor, _buff, ctx) {
    if (ctx?.source !== "burn") return;
    return { damage: Math.floor((ctx.damage ?? 0) / 2), hpFloor: 1 };
  },
};

const FLAME_SHARED_DESC =
  "- 最大值：30 层\n"
  + "- 每回合最多获得 20 层\n"
  + "- 自身不会因【烧伤】伤害陷入混乱，或使生命值降至 1 点以下\n"
  + "- 自身受到的【烧伤】伤害 -50%（向下取整）";

/**
 * 【炎蝶之棺】
 * [回合结束时]：获得本层数一半的【烧伤】强度；
 *               若本层数为 30 层，则改为直接设为 2 层 5 级【烧伤】。
 */
registerCustomBuff("flameButterflyCoffin", {
  ...FLAME_SHARED,
  label:       "炎蝶之棺",
  description: `${FLAME_SHARED_DESC}\n[回合结束时]：获得本层数一半的【烧伤】强度\n- 若本层数为 30 层，则改为 2 层 5 级【烧伤】`,

  async onRoundEnd(actor, buff) {
    const stacks = buff.stacks ?? 0;
    if (stacks <= 0) return;

    const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);
    const bi    = buffs.findIndex(b => b.type === "burn" && (b.whenAdded ?? "本回合") !== "下回合");
    let   note;

    if (stacks >= 30) {
      // 满层：直接改写为 2 层 5 级【烧伤】（是"修改为"，不是叠加）
      if (bi >= 0) {
        buffs[bi].stacks    = 2;
        buffs[bi].intensity = 5;
      } else {
        buffs.push({
          id: foundry.utils.randomID(), type: "burn", name: "烧伤",
          icon: "systems/limbusCompany_FVTT/assets/icons/Buff_icon/烧伤.webp",
          intensity: 5, stacks: 2, whenAdded: "本回合",
        });
      }
      note = "满 30 层：【烧伤】修改为 <strong>2</strong> 层 <strong>5</strong> 级";
    } else {
      const gain = Math.floor(stacks / 2);
      if (gain <= 0) return;
      if (bi >= 0) {
        buffs[bi].intensity = (buffs[bi].intensity ?? 0) + gain;
        if (!(buffs[bi].stacks > 0)) buffs[bi].stacks = 1;
      } else {
        buffs.push({
          id: foundry.utils.randomID(), type: "burn", name: "烧伤",
          icon: "systems/limbusCompany_FVTT/assets/icons/Buff_icon/烧伤.webp",
          intensity: gain, stacks: 1, whenAdded: "本回合",
        });
      }
      note = `获得 <strong>${gain}</strong> 级【烧伤】强度（本层数 ${stacks} 的一半）`;
    }

    await _safeUpdate(actor, { "system.buffs": buffs });
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="limbuscompany chat-clash"><strong>${actor.name}</strong>【炎蝶之棺】：${note}。</div>`,
    });
  },
});

/**
 * 【黎明之火】
 * [命中时]：不低于 10 层 → 为目标添加 2 级【烧伤】
 * [命中时]：不低于 20 层 → 为目标添加 1 层【烧伤】
 * （两条各自独立判定，20 层及以上时两条同时生效）
 */
registerCustomBuff("dawnFire", {
  ...FLAME_SHARED,
  label:       "黎明之火",
  description: `${FLAME_SHARED_DESC}\n[回合开始时]：每有 5 层本效果，自身【烧伤】强度 +1；每有 10 层本效果，对自身施加 1 层【烧伤】\n[命中时]：若不低于 10 层，为目标添加 2 级【烧伤】\n[命中时]：若不低于 20 层，为目标添加 1 层【烧伤】`,

  /**
   * 回合开始：层数越高，自身烧得越旺。
   * 每 5 层 +1 级烧伤强度，每 10 层 +1 层烧伤（向下取整，两者独立计算）。
   * 与 onHit 同理，不能走 _addBuff——那条路径会把 0 层订正成 1 层，
   * 而 5~9 层这一档只该加强度、不该凭空多出层数。
   */
  async onRoundStart(actor, buff) {
    const stacks = buff.stacks ?? 0;
    const addIntensity = Math.floor(stacks / 5);
    const addStacks    = Math.floor(stacks / 10);
    if (addIntensity <= 0 && addStacks <= 0) return;

    const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);
    const bi    = buffs.findIndex(b => b.type === "burn" && (b.whenAdded ?? "本回合") !== "下回合");
    if (bi >= 0) {
      buffs[bi].intensity = (buffs[bi].intensity ?? 0) + addIntensity;
      buffs[bi].stacks    = Math.max(1, (buffs[bi].stacks ?? 0) + addStacks);
    } else {
      buffs.push({
        id: foundry.utils.randomID(), type: "burn", name: "烧伤",
        icon: "systems/limbusCompany_FVTT/assets/icons/Buff_icon/烧伤.webp",
        intensity: addIntensity, stacks: Math.max(1, addStacks), whenAdded: "本回合",
      });
    }
    await _safeUpdate(actor, { "system.buffs": buffs });

    const parts = [];
    if (addIntensity > 0) parts.push(`<strong>${addIntensity}</strong> 级`);
    if (addStacks    > 0) parts.push(`<strong>${addStacks}</strong> 层`);
    return `【黎明之火】（${stacks} 层）：自身获得 ${parts.join(" ")}【烧伤】。`;
  },

  async onHit(actor, buff, ctx) {
    const target = ctx?.target;
    if (!target) return;
    const stacks = buff.stacks ?? 0;
    if (stacks < 10) return;

    // 强度 2 / 层数 0：只加强度不加层；20 层起再补 1 层
    const addIntensity = 2;
    const addStacks    = stacks >= 20 ? 1 : 0;

    // 不能直接用 addBuffTo：烧伤属于"层数为 0 自动订正为 1"的基础 BUFF，
    // 10~19 层这档只该加强度、不该加层，所以在快照上手动处理
    // （目标原本没有烧伤时才建 1 层，否则 0 层的烧伤不会发作）。
    const buffs = foundry.utils.deepClone(target.system?.buffs ?? []);
    const bi    = buffs.findIndex(b => b.type === "burn" && (b.whenAdded ?? "本回合") !== "下回合");
    if (bi >= 0) {
      buffs[bi].intensity = (buffs[bi].intensity ?? 0) + addIntensity;
      buffs[bi].stacks    = Math.max(1, (buffs[bi].stacks ?? 0) + addStacks);
    } else {
      buffs.push({
        id: foundry.utils.randomID(), type: "burn", name: "烧伤",
        icon: "systems/limbusCompany_FVTT/assets/icons/Buff_icon/烧伤.webp",
        intensity: addIntensity, stacks: Math.max(1, addStacks), whenAdded: "本回合",
      });
    }
    // clash.mjs 静态 import 了本文件，反向只能动态 import，避免循环依赖
    const { ClashManager } = await import("./clash.mjs");
    await ClashManager._safeDocUpdate(target, { "system.buffs": buffs });

    return `【黎明之火】（${stacks} 层）：为 <strong>${target.name}</strong> 添加 `
      + `<strong>${addIntensity}</strong> 级${addStacks > 0 ? ` <strong>${addStacks}</strong> 层` : ""}【烧伤】。`;
  },
});

/**
 * 【迎接黎明】
 * - 最大值：3 层
 * - [回合开始时]：为你添加 2 层【攻击等级提升】；若"背景"为"黎明事务所"，额外 1 层【强壮】
 * - [命中时]：为目标添加 1 层 1 级【烧伤】，额外造成 1D12 的暴怒伤害
 * - [回合结束时]：本效果层数减少 1 层
 */
registerCustomBuff("greetTheDawn", {
  label:       "迎接黎明",
  description: "- 最大值：3 层\n"
    + "- [回合开始时]：为你添加 2 层【攻击等级提升】，若你的背景为「黎明事务所」额外添加 1 层【强壮】\n"
    + "- [命中时]：为目标添加 1 层 1 级【烧伤】，额外造成 1D12 的暴怒伤害\n"
    + "- [回合结束时]：本效果层数减少 1 层",
  maxStacks:   3,

  async onRoundStart(actor, _buff) {
    const { ClashManager } = await import("./clash.mjs");
    await ClashManager._addBuff(actor, "atkLevelUp", 0, 2, "本回合");

    const isDawnOffice = await _hasBackgroundNamed(actor, "黎明事务所");
    if (isDawnOffice) await ClashManager._addBuff(actor, "strong", 0, 1, "本回合");

    return `获得 <strong>2</strong> 层【攻击等级提升】`
      + (isDawnOffice ? `，背景「黎明事务所」额外获得 <strong>1</strong> 层【强壮】` : "")
      + "。";
  },

  async onHit(_actor, _buff, ctx) {
    const target = ctx?.target;
    if (!target) return;
    await ctx.addBuffTo?.(target, "burn", 1, 1, "本回合");
    const dmg = await ctx.dealDamage?.(target, "", "1d12", "wrath");
    return `为 <strong>${target.name}</strong> 添加 1 层 1 级【烧伤】，`
      + `并造成 <strong>${dmg ?? 0}</strong> 点【暴怒】伤害。`;
  },

  /** 回合结束：层数 -1，归零时移除 */
  async onRoundEnd(actor, buff) {
    const buffs = foundry.utils.deepClone(actor.system?.buffs ?? []);
    const idx   = buffs.findIndex(b => b.id === buff.id);
    if (idx < 0) return;
    const newStacks = (buffs[idx].stacks ?? 1) - 1;
    if (newStacks <= 0) buffs.splice(idx, 1);
    else                buffs[idx].stacks = newStacks;
    await _safeUpdate(actor, { "system.buffs": buffs });
  },
});

/* ─── 振幅系 & 特殊震颤 ─────────────────────────────────────────────────── */

/**
 * 两个振幅 BUFF 共用的事件响应：
 * - 震颤族有任何增减 → 【振幅纠缠】下把各特殊震颤同步到【震颤】的层数/强度
 * - 震颤族被打空     → 自己（【振幅转换】/【振幅纠缠】）一并消失
 * 这两件事原先硬编码在 ClashManager._addBuff 里，现在改为挂在
 * onBuffGained / onBuffLost 事件上，任何加减 BUFF 的路径都能覆盖到。
 */
const AMPLITUDE_EVENTS = {
  async onBuffGained(actor, _buff, ctx) {
    if (!isTremorFamilyType(ctx?.type ?? "")) return;
    const { ClashManager } = await import("./clash.mjs");
    await ClashManager._syncTremorFamily(actor);
  },
  async onBuffLost(actor, _buff, ctx) {
    if (!isTremorFamilyType(ctx?.type ?? "")) return;
    const { ClashManager } = await import("./clash.mjs");
    await ClashManager._syncTremorFamily(actor);
    await ClashManager._cleanupTremorDependents(actor);
  },
};

/**
 * 【振幅转换】
 * - 持有期间，任何震颤族的施加都并入现有的那一种（层数、强度分别求和），
 *   施加特殊震颤则整体转为该类型，施加普通【震颤】则被现有的特殊震颤吸收。
 * - 不消耗层数，持续生效；因此持有期间震颤族始终只有一种。
 * - 目标身上震颤族全部消失时，本效果一并消失。
 */
registerCustomBuff("amplitudeConvert", {
  ...AMPLITUDE_EVENTS,
  label:       "振幅转换",
  description: "- 只能在目标拥有【震颤】或【特殊震颤】时添加\n"
    + "- 持有期间，施加任何震颤都并入现有的那一种：施加【特殊震颤】则转换为该类型，\n"
    + "  施加普通【震颤】则被现有的特殊震颤吸收；层数与强度分别相加\n"
    + "- 转换不消耗层数，持有期间震颤族只会存在一种\n"
    + "- 目标失去全部震颤时，本效果消失",
});

/**
 * 【振幅纠缠】
 * - 持有期间，特殊震颤与普通震颤并列存在（不再互相转换），
 *   且各特殊震颤的层数与强度始终同步于普通【震颤】。
 * - 每次【震颤引爆】只结算 1 次【震颤】的基础效果（阈值前移 + 扣 1 层），
 *   随后各【特殊震颤】各跑一次自己的额外效果。
 * - 目标身上震颤族全部消失时，本效果一并消失。
 */
registerCustomBuff("amplitudeEntangle", {
  ...AMPLITUDE_EVENTS,
  label:       "振幅纠缠",
  description: "- 只能在目标拥有【震颤】或【特殊震颤】时添加\n"
    + "- 持有期间，【特殊震颤】与【震颤】并列存在，不再互相转换\n"
    + "- 各【特殊震颤】的层数与强度同步于【震颤】\n"
    + "- 受到【震颤引爆】时，只触发 1 次【震颤】的基础效果，随后触发各【特殊震颤】的额外效果\n"
    + "- 目标失去全部震颤时，本效果消失",
});

/**
 * 【震颤-灼热】——特殊震颤
 * - 会受到【震颤引爆】效果（消耗 1 层、混乱阈值前移本效果强度）
 * - 额外效果：受到引爆时，承受 (本效果强度 + 自身【烧伤】强度) / 2 点【暴怒】伤害
 *   （自身没有烧伤时即为 本效果强度 / 2，向下取整）
 */
registerCustomBuff("tremorHeat", {
  label:         "震颤-灼热",
  specialTremor: true,
  description:   "·特殊震颤（会受到【震颤引爆】效果）\n"
    + "·额外效果 受到【震颤引爆】时：受到（自身的震颤强度与烧伤强度之和 ÷ 2）点【暴怒】伤害",

  async onSeismicBlast(target, buff, ctx) {
    const tremorInt = buff.intensity ?? 0;
    const burnInt   = ctx.getBuff?.("burn")?.intensity ?? 0;
    const amount    = Math.floor((tremorInt + burnInt) / 2);
    if (amount <= 0) return;
    const dealt = await ctx.dealDamage?.(target, "", `${amount}`, "wrath");
    return `【震颤-灼热】额外效果：(震颤强度 ${tremorInt} + 烧伤强度 ${burnInt}) ÷ 2 = `
      + `<strong>${amount}</strong> → 造成 <strong>${dealt ?? 0}</strong> 点【暴怒】伤害。`;
  },
});

/**
 * 【震颤-回响】——特殊震颤
 * - 会受到【震颤引爆】效果
 * - 额外效果：受到引爆时，承受「自身震颤强度」点【怠惰】伤害
 */
registerCustomBuff("tremorEcho", {
  label:         "震颤-回响",
  specialTremor: true,
  description:   "·特殊震颤（会受到【震颤引爆】效果）\n"
    + "·额外效果 受到【震颤引爆】时：受到自身震颤强度点【怠惰】伤害",

  async onSeismicBlast(target, buff, ctx) {
    const amount = buff.intensity ?? 0;
    if (amount <= 0) return;
    const dealt = await ctx.dealDamage?.(target, "", `${amount}`, "sloth");
    return `【震颤-回响】额外效果：震颤强度 <strong>${amount}</strong> → `
      + `造成 <strong>${dealt ?? 0}</strong> 点【怠惰】伤害。`;
  },
});

/**
 * 【震颤-崩坏】——特殊震颤
 * - 会受到【震颤引爆】效果
 * - 额外效果：受到引爆时，每带有 4 级震颤强度，防御等级减少 1 级
 */
registerCustomBuff("tremorCollapse", {
  label:         "震颤-崩坏",
  specialTremor: true,
  description:   "·特殊震颤（会受到【震颤引爆】效果）\n"
    + "·额外效果 受到【震颤引爆】时：每带有 4 级震颤强度，防御等级减少 1 级",

  async onSeismicBlast(_target, buff, ctx) {
    const levels = Math.floor((buff.intensity ?? 0) / 4);
    if (levels <= 0) return;
    await ctx.addBuff?.("defLevelDown", 0, levels, "本回合");
    return `【震颤-崩坏】额外效果：震颤强度 ${buff.intensity ?? 0} ÷ 4 → `
      + `获得 <strong>${levels}</strong> 层【防御等级降低】。`;
  },
});

/**
 * 判断角色的「背景」是否为指定名称。
 * 优先解析结构化背景（system.background.uuid 指向的背景物品），
 * 回退到旧版自由文本背景标签 system.backgroundTag。
 */
async function _hasBackgroundNamed(actor, name) {
  const uuid = actor?.system?.background?.uuid ?? "";
  if (uuid) {
    const bg = await fromUuid(uuid).catch(() => null);
    if (bg?.name === name) return true;
  }
  const tag = String(actor?.system?.backgroundTag ?? "");
  return tag.split(/[\/,，、\s]+/).map(t => t.trim()).includes(name);
}

/* ═══════════════════════════════════════════════════════════════════════════
   场地资源（FieldResourceRegistry）
   ═══════════════════════════════════════════════════════════════════════════

   与 CustomBuffRegistry 是姐妹关系但完全独立：场地资源是"全局公共计数器"，
   不会写入任何角色的 system.buffs，因此天然无法作为 BUFF 施加给角色。

   存储/同步：由 sin-resource-hud.mjs 负责（world-scope game.settings + socket
   委托 GM 写入），本文件只维护"有哪些场地资源、它们各自的被动规则"这份定义表。
   物品 Activity 编辑器里"消耗/效果"新增的【公用场地】选项，读写的就是这份
   存储，与 CustomBuffRegistry 驱动的角色 BUFF 系统完全不共用数据。

   用法：
   registerFieldResource("场地名字", {
     icon: "systems/limbusCompany_FVTT/assets/icons/Buff_icon/Custom_buffs/xxx.webp", // 可选，sin-hud 面板图标
     maxStacks: 999,                 // 可选，默认无上限
     triggerBackgroundTags: ["血魔"], // 遭遇战开始时，若在场任意角色背景 tags
                                      // 命中列表中任一项，则激活该场地资源
     roundStartTags: ["拉曼却", "血魔"], // 可选：onRoundStart 的角色匹配名单，
                                      // 缺省时与 triggerBackgroundTags 相同
     async onStatusTick(ctx) {
       // ctx = { buffType, intensity, stacksConsumed, name, addStacks(delta) }
       // 在【流血/烧伤/破裂/沉沦/震颤】造成跳动伤害后，由 ClashManager 广播调用
     },
     async onRoundStart(ctx) {
       // ctx = { actor, addBuff(type, intensity, stacks, whenAdded) }
       // 每轮"回合开始时"处理，对每个行动角色调用一次（GM 端触发）
     },
     async onConsumed(ctx) {
       // ctx = { amount, addStacksTo(otherFieldName, delta) }
       // 本场地资源被 Activity「消耗」类型成功扣除时调用（用于联动其他计数场地，
       // 如"消耗XX总数"这类只增不减的统计型场地）
     },
   });
*/

/** @type {Map<string, object>} */
export const FieldResourceRegistry = new Map();

/**
 * 注册一个场地资源定义（详见文件头本节用法说明）。
 * @param {string} name    场地名字（同时作为存储 key 与 Activity 编辑器里输入的匹配串）
 * @param {object} config  { icon, maxStacks, triggerBackgroundTags, roundStartTags, onStatusTick, onRoundStart, onConsumed }
 */
export function registerFieldResource(name, config = {}) {
  FieldResourceRegistry.set(name, {
    name,
    icon:                   config.icon ?? "",
    maxStacks:             config.maxStacks ?? Infinity,
    triggerBackgroundTags: config.triggerBackgroundTags ?? [],
    roundStartTags:        config.roundStartTags ?? config.triggerBackgroundTags ?? [],
    onStatusTick:          typeof config.onStatusTick === "function" ? config.onStatusTick : null,
    onRoundStart:          typeof config.onRoundStart === "function" ? config.onRoundStart : null,
    onConsumed:            typeof config.onConsumed   === "function" ? config.onConsumed   : null,
  });
}

/**
 * 【血宴】场地资源
 * - 最大值：999 层
 * - 任意角色受到【流血】跳动伤害时：为血宴添加与该次流血强度相同的层数
 * - 背景标签为【拉曼却】或【血魔】的角色，回合开始时：
 *   获得 1 层 5 级（强度5）【流血】 + 3 层【攻击等级提升】
 * - 每被 Activity 消耗一次，累加进【消耗血宴总数】
 */
registerFieldResource("血宴", {
  icon:                   "systems/limbusCompany_FVTT/assets/icons/Buff_icon/Custom_buffs/血宴.webp",
  maxStacks:             999,
  triggerBackgroundTags: ["血魔"],
  roundStartTags:        ["拉曼却", "血魔"],

  async onStatusTick(ctx) {
    if (ctx.buffType !== "bleed") return;
    if (!(ctx.intensity > 0)) return;
    await ctx.addStacks(ctx.intensity);
  },

  async onRoundStart(ctx) {
    const bgUuid = ctx.actor?.system?.background?.uuid ?? "";
    if (!bgUuid) return;
    const bgItem = await fromUuid(bgUuid).catch(() => null);
    // tags 可能是数组也可能是 "a/b" 字符串，两种都要认
    const rawTags = bgItem?.system?.tags;
    const tags = (Array.isArray(rawTags) ? rawTags : String(rawTags ?? "").split("/"))
      .map(t => String(t).trim()).filter(Boolean);
    if (!tags.some(t => this.roundStartTags.includes(t))) return;
    await ctx.addBuff("bleed",      5, 1, "本回合");
    await ctx.addBuff("atkLevelUp", 0, 3, "本回合");
  },

  async onConsumed(ctx) {
    if (!(ctx.amount > 0)) return;
    await ctx.addStacksTo("消耗血宴总数", ctx.amount);
  },
});

/**
 * 【消耗血宴总数】场地资源
 * - 纯统计型计数器：只在【血宴】被 Activity 消耗时累加，不会自然衰减/上限截断
 * - 与【血宴】同批背景标签下随遭遇战一起激活（初始 0 层，方便一开场就能看到）
 */
registerFieldResource("消耗血宴总数", {
  icon:                   "systems/limbusCompany_FVTT/assets/icons/Buff_icon/Custom_buffs/消耗血宴总数.webp",
  maxStacks:             Infinity,
  triggerBackgroundTags: ["血魔"],
});
