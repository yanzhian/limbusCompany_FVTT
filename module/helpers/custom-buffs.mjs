/**
 * custom-buffs.mjs — 自定义 BUFF 扩展通道
 *
 * 用法：
 *   import { registerCustomBuff } from "./custom-buffs.mjs";
 *
 *   registerCustomBuff("myBuff", {
 *     label:         "显示名称",
 *     maxStacks:     4,          // 可选：最大层数上限（超出则截断）
 *     refreshOnGain: true,       // 可选：获得时刷新（不叠加层数，直接替换）
 *     onRoundEnd(actor, buff) {},           // 回合结束时回调 → 返回 Promise
 *     modifySpeedRoll(actor, ctx) {},       // 速度骰结果修正 → 返回最终 total（Number）
 *     onClashWin(carrier, opponent) {},     // 拼点胜利时回调 → 返回 Promise
 *     beforeChaos(actor, buff) {},          // 混乱触发前检查 → 返回 { immune: bool }
 *     modifyResistances(actor, buff, res) {}, // 修改物理抗性：res = { slash, blunt, pierce }（"xN.0" 字符串），
 *                                             // 可原地修改或返回部分覆盖对象（如 { slash: "x2.0" }）；
 *                                             // 陷入混乱的强制抗性优先级更高，混乱时不会调用此钩子
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

/* ─── 内置自定义 BUFF ───────────────────────────────────────────────────── */

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
      await actor.update({ "system.buffs": buffs });
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="limbuscompany chat-clash"><strong>${actor.name}</strong>【防御姿态】已消散。</div>`,
      });
    } else {
      buffs[idx].stacks = newStacks;
      await actor.update({ "system.buffs": buffs });
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
    const buffs    = opponent.system?.buffs ?? [];
    const tremor   = buffs.find(b => b.type === "tremor" && (b.stacks ?? 0) > 0);
    if (!tremor) return;

    const intensity = tremor.intensity ?? 1;
    const thresholds = foundry.utils.deepClone(opponent.system?.chaosThresholds ?? []);
    let shifted = false;
    for (let i = 0; i < thresholds.length; i++) {
      thresholds[i] = { ...thresholds[i], percent: (thresholds[i].percent ?? 0) + intensity };
      shifted = true;
    }
    if (shifted) {
      await opponent.update({ "system.chaosThresholds": thresholds });
    }

    // 消耗 1 层震颤
    if (typeof opponent.reduceBuffStacks === "function") {
      await opponent.reduceBuffStacks("tremor");
    } else {
      const nb  = foundry.utils.deepClone(opponent.system?.buffs ?? []);
      const tidx = nb.findIndex(b => b.type === "tremor");
      if (tidx >= 0) {
        nb[tidx].stacks = Math.max(0, (nb[tidx].stacks ?? 1) - 1);
        if (nb[tidx].stacks <= 0) nb.splice(tidx, 1);
        await opponent.update({ "system.buffs": nb });
      }
    }

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: carrier }),
      content: `<div class="limbuscompany chat-clash">
        <strong>${carrier.name}</strong>【防御姿态】触发：对 <strong>${opponent.name}</strong> 震颤引爆！
        混乱阈值各前移 <strong>${intensity}%</strong>。
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
    await actor.update({ "system.buffs": buffs });

    // 为伤害来源（attacker）恢复 1D6 理智
    const target = ctx?.attacker ?? null;
    let sanHeal = 0;
    if (target) {
      const healRoll = new Roll("1d6");
      await healRoll.evaluate();
      sanHeal = healRoll.total;
      const curSan = target.system?.sanity?.value ?? 50;
      const newSan = Math.min(95, curSan + sanHeal);
      await target.update({ "system.sanity.value": newSan });
    }

    // 返回消息文本，由 _applyAndSendTake 收集后并入 ⚡ 活动消息
    return `【蝶】触发（剩余 <strong>${newStacks}</strong> 层）：`
      + (target ? ` 为 <strong>${target.name}</strong> 恢复 <strong>${sanHeal}</strong> 点理智。` : "")
      + ` 自身获得 1 层【沉沦】（强度 2）。`;
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
    await actor.update({ "system.buffs": buffs });
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
    await actor.update({ "system.buffs": buffs });
  },
});
