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
import { CustomBuffRegistry, resolveBuffHandler, normalizeBuffType } from "../helpers/custom-buffs.mjs";
import { BAG_COLS, BAG_ROWS, getBagItems, packBagGrid } from "../helpers/bag-grid.mjs";
import { GridDnD } from "../helpers/grid-dnd.mjs";
import { autoPlace, canPlace, makeLockedSet } from "../helpers/grid-layout.mjs";
import { canContainerAccept, wouldNest } from "../helpers/container-rules.mjs";
import { buildItemTitleCard, closeTitleCardUnlessLocked, toggleTitleCardLock } from "./item-sheet.mjs";
import { ClashVFX } from "../helpers/clash-vfx.mjs";
import { QuickActionHUD } from "./quick-action-hud.mjs";
import { refreshReadySlots } from "../helpers/ready-sparkle.mjs";

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
      height:   860,
      tabs:     [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "items" }],
      dragDrop: [{ dragSelector: ".equip-slot[data-item-id], .skill-slot-wrap[data-item-id], .item-row .item-icon, .skill-row .item-icon", dropSelector: ".equip-grid, .item-list-panel, .skill-list-panel, .basic-skill-slots, .ego-skill-grid, .defense-skill-slot" }],
      scrollY:  [".item-list-panel", ".skill-list-panel", ".buff-list"],
    });
  }

  get template() {
    // 【角色卡·改良版外观（调试）】：设置里打开时换用并行的试验模板。
    // 两套模板复用同一批 parts（header / tab-items / tab-skills / tab-combat），
    // 功能逻辑与监听完全一致，只有外框和样式不同。
    let redesign = false;
    try { redesign = !!game.settings.get("limbusCompany_FVTT", "sheetRedesign"); }
    catch { /* 设置未注册时用旧版 */ }
    return redesign
      ? "systems/limbusCompany_FVTT/templates/actor/character-sheet-redesign.hbs"
      : "systems/limbusCompany_FVTT/templates/actor/character-sheet.hbs";
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

    // ── 背景（name-row-top：未设置显示"添加背景"，否则显示背景名称） ──────
    const bgUuid = system.background?.uuid ?? "";
    context.backgroundName = bgUuid
      ? (await fromUuid(bgUuid).catch(() => null))?.name ?? "（背景已失效）"
      : "";

    // ── 经验/HP/理智百分比 ────────────────────────────────────────────────
    context.xpPercent     = system.xp.next  > 0 ? ((system.xp.value  / system.xp.next)  * 100) : 0;
    context.canLevelUp    = (system.xp.value ?? 0) > (system.xp.next ?? Number.MAX_SAFE_INTEGER);
    context.hpPercent     = system.hp.max   > 0 ? ((system.hp.value   / system.hp.max)   * 100) : 0;
    // 护盾：叠加在血条右侧，超出血量上限部分也显示
    const shieldBuff      = (system.buffs ?? []).find(b => b.type === "shield");
    const shieldStacks    = shieldBuff?.stacks ?? 0;
    const effectiveMax    = system.hp.max > 0 ? system.hp.max : 1;
    context.shieldStacks  = shieldStacks;
    // 护盾条宽度 = min(shieldStacks, max) / max * 100，右移 = hpPercent
    context.shieldWidth   = Math.min(shieldStacks, effectiveMax) / effectiveMax * 100;
    context.shieldOffset  = context.hpPercent; // 护盾条从HP末端开始
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

    // 抗性显示与战斗结算共用同一逻辑（混乱强制值 > 自定义BUFF modifyResistances > 上装覆盖 > 基础值）
    context.displayResistances = ClashManager._getEffectiveResistances(actor);

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

    // ── 形象（纸娃娃）视图 ────────────────────────────────────────────────
    // 与九宫格共用左栏，同一份 equipment 槽位数据的两种画法。
    // 摆放参数存在装备自己身上（EquipmentData.doll），脱下再穿会保留。
    // 形象系统总开关（设置里默认关闭）：关掉时左栏只有九宫格
    let dollOn = false;
    try { dollOn = !!game.settings.get("limbusCompany_FVTT", "dollSystem"); }
    catch { /* 设置未注册时按关闭处理 */ }
    context.dollEnabled = dollOn;
    if (!dollOn) { this._dollView = false; this._dollEdit = false; }

    context.dollView = this._dollView ?? false;
    context.dollEdit = this._dollEdit ?? false;
    context.dollMode = this._dollMode ?? "move";
    context.dollModeLabel = { move: "移动", rotate: "旋转", scale: "缩放" }[context.dollMode] ?? "移动";
    if (context.dollView) {
      const DEF = CONFIG.LIMBUSCOMPANY?.DOLL_DEFAULTS ?? {};
      context.dollLayers = context.equipmentGrid
        .filter(e => e.item && e.item.type === "equipment")
        .map(e => {
          const d   = e.item.system?.doll ?? {};
          // 没亲手摆过就用按子类型的默认位（config.mjs 的 DOLL_DEFAULTS）
          const def = DEF[e.item.system?.subtype ?? ""] ?? {};
          const placed = !!d.placed;
          return {
            itemId: e.item.id,
            name:   e.item.name,
            img:    e.item.img,
            slot:   e.slotIndex,
            x:     placed ? (d.x ?? 50) : (def.x ?? 50),
            y:     placed ? (d.y ?? 50) : (def.y ?? 50),
            scale: placed ? (d.scale ?? 1) : (def.scale ?? 1),
            rot:   placed ? (d.rot ?? 0)   : (def.rot ?? 0),
            w:     def.w ?? 42,
            // 没单独设过层级就用默认层级，再退回槽位顺序（先装的在下面）
            z: (d.z ?? 0) || def.z || e.slotIndex,
            hidden: !!d.hidden,
            selected: this._dollSel === e.item.id,
          };
        })
        .sort((a, b) => a.z - b.z);
      // 头：单独一张图，永远压在所有装备之上（z 固定给个大数）
      const h    = system.dollHead ?? {};
      const hDef = DEF.head ?? {};
      context.dollHead = {
        img: h.img ?? "",
        x: h.x ?? hDef.x ?? 50, y: h.y ?? hDef.y ?? 22,
        scale: h.scale ?? 1, rot: h.rot ?? 0, w: hDef.w ?? 30,
        selected: this._dollSel === "__head__",
      };
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
        frameImg:  this._resolveFrameImg(bItem, "basic"),
      };
    });

    const defItem = system.skills?.defense ? actor.items.get(system.skills.defense) : null;
    context.defenseSkill = {
      item:     defItem,
      itemId:   system.skills?.defense ?? null,
      skillImg: defItem?.img ?? "",
      frameImg: this._resolveFrameImg(defItem, "defense"),
    };

    context.egoSkills = cfg.EGO_GRADES.map(grade => {
      const egoItem   = system.skills?.ego?.[grade] ? actor.items.get(system.skills.ego[grade]) : null;
      return {
        grade,
        item:       egoItem,
        itemId:     system.skills?.ego?.[grade] ?? null,
        skillImg:   egoItem?.img ?? "",
        frameImg:   this._resolveFrameImg(egoItem, "ego"),
      };
    });

    // ── 物品分组（物品 Tab） ───────────────────────────────────────────────
    context.itemGroups  = this._groupEquipmentItems();
    // ── 背包容量（物品 Tab） ───────────────────────────────────────────────
    const INVENTORY_MAX = BAG_COLS * BAG_ROWS; // 角色背包固定 5×8
    const inventoryUsed = this._calcInventoryCapacity();
    context.inventoryMax  = INVENTORY_MAX;
    context.inventoryUsed = inventoryUsed;
    context.inventoryOverCapacity = inventoryUsed > INVENTORY_MAX;
    // 物品 Tab 网格视图（工具栏切换按钮）
    context.itemGridView = this._itemGridView ?? false;
    if (context.itemGridView) {
      context.bagGrid = packBagGrid(getBagItems(actor), BAG_COLS, BAG_ROWS,
                                    actor.system?.bagLayout ?? []);
      context.bagGrid.cols = BAG_COLS;
      // GridDnD 的碰撞检测直接读这份渲染结果，免得再算一遍
      this._bagGridCache = context.bagGrid;
      // 没有坐标记录的物品（新捡到的、刚从容器里拿出来的）本次是自动补位的，
      // 把补位结果落成记录——否则下次渲染会重新首适应，挪动一件物品会连带
      // 把别的物品也重排一遍（"自动排序"的观感就是从这儿来的）。
      this._persistBagLayout(context.bagGrid);
    }
    // ── 技能分组（技能 Tab） ───────────────────────────────────────────────
    context.skillGroups = this._groupSkillItems();

    // ── BUFF 列表（战斗 Tab） ─────────────────────────────────────────────
    context.buffs = (system.buffs ?? []).map(b => ({
      ...b,
      icon:        _buffIconPath(b.type, b.name),
      description: CustomBuffRegistry.get(b.type)?.description ?? "",
    }));
    context.buffIcons = _buildBuffIconMap();

    // ── 基础技能战斗槽（6格占位，避免 {{#times}} 未注册问题） ─────────────
    context.basicCombatSlots = [0, 1, 2, 3, 4, 5].map(i => ({ slotIndex: i }));

    // ── 混乱阈值（HP条刻度） ──────────────────────────────────────────────
    context.chaosThresholds = system.chaosThresholds ?? [];

    // ── 战斗行动值显示（行动值无上限，至少画 3 枚硬币） ──────────────────
    const apVal = system.ap.value ?? 0;
    context.apCoins = Array.from({ length: Math.max(3, apVal) },
      (_, i) => ({ index: i, active: i < apVal }));

    // ── 罪孽抗性（战斗 Tab 显示，供 EGO 修改后实时刷新） ─────────────────
    const SINS = cfg.SINS ?? ["wrath","lust","sloth","gluttony","gloom","pride","envy"];
    const SIN_ICON_BASE = "systems/limbusCompany_FVTT/assets/icons/Base_icon/";
    context.sinResistances = SINS.map(sin => ({
      sin,
      label:    cfg.SIN_LABELS_ZH?.[sin] ?? sin,
      icon:     `${SIN_ICON_BASE}${sin.charAt(0).toUpperCase() + sin.slice(1)}_icon.webp`,
      color:    cfg.SIN_COLORS?.[sin] ?? "#E8C9A2",
      value:    system.egoResistances?.[sin] ?? "x1.0",
      field:    `system.egoResistances.${sin}`,
    }));
    context.resistanceValues = cfg.RESISTANCE_VALUES ?? ["x0.5","x1.0","x2.0","x2.5","x3.0"];

    // ── 恐慌类型槽位（战斗 Tab 罪孽抗性下方） ────────────────────────────
    context.panicSlots = [
      { key: "lowMorale", label: "士气低落" },
      { key: "panic",     label: "陷入恐慌" },
    ].map(s => {
      const id   = system.panicSlots?.[s.key] ?? "";
      const item = id ? actor.items.get(id) : null;
      return { ...s, item: item ? { id: item.id, name: item.name, img: item.img } : null };
    });

    // ── 恐慌/坚定计数（角色所有者+GM 可手动调整） ────────────────────────
    context.panicCounters = {
      fear:    system.panicCounters?.fear    ?? 0,
      resolve: system.panicCounters?.resolve ?? 0,
    };
    context.canEditPanicCounters = actor.isOwner;

    // ── 本地过滤状态（不持久化） ──────────────────────────────────────────
    context.filterState = this._filterState ?? { categories: [] };

    return context;
  }

  /* ─── 技能图标 / 框架图解析辅助 ───────────────────────────────────────────── */

  /**
   * 解析技能框架图路径（叠加在技能图标上方的环形装饰）。
   * @param {Item|null} item  技能物品
   * @param {"basic"|"ego"|"defense"} slotType  槽位类型
   * @returns {string}  图片路径
   */
  _resolveFrameImg(item, slotType = "basic") {
    const BASE = "systems/limbusCompany_FVTT/assets/icons/Skill/";
    // EGO 槽固定用圆形框（有技能时也一样）
    if (slotType === "ego") return `${BASE}E.G.O.webp`;
    // 空槽 / 无罪孽类型 → 通用框
    if (!item || !item.system?.sinType) return `${BASE}Normalsin.webp`;
    const sinCapMap = {
      wrath:"Wrath", lust:"Lust", sloth:"Sloth",
      gluttony:"Gluttony", gloom:"Gloom", pride:"Pride", envy:"Envy",
    };
    const sinCap = sinCapMap[item.system.sinType];
    if (!sinCap) return `${BASE}Normalsin.webp`;
    const lv = Math.min(3, Math.max(1, parseInt(item.system?.level) || 1));
    return `${BASE}${sinCap}_lv${lv}.webp`;
  }

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

  /** 返回所有被放入容器内的物品 UUID Set（这些物品不计入背包容量）。 */
  _getItemsInContainers() {
    const inContainer = new Set();
    for (const item of this.actor.items) {
      if (item.type !== "container") continue;
      for (const p of (item.system?.contents ?? [])) {
        if (p?.uuid) inContainer.add(p.uuid);
      }
    }
    return inContainer;
  }

  _calcInventoryCapacity() {
    const inContainer  = this._getItemsInContainers();
    let total = 0;
    const nonSkillTypes = ["equipment", "consumable", "material", "container", "skillbook", "background"];
    for (const item of this.actor.items) {
      if (!nonSkillTypes.includes(item.type)) continue;
      if (inContainer.has(item.uuid)) continue; // 容器内物品不占背包容量
      const cap = item.system?.capacity;
      total += (cap?.w ?? 1) * (cap?.h ?? 1);
    }
    return total;
  }

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
      skillbook: "技能书",
      background: "背景",
    };

    const groups = {};
    const nonSkillTypes  = ["equipment", "consumable", "material", "container", "skillbook", "background"];
    const inContainer    = this._getItemsInContainers();

    for (const item of this.actor.items) {
      if (!nonSkillTypes.includes(item.type)) continue;
      if (inContainer.has(item.uuid)) continue; // 容器内物品不出现在列表

      let key;
      if (item.type === "equipment") key = item.system.subtype ?? "weapon";
      else key = item.type;

      if (!groups[key]) groups[key] = { key, label: labelMap[key] ?? key, items: [] };
      groups[key].items.push(this._enrichItemContext(item));
    }

    // Sort by predefined order
    const order = [...subtypeOrder, "consumable", "material", "container", "skillbook", "background"];
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

    const capW = sys.capacity?.w ?? 1;
    const capH = sys.capacity?.h ?? 1;

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
      sinIconPath: cfg.SIN_ICON_PATHS?.[sys.sinType] ?? "",
      catLabel,
      skillIcon:   item.img,
      capacityLabel: `${capW}×${capH}`,
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

  /** 读取 footer-stellar-val 判断剩余星芒是否能负担 item 的费用 */
  _checkStellarBudget(item) {
    const remaining = parseInt(this.element?.find(".footer-stellar-val").text()) || 0;
    const cost = item.getStellarCost?.() ?? 0;
    if (cost > remaining) {
      ui.notifications.warn(`星芒不足：需要 ${cost}，当前剩余 ${remaining}`);
      return false;
    }
    return true;
  }

  /**
   * 列表里双击一行：已装备 → 卸下；未装备 → 自动找空位装上。
   * 找不到空位就什么都不做（不替换已有装备，避免误覆盖）。
   * @param {Event}  event
   * @param {string} kind "skill" | "item"
   */
  async _onQuickToggleEquip(event, kind) {
    event.preventDefault();
    const itemId = event.currentTarget.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;

    const sys = this.actor.system;

    if (kind === "skill" || item.type === "skill") {
      // 已装备 → 卸下
      if (this._isItemEquipped(itemId)) return this.actor.unequipSkill(itemId);
      if (item.system?.noEquip) {
        ui.notifications.warn(`【${item.name}】无法装备，只能通过【相关技能转换】替换上场。`);
        return;
      }
      const type = item.system?.type;
      if (type === "basic") {
        const slots = sys.skills?.basic ?? [];
        if (!slots.some(s => !s)) return;                    // 六格已满 → 不执行
      } else if (type === "defense") {
        if (sys.skills?.defense) return;                     // 守备槽已占 → 不执行
      } else if (type === "ego") {
        const grade = item.system?.egoDiceRating;
        if (!grade || sys.skills?.ego?.[grade]) return;      // 对应等级已占 → 不执行
      } else return;
      if (!this._checkStellarBudget(item)) return;
      return this.actor.equipSkill(itemId);
    }

    // ── 装备：九宫格 ──────────────────────────────────────────────────
    if (item.type !== "equipment") return;
    const equipped = Object.entries(sys.equipment ?? {}).find(([, id]) => id === itemId);
    if (equipped) {
      const idx = parseInt(String(equipped[0]).replace("slot", ""));
      if (Number.isInteger(idx)) return this.actor.unequipFromGrid(idx);
      return;
    }
    // 找第一个空格；没有空格就不执行
    const freeSlot = [...Array(9).keys()].find(i => !sys.equipment?.[`slot${i}`]);
    if (freeSlot === undefined) return;
    if (!this._checkStellarBudget(item)) return;
    return this.actor.equipToGrid(itemId, freeSlot);
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

  /**
   * Tab 选中指示条：整条金线在三个 Tab 之间滑动，而不是各自淡入淡出。
   * 位置只靠 nav 上的 --tab-i / --tab-n 两个 CSS 变量表达，动画交给 CSS transition。
   */
  _bindTabIndicator(html) {
    const nav = html.find("nav.sheet-tabs")[0];
    if (!nav) return;
    const items = [...nav.querySelectorAll(".item")];
    if (!items.length) return;

    const sync = () => {
      const i = Math.max(0, items.findIndex(el => el.classList.contains("active")));
      nav.style.setProperty("--tab-n", items.length);
      nav.style.setProperty("--tab-i", i);
    };

    // 首次定位不要有滑动动画（否则每次重开卡都会从最左边扫过来）
    nav.classList.add("tab-nav-init");
    sync();
    requestAnimationFrame(() => nav.classList.remove("tab-nav-init"));

    // 点击后 Foundry 才会改 .active，等一帧再读
    items.forEach(el => el.addEventListener("click", () => requestAnimationFrame(sync)));
  }

  activateListeners(html) {
    super.activateListeners(html);
    this._applyEditLockState(html);
    this._bindTabIndicator(html);

    // ── 只读操作（非编辑模式也可用） ──────────────────────────────────────

    // 属性鉴定
    html.find(".attr-check-btn").on("click", this._onAttributeCheck.bind(this));

    // 背景：未设置 → 打开创建向导；已设置 → 打开背景物品卡；右键 → 查看/删除
    html.find('[data-action="open-background-wizard"]').on("click", this._onOpenBackgroundWizard.bind(this));
    html.find('[data-action="open-background-item"]').on("click", this._onOpenBackgroundItem.bind(this));
    html.find('[data-action="open-background-item"]').on("contextmenu", this._onBackgroundContextMenu.bind(this));

    // 发送聊天框（物品行）
    html.find(".item-send-chat").on("click", this._onSendToChat.bind(this));

    // 发起对抗（技能行）
    html.find(".item-start-clash").on("click", this._onStartClash.bind(this));

    // 悬停 Title 卡片
    html.find(".item-icon[data-item-id]").on("mouseenter", this._onItemHover.bind(this));
    html.find(".item-icon[data-item-id]").on("mouseleave", () => this._onItemHoverEnd());
    html.find(".equip-slot[data-item-id]").on("mouseenter", this._onItemHover.bind(this));
    html.find(".equip-slot[data-item-id]").on("mouseleave", () => this._onItemHoverEnd());
    html.find(".skill-slot-wrap[data-item-id]").on("mouseenter", this._onItemHover.bind(this));
    html.find(".skill-slot-wrap[data-item-id]").on("mouseleave", () => this._onItemHoverEnd());
    // ── 双击快速装备 / 卸下 ────────────────────────────────────────────
    // 双击行内的操作按钮（发起对抗/收藏/更多…）不触发，避免误操作
    html.find(".skill-row[data-item-id]").on("dblclick", (ev) => {
      if ($(ev.target).closest(".action-btn, button").length) return;
      this._onQuickToggleEquip(ev, "skill");
    });
    html.find(".item-row[data-item-id]").on("dblclick", (ev) => {
      if ($(ev.target).closest(".action-btn, button").length) return;
      if ($(ev.currentTarget).hasClass("skill-row")) return;   // 技能行已在上面处理
      this._onQuickToggleEquip(ev, "item");
    });
    // 槽位上双击 = 卸下
    html.find(".equip-slot[data-item-id]").on("dblclick", (ev) => {
      const slotIdx = parseInt(ev.currentTarget.dataset.slot ?? "-1");
      if (slotIdx >= 0) this.actor.unequipFromGrid(slotIdx);
    });
    html.find(".skill-slot-wrap[data-item-id]").on("dblclick", (ev) => {
      const itemId = ev.currentTarget.dataset.itemId;
      if (itemId) this.actor.unequipSkill(itemId);
    });

    // 图标本身也能中键锁定 Title 卡，不必先把鼠标挪到卡片上
    html.find(".item-icon[data-item-id], .equip-slot[data-item-id], .skill-slot-wrap[data-item-id]")
      .on("mousedown", (ev) => {
        if (ev.button !== 1) return;
        ev.preventDefault();
        toggleTitleCardLock(this._titleCard);
      });

    // Tab 切换时跟踪当前 tab ID（跨重渲染保持状态）
    html.find(".sheet-tabs .item[data-tab]").on("click", (ev) => {
      this._activeTab = ev.currentTarget.dataset.tab;
      // 旧模板的战斗 Tab 写作「战斗」，改良版写作 combat——两个都认
      if (this._activeTab === "combat" || this._activeTab === "战斗") {
        setTimeout(() => this._syncCombatSlots(this.element), 50);
      }
    });

    // 重渲染后恢复战斗槽（无论当前在哪个 Tab，DOM 元素都存在）：
    // 只要 _combatBagState 存在就恢复，避免 AP/BUFF 等更新触发重渲染时清空槽位。
    // 同步执行（activateListeners 早于 DOM 注入）：以前用 setTimeout(80) 会让槽位
    // 先按模板默认图渲染一帧、80ms 后才换成真正的技能图 —— 改理智/行动值这种
    // 频繁重渲染时就表现为【基础技能】闪一下。
    if (this._combatBagState) this._renderCombatSlots(html);

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
      const sys = this.actor.system;
      const defaultThresholds = sys.getDefaultChaosThresholds?.()
        ?? [{ percent: 60, triggered: false }, { percent: 30, triggered: false }];
      this.actor.update({
        "system.hp.value":        sys.hp.max,
        "system.chaosThresholds": defaultThresholds,
      });
    });
    html.find(".sanity-reset").on("click", () => {
      this.actor.update({ "system.sanity.value": 50 });
    });

    // ── 物品行操作 ────────────────────────────────────────────────────────
    html.find(".item-activate").on("click",   this._onItemActivate.bind(this));
    html.find(".item-learn-skillbook").on("click", this._onSkillBookLearn.bind(this));
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
    html.find(".filter-apply-btn").on("click", this._onFilterApply.bind(this));
    html.find(".filter-expand-all").on("click", this._onExpandAll.bind(this));
    html.find(".filter-collapse-all").on("click", this._onCollapseAll.bind(this));

    // ── 恐慌类型槽位（战斗 Tab）──────────────────────────────────────────
    html.find(".panic-slot").on("dragover", (e) => {
      e.preventDefault();
      $(e.currentTarget).addClass("cg-drag-over");
    });
    html.find(".panic-slot").on("dragleave", (e) => $(e.currentTarget).removeClass("cg-drag-over"));
    html.find(".panic-slot").on("drop", this._onPanicSlotDrop.bind(this));
    html.find(".panic-slot").on("dblclick", (e) => {
      const slot = e.currentTarget.dataset.slot;
      const id   = this.actor.system.panicSlots?.[slot] ?? "";
      this.actor.items.get(id)?.sheet?.render(true);
    });
    html.find(".panic-slot").on("contextmenu", async (e) => {
      e.preventDefault();
      const slot = e.currentTarget.dataset.slot;
      const id   = this.actor.system.panicSlots?.[slot] ?? "";
      if (!id) return;
      const item = this.actor.items.get(id);
      const confirmed = await Dialog.confirm({
        title:   "移除恐慌卡",
        content: `<p>确定移除【${item?.name ?? "恐慌卡"}】？（将从角色身上删除）</p>`,
      });
      if (!confirmed) return;
      await this.actor.update({ [`system.panicSlots.${slot}`]: "" });
      if (item) await item.delete();
    });

    // ── 恐慌/坚定计数圆点（角色所有者+GM 可点击） ─────────────────────────
    html.find(".panic-counter-dot:not(.readonly)").on("click", async (e) => {
      const side  = e.currentTarget.dataset.side;   // "fear" | "resolve"
      const index = parseInt(e.currentTarget.dataset.index);
      const cur   = this.actor.system.panicCounters?.[side] ?? 0;
      // 点击已点亮的最高位 = 点熄（退回 index-1）；否则点亮到 index
      const next  = cur === index ? index - 1 : index;
      await this.actor.setPanicCounter?.(side, next);
    });

    // ── 物品 Tab：左栏 九宫格 ↔ 形象 ────────────────────────────────────
    html.find(".doll-view-toggle").on("click", () => {
      this._dollView = !(this._dollView ?? false);
      if (!this._dollView) this._dollEdit = false;
      this.render(false);
    });
    html.find(".doll-edit-toggle").on("click", () => {
      this._dollEdit = !(this._dollEdit ?? false);
      this._dollMode = "move";
      this.render(false);
    });
    this._bindDollEditor(html);

    // ── 物品 Tab：网格/列表视图切换 ──────────────────────────────────────
    html.find(".item-view-toggle").on("click", () => {
      this._itemGridView = !(this._itemGridView ?? false);
      this.render(false);
    });
    // 网格视图图块：拖拽（标准 Item 数据，可拖入营地仓库等）+ 双击打开
    html.find(".bag-cg .cg-item-tile").on("dragstart", (event) => {
      this._onItemHoverEnd(true); // 拖动开始即强制关闭 Title 卡（忽略锁定）
      const uuid = event.currentTarget.dataset.itemUuid ?? "";
      event.originalEvent.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid }));
      event.originalEvent.dataTransfer.effectAllowed = "move";
    });
    html.find(".bag-cg .cg-item-tile").on("dblclick", (event) => {
      const item = this.actor.items.get(event.currentTarget.dataset.itemId ?? "");
      item?.sheet?.render(true);
    });
    // 网格视图图块：悬停 Title 卡（复用现有 _buildTitleCard，显示在角色卡左侧）
    html.find(".bag-cg .cg-item-tile").on("mouseenter", (event) => {
      const item = this.actor.items.get(event.currentTarget.dataset.itemId ?? "");
      if (!item) return;
      this._onItemHoverEnd(true);
      this._titleCard = this._buildTitleCard(item);
      if (!this._titleCard) return;
      const rect  = this.element[0].getBoundingClientRect();
      const cardW = 280, cardH = 500;
      let left = rect.left - cardW - 8;
      if (left < 8) left = rect.right + 8;
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - cardH - 8));
      this._titleCard.css({ position: "fixed", left, top, zIndex: 99998 });
      $("body").append(this._titleCard);
      this._finalizeTitleCard();
    });
    html.find(".bag-cg .cg-item-tile").on("mouseleave", () => this._onItemHoverEnd());
    html.find(".bag-cg .cg-item-tile").on("mousedown", (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      toggleTitleCardLock(this._titleCard);
    });
    // 网格视图：拖到容器图块上 = 自动寻位存入容器
    html.find(".bag-cg .cg-item-tile.cg-tile-container").on("dragover", (event) => {
      event.preventDefault();
      event.originalEvent.dataTransfer.dropEffect = "move";
    });
    html.find(".bag-cg .cg-item-tile.cg-tile-container").on("drop", this._onBagTileDropOnContainer.bind(this));
    // 背包格：接住 GridDnD 合成的 drop（自由摆放的落点写进 system.bagLayout）
    html.find(".bag-cg .cg-cell").on("dragover", (ev) => ev.preventDefault());
    html.find(".bag-cg .cg-cell").on("drop", this._onBagCellDrop.bind(this));
    // pointer 自绘拖放：幽灵 / 落点预览 / R 旋转
    const bagRoot = html.find(".bag-cg")[0];
    if (bagRoot) {
      const grid = this._bagGridCache ?? null;
      GridDnD.register(bagRoot, {
        key:        `bag:${this.actor.uuid}`,
        cols:       BAG_COLS,
        rows:       grid?.rows ?? BAG_ROWS,
        editable:   () => this.isEditable,
        placements: () => (grid?.tiles ?? []).map(t => ({ x: t.x, y: t.y, w: t.w, h: t.h })),
        // 悬停在容器图块上时：这个容器收不收拖着的这件东西（红框即不收）
        tileAccepts: (tileEl, payload) => {
          const box = this.actor.items.get(tileEl.dataset.itemId ?? "");
          if (!box || !payload.itemMeta) return true;
          return canContainerAccept(box, payload.itemMeta).ok;
        },
        payloadFor: (tile) => {
          const id = tile.dataset.itemId ?? "";
          if (!id) return null;
          const idx = (grid?.tiles ?? []).findIndex(t => t.id === id);
          const doc = this.actor.items.get(id);
          return {
            itemMeta: {
              type:   doc?.type ?? "",
              system: { category: doc?.system?.category ?? "", subtype: doc?.system?.subtype ?? "" },
            },
            type: "Item",
            uuid: tile.dataset.itemUuid ?? "",
            x: parseInt(tile.dataset.x ?? 0),
            y: parseInt(tile.dataset.y ?? 0),
            w: parseInt(tile.dataset.w ?? 1),
            h: parseInt(tile.dataset.h ?? 1),
            placementIdx: idx,
            fromBag: { actorId: this.actor.id, itemId: id },
          };
        },
      });
    }
    html.find(".filter-favorite-btn").on("click", this._onFavFilter.bind(this));

    // ── 搜索框 ────────────────────────────────────────────────────────────
    html.find(".item-search").on("input", this._onItemSearch.bind(this));

    // ── 分组折叠 ─────────────────────────────────────────────────────────
    html.find(".group-header").on("click", this._onGroupToggle.bind(this));

    // ── 新建物品 ─────────────────────────────────────────────────────────
    html.find(".item-create-btn").on("click", this._onItemCreate.bind(this));

    // ── 战斗 Tab ─────────────────────────────────────────────────────────
    html.find(".roll-initiative-btn").on("click",  () => this.actor.rollSpeedInitiative());
    html.find(".combat-activate-btn").on("click", this._onCombatActivate.bind(this));
    html.find(".combat-clear-btn").on("click",    this._onCombatClear.bind(this));
    html.find(".ap-coin").on("click",             this._onApCoinToggle.bind(this));
    html.find(".ap-reset-btn").on("click",        this._onApReset.bind(this));
    html.find(".ap-clear-btn").on("click",        () => this.actor.update({ "system.ap.value": 0 }));
    html.find(".add-buff-btn").on("click",        this._onAddBuff.bind(this));
    html.find(".buff-trigger").on("click",        this._onBuffTrigger.bind(this));
    html.find(".buff-delete").on("click",         this._onBuffDelete.bind(this));
    html.find(".buff-inline-input").on("change",  this._onBuffInlineEdit.bind(this));
    // 罪孽抗性下拉直接写入 actor
    html.find(".sin-resist-select").on("change", async (ev) => {
      const name = ev.currentTarget.name;   // e.g. "system.egoResistances.wrath"
      const val  = ev.currentTarget.value;
      if (name && val) await this.actor.update({ [name]: val });
    });

    // ── 战斗技能槽点击 ────────────────────────────────────────────────────
    // 基础技能槽：data-item-id 是运行时动态写入，不能在绑定时用属性选择器过滤
    html.find(".basic-combat-section .combat-skill-slot").on("click", this._onCombatSkillClick.bind(this));
    // EGO / 守备技能槽：data-item-id 由 HBS 模板直接写入，绑定时已存在
    html.find(".ego-combat-section .combat-skill-slot[data-item-id], .combat-defense-slot[data-item-id]")
      .on("click", this._onEgoSkillClick.bind(this));

    // ── 战斗技能槽悬浮 Title 卡（事件委托，兼容动态写入的 data-item-id）────
    html.find(".tab[data-tab='战斗']")
      .on("mouseenter", ".combat-skill-slot[data-item-id]", (ev) => this._onCombatSlotHover(ev))
      .on("mouseleave", ".combat-skill-slot[data-item-id]", ()   => this._onItemHoverEnd())
      .on("mousedown", ".combat-skill-slot[data-item-id]", (ev) => {
        if (ev.button !== 1) return;
        ev.preventDefault();
        toggleTitleCardLock(this._titleCard);
      });
  }

  /* ─── 拖放处理 ──────────────────────────────────────────────────────────── */

  /**
   * 把拖拽残影换成一张干净的物品图标。
   *
   * 两个坑：
   * ① 不设 setDragImage 时，浏览器会把被拖元素**整个盒子**截图当残影——技能槽外面
   *    裹着 skill-slot-wrap → skill-slot-octa → 220% 的边框图好几层，拖出来是一坨方块。
   * ② 直接把槽位里那张 img 传给 setDragImage 同样不行：它带着
   *    position:absolute + translate(-50%,-50%) + clip-path(七边形)，
   *    Chrome 生成残影时会把这些一起算进去，仍然得到一个偏移的大方框。
   * 因此这里另外造一张脱离样式的临时 img（只有 src 和尺寸），用完即弃。
   *
   * @param {DragEvent}   event
   * @param {HTMLElement} el   被拖的槽位元素
   * @param {string}      src  图标路径
   */
  _setIconDragImage(event, el, src) {
    if (!src || !event.dataTransfer?.setDragImage) return;
    const size  = 48;
    const ghost = document.createElement("img");
    ghost.src = src;
    Object.assign(ghost.style, {
      position: "fixed",
      top:      "-1000px",     // 挪到屏幕外，只为让浏览器能把它渲染成残影
      left:     "-1000px",
      width:    `${size}px`,
      height:   `${size}px`,
      objectFit: "contain",
      pointerEvents: "none",
    });
    document.body.appendChild(ghost);
    try {
      event.dataTransfer.setDragImage(ghost, size / 2, size / 2);
    } catch (err) { /* 极少数浏览器不支持，回落到默认残影 */ }
    // 残影在 dragstart 结束时已被截取，随后即可移除
    setTimeout(() => ghost.remove(), 0);
  }

  _onDragStart(event) {
    const dragEl = event.currentTarget;

    // ── 来自九宫格装备槽 ──────────────────────────────────────────────────
    const equipSlotEl = dragEl?.closest?.(".equip-slot[data-item-id]");
    if (equipSlotEl) {
      const itemId = equipSlotEl.dataset.itemId;
      const slotIndex = Number(equipSlotEl.dataset.slot);
      const item = this.actor.items.get(itemId);
      if (!item) return;
      this._setIconDragImage(event, equipSlotEl, item.img);
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
      this._setIconDragImage(event, skillSlotEl, item.img);
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

    // ── 世界金库取出：无 UUID，itemData 携带完整物品数据 ─────────────────────
    if (data.fromContainer?.isWorldContainer) {
      const { containerId, placementIdx } = data.fromContainer;
      const $target = $(event.target);
      const droppedIntoItemList = $target.closest(".item-list-panel").length > 0
        || $target.closest(".sheet-body").length > 0;
      if (droppedIntoItemList || !$target.closest(".cg-cell,.cg-item-tile,.equip-slot,.skill-slot-wrap").length) {
        const vault = game.items.get(containerId);
        if (!vault) return;
        const srcContents = foundry.utils.deepClone(vault.system.contents ?? []);
        const entry = srcContents[placementIdx];
        srcContents.splice(placementIdx, 1);
        await vault.update({ "system.contents": srcContents });
        const itemData = data.itemData ?? entry?.itemData;
        if (itemData) {
          const newData = foundry.utils.deepClone(itemData);
          delete newData._id;
          await Item.create(newData, { parent: this.actor });
        }
        return;
      }
    }

    // 解析拖入的 item
    const item = await Item.fromDropData(data);
    if (!item) return;

    // 是否已在 actor.items 中
    const ownedItem = this.actor.items.get(item.id) ?? null;

    // ── 容器图块拖入物品列表：从源容器移除，添加到本 Actor ───────────────
    if (data.fromContainer) {
      const { actorId, containerId, placementIdx } = data.fromContainer;
      const $target = $(event.target);
      const droppedIntoItemList = $target.closest(".item-list-panel").length > 0
        || $target.closest(".sheet-body").length > 0;
      if (droppedIntoItemList || !$target.closest(".cg-cell,.cg-item-tile,.equip-slot,.skill-slot-wrap").length) {
        // 移除源容器中的占位
        const srcActor     = actorId ? (game.actors?.get(actorId) ?? this.actor) : this.actor;
        const srcContainer = srcActor.items.get(containerId);
        if (srcContainer) {
          const srcContents = foundry.utils.deepClone(srcContainer.system.contents ?? []);
          srcContents.splice(placementIdx, 1);
          await srcContainer.update({ "system.contents": srcContents });
        }
        // 跨 Actor：物品已在本 actor（由跨 actor drop 逻辑创建），或需从源 actor 移动
        if (srcActor.id !== this.actor.id && !ownedItem) {
          const itemData = item.toObject();
          await Item.create(itemData, { parent: this.actor });
          await item.delete();
        }
        // 同 Actor：物品依然在 actor.items 中，无需额外操作（移出容器即回到列表）
        return;
      }
    }

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
      if (!this._checkStellarBudget(owned)) return;
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
        if (owned && this._checkStellarBudget(owned)) await this.actor.equipSkillToSlot(owned.id, targetSlot, isNaN(fromSlot) ? -1 : fromSlot);
      }
      // ── EGO / 守备：按类型自动匹配槽位 ──────────────────────────────
      else {
        const owned = ownedItem ?? await this._importItemToActor(item);
        if (owned && this._checkStellarBudget(owned)) await this.actor.equipSkill(owned.id);
      }
      return;
    }

    // ── 拖入技能列表（.skill-list-panel）：从外部导入，不自动装备 ─────────────
    const droppedIntoSkillList = $target.closest(".skill-list-panel").length > 0;
    if (droppedIntoSkillList) {
      if (item.type !== "skill") {
        ui.notifications.warn("只有技能才能拖入技能列表。");
        return;
      }
      // 从技能槽拖回技能列表 = 快速卸下
      if (data.fromSkillSlotType) {
        if (ownedItem) await this.actor.unequipSkill(ownedItem.id);
        return;
      }
      // 已在角色中则不重复导入
      if (!ownedItem) await this._importItemToActor(item);
      return;
    }

    // ── 拖入物品列表中的容器行：自动寻位存入 ──────────────────────────────
    const containerRow = $target.closest('.item-row[data-type="container"]');
    if (containerRow.length && item.type !== "container") {
      const containerId = String(containerRow.data("item-id") ?? containerRow.attr("data-item-id"));
      const container = this.actor.items.get(containerId);
      if (!container) return;
      // 确保物品已属于该角色
      const owned = ownedItem ?? await this._importItemToActor(item);
      if (!owned) return;
      const w = owned.system?.capacity?.w ?? 1;
      const h = owned.system?.capacity?.h ?? 1;
      const slot = this._findContainerSlot(container, w, h);
      if (!slot) {
        ui.notifications.warn(`容器「${container.name}」容量空间已满，无法存入「${owned.name}」。`);
        return;
      }
      const contents = foundry.utils.deepClone(container.system.contents ?? []);
      contents.push({
        uuid: owned.uuid,
        x: slot.x, y: slot.y,
        w: slot.rotated ? h : w,
        h: slot.rotated ? w : h,
        rotated: slot.rotated,
      });
      await container.update({ "system.contents": contents });
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
        if (ownedItem) return;  // 已属于该角色，忽略原地拖拽
        const sourceActor = item.parent;
        await this._importItemToActor(item, { forceDuplicate: true });
        // 跨 Actor 移动：删除源角色物品
        if (sourceActor && sourceActor.id !== this.actor.id) await item.delete();
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

  /**
   * 在容器网格中寻找能容纳 itemW×itemH 物品的第一个空位。
   * 先尝试不旋转，再尝试旋转（仅当 w≠h 时）。
   * @returns {{ x, y, rotated: boolean } | null}
   */
  _findContainerSlot(container, itemW, itemH) {
    const sys  = container.system;
    const cols = sys.gridSize?.width  ?? 5;
    const rows = sys.gridSize?.height ?? 5;

    // 构建已占用格子集合
    const occupied = new Set();
    for (const p of (sys.contents ?? [])) {
      const pw = p.w ?? 1, ph = p.h ?? 1;
      for (let dy = 0; dy < ph; dy++)
        for (let dx = 0; dx < pw; dx++)
          occupied.add(`${p.x + dx},${p.y + dy}`);
    }

    const fits = (x, y, w, h) => {
      if (x + w > cols || y + h > rows) return false;
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++)
          if (occupied.has(`${x + dx},${y + dy}`)) return false;
      return true;
    };

    // 不旋转：行优先扫描
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++)
        if (fits(x, y, itemW, itemH)) return { x, y, rotated: false };

    // 旋转（仅当 w≠h）
    if (itemW !== itemH)
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++)
          if (fits(x, y, itemH, itemW)) return { x, y, rotated: true };

    return null;
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
            // 每枚硬币：Roll 1d10，结果 < 属性值 = 正面
            const rollFormula = Array.from({ length: coins }, () => "1d10").join("+");
            const roll = new Roll(rollFormula);
            await roll.evaluate();

            // 统计正面
            let headCount = 0;
            for (const term of roll.terms) {
              if (term.results) {
                headCount += term.results.filter(r => r.result < attrVal).length;
              }
            }

            const difficulty = 3; // 默认难度
            const success     = headCount >= difficulty;
            const resultText  = success ? "成功" : "失败";
            const resultClass = success ? "result-success" : "result-fail";

            const COIN_FACE = "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_正面.webp";
            const COIN_TAIL = "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_反面.webp";
            // Collect per-coin results
            const coinResults = [];
            for (const term of roll.terms) {
              if (!term.results) continue;
              for (const r of term.results) {
                coinResults.push(r.result < attrVal);
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

  /* ─── 背景创建向导 ──────────────────────────────────────────────────────── */

  async _onOpenBackgroundWizard(ev) {
    ev.preventDefault();
    if (!this.isEditable) return;
    const { BackgroundWizard } = await import("./background-wizard.mjs");
    new BackgroundWizard(this.actor).render(true);
  }

  /** 已选择背景：点击直接打开该背景物品卡（而不是重新创建） */
  async _onOpenBackgroundItem(ev) {
    ev.preventDefault();
    const uuid = this.actor.system.background?.uuid ?? "";
    if (!uuid) return;
    const item = await fromUuid(uuid).catch(() => null);
    if (!item) { ui.notifications.warn("背景物品已失效。"); return; }
    item.sheet?.render(true);
  }

  /** 已选择背景：右键菜单「查看/删除」（删除即清空 system.background.uuid，二次确认） */
  async _onBackgroundContextMenu(ev) {
    ev.preventDefault();
    if (!this.isEditable) return;
    const uuid = this.actor.system.background?.uuid ?? "";
    if (!uuid) return;

    this._renderContextMenu(ev, [
      {
        name: "查看/编辑", icon: "<i class='fas fa-edit'></i>",
        callback: async () => {
          const item = await fromUuid(uuid).catch(() => null);
          if (!item) { ui.notifications.warn("背景物品已失效。"); return; }
          item.sheet?.render(true);
        },
      },
      {
        name: "删除", icon: "<i class='fas fa-trash'></i>",
        callback: async () => {
          const confirmed = await Dialog.confirm({
            title:   "移除背景",
            content: "<p>确定要移除当前角色的背景吗？此操作不会删除背景物品本身，也不会撤销已获得的属性点/物品，仅解除角色与该背景的关联。</p>",
          });
          if (!confirmed) return;
          await this.actor.update({ "system.background.uuid": "" });
        },
      },
    ]);
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

    // slotIndex = -2：不推进 6-bag（非战斗槽触发）
    await this._showClashDialog(item, -2);
  }

  async _showClashDialog(item, slotIndex = -1) {
    await ClashManager.showInitiateDialog(this.actor, item, slotIndex);
  }

  async _onItemActivate(event) {
    const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;
    await this._activateItem(item);
  }

  /** 激活物品：触发 [使用时] Activity 效果；消耗品数量 -1，归零时自动删除。*/
  async _activateItem(item) {
    if (!item) return;
    if (item.type === "consumable" && (item.system.quantity ?? 0) <= 0) {
      ui.notifications.warn("数量不足。"); return;
    }

    // 装备 / 守备技能激活不再消耗行动值，仍要做[使用时]次数预检
    const needsCheck = item.type === "equipment"
      || (item.type === "skill" && item.system?.type === "defense");
    if (needsCheck) {
      const { blocked, reasons } = ClashManager._checkAllActivitiesBlocked(item, "使用时", this.actor);
      if (blocked) {
        const detail = reasons.length ? `（${reasons.join("；")}）` : "";
        ui.notifications.warn(`【${item.name}】的使用次数已达上限，本次使用被取消。${detail}`);
        return;
      }
    }

    // Activity 效果可能涉及群体目标（其他玩家角色），非GM无权直接 update
    // → 委托GM通过 socket 代为执行
    if (game.user.isGM) {
      await ClashManager._applyActivities(item, "使用时", {
        owner: this.actor, atkActor: this.actor, defActor: null, _fireCounts: {},
      });
    } else {
      game.socket.emit("system.limbusCompany_FVTT", {
        type:    "activityActivate",
        actorId: this.actor.id,
        itemId:  item.id,
        trigger: "使用时",
      });
    }

    if (item.type === "consumable") {
      const qty      = (item.system.quantity ?? 1) - 1;
      const reusable = item.system.reusable ?? false;
      if (qty <= 0 && !reusable) {
        await item.delete();
      } else {
        await item.update({ "system.quantity": Math.max(0, qty) });
      }
    }
  }

  async _onItemFavorite(event) {
    const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
    const favs   = new Set(this.actor.getFlag("limbusCompany_FVTT", "favorites") ?? []);
    if (favs.has(itemId)) favs.delete(itemId);
    else favs.add(itemId);
    // 立即切换按钮高亮（不依赖重渲染），再持久化
    $(event.currentTarget).toggleClass("fav-active", favs.has(itemId));
    this.__favorites = favs;
    await this.actor.setFlag("limbusCompany_FVTT", "favorites", [...favs]);
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
      { name: "激活",      icon: "<i class='fas fa-bolt'></i>",      callback: () => this._activateItem(item) },
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
      { name: "发起对抗",  icon: "<i class='fas fa-swords'></i>",  callback: () => {
          this._showClashDialog(item, -2);
        } },
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
      const name = $(row).find(".item-name, .col-name.item-name").text().toLowerCase();
      const tags = ($(row).attr("data-tags") ?? "").toLowerCase();
      $(row).toggle(!query || name.includes(query) || tags.includes(query));
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

  _onFilterApply(event) {
    const panel    = $(event.currentTarget).closest(".filter-panel");
    const cats     = panel.find(".filter-category-btn.active").map((_, b) => $(b).data("category")).get();
    this._filterState = { categories: cats };

    const listPanel = $(event.currentTarget).closest(".tab").find(".item-list-panel, .skill-list-panel");
    listPanel.find(".item-row, .skill-row").each((_, row) => {
      const $row = $(row);
      const cat  = $row.data("subtype") ?? $row.data("type") ?? "";

      const catOk = !cats.length || cats.includes(cat);
      $row.toggle(catOk);
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

  /**
   * 相关技能转换后，把 6-bag 状态里所有引用旧技能 ID 的位置原地换成新技能 ID
   * （equipped/slots/pool 三个数组逐一替换，位置/顺序保持不变，不重新洗牌）。
   * 6-bag 状态是本客户端本地的临时抽卡进度（不持久化到角色数据），只有当前
   * 正在查看该角色卡的客户端才需要同步；未打开该角色卡或尚未开始抽卡时静默跳过。
   * @param {string} oldId
   * @param {string} newId
   */
  _replaceCombatBagSkill(oldId, newId, limit = Infinity) {
    const state = this._combatBagState;
    if (!state || !oldId || !newId || oldId === newId) return;

    // limit：最多替换几处。临时技能转换的**还原**是一条记录对应一个槽位，
    // 必须传 1——基础槽与守备槽同时换成同一个强化形态时，无限制地全量替换
    // 会把 6 袋与 HUD 里另一格也一起写成对方的原技能。
    let left = Math.max(0, limit);
    let changed = false;
    for (const key of ["equipped", "slots", "pool"]) {
      const arr = state[key];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length && left > 0; i++) {
        if (arr[i] === oldId) { arr[i] = newId; changed = true; left--; }
      }
      if (left <= 0) break;
    }
    if (changed) {
      this._renderCombatSlots(this.element);
      // 快捷操作 HUD 读的是同一份 _combatBagState，得跟着重画
      import("./quick-action-hud.mjs")
        .then(({ QuickActionHUD }) => QuickActionHUD.onActorUpdate?.(this.actor))
        .catch(() => {});
    }
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
        const $img0 = $slot.find("img");
        if ($img0.attr("src") !== defaultImg) $img0.attr("src", defaultImg);
        $img0.show();
        $slot.attr("data-item-id", "");
        $slot.removeClass("slot-active slot-reserve slot-bag").addClass("slot-empty");
        $wrap.find(".slot-state-dot").removeClass("dot-active dot-reserve");
        $wrap.find(".combat-slot-name").text("");
      });
      return;
    }

    const ap = this.actor.system.ap?.value ?? 0;

    basicSlots.each((i, wrap) => {
      const $wrap   = $(wrap);
      const $slot   = $wrap.find(".combat-skill-slot");
      const $dot    = $wrap.find(".slot-state-dot");
      const $name   = $wrap.find(".combat-slot-name");
      const id      = state.slots[i] ?? null;

      // 主技能
      const mainItem = id ? this.actor.items.get(id) : null;

      // 同 src 不重复写，避免浏览器重新解码图片造成的闪烁
      const $img   = $slot.find("img");
      const newSrc = mainItem?.img ?? "";
      if ($img.attr("src") !== newSrc) $img.attr("src", newSrc);
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
    });

    // 【大招就绪】星芒：槽位 DOM 是复用的，每次重绘都先清后挂
    refreshReadySlots(html, this.actor);
  }

  /** @override 关卡时摘掉形象编辑挂在 window 上的键盘监听 */
  async close(options = {}) {
    if (this._dollKeyHandler) {
      window.removeEventListener("keydown", this._dollKeyHandler);
      this._dollKeyHandler = null;
    }
    return super.close(options);
  }

  /**
   * 形象编辑：拖动摆放装备贴图。
   *
   * 三种模式共用一次拖动——按下选中图层，移动时按当前模式改一个参数：
   *   移动(move)   → 改 x/y（百分比，跟着立绘框缩放走）
   *   旋转(rotate) → 改 rot（按指针绕图层中心的夹角，所见即所得）
   *   缩放(scale)  → 改 scale（上下拖，往上变大）
   * R / E 切换到旋转 / 缩放，再按一次回到移动。
   * 松手才写库（render:false，避免重绘打断连续操作）。
   */
  _bindDollEditor(html) {
    const stage = html.find(".doll-stage")[0];
    if (!stage || !this._dollEdit) return;

    const applyStyle = (el, st) => {
      el.style.left = `${st.x}%`;
      el.style.top  = `${st.y}%`;
      el.style.transform = `translate(-50%,-50%) rotate(${st.rot}deg) scale(${st.scale})`;
    };

    let drag = null;

    const onMove = (ev) => {
      if (!drag) return;
      ev.preventDefault();
      const mode = this._dollMode ?? "move";
      if (mode === "move") {
        drag.st.x = drag.base.x + ((ev.clientX - drag.startX) / drag.rect.width)  * 100;
        drag.st.y = drag.base.y + ((ev.clientY - drag.startY) / drag.rect.height) * 100;
      } else if (mode === "rotate") {
        const cx = drag.rect.left + (drag.base.x / 100) * drag.rect.width;
        const cy = drag.rect.top  + (drag.base.y / 100) * drag.rect.height;
        const a0 = Math.atan2(drag.startY - cy, drag.startX - cx);
        const a1 = Math.atan2(ev.clientY  - cy, ev.clientX  - cx);
        drag.st.rot = Math.round(drag.base.rot + (a1 - a0) * 180 / Math.PI);
      } else {
        // 往上拖变大：每 120px 一倍
        const k = 1 + (drag.startY - ev.clientY) / 120;
        drag.st.scale = Math.min(8, Math.max(0.05, Math.round(drag.base.scale * k * 100) / 100));
      }
      applyStyle(drag.el, drag.st);
    };

    const onUp = async () => {
      if (!drag) return;
      const { item, st, isHead } = drag;
      drag = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const data = {
        x:     Math.round(st.x * 100) / 100,
        y:     Math.round(st.y * 100) / 100,
        rot:   st.rot,
        scale: st.scale,
      };
      // 头的摆放存在角色身上（它不是某件装备），装备的存在装备自己身上
      if (isHead) {
        await this.actor.update({
          "system.dollHead.x": data.x, "system.dollHead.y": data.y,
          "system.dollHead.rot": data.rot, "system.dollHead.scale": data.scale,
        }, { render: false });
      } else {
        await item?.update({
          "system.doll.x": data.x, "system.doll.y": data.y,
          "system.doll.rot": data.rot, "system.doll.scale": data.scale,
          "system.doll.placed": true,     // 亲手摆过，之后不再套用默认位
        }, { render: false });
      }
    };

    html.find(".doll-layer").on("pointerdown", (ev) => {
      ev.preventDefault();
      const el     = ev.currentTarget;
      const isHead = el.dataset.head === "1";
      const item   = isHead ? null : this.actor.items.get(el.dataset.itemId ?? "");
      if (!isHead && !item) return;
      this._dollSel = isHead ? "__head__" : item.id;
      html.find(".doll-layer").removeClass("doll-sel");
      el.classList.add("doll-sel");
      const d = isHead ? (this.actor.system?.dollHead ?? {}) : (item.system?.doll ?? {});
      const base = { x: d.x ?? 50, y: d.y ?? (isHead ? 22 : 50), rot: d.rot ?? 0, scale: d.scale ?? 1 };
      drag = {
        el, item, isHead, base, st: { ...base },
        rect: stage.getBoundingClientRect(),
        startX: ev.clientX, startY: ev.clientY,
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    // R / E 切换模式：只在编辑模式下、且焦点不在输入框里时响应
    if (this._dollKeyHandler) window.removeEventListener("keydown", this._dollKeyHandler);
    this._dollKeyHandler = (ev) => {
      if (!this._dollEdit || !this.rendered) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
      const k = ev.key?.toLowerCase();
      if (k !== "r" && k !== "e") return;
      ev.preventDefault();
      const want = k === "r" ? "rotate" : "scale";
      this._dollMode = (this._dollMode === want) ? "move" : want;
      const lbl = { move: "移动", rotate: "旋转", scale: "缩放" }[this._dollMode];
      this.element?.find(".doll-hint b").first().text(lbl);
    };
    window.addEventListener("keydown", this._dollKeyHandler);

    // 滚轮：调整这件装备的图层前后（头恒在最前，不参与）
    html.find(".doll-layer").on("wheel", async (ev) => {
      const el = ev.currentTarget;
      if (el.dataset.head === "1") return;
      const item = this.actor.items.get(el.dataset.itemId ?? "");
      if (!item) return;
      ev.preventDefault();
      const dir = (ev.originalEvent ?? ev).deltaY < 0 ? 1 : -1;   // 上滚＝往前
      const cur = Number(el.style.zIndex) || (item.system?.doll?.z ?? 0);
      const nz  = Math.max(0, Math.min(999, cur + dir));
      el.style.zIndex = nz;                     // 先动 DOM，手感跟手
      await item.update({ "system.doll.z": nz }, { render: false });
    });

    // 添加 / 更换头像：单独一张图，永远画在所有装备之上
    html.find(".doll-head-pick").on("click", () => {
      const cur = this.actor.system?.dollHead?.img ?? "";
      const FP  = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
      new FP({
        type: "image", current: cur,
        callback: (path) => this.actor.update({ "system.dollHead.img": path }),
      }).browse(cur);
    });

    // 重置选中的那件
    html.find(".doll-reset").on("click", async () => {
      if (this._dollSel === "__head__") {
        return void await this.actor.update({
          "system.dollHead.x": 50, "system.dollHead.y": 22,
          "system.dollHead.rot": 0, "system.dollHead.scale": 1,
        });
      }
      const item = this.actor.items.get(this._dollSel ?? "");
      if (!item) return void ui.notifications.info("先点一下要重置的部件。");
      // 重置＝退回"没摆过"，重新套用该子类型的默认位
      await item.update({
        "system.doll.x": 50, "system.doll.y": 50,
        "system.doll.rot": 0, "system.doll.scale": 1,
        "system.doll.z": 0, "system.doll.placed": false,
      });
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

  /**
   * 丢弃战斗槽中的技能
   *
   * 只会丢激活槽 0/1（预备模式丢槽 2）——6bag 里只可能有基础技能，装备/守备技能
   * 触发的丢弃也一样只作用于这两格。触发这条消耗的技能永远不会丢弃自己，
   * 【等级】模式也只是判断"另一张"是不是该等级；0/1 两格都符合时两张一起丢
   *（【丢弃时】由调用方只触发一次）。
   *
   * @param {"level"|"another"|"reserve"} mode
   * @param {number} level - 仅 mode==="level" 时有效
   * @param {string} currentItemId - 触发本次丢弃的技能 ID（永远排除）
   * @param {number[]|null} declaredIdx - 还剩哪些"宣言时就在场"的槽位下标
   * @returns {{ discardedIds: string[], slotIndices: number[] }} 被丢弃的技能与槽位
   */
  async _discardCombatSkill(mode, level, currentItemId, declaredIdx = null) {
    const state = this._combatBagState;
    if (!state) return { discardedIds: [], slotIndices: [] };

    // 与消耗预检查共用同一套定位规则，避免"检查通过但实际丢不掉"
    const slots = ClashManager._findDiscardSlots(
      this.actor, state.slots,
      { discardMode: mode, discardLevel: level },
      currentItemId ?? "", declaredIdx
    );
    if (!slots.length) return { discardedIds: [], slotIndices: [] };

    const discardedIds = slots.map(i => state.slots[i]).filter(Boolean);
    // 从后往前丢，免得前一张的左移把后面的下标搞错
    for (const idx of [...slots].reverse()) {
      if (state.slots[idx]) await this._animateDiscardSkill(idx);
    }
    return { discardedIds, slotIndices: slots };
  }

  // 丢弃动画：破币特效 → 该槽碎裂消失 → 左侧不动、右侧左移、新牌从右边推进来
  async _animateDiscardSkill(slotIndex) {
    const state = this._combatBagState;
    if (!state) return;

    const _wraps = () => this.element?.find(".basic-combat-section .combat-skill-slot-wrap");

    // 快捷 HUD 上也显示前 3 格，同步炸一下
    const $hudSlot = (slotIndex <= 2)
      ? QuickActionHUD.instance?.element?.find(`.qa-skill-slot[data-slot-index="${slotIndex}"]`)
      : null;
    if ($hudSlot?.length) {
      ClashVFX.burstOnElement($hudSlot);
      $hudSlot.addClass("qa-skill-slot--breaking");
    }

    const $wraps = _wraps();
    const $slot  = $wraps?.eq(slotIndex).find(".combat-skill-slot");

    // 角色卡没打开（或槽位不在 DOM 里）：只更新状态
    if (!$slot?.length) {
      this._advanceBagState(slotIndex);
      this._renderCombatSlots(this.element);
      QuickActionHUD.instance?.render(false);
      return;
    }

    ClashVFX.burstOnElement($slot);
    $slot.addClass("combat-skill-slot--breaking");

    await new Promise(r => setTimeout(r, 260));

    state.slots.splice(slotIndex, 1);
    state.slots.push(this._drawNextFromPool());

    // 重渲染前把上一轮残留的内联样式清掉
    _wraps()?.each((_, el) => {
      $(el).find(".combat-skill-slot")
        .removeClass("combat-skill-slot--breaking")
        .css({ transition: "none", transform: "", opacity: "" });
    });
    this._renderCombatSlots(this.element);
    // HUD 也补播一次补位动画，否则它是整块重渲染、看起来在闪
    const hud = QuickActionHUD.instance;
    if (hud) { if (slotIndex <= 2) hud._slideFromSlot = slotIndex; hud.render(false); }

    // 被丢的那格右边所有牌左移一格，最右边补进来的新牌从右侧推入
    const $after = _wraps();
    $after?.each((i, el) => {
      if (i < slotIndex) return;                        // 左侧的牌原地不动
      const $s = $(el).find(".combat-skill-slot");
      $s.addClass(i === 5 ? "combat-skill-slot--slide-in" : "combat-skill-slot--shift-left");
      setTimeout(() => $s.removeClass("combat-skill-slot--slide-in combat-skill-slot--shift-left"), 400);
    });
    await new Promise(r => setTimeout(r, 120));
  }

  // 推进 bag 状态（无论角色卡是否打开都必须执行）
  _advanceBagState(slotIndex) {
    const state = this._combatBagState;
    if (!state || !state.slots[slotIndex]) return;
    state.slots.splice(slotIndex, 1);
    const nextId = this._drawNextFromPool();
    state.slots.push(nextId);
  }

  // 带动画地使用指定激活槽技能（仅 slotIndex = 0 或 1）
  _animateCombatSkillUse(slotIndex) {
    const state = this._combatBagState;
    if (!state || !state.slots[slotIndex]) return;

    // 角色卡未打开：直接推进状态，不播放动画
    if (!this.element?.length) {
      this._advanceBagState(slotIndex);
      return;
    }

    // 每个阶段都通过 this.element 实时查询，避免因重渲染导致引用失效
    const _wraps = () => this.element.find(".basic-combat-section .combat-skill-slot-wrap");

    const $wraps = _wraps();
    if (slotIndex >= $wraps.length) {
      this._advanceBagState(slotIndex);
      return;
    }

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
      this._advanceBagState(slotIndex);

      // 重置 wrapper 和内部 slot 的所有内联动画样式（不带动画）
      const $w2 = _wraps();
      $w2.each((_, el) => {
        $(el).css({ transition: "none", transform: "" });
        $(el).find(".combat-skill-slot").css({ transition: "none", transform: "", opacity: "" });
      });

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

    const slotIndex = parseInt($slot.attr("data-slot-index") ?? "0");

    const item = this.actor.items.get(itemId);
    if (!item) return;

    this._showClashDialog(item, slotIndex);
  }

  _onEgoSkillClick(event) {
    const itemId = event.currentTarget.dataset.itemId;
    if (!itemId) return;
    const item = this.actor.items.get(itemId);
    if (!item) return;

    // 守备技能按规则只能【激活】，不能发起对抗
    if (item.system?.type === "defense") return this._activateItem(item);

    // EGO 技能：直接发起对抗，不推进 bag，不消耗行动值
    this._showClashDialog(item, -1);  // slotIndex = -1 → 不触发 bag 动画/AP 消耗
  }

  /* ─── 行动值（AP） ──────────────────────────────────────────────────────── */

  async _onApCoinToggle(event) {
    const idx     = parseInt(event.currentTarget.dataset.index);
    const current = this.actor.system.ap.value;
    // 点击已使用硬币 → 恢复；点击未使用硬币 → 使用
    const newVal  = idx < current ? idx : idx + 1;
    await this.actor.update({ "system.ap.value": Math.max(0, newVal) });
  }

  async _onApReset(event) {
    await this.actor.update({ "system.ap.value": this.actor.system.ap.max ?? 3 });
  }

  /* ─── BUFF 管理 ─────────────────────────────────────────────────────────── */

  async _onAddBuff(event) {
    // 构建 label→typeKey 映射，涵盖所有已知 BUFF
    const labelToKey = {};
    const cfg = CONFIG.LIMBUSCOMPANY;
    const allGroups = [
      ...(cfg.BUFF_GROUPS.positive ?? []),
      ...(cfg.BUFF_GROUPS.negative ?? []),
      ...(cfg.BUFF_GROUPS.special  ?? []),
      ...(cfg.BUFF_GROUPS.other    ?? []),
      ...(cfg.BUFF_GROUPS.custom   ?? []),
    ];
    for (const k of allGroups) {
      labelToKey[_buffLabel(k)] = k;
    }
    // 自定义注册表中的 BUFF 也加入（处理动态注册情况）
    for (const [k, handler] of CustomBuffRegistry.entries()) {
      if (handler?.label) labelToKey[handler.label] = k;
    }

    const datalistOptions = Object.keys(labelToKey)
      .map(lbl => `<option value="${lbl}">`)
      .join("");

    const content = `
      <div class="limbuscompany add-buff-dialog">
        <div class="form-group">
          <label>BUFF名称</label>
          <input type="text" name="buffName" list="add-buff-datalist"
                 placeholder="输入或选择BUFF名称…" autocomplete="off" style="width:100%"/>
          <datalist id="add-buff-datalist">${datalistOptions}</datalist>
        </div>
        <div class="form-group">
          <label>回合</label>
          <select name="whenAdded">
            <option value="本回合">本回合</option>
            <option value="下回合">下回合</option>
          </select>
        </div>
        <div class="form-group inline-row">
          <label>强度</label><input type="number" name="intensity" value="0" min="0" style="width:60px"/>
          <label style="margin-left:8px">层数</label><input type="number" name="stacks" value="0" min="0" style="width:60px"/>
        </div>
      </div>`;

    const dlg = new Dialog({
      title: "添加新的状态BUFF",
      content,
      buttons: {
        add: {
          label: "添加",
          callback: async (html) => {
            const inputName = html.find("[name='buffName']").val().trim();
            const whenAdded = html.find("[name='whenAdded']").val();
            const intensity = parseInt(html.find("[name='intensity']").val()) || 0;
            const stacks    = parseInt(html.find("[name='stacks']").val())    || 0;

            // 通过中文名反查 typeKey；匹配不到则视为纯自定义文本
            let type = labelToKey[inputName] ?? normalizeBuffType("custom", inputName);
            const name = inputName || "自定义";

            await this.actor.addBuff({ type, name, intensity, stacks, whenAdded,
              icon: _buffIconPath(type, name) });
          },
        },
        cancel: { label: "取消" },
      },
      default: "add",
    });

    dlg.render(true);
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
        // 自定义 BUFF 可修正跳动伤害 / 设定生命值下限
        const tickMods = ClashManager.applyTickDamageMods(actor, intensity, buff.type);
        const tickDmg  = tickMods.damage;
        const oldHp = actor.system.hp?.value ?? 0;
        const newHp = ClashManager.applyHpFloor(oldHp, oldHp - tickDmg, tickMods.hpFloor);
        const maxHpBuff       = actor.system.hp?.max ?? 1;
        const _SH_TYPES       = ["chaos", "chaos_plus", "chaos_double_plus"];
        const _SH_NAMES       = ["陷入混乱", "陷入混乱+", "陷入混乱++"];
        const buffChaosCount  = (actor.system.chaosThresholds ?? []).filter(
          t => !t.triggered && newHp <= maxHpBuff * t.percent / 100
        ).length;
        const shExistingType  = (actor.system.buffs ?? []).find(b => _SH_TYPES.includes(b.type))?.type;
        const shCurrentLevel  = shExistingType ? (_SH_TYPES.indexOf(shExistingType) + 1) : 0;
        const shNewLevel      = Math.min(3, shCurrentLevel + buffChaosCount);
        const buffChaosName   = _SH_NAMES[shNewLevel - 1] ?? "陷入混乱";
        await actor.update({ "system.hp.value": newHp });
        await actor.reduceBuffStacks(buff.type);
        if (actor.checkAndTriggerChaos) await actor.checkAndTriggerChaos(newHp, oldHp, { silent: true, source: buff.type });
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div class="limbuscompany chat-clash">
            <strong>${actor.name}</strong>【${buff.name}】触发：受到 <strong>${tickDmg}</strong> 点固定伤害。
            （HP ${oldHp} → ${newHp}）${buffChaosCount > 0 ? `　<span style='color:#E84444;font-weight:bold;'>——【${buffChaosName}】！</span>` : ""}
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
        await ChatMessage.create({
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
        // 统一走 ClashManager.seismicBlast，特殊震颤/振幅纠缠的规则一并生效
        const { blasts, msgs: blastMsgs } = await ClashManager.seismicBlast(actor, 1);
        if (blasts > 0) {
          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div class="limbuscompany chat-clash">
              <strong>${actor.name}</strong>【震颤】引爆：<br>${blastMsgs.join("<br>")}
            </div>`,
          });
        }
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
    let   value  = parseInt(input.value) || 0;
    const buffs  = (this.actor.system.buffs ?? []).map(b => {
      if (b.id !== buffId) return b;
      // 手改也守规矩：层数不得超过该 BUFF 注册的上限
      if (field === "stacks") {
        const max = resolveBuffHandler(b)?.maxStacks ?? Infinity;
        if (Number.isFinite(max) && value > max) {
          ui.notifications.info(`【${b.name ?? b.type}】最多 ${max} 层`);
          value = max;
          input.value = max;
        }
      }
      return { ...b, [field]: value };
    });
    await this.actor.update({ "system.buffs": buffs });
  }

  async _onLevelUpClick(event) {
    event.preventDefault();
    const { LevelUpDialog } = await import("./level-up-dialog.mjs");
    new LevelUpDialog(this.actor).render(true);
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
      root.find(".sin-resist-static").hide();
    } else {
      lockBtn.addClass("locked").html('<i class="fas fa-lock"></i>');
      root.find(".editable-field").prop("disabled", true);
      root.find(".editable-only").hide();
      root.find(".sin-resist-static").show();
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

    // 防止重复生成（强制关闭：这里是"打开新卡片前清场"，不是普通移出）
    this._onItemHoverEnd(true);
    this._titleCard = this._buildTitleCard(item);

    const rect     = this.element[0].getBoundingClientRect();
    const cardW    = 280;
    const cardH    = 500;
    const left     = Math.max(8, rect.left - cardW - 8);
    const top      = Math.max(8, Math.min(rect.top, window.innerHeight - cardH - 8));

    this._titleCard.css({ position: "fixed", left, top, zIndex: 99998 });
    $("body").append(this._titleCard);
    this._finalizeTitleCard();

    // 允许在悬停期间通过滚轮滚动 Title 卡描述区（卡片现为 pointer-events: auto，
    // 但轮子事件仍从槽位元素转发，避免鼠标必须精确停在描述区才能滚动）
    this._titleCardWheelEl = el;
    this._titleCardWheelHandler = (ev) => {
      if (!this._titleCard?.length) return;
      const desc = this._titleCard.find(".tc-desc, .tce-desc, .item-desc-display")[0];
      if (!desc) return;

      const hasOverflow = desc.scrollHeight > desc.clientHeight;
      if (!hasOverflow) return;

      desc.scrollTop += ev.deltaY;
      ev.preventDefault();
    };
    el.addEventListener("wheel", this._titleCardWheelHandler, { passive: false });
  }

  /**
   * 卡片本体挂上"鼠标进入取消关闭 / 鼠标离开重新排队关闭"，让用户有机会把鼠标
   * 移到卡片上；锁定的卡片只能靠中键再点一次关闭（见 item-sheet.mjs 的
   * _wireCardInteractivity），离开触发源/卡片本体都不会关闭锁定的卡片。
   */
  _finalizeTitleCard() {
    if (!this._titleCard?.length) return;
    this._titleCard.on("mouseenter", () => clearTimeout(this._titleCardCloseTimer));
    this._titleCard.on("mouseleave", () => this._onItemHoverEnd());
  }

  _clearTitleCardWheel() {
    if (this._titleCardWheelEl && this._titleCardWheelHandler) {
      this._titleCardWheelEl.removeEventListener("wheel", this._titleCardWheelHandler);
    }
    this._titleCardWheelEl = null;
    this._titleCardWheelHandler = null;
  }

  /**
   * @param {boolean} [force=false]  true=立即强制关闭（忽略锁定，用于拖拽开始/
   *   即将打开新卡片等清场场景）；false=按 150ms 延迟软关闭——只影响"离开触发源"
   *   这一路径，锁定的卡片不会被这条路径摘掉（要关闭锁定卡片需离开卡片本体，
   *   或中键再点一次卡片，见 _finalizeTitleCard / item-sheet.mjs）
   */
  _onItemHoverEnd(force = false) {
    if (!force) {
      clearTimeout(this._titleCardCloseTimer);
      this._titleCardCloseTimer = setTimeout(() => this._onItemHoverEnd(true), 150);
      return;
    }
    clearTimeout(this._titleCardCloseTimer);
    this._clearTitleCardWheel();
    closeTitleCardUnlessLocked(this._titleCard);
    if (!this._titleCard?.data("tcLocked")) this._titleCard = null;
  }

  /** 恐慌槽位：拖入恐慌卡（世界/目录物品复制嵌入，本角色物品直接引用） */
  async _onPanicSlotDrop(event) {
    event.preventDefault();
    $(event.currentTarget).removeClass("cg-drag-over");
    const slot = event.currentTarget.dataset.slot;
    if (!slot) return;

    let raw;
    try { raw = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (raw?.type !== "Item") return;

    const dropped = await Item.fromDropData(raw).catch(() => null);
    if (!dropped) return;
    if (dropped.type !== "panic") {
      ui.notifications.warn("只能放入「恐慌」类型的物品。");
      return;
    }
    // 恐慌卡分【士气低落】【陷入恐慌】两种，槽位对应类型。
    // 未指定类型的老数据放行，只有明确标了另一种类型才拦。
    const dropType = dropped.system?.panicType ?? "";
    if (dropType && dropType !== slot) {
      const L = CONFIG.LIMBUSCOMPANY?.PANIC_TYPES ?? {};
      ui.notifications.warn(`【${dropped.name}】是「${L[dropType] ?? dropType}」卡，放不进「${L[slot] ?? slot}」槽。`);
      return;
    }

    let itemId = dropped.id;
    if (dropped.parent?.id !== this.actor.id) {
      // 外部物品：复制嵌入本角色
      const data = dropped.toObject();
      delete data._id;
      const [newItem] = await this.actor.createEmbeddedDocuments("Item", [data]);
      itemId = newItem.id;
    }

    // 替换旧卡：若旧卡不再被任何槽引用则删除
    const oldId = this.actor.system.panicSlots?.[slot] ?? "";
    await this.actor.update({ [`system.panicSlots.${slot}`]: itemId });
    if (oldId && oldId !== itemId) {
      const stillUsed = Object.entries(this.actor.system.panicSlots ?? {})
        .some(([k, v]) => k !== slot && v === oldId);
      if (!stillUsed) await this.actor.items.get(oldId)?.delete();
    }
  }

  /** 物品列表：技能书「学习技能」按钮（确认后学习全部技能并消耗技能书） */
  async _onSkillBookLearn(event) {
    const itemId = event.currentTarget.dataset.itemId ?? "";
    const book   = this.actor.items.get(itemId);
    if (!book || book.type !== "skillbook") return;
    const confirmed = await Dialog.confirm({
      title:   "学习技能",
      content: `<p>确定学习技能书「${book.name}」中的全部技能？技能书将被消耗。</p>`,
    });
    if (!confirmed) return;
    await book.learnAllSkills();
  }

  /** 网格视图：拖到容器图块上，自动寻位存入容器（容器不能存放容器） */
  /**
   * 背包格投放：把落点写进 `system.bagLayout`（塔科夫式自由摆放）。
   * 只处理"背包内部挪动"——从容器/仓库/侧边栏拖来的物品仍走既有流程。
   */
  /**
   * 把渲染时自动补位的坐标写回 `system.bagLayout`，让背包摆放彻底固定下来。
   * 只补缺失的条目，不动玩家已经摆好的；没有缺失就一次写都不发。
   * 渲染流程里不能同步 await（会把 getData 拖住并触发再次渲染），
   * 因此 fire-and-forget，并用一个标志位防止写入引发的重渲染再次进来。
   */
  _persistBagLayout(grid) {
    if (this._bagLayoutSyncing) return;
    if (!this.actor.isOwner) return;
    const layout = this.actor.system?.bagLayout ?? [];
    const known  = new Set(layout.map(e => e.itemId));
    const missing = (grid?.tiles ?? []).filter(t => !known.has(t.id));
    if (!missing.length) return;

    this._bagLayoutSyncing = true;
    const next = [
      ...layout,
      ...missing.map(t => ({ itemId: t.id, x: t.x, y: t.y, rotated: !!t.rotated })),
    ];
    this.actor.update({ "system.bagLayout": next })
      .catch(err => console.warn("[背包] 摆放坐标写入失败", err))
      .finally(() => { this._bagLayoutSyncing = false; });
  }

  async _onBagCellDrop(event) {
    event.preventDefault();
    let raw;
    try { raw = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (raw?.fromBag?.actorId !== this.actor.id) return;

    const itemId = raw.fromBag.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;

    const grid = this._bagGridCache ?? { tiles: [], rows: BAG_ROWS };
    const cols = BAG_COLS;
    const rows = grid.rows ?? BAG_ROWS;

    const layout  = foundry.utils.deepClone(this.actor.system.bagLayout ?? []);
    const entry   = layout.find(e => e.itemId === itemId) ?? null;
    const wasRot  = entry?.rotated ?? false;
    const newRot  = raw.rotatePending ? !wasRot : wasRot;

    const cap  = item.system?.capacity ?? {};
    const rawW = Math.max(1, cap.w ?? 1);
    const rawH = Math.max(1, cap.h ?? 1);
    const w    = newRot ? rawH : rawW;
    const h    = newRot ? rawW : rawH;

    // 落点：GridDnD 已经把抓取偏移与旋转算进 dropX/dropY，直接用；
    // 万一是别处合成的 drop（没有这两个字段），退回用格子坐标。
    const x = raw.dropX ?? parseInt(event.currentTarget.dataset.x ?? 0);
    const y = raw.dropY ?? parseInt(event.currentTarget.dataset.y ?? 0);

    // 与其他物品的碰撞（自己排除在外）
    const others = (grid.tiles ?? [])
      .filter(t => t.id !== itemId)
      .map(t => ({ x: t.x, y: t.y, w: t.w, h: t.h }));
    if (!canPlace(others, x, y, w, h, cols, rows)) {
      return void ui.notifications.warn("此位置无法放置（超出背包边界或与其他物品重叠）");
    }

    if (entry) { entry.x = x; entry.y = y; entry.rotated = newRot; }
    else       { layout.push({ itemId, x, y, rotated: newRot }); }
    await this.actor.update({ "system.bagLayout": layout });
  }

  async _onBagTileDropOnContainer(event) {
    const container = this.actor.items.get(event.currentTarget.dataset.itemId ?? "");
    if (container?.type !== "container") return;

    let raw;
    try { raw = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (raw?.type !== "Item" || !raw.uuid) return;

    const dragged = await fromUuid(raw.uuid).catch(() => null);
    if (!dragged || dragged.id === container.id) return;
    // 只处理本角色背包内的物品（跨来源拖入仍走原有流程）
    if (dragged.parent?.id !== this.actor.id) return;

    event.preventDefault();
    event.stopPropagation();

    // 存放限制（类型 AND 分类；容器套容器也由类型限制决定）+ 环检测
    const verdict = canContainerAccept(container, dragged);
    if (!verdict.ok) return void ui.notifications.warn(verdict.reason);
    if (await wouldNest(container, dragged)) {
      return void ui.notifications.warn("不能把容器放进它自己或它内部的容器里。");
    }

    // 容器内自动寻位（首适应 + 旋转）
    const gw       = container.system.gridSize?.width  ?? 3;
    const gh       = container.system.gridSize?.height ?? 3;
    const contents = foundry.utils.deepClone(container.system.contents ?? []);
    // 已在该容器内则不重复放入
    if (contents.some(p => p.uuid === dragged.uuid)) return;
    const cap = dragged.system?.capacity ?? { w: 1, h: 1 };
    const iw = Math.max(1, cap.w ?? 1), ih = Math.max(1, cap.h ?? 1);
    // 自动寻位：复用共用算法，**锁定格不可占用**（原来这份手写实现漏了这一条）
    const place = autoPlace(contents, iw, ih, gw, gh, {
      lockedSet: makeLockedSet(container.system.lockedCells ?? []),
    });
    if (!place) { ui.notifications.warn(`【${container.name}】容量空间已满，无法存入。`); return; }

    contents.push({ uuid: dragged.uuid, x: place.x, y: place.y, w: place.w, h: place.h, rotated: place.rotated });
    await container.update({ "system.contents": contents });
  }

  /** 战斗槽悬浮 Title 卡（基础/EGO/守备） */
  _onCombatSlotHover(event) {
    const el     = event.currentTarget;
    const itemId = el.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;

    this._onItemHoverEnd(true);
    this._titleCard = this._buildTitleCard(item);

    // 卡片显示在角色卡左侧；若角色卡左侧空间不足则显示在右侧
    const rect  = this.element[0].getBoundingClientRect();
    const cardW = 280;
    const cardH = 500;
    let left = rect.left - cardW - 8;
    if (left < 8) left = rect.right + 8;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - cardH - 8));

    this._titleCard.css({ position: "fixed", left, top, zIndex: 99998 });
    $("body").append(this._titleCard);
    this._finalizeTitleCard();

    // 允许鼠标在槽位上滚动时滚动描述区
    this._titleCardWheelEl = el;
    this._titleCardWheelHandler = (ev) => {
      const desc = this._titleCard?.find(".tc-desc")[0];
      if (!desc || desc.scrollHeight <= desc.clientHeight) return;
      desc.scrollTop += ev.deltaY;
      ev.preventDefault();
    };
    el.addEventListener("wheel", this._titleCardWheelHandler, { passive: false });
  }

  /**
   * 复用 item-sheet.mjs 的共享 Title 卡构建（描述文本 linkify、鼠标中键锁定、
   * 卡内 chip 悬停出嵌套卡都在那边统一实现，这里不再维护第二份重复实现）。
   */
  _buildTitleCard(item) {
    return buildItemTitleCard(item);
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
  if (labels[type]) return labels[type];
  // 查询自定义 BUFF 注册表
  const handler = CustomBuffRegistry.get(type);
  if (handler?.label) return handler.label;
  return type;
}

function _buffIconPath(type, name = "") {
  const base = "systems/limbusCompany_FVTT/assets/icons/Buff_icon/";
  const map  = { strong:"强壮", weak:"虚弱", endure:"忍耐", breach:"破绽",
    swift:"迅捷", bind:"束缚", guard:"守护", fragile:"易损",
    clashPowerUp:"拼点威力提升", clashPowerDown:"拼点威力降低",
    atkLevelUp:"攻击等级提升",   atkLevelDown:"攻击等级降低",
    defLevelUp:"防御等级提升",   defLevelDown:"防御等级降低",
    burn:"烧伤", bleed:"流血", tremor:"震颤", rupture:"破裂",
    sinking:"沉沦", breathing:"呼吸法", charge:"充能",
    chaos:"陷入混乱", panic:"陷入恐慌" };
  if (map[type]) return `${base}${map[type]}.webp`;
  // 注册表自定义 BUFF：图标在 Custom_buffs/ 子目录，使用中文标签作为文件名
  const regHandler = CustomBuffRegistry.get(type);
  if (regHandler?.label) return `${base}Custom_buffs/${regHandler.label}.webp`;
  // 其他自定义（type="custom" 或未知类型）：尝试用 name 在 Custom_buffs/ 中查找
  const customName = name || type;
  return customName ? `${base}Custom_buffs/${customName}.webp` : "";
}

