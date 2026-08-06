/**
 * item.mjs — 边狱巴士都市规则 Item 文档类
 *
 * 包含：
 *   - EquipmentData  : 装备数据模型
 *   - SkillData      : 技能数据模型（基础 / 守备 / EGO）
 *   - ConsumableData : 消耗品数据模型
 *   - MaterialData   : 材料数据模型
 *   - ContainerData  : 容器数据模型
 *   - LimbusItem     : Item 文档类（封装游戏逻辑）
 */

// ─── 公共子模式（多处复用） ──────────────────────────────────────────────────

/**
 * 效果触发（Activity）条目模式
 * 用于 equipment / skill / consumable
 */
function makeActivitySchema() {
  const fields = foundry.data.fields;
  return new fields.SchemaField({
    id:           new fields.StringField({ required: true, initial: () => foundry.utils.randomID() }),
    name:         new fields.StringField({ required: true, initial: "新效果" }),
    trigger:      new fields.StringField({ required: true, initial: "攻击时" }),
    preconditions: new fields.ArrayField(new fields.ObjectField(), { required: true, initial: [] }),
    costs:         new fields.ArrayField(new fields.ObjectField(), { required: true, initial: [] }),
    effects:       new fields.ArrayField(new fields.ObjectField(), { required: true, initial: [] }),
    limit: new fields.SchemaField({
      type:  new fields.StringField({ required: true, initial: "unlimited" }),
      count: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  EquipmentData — 装备数据模型
// ═══════════════════════════════════════════════════════════════════════════

export class EquipmentData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;
    return {
      // 子类型：上装 / 下装 / 武器 / 饰品
      subtype:  new fields.StringField({ required: true, initial: "weapon",
        choices: ["upper", "lower", "weapon", "accessory"] }),

      // 具体分类（如：匕首、盔甲、戒指……用户自定义文本）
      category: new fields.StringField({ required: false, initial: "" }),

      // 数量
      quantity: new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),

      // 物理抗性修正（上装专用，格式如 "x2.0"，其他子类型留空）
      resistanceAdj: new fields.SchemaField({
        slash:  new fields.StringField({ required: false, initial: "" }),
        blunt:  new fields.StringField({ required: false, initial: "" }),
        pierce: new fields.StringField({ required: false, initial: "" }),
      }),

      // 攻/防/速度修正值
      atkAdj:   new fields.NumberField({ required: true, integer: true, initial: 0 }),
      defAdj:   new fields.NumberField({ required: true, integer: true, initial: 0 }),
      speedAdj: new fields.NumberField({ required: true, integer: true, initial: 0 }),

      // 星芒费用
      stellarCost: new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),

      // 标签（用 "/" 分隔的字符串数组，存储为数组）
      tags: new fields.ArrayField(
        new fields.StringField({ required: true }),
        { required: true, initial: [] }
      ),

      // 效果描述（富文本）
      effect: new fields.HTMLField({ required: false, initial: "" }),

      // 效果触发列表（Activity）
      activities: new fields.ArrayField(makeActivitySchema(), { required: true, initial: [] }),

      // 是否已激活（武器/饰品有多件时的激活状态）
      isActive: new fields.BooleanField({ required: true, initial: false }),

      // 收藏
      favorited: new fields.BooleanField({ required: true, initial: false }),

      // 物品容量（占用角色背包格数，默认 1×1）
      capacity: new fields.SchemaField({
        w: new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 1 }),
        h: new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 1 }),
      }),

      // 眼价格（供 Item Piles 商人/市场使用）
      cost: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),

      // ── 商人货架字段 ────────────────────────────────────────────────────
      // price：商人售卖单价（眼）
      price:  new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      // stock：库存数量，-1 = 无限，0 = 售罄，N = 剩余 N 件
      stock:  new fields.NumberField({ required: true, integer: true, min: -1, initial: -1 }),
      // hidden：是否对玩家隐藏（GM可见，玩家不可见）
      hidden: new fields.BooleanField({ required: true, initial: false }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SkillData — 技能数据模型（基础 / 守备 / EGO）
// ═══════════════════════════════════════════════════════════════════════════

export class SkillData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;

    // 相关技能结构（v2：技能池，替代旧版单一 itemUuid + 冗余 trigger 字段。
    // 触发改由④效果「相关技能转换」自身的 Activity trigger 决定，不再需要独立 trigger 字段）
    const relatedSkillSchema = new fields.SchemaField({
      // 相关技能池：可挂载多个技能 UUID，配合"相关技能转换"效果随机/指定切换
      pool: new fields.ArrayField(
        new fields.SchemaField({
          itemUuid: new fields.StringField({ required: false, nullable: true, initial: null }),
        }),
        { required: true, initial: [] }
      ),
      // EGO 技能：恐慌时替换为侵蚀形态 UUID（脱离恐慌后恢复，与技能池无关，独立机制）
      erodeUuid: new fields.StringField({ required: false, nullable: true, initial: null }),
    });

    // EGO 罪孽消耗条目
    const sinCostEntrySchema = new fields.SchemaField({
      sinType: new fields.StringField({ required: true, initial: "wrath",
        choices: ["wrath", "lust", "sloth", "gluttony", "gloom", "pride", "envy"] }),
      amount:  new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
    });

    // EGO 罪孽抗性修正条目
    const egoResistAdjSchema = new fields.SchemaField({
      sinType:    new fields.StringField({ required: true, initial: "wrath" }),
      multiplier: new fields.StringField({ required: true, initial: "x1.0" }),
    });

    return {
      // 技能类型：basic / defense / ego
      type: new fields.StringField({ required: true, initial: "basic",
        choices: ["basic", "defense", "ego"] }),

      // 等级（基础/守备技能：1/2/3；EGO 不使用此字段，由 egoDiceRating 决定）
      level: new fields.NumberField({ required: true, integer: true, min: 1, max: 3, initial: 1 }),

      // 攻击 / 守备分类
      // 基础/EGO：slash / blunt / pierce
      // 守备：dodge / block / counter / clashBlock / clashCounter
      category: new fields.StringField({ required: true, initial: "slash" }),

      // 反击伤害类型（仅守备技能 category=counter/clashCounter 有效）
      counterType: new fields.StringField({ required: false, initial: "slash",
        choices: ["slash", "blunt", "pierce"] }),

      // 罪孽属性（决定图标和边框颜色）
      sinType: new fields.StringField({ required: true, initial: "wrath",
        choices: ["wrath", "lust", "sloth", "gluttony", "gloom", "pride", "envy"] }),

      // EGO 等级评级（仅 EGO 技能）
      egoDiceRating: new fields.StringField({ required: false, nullable: true, initial: null,
        choices: [null, "ZAYIN", "TET", "HE", "WAW", "ALEPH"] }),

      // EGO 罪孽抗性修正（使用后生效）
      egoResistanceAdj: new fields.ArrayField(egoResistAdjSchema, { required: true, initial: [] }),

      // 加重值（守备技能无此字段，设为 0）
      weight: new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),

      // 骰子类型：normal / unbreakable / severing
      diceType: new fields.StringField({ required: true, initial: "normal",
        choices: ["normal", "unbreakable", "severing"] }),

      // 骰子公式（基础值 + 变动骰数）
      baseValue:  new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      diceCount:  new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      diceFaces:  new fields.NumberField({ required: true, integer: true, min: 1, initial: 4 }),
      // diceFormula：便捷显示字符串，如 "2d4+3"（由 prepareDerivedData 生成）
      diceFormula: new fields.StringField({ required: false, initial: "1d4" }),

      // 相关技能（可选，不占用6-bag槽）
      relatedSkill: relatedSkillSchema,

      // 星芒费用（按等级自动推算，可手动覆盖）
      stellarCost: new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),

      // 武器限制（填写武器分类名，空字符串=无限制）
      weaponRestriction: new fields.StringField({ required: false, initial: "" }),

      // 标签
      tags: new fields.ArrayField(
        new fields.StringField({ required: true }),
        { required: true, initial: [] }
      ),

      // 效果描述（富文本）
      effectDesc: new fields.HTMLField({ required: false, initial: "" }),

      // EGO 罪孽消耗（多种罪孽资源）
      sinCost: new fields.ArrayField(sinCostEntrySchema, { required: true, initial: [] }),

      // EGO 理智消耗
      sanityCost: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),

      // 效果触发列表（Activity）
      activities: new fields.ArrayField(makeActivitySchema(), { required: true, initial: [] }),

      // 收藏
      favorited: new fields.BooleanField({ required: true, initial: false }),

      // ── 商人货架字段 ────────────────────────────────────────────────────
      price:  new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      stock:  new fields.NumberField({ required: true, integer: true, min: -1, initial: -1 }),
      hidden: new fields.BooleanField({ required: true, initial: false }),
    };
  }

  /** @override 生成 diceFormula 显示字符串 */
  prepareDerivedData() {
    const { diceCount, diceFaces, baseValue } = this;
    let formula = `${diceCount}d${diceFaces}`;
    if (baseValue > 0) formula += `+${baseValue}`;
    this.diceFormula = formula;

    // 若 EGO 技能且 stellarCost 未手动修改，则按 egoDiceRating 自动推算
    if (this.type === "ego" && this.egoDiceRating) {
      const egoCosts = CONFIG.LIMBUSCOMPANY?.EGO_COSTS ?? {};
      if (!this._stellarCostOverridden) {
        this.stellarCost = egoCosts[this.egoDiceRating] ?? this.stellarCost;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ConsumableData — 消耗品数据模型
// ═══════════════════════════════════════════════════════════════════════════

export class ConsumableData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;
    return {
      category: new fields.StringField({ required: false, initial: "" }),
      typeName: new fields.StringField({ required: false, initial: "" }),
      quantity: new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      reusable: new fields.BooleanField({ required: true, initial: false }),
      infinite: new fields.BooleanField({ required: true, initial: false }),
      tags:     new fields.StringField({ required: false, initial: "" }),
      effect:   new fields.HTMLField({ required: false, initial: "" }),
      // 激活效果触发列表
      activities: new fields.ArrayField(makeActivitySchema(), { required: true, initial: [] }),
      favorited:  new fields.BooleanField({ required: true, initial: false }),
      // 物品容量
      capacity: new fields.SchemaField({
        w: new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 1 }),
        h: new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 1 }),
      }),

      // 眼价格（供 Item Piles 商人/市场使用）
      cost: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),

      // ── 商人货架字段 ────────────────────────────────────────────────────
      price:  new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      stock:  new fields.NumberField({ required: true, integer: true, min: -1, initial: -1 }),
      hidden: new fields.BooleanField({ required: true, initial: false }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MaterialData — 材料数据模型
// ═══════════════════════════════════════════════════════════════════════════

export class MaterialData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;
    return {
      category:    new fields.StringField({ required: false, initial: "" }),
      typeName:    new fields.StringField({ required: false, initial: "" }),
      effect:      new fields.HTMLField({ required: false, initial: "" }),
      tags:        new fields.StringField({ required: false, initial: "" }),
      reusable:    new fields.BooleanField({ required: true, initial: false }),
      infinite:    new fields.BooleanField({ required: true, initial: false }),
      quantity:    new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      favorited:   new fields.BooleanField({ required: true, initial: false }),
      // 物品容量
      capacity: new fields.SchemaField({
        w: new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 1 }),
        h: new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 1 }),
      }),

      // 眼价格（供 Item Piles 商人/市场使用）
      cost: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),

      // ── 商人货架字段 ────────────────────────────────────────────────────
      price:  new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      stock:  new fields.NumberField({ required: true, integer: true, min: -1, initial: -1 }),
      hidden: new fields.BooleanField({ required: true, initial: false }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ContainerData — 容器数据模型
// ═══════════════════════════════════════════════════════════════════════════

export class ContainerData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;
    return {
      // 网格尺寸
      gridSize: new fields.SchemaField({
        width:  new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 3 }),
        height: new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 3 }),
      }),
      // 内容物：放置记录 { uuid, x, y, w, h, rotated, itemData? }
      // uuid 用于 Actor 内嵌容器；itemData 用于世界金库（物品完整数据，无需 UUID）
      contents: new fields.ArrayField(
        new fields.SchemaField({
          uuid:     new fields.StringField({ required: true, initial: "" }),
          x:        new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
          y:        new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
          w:        new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
          h:        new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
          rotated:  new fields.BooleanField({ initial: false }),
          itemData: new fields.ObjectField({ required: false, nullable: true, initial: null }),
        }),
        { required: true, initial: [] }
      ),
      favorited: new fields.BooleanField({ required: true, initial: false }),
      // 物品容量（容器本身占用角色背包格数，与内部 gridSize 无关）
      capacity: new fields.SchemaField({
        w: new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 1 }),
        h: new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 1 }),
      }),

      // 眼价格（供 Item Piles 商人/市场使用）
      cost: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),

      // ── 商人货架字段 ────────────────────────────────────────────────────
      price:  new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      stock:  new fields.NumberField({ required: true, integer: true, min: -1, initial: -1 }),
      hidden: new fields.BooleanField({ required: true, initial: false }),

      // 锁定格：禁止放置物品的格子坐标列表
      lockedCells: new fields.ArrayField(
        new fields.SchemaField({
          x: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
          y: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        }),
        { required: true, initial: [] }
      ),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SkillBookData — 技能书数据模型
// ═══════════════════════════════════════════════════════════════════════════

export const SKILLBOOK_MAX_SLOTS = 16;

export class SkillBookData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;
    return {
      category: new fields.StringField({ required: false, initial: "" }),

      // 存放的技能：{ uuid, itemData? }（uuid 用于 Actor 内嵌技能；itemData 用于世界金库存储）
      skills: new fields.ArrayField(
        new fields.SchemaField({
          uuid:     new fields.StringField({ required: true, initial: "" }),
          itemData: new fields.ObjectField({ required: false, nullable: true, initial: null }),
        }),
        { required: true, initial: [] }
      ),

      tags: new fields.ArrayField(
        new fields.StringField({ required: true }),
        { required: true, initial: [] }
      ),

      favorited: new fields.BooleanField({ required: true, initial: false }),

      // 物品容量（技能书本身占用角色背包格数）
      capacity: new fields.SchemaField({
        w: new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 1 }),
        h: new fields.NumberField({ required: true, integer: true, min: 1, max: 10, initial: 1 }),
      }),

      // 眼价格（供 Item Piles 商人/市场使用）
      cost: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),

      // ── 商人货架字段 ────────────────────────────────────────────────────
      price:  new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      stock:  new fields.NumberField({ required: true, integer: true, min: -1, initial: -1 }),
      hidden: new fields.BooleanField({ required: true, initial: false }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PanicData — 恐慌卡数据模型（士气低落/陷入恐慌的可更换效果配置）
// ═══════════════════════════════════════════════════════════════════════════

export class PanicData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;
    return {
      // 描述（显示在恐慌卡上）
      description: new fields.HTMLField({ required: false, initial: "" }),
      tags:        new fields.StringField({ required: false, initial: "" }),
      // 效果触发器（使用触发时机「恐慌触发时」，槽位决定何时触发）
      activities:  new fields.ArrayField(makeActivitySchema(), { required: true, initial: [] }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BackgroundData — 背景物品数据模型
//  （角色创建向导用：背景名称/简介 + 初始物品 + 按等级解锁的升级奖励物品）
// ═══════════════════════════════════════════════════════════════════════════

/** 物品引用条目：uuid 用于世界/合集包物品；itemData 为完整数据快照（拖入时缓存，防止源物品被删除后失效） */
function makeItemRefSchema() {
  const fields = foundry.data.fields;
  return new fields.SchemaField({
    id:       new fields.StringField({ required: true, initial: () => foundry.utils.randomID() }),
    uuid:     new fields.StringField({ required: true, initial: "" }),
    itemData: new fields.ObjectField({ required: false, nullable: true, initial: null }),
  });
}

export class BackgroundData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;

    // 等级奖励条目：达到某等级时解锁的物品列表
    const levelRewardSchema = new fields.SchemaField({
      id:    new fields.StringField({ required: true, initial: () => foundry.utils.randomID() }),
      level: new fields.NumberField({ required: true, integer: true, min: 1, initial: 5 }),
      items: new fields.ArrayField(makeItemRefSchema(), { required: true, initial: [] }),
    });

    return {
      // 副标题（显示在背景名称下方，如"收尾人"）
      subtitle: new fields.StringField({ required: false, initial: "" }),

      // 简介（富文本，支持图文）
      description: new fields.HTMLField({ required: false, initial: "" }),

      // 初始物品：创建角色时立即获得
      startingItems: new fields.ArrayField(makeItemRefSchema(), { required: true, initial: [] }),

      // 升级奖励：按等级解锁
      levelRewards: new fields.ArrayField(levelRewardSchema, { required: true, initial: [] }),

      // 合集包浏览器分类标签（如"事务所"/"协会"/"世界之翼"），供背景选择向导筛选
      category: new fields.StringField({ required: false, initial: "" }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  LimbusItem — Item 文档类
// ═══════════════════════════════════════════════════════════════════════════

export class LimbusItem extends Item {

  /** @override */
  prepareData() {
    super.prepareData();
  }

  /** @override */
  prepareDerivedData() {
    super.prepareDerivedData();
    if (this.type === "skill")  this._prepareSkillData();
    if (this.type === "equipment") this._prepareEquipmentData();
  }

  // ─── 技能派生数据 ──────────────────────────────────────────────────────

  _prepareSkillData() {
    const sys = this.system;
    // 确保骰子公式字符串已生成（TypeDataModel.prepareDerivedData 可能已处理）
    if (!sys.diceFormula) {
      const { diceCount, diceFaces, baseValue } = sys;
      let formula = `${diceCount}d${diceFaces}`;
      if (baseValue > 0) formula += `+${baseValue}`;
      sys.diceFormula = formula;
    }
  }

  // ─── 装备派生数据 ──────────────────────────────────────────────────────

  _prepareEquipmentData() {
    // 暂无额外派生计算，占位供后续扩展
  }

  // ─── 星芒费用 ──────────────────────────────────────────────────────────

  /**
   * 返回该物品的星芒消耗量
   * @returns {number}
   */
  getStellarCost() {
    if (this.type === "skill") {
      const sys = this.system;
      if (sys.type === "ego" && sys.egoDiceRating) {
        return CONFIG.LIMBUSCOMPANY?.EGO_COSTS?.[sys.egoDiceRating] ?? sys.stellarCost;
      }
      // 基础/守备技能按等级
      return CONFIG.LIMBUSCOMPANY?.SKILL_COSTS?.[sys.level] ?? sys.stellarCost;
    }
    if (this.type === "equipment") {
      return this.system.stellarCost ?? 0;
    }
    return 0;
  }

  // ─── 骰子公式 ──────────────────────────────────────────────────────────

  /**
   * 返回技能的骰子公式字符串，如 "2d4+3"
   * @returns {string}
   */
  getDiceFormula() {
    if (this.type !== "skill") return "";
    const { diceCount, diceFaces, baseValue } = this.system;
    let formula = `${diceCount}d${diceFaces}`;
    if (baseValue > 0) formula += `+${baseValue}`;
    return formula;
  }

  /**
   * 投骰子（使用 Foundry Roll API）
   * @returns {Promise<Roll>}
   */
  async rollDice() {
    if (this.type !== "skill") return null;
    const formula = this.getDiceFormula();
    const roll    = new Roll(formula);
    await roll.evaluate();
    return roll;
  }

  // ─── 相关技能解析 ──────────────────────────────────────────────────────

  /**
   * 获取相关技能池中所有已配置的 Item 实例（按池内顺序，跳过解析失败的条目）。
   * @returns {Promise<LimbusItem[]>}
   */
  async getRelatedSkillPool() {
    if (this.type !== "skill") return [];
    const pool = this.system.relatedSkill?.pool ?? [];
    const items = await Promise.all(
      pool.map(p => (p?.itemUuid ? fromUuid(p.itemUuid).catch(() => null) : null))
    );
    return items.filter(Boolean);
  }

  /**
   * 获取侵蚀形态技能 Item 实例（EGO 专用，恐慌时使用）
   * @returns {Promise<LimbusItem|null>}
   */
  async getErodeSkillItem() {
    if (this.type !== "skill" || this.system.type !== "ego") return null;
    const uuid = this.system.relatedSkill?.erodeUuid;
    if (!uuid) return null;
    return fromUuid(uuid).catch(() => null);
  }

  // ─── Activity（效果触发）管理 ──────────────────────────────────────────

  /**
   * 添加效果触发条目
   * @param {object} activityData
   */
  async addActivity(activityData) {
    const activities = [...(this.system.activities ?? [])];
    activities.push({
      id:           foundry.utils.randomID(),
      name:         activityData.name    ?? "新效果",
      trigger:      activityData.trigger ?? "攻击时",
      precondition: activityData.precondition ?? null,
      cost:         activityData.cost    ?? null,
      effect:       activityData.effect  ?? { type: "addBuff", target: "self", intensity: 1, stacks: 1 },
      limit:        activityData.limit   ?? { type: "unlimited", count: 1 },
    });
    return this.update({ "system.activities": activities });
  }

  /**
   * 删除效果触发条目
   * @param {string} activityId
   */
  async removeActivity(activityId) {
    const activities = (this.system.activities ?? []).filter(a => a.id !== activityId);
    return this.update({ "system.activities": activities });
  }

  /**
   * 更新效果触发条目
   * @param {string} activityId
   * @param {object} updates
   */
  async updateActivity(activityId, updates) {
    const activities = (this.system.activities ?? []).map(a =>
      a.id === activityId ? foundry.utils.mergeObject(a, updates, { inplace: false }) : a
    );
    return this.update({ "system.activities": activities });
  }

  // ─── 收藏切换 ──────────────────────────────────────────────────────────

  async toggleFavorite() {
    return this.update({ "system.favorited": !this.system.favorited });
  }

  // ─── 发送到聊天框 ──────────────────────────────────────────────────────

  /**
   * 将物品信息发送到聊天框
   */
  async sendToChat() {
    const sys  = this.system;
    const actor = this.actor;

    // ── 头像 & 玩家名 ──────────────────────────────────────────────────
    const actorImg   = actor?.img ?? "icons/svg/mystery-man.svg";
    const actorName  = actor?.name ?? this.name;
    const ownerUser  = actor
      ? game.users?.find(u => !u.isGM && u.character?.id === actor.id)
      : null;
    const playerName = ownerUser?.name ?? game.user?.name ?? actorName;

    // ── 分割线 ─────────────────────────────────────────────────────────
    const divider = `<div class="ic-gold-divider"></div>`;

    // ── 技能 meta（类型图标 + 骰数）──────────────────────────────────
    let metaHtml = "";
    if (this.type === "skill") {
      const iconPaths = CONFIG.LIMBUSCOMPANY?.CATEGORY_ICON_PATHS ?? {};
      const catIcon   = iconPaths[sys.category] ?? "";
      const formula   = this.getDiceFormula();
      const catImgTag = catIcon
        ? `<img class="ic-cat-icon" src="${catIcon}" alt="${sys.category}" width="16" height="16">`
        : "";
      metaHtml = `<div class="ic-item-meta skill-meta">${catImgTag}<span class="ic-dice">${formula}</span></div>`;
    } else {
      // 物品类：type label + category
      const typeLabels = { equipment:"装备", consumable:"消耗品", material:"材料", container:"容器", skillbook:"技能书", panic:"恐慌", background:"背景" };
      const typeLabel  = typeLabels[this.type] ?? this.type;
      const catLabel   = sys.category ? ` · ${sys.category}` : "";
      metaHtml = `<div class="ic-item-meta">${typeLabel}${catLabel}</div>`;
    }

    // ── 描述文本 ───────────────────────────────────────────────────────
    const descHtml = (() => {
      const raw =
        (this.type === "skill"      ? sys.effectDesc : null) ??
        (this.type === "equipment"  ? sys.effect     : null) ??
        (this.type === "consumable" ? sys.effect : null) ??
        (this.type === "material"   ? sys.effect : null) ??
        (this.type === "background" ? sys.description : null) ??
        "";
      if (!raw) return "";
      return `<div class="ic-desc">${raw}</div>`;
    })();

    const content = `
      <div class="limbus-item-chat-card">
        <div class="ic-header">
          <img class="ic-actor-avatar" src="${actorImg}" alt="${actorName}">
          <div class="ic-actor-info">
            <div class="ic-title">发送聊天框</div>
            <div class="ic-player">${playerName}</div>
          </div>
        </div>
        ${divider}
        <div class="ic-item-row">
          <img class="ic-item-icon" src="${this.img}" alt="${this.name}">
          <div class="ic-item-info">
            <div class="ic-item-name">${this.name}</div>
            ${metaHtml}
          </div>
        </div>
        ${descHtml}
        ${divider}
      </div>`;

    return ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor }),
    });
  }

  // ─── 技能书：学习全部技能 ──────────────────────────────────────────────

  /**
   * 将技能书中存放的所有技能加入所属角色的技能列表，并删除该技能书。
   * 仅当技能书归属于某个角色（this.actor）时可调用。
   * @returns {Promise<void>}
   */
  async learnAllSkills() {
    if (this.type !== "skillbook") return;
    const actor = this.actor;
    if (!actor) { ui.notifications?.warn("技能书不属于任何角色，无法学习。"); return; }

    const entries = this.system.skills ?? [];
    if (!entries.length) { ui.notifications?.warn("技能书是空的。"); return; }

    const newSkillData = [];
    for (const entry of entries) {
      if (entry.uuid) {
        const skillItem = await fromUuid(entry.uuid).catch(() => null);
        if (!skillItem) continue;
        const data = skillItem.toObject();
        delete data._id;
        newSkillData.push(data);
      } else if (entry.itemData) {
        const data = foundry.utils.deepClone(entry.itemData);
        delete data._id;
        newSkillData.push(data);
      }
    }

    if (newSkillData.length) {
      await actor.createEmbeddedDocuments("Item", newSkillData);
    }
    await this.delete();
  }

  // ─── 辅助：判断此技能是否为侵蚀形态 ──────────────────────────────────

  get isErodeForm() {
    // 约定：若技能名称包含"侵蚀"或被其他技能的 erodeUuid 引用，则视为侵蚀形态
    // 实际关系由 erodeUuid 引用确定，这里只做名称简单标记
    return this.name?.includes("侵蚀") ?? false;
  }

}
