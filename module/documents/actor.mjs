import { LC } from "../helpers/config.mjs";

/**
 * Limbus Company Actor 文档类。
 * 负责所有角色数据的派生计算和骰子方法。
 */
export class LimbusActor extends Actor {

  /* ============================================================
     数据准备管线
     ============================================================ */

  /** @override */
  prepareData() {
    super.prepareData();
  }

  /**
   * 在 items 处理之前执行。
   * 设置攻击等级和防御等级的基础值（来自属性）。
   * @override
   */
  prepareBaseData() {
    super.prepareBaseData();
    if (this.type !== "character" && this.type !== "npc") return;

    const sys = this.system;
    const attrs = sys.attributes;

    // 攻击等级基础 = 力量（str）
    sys.offense_level.base = attrs.str.value ?? 3;
    // 防御等级基础 = 体质（con）
    sys.defense_level.base = attrs.con.value ?? 5;
  }

  /**
   * 在 prepareBaseData + ActiveEffects 之后执行。
   * 计算所有派生数值。
   * @override
   */
  prepareDerivedData() {
    super.prepareDerivedData();
    if (this.type !== "character" && this.type !== "npc") return;

    this._calcLevelStats();
    this._calcDerivedStats();
    this._calcChaosThresholds();
    if (this.type === "character") this._calcHeartAndHopeBonus();
  }

  /* ============================================================
     私有计算方法
     ============================================================ */

  /**
   * 根据等级计算星芒上限（每升1级+1）。
   * 注：星芒实际值由玩家维护，此处只记录每级应得的累计量供参考。
   */
  _calcLevelStats() {
    // 暂无等级触发的自动计算，预留扩展点
  }

  /**
   * 计算速度、攻击/防御等级总值。
   */
  _calcDerivedStats() {
    const sys   = this.system;
    const attrs = sys.attributes;

    // 速度 = 敏捷（先攻用，骰面1d6部分在 rollSpeed 方法中处理）
    // 这里仅存敏捷值，方便 rollSpeed 调用
    sys.speed._agiValue = attrs.agi.value ?? 4;

    // 攻击/防御等级总值 = 基础 + bonus（bonus 由装备或心与望加成）
    sys.offense_level.total =
      (sys.offense_level.base ?? 0) + (sys.offense_level.bonus ?? 0);
    sys.defense_level.total =
      (sys.defense_level.base ?? 0) + (sys.defense_level.bonus ?? 0);
  }

  /**
   * 根据体质/敏捷计算混乱阀值条数和每条对应的 HP 值。
   * 体质>7 减1条；敏捷>7 加1条；范围 [1, 3]。
   */
  _calcChaosThresholds() {
    const sys   = this.system;
    const attrs = sys.attributes;
    const con   = attrs.con.value ?? 5;
    const agi   = attrs.agi.value ?? 4;
    const maxHP = sys.health.max ?? 10;

    let count = 2;
    if (con > 7) count -= 1;
    if (agi > 7) count += 1;
    count = Math.max(1, Math.min(3, count));

    sys.chaos_thresholds.count = count;
    const percents = LC.chaosThresholdMap[count] ?? [0.30, 0.60];
    sys.chaos_thresholds.thresholds = percents.map(p => Math.floor(maxHP * p));
  }

  /**
   * 将已选择的「心与望」加成应用到 offense_level.bonus / defense_level.bonus。
   */
  _calcHeartAndHopeBonus() {
    const sys     = this.system;
    const choices = sys.heart_and_hope?.choices ?? [];

    let offenseBonus  = 0;
    let defenseBonus  = 0;
    let chaosReduction = 0;

    for (const choice of choices) {
      if (choice === "offense_up")   offenseBonus  += 10;
      if (choice === "defense_up")   defenseBonus  += 10;
      if (choice === "chaos_reduce") chaosReduction += 1;
    }

    // 叠加到 bonus（注意 bonus 可能还有装备加成，这里只追加心与望部分）
    sys.offense_level.bonus  = (sys.offense_level.bonus  ?? 0) + offenseBonus;
    sys.defense_level.bonus  = (sys.defense_level.bonus  ?? 0) + defenseBonus;

    // 混乱阀值减少（在 _calcChaosThresholds 之后应用）
    if (chaosReduction > 0) {
      sys.chaos_thresholds.count = Math.max(1, sys.chaos_thresholds.count - chaosReduction);
      const percents = LC.chaosThresholdMap[sys.chaos_thresholds.count] ?? [0.50];
      sys.chaos_thresholds.thresholds = percents.map(p => Math.floor(sys.health.max * p));
    }
  }

  /* ============================================================
     检查当前 HP 是否触发混乱阀值
     ============================================================ */

  /**
   * 当 HP 发生变化后调用，检查是否越过任一未触发的阀值。
   * 若越过则标记为已触发并设置 chaos = true。
   * @returns {boolean} 是否新触发了混乱
   */
  checkChaosThreshold() {
    const sys         = this.system;
    const currentHP   = sys.health.value ?? 0;
    const thresholds  = sys.chaos_thresholds.thresholds ?? [];
    const triggered   = new Set(sys.chaos_thresholds.triggered ?? []);
    let newChaos      = false;

    thresholds.forEach((threshold, idx) => {
      if (!triggered.has(idx) && currentHP <= threshold) {
        triggered.add(idx);
        newChaos = true;
      }
    });

    if (newChaos) {
      this.update({
        "system.chaos_thresholds.triggered": [...triggered],
        "system.chaos": true,
      });
    }
    return newChaos;
  }

  /**
   * 长休：恢复满血，重置混乱阀值，清除混乱/恐慌状态。
   */
  async longRest() {
    await this.update({
      "system.health.value":                  this.system.health.max,
      "system.chaos_thresholds.triggered":    [],
      "system.chaos":                         false,
      "system.panic":                         false,
    });
    ui.notifications.info(`${this.name} 进行了长休，生命值和混乱阀值已恢复。`);
  }

  /* ============================================================
     骰子方法
     ============================================================ */

  /**
   * 属性鉴定：投出 attrValue 枚硬币（1d2），正面（=2）算成功。
   * 成功数 >= difficulty → 成功；= difficulty → 完美成功。
   * @param {string} attrKey    - 属性键名（str/agi/con/int/per/cha）
   * @param {number} difficulty - 需要的成功枚数
   * @param {number} [modifier=0] - 装备或RP带来的硬币数修正（正负均可）
   */
  async rollAttributeCheck(attrKey, difficulty, modifier = 0) {
    const attr = this.system.attributes[attrKey];
    if (!attr) {
      ui.notifications.warn(`LimbusCompany | 未知属性: ${attrKey}`);
      return null;
    }

    const attrValue   = attr.value ?? 3;
    const totalCoins  = Math.max(1, attrValue + modifier);
    const label       = game.i18n.localize(`LC.Attribute.${attrKey}`);

    // 投出 totalCoins 枚 1d2，2=正面
    const rolls = [];
    for (let i = 0; i < totalCoins; i++) {
      const r = new Roll("1d2");
      await r.evaluate();
      rolls.push(r.total);
    }

    const successes  = rolls.filter(v => v === 2).length;
    const isPerfect  = successes === difficulty;
    const isSuccess  = successes >= difficulty;

    let resultKey;
    if (!isSuccess)   resultKey = "LC.Check.failure";
    else if (isPerfect) resultKey = "LC.Check.perfect";
    else              resultKey = "LC.Check.success";

    const diffLabel = game.i18n.localize(LC.checkDifficultyLabel(difficulty));
    const content = `
      <div class="lc-check">
        <p><strong>${this.name}</strong> — ${label} 鉴定（难度 ${difficulty}，${diffLabel}）</p>
        <p>投币：${totalCoins} 枚${modifier !== 0 ? `（${attrValue}属性 ${modifier >= 0 ? "+" : ""}${modifier}修正）` : ""}</p>
        <p>正面：<strong>${successes}</strong> 枚 →
           <strong class="${isSuccess ? (isPerfect ? "perfect" : "success") : "failure"}">
             ${game.i18n.localize(resultKey)}
           </strong>
        </p>
      </div>
    `;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      content,
      type: CONST.CHAT_MESSAGE_TYPES.ROLL,
    });

    return { rolls, successes, isSuccess, isPerfect };
  }

  /**
   * 骰先攻速度：1d6 + 敏捷。
   */
  async rollSpeed() {
    const agi  = this.system.attributes.agi.value ?? 4;
    const roll = new Roll(`1d6 + ${agi}`);
    await roll.evaluate();

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      flavor:  `${this.name} — 先攻速度`,
      rollMode: game.settings.get("core", "rollMode"),
    });

    return roll;
  }

  /**
   * 骰技能拼点骰池：返回 dice_count 个独立骰子的结果数组。
   * 每个骰子 = base_value + variable_dice_roll + weight。
   *
   * 骰类规则：
   *   normal      — 正常取值
   *   unbreakable — 每个骰子结果不低于 base_value（不可破坏）
   *   truncated   — 每个骰子结果不高于 base_value + weight（截断）
   *
   * @param {Item} skillItem - skill_attack / skill_defense / ego 物品
   * @returns {{ results: number[], sinKey: string }}
   */
  async rollSkillDice(skillItem) {
    const sd        = skillItem.system;
    const diceCount = sd.dice_count    ?? 1;
    const baseVal   = sd.base_value    ?? 0;
    const varDice   = sd.variable_dice ?? "d4";
    const weight    = sd.weight        ?? 0;
    const diceType  = sd.dice_type     ?? "normal";
    const sinKey    = sd.sin           ?? "none";

    const results = [];

    for (let i = 0; i < diceCount; i++) {
      const r = new Roll(`1${varDice}`);
      await r.evaluate();
      let val = baseVal + r.total + weight;

      if (diceType === "unbreakable") val = Math.max(val, baseVal);
      if (diceType === "truncated")   val = Math.min(val, baseVal + weight);

      results.push(val);
    }

    // 罪孽技能使用后：公共罪孽池 +1
    if (sinKey !== "none" && game.limbusCompany?.adjustSin) {
      await game.limbusCompany.adjustSin(sinKey, 1);
    }

    const sinLabel  = sinKey !== "none"
      ? game.i18n.localize(`LC.Sin.${sinKey}`) : "";
    const typeLabel = skillItem.type === "skill_attack"
      ? game.i18n.localize(`LC.AttackType.${sd.attack_type ?? "slash"}`)
      : skillItem.type === "skill_defense"
        ? game.i18n.localize(`LC.DefenseType.${sd.defense_type ?? "dodge"}`)
        : game.i18n.localize(`LC.EgoTier.${(sd.ego_tier ?? "ZAYIN").toLowerCase()}`);

    const content = `
      <div class="lc-skill-roll">
        <p><strong>${skillItem.name}</strong>
           ${sinLabel ? `[${sinLabel}]` : ""} · ${typeLabel}</p>
        <p>骰子结果（${diceCount}个）：${results.join(" / ")}</p>
        <p>最高值：<strong>${Math.max(...results)}</strong></p>
        ${sinKey !== "none" ? `<p class="sin-note">公共罪孽池 [${sinLabel}] +1</p>` : ""}
      </div>
    `;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      content,
    });

    return { results, sinKey };
  }

  /**
   * EGO 激活：检查公共罪孽池是否满足消耗条件，满足则扣除并骰点。
   * @param {Item} egoItem - ego 类型物品
   */
  async activateEgo(egoItem) {
    const sinCost = egoItem.system.sin_cost ?? {};

    if (!game.limbusCompany.canActivateEgo(sinCost)) {
      ui.notifications.warn(
        `${this.name} | EGO「${egoItem.name}」罪孽资源不足，无法激活。`
      );
      return null;
    }

    // 扣除消耗
    for (const [sin, amount] of Object.entries(sinCost)) {
      if (amount > 0) await game.limbusCompany.adjustSin(sin, -amount);
    }

    // 骰技能骰
    return this.rollSkillDice(egoItem);
  }
}
