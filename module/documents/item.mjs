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

      // 链接方向（四方向箭头）
      links: new fields.SchemaField({
        up:    new fields.BooleanField({ required: true, initial: false }),
        down:  new fields.BooleanField({ required: true, initial: false }),
        left:  new fields.BooleanField({ required: true, initial: false }),
        right: new fields.BooleanField({ required: true, initial: false }),
      }),

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

      // 是否需要相互链接才激活效果
      requiresLink: new fields.BooleanField({ required: true, initial: false }),

      // 是否已激活（武器/饰品有多件时的激活状态）
      isActive: new fields.BooleanField({ required: true, initial: false }),

      // 收藏
      favorited: new fields.BooleanField({ required: true, initial: false }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SkillData — 技能数据模型（基础 / 守备 / EGO）
// ═══════════════════════════════════════════════════════════════════════════

export class SkillData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;

    // 相关技能结构
    const relatedSkillSchema = new fields.SchemaField({
      // 主技能：关联的已有技能 Item UUID
      itemUuid:  new fields.StringField({ required: false, nullable: true, initial: null }),
      // 触发条件
      trigger:   new fields.StringField({ required: false, initial: "命中时" }),
      // EGO 技能：恐慌时替换为侵蚀形态 UUID
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
      quantity: new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      effect:   new fields.HTMLField({ required: false, initial: "" }),
      // 激活效果触发列表
      activities: new fields.ArrayField(makeActivitySchema(), { required: true, initial: [] }),
      favorited:  new fields.BooleanField({ required: true, initial: false }),
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
      description: new fields.HTMLField({ required: false, initial: "" }),
      quantity:    new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      favorited:   new fields.BooleanField({ required: true, initial: false }),
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
      // 内容物（存储物品 UUID 数组，顺序对应格子位置，null 表示空格）
      contents: new fields.ArrayField(
        new fields.StringField({ nullable: true }),
        { required: true, initial: [] }
      ),
      favorited: new fields.BooleanField({ required: true, initial: false }),
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
   * 异步获取相关技能的 Item 实例（通过 UUID）
   * @returns {Promise<LimbusItem|null>}
   */
  async getRelatedSkillItem() {
    if (this.type !== "skill") return null;
    const uuid = this.system.relatedSkill?.itemUuid;
    if (!uuid) return null;
    return fromUuid(uuid).catch(() => null);
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
      const typeLabels = { equipment:"装备", consumable:"消耗品", material:"材料", container:"容器" };
      const typeLabel  = typeLabels[this.type] ?? this.type;
      const catLabel   = sys.category ? ` · ${sys.category}` : "";
      metaHtml = `<div class="ic-item-meta">${typeLabel}${catLabel}</div>`;
    }

    // ── 描述文本 ───────────────────────────────────────────────────────
    const descHtml = (() => {
      const raw =
        (this.type === "skill"      ? sys.effectDesc : null) ??
        (this.type === "equipment"  ? sys.effect     : null) ??
        (this.type === "consumable" ? sys.effect      : null) ??
        (this.type === "material"   ? sys.description : null) ??
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

  // ─── 辅助：判断此技能是否为侵蚀形态 ──────────────────────────────────

  get isErodeForm() {
    // 约定：若技能名称包含"侵蚀"或被其他技能的 erodeUuid 引用，则视为侵蚀形态
    // 实际关系由 erodeUuid 引用确定，这里只做名称简单标记
    return this.name?.includes("侵蚀") ?? false;
  }

  // ─── 装备链接检测辅助 ─────────────────────────────────────────────────

  /**
   * 检查此装备是否与另一件装备在指定方向上相互链接
   * @param {LimbusItem} other  相邻装备
   * @param {"up"|"down"|"left"|"right"} directionFromThis  从本装备到另一装备的方向
   * @returns {boolean}
   */
  isLinkedWith(other, directionFromThis) {
    if (this.type !== "equipment" || other.type !== "equipment") return false;
    const opposites = { up: "down", down: "up", left: "right", right: "left" };
    const myLink    = this.system.links?.[directionFromThis]        ?? false;
    const theirLink = other.system.links?.[opposites[directionFromThis]] ?? false;
    return myLink && theirLink;
  }
}
