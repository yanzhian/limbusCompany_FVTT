import { LC } from "../helpers/config.mjs";

/**
 * Limbus Company Item 文档类。
 * 负责所有物品/技能数据的派生计算和规则判断。
 */
export class LimbusItem extends Item {

  /* ============================================================
     数据准备管线
     ============================================================ */

  /** @override */
  prepareData() {
    super.prepareData();
  }

  /** @override */
  prepareDerivedData() {
    const sys  = this.system;
    const type = this.type;

    if (type === "skill_attack") this._prepareAttackSkill(sys);
    if (type === "skill_defense") this._prepareDefenseSkill(sys);
    if (type === "ego")  this._prepareEgo(sys);
    if (type === "upper_body") this._prepareUpperBody(sys);
  }

  /* ============================================================
     私有计算方法
     ============================================================ */

  /**
   * 攻击技能：计算星芒消耗。
   * 相关技能（tags 包含 "related"）不消耗星芒。
   */
  _prepareAttackSkill(sys) {
    const isRelated = (sys.tags ?? []).includes("related");
    if (isRelated) {
      sys._starlingSost = 0;
    } else {
      const level = sys.skill_level ?? 1;
      sys._starlingCost = LC.skillLevels[level] ?? 1;
    }
  }

  /**
   * 守备技能：计算星芒消耗（与攻击技能相同规则）。
   */
  _prepareDefenseSkill(sys) {
    const isRelated = (sys.tags ?? []).includes("related");
    sys._starlingCost = isRelated ? 0 : (sys.starling ?? 0);
    // 守备技能无等级概念，星芒消耗直接由 starling 字段填写
  }

  /**
   * EGO：验证 sin_cost 字段合法性，计算总消耗量。
   */
  _prepareEgo(sys) {
    const cost  = sys.sin_cost ?? {};
    let   total = 0;
    for (const sin of Object.keys(LC.sinPoolDefault)) {
      const v = cost[sin] ?? 0;
      if (v < 0) cost[sin] = 0; // 不允许负消耗
      total += cost[sin] ?? 0;
    }
    sys._sinCostTotal = total;
  }

  /**
   * 上装：将 resistance_mod 中的非 "none" 条目整理为易读的列表。
   */
  _prepareUpperBody(sys) {
    const mods       = sys.resistance_mod ?? {};
    sys._resMods = Object.entries(mods)
      .filter(([, v]) => v !== "none")
      .map(([type, level]) => ({ type, level }));
  }

  /* ============================================================
     规则判断方法
     ============================================================ */

  /**
   * 检查此技能是否需要特定武器类型。
   * 若 weapon_requirement 为空则无限制。
   * @param {Actor} actor - 使用者
   * @returns {boolean}
   */
  requiresWeapon(actor) {
    const req = this.system.weapon_requirement ?? "";
    if (!req) return true;

    // 检查角色装备中是否有匹配 attack_type 的武器
    const hasWeapon = actor.items.some(
      i => i.type === "weapon" && i.system.attack_type === req
    );
    return hasWeapon;
  }

  /**
   * 取得此技能的链接插槽方向列表（如 ["left", "down"]）。
   * 链接方向来自 links 字段，以字符串存储（"←↓" 等）。
   * @returns {string[]}
   */
  getLinkDirections() {
    const raw = this.system.links ?? [];
    if (Array.isArray(raw)) return raw;
    // 兼容旧版字符串格式
    return String(raw).split("").filter(c => ["←", "→", "↑", "↓"].includes(c));
  }

  /**
   * 获取此物品的星芒消耗（统一入口）。
   * @returns {number}
   */
  getStarlingCost() {
    return this.system._starlingCost ?? this.system.starling ?? 0;
  }

  /**
   * 获取 EGO 激活所需的罪孽消耗（仅对 ego 类型有效）。
   * @returns {Object} { wrath: n, ... }
   */
  getSinCost() {
    if (this.type !== "ego") return {};
    return this.system.sin_cost ?? {};
  }

  /**
   * 将物品信息发送到聊天窗口（简易展示）。
   */
  async displayInChat() {
    const typeLabel = game.i18n.localize(`TYPES.Item.${this.type}`);
    const sinLabel  = this.system.sin && this.system.sin !== "none"
      ? game.i18n.localize(`LC.Sin.${this.system.sin}`) : null;

    let extraInfo = "";
    if (this.type === "skill_attack") {
      const atk = game.i18n.localize(`LC.AttackType.${this.system.attack_type ?? "slash"}`);
      extraInfo = `${atk} · Lv${this.system.skill_level ?? 1} · 基${this.system.base_value ?? 0}+${this.system.variable_dice ?? "d4"}×${this.system.dice_count ?? 1}`;
    } else if (this.type === "skill_defense") {
      const def = game.i18n.localize(`LC.DefenseType.${this.system.defense_type ?? "dodge"}`);
      extraInfo = `${def} · 基${this.system.base_value ?? 0}+${this.system.variable_dice ?? "d4"}×${this.system.dice_count ?? 1}`;
    } else if (this.type === "ego") {
      const tier = this.system.ego_tier ?? "ZAYIN";
      const atk  = game.i18n.localize(`LC.AttackType.${this.system.attack_type ?? "slash"}`);
      extraInfo = `${tier} · ${atk} · 总消耗 ${this.system._sinCostTotal ?? 0} 罪孽`;
    }

    const content = `
      <div class="lc-item-display">
        <strong>${this.name}</strong>【${typeLabel}】${sinLabel ? `[${sinLabel}]` : ""}
        ${extraInfo ? `<br>${extraInfo}` : ""}
        ${this.system.description ? `<hr><p>${this.system.description}</p>` : ""}
      </div>
    `;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content,
    });
  }
}
