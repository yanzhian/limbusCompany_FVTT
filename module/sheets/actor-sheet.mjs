/**
 * actor-sheet.mjs — 角色卡界面
 * LimbusActorSheet extends ActorSheet
 *
 * 实现：
 *   - 三列顶部区域（头像/HP/理智 | 基础信息/抗性 | 名字/属性）
 *   - Tab-物品（九宫格装备栏 + 物品列表 + 过滤面板 + Title卡片）
 *   - Tab-技能（技能槽 + 技能列表）
 *   - Tab-战斗（BUFF状态 + 6-bag技能区 + 行动点硬币）
 *   - 底部固定栏（眼货币 + 星芒）
 */

import { ClashManager } from "../helpers/clash.mjs";

/**
 * 以 actorId 为 key 的模块级战斗袋状态 Map。
 * 确保同一角色的角色卡 sheet 与 Token sheet 共享同一状态，不因实例不同而分裂。
 */
const _globalBagState = new Map();

export class LimbusActorSheet extends ActorSheet {

  /* ─── 战斗袋状态（跨实例共享） ─────────────────────────────────────────── */

  /** 读取：从模块级 Map 取，角色卡 sheet 与 Token sheet 共用同一对象 */
  get _combatBagState() {
    return _globalBagState.get(this.actor?.id) ?? null;
  }

  /** 写入：null 表示清除，其他值存入 Map */
  set _combatBagState(value) {
    const id = this.actor?.id;
    if (!id) return;
    if (value == null) _globalBagState.delete(id);
    else               _globalBagState.set(id, value);
  }

  /* ─── 默认选项 ──────────────────────────────────────────────────────────── */

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes:  ["limbuscompany", "sheet", "actor", "character"],
      width:    880,
      height:   810,
      tabs:     [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "items" }],
      dragDrop: [{ dragSelector: ".equip-slot[data-item-id], .skill-slot-wrap[data-item-id], .item-row .item-icon, .skill-row .item-icon", dropSelector: ".equip-grid, .item-list-panel, .basic-skill-slots, .ego-skill-grid, .defense-skill-slot" }],
      scrollY:  [".item-list-panel", ".skill-list-panel", ".buff-list"],
    });
  }

  get template() {
    return "systems/limbusCompany_FVTT/templates/actor/character-sheet.hbs";
  }

  /* ─── 数据准备 ──────────────────────────────────────────────────────────── */

  async getData() {
    const context     = await super.getData();
    const actor       = this.actor;
    const system      = actor.system;
    const cfg         = CONFIG.LIMBUSCOMPANY;

    // ── 基础信息 ──────────────────────────────────────────────────────────
    context.system     = system;
    context.config     = cfg;
    context.isGM       = game.user.isGM;
    context.isEditable = this.isEditable;
    this._editUnlocked ??= false;

    // ── 经验/HP/理智百分比 ────────────────────────────────────────────────
    context.xpPercent     = system.xp.next  > 0 ? ((system.xp.value  / system.xp.next)  * 100) : 0;
    context.canLevelUp    = (system.xp.value ?? 0) > (system.xp.next ?? Number.MAX_SAFE_INTEGER);
    context.hpPercent     = system.hp.max   > 0 ? ((system.hp.value   / system.hp.max)   * 100) : 0;
    context.sanityPercent = ((system.sanity.value - 5) / 90) * 100;
    context.isInPanic     = system.sanity.value <= 5;

    // ── 属性列表 ──────────────────────────────────────────────────────────
    context.attributes = cfg.ATTRIBUTES.map(key => ({
      key,
      label: this._getAttributeLabel(key),
      value: system.attributes[key] ?? 0,
    }));

    // ── 装备修正后的基础信息 / 抗性信息 ────────────────────────────────────
    const equippedItems = Object.values(system.equipment ?? {})
      .map(id => (id ? actor.items.get(id) : null))
      .filter(item => item?.type === "equipment");

    const equipAdj = equippedItems.reduce((acc, eq) => {
      acc.atk += Number(eq.system?.atkAdj ?? 0);
      acc.def += Number(eq.system?.defAdj ?? 0);
      acc.speed += Number(eq.system?.speedAdj ?? 0);
      return acc;
    }, { atk: 0, def: 0, speed: 0 });

    // BUFF 层数修正（攻击等级提升/降低、防御等级提升/降低、迅捷/束缚）
    const bStacks = (type) => (system.buffs ?? [])
      .filter(b => b.type === type)
      .reduce((s, b) => s + (b.stacks ?? 0), 0);

    const buffAtkMod   = bStacks("atkLevelUp") - bStacks("atkLevelDown");
    const buffDefMod   = bStacks("defLevelUp")  - bStacks("defLevelDown");
    const buffSpeedMod = bStacks("swift")        - bStacks("bind");

    context.atkTotal = (system.atk.base ?? 0) + (system.atk.extra ?? 0) + equipAdj.atk + buffAtkMod;
    context.defTotal = (system.def.base ?? 0) + (system.def.extra ?? 0) + equipAdj.def + buffDefMod;
    context.speedDisplay = {
      min: (system.speed.min ?? 0) + equipAdj.speed + buffSpeedMod,
      max: (system.speed.max ?? 0) + equipAdj.speed + buffSpeedMod,
    };

    const equippedUpper = equippedItems.find(eq => eq.system?.subtype === "upper");
    context.displayResistances = equippedUpper?.system?.resistanceAdj
      ? {
        slash: equippedUpper.system.resistanceAdj.slash ?? system.resistances.slash,
        blunt: equippedUpper.system.resistanceAdj.blunt ?? system.resistances.blunt,
        pierce: equippedUpper.system.resistanceAdj.pierce ?? system.resistances.pierce,
      }
      : { ...system.resistances };

    const stellarMax = 30 + (system.level ?? 1);
    const equippedStellarCost = this._calcEquippedStellarCost();
    context.footerStellarMax = stellarMax;
    context.footerStellarVal = Math.max(0, stellarMax - equippedStellarCost);

    // ── 九宫格装备槽 ──────────────────────────────────────────────────────
    context.equipmentGrid = [];
    for (let i = 0; i < 9; i++) {
      const id   = system.equipment?.[`slot${i}`] ?? null;
      const item = id ? actor.items.get(id) : null;
      context.equipmentGrid.push({ slotIndex: i, item, itemId: id });
    }

    // ── 技能槽 ────────────────────────────────────────────────────────────
    const basicIds = system.skills?.basic ?? [null, null, null, null, null, null];
    context.basicSkills = basicIds.map((id, idx) => {
      const bItem = id ? actor.items.get(id) : null;
      return {
        slotIndex: idx,
        item:      bItem,
        itemId:    id ?? null,
        skillImg:  bItem?.img ?? "",
      };
    });

    const defItem = system.skills?.defense ? actor.items.get(system.skills.defense) : null;
    context.defenseSkill = {
      item:     defItem,
      itemId:   system.skills?.defense ?? null,
      skillImg: defItem?.img ?? "",
    };

    context.egoSkills = cfg.EGO_GRADES.map(grade => {
      const egoItem = system.skills?.ego?.[grade] ? actor.items.get(system.skills.ego[grade]) : null;
      return {
        grade,
        item:     egoItem,
        itemId:   system.skills?.ego?.[grade] ?? null,
        skillImg: egoItem?.img ?? "",
      };
    });

    // ── 物品分组（物品 Tab） ───────────────────────────────────────────────
    context.itemGroups  = this._groupEquipmentItems();
    // ── 技能分组（技能 Tab） ───────────────────────────────────────────────
    context.skillGroups = this._groupSkillItems();

    // ── BUFF 列表（战斗 Tab） ─────────────────────────────────────────────
    context.buffs = system.buffs ?? [];
    context.buffIcons = _buildBuffIconMap();

    // ── 基础技能战斗槽（6格占位，避免 {{#times}} 未注册问题） ─────────────
    context.basicCombatSlots = [0, 1, 2, 3, 4, 5].map(i => ({ slotIndex: i }));

    // ── 混乱阈值（HP条刻度） ──────────────────────────────────────────────
    context.chaosThresholds = system.chaosThresholds ?? [];

    // ── 战斗行动值显示（3枚硬币） ─────────────────────────────────────────
    context.apCoins = [0, 1, 2].map(i => ({ index: i, active: i < (system.ap.value ?? 0) }));

    // ── 本地过滤状态（不持久化） ──────────────────────────────────────────
    context.filterState = this._filterState ?? { categories: [], links: [] };

    return context;
  }

  /* ─── 技能图标解析辅助 ──────────────────────────────────────────────────── */

  /**
   * 解析技能图标路径：
   * 1. item.img 若为系统/模块/世界路径 → 直接使用
   * 2. 否则根据 sinType + level 自动推导图标
   * 3. 最终回退到 Normalsin.webp
   */
  _resolveSkillImg(item) {
    const base = "systems/limbusCompany_FVTT/assets/icons/Skill/";
    const fallback = `${base}Normalsin.webp`;
    if (!item) return fallback;

    const img = item.img;
    // 自定义路径（系统/模块/世界资源或外部 URL）直接使用
    if (img && (
      img.startsWith("systems/") || img.startsWith("modules/") ||
      img.startsWith("worlds/")  || img.startsWith("http")     ||
      img.startsWith("data:")    || img.startsWith("/")
    )) return img;

    // 根据罪孽类型和等级推导图标
    const sinCapMap = {
      wrath: "Wrath", lust: "Lust", sloth: "Sloth",
      gluttony: "Gluttony", gloom: "Gloom", pride: "Pride", envy: "Envy",
    };
    const sinCap = sinCapMap[item.system?.sinType];
    if (sinCap) {
      const lv = Math.min(3, Math.max(1, parseInt(item.system?.level) || 1));
      return `${base}${sinCap}_lv${lv}.webp`;
    }
    return fallback;
  }

  /* ─── 物品分组辅助 ──────────────────────────────────────────────────────── */

  _groupEquipmentItems() {
    const subtypeOrder = ["weapon", "upper", "lower", "accessory"];
    const labelMap = {
      weapon:    "武器",
      upper:     "上装",
      lower:     "下装",
      accessory: "饰品",
      consumable:"消耗品",
      material:  "材料",
      container: "容器",
    };

    const groups = {};
    const nonSkillTypes = ["equipment", "consumable", "material", "container"];

    for (const item of this.actor.items) {
      if (!nonSkillTypes.includes(item.type)) continue;

      let key;
      if (item.type === "equipment") key = item.system.subtype ?? "weapon";
      else key = item.type;

      if (!groups[key]) groups[key] = { key, label: labelMap[key] ?? key, items: [] };
      groups[key].items.push(this._enrichItemContext(item));
    }

    // Sort by predefined order
    const order = [...subtypeOrder, "consumable", "material", "container"];
    return order
      .filter(k => groups[k])
      .map(k => groups[k]);
  }


  _getAttributeLabel(attrKey) {
    const i18nKey = CONFIG.LIMBUSCOMPANY.ATTRIBUTE_LABELS?.[attrKey] ?? attrKey;
    const localized = game.i18n.localize(i18nKey);
    if (localized !== i18nKey) return localized;

    const fallbackLabels = {
      str: "力量",
      agi: "敏捷",
      con: "体质",
      int: "智力",
      per: "感知",
      cha: "魅力",
    };
    return fallbackLabels[attrKey] ?? localized;
  }

  _groupSkillItems() {
    const groups = {
      basic:   { key: "basic",   label: "基本技能",  items: [] },
      defense: { key: "defense", label: "守备技能",  items: [] },
      ego:     { key: "ego",     label: "E.G.O技能", items: [] },
    };

    for (const item of this.actor.items) {
      if (item.type !== "skill") continue;
      const t = item.system.type ?? "basic";
      if (groups[t]) groups[t].items.push(this._enrichItemContext(item));
    }

    return Object.values(groups).filter(g => g.items.length > 0);
  }

  _enrichItemContext(item) {
    const sys = item.system;
    const cfg = CONFIG.LIMBUSCOMPANY;

    // 罪孽中文标签（直接查表，不依赖 game.i18n）
    const sinLabel = cfg.SIN_LABELS_ZH?.[sys.sinType] ?? (sys.sinType ?? "");

    // 分类中文标签（直接查表，不依赖 game.i18n）
    const catRaw   = sys.category ?? "";
    const catLabel = cfg.CATEGORY_LABELS_ZH?.[catRaw] ?? catRaw;

    return {
      _id:         item.id,
      name:        item.name,
      img:         item.img,
      type:        item.type,
      system:      sys,
      stellarCost: item.getStellarCost?.() ?? 0,
      isEquipped:  this._isItemEquipped(item.id),
      isGridEquipped: this._isItemGridEquipped(item.id),
      isFavorite:  this._favorites.has(item.id),
      sinColor:    cfg.SIN_COLORS?.[sys.sinType] ?? "#E8CAA2",
      sinLabel,
      catLabel,
      skillIcon:   item.img,
    };
  }

  _calcEquippedStellarCost() {
    const sys = this.actor.system;
    let total = 0;

    for (const itemId of Object.values(sys.equipment ?? {})) {
      const item = itemId ? this.actor.items.get(itemId) : null;
      total += item?.getStellarCost?.() ?? 0;
    }

    for (const itemId of (sys.skills?.basic ?? [])) {
      const item = itemId ? this.actor.items.get(itemId) : null;
      total += item?.getStellarCost?.() ?? 0;
    }

    const defenseId = sys.skills?.defense ?? null;
    const defense = defenseId ? this.actor.items.get(defenseId) : null;
    total += defense?.getStellarCost?.() ?? 0;

    for (const itemId of Object.values(sys.skills?.ego ?? {})) {
      const item = itemId ? this.actor.items.get(itemId) : null;
      total += item?.getStellarCost?.() ?? 0;
    }

    return total;
  }

  _isItemGridEquipped(itemId) {
    const sys = this.actor.system;
    return Object.values(sys.equipment ?? {}).includes(itemId);
  }

  _isItemEquipped(itemId) {
    const sys = this.actor.system;
    if (Object.values(sys.equipment ?? {}).includes(itemId)) return true;
    if ((sys.skills?.basic ?? []).includes(itemId)) return true;
    if (sys.skills?.defense === itemId) return true;
    if (Object.values(sys.skills?.ego ?? {}).includes(itemId)) return true;
    return false;
  }

  /* ─── 懒加载的收藏集合 ──────────────────────────────────────────────────── */

  get _favorites() {
    if (!this.__favorites) {
      const stored = this.actor.getFlag("limbusCompany_FVTT", "favorites") ?? [];
      this.__favorites = new Set(stored);
    }
    return this.__favorites;
  }

  /* ─── 事件绑定 ──────────────────────────────────────────────────────────── */

  activateListeners(html) {
    super.activateListeners(html);
    this._applyEditLockState(html);

    // ── 只读操作（非编辑模式也可用） ──────────────────────────────────────

    // 属性鉴定
    html.find(".attr-check-btn").on("click", this._onAttributeCheck.bind(this));

    // 发送聊天框（物品行）
    html.find(".item-send-chat").on("click", this._onSendToChat.bind(this));

    // 发起对抗（技能行）
    html.find(".item-start-clash").on("click", this._onStartClash.bind(this));

    // 悬停 Title 卡片
    html.find(".item-icon[data-item-id]").on("mouseenter", this._onItemHover.bind(this));
    html.find(".item-icon[data-item-id]").on("mouseleave", this._onItemHoverEnd.bind(this));
    html.find(".equip-slot[data-item-id]").on("mouseenter", this._onItemHover.bind(this));
    html.find(".equip-slot[data-item-id]").on("mouseleave", this._onItemHoverEnd.bind(this));
    html.find(".skill-slot-wrap[data-item-id]").on("mouseenter", this._onItemHover.bind(this));
    html.find(".skill-slot-wrap[data-item-id]").on("mouseleave", this._onItemHoverEnd.bind(this));

    // Tab 切换时跟踪当前 tab ID（跨重渲染保持状态）
    html.find(".sheet-tabs .item[data-tab]").on("click", (ev) => {
      this._activeTab = ev.currentTarget.dataset.tab;
      if (this._activeTab === "combat") {
        setTimeout(() => this._syncCombatSlots(this.element), 50);
      }
    });

    // 重渲染后恢复战斗槽（无论当前在哪个 Tab，DOM 元素都存在）：
    // 只要 _combatBagState 存在就恢复，避免 AP/BUFF 等更新触发重渲染时清空槽位。
    if (this._combatBagState) {
      setTimeout(() => this._renderCombatSlots(this.element), 80);
    }

    // ── 非 GM/非编辑：只读分支结束 ────────────────────────────────────────
    if (!this.isEditable) return;

    // ── 锁状态切换 ────────────────────────────────────────────────────────
    html.find(".sheet-lock-toggle").on("click", this._onToggleLock.bind(this));

    // ── 升级按钮（经验值 > 升级阈值） ───────────────────────────────────
    html.find(".level-up-btn").on("click", this._onLevelUpClick.bind(this));

    // ── 长休 ─────────────────────────────────────────────────────────────
    html.find(".long-rest-btn").on("click", () => this.actor.longRest());

    // ── HP / 理智 重置 ───────────────────────────────────────────────────
    html.find(".hp-reset").on("click", () => {
      this.actor.update({ "system.hp.value": this.actor.system.hp.max });
    });
    html.find(".sanity-reset").on("click", () => {
      this.actor.update({ "system.sanity.value": 50 });
    });

    // ── 物品行操作 ────────────────────────────────────────────────────────
    html.find(".item-activate").on("click",   this._onItemActivate.bind(this));
    html.find(".item-favorite").on("click",   this._onItemFavorite.bind(this));
    html.find(".item-more-menu").on("click",  this._onItemContextMenu.bind(this));
    html.find(".item-row .item-name").on("click", this._onItemOpen.bind(this));
    html.find(".item-row .item-icon").on("click", this._onItemOpen.bind(this));

    // ── 装备槽右键菜单 ────────────────────────────────────────────────────
    html.find(".equip-slot[data-item-id]").on("contextmenu", this._onEquipSlotContextMenu.bind(this));

    // ── 技能槽右键菜单 ────────────────────────────────────────────────────
    html.find(".skill-slot-wrap[data-item-id]").on("contextmenu", this._onSkillSlotContextMenu.bind(this));

    // ── 过滤面板 ──────────────────────────────────────────────────────────
    html.find(".filter-toggle-btn").on("click", this._onFilterToggle.bind(this));
    html.find(".filter-category-btn").on("click", this._onFilterCategory.bind(this));
    html.find(".filter-link-btn").on("click", this._onFilterLink.bind(this));
    html.find(".filter-apply-btn").on("click", this._onFilterApply.bind(this));
    html.find(".filter-expand-all").on("click", this._onExpandAll.bind(this));
    html.find(".filter-collapse-all").on("click", this._onCollapseAll.bind(this));
    html.find(".filter-favorite-btn").on("click", this._onFavFilter.bind(this));

    // ── 搜索框 ────────────────────────────────────────────────────────────
    html.find(".item-search").on("input", this._onItemSearch.bind(this));

    // ── 分组折叠 ─────────────────────────────────────────────────────────
    html.find(".group-header").on("click", this._onGroupToggle.bind(this));

    // ── 新建物品 ─────────────────────────────────────────────────────────
    html.find(".item-create-btn").on("click", this._onItemCreate.bind(this));

    // ── 战斗 Tab ─────────────────────────────────────────────────────────
    html.find(".combat-activate-btn").on("click", this._onCombatActivate.bind(this));
    html.find(".combat-clear-btn").on("click",    this._onCombatClear.bind(this));
    html.find(".ap-coin").on("click",             this._onApCoinToggle.bind(this));
    html.find(".ap-reset-btn").on("click",        this._onApReset.bind(this));
    html.find(".ap-clear-btn").on("click",        () => this.actor.update({ "system.ap.value": 0 }));
    html.find(".add-buff-btn").on("click",        this._onAddBuff.bind(this));
    html.find(".buff-trigger").on("click",        this._onBuffTrigger.bind(this));
    html.find(".buff-delete").on("click",         this._onBuffDelete.bind(this));
    html.find(".buff-inline-input").on("change",  this._onBuffInlineEdit.bind(this));

    // ── 战斗技能槽点击 ────────────────────────────────────────────────────
    // 基础技能槽：data-item-id 是运行时动态写入，不能在绑定时用属性选择器过滤
    html.find(".basic-combat-section .combat-skill-slot").on("click", this._onCombatSkillClick.bind(this));
    // EGO / 守备技能槽：data-item-id 由 HBS 模板直接写入，绑定时已存在
    html.find(".ego-combat-section .combat-skill-slot[data-item-id], .combat-defense-slot[data-item-id]")
      .on("click", this._onEgoSkillClick.bind(this));
    html.find(".combat-skill-related-toggle").on("click", this._onRelatedSkillToggle.bind(this));
  }

  /* ─── 拖放处理 ──────────────────────────────────────────────────────────── */

  _onDragStart(event) {
    const dragEl = event.currentTarget;

    // ── 来自九宫格装备槽 ──────────────────────────────────────────────────
    const equipSlotEl = dragEl?.closest?.(".equip-slot[data-item-id]");
    if (equipSlotEl) {
      const itemId = equipSlotEl.dataset.itemId;
      const slotIndex = Number(equipSlotEl.dataset.slot);
      const item = this.actor.items.get(itemId);
      if (!item) return;
      event.dataTransfer.setData("text/plain", JSON.stringify({
        type: "Item",
        uuid: item.uuid,
        fromEquipSlot: Number.isInteger(slotIndex) ? slotIndex : null,
      }));
      return;
    }

    // ── 来自技能槽（基础/EGO/守备） ───────────────────────────────────────
    const skillSlotEl = dragEl?.closest?.(".skill-slot-wrap[data-item-id]");
    if (skillSlotEl) {
      const itemId    = skillSlotEl.dataset.itemId;
      const slotType  = skillSlotEl.dataset.slotType;
      const slotIndex = parseInt(skillSlotEl.dataset.slotIndex ?? "-1");
      const item      = this.actor.items.get(itemId);
      if (!item) return;
      event.dataTransfer.setData("text/plain", JSON.stringify({
        type:              "Item",
        uuid:              item.uuid,
        fromSkillSlotType: slotType,
        fromSkillSlot:     slotType === "basic" ? slotIndex : -1,
      }));
      return;
    }

    return super._onDragStart(event);
  }

  async _onDrop(event) {
    event.preventDefault();
    const data = TextEditor.getDragEventData(event);

    if (data.type === "Item") return this._onDropItem(event, data);
    return super._onDrop(event, data);
  }

  async _onDropItem(event, data) {
    if (!this.isEditable) return;

    // 解析拖入的 item
    const item = await Item.fromDropData(data);
    if (!item) return;

    // 是否已在 actor.items 中
    const ownedItem = this.actor.items.get(item.id) ?? null;

    const $target = $(event.target);

    // ── 拖入九宫格装备槽 ─────────────────────────────────────────────────
    const equipSlot = $target.closest(".equip-slot");
    if (equipSlot.length) {
      const slotIdx = parseInt(equipSlot.data("slot"));
      if (item.type !== "equipment") {
        ui.notifications.warn("只能将装备放入装备栏。");
        return;
      }

      // 装备栏内拖拽：移动（源槽清空）；若目标有装备则交换
      const fromSlot = Number.isInteger(data.fromEquipSlot) ? data.fromEquipSlot : parseInt(data.fromEquipSlot);
      const owned = ownedItem ?? (await this._importItemToActor(item));
      if (!owned) return;

      if (Number.isInteger(fromSlot) && fromSlot >= 0 && fromSlot <= 8) {
        if (fromSlot === slotIdx) return;
        const sourceId = this.actor.system.equipment?.[`slot${fromSlot}`] ?? null;
        if (sourceId === owned.id) {
          const targetId = this.actor.system.equipment?.[`slot${slotIdx}`] ?? null;
          await this.actor.update({
            [`system.equipment.slot${slotIdx}`]: owned.id,
            [`system.equipment.slot${fromSlot}`]: targetId,
          });
          return;
        }
      }

      // 从物品列表拖拽已装备物品：禁止复制装备
      const equippedSlot = Object.entries(this.actor.system.equipment ?? {})
        .find(([, id]) => id === owned.id)?.[0] ?? null;
      if (equippedSlot) {
        ui.notifications.warn("该装备已在九宫格中，请直接拖动九宫格内的装备格进行移动。");
        return;
      }

      // 常规拖入：按装备逻辑处理（含星芒消耗）
      await this.actor.equipToGrid(owned.id, slotIdx);
      return;
    }

    // ── 拖入任意技能槽（统一入口，含类型不匹配警告） ─────────────────────
    const skillSlotWrap = $target.closest(".skill-slot-wrap[data-slot-type]");
    if (skillSlotWrap.length) {
      const slotType = skillSlotWrap.data("slotType");

      // 非技能物品拖入技能槽
      if (item.type !== "skill") {
        ui.notifications.warn("只有技能才能放入技能槽。");
        return;
      }

      // 类型不匹配（如基础技能拖入EGO槽）
      const slotLabelMap = { basic:"基础技能槽", ego:"EGO技能槽", defense:"守备技能槽" };
      const typeLabelMap = { basic:"基础技能",   ego:"EGO技能",   defense:"守备技能" };
      if (item.system.type !== slotType) {
        ui.notifications.warn(
          `${typeLabelMap[item.system.type] ?? "该技能"}无法放入${slotLabelMap[slotType] ?? slotType}。`
        );
        return;
      }

      // ── 基础技能：自由放置到目标槽位 ─────────────────────────────────
      if (slotType === "basic") {
        const owned      = ownedItem ?? await this._importItemToActor(item);
        const targetSlot = parseInt(skillSlotWrap.data("slotIndex") ?? "0");
        const fromSlot   = parseInt(data.fromSkillSlot ?? "-1");
        if (owned) await this.actor.equipSkillToSlot(owned.id, targetSlot, isNaN(fromSlot) ? -1 : fromSlot);
      }
      // ── EGO / 守备：按类型自动匹配槽位 ──────────────────────────────
      else {
        const owned = ownedItem ?? await this._importItemToActor(item);
        if (owned) await this.actor.equipSkill(owned.id);
      }
      return;
    }

    // ── 拖入物品列表：
    // 1) 从装备槽拖回列表 → 视为卸下
    // 2) 从 FVTT 物品目录/其他来源拖入 → 复制一份到角色物品
    const fromSlot = Number.isInteger(data.fromEquipSlot) ? data.fromEquipSlot : parseInt(data.fromEquipSlot);
    const droppedIntoItemList = $target.closest(".item-list-panel").length > 0;
    if (droppedIntoItemList) {
      if (Number.isInteger(fromSlot) && fromSlot >= 0 && fromSlot <= 8) {
        await this.actor.unequipFromGrid(fromSlot);
        return;
      }
      const fromSkillSlot = Number.isInteger(data.fromSkillSlot)
        ? data.fromSkillSlot
        : parseInt(data.fromSkillSlot ?? "-1");
      const fromOwnedSlots = data.fromSkillSlotType || (Number.isInteger(fromSkillSlot) && fromSkillSlot >= 0);
      if (!fromOwnedSlots) {
        await this._importItemToActor(item, { forceDuplicate: true });
        return;
      }
    }

    // ── 默认：添加物品到 actor ────────────────────────────────────────────
    if (!ownedItem) {
      await this._importItemToActor(item, { forceDuplicate: false });
    }
  }

  async _importItemToActor(item, { forceDuplicate = false } = {}) {
    const itemData = item.toObject();
    if (forceDuplicate || this.actor.items.get(itemData._id)) delete itemData._id;
    const created = await Item.create(itemData, { parent: this.actor });
    return created;
  }

  /* ─── 鉴定对话框 ────────────────────────────────────────────────────────── */

  async _onAttributeCheck(event) {
    const attr = event.currentTarget.dataset.attr;
    const attrVal = this.actor.system.attributes[attr] ?? 0;
    const label = this._getAttributeLabel(attr);

    const { AttributeCheckDialog } = await import("../helpers/dice.mjs").catch(() => ({ AttributeCheckDialog: null }));
    if (AttributeCheckDialog) {
      return AttributeCheckDialog.show(this.actor, attr, attrVal, label);
    }

    // Fallback: 简易骰子弹窗
    const content = `
      <div class="limbuscompany check-dialog">
        <p><strong>${label}鉴定</strong>（属性值：${attrVal}）</p>
        <div class="form-group">
          <label>加值修正</label>
          <input type="number" name="bonus" value="0" style="width:60px"/>
        </div>
      </div>`;

    new Dialog({
      title: `${label}鉴定`,
      content,
      buttons: {
        roll: {
          label: "鉴定",
          callback: async (html) => {
            const bonus = parseInt(html.find("[name='bonus']").val()) || 0;
            const coins  = Math.max(2, attrVal + bonus);
            // 每枚硬币：Roll 1d2，≥2 = 正面
            const rollFormula = Array.from({ length: coins }, () => "1d2").join("+");
            const roll = new Roll(rollFormula);
            await roll.evaluate();
            const heads = roll.terms.reduce((sum, t, i) => {
              if (i % 2 !== 0) return sum; // operator terms
              return sum + (t.results?.filter(r => r.result >= 2).length ?? 0);
            }, 0);

            // 实际统计正面
            let headCount = 0;
            for (const term of roll.terms) {
              if (term.results) {
                headCount += term.results.filter(r => r.result >= 2).length;
              }
            }

            const difficulty = attrVal; // 难度 = 属性值
            let resultText, resultClass;
            if (headCount > difficulty)      { resultText = "成功";     resultClass = "result-success"; }
            else if (headCount === difficulty){ resultText = "完美成功"; resultClass = "result-perfect"; }
            else                             { resultText = "失败";     resultClass = "result-fail"; }

            const COIN_FACE = "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_正面.webp";
            const COIN_TAIL = "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_反面.webp";
            // Collect per-coin results
            const coinResults = [];
            for (const term of roll.terms) {
              if (!term.results) continue;
              for (const r of term.results) {
                coinResults.push(r.result >= 2);
              }
            }
            const coinRowHtml = coinResults.map(isHeads =>
              `<img src="${isHeads ? COIN_FACE : COIN_TAIL}" width="28" height="28"
                    class="${isHeads ? "coin-heads" : "coin-tails"}" alt="${isHeads ? "正面" : "反面"}">`
            ).join("");

            const actorImg  = this.actor.img || "icons/svg/mystery-man.svg";
            const ownerUser = game.users?.find(u => !u.isGM && u.character?.id === this.actor.id);
            const playerName = ownerUser?.name ?? this.actor.name ?? game.user?.name ?? "未知玩家";

            ChatMessage.create({
              speaker: ChatMessage.getSpeaker({ actor: this.actor }),
              content: `
              <div class="limbus-check-card ${resultClass}">
                <div class="check-card-header">
                  <img class="check-actor-avatar" src="${actorImg}" alt="${this.actor.name}">
                  <div class="check-actor-info">
                    <div class="check-title">${label}鉴定结果</div>
                    <div class="check-player">${playerName}</div>
                  </div>
                </div>
                <div class="check-gold-divider"></div>
                <div class="check-difficulty-text">难度等级 <span class="check-difficulty-num">${difficulty}</span></div>
                <div class="check-result-text">${resultText}</div>
                <div class="check-coins-label">骰掷结果</div>
                <div class="check-coin-row">${coinRowHtml}</div>
                <div class="check-gold-divider"></div>
              </div>`,
            });
          },
        },
      },
      default: "roll",
    }).render(true);
  }

  /* ─── 物品操作 ──────────────────────────────────────────────────────────── */

  async _onSendToChat(event) {
    const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;
    item.sendToChat?.() ?? item.toMessage?.();
  }

  async _onStartClash(event) {
    const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;

    // 显示发起对抗弹窗
    await this._showClashDialog(item);
  }

  async _showClashDialog(item, slotIndex = -1) {
    await ClashManager.showInitiateDialog(this.actor, item, slotIndex);
  }

  async _onItemActivate(event) {
    const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;
    if (item.type === "equipment") {
      const isActive = item.system.active ?? false;
      await item.update({ "system.active": !isActive });
    }
  }

  async _onItemFavorite(event) {
    const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
    const favs   = new Set(this.actor.getFlag("limbusCompany_FVTT", "favorites") ?? []);
    if (favs.has(itemId)) favs.delete(itemId);
    else favs.add(itemId);
    await this.actor.setFlag("limbusCompany_FVTT", "favorites", [...favs]);
    this.__favorites = favs;
  }

  _onItemContextMenu(event) {
    event.preventDefault();
    const el     = event.currentTarget.closest("[data-item-id]");
    const itemId = el?.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;
    this._showItemContextMenu(event, item);
  }

  _onItemOpen(event) {
    const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    item?.sheet?.render(true);
  }

  /* ─── 装备槽右键菜单 ────────────────────────────────────────────────────── */

  _onEquipSlotContextMenu(event) {
    event.preventDefault();
    const slot   = event.currentTarget;
    const itemId = slot.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;

    const slotIdx = parseInt(slot.dataset.slot);
    const menuItems = [
      { name: "卸下",      icon: "<i class='fas fa-times'></i>",     callback: () => this.actor.unequipFromGrid(slotIdx) },
      { name: "查看/编辑", icon: "<i class='fas fa-edit'></i>",      callback: () => item.sheet.render(true) },
      { name: "激活",      icon: "<i class='fas fa-bolt'></i>",      callback: () => item.update({ "system.active": !(item.system.active ?? false) }) },
      { name: "发送聊天框",icon: "<i class='fas fa-comment'></i>",   callback: () => item.sendToChat?.() },
    ];
    this._renderContextMenu(event, menuItems);
  }

  _onSkillSlotContextMenu(event) {
    event.preventDefault();
    const wrap   = event.currentTarget;
    const itemId = wrap.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;

    const menuItems = [
      { name: "卸下",      icon: "<i class='fas fa-times'></i>",   callback: () => this.actor.unequipSkill(itemId) },
      { name: "查看/编辑", icon: "<i class='fas fa-edit'></i>",    callback: () => item.sheet.render(true) },
      { name: "发起对抗",  icon: "<i class='fas fa-swords'></i>",  callback: () => this._showClashDialog(item) },
      { name: "发送聊天框",icon: "<i class='fas fa-comment'></i>", callback: () => item.sendToChat?.() },
    ];
    this._renderContextMenu(event, menuItems);
  }

  _showItemContextMenu(event, item) {
    const menuItems = [
      { name: "查看/编辑", icon: "<i class='fas fa-edit'></i>",    callback: () => item.sheet.render(true) },
      { name: "发送聊天框",icon: "<i class='fas fa-comment'></i>", callback: () => item.sendToChat?.() },
      { name: "删除",      icon: "<i class='fas fa-trash'></i>",   callback: () => item.delete() },
    ];
    this._renderContextMenu(event, menuItems);
  }

  _renderContextMenu(event, items) {
    // 移除已有菜单
    $(".limbus-context-menu").remove();

    const menu = $('<nav class="limbus-context-menu context-menu"></nav>');
    for (const item of items) {
      const li = $(`<li class="context-item">${item.icon} ${item.name}</li>`);
      li.on("click", (e) => { e.stopPropagation(); menu.remove(); item.callback(); });
      menu.append(li);
    }

    menu.css({ position: "fixed", left: event.clientX, top: event.clientY, zIndex: 99999 });
    $("body").append(menu);

    // 点击其他区域关闭
    const close = (e) => { if (!$(e.target).closest(".limbus-context-menu").length) { menu.remove(); $(document).off("click", close); } };
    setTimeout(() => $(document).on("click", close), 10);
  }

  /* ─── 搜索 & 过滤 ───────────────────────────────────────────────────────── */

  _onItemSearch(event) {
    const query = event.target.value.toLowerCase().trim();
    const panel = $(event.target).closest(".sheet-body").find(".item-list-panel, .skill-list-panel");
    panel.find(".item-row, .skill-row").each((_, row) => {
      const name = $(row).find(".item-name").text().toLowerCase();
      $(row).toggle(!query || name.includes(query));
    });
  }

  _onFilterToggle(event) {
    const panel = $(event.currentTarget).closest(".list-toolbar").find(".filter-panel");
    panel.toggle();
  }

  _onFilterCategory(event) {
    const btn = $(event.currentTarget);
    btn.toggleClass("active");
  }

  _onFilterLink(event) {
    const btn = $(event.currentTarget);
    btn.toggleClass("active");
  }

  _onFilterApply(event) {
    const panel    = $(event.currentTarget).closest(".filter-panel");
    const cats     = panel.find(".filter-category-btn.active").map((_, b) => $(b).data("category")).get();
    const links    = panel.find(".filter-link-btn.active").map((_, b)    => $(b).data("dir")).get();
    this._filterState = { categories: cats, links };

    const listPanel = $(event.currentTarget).closest(".tab").find(".item-list-panel, .skill-list-panel");
    listPanel.find(".item-row, .skill-row").each((_, row) => {
      const $row    = $(row);
      const cat     = $row.data("subtype") ?? $row.data("type") ?? "";
      const rowLinks = ($row.data("links") ?? "").split(",").filter(Boolean);

      const catOk  = !cats.length  || cats.includes(cat);
      const linkOk = !links.length || links.some(l => rowLinks.includes(l));
      $row.toggle(catOk && linkOk);
    });

    panel.hide();
  }

  _onExpandAll(event) {
    $(event.currentTarget).closest(".tab").find(".group-body").show();
    $(event.currentTarget).closest(".tab").find(".group-header .group-toggle").text("▼");
  }

  _onCollapseAll(event) {
    $(event.currentTarget).closest(".tab").find(".group-body").hide();
    $(event.currentTarget).closest(".tab").find(".group-header .group-toggle").text("▶");
  }

  _onFavFilter(event) {
    const btn   = $(event.currentTarget);
    const on    = btn.toggleClass("active").hasClass("active");
    const panel = $(event.currentTarget).closest(".tab").find(".item-list-panel, .skill-list-panel");
    if (!on) {
      panel.find(".item-row, .skill-row").show();
    } else {
      panel.find(".item-row, .skill-row").each((_, row) => {
        const id = $(row).data("item-id");
        $(row).toggle(this._favorites.has(id));
      });
    }
  }

  _onGroupToggle(event) {
    const header = $(event.currentTarget);
    const body   = header.next(".group-body");
    const arrow  = header.find(".group-toggle");
    if (body.is(":visible")) { body.hide(); arrow.text("▶"); }
    else                     { body.show(); arrow.text("▼"); }
  }

  /* ─── 新建物品 ──────────────────────────────────────────────────────────── */

  async _onItemCreate(event) {
    const tab    = $(event.currentTarget).closest(".tab").data("tab");
    const isSkill = tab === "skills";
    await Item.create({
      name: isSkill ? "新技能" : "新物品",
      type: isSkill ? "skill" : "equipment",
    }, { parent: this.actor });
  }

  /* ─── 战斗 Tab ──────────────────────────────────────────────────────────── */

  _onCombatActivate(event) {
    this._combatBagState = null;
    this._activeTab = "combat";
    this._syncCombatSlots(this.element);
  }

  _onCombatClear(event) {
    this._combatBagState = null;
    this._renderCombatSlots(this.element);
  }

  _syncCombatSlots(html) {
    if (!this._combatBagState) {
      // 初始化 6-bag：从已装备的基础技能随机打乱，分配到0-5槽
      const basicIds = (this.actor.system.skills?.basic ?? []).filter(Boolean);
      if (!basicIds.length) return;

      // 第一包：显示用（6个槽位）
      const bag1 = [...basicIds].sort(() => Math.random() - 0.5);
      // 第二包：预备池（用于补充）
      const bag2 = [...basicIds].sort(() => Math.random() - 0.5);

      this._combatBagState = {
        equipped:    basicIds,          // 装备的6个技能 ID
        slots:       bag1.slice(0, 6), // 当前6个显示槽 [0..5]
        pool:        bag2,             // 预备池（下一轮抽取来源）
        relatedMode: {},               // slotIndex → true 时显示相关技能
      };
    }
    this._renderCombatSlots(html);
  }

  _renderCombatSlots(html) {
    const state = this._combatBagState;
    const basicSlots = html.find(".basic-combat-section .combat-skill-slot-wrap");
    const defaultImg = "systems/limbusCompany_FVTT/assets/icons/Skill/Normalsin.webp";

    if (!state) {
      // 无激活状态：全部显示为空槽
      basicSlots.each((i, wrap) => {
        const $wrap = $(wrap);
        const $slot = $wrap.find(".combat-skill-slot");
        $slot.find("img").attr("src", defaultImg).show();
        $slot.attr("data-item-id", "");
        $slot.removeClass("slot-active slot-reserve slot-bag").addClass("slot-empty");
        $wrap.find(".slot-state-dot").removeClass("dot-active dot-reserve");
        $wrap.find(".combat-skill-related-toggle").hide();
        $wrap.find(".combat-slot-name").text("");
      });
      return;
    }

    const ap = this.actor.system.ap?.value ?? 0;

    basicSlots.each((i, wrap) => {
      const $wrap   = $(wrap);
      const $slot   = $wrap.find(".combat-skill-slot");
      const $dot    = $wrap.find(".slot-state-dot");
      const $toggle = $wrap.find(".combat-skill-related-toggle");
      const $name   = $wrap.find(".combat-slot-name");
      const id      = state.slots[i] ?? null;

      // 主技能
      const mainItem = id ? this.actor.items.get(id) : null;

      $slot.find("img").attr("src", mainItem?.img ?? "");
      $slot.attr("data-item-id", id ?? "");
      $slot.attr("data-slot-index", i);

      // 名称（截短显示）
      if ($name.length) $name.text(mainItem ? mainItem.name : "");

      // 状态样式：0,1 = 激活（金色），2 = 预备（暗红），3-5 = bag
      $slot.removeClass("slot-active slot-reserve slot-bag slot-empty slot-no-ap");
      $dot.removeClass("dot-active dot-reserve");

      if (id) {
        if (i < 2) {
          $slot.addClass("slot-active");
          $dot.addClass("dot-active");
          // AP 不足时添加视觉提示（金框保留但加灰化）
          if (ap <= 0) $slot.addClass("slot-no-ap");
        } else if (i === 2) {
          $slot.addClass("slot-reserve");
          $dot.addClass("dot-reserve");
        } else {
          $slot.addClass("slot-bag");
        }
      } else {
        $slot.addClass("slot-empty");
      }

      // 罪孽色内发光（激活槽）
      const sinColor = CONFIG.LIMBUSCOMPANY?.SIN_COLORS?.[mainItem?.system?.sinType] ?? "";
      $slot.css("--slot-sin-color", (sinColor && i < 2) ? sinColor : "");

      // 相关技能切换按钮（激活槽且有关联技能时显示）
      const hasRelated = !!(mainItem?.system?.relatedSkill?.itemUuid);
      const showToggle = hasRelated && i < 2;
      $toggle.toggle(showToggle);

      // 若处于相关技能模式，用相关技能图标/名称覆盖
      if (showToggle && state.relatedMode?.[i]) {
        const relUuid = mainItem.system.relatedSkill.itemUuid;
        const relItem = typeof fromUuidSync !== "undefined" ? fromUuidSync(relUuid) : null;
        if (relItem) {
          $slot.find("img").attr("src", relItem.img ?? "");
          if ($name.length) $name.text(relItem.name ?? "");
        }
        $toggle.addClass("related-active");
      } else {
        $toggle.removeClass("related-active");
      }
    });
  }

  // 从 pool 中取下一张牌补充到 slots[5]
  _drawNextFromPool() {
    const state = this._combatBagState;
    if (!state) return null;
    if (state.pool.length === 0) {
      // pool 耗尽，重新洗牌 equipped
      state.pool = [...state.equipped].sort(() => Math.random() - 0.5);
    }
    return state.pool.shift() ?? null;
  }

  // 带动画地使用指定激活槽技能（仅 slotIndex = 0 或 1）
  _animateCombatSkillUse(slotIndex) {
    if (!this.element?.length) return;

    // 每个阶段都通过 this.element 实时查询，避免因重渲染导致引用失效
    const _wraps = () => this.element.find(".basic-combat-section .combat-skill-slot-wrap");

    const $wraps = _wraps();
    if (slotIndex >= $wraps.length) return;

    const state = this._combatBagState;
    if (!state || !state.slots[slotIndex]) return;

    const $usedSlot = $wraps.eq(slotIndex).find(".combat-skill-slot");

    // 计算单格宽度（含 gap）用于位移
    let slotOuterW = 58; // 默认 52px + 6px gap
    if ($wraps.length > 1) {
      const r0 = $wraps.eq(0)[0].getBoundingClientRect();
      const r1 = $wraps.eq(1)[0].getBoundingClientRect();
      slotOuterW = Math.round(r1.left - r0.left) || slotOuterW;
    }

    // ── 第1阶段：使用槽向上飞出 ─────────────────────────────────────────
    $usedSlot.css({
      transition: "transform 0.28s cubic-bezier(.4,0,.6,1), opacity 0.25s ease",
      transform:  "translateY(-64px) scale(0.75)",
      opacity:    "0",
    });

    // ── 第2阶段（140ms后）：右侧槽向左滑 ───────────────────────────────
    setTimeout(() => {
      const $w = _wraps();
      for (let i = slotIndex + 1; i < $w.length; i++) {
        $w.eq(i).css({
          transition: "transform 0.22s ease",
          transform:  `translateX(-${slotOuterW}px)`,
        });
      }
    }, 140);

    // ── 第3阶段（310ms后）：更新状态，重渲染，新牌淡入 ──────────────────
    setTimeout(() => {
      // 更新 bag 状态
      state.slots.splice(slotIndex, 1);
      const nextId = this._drawNextFromPool();
      state.slots.push(nextId);   // 补充到位置5

      // 重置所有 transform（不带动画）
      const $w2 = _wraps();
      $w2.each((_, el) => $(el).css({ transition: "none", transform: "" }));

      // 静态重渲染（应用最新状态）
      this._renderCombatSlots(this.element);

      // ── 第4阶段：新槽在位置5淡入 ─────────────────────────────────────
      const $newSlot = _wraps().eq(5).find(".combat-skill-slot");
      $newSlot.css({ opacity: "0", transform: "scale(0.7)" });

      // 双帧延迟确保浏览器处理完上面的状态变更
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          $newSlot.css({
            transition: "opacity 0.35s ease, transform 0.35s ease",
            opacity:    "1",
            transform:  "scale(1)",
          });
          setTimeout(() => $newSlot.css({ transition: "", transform: "" }), 380);
        });
      });
    }, 310);
  }

  _onCombatSkillClick(event) {
    const $slot = $(event.currentTarget);
    // 仅激活槽（0, 1）响应点击
    if (!$slot.hasClass("slot-active")) return;
    const itemId = $slot.attr("data-item-id");
    if (!itemId) return;

    // AP 不足时拦截，保留视觉状态但阻止操作
    if ((this.actor.system.ap?.value ?? 0) <= 0) {
      ui.notifications?.warn("行动值不足，无法使用技能");
      return;
    }

    const slotIndex = parseInt($slot.attr("data-slot-index") ?? "0");
    const state = this._combatBagState;

    // 若处于相关技能显示模式，使用相关技能；否则使用主技能
    let item = this.actor.items.get(itemId);
    if (!item) return;
    if (state?.relatedMode?.[slotIndex] && item.system?.relatedSkill?.itemUuid) {
      const relUuid = item.system.relatedSkill.itemUuid;
      const relItem = typeof fromUuidSync !== "undefined" ? fromUuidSync(relUuid) : null;
      if (relItem) item = relItem;
    }

    this._showClashDialog(item, slotIndex);
  }

  _onEgoSkillClick(event) {
    // EGO / 守备技能：直接发起对抗，不推进 bag，不消耗行动值
    const itemId = event.currentTarget.dataset.itemId;
    if (!itemId) return;
    const item = this.actor.items.get(itemId);
    if (!item) return;
    this._showClashDialog(item, -1);  // slotIndex = -1 → 不触发 bag 动画/AP 消耗
  }

  _onRelatedSkillToggle(event) {
    event.stopPropagation();
    const $btn   = $(event.currentTarget);
    const $wrap  = $btn.closest(".combat-skill-slot-wrap");
    const $slot  = $wrap.find(".combat-skill-slot");
    const slotIndex = parseInt($slot.attr("data-slot-index") ?? "0");

    const state = this._combatBagState;
    if (!state) return;
    if (!state.relatedMode) state.relatedMode = {};

    const isNowRelated = !state.relatedMode[slotIndex];
    state.relatedMode[slotIndex] = isNowRelated;
    $btn.toggleClass("related-active", isNowRelated);

    // 取主技能和相关技能，更新槽位显示
    const mainId   = state.slots[slotIndex];
    const mainItem = mainId ? this.actor.items.get(mainId) : null;
    if (!mainItem) return;

    let displayItem = mainItem;
    if (isNowRelated) {
      const relUuid = mainItem.system?.relatedSkill?.itemUuid;
      const relItem = relUuid && typeof fromUuidSync !== "undefined" ? fromUuidSync(relUuid) : null;
      if (relItem) displayItem = relItem;
    }

    $slot.find("img").attr("src", displayItem.img ?? "");
    $wrap.find(".combat-slot-name").text(displayItem.name ?? "");
  }

  /* ─── 行动值（AP） ──────────────────────────────────────────────────────── */

  async _onApCoinToggle(event) {
    const idx     = parseInt(event.currentTarget.dataset.index);
    const current = this.actor.system.ap.value;
    // 点击已使用硬币 → 恢复；点击未使用硬币 → 使用
    const newVal  = idx < current ? idx : idx + 1;
    await this.actor.update({ "system.ap.value": Math.min(3, Math.max(0, newVal)) });
  }

  async _onApReset(event) {
    await this.actor.update({ "system.ap.value": this.actor.system.ap.max });
  }

  /* ─── BUFF 管理 ─────────────────────────────────────────────────────────── */

  async _onAddBuff(event) {
    const cfg      = CONFIG.LIMBUSCOMPANY;
    const groups   = cfg.BUFF_GROUPS;
    const allBuffs = cfg.BUFF_TYPES;

    // 构建选项 HTML（分组）
    const buildGroupOptions = () => {
      const sections = [
        { label: "增益",   keys: groups.positive },
        { label: "减益",   keys: groups.negative },
        { label: "特殊",   keys: groups.special },
        { label: "其他",   keys: groups.other },
      ];
      return sections.map(sec =>
        `<optgroup label="${sec.label}">${sec.keys.map(k => `<option value="${k}">${_buffLabel(k)}</option>`).join("")}</optgroup>`
      ).join("");
    };

    const content = `
      <div class="limbuscompany add-buff-dialog">
        <div class="form-group">
          <label>选择BUFF</label>
          <select name="buffType">${buildGroupOptions()}</select>
        </div>
        <div class="form-group custom-buff-row" style="display:none">
          <label>自定义BUFF</label>
          <input type="text" name="customName" placeholder="输入文本"/>
        </div>
        <div class="form-group">
          <label>回合</label>
          <select name="whenAdded">
            <option value="本回合">本回合</option>
            <option value="下回合">下回合</option>
          </select>
        </div>
        <div class="form-group inline-row">
          <label>强度</label><input type="number" name="intensity" value="1" min="0" style="width:60px"/>
          <label style="margin-left:8px">层数</label><input type="number" name="stacks" value="1" min="0" style="width:60px"/>
        </div>
      </div>`;

    const dlg = new Dialog({
      title: "添加新的状态BUFF",
      content,
      buttons: {
        add: {
          label: "添加",
          callback: async (html) => {
            const type      = html.find("[name='buffType']").val();
            const custom    = html.find("[name='customName']").val();
            const whenAdded = html.find("[name='whenAdded']").val();
            const intensity = parseInt(html.find("[name='intensity']").val()) || 1;
            const stacks    = parseInt(html.find("[name='stacks']").val())    || 1;
            const name      = type === "custom" ? (custom || "自定义") : _buffLabel(type);

            await this.actor.addBuff({ type, name, intensity, stacks, whenAdded,
              icon: _buffIconPath(type) });
          },
        },
        cancel: { label: "取消" },
      },
      default: "add",
    });

    dlg.render(true);

    // 监听 select 变化显示/隐藏自定义输入
    setTimeout(() => {
      const sel = dlg.element?.find("[name='buffType']");
      sel?.on("change", (e) => {
        dlg.element.find(".custom-buff-row").toggle(e.target.value === "custom");
      });
    }, 50);
  }

  async _onBuffTrigger(event) {
    const buffId = event.currentTarget.closest("[data-buff-id]")?.dataset.buffId;
    const buff   = this.actor.system.buffs?.find(b => b.id === buffId);
    if (!buff) return;

    const actor     = this.actor;
    const intensity = buff.intensity ?? 0;
    const stacks    = buff.stacks    ?? 0;

    switch (buff.type) {

      // ── 流血 / 破裂 / 燃烧：受到强度点固定伤害，层数 -1 ─────────────────
      case "bleed":
      case "rupture":
      case "burn": {
        const oldHp = actor.system.hp?.value ?? 0;
        const newHp = Math.max(0, oldHp - intensity);
        await actor.update({ "system.hp.value": newHp });
        await actor.reduceBuffStacks(buff.type);
        if (actor.checkAndTriggerChaos) await actor.checkAndTriggerChaos(newHp, oldHp);
        ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div class="limbuscompany chat-clash">
            <strong>${actor.name}</strong>【${buff.name}】触发：受到 <strong>${intensity}</strong> 点固定伤害。
            （HP ${oldHp} → ${newHp}）
          </div>`,
        });
        break;
      }

      // ── 沉沦：理智 -强度，层数 -1 ────────────────────────────────────────
      case "sinking": {
        const oldSan = actor.system.sanity?.value ?? 50;
        const newSan = Math.max(5, oldSan - intensity);
        await actor.setSanity(oldSan - intensity);
        await actor.reduceBuffStacks("sinking");
        ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div class="limbuscompany chat-clash">
            <strong>${actor.name}</strong>【沉沦】触发：理智 -${intensity}。
            （理智 ${oldSan} → ${newSan}）
          </div>`,
        });
        break;
      }

      // ── 震颤：混乱阈值前移强度值，层数 -1 ───────────────────────────────
      case "tremor": {
        await actor.triggerSeismicBlast(intensity);
        await actor.reduceBuffStacks("tremor");
        ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div class="limbuscompany chat-clash">
            <strong>${actor.name}</strong>【震颤】引爆：混乱阈值前移 <strong>${intensity}%</strong>。
          </div>`,
        });
        break;
      }

      // ── 充能：消耗 1 层 ───────────────────────────────────────────────────
      case "charge": {
        await actor.reduceBuffStacks("charge");
        ui.notifications.info(`${actor.name}【充能】消耗 1 层（剩余 ${Math.max(0, stacks - 1)} 层）`);
        break;
      }

      // ── 其他 BUFF：仅提示，不执行效果 ────────────────────────────────────
      default:
        ui.notifications.info(`触发 【${buff.name}】 强度:${intensity} 层数:${stacks}`);
        break;
    }
  }

  async _onBuffDelete(event) {
    const buffId = event.currentTarget.closest("[data-buff-id]")?.dataset.buffId;
    await this.actor.removeBuff(buffId);
  }

  async _onBuffInlineEdit(event) {
    if (!this._editUnlocked) return;
    const input  = event.currentTarget;
    const buffId = input.dataset.buffId;
    const field  = input.dataset.field;
    const value  = parseInt(input.value) || 0;
    const buffs  = (this.actor.system.buffs ?? []).map(b =>
      b.id === buffId ? { ...b, [field]: value } : b
    );
    await this.actor.update({ "system.buffs": buffs });
  }

  async _onLevelUpClick(event) {
    event.preventDefault();
    await this.actor.levelUpByXp?.();
  }

  /* ─── 编辑锁 ─────────────────────────────────────────────────────────────── */

  _onToggleLock(event) {
    event.preventDefault();
    this._editUnlocked = !this._editUnlocked;
    this._applyEditLockState(this.element);
  }

  _applyEditLockState(html) {
    const root = html && html.find ? html : this.element;
    if (!root?.length) return;

    const lockBtn = root.find(".sheet-lock-toggle");
    if (this._editUnlocked) {
      lockBtn.removeClass("locked").html('<i class="fas fa-lock-open"></i>');
      root.find(".editable-field").prop("disabled", false);
      root.find(".editable-only").show();
    } else {
      lockBtn.addClass("locked").html('<i class="fas fa-lock"></i>');
      root.find(".editable-field").prop("disabled", true);
      root.find(".editable-only").hide();
    }

    // 星芒固定不可编辑
    root.find("[name='system.stellarMotes.value']").prop("disabled", true);
  }

  /* ─── Title 卡片（悬停） ────────────────────────────────────────────────── */

  _onItemHover(event) {
    const el     = event.currentTarget;
    const itemId = el.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;

    // 防止重复生成
    this._onItemHoverEnd();
    this._titleCard = this._buildTitleCard(item);

    const rect     = this.element[0].getBoundingClientRect();
    const cardW    = 280; // --card-width ≈ 17.5rem at 16px
    const left     = rect.left - cardW - 8;
    const top      = Math.max(8, rect.top);

    this._titleCard.css({ position: "fixed", left: Math.max(8, left), top, zIndex: 99998 });
    $("body").append(this._titleCard);
  }

  _onItemHoverEnd() {
    this._titleCard?.remove();
    this._titleCard = null;
  }

  _buildTitleCard(item) {
    const sys = item.system;
    const cfg = CONFIG.LIMBUSCOMPANY;
    const sinColor = cfg.SIN_COLORS?.[sys.sinType] ?? "#5F3E21";

    if (item.type === "skill") {
      const costHtml = item.type === "skill" && sys.type === "ego"
        ? `<div class="tc-stellar"><i class="fas fa-star-half-alt"></i> ${item.getStellarCost?.() ?? 0}</div>`
        : `<div class="tc-stellar"><i class="fas fa-star"></i> ${item.getStellarCost?.() ?? 0}</div>`;

      return $(`<div class="limbus-title-card limbus-title-card-skill">
        <div class="tc-header" style="background:${sinColor}">${item.name}</div>
        <div class="tc-row2">
          <img src="${_getCategoryIcon(sys.category)}" width="18" height="18" alt="type">
          <span class="tc-formula">${(sys.diceFormula ?? "").toUpperCase()}</span>
          <span class="tc-tags">${(Array.isArray(sys.tags) ? sys.tags : (sys.tags ?? "").split("/")).filter(Boolean).map(t => `<span class="tag">${String(t).trim()}</span>`).join("")}</span>
        </div>
        ${sys.weight ? `<div class="tc-weight">${Array.from({length: sys.weight ?? 0}, () => '<span class="weight-sq"></span>').join("")}</div>` : ""}
        <div class="tc-desc">${sys.effectDesc ?? item.system.description ?? ""}</div>
        <div class="tc-footer">${costHtml}</div>
      </div>`);
    }

    // Equipment / other
    const linksHtml = Object.entries(sys.links ?? {})
      .filter(([_, v]) => v)
      .map(([k]) => `<span class="tc-link-arrow link-${k}"></span>`)
      .join("");

    return $(`<div class="limbus-title-card limbus-title-card-equip">
      <div class="tc-header tc-equip-header">
        <span>${item.name}</span>
        <span class="tc-links">${linksHtml}</span>
      </div>
      <div class="tc-row2">${_subtypeLabel(sys.subtype ?? item.type)}　${sys.category ?? ""}</div>
      <div class="tc-desc">${sys.description ?? ""}</div>
      <div class="tc-footer-small">鼠标中间用来编辑/查看</div>
      <div class="tc-footer"><i class="fas fa-star"></i> ${sys.stellarCost ?? 0}</div>
    </div>`);
  }
}

/* ─── 模块级辅助函数 ─────────────────────────────────────────────────────── */

function _buildBuffIconMap() {
  const base = "systems/limbusCompany_FVTT/assets/icons/Buff_icon/";
  const map  = {
    strong:        "强壮.webp",   weak:          "虚弱.webp",
    endure:        "忍耐.webp",   breach:        "破绽.webp",
    swift:         "迅捷.webp",   bind:          "束缚.webp",
    guard:         "守护.webp",   fragile:       "易损.webp",
    clashPowerUp:  "拼点威力提升.webp", clashPowerDown: "拼点威力降低.webp",
    atkLevelUp:    "攻击等级提升.webp", atkLevelDown:   "攻击等级降低.webp",
    defLevelUp:    "防御等级提升.webp", defLevelDown:   "防御等级降低.webp",
    burn:          "烧伤.webp",   bleed:         "流血.webp",
    tremor:        "震颤.webp",   rupture:       "破裂.webp",
    sinking:       "沉沦.webp",   breathing:     "呼吸法.webp",
    charge:        "充能.webp",   chaos:         "陷入混乱.webp",
    panic:         "陷入恐慌.webp",
  };
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, base + v]));
}

function _buffLabel(type) {
  const labels = {
    strong:"强壮", weak:"虚弱", endure:"忍耐", breach:"破绽",
    swift:"迅捷", bind:"束缚", guard:"守护", fragile:"易损",
    clashPowerUp:"拼点威力提升", clashPowerDown:"拼点威力降低",
    atkLevelUp:"攻击等级提升",   atkLevelDown:"攻击等级降低",
    defLevelUp:"防御等级提升",   defLevelDown:"防御等级降低",
    burn:"烧伤", bleed:"流血", tremor:"震颤", rupture:"破裂",
    sinking:"沉沦", breathing:"呼吸法", charge:"充能",
    chaos:"陷入混乱", panic:"陷入恐慌", custom:"自定义",
  };
  return labels[type] ?? type;
}

function _buffIconPath(type) {
  const base = "systems/limbusCompany_FVTT/assets/icons/Buff_icon/";
  const map  = { strong:"强壮", weak:"虚弱", endure:"忍耐", breach:"破绽",
    swift:"迅捷", bind:"束缚", guard:"守护", fragile:"易损",
    burn:"烧伤", bleed:"流血", tremor:"震颤", rupture:"破裂",
    sinking:"沉沦", breathing:"呼吸法", charge:"充能",
    chaos:"陷入混乱", panic:"陷入恐慌" };
  return map[type] ? `${base}${map[type]}.webp` : "";
}

function _getCategoryIcon(category) {
  return CONFIG.LIMBUSCOMPANY?.CATEGORY_ICON_PATHS?.[category] ?? "";
}

function _subtypeLabel(subtype) {
  return { weapon:"武器", upper:"上装", lower:"下装", accessory:"饰品",
           consumable:"消耗品", material:"材料", container:"容器" }[subtype] ?? subtype;
}

