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

  maxStacks:     4,
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
