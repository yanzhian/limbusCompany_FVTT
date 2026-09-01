/**
 * actor.mjs — 边狱巴士都市规则 Actor 文档类
 *
 * 包含：
 *   - CharacterData  : TypeDataModel（角色数据模型 + 派生值计算）
 *   - LimbusActor    : Actor 文档类（封装游戏逻辑方法）
 */

import { CustomBuffRegistry, resolveBuffHandler, isTremorFamilyType, TREMOR_DEPENDENT_TYPES } from "../helpers/custom-buffs.mjs";

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

      // ── 行动币（AP，无上限）─────────────────────────────────────────────
      // value 无上限：技能 / 装备 / 消耗品都能把它顶到 3 以上。
      // max 只是「回合开始补到几枚」的默认值，不是硬上限。
      ap: new fields.SchemaField({
        value: new fields.NumberField({ required: true, integer: true, min: 0, initial: 3 }),
        max:   new fields.NumberField({ required: true, integer: true, min: 1, initial: 3 }),
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

      // ── 背包摆放（塔科夫式自由摆放的持久化坐标） ────────────────────
      // 只存"人为摆过"的物品：{ itemId, x, y, rotated }。
      // 没有记录的物品（新捡到的、刚从容器里拿出来的）在渲染时首适应自动补位，
      // 补位结果不会写回——玩家真正拖过一次才落成记录。
      bagLayout: new fields.ArrayField(
        new fields.SchemaField({
          itemId:  new fields.StringField({ required: true, initial: "" }),
          x:       new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
          y:       new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
          rotated: new fields.BooleanField({ initial: false }),
        }),
        { required: true, initial: [] }
      ),

      // ── 形象·头部图层 ──────────────────────────────────────────────
      // 立绘（actor.img）是底图；「头」是单独一张图，永远画在所有装备之上。
      // 摆放参数与装备的 doll 同构，编辑方式也一样。
      dollHead: new fields.SchemaField({
        img:   new fields.StringField({ required: false, initial: "" }),
        x:     new fields.NumberField({ required: true, initial: 50 }),
        y:     new fields.NumberField({ required: true, initial: 22 }),
        scale: new fields.NumberField({ required: true, initial: 1, min: 0.05, max: 8 }),
        rot:   new fields.NumberField({ required: true, initial: 0 }),
      }),

      // ── 恐慌类型槽位（战斗 Tab 罪孽抗性下方，存嵌入恐慌卡的 itemId） ──
      panicSlots: new fields.SchemaField({
        lowMorale: new fields.StringField({ required: false, initial: "" }),
        panic:     new fields.StringField({ required: false, initial: "" }),
      }),

      // ── 恐慌/坚定计数（陷入恐慌回合结束鉴定用，各 0-3） ────────────
      panicCounters: new fields.SchemaField({
        fear:    new fields.NumberField({ required: true, integer: true, min: 0, max: 3, initial: 0 }),
        resolve: new fields.NumberField({ required: true, integer: true, min: 0, max: 3, initial: 0 }),
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

      // ── 背景标签（旧版自由文本，逐步由下方 background.uuid 结构化背景取代） ──
      backgroundTag: new fields.StringField({ required: false, initial: "" }),

      // ── 背景（指向"背景"类型物品的 UUID，由创建向导写入） ──────────────
      background: new fields.SchemaField({
        uuid: new fields.StringField({ required: false, initial: "" }),
      }),

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

    // 最大生命值：基础HP(体质) + (等级-1) × 成长系数(体质)
    // 体质范围 1–8；基础HP 60→80，成长系数 2.0→3.0，线性插值
    const conClamped = Math.max(1, Math.min(8, con));
    const t = (conClamped - 1) / 7;
    const hpBase   = 60 + t * 20;
    const hpGrowth = 2.0 + t * 1.0;
    this.hp.max = Math.round(hpBase + (Math.max(1, level) - 1) * hpGrowth);

    // 速度范围：1+敏捷 ~ 6+敏捷（1D6+敏捷）
    this.speed.min = 1 + agi;
    this.speed.max = 6 + agi;

    // 星芒上限：30 + 等级
    this.stellarMotes.max = 30 + level;

    // 下一级经验需求
    const xpTable = CONFIG.LIMBUSCOMPANY?.LEVEL_XP ?? [];
    this.xp.next = xpTable[level] ?? (xpTable[xpTable.length - 1] ?? 0);

    // 行动币无上限；ap.max 只是"回合开始时补到几枚"的默认值，不是硬上限
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
//  MerchantData — TypeDataModel（NPC商人数据模型）
// ═══════════════════════════════════════════════════════════════════════════

export class MerchantData extends foundry.abstract.TypeDataModel {

  /** 定义数据模型结构 */
  static defineSchema() {
    const fields = foundry.data.fields;
    return {
      // 店铺描述（富文本，显示在左侧立绘下方）
      shopDesc: new fields.HTMLField({ required: false, initial: "" }),

      // 商人自己持有的货币（眼），显示在 GM 底栏
      merchantCurrency: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),

      // ── 货架网格 ────────────────────────────────────────────────────────
      // 留成字段只是为了以后要改时不用动 schema
      // 与玩家背包同尺寸（5 宽 × 8 高），两边并排看着才对称
      shelfSize: new fields.SchemaField({
        width:  new fields.NumberField({ required: true, integer: true, min: 1, max: 20, initial: 5 }),
        height: new fields.NumberField({ required: true, integer: true, min: 1, max: 20, initial: 8 }),
      }),
      // 货架摆放记录，格式与营地仓库 warehouseContents 一致（buildPlacementGrid 直接吃）
      // 多一个 price：**这一件商品的原价**，与物品自身的 system.price 解耦——
      // 同一件物品在不同商人那里可以卖不同价，玩家卖过来的东西也不该改写原物品。
      shelfContents: new fields.ArrayField(
        new fields.SchemaField({
          uuid:    new fields.StringField({ required: true, initial: "" }),
          x:       new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
          y:       new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
          w:       new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
          h:       new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
          rotated: new fields.BooleanField({ initial: false }),
          price:   new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        }),
        { required: true, initial: [] }
      ),

      // ── 折扣 ────────────────────────────────────────────────────────────
      // enabled 是总闸；rate 用「折」计：10 = 原价，1 = 一折。只作用于**买入**，
      // 回收价恒定半价（折扣是买方的事，压低回收价只会让人不想卖）。
      sale: new fields.SchemaField({
        enabled: new fields.BooleanField({ initial: false }),
        rate:    new fields.NumberField({ required: true, min: 1, max: 10, initial: 10 }),
      }),

      // ── 打烊 ────────────────────────────────────────────────────────────
      // GM 一键歇业：玩家看不到货架上的商品，也不能买、不能卖。GM 端不受影响。
      closed: new fields.BooleanField({ initial: false }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CampData — TypeDataModel（营地数据模型）
// ═══════════════════════════════════════════════════════════════════════════

export class CampData extends foundry.abstract.TypeDataModel {

  static defineSchema() {
    const fields = foundry.data.fields;

    // 配方原料条目
    const ingredientSchema = new fields.SchemaField({
      name:     new fields.StringField({ required: true, initial: "" }),
      img:      new fields.StringField({ required: false, initial: "icons/svg/item-bag.svg" }),
      quantity: new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    });

    // 配方条目
    const recipeSchema = new fields.SchemaField({
      id:             new fields.StringField({ required: true, initial: () => foundry.utils.randomID() }),
      name:           new fields.StringField({ required: true, initial: "新配方" }),
      hidden:         new fields.BooleanField({ required: true, initial: false }),
      ingredients:    new fields.ArrayField(ingredientSchema, { required: true, initial: [] }),
      outputName:     new fields.StringField({ required: true, initial: "" }),
      outputImg:      new fields.StringField({ required: false, initial: "icons/svg/item-bag.svg" }),
      outputQuantity: new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      // 产出物品完整数据快照（GM 拖拽物品时自动填入）
      outputItemData: new fields.ObjectField({ required: false, nullable: true, initial: null }),
    });

    return {
      // 仓库网格尺寸（默认 7×7）
      warehouseSize: new fields.SchemaField({
        width:  new fields.NumberField({ required: true, integer: true, min: 1, max: 20, initial: 7 }),
        height: new fields.NumberField({ required: true, integer: true, min: 1, max: 20, initial: 7 }),
      }),
      // 仓库内容物（放置记录，与容器 contents 格式相同）
      // { uuid, x, y, w, h, rotated }  uuid 指向该 camp actor 的嵌入物品
      warehouseContents: new fields.ArrayField(
        new fields.SchemaField({
          uuid:    new fields.StringField({ required: true, initial: "" }),
          x:       new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
          y:       new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
          w:       new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
          h:       new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
          rotated: new fields.BooleanField({ initial: false }),
        }),
        { required: true, initial: [] }
      ),
      description: new fields.HTMLField({ required: false, initial: "" }),
      recipes:     new fields.ArrayField(recipeSchema, { required: true, initial: [] }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  LootData — 战利品 Actor 数据模型
// ═══════════════════════════════════════════════════════════════════════════

export class LootData extends foundry.abstract.TypeDataModel {

  static defineSchema() {
    const fields = foundry.data.fields;

    // 放置记录（与营地仓库格式相同 + 揭晓状态）
    const placementSchema = new fields.SchemaField({
      uuid:     new fields.StringField({ required: true, initial: "" }),
      x:        new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      y:        new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      w:        new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      h:        new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      rotated:  new fields.BooleanField({ initial: false }),
      // 玩家双击揭晓前显示为剪影，且不可拾取
      revealed: new fields.BooleanField({ initial: false }),
    });

    // 战利品清单条目（随机表条目：权重抽取用）
    const lootTableEntrySchema = new fields.SchemaField({
      id:       new fields.StringField({ required: true, initial: () => foundry.utils.randomID() }),
      name:     new fields.StringField({ required: true, initial: "" }),
      img:      new fields.StringField({ required: false, initial: "icons/svg/item-bag.svg" }),
      weight:   new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      // 物品完整数据快照（补充战利品时据此创建）
      itemData: new fields.ObjectField({ required: false, nullable: true, initial: null }),
    });

    return {
      // 网格尺寸（GM 可改，默认 5×5）
      gridSize: new fields.SchemaField({
        width:  new fields.NumberField({ required: true, integer: true, min: 1, max: 20, initial: 5 }),
        height: new fields.NumberField({ required: true, integer: true, min: 1, max: 20, initial: 5 }),
      }),
      // 物品放置记录
      lootContents: new fields.ArrayField(placementSchema, { required: true, initial: [] }),
      // 眼（货币）
      currency: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      // 战利品清单（GM 补充战利品时的随机抽取表）
      lootTable: new fields.ArrayField(lootTableEntrySchema, { required: true, initial: [] }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  LimbusActor — Actor 文档类
// ═══════════════════════════════════════════════════════════════════════════

export class LimbusActor extends Actor {

  /**
   * Item Piles v3 creates pile actors without a 'type' field.
   * cleanData() runs before validation, so we can safely default it here.
   * @override
   */
  static cleanData(source = {}, options = {}) {
    if (!source.type) source.type = "character";
    return super.cleanData(source, options);
  }

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

  /** 计算当前所有已装备物品（装备格 + 技能槽）的星芒总消耗 */
  _calcEquippedStellarCost() {
    const sys = this.system;
    let total = 0;
    for (const itemId of Object.values(sys.equipment ?? {})) {
      const item = itemId ? this.items.get(itemId) : null;
      total += item?.getStellarCost?.() ?? 0;
    }
    for (const itemId of (sys.skills?.basic ?? [])) {
      const item = itemId ? this.items.get(itemId) : null;
      total += item?.getStellarCost?.() ?? 0;
    }
    const defenseId = sys.skills?.defense ?? null;
    const defense   = defenseId ? this.items.get(defenseId) : null;
    total += defense?.getStellarCost?.() ?? 0;
    for (const itemId of Object.values(sys.skills?.ego ?? {})) {
      const item = itemId ? this.items.get(itemId) : null;
      total += item?.getStellarCost?.() ?? 0;
    }
    return total;
  }

  /**
   * 检查是否有足够星芒装备某个物品。
   * 以【上限 - 当前已装备总费用】动态计算剩余星芒，与 UI 显示保持一致，
   * 避免 stellarMotes.value 因数据迁移/直接编辑而与实际状态脱节。
   * @param {LimbusItem} item
   * @param {number}     [refund=0]  替换旧物品时可退还的星芒（旧物品仍在 equipped 列表中，需补偿）
   * @returns {{ canEquip: boolean, cost: number, current: number, max: number }}
   */
  checkStellarCost(item, refund = 0) {
    const cost    = item.getStellarCost?.() ?? 0;
    const max     = 30 + (this.system.level ?? 1);
    const spent   = this._calcEquippedStellarCost();
    const current = Math.max(0, max - spent);
    return { canEquip: (current + refund) >= cost, cost, current, max };
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

    const prevId   = this.system.equipment[`slot${slotIndex}`];
    if (!this._canEquipSubtype(item, { currentSlot: slotIndex, replacingItemId: prevId })) return;

    const prevItem = prevId ? this.items.get(prevId) : null;
    const refund   = prevItem?.getStellarCost?.() ?? 0;
    const { canEquip, cost, current, max } = this.checkStellarCost(item, refund);
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
   * 标了【无法装备】的衍生技能不能直接装进技能槽，
   * 只能由【相关技能转换】把已装备的技能替换成它（replaceSkillSlot 不走这里）。
   * @returns {boolean} 是否应当拒绝本次装备
   */
  _rejectNoEquip(item) {
    if (!item?.system?.noEquip) return false;
    ui.notifications?.warn(`【${item.name}】无法装备，只能通过【相关技能转换】替换上场。`);
    return true;
  }

  /**
   * 装备技能到对应槽位
   * @param {string} itemId  物品 ID
   */
  async equipSkill(itemId) {
    const item = this.items.get(itemId);
    if (!item || item.type !== "skill") return;
    if (this._rejectNoEquip(item)) return;

    const skillType = item.system.type;

    // 提前计算旧技能退款（用于星芒校验）
    let prevId = null;
    if (skillType === "defense") {
      prevId = this.system.skills.defense;
    } else if (skillType === "ego") {
      const grade = item.system.egoDiceRating;
      if (!grade) return;
      prevId = this.system.skills.ego[grade];
    }
    const refund = prevId ? (this.items.get(prevId)?.getStellarCost?.() ?? 0) : 0;

    const { canEquip, cost, current, max } = this.checkStellarCost(item, refund);
    if (!canEquip) {
      const msg = game.i18n.format("LIMBUSCOMPANY.Warning.NotEnoughStellar", { cost, current, max });
      ui.notifications.warn(msg);
      return;
    }

    if (skillType === "defense") {
      if (prevId) await this.unequipSkill(prevId);
      await this.spendStellarMotes(cost);
      return this.update({ "system.skills.defense": itemId });
    }

    if (skillType === "ego") {
      const grade = item.system.egoDiceRating;
      if (prevId) await this.unequipSkill(prevId);
      await this.spendStellarMotes(cost);
      return this.update({ [`system.skills.ego.${grade}`]: itemId });
    }

    // 基础技能：找第一个空槽（无替换，无退款）
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
    // 槽位间移动不算"装备"，衍生技能一旦上场就允许挪位
    if (fromSlot < 0 && this._rejectNoEquip(item)) return;

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

    // 星芒检查（含目标槽旧技能的退款）
    const prevId   = slots[targetSlot];
    const refund   = prevId ? (this.items.get(prevId)?.getStellarCost?.() ?? 0) : 0;
    const { canEquip, cost, current, max } = this.checkStellarCost(item, refund);
    if (!canEquip) {
      ui.notifications.warn(game.i18n.format("LIMBUSCOMPANY.Warning.NotEnoughStellar", { cost, current, max }));
      return;
    }

    // 目标槽已有技能则先卸下（退还星芒）
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
   * 计算升级预览（不修改数据），供升级对话框展示"原→现"数值与本级奖励物品。
   * @returns {Promise<object|null>} 无法升级时返回 null
   */
  async getLevelUpPreview() {
    const xpTable = CONFIG.LIMBUSCOMPANY?.LEVEL_XP ?? [];
    const sys = this.system;
    const currentLevel = sys.level;
    const needed = xpTable[currentLevel] ?? null;
    const currentXp = sys.xp.value ?? 0;
    if (needed === null || currentXp <= needed) return null;

    const nextLevel = currentLevel + 1;
    const con = sys.attributes?.con ?? 1;
    const conClamped = Math.max(1, Math.min(8, con));
    const t = (conClamped - 1) / 7;
    const hpBase   = 60 + t * 20;
    const hpGrowth = 2.0 + t * 1.0;
    const nextHPMax   = Math.round(hpBase + (nextLevel - 1) * hpGrowth);
    const nextHPValue = Math.min(Math.max(sys.hp.value ?? 0, 0), nextHPMax);
    const nextStellarMax = 30 + nextLevel;
    const nextAttrPoints = (nextLevel % 10 === 0) ? ((sys.attrPoints ?? 0) + 1) : (sys.attrPoints ?? 0);

    // 背景升级奖励：匹配 nextLevel 的物品条目
    const rewards = [];
    const bgUuid = sys.background?.uuid ?? "";
    if (bgUuid) {
      const bg = await fromUuid(bgUuid).catch(() => null);
      const entry = bg?.system?.levelRewards?.find(r => Number(r.level) === nextLevel);
      for (const ref of entry?.items ?? []) {
        const it = ref.uuid ? await fromUuid(ref.uuid).catch(() => null) : null;
        rewards.push({
          uuid: ref.uuid,
          name: it?.name ?? ref.itemData?.name ?? "（未知物品）",
          img:  it?.img  ?? ref.itemData?.img  ?? "icons/svg/item-bag.svg",
        });
      }
    }

    return {
      currentLevel, nextLevel,
      hpFrom: sys.hp.max, hpTo: nextHPMax, hpValueTo: nextHPValue,
      stellarFrom: sys.stellarMotes.max, stellarTo: nextStellarMax,
      attrPointsFrom: sys.attrPoints ?? 0, attrPointsTo: nextAttrPoints,
      rewards,
    };
  }

  /**
   * 应用升级：等级+1，经验清零，生命/星芒上限更新，按背景等级奖励发放物品。
   * @returns {Promise<object|null>} 升级预览数据（用于聊天记录展示），无法升级时返回 null
   */
  async levelUpByXp() {
    const preview = await this.getLevelUpPreview();
    if (!preview) {
      ui.notifications?.warn?.("经验值未超过升级阈值，无法升级。");
      return null;
    }

    await this.update({
      "system.level":             preview.nextLevel,
      "system.xp.value":          0,
      "system.attrPoints":        preview.attrPointsTo,
      "system.stellarMotes.max":  preview.stellarTo,
      "system.hp.max":            preview.hpTo,
      "system.hp.value":          preview.hpValueTo,
    });

    if (preview.rewards.length) {
      const toCreate = [];
      for (const r of preview.rewards) {
        const src = r.uuid ? await fromUuid(r.uuid).catch(() => null) : null;
        const data = src ? src.toObject() : null;
        if (!data) continue;
        delete data._id;
        toCreate.push(data);
      }
      if (toCreate.length) await this.createEmbeddedDocuments("Item", toCreate);
    }

    return preview;
  }


  // ─── 长休 ──────────────────────────────────────────────────────────────

  /**
   * 执行长休：恢复 HP / 理智 / AP，重置混乱阈值，还原全部临时技能转换。
   * 无确认对话框，直接执行。
   */
  async longRest() {
    // 兜底：一直没被使用掉的临时技能转换（如「使用一次后还原」的强化形态在战斗
    // 结束前始终没投出去）会一直挂在槽位上，长休时统一收回，不跨休息残留
    const { ClashManager } = await import("../helpers/clash.mjs");
    await ClashManager._revertTempSkillConverts(this, "all");

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
   * 检查并处理混乱阈值触发。
   * 同一次伤害可同时跨越多条阈值，全部烧断；
   * 若已有混乱 BUFF，则按触发条数升级，依次类推：
   *   无 + 1条 → 陷入混乱（×2.0）
   *   无 + 2条 / 陷入混乱 + 1条 → 陷入混乱+（×2.5）
   *   任意 → 陷入混乱++（×3.0，上限）
   * 仅在 HP 减少时调用，HP 回升不触发。
   * @param {number} newHP
   * @param {number} oldHP
   * @param {object} [opts]
   * @param {boolean} [opts.silent=false] 为 true 时跳过聊天框（调用方自行在消息中显示混乱信息）
   * @param {string}  [opts.source=""]   伤害来源标识，如 "burn"，供 beforeChaos 判断免疫条件
   */
  async checkAndTriggerChaos(newHP, oldHP, { silent = false, source = "" } = {}) {
    if (newHP >= oldHP) return; // HP 没有减少则不检查

    // 检查自定义 BUFF beforeChaos 免疫（如【防御姿态】【血炎】）
    for (const buff of (this.system?.buffs ?? [])) {
      const handler = resolveBuffHandler(buff);
      if (typeof handler?.beforeChaos === "function") {
        const result = handler.beforeChaos(this, buff, { source });
        if (result?.immune) return; // 免疫混乱触发
      }
    }

    const sys        = this.system;
    const maxHP      = sys.hp.max;
    const thresholds = [...sys.chaosThresholds];
    const burnedIdxs = [];

    // 同次伤害可同时跨越多条阈值，全部烧断
    for (let i = 0; i < thresholds.length; i++) {
      const t = thresholds[i];
      if (!t.triggered && newHP <= maxHP * t.percent / 100) {
        burnedIdxs.push(i);
        thresholds[i] = { ...thresholds[i], triggered: true };
      }
    }

    if (burnedIdxs.length === 0) return;

    // 混乱等级：0=无 1=陷入混乱 2=陷入混乱+ 3=陷入混乱++
    const CHAOS_TYPES = CONFIG.LIMBUSCOMPANY?.CHAOS_TYPES ?? ["chaos", "chaos_plus", "chaos_double_plus"];
    const CHAOS_NAMES = CONFIG.LIMBUSCOMPANY?.CHAOS_NAMES ?? ["陷入混乱", "陷入混乱+", "陷入混乱++"];

    const existingChaos = (this.system.buffs ?? []).find(b => CHAOS_TYPES.includes(b.type));
    const currentLevel  = existingChaos ? (CHAOS_TYPES.indexOf(existingChaos.type) + 1) : 0;
    const newLevel      = Math.min(3, currentLevel + burnedIdxs.length);
    const chaosType     = CHAOS_TYPES[newLevel - 1];
    const chaosName     = CHAOS_NAMES[newLevel - 1];

    // 移除旧混乱 BUFF（如有），加入升级后的 BUFF
    let newBuffs = (this.system.buffs ?? []).filter(b => !CHAOS_TYPES.includes(b.type));
    newBuffs.push({
      id:        foundry.utils.randomID(),
      type:      chaosType,
      name:      chaosName,
      icon:      "",
      intensity: 0,
      stacks:    1,
      whenAdded: "本回合",
    });

    await this._safeUpdateSelf({
      "system.chaosThresholds": thresholds,
      "system.ap.value":        0,
      "system.buffs":           newBuffs,
    });

    // 混乱阈值被击穿：全场都该听见
    const { ClashTotalFX } = await import("../helpers/clash-total-fx.mjs");
    ClashTotalFX.broadcastSfx("chaos");

    // ── [陷入混乱时] Activity ────────────────────────────────────────────
    // 已装备的技能 + 装备格物品都参与；升级（混乱→混乱+）同样算一次触发
    await this.triggerChaosActivities();

    // silent=true 时调用方已在取血消息中展示混乱触发信息，无需再创建独立消息
    if (!silent) {
      const pctList  = burnedIdxs.map(i => thresholds[i].percent + "%").join("、");
      const upgraded = existingChaos ? `（${CHAOS_NAMES[currentLevel - 1]} → ${chaosName}）` : "";
      await ChatMessage.create({
        content: `<div class="limbuscompany chat-clash"><strong>${this.name}</strong> 混乱阈值被触发（${pctList}）——【${chaosName}】${upgraded}！</div>`,
      });
    }
  }

  // ─── BUFF 管理 ─────────────────────────────────────────────────────────

  /**
   * 安全写入自身：战斗流程里经常由"对方的客户端"来改本角色（承受伤害、被加 BUFF、
   * 混乱阈值前移等），此时当前玩家没有本角色的更新权限。统一走
   * ClashManager._safeDocUpdate，由它在无权限时通过 socket 委托 GM 执行。
   */
  async _safeUpdateSelf(data) {
    const { ClashManager } = await import("../helpers/clash.mjs");
    return ClashManager._safeDocUpdate(this, data);
  }

  /**
   * 添加 BUFF
   * @param {{ type: string, name: string, intensity: number, stacks: number, whenAdded: string, icon?: string }} buffData
   */
  async addBuff(buffData) {
    const buffs = [...(this.system.buffs ?? [])];
    const type  = buffData.type ?? "custom";
    const name  = buffData.name ?? "自定义";

    // 基础特殊类 BUFF（烧伤/流血/破裂/震颤/沉沦/呼吸法；充能是例外，不算在内）：不存在"0层"或"0级"的这类 BUFF，
    // 层数/强度为 0 时自动订正为 1；增益/减益与自定义 BUFF 不受此规则影响
    const zeroDefault = ["burn", "bleed", "rupture", "tremor", "sinking", "breathing"].includes(type);
    let rawIntensity = buffData.intensity ?? 0;
    let rawStacks    = buffData.stacks    ?? 0;
    if (zeroDefault) {
      if (!(rawIntensity > 0)) rawIntensity = 1;
      if (!(rawStacks    > 0)) rawStacks    = 1;
    }

    // 【振幅转换】【振幅纠缠】依附于震颤存在：没有任何震颤族时无法施加；且两者互斥
    if (TREMOR_DEPENDENT_TYPES.includes(type)) {
      if (!(this.system.buffs ?? []).some(b => isTremorFamilyType(b.type) && (b.stacks ?? 0) > 0)) {
        ui.notifications?.warn(`【${name}】只能在目标拥有【震颤】或【特殊震颤】时添加。`);
        return;
      }
      const other = TREMOR_DEPENDENT_TYPES.find(t => t !== type);
      for (let i = buffs.length - 1; i >= 0; i--) if (buffs[i].type === other) buffs.splice(i, 1);
    }

    // maxGainPerRound：本回合累计可获得的层数上限。额度用尽后，本轮内无论通过
    // 技能、装备还是手动添加都不再获得层数（与 ClashManager._addBuff 共用同一份
    // flag 计数，每轮结束清空）。
    const handler = resolveBuffHandler({ type, name });
    const maxGain = handler?.maxGainPerRound ?? Infinity;
    let   gainFlagUpdate = null;
    if (Number.isFinite(maxGain) && rawStacks > 0) {
      const gainMap = foundry.utils.deepClone(
        this.getFlag("limbusCompany_FVTT", "buffRoundGain") ?? {}
      );
      const gained  = gainMap[type] ?? 0;
      const allowed = Math.max(0, maxGain - gained);
      if (allowed <= 0) {
        ui.notifications?.info(`【${handler.label ?? type}】本回合已达获得上限（${maxGain} 层）。`);
        return;
      }
      rawStacks      = Math.min(rawStacks, allowed);
      gainMap[type]  = gained + rawStacks;
      gainFlagUpdate = { "flags.limbusCompany_FVTT.buffRoundGain": gainMap };
    }

    const { ClashManager } = await import("../helpers/clash.mjs");

    // 【振幅转换】：持有期间任何震颤族的施加都并入现有的那一种（与 _addBuff 同规则）
    if (isTremorFamilyType(type)) {
      const cur = this.system.buffs ?? [];
      if (cur.some(b => b.type === "amplitudeConvert")
          && !cur.some(b => b.type === "amplitudeEntangle")) {
        const family   = ClashManager._tremorFamilyBuffs(this);
        const existing = family.find(b => b.type !== "tremor") ?? family[0];
        const newType  = type !== "tremor" ? type : existing?.type;
        if (newType && await ClashManager._convertTremorFamily(
              this, newType, { stacks: rawStacks, intensity: rawIntensity })) {
          await ClashManager._dispatchBuffChange(this, "onBuffGained",
            { type: newType, intensity: rawIntensity, stacks: rawStacks });
          return;
        }
      }
    }

    // 已有同类型（且同回合、自定义 BUFF 还需同名）则叠加，否则新增
    // ——与 ClashManager._addBuff 保持一致，避免同一个 BUFF 在状态栏里裂成多条
    const maxStacks     = handler?.maxStacks    ?? Infinity;
    const maxIntensity  = handler?.maxIntensity ?? Infinity;
    const refreshOnGain = handler?.refreshOnGain ?? false;
    const whenAdded     = buffData.whenAdded ?? "本回合";
    const idx = buffs.findIndex(b =>
      b.type === type
      && (b.whenAdded ?? "本回合") === whenAdded
      && (type !== "custom" || b.name === name));

    if (idx >= 0) {
      if (refreshOnGain) {
        buffs[idx] = { ...buffs[idx], stacks: Math.min(rawStacks, maxStacks),
                       intensity: Math.min(rawIntensity, maxIntensity) };
      } else {
        buffs[idx] = {
          ...buffs[idx],
          stacks:    Math.min((buffs[idx].stacks ?? 0) + rawStacks, maxStacks),
          intensity: Math.min((buffs[idx].intensity ?? 0) + rawIntensity, maxIntensity),
        };
      }
    } else {
      buffs.push({
        id:        foundry.utils.randomID(),
        type,
        name,
        icon:      buffData.icon ?? "",
        intensity: Math.min(rawIntensity, maxIntensity),
        stacks:    Math.min(rawStacks, maxStacks),
        whenAdded,
      });
    }

    await this._safeUpdateSelf({ "system.buffs": buffs, ...(gainFlagUpdate ?? {}) });
    await ClashManager._dispatchBuffChange(this, "onBuffGained",
      { type, intensity: rawIntensity, stacks: rawStacks });
  }

  /**
   * 移除 BUFF（按 ID）
   * @param {string} buffId
   */
  async removeBuff(buffId) {
    const buffs = (this.system.buffs ?? []).filter(b => b.id !== buffId);
    return this._safeUpdateSelf({ "system.buffs": buffs });
  }

  /**
   * 移除所有指定类型的 BUFF
   * @param {string} type
   */
  async removeBuffsByType(type) {
    const buffs = (this.system.buffs ?? []).filter(b => b.type !== type);
    return this._safeUpdateSelf({ "system.buffs": buffs });
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
    // 自定义 BUFF 可选 keepAtZero：层数为 0 时不自动清除（仅归零，仍显示在状态栏）
    const keepAtZero = resolveBuffHandler(buffs[idx])?.keepAtZero ?? false;
    if (next <= 0 && !keepAtZero) buffs.splice(idx, 1);
    else                          buffs[idx] = { ...buffs[idx], stacks: next };
    return this._safeUpdateSelf({ "system.buffs": buffs });
  }

  /**
   * 减少指定类型 BUFF 的强度（如"每消耗4级【呼吸法】"这类按强度消耗）。
   * 与 reduceBuffStacks 不同：强度归零不会自动移除 BUFF（层数仍可能 >0），
   * 只有强度和层数都归零时才移除。
   * @param {string} type   BUFF type 键
   * @param {number} amount 减少量，默认 1
   */
  async reduceBuffIntensity(type, amount = 1) {
    const buffs = [...(this.system.buffs ?? [])];
    const idx   = buffs.findIndex(b => b.type === type);
    if (idx === -1) return;
    const next   = Math.max(0, (buffs[idx].intensity ?? 0) - amount);
    const stacks = buffs[idx].stacks ?? 0;
    const keepAtZero = resolveBuffHandler(buffs[idx])?.keepAtZero ?? false;
    if (next <= 0 && stacks <= 0 && !keepAtZero) buffs.splice(idx, 1);
    else                                         buffs[idx] = { ...buffs[idx], intensity: next };
    return this._safeUpdateSelf({ "system.buffs": buffs });
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
    return this._safeUpdateSelf({ "system.chaosThresholds": thresholds });
  }

  // ─── 理智检查（恐慌状态） ──────────────────────────────────────────────

  /**
   * 设置理智值并检查恐慌状态。
   * ≤30：士气低落（一场遭遇战只触发一次效果，无需鉴定）。
   * ≤10：由 updateCombat 回合结束钩子驱动坚定/恐慌鉴定（见 performPanicCheck）。
   * @param {number} value
   */
  async setSanity(value) {
    const clamped = Math.min(95, Math.max(5, value));
    await this._safeUpdateSelf({ "system.sanity.value": clamped });

    // 士气低落：一场遭遇战只触发一次（无论跨阈值多少次），不重新鉴定。
    // 士气低落不是 BUFF，不写入 system.buffs，也就不会出现在状态栏上——
    // 只是理智≤30 时的一次性效果触发（恐慌卡 activities）+ 聊天提示。
    if (clamped <= 30) {
      const firedKey = "lowMoraleFiredEncounter";
      const alreadyFired = this.getFlag("limbusCompany_FVTT", firedKey) ?? false;
      if (!alreadyFired) {
        await this.setFlag("limbusCompany_FVTT", firedKey, true);
        const { ClashManager } = await import("../helpers/clash.mjs");
        await ClashManager.recordPanic(this, "士气低落", "fear", {
          fear:    this.system.panicCounters?.fear ?? 0,
          resolve: this.system.panicCounters?.resolve ?? 0,
        }, `理智 ${clamped}`);
        await this.triggerPanicActivities("lowMorale", "恐慌触发时");
      }
    }
  }

  /**
   * 陷入恐慌鉴定（回合结束时，理智 ≤10 自动调用一次）：
   * 投掷 1 枚 1d10，结果 ≤ 智力 → 坚定+1，否则 → 恐慌+1。
   * 任一计数达到 3 时立即触发对应效果并重置理智（不清空计数——
   * 计数清空交由 clearPanicCountersIfTriggered 在下一回合开始时执行）。
   */
  async performPanicCheck() {
    const int = this.system.attributes?.int ?? 0;
    const roll = new Roll("1d10");
    await roll.evaluate();
    const success = (roll.total ?? 0) <= int;

    const side = success ? "resolve" : "fear";

    // 预先算出计数 +1 后的数值用于卡片公示（与 addPanicCounter 的 clamp 逻辑一致），
    // 实际写入仍交给 addPanicCounter，保证结果卡先于其可能触发的后续消息出现在聊天记录中。
    const curFear    = this.system.panicCounters?.fear ?? 0;
    const curResolve = this.system.panicCounters?.resolve ?? 0;
    const nextFear    = side === "fear"    ? Math.min(3, curFear + 1)    : curFear;
    const nextResolve = side === "resolve" ? Math.min(3, curResolve + 1) : curResolve;

    const { ClashManager } = await import("../helpers/clash.mjs");
    await ClashManager.recordPanic(
      this, success ? "坚定 +1" : "恐惧 +1", side,
      { fear: nextFear, resolve: nextResolve },
      `1d10 = ${roll.total}（智力 ${int}）`
    );
    await this.addPanicCounter(side);
  }

  /**
   * 恐慌/坚定计数 +1（不超过 3），达到 3 时立即触发对应效果。
   * @param {"fear"|"resolve"} side
   */
  async addPanicCounter(side) {
    const cur = this.system.panicCounters?.[side] ?? 0;
    const next = Math.min(3, cur + 1);
    await this._safeUpdateSelf({ [`system.panicCounters.${side}`]: next });
    if (next >= 3) await this._resolvePanicOutcome(side);
  }

  /**
   * 手动设置恐慌/坚定计数（拖动圆点）。设为 3 时立即触发对应效果。
   * @param {"fear"|"resolve"} side
   * @param {number} value  0-3
   */
  async setPanicCounter(side, value) {
    const clamped = Math.max(0, Math.min(3, value));
    await this._safeUpdateSelf({ [`system.panicCounters.${side}`]: clamped });
    if (clamped < 3) return;
    // 手动拖点触发的一连串恐慌消息（触发恐慌 → 士气低落 → 恐慌卡效果）也合成一张卡
    const { ClashManager } = await import("../helpers/clash.mjs");
    await ClashManager.withPanicAgg(() => this._resolvePanicOutcome(side));
  }

  /** 恐慌/坚定计数达到 3：触发对应效果 + 重置理智（30 恐慌 / 70 坚定）。 */
  async _resolvePanicOutcome(side) {
    const isFear = side === "fear";
    await this.setSanity(isFear ? 30 : 70);
    const { ClashManager } = await import("../helpers/clash.mjs");
    await ClashManager.recordPanic(
      this, isFear ? "触发恐慌" : "触发坚定", side,
      {
        fear:    this.system.panicCounters?.fear ?? 0,
        resolve: this.system.panicCounters?.resolve ?? 0,
      },
      `理智 → ${isFear ? 30 : 70}`
    );
    await this.triggerPanicActivities("panic", isFear ? "恐慌触发时" : "坚定触发时");
  }

  /** 回合开始时调用：若恐慌/坚定计数存在已点亮的「3」，清空双方计数。 */
  async clearPanicCountersIfTriggered() {
    const { fear = 0, resolve = 0 } = this.system.panicCounters ?? {};
    if (fear >= 3 || resolve >= 3) {
      await this._safeUpdateSelf({ "system.panicCounters.fear": 0, "system.panicCounters.resolve": 0 });
    }
  }

  /**
   * 触发 [陷入混乱时] 的 activities。
   * 混乱本身是纯负面状态（物理抗性被强制翻倍、行动值清零），这个时机是留给
   * "被打进混乱时反打一下"这类翻盘效果的。已装备技能 + 装备格物品都参与；
   * 混乱升级（混乱 → 混乱+）同样算一次触发。
   */
  async triggerChaosActivities() {
    const { ClashManager } = await import("../helpers/clash.mjs");
    const sys  = this.system ?? {};
    const ctx  = { owner: this, atkActor: this, defActor: null, _fireCounts: {}, _actMsgs: [] };
    const skillIds = [
      ...(sys.skills?.basic ?? []),
      sys.skills?.defense ?? null,
      ...Object.values(sys.skills?.ego ?? {}),
    ].filter(Boolean);
    for (const id of skillIds) {
      const item = this.items.get(id);
      if (item) await ClashManager._applyActivities(item, "陷入混乱时", ctx);
    }
    for (const eq of ClashManager._getEquippedItems(this)) {
      await ClashManager._applyActivities(eq, "陷入混乱时", ctx);
    }
    if (!ctx._actMsgs.length) return;
    // 混乱可能发生在承受伤害那一刻，也可能发生在回合结束的跳动伤害里。
    // 外层登记了环境桶就收进去（→ 承受结算 / 先攻骰掷的「上回合结束」），
    // 没登记才自己单发一条。
    if (!ClashManager.pushAmbient(ctx._actMsgs)) {
      await ClashManager._flushActMsgs(ctx._actMsgs, this);
    }
  }

  /**
   * 触发恐慌槽位物品的指定 activities 触发时机。
   * @param {"lowMorale"|"panic"} slot
   * @param {string} triggerName  "恐慌触发时" | "坚定触发时"
   */
  async triggerPanicActivities(slot, triggerName = "恐慌触发时") {
    const itemId = this.system.panicSlots?.[slot] ?? "";
    const item   = itemId ? this.items.get(itemId) : null;
    if (!item) return;
    const { ClashManager } = await import("../helpers/clash.mjs");
    const msgs = [];
    await ClashManager._applyActivities(item, triggerName, {
      owner: this, atkActor: this, defActor: null, _fireCounts: {}, _actMsgs: msgs,
    });
    if (!msgs.length) return;
    const kind = triggerName === "坚定触发时" ? "resolve" : "fear";
    // 聚合开着就并进【恐慌鉴定】卡底部的对应折叠，没开才自己单发一条
    if (!ClashManager.pushPanicActMsgs(kind, msgs)) {
      await ClashManager._flushActMsgs(msgs, this);
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

  /**
   * 将技能槽位中的 oldItemId 永久替换为 newItemId（相关技能转换用）。
   * 依次检查基础技能槽（数组）、守备技能槽（单值）、EGO 技能槽（按等级），
   * 命中的每一处都会替换（理论上同一 id 只会出现在一处）。
   * @param {string} oldItemId
   * @param {string} newItemId
   * @returns {Promise<boolean>} 是否找到并替换了槽位
   */
  async replaceSkillSlot(oldItemId, newItemId) {
    if (!oldItemId || !newItemId || oldItemId === newItemId) return false;
    const sys = this.system;
    const updates = {};
    // 换掉了哪几个槽位——临时转换的还原按槽位记账，必须由这里如实报出来。
    // 让调用方事后再 findSkillSlot 找一遍是不行的：那时槽位里装的已经是新技能，
    // 而且同一 tick 里 system 还可能没刷新，找不到就会退化成按 id 还原，
    // 把「另一个也变成了黎明将至」的槽位一起改掉。
    const slots = [];

    const basic = [...(sys.skills?.basic ?? [])];
    for (let i = 0; i < basic.length; i++) {
      if (basic[i] !== oldItemId) continue;
      basic[i] = newItemId;
      updates["system.skills.basic"] = basic;
      slots.push({ kind: "basic", idx: i });
    }

    if (sys.skills?.defense === oldItemId) {
      updates["system.skills.defense"] = newItemId;
      slots.push({ kind: "defense" });
    }

    const ego = { ...(sys.skills?.ego ?? {}) };
    for (const grade of Object.keys(ego)) {
      if (ego[grade] === oldItemId) {
        ego[grade] = newItemId;
        updates["system.skills.ego"] = ego;
        slots.push({ kind: "ego", grade });
      }
    }

    const changed = slots.length > 0;
    if (changed) {
      // 跨客户端执行时（如对方触发本方技能的转换效果），当前用户可能没有本
      // Actor 的写权限，复用 ClashManager._safeDocUpdate 经 socket 委托 GM 执行
      const { ClashManager } = await import("../helpers/clash.mjs");
      await ClashManager._safeDocUpdate(this, updates);
    }
    // 兼容旧用法：没换到返回 false，换到了返回槽位数组（真值）
    return changed ? slots : false;
  }

  /**
   * 定位某技能 id 所在的槽位（第一处命中）。
   * 临时技能转换的还原要按**槽位**记账而不是按 id——基础槽与守备槽可能同时
   * 被换成了同一个强化形态，此时按 id 还原会把两个槽一起改掉。
   * @param {string} itemId
   * @returns {{kind:string, idx?:number, grade?:string}|null}
   */
  findSkillSlot(itemId) {
    if (!itemId) return null;
    const sys = this.system;
    const bIdx = (sys.skills?.basic ?? []).indexOf(itemId);
    if (bIdx >= 0) return { kind: "basic", idx: bIdx };
    if (sys.skills?.defense === itemId) return { kind: "defense" };
    for (const [grade, id] of Object.entries(sys.skills?.ego ?? {})) {
      if (id === itemId) return { kind: "ego", grade };
    }
    return null;
  }

  /**
   * 把指定槽位直接写成 itemId（临时技能转换的还原用）。
   * @param {{kind:string, idx?:number, grade?:string}} slot
   * @param {string} itemId
   * @returns {Promise<boolean>}
   */
  async setSkillSlot(slot, itemId) {
    if (!slot?.kind || !itemId) return false;
    const sys = this.system;
    const updates = {};

    if (slot.kind === "basic") {
      const basic = [...(sys.skills?.basic ?? [])];
      const idx   = slot.idx ?? -1;
      if (idx < 0 || idx >= basic.length) return false;
      if (basic[idx] === itemId) return false;
      basic[idx] = itemId;
      updates["system.skills.basic"] = basic;
    } else if (slot.kind === "defense") {
      if (sys.skills?.defense === itemId) return false;
      updates["system.skills.defense"] = itemId;
    } else if (slot.kind === "ego") {
      const ego = { ...(sys.skills?.ego ?? {}) };
      if (!(slot.grade in ego) || ego[slot.grade] === itemId) return false;
      ego[slot.grade] = itemId;
      updates["system.skills.ego"] = ego;
    } else {
      return false;
    }

    const { ClashManager } = await import("../helpers/clash.mjs");
    await ClashManager._safeDocUpdate(this, updates);
    return true;
  }

  // ─── 先攻骰掷 ─────────────────────────────────────────────────────────

  /**
   * 骰掷先攻：1D6 + 敏捷（含装备速度修正 + 迅捷/束缚 BUFF）
   * 播放 DiceSoNice 动画，发送聊天消息，更新战斗跟踪器先攻值。
   * @returns {Promise<Roll>}
   */
  async rollSpeedInitiative({ updateCombatant = true, chatMessage = true } = {}) {
    const sys = this.system;
    const agi = sys.attributes?.agi ?? 0;

    // 装备速度修正
    const equipSpeedAdj = Object.values(sys.equipment ?? {})
      .filter(Boolean)
      .map(id => this.items.get(id))
      .filter(i => i?.type === "equipment")
      .reduce((acc, eq) => acc + Number(eq.system?.speedAdj ?? 0), 0);

    // BUFF 速度修正（迅捷 swift - 束缚 bind）
    const bStacks = (type) => (sys.buffs ?? [])
      .filter(b => b.type === type)
      .reduce((s, b) => s + (b.stacks ?? 0), 0);
    const buffSpeedMod = bStacks("swift") - bStacks("bind");

    const modifier = agi + equipSpeedAdj + buffSpeedMod;
    const roll     = new Roll("1d6 + @mod", { mod: modifier });
    await roll.evaluate();

    // 自定义 BUFF modifySpeedRoll 钩子（如【防御姿态】固定为最小速度）
    let finalTotal = roll.total;
    for (const buff of (sys.buffs ?? [])) {
      const handler = resolveBuffHandler(buff);
      if (typeof handler?.modifySpeedRoll === "function") {
        finalTotal = handler.modifySpeedRoll(this, { modifier, roll });
        break; // 只取第一个生效的修正器
      }
    }

    // 更新战斗跟踪器先攻值（可选：批量更新时由调用方统一写入）
    if (updateCombatant) {
      const combat = game.combat;
      if (combat) {
        const combatant = combat.combatants.find(c => c.actorId === this.id);
        if (combatant) await combatant.update({ initiative: finalTotal });
      }
    }

    // 发送聊天消息
    const ownerUser  = game.users?.find(u => !u.isGM && u.character?.id === this.id);
    const playerName = ownerUser?.name ?? game.user?.name ?? this.name;
    const speedMin   = 1 + modifier;
    const speedMax   = 6 + modifier;

    // 将结果附加到 roll 对象，供调用方使用（批量汇总时 chatMessage=false）
    roll.finalTotal = finalTotal;
    roll.speedMin   = speedMin;
    roll.speedMax   = speedMax;
    if (!chatMessage) return roll;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      content: `
        <div class="limbus-initiative-card">
          <div class="ic-header">
            <img class="ic-actor-avatar" src="${this.img}" alt="${this.name}">
            <div class="ic-actor-info">
              <div class="ic-title">先攻骰掷</div>
              <div class="ic-player">${playerName}</div>
            </div>
          </div>
          <div class="ic-gold-divider"></div>
          <div class="initiative-result-row">
            <img src="systems/limbusCompany_FVTT/assets/icons/Base_icon/Speed.webp"
                 class="initiative-speed-icon" alt="速度" width="20" height="20">
            <span class="initiative-speed-range">${speedMin}–${speedMax}</span>
            <span class="initiative-arrow">→</span>
            <span class="initiative-total">${finalTotal}</span>
          </div>
          <div class="ic-gold-divider"></div>
        </div>`,
    });

    return roll;
  }
}
