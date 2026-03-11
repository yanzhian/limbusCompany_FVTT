/**
 * actor.mjs — 边狱巴士都市规则 Actor 文档类
 *
 * 包含：
 *   - CharacterData  : TypeDataModel（角色数据模型 + 派生值计算）
 *   - LimbusActor    : Actor 文档类（封装游戏逻辑方法）
 */

// ═══════════════════════════════════════════════════════════════════════════
//  CharacterData — TypeDataModel（角色数据模型）
// ═══════════════════════════════════════════════════════════════════════════

export class CharacterData extends foundry.abstract.TypeDataModel {

  /** 定义数据模型结构 */
  static defineSchema() {
    const fields = foundry.data.fields;

    // ── 混乱阈值条目模式 ──────────────────────────────────────────────────
    const chaosThresholdSchema = new fields.SchemaField({
      percent:   new fields.NumberField({ required: true, integer: true, min: 0, max: 100, initial: 60 }),
      triggered: new fields.BooleanField({ required: true, initial: false }),
    });

    // ── Activity（效果触发）模式 ──────────────────────────────────────────
    const activitySchema = new fields.SchemaField({
      id:           new fields.StringField({ required: true, initial: () => foundry.utils.randomID() }),
      name:         new fields.StringField({ required: true, initial: "新效果" }),
      trigger:      new fields.StringField({ required: true, initial: "攻击时" }),
      precondition: new fields.ObjectField({ required: false, nullable: true, initial: null }),
      cost:         new fields.ObjectField({ required: false, nullable: true, initial: null }),
      effect:       new fields.ObjectField({ required: true, initial: () => ({}) }),
      limit: new fields.SchemaField({
        type:  new fields.StringField({ required: true, initial: "unlimited" }),
        count: new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      }),
    });

    // ── BUFF 条目模式 ─────────────────────────────────────────────────────
    const buffSchema = new fields.SchemaField({
      id:         new fields.StringField({ required: true, initial: () => foundry.utils.randomID() }),
      type:       new fields.StringField({ required: true, initial: "custom" }),
      name:       new fields.StringField({ required: true, initial: "自定义" }),
      icon:       new fields.StringField({ required: false, initial: "" }),
      intensity:  new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      stacks:     new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      whenAdded:  new fields.StringField({ required: true, initial: "本回合" }), // "本回合" | "下回合"
    });

    return {
      // ── 生命值 ────────────────────────────────────────────────────────
      hp: new fields.SchemaField({
        value: new fields.NumberField({ required: true, integer: true, min: 0, initial: 10 }),
        max:   new fields.NumberField({ required: true, integer: true, min: 1, initial: 10 }),
        rollTotal: new fields.NumberField({ required: true, integer: true, min: 1, initial: 10 }),
      }),

      // ── 理智值（范围 5–95，默认 50） ───────────────────────────────────
      sanity: new fields.SchemaField({
        value: new fields.NumberField({ required: true, integer: true, min: 5, max: 95, initial: 50 }),
      }),

      // ── 速度（派生自敏捷，存储实际值供显示） ──────────────────────────
      speed: new fields.SchemaField({
        min: new fields.NumberField({ required: true, integer: true, min: 0, initial: 2 }),
        max: new fields.NumberField({ required: true, integer: true, min: 0, initial: 7 }),
      }),

      // ── 行动点（上限固定 3） ───────────────────────────────────────────
      ap: new fields.SchemaField({
        value: new fields.NumberField({ required: true, integer: true, min: 0, max: 3, initial: 3 }),
        max:   new fields.NumberField({ required: true, integer: true, min: 1, max: 3, initial: 3 }),
      }),

      // ── 等级 & 经验 ───────────────────────────────────────────────────
      level: new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      xp: new fields.SchemaField({
        value: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        next:  new fields.NumberField({ required: true, integer: true, min: 0, initial: 10 }),
      }),

      // ── 星芒（上限 = 30 + 等级） ─────────────────────────────────────
      stellarMotes: new fields.SchemaField({
        value: new fields.NumberField({ required: true, integer: true, min: 0, initial: 30 }),
        max:   new fields.NumberField({ required: true, integer: true, min: 0, initial: 30 }),
      }),

      // ── 攻击等级 & 防御等级（base = 公式推算；extra = 装备加成） ────────
      atk: new fields.SchemaField({
        base:  new fields.NumberField({ required: true, integer: true, initial: 0 }),
        extra: new fields.NumberField({ required: true, integer: true, initial: 0 }),
      }),
      def: new fields.SchemaField({
        base:  new fields.NumberField({ required: true, integer: true, initial: 0 }),
        extra: new fields.NumberField({ required: true, integer: true, initial: 0 }),
      }),

      // ── 六属性（范围 2–10，初始分配 30 点） ───────────────────────────
      attributes: new fields.SchemaField({
        str: new fields.NumberField({ required: true, integer: true, min: 2, max: 10, initial: 5 }),
        agi: new fields.NumberField({ required: true, integer: true, min: 2, max: 10, initial: 5 }),
        con: new fields.NumberField({ required: true, integer: true, min: 2, max: 10, initial: 5 }),
        int: new fields.NumberField({ required: true, integer: true, min: 2, max: 10, initial: 5 }),
        per: new fields.NumberField({ required: true, integer: true, min: 2, max: 10, initial: 5 }),
        cha: new fields.NumberField({ required: true, integer: true, min: 2, max: 10, initial: 5 }),
      }),

      // ── 物理抗性（由上装决定） ─────────────────────────────────────────
      resistances: new fields.SchemaField({
        slash:  new fields.StringField({ required: true, initial: "x1.0" }),
        blunt:  new fields.StringField({ required: true, initial: "x1.0" }),
        pierce: new fields.StringField({ required: true, initial: "x1.0" }),
      }),

      // ── EGO 罪孽抗性（默认全 x1.0） ──────────────────────────────────
      egoResistances: new fields.SchemaField({
        wrath:    new fields.StringField({ required: true, initial: "x1.0" }),
        lust:     new fields.StringField({ required: true, initial: "x1.0" }),
        sloth:    new fields.StringField({ required: true, initial: "x1.0" }),
        gluttony: new fields.StringField({ required: true, initial: "x1.0" }),
        gloom:    new fields.StringField({ required: true, initial: "x1.0" }),
        pride:    new fields.StringField({ required: true, initial: "x1.0" }),
        envy:     new fields.StringField({ required: true, initial: "x1.0" }),
      }),

      // ── 混乱阈值（数组，含 percent + triggered） ──────────────────────
      // 默认 2 条：60% / 30%
      chaosThresholds: new fields.ArrayField(chaosThresholdSchema, {
        required: true,
        initial: [
          { percent: 60, triggered: false },
          { percent: 30, triggered: false },
        ],
      }),

      // ── 七宗罪资源（公共资源，暂存于角色数据） ───────────────────────
      sins: new fields.SchemaField({
        wrath:    new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        lust:     new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        sloth:    new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        gluttony: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        gloom:    new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        pride:    new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        envy:     new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      }),

      // ── 装备格（3×3 九宫格，存储已装备物品的 UUID） ────────────────────
      // slot0–slot8，null 表示空槽
      equipment: new fields.SchemaField({
        slot0: new fields.StringField({ required: false, nullable: true, initial: null }),
        slot1: new fields.StringField({ required: false, nullable: true, initial: null }),
        slot2: new fields.StringField({ required: false, nullable: true, initial: null }),
        slot3: new fields.StringField({ required: false, nullable: true, initial: null }),
        slot4: new fields.StringField({ required: false, nullable: true, initial: null }),
        slot5: new fields.StringField({ required: false, nullable: true, initial: null }),
        slot6: new fields.StringField({ required: false, nullable: true, initial: null }),
        slot7: new fields.StringField({ required: false, nullable: true, initial: null }),
        slot8: new fields.StringField({ required: false, nullable: true, initial: null }),
      }),

      // ── 技能槽（存储已装备物品的 UUID） ──────────────────────────────
      skills: new fields.SchemaField({
        // 最多 6 个基础技能槽，不足时为 null
        basic: new fields.ArrayField(
          new fields.StringField({ nullable: true }),
          { required: true, initial: [null, null, null, null, null, null] }
        ),
        // 守备技能槽（1 个）
        defense: new fields.StringField({ required: false, nullable: true, initial: null }),
        // EGO 技能槽（按等级）
        ego: new fields.SchemaField({
          ZAYIN: new fields.StringField({ nullable: true, initial: null }),
          TET:   new fields.StringField({ nullable: true, initial: null }),
          HE:    new fields.StringField({ nullable: true, initial: null }),
          WAW:   new fields.StringField({ nullable: true, initial: null }),
          ALEPH: new fields.StringField({ nullable: true, initial: null }),
        }),
      }),

      // ── 眼（货币） ────────────────────────────────────────────────────
      currency: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),

      // ── BUFF 状态列表 ─────────────────────────────────────────────────
      buffs: new fields.ArrayField(buffSchema, { required: true, initial: [] }),

      // ── 背景信息（纯自由文本，不参与规则运算） ───────────────────────
      biography: new fields.HTMLField({ required: false, initial: "" }),

      // ── 背景标签（如：背景-收尾人-7阶） ─────────────────────────────
      backgroundTag: new fields.StringField({ required: false, initial: "" }),

      // ── 属性点（每 10 级 +1） ─────────────────────────────────────────
      attrPoints: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    };
  }

  // ─── 派生数据计算 ──────────────────────────────────────────────────────────

  prepareDerivedData() {
    const { attributes, level } = this;
    const { str, agi, con } = attributes;

    // 攻击等级基础值：力量÷3↓ + 等级
    this.atk.base = Math.floor(str / 3) + level;

    // 防御等级基础值：体质÷3↓ + 等级
    this.def.base = Math.floor(con / 3) + level;

    // 最大生命值：等级d10累计 + 体质×5
    const rollTotal = Math.max(1, this.hp.rollTotal ?? 10);
    this.hp.max = (con * 5) + rollTotal;

    // 速度范围：1+敏捷 ~ 6+敏捷（1D6+敏捷）
    this.speed.min = 1 + agi;
    this.speed.max = 6 + agi;

    // 星芒上限：30 + 等级
    this.stellarMotes.max = 30 + level;

    // 下一级经验需求
    const xpTable = CONFIG.LIMBUSCOMPANY?.LEVEL_XP ?? [];
    this.xp.next = xpTable[level] ?? (xpTable[xpTable.length - 1] ?? 0);

    // 行动点上限固定 3
    this.ap.max = 3;
  }

  // ─── 混乱阈值辅助方法 ─────────────────────────────────────────────────────

  /**
   * 根据当前属性（体质 / 敏捷）计算默认混乱阈值数组
   * 用于新角色创建和长休重置。
   * @returns {{ percent: number, triggered: boolean }[]} 从高到低排序
   */
  getDefaultChaosThresholds() {
    const { agi, con } = this.attributes;
    if (con > 7) {
      return [{ percent: 50, triggered: false }];
    } else if (agi > 7) {
      return [
        { percent: 80, triggered: false },
        { percent: 50, triggered: false },
        { percent: 20, triggered: false },
      ];
    } else {
      return [
        { percent: 60, triggered: false },
        { percent: 30, triggered: false },
      ];
    }
  }

  /**
   * 检查当前 HP 是否触发任意混乱阈值。
   * 从高到低逐条检查，最多触发一条，触发后烧断（triggered = true）。
   * @param {number} currentHP
   * @param {number} maxHP
   * @returns {{ triggered: boolean, threshold: object|null }}
   */
  checkChaosThreshold(currentHP, maxHP) {
    for (const threshold of this.chaosThresholds) {
      if (!threshold.triggered && currentHP <= maxHP * threshold.percent / 100) {
        return { triggered: true, threshold };
      }
    }
    return { triggered: false, threshold: null };
  }

  /**
   * 震颤引爆：所有阈值百分比同时前移 N%（可叠加，已烧断的保持烧断状态）
   * @param {number} shiftAmount 震颤强度值
   * @returns {{ percent: number, triggered: boolean }[]} 更新后的阈值数组
   */
  applySeismicBlast(shiftAmount) {
    return this.chaosThresholds.map(t => ({
      percent:   Math.min(100, t.percent + shiftAmount),
      triggered: t.triggered,
    }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  LimbusActor — Actor 文档类
// ═══════════════════════════════════════════════════════════════════════════

export class LimbusActor extends Actor {

  /**
   * @override
   * 新建角色时强制 prototypeToken.actorLink = true，
   * 确保拖拽到场景时 Token 与角色卡共享数据，不会产生独立的 Token 副本。
   */
  async _preCreate(data, options, user) {
    await super._preCreate(data, options, user);
    if (this.type === "character") {
      this.updateSource({ "prototypeToken.actorLink": true });
    }
  }

  /** @override */
  prepareData() {
    super.prepareData();
  }

  /** @override */
  prepareDerivedData() {
    super.prepareDerivedData();
    if (this.type === "character") this._prepareCharacterData();
  }

  // ─── 角色专项派生数据 ──────────────────────────────────────────────────

  _prepareCharacterData() {
    const systemData = this.system;

    // 将攻防加成汇总（基础值 + 装备修正）
    systemData.atk.total = systemData.atk.base + systemData.atk.extra;
    systemData.def.total = systemData.def.base + systemData.def.extra;

    // 检查恐慌状态
    systemData.isInPanic = systemData.sanity.value <= 5;

    // 统计已装备的基础技能数量
    systemData.equippedBasicSkillCount = (systemData.skills.basic ?? []).filter(Boolean).length;
  }

  // ─── 星芒检查 ──────────────────────────────────────────────────────────

  /**
   * 检查是否有足够星芒装备某个物品
   * @param {LimbusItem} item
   * @returns {{ canEquip: boolean, cost: number, current: number, max: number }}
   */
  checkStellarCost(item) {
    const cost    = item.getStellarCost?.() ?? 0;
    const current = this.system.stellarMotes.value;
    const max     = this.system.stellarMotes.max;
    return { canEquip: current >= cost, cost, current, max };
  }

  /**
   * 消耗星芒
   * @param {number} amount
   */
  async spendStellarMotes(amount) {
    const current = this.system.stellarMotes.value;
    return this.update({ "system.stellarMotes.value": Math.max(0, current - amount) });
  }

  /**
   * 回复星芒
   * @param {number} amount
   */
  async gainStellarMotes(amount) {
    const current = this.system.stellarMotes.value;
    const max     = this.system.stellarMotes.max;
    return this.update({ "system.stellarMotes.value": Math.min(max, current + amount) });
  }

  // ─── 装备物品到九宫格 ──────────────────────────────────────────────────

  /**
   * 将物品装备到指定九宫格槽位
   * @param {string} itemId   actor.items 中的物品 ID
   * @param {number} slotIndex  0–8
   */
  async equipToGrid(itemId, slotIndex) {
    if (slotIndex < 0 || slotIndex > 8) return;
    const item = this.items.get(itemId);
    if (!item || item.type !== "equipment") return;

    const prevId = this.system.equipment[`slot${slotIndex}`];
    if (!this._canEquipSubtype(item, { currentSlot: slotIndex, replacingItemId: prevId })) return;

    const { canEquip, cost, current, max } = this.checkStellarCost(item);
    if (!canEquip) {
      const msg = game.i18n.format("LIMBUSCOMPANY.Warning.NotEnoughStellar", { cost, current, max });
      ui.notifications.warn(msg);
      return;
    }

    // 先卸下该槽位原有装备（返还星芒）
    if (prevId) await this.unequipFromGrid(slotIndex);

    await this.spendStellarMotes(cost);
    return this.update({ [`system.equipment.slot${slotIndex}`]: itemId });
  }

  /**
   * 从九宫格卸下装备
   * @param {number} slotIndex 0–8
   */
  async unequipFromGrid(slotIndex) {
    const itemId = this.system.equipment[`slot${slotIndex}`];
    if (!itemId) return;
    const item = this.items.get(itemId);
    if (item) await this.gainStellarMotes(item.getStellarCost?.() ?? 0);
    return this.update({ [`system.equipment.slot${slotIndex}`]: null });
  }


  _canEquipSubtype(item, { currentSlot = null, replacingItemId = null } = {}) {
    const subtype = item?.system?.subtype;
    if (!["upper", "lower"].includes(subtype)) return true;

    const equippedIds = Object.entries(this.system.equipment ?? {})
      .filter(([slotKey, id]) => id && slotKey !== `slot${currentSlot}`)
      .map(([, id]) => id)
      .filter(id => id !== replacingItemId && id !== item.id);

    const hasSameSubtype = equippedIds.some(id => this.items.get(id)?.system?.subtype === subtype);
    if (hasSameSubtype) {
      ui.notifications.warn(`${subtype === "upper" ? "上装" : "下装"}只能装备 1 个。`);
      return false;
    }
    return true;
  }

  // ─── 装备技能 ──────────────────────────────────────────────────────────

  /**
   * 装备技能到对应槽位
   * @param {string} itemId  物品 ID
   */
  async equipSkill(itemId) {
    const item = this.items.get(itemId);
    if (!item || item.type !== "skill") return;

    const { canEquip, cost, current, max } = this.checkStellarCost(item);
    if (!canEquip) {
      const msg = game.i18n.format("LIMBUSCOMPANY.Warning.NotEnoughStellar", { cost, current, max });
      ui.notifications.warn(msg);
      return;
    }

    const skillType = item.system.type;

    if (skillType === "defense") {
      const prevId = this.system.skills.defense;
      if (prevId) await this.unequipSkill(prevId);
      await this.spendStellarMotes(cost);
      return this.update({ "system.skills.defense": itemId });
    }

    if (skillType === "ego") {
      const grade = item.system.egoDiceRating;
      if (!grade) return;
      const prevId = this.system.skills.ego[grade];
      if (prevId) await this.unequipSkill(prevId);
      await this.spendStellarMotes(cost);
      return this.update({ [`system.skills.ego.${grade}`]: itemId });
    }

    // 基础技能：找第一个空槽
    if (skillType === "basic") {
      const slots = [...(this.system.skills.basic ?? [null, null, null, null, null, null])];
      const emptyIdx = slots.findIndex(s => !s);
      if (emptyIdx === -1) {
        ui.notifications.warn(game.i18n.localize("LIMBUSCOMPANY.Warning.SlotFull"));
        return;
      }
      slots[emptyIdx] = itemId;
      await this.spendStellarMotes(cost);
      return this.update({ "system.skills.basic": slots });
    }
  }

  /**
   * 装备基础技能到指定槽位（自由放置，支持槽内移动与替换）
   * @param {string} itemId        物品 ID
   * @param {number} targetSlot    目标槽位索引（0–5）
   * @param {number} [fromSlot=-1] 源槽位索引（来自槽位拖拽时传入，-1 表示来自列表）
   */
  async equipSkillToSlot(itemId, targetSlot, fromSlot = -1) {
    const item = this.items.get(itemId);
    if (!item || item.type !== "skill" || item.system.type !== "basic") return;

    const slots = [...(this.system.skills.basic ?? [null, null, null, null, null, null])];

    // ── 槽位间移动（来自另一个基础技能槽） ─────────────────────────────
    if (fromSlot >= 0 && fromSlot <= 5) {
      if (fromSlot === targetSlot) return;
      const displaced = slots[targetSlot] ?? null;  // 目标槽原有技能
      slots[targetSlot] = itemId;
      slots[fromSlot]   = displaced;                // 交换（为 null 即清空）
      return this.update({ "system.skills.basic": slots });
    }

    // ── 来自技能列表 ────────────────────────────────────────────────────
    // 已在某个槽位则拒绝重复装备
    if (slots.includes(itemId)) {
      ui.notifications.warn("该技能已装备在技能栏中，请直接拖动技能槽进行移位。");
      return;
    }

    // 星芒检查
    const { canEquip, cost, current, max } = this.checkStellarCost(item);
    if (!canEquip) {
      ui.notifications.warn(game.i18n.format("LIMBUSCOMPANY.Warning.NotEnoughStellar", { cost, current, max }));
      return;
    }

    // 目标槽已有技能则先卸下（退还星芒）
    const prevId = slots[targetSlot];
    if (prevId) await this.unequipSkill(prevId);

    // 重新读取（unequipSkill 会触发 update）
    const refreshed = [...(this.system.skills.basic ?? [null, null, null, null, null, null])];
    refreshed[targetSlot] = itemId;
    await this.spendStellarMotes(cost);
    return this.update({ "system.skills.basic": refreshed });
  }

  /**
   * 卸下技能（通过物品 ID 查找并清除对应槽位）
   * @param {string} itemId
   */
  async unequipSkill(itemId) {
    const item = this.items.get(itemId);
    if (!item) return;
    const cost = item.getStellarCost?.() ?? 0;

    const skillType = item.system.type;
    if (skillType === "defense" && this.system.skills.defense === itemId) {
      await this.gainStellarMotes(cost);
      return this.update({ "system.skills.defense": null });
    }

    if (skillType === "ego") {
      const grade = item.system.egoDiceRating;
      if (grade && this.system.skills.ego[grade] === itemId) {
        await this.gainStellarMotes(cost);
        return this.update({ [`system.skills.ego.${grade}`]: null });
      }
    }

    if (skillType === "basic") {
      const slots = [...(this.system.skills.basic ?? [])];
      const idx   = slots.indexOf(itemId);
      if (idx !== -1) {
        slots[idx] = null;
        await this.gainStellarMotes(cost);
        return this.update({ "system.skills.basic": slots });
      }
    }
  }

  // ─── 升级系统 ──────────────────────────────────────────────────────────

  /**
   * 添加经验值，自动处理升级（含多级连升）。
   * 每 10 级 +1 属性点。每升 1 级 +1 星芒上限。
   * @param {number} amount
   */
  async addXP(amount) {
    const curr = this.system.xp.value ?? 0;
    const next = Math.max(0, curr + Number(amount || 0));
    return this.update({ "system.xp.value": next });
  }

  /**
   * 手动升级：当经验值大于当前升级阈值时可触发。
   * 升级后：等级+1，经验清零，星芒上限更新，按规则掷 1D10 增加最大生命值。
   */
  async levelUpByXp() {
    const xpTable = CONFIG.LIMBUSCOMPANY?.LEVEL_XP ?? [];
    const sys = this.system;
    const currentLevel = sys.level;
    const needed = xpTable[currentLevel] ?? null;
    const currentXp = sys.xp.value ?? 0;

    if (needed === null || currentXp <= needed) {
      ui.notifications?.warn?.("经验值未超过升级阈值，无法升级。");
      return;
    }

    const nextLevel = currentLevel + 1;
    const hpGainRoll = await this._rollHpGainForLevel(nextLevel);
    const currRollTotal = sys.hp.rollTotal ?? Math.max(1, (sys.hp.max ?? 10) - ((sys.attributes?.con ?? 0) * 5));
    const nextRollTotal = currRollTotal + hpGainRoll;
    const con = sys.attributes?.con ?? 0;
    const nextHPMax = (con * 5) + nextRollTotal;
    const nextHPValue = Math.min(Math.max(sys.hp.value ?? 0, 0), nextHPMax);
    const nextStellarMax = 30 + nextLevel;
    const nextAttrPoints = (nextLevel % 10 === 0) ? ((sys.attrPoints ?? 0) + 1) : (sys.attrPoints ?? 0);

    return this.update({
      "system.level":             nextLevel,
      "system.xp.value":          0,
      "system.attrPoints":        nextAttrPoints,
      "system.stellarMotes.max":  nextStellarMax,
      "system.hp.rollTotal":      nextRollTotal,
      "system.hp.max":            nextHPMax,
      "system.hp.value":          nextHPValue,
    });

    await Dialog.wait({
      title: `升级到 Lv ${level}`,
      content: `<div class="limbuscompany"><p>生命值成长掷骰结果：<strong>${gain}</strong>（1D10）</p><p>点击确认继续。</p></div>`,
      buttons: {
        ok: { label: "确认" },
      },
      default: "ok",
      close: () => gain,
    });

    return gain;
  }

  async _rollHpGainForLevel(level) {
    const roll = await (new Roll("1d10")).evaluate();
    const gain = roll.total ?? 1;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      content: `<div class="limbuscompany-card"><div class="card-title">升级生命值</div><div class="card-body">Lv ${level}：1D10 = <strong>${gain}</strong></div></div>`,
      rolls: [roll],
      type: CONST.CHAT_MESSAGE_STYLES.ROLL,
    });

    await Dialog.wait({
      title: `升级到 Lv ${level}`,
      content: `<div class="limbuscompany"><p>生命值成长掷骰结果：<strong>${gain}</strong>（1D10）</p><p>点击确认继续。</p></div>`,
      buttons: {
        ok: { label: "确认" },
      },
      default: "ok",
      close: () => gain,
    });

    return gain;
  }

  // ─── 长休 ──────────────────────────────────────────────────────────────

  /**
   * 执行长休：恢复 HP / 理智 / AP，重置混乱阈值。
   * 无确认对话框，直接执行。
   */
  async longRest() {
    const sys              = this.system;
    const defaultThresholds = sys.getDefaultChaosThresholds?.() ?? [
      { percent: 60, triggered: false },
      { percent: 30, triggered: false },
    ];

    return this.update({
      "system.hp.value":            sys.hp.max,
      "system.sanity.value":        50,
      "system.ap.value":            3,
      "system.chaosThresholds":     defaultThresholds,
    });
  }

  // ─── 混乱阈值触发检查（每次 HP 变动时调用） ──────────────────────────────

  /**
   * 检查并处理混乱阈值触发（单次触发逻辑）。
   * 仅在 HP 减少时调用，HP 回升不触发。
   * @param {number} newHP
   * @param {number} oldHP
   * @param {object} [opts]
   * @param {boolean} [opts.silent=false] 为 true 时跳过聊天框（调用方自行在消息中显示混乱信息）
   */
  async checkAndTriggerChaos(newHP, oldHP, { silent = false } = {}) {
    if (newHP >= oldHP) return; // HP 没有减少则不检查

    const sys        = this.system;
    const maxHP      = sys.hp.max;
    const thresholds = [...sys.chaosThresholds];
    let triggered    = false;
    let burnedIdx    = -1;

    for (let i = 0; i < thresholds.length; i++) {
      const t = thresholds[i];
      if (!t.triggered && newHP <= maxHP * t.percent / 100) {
        burnedIdx = i;
        triggered = true;
        break; // 每次只触发一条
      }
    }

    if (!triggered) return;

    thresholds[burnedIdx] = { ...thresholds[burnedIdx], triggered: true };

    // 将混乱阈值烧断、物理抗性 ×2.0、AP 清零、添加 BUFF 合并为单次 update，
    // 避免多次 update 连发触发 Foundry 竞态（renderChatMessage / deleteDocuments 报错）
    const newBuffs = [...(this.system.buffs ?? [])];
    newBuffs.push({
      id:        foundry.utils.randomID(),
      type:      "chaos",
      name:      "陷入混乱",
      icon:      "",
      intensity: 0,
      stacks:    1,
      whenAdded: "本回合",
    });

    await this.update({
      "system.chaosThresholds": thresholds,
      "system.ap.value":        0,
      "system.buffs":           newBuffs,
    });

    // silent=true 时调用方（_applyAndSendTake）已在取血消息中展示混乱触发信息，无需再创建独立消息，
    // 避免两次 ChatMessage.create() 触发 Foundry 自动清理同一条旧消息导致"does not exist"报错
    if (!silent) {
      await ChatMessage.create({
        content: `<div class="limbuscompany chat-clash"><strong>${this.name}</strong> 混乱阈值被触发（${thresholds[burnedIdx].percent}%）——【陷入混乱】！</div>`,
      });
    }
  }

  // ─── BUFF 管理 ─────────────────────────────────────────────────────────

  /**
   * 添加 BUFF
   * @param {{ type: string, name: string, intensity: number, stacks: number, whenAdded: string, icon?: string }} buffData
   */
  async addBuff(buffData) {
    const buffs = [...(this.system.buffs ?? [])];
    buffs.push({
      id:        foundry.utils.randomID(),
      type:      buffData.type ?? "custom",
      name:      buffData.name ?? "自定义",
      icon:      buffData.icon ?? "",
      intensity: buffData.intensity ?? 1,
      stacks:    buffData.stacks ?? 1,
      whenAdded: buffData.whenAdded ?? "本回合",
    });
    return this.update({ "system.buffs": buffs });
  }

  /**
   * 移除 BUFF（按 ID）
   * @param {string} buffId
   */
  async removeBuff(buffId) {
    const buffs = (this.system.buffs ?? []).filter(b => b.id !== buffId);
    return this.update({ "system.buffs": buffs });
  }

  /**
   * 移除所有指定类型的 BUFF
   * @param {string} type
   */
  async removeBuffsByType(type) {
    const buffs = (this.system.buffs ?? []).filter(b => b.type !== type);
    return this.update({ "system.buffs": buffs });
  }

  /**
   * 减少指定类型 BUFF 的层数，层数归零时自动移除。
   * @param {string} type   BUFF type 键
   * @param {number} amount 减少量，默认 1
   */
  async reduceBuffStacks(type, amount = 1) {
    const buffs = [...(this.system.buffs ?? [])];
    const idx   = buffs.findIndex(b => b.type === type);
    if (idx === -1) return;
    const next = Math.max(0, (buffs[idx].stacks ?? 1) - amount);
    if (next <= 0) buffs.splice(idx, 1);
    else           buffs[idx] = { ...buffs[idx], stacks: next };
    return this.update({ "system.buffs": buffs });
  }

  // ─── 震颤引爆 ──────────────────────────────────────────────────────────

  /**
   * 触发震颤引爆：所有混乱阈值前移 N%
   * @param {number} intensity 震颤强度
   */
  async triggerSeismicBlast(intensity) {
    const thresholds = this.system.applySeismicBlast?.(intensity)
      ?? this.system.chaosThresholds.map(t => ({
        percent:   Math.min(100, t.percent + intensity),
        triggered: t.triggered,
      }));
    return this.update({ "system.chaosThresholds": thresholds });
  }

  // ─── 理智检查（恐慌状态） ──────────────────────────────────────────────

  /**
   * 设置理智值并检查恐慌状态（≤5 触发恐慌）
   * @param {number} value
   */
  async setSanity(value) {
    const clamped = Math.min(95, Math.max(5, value));
    await this.update({ "system.sanity.value": clamped });

    if (clamped <= 5 && !this.system.isInPanic) {
      // 触发恐慌：清空行动点，EGO 相关技能切换为侵蚀形态
      await this.update({ "system.ap.value": 0 });
      await this.addBuff({ type: "panic", name: "陷入恐慌", intensity: 1, stacks: 1, whenAdded: "本回合" });
      await ChatMessage.create({
        content: `<div class="limbuscompany chat-clash"><strong>${this.name}</strong> 理智跌至 ${clamped}——【陷入恐慌】！</div>`,
      });
    }
  }

  // ─── 辅助：获取已装备物品（从 actor.items） ────────────────────────────

  /** 获取九宫格已装备物品列表（含槽位信息） */
  get equippedGridItems() {
    const result = [];
    for (let i = 0; i < 9; i++) {
      const id   = this.system.equipment[`slot${i}`];
      const item = id ? this.items.get(id) : null;
      result.push({ slotIndex: i, item });
    }
    return result;
  }

  /** 获取已装备的基础技能列表 */
  get equippedBasicSkills() {
    return (this.system.skills.basic ?? []).map(id => (id ? this.items.get(id) : null));
  }

  /** 获取已装备的守备技能 */
  get equippedDefenseSkill() {
    const id = this.system.skills.defense;
    return id ? this.items.get(id) : null;
  }

  /** 获取已装备的 EGO 技能（对象，键为 grade） */
  get equippedEgoSkills() {
    const result = {};
    for (const grade of ["ZAYIN", "TET", "HE", "WAW", "ALEPH"]) {
      const id   = this.system.skills.ego?.[grade];
      result[grade] = id ? this.items.get(id) : null;
    }
    return result;
  }
}
