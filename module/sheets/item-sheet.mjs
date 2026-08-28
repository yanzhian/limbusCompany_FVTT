/**
 * item-sheet.mjs — 物品卡界面
 * LimbusItemSheet extends ItemSheet
 *
 * 支持类型：equipment / skill / consumable / material / container
 * 特性：
 *   - 🔒/🔓 编辑锁（runtime状态，不持久化）
 *   - 效果触发编辑器（Activity editor，折叠/展开）
 *   - 装备：链接方向切换（黑/白）
 *   - 容器：自定义网格
 */

import { ClashManager } from "../helpers/clash.mjs";
import { SKILLBOOK_MAX_SLOTS } from "../documents/item.mjs";
import { CustomBuffRegistry, normalizeBuffType } from "../helpers/custom-buffs.mjs";
import { linkifyHtml } from "../helpers/linkify.mjs";
import { GridDnD } from "../helpers/grid-dnd.mjs";
import { canContainerAccept, wouldNest } from "../helpers/container-rules.mjs";
import { buildPlacementGrid, canPlace, autoPlace, makeLockedSet } from "../helpers/grid-layout.mjs";

/** 背景的等级物品不收这三类（背景由向导指定、恐慌卡走 panicSlots、技能走技能书） */
const BG_ITEM_BLOCKED_TYPES = ["background", "panic", "skill"];

/**
 * 拖动 payload 里随身携带的物品"身份卡"：容器限制判定只看类型/分类/子类型，
 * 悬停预览必须同步出结果（来不及 await fromUuid），所以起拖时就带上。
 */
function _itemMetaOf(itemLike) {
  return {
    type:   itemLike?.type ?? "",
    system: {
      category: itemLike?.system?.category ?? "",
      subtype:  itemLike?.system?.subtype  ?? "",
    },
  };
}

/** 有没有在线 GM 可以代执行写操作（权限不足时的兜底通道） */
const _hasActiveGM = () => game.users?.some(u => u.isGM && u.active) ?? false;

/**
 * 激活效果剪贴板（本次会话内共享，跨物品卡有效，刷新页面后清空）。
 * 存的是去掉 id 的 activity 快照——粘贴时再补一个新 id。
 */
let _activityClipboard = null;

export class LimbusItemSheet extends ItemSheet {

  /** 当前 sheet 绑定的所有 Title 卡 hover controller（activateListeners 时填充） */
  _titleCardCtrls = [];

  /* ─── 默认选项 ──────────────────────────────────────────────────────────── */

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes:  ["limbuscompany", "sheet", "item"],
      width:    460,
      height:   500,
      tabs:     [],
      resizable: true,
      // 卡内任意改动都会重渲染，需保留正文滚动位置，否则会回滚置顶
      scrollY:  [".equip-body"],
    });
  }

  get template() {
    const typeMap = {
      equipment:  "equipment-sheet",
      skill:      "skill-sheet",
      consumable: "consumable-sheet",
      material:   "consumable-sheet",   // 共用一套模板
      container:  "container-sheet",
      skillbook:  "skillbook-sheet",
      panic:      "panic-sheet",
      background: "background-sheet",
    };
    const name = typeMap[this.item.type] ?? "equipment-sheet";
    return `systems/limbusCompany_FVTT/templates/item/${name}.hbs`;
  }

  /* ─── 编辑锁 runtime 状态 ──────────────────────────────────────────────── */

  get isLocked() { return this._isLocked ?? true; }
  set isLocked(v) { this._isLocked = v; }

  /* ─── 活动编辑器展开状态 ────────────────────────────────────────────────── */

  get activitiesExpanded() { return this._activitiesExpanded ?? false; }

  /* ─── E.G.O 形态（觉醒 / 侵蚀） ─────────────────────────────────────────── */

  /** 当前编辑的是不是 EGO 的【侵蚀】形态 */
  get _editCorrode() {
    return this.item.type === "skill"
      && this.item.system?.type === "ego"
      && this.item.system?.egoForm === "corrode";
  }
  /** 激活效果所在的字段名（侵蚀形态另存一套） */
  get _actField() { return this._editCorrode ? "corrode.activities" : "activities"; }
  get _actPath()  { return `system.${this._actField}`; }
  /** 当前形态的激活效果列表（原始存档值） */
  get _actList() {
    const src = this.item.toObject().system ?? {};
    return foundry.utils.deepClone(
      (this._editCorrode ? src.corrode?.activities : src.activities) ?? []
    );
  }

  /** 右上角 [觉醒/侵蚀] 切换：首次切到侵蚀时用觉醒的数值打底 */
  async _onEgoFormToggle(event) {
    event.preventDefault();
    const sys  = this.item.toObject().system ?? {};
    const next = sys.egoForm === "corrode" ? "awaken" : "corrode";
    const update = { "system.egoForm": next };
    if (next === "corrode" && !sys.corrode?.initialized) {
      Object.assign(update, {
        "system.corrode.initialized": true,
        "system.corrode.category":    sys.category    ?? "slash",
        "system.corrode.baseValue":   sys.baseValue   ?? 0,
        "system.corrode.diceCount":   sys.diceCount   ?? 1,
        "system.corrode.diceFaces":   sys.diceFaces   ?? 4,
        "system.corrode.weight":      sys.weight      ?? 1,
        "system.corrode.sanityCost":  sys.sanityCost  ?? 0,
        "system.corrode.effectDesc":  sys.effectDesc  ?? "",
        "system.corrode.activities":  foundry.utils.deepClone(sys.activities ?? []),
      });
    }
    await this.item.update(update);
  }

  /* ─── 数据准备 ──────────────────────────────────────────────────────────── */

  async getData() {
    const context  = await super.getData();
    const item     = this.item;
    const sys      = item.system;
    const cfg      = CONFIG.LIMBUSCOMPANY;

    context.system    = sys;
    context.config    = cfg;
    context.isLocked  = this.isLocked;
    context.isEditable = this.isEditable;
    context.activitiesExpanded = this.activitiesExpanded;

    // ── 稀有度标签（锁定时显示中文名）────────────────────────────────
    context.rarityLabel = (cfg.RARITY_LABELS ?? {})[sys.rarity] ?? "";

    // ── 恐慌卡：类型（士气低落 / 陷入恐慌）──────────────────────────────
    if (item.type === "panic") {
      context.panicTypes = cfg.PANIC_TYPES ?? {};
      context.panicTypeLabel = (cfg.PANIC_TYPES ?? {})[sys.panicType] ?? "未指定类型";
    }

    // ── 活动列表 ─────────────────────────────────────────────────────────
    // EGO 处于【侵蚀】编辑形态时，编辑的是 system.corrode.activities
    // 注意 _actField 可能是 "corrode.activities" 这种带点路径，不能直接方括号取值
    context.activities = foundry.utils.getProperty(item.toObject().system ?? {}, this._actField) ?? [];

    // 剪贴板状态（供「粘贴效果」按钮显示名字）
    context.clipboardActivityName = _activityClipboard?.name ?? "";

    // ── 技能专用数据 ──────────────────────────────────────────────────────
    if (item.type === "skill") {
      context.sinColor = cfg.SIN_COLORS?.[sys.sinType] ?? "#5F3E21";
      context.categoryIcon = _getCategoryIcon(sys.category);
      context.isBasic       = sys.type === "basic";
      context.isDefense     = sys.type === "defense";
      context.isEgo         = sys.type === "ego";
      context.isCounterType = sys.type === "defense" &&
        (sys.category === "counter" || sys.category === "clashCounter");

      // EGO 消耗行（罪孽消耗 / 调整抗性两形态共用）
      // 注意：schema 字段名为 sinCost[].sinType 和 egoResistanceAdj[].{sinType,multiplier}
      if (context.isEgo) {
        context.sinCosts      = sys.sinCost ?? [];
        context.egoResChanges = sys.egoResistanceAdj ?? [];
      }

      // 【觉醒】/【侵蚀】：卡面按 system.egoForm 决定编辑/展示哪一套。
      // 注意读的是 _source——持有者恐慌时 prepareDerivedData 会把侵蚀数据投影到
      // 顶层字段上，编辑器必须看原始存档值，否则会把投影结果写回觉醒那一套。
      const src   = item.toObject().system ?? {};
      const corrode = context.isEgo && sys.egoForm === "corrode";
      context.isCorrode    = corrode;
      context.egoFormLabel = corrode ? "侵蚀" : "觉醒";
      // 表单字段前缀：侵蚀形态下这些字段写进 system.corrode.*
      context.fp = corrode ? "system.corrode." : "system.";
      const cSrc = src.corrode ?? {};
      const pick = (k) => (corrode && cSrc[k] !== null && cSrc[k] !== undefined) ? cSrc[k] : src[k];
      // 当前形态下展示的那一套数值
      context.form = {
        category:   pick("category"),
        weight:     pick("weight"),
        sanityCost: pick("sanityCost"),
        effectDesc: corrode ? (cSrc.effectDesc ?? "") : (src.effectDesc ?? ""),
        // 【无差别攻击】：侵蚀形态可以单独开（null = 沿用觉醒）
        indiscriminate: !!(pick("indiscriminate") ?? false),
      };
      context.formDiceCount = pick("diceCount") ?? 1;
      context.formDiceFaces = pick("diceFaces") ?? 4;
      context.formBaseValue = pick("baseValue") ?? 0;
      context.formNegDice   = !!(pick("negativeDice") ?? false);

      // 攻击/守备类别选项：使用中文直接标签，避免模板渲染 i18n key 字符串
      const _catZh = cfg.CATEGORY_LABELS_ZH ?? {};
      context.attackCategories = Object.fromEntries(
        Object.keys(cfg.ATTACK_CATEGORIES ?? {}).map(k => [k, _catZh[k] ?? k])
      );
      context.defenseCategories = Object.fromEntries(
        Object.keys(cfg.DEFENSE_CATEGORIES ?? {}).map(k => [k, _catZh[k] ?? k])
      );
      // 罪孽类型：同样使用中文标签
      context.skillSinTypes = cfg.SIN_LABELS_ZH ?? {};

      // 技能骰公式（格式化为大写）——按当前展示的形态生成。
      // 这里是独立于 prepareDerivedData 的一份拼装（要区分觉醒/侵蚀形态），
      // 负面骰的方向必须在这里也照顾到，否则填 20-1D8 会被显示回 1D8+20。
      const _bv = context.formBaseValue;
      context.diceFormulaDisplay = context.formNegDice
        ? `${_bv}-${context.formDiceCount}D${context.formDiceFaces}`
        : `${context.formDiceCount}D${context.formDiceFaces}${_bv > 0 ? `+${_bv}` : ""}`;

      // 攻击容量小方块
      context.weightSquares = Array.from({ length: context.form.weight ?? 0 }, (_, i) => i);

      // 攻击容量 >= 2 时才给扩散方式 / 范围（1 格 = 5ft，半径 N → N×5+2.5 ft）。
      // 基础容量只有 1、靠效果临时增容的技能也可能需要指定方式，因此只要已经
      // 设过非默认值（广域乱射 / 范围 >1），这一栏就一直显示出来可编辑。
      // 扩散方式/范围与其它字段一样分形态：侵蚀填了就用侵蚀的，没填沿用觉醒的
      context.formSpreadMode  = pick("spreadMode")  ?? "chain";
      context.formSpreadRange = pick("spreadRange") ?? 1;
      const spreadSet = context.formSpreadMode === "spray" || context.formSpreadRange > 1;
      context.showSpread      = (context.form.weight ?? 0) >= 2 || spreadSet;
      context.spreadModeLabel = context.formSpreadMode === "spray" ? "广域乱射" : "链式扩散";
      context.spreadFt        = `${(context.formSpreadRange * 5 + 2.5).toFixed(1)}ft`;

      // 图标边框：与 HUD / 技能槽同一套（罪孽+等级空心框，EGO 为圆环）
      context.skillFrame = ClashManager._skillFrameIcon(item);
    }

    // ── 装备专用数据 ──────────────────────────────────────────────────────
    if (item.type === "equipment") {
      context.isWeapon    = sys.subtype === "weapon";
      // 武器的攻击方式与射程（1 格 = 5ft，沿用容量扩散那套换算口径）
      context.rangeTypeLabel = sys.rangeType === "ranged" ? "远程" : "近战";
      context.rangeFt        = `${((sys.range ?? 1) * 5 + 2.5).toFixed(1)}ft`;
      context.isUpper     = sys.subtype === "upper";
      context.isLower     = sys.subtype === "lower";
      context.isAccessory = sys.subtype === "accessory";
      const subtypeZh = { upper: "上装", lower: "下装", weapon: "武器", accessory: "饰品" };
      context.subtypes    = Object.fromEntries(Object.entries(cfg.EQUIPMENT_SUBTYPES ?? {}).map(([k, v]) => {
        const localized = game.i18n.localize(v);
        return [k, (localized && localized !== v) ? localized : (subtypeZh[k] ?? k)];
      }));
      // 必须传 object 而非 array：Foundry selectOptions 对纯数组会用索引(0/1/2)作为 value，
      // 导致表单提交的是整数字符串而非 "x0.5" 等，无法通过 validResists 校验。
      const _resArr = cfg.RESISTANCE_VALUES ?? ["x0.5", "x1.0", "x2.0"];
      context.resistanceValues = Object.fromEntries(_resArr.map(v => [v, v]));
      context.subtypeLabel = ({ weapon: "武器", upper: "上装", lower: "下装", accessory: "饰品" })[sys.subtype] ?? "装备";

      // 汇总修正行（用于解锁编辑）
      context.modifiers = _parseModifiers(sys);
    }

    // ── 消耗品/材料专用数据 ───────────────────────────────────────────────
    if (item.type === "consumable" || item.type === "material") {
      context.isConsumable = item.type === "consumable";
      context.isMaterial   = item.type === "material";
      context.typeLabel    = item.type === "consumable" ? "消耗品" : "材料";
    }

    // ── 恐慌卡专用数据 ────────────────────────────────────────────────────
    if (item.type === "panic") {
      context.typeLabel = "恐慌";
    }

    // ── 容器专用数据 ──────────────────────────────────────────────────────
    if (item.type === "container") {
      const cols = Math.max(1, Math.min(10, sys.gridSize?.width  ?? 3));
      const rows = Math.max(1, Math.min(10, sys.gridSize?.height ?? 3));
      context.gridCols  = cols;
      context.gridRows  = rows;
      context.gridSizeLabel   = `${cols} × ${rows}`;
      context.containerSearch = this._containerSearch ?? "";
      const { placedItems, allCells } = await this._buildContainerGrid(sys.contents ?? [], cols, rows, sys.lockedCells ?? []);
      context.placedItems    = placedItems;
      context.allCells       = allCells;
      context.containerUsed  = placedItems.length;
      context.containerMax   = cols * rows;
      context.containerAvail = allCells.filter(c => !c.occupied && !c.locked).length;
    }

    // ── 技能书专用数据 ──────────────────────────────────────────────────────
    if (item.type === "skillbook") {
      context.skillSlots = await this._buildSkillBookSlots(sys.skills ?? []);
      context.skillBookMax  = SKILLBOOK_MAX_SLOTS;
      context.skillBookUsed = (sys.skills ?? []).length;
    }

    // ── 背景专用数据 ────────────────────────────────────────────────────────
    if (item.type === "background") {
      context.startingItems = await this._resolveItemRefs(sys.startingItems ?? []);
      context.levelRewards  = await Promise.all(
        (sys.levelRewards ?? []).map(async (lr) => ({
          id:    lr.id,
          level: lr.level,
          items: await this._resolveItemRefs(lr.items ?? []),
        }))
      );
    }

    // ── Activity 触发时机 & 效果类型选项 ─────────────────────────────────
    context.activityTriggers = cfg.ACTIVITY_TRIGGERS ?? [];
    context.activityEffects  = _activityEffectLabels();
    return context;
  }

  /**
   * 容器数据写入。
   * 容器可能挂在**别人**的 Actor 上（最典型的是营地仓库里的箱子：物品属于营地
   * Actor，玩家对它只有"查看"权限），直接 `item.update()` 会被权限挡下。
   * 统一走 `_safeDocUpdate`：本人有权就直接写，没权就发 socket 请 GM 代执行。
   */
  async _containerUpdate(data) {
    return ClashManager._safeDocUpdate(this.item, data);
  }

  /**
   * 容器卡的实时刷新。
   * 容器格里画的是**别的物品**（按 uuid 引用），那些物品被移走/删除时 Foundry
   * 不会重渲染本卡，于是内容看着还在（其实早没了）。这里监听物品增删改，
   * 只要牵动本容器引用的 uuid 就重画；容器自己没了就直接关卡。
   */
  _registerContainerWatch() {
    if (this._containerWatchIds || this.item.type !== "container") return;
    const refresh = (doc) => {
      if (GridDnD.dragging) return;                 // 拖动中不打断
      const uuids = (this.item.system?.contents ?? []).map(p => p.uuid).filter(Boolean);
      if (!uuids.includes(doc?.uuid)) return;
      this.render(false);
    };
    const selfGone = (doc) => {
      if (doc?.id === this.item.id) this.close();
    };
    this._containerWatchIds = {
      createItem: Hooks.on("createItem", refresh),
      updateItem: Hooks.on("updateItem", refresh),
      deleteItem: Hooks.on("deleteItem", (doc) => { selfGone(doc); refresh(doc); }),
    };
  }

  /* ─── 容器网格构建 ──────────────────────────────────────────────────────── */

  /**
   * 将 contents 放置记录解析为模板所需数据（算法见 helpers/grid-layout.mjs）。
   * @returns {Promise<{ placedItems: Array, allCells: Array }>}
   */
  async _buildContainerGrid(placements, cols, rows, lockedCells = []) {
    const { placedItems, allCells } = await buildPlacementGrid(placements, {
      cols, rows, lockedCells,
      search: this._containerSearch ?? "",
      // 容器内孤儿记录直接忽略（不占格），与既有行为一致
      keepOrphanOccupancy: false,
    });
    return { placedItems, allCells };
  }

  /* ─── 技能书：解析存放的技能 ─────────────────────────────────────────────── */

  /**
   * 将 skillbook.system.skills 引用列表解析为模板所需数据。
   * @returns {Promise<Array>}
   */
  async _buildSkillBookSlots(entries) {
    const slots = [];
    for (let idx = 0; idx < entries.length; idx++) {
      const entry = entries[idx];
      let item = null;
      if (entry?.uuid) {
        item = await fromUuid(entry.uuid).catch(() => null);
      } else if (entry?.itemData) {
        item = { id: null, name: entry.itemData.name ?? "未知技能", img: entry.itemData.img ?? "icons/svg/book.svg", system: entry.itemData.system ?? {} };
      }
      if (!item) continue;
      const cfg = CONFIG.LIMBUSCOMPANY;
      slots.push({
        idx, uuid: entry.uuid ?? "",
        item: { _id: item.id, name: item.name, img: item.img },
        sinColor: cfg?.SIN_COLORS?.[item.system?.sinType] ?? "#5F3E21",
      });
    }
    return slots;
  }

  /**
   * 将通用物品引用条目（{id, uuid, itemData?}）解析为模板所需显示数据。
   * 用于背景物品的"初始物品"/"升级奖励物品"（可存放任意物品类型，含技能书）。
   * @returns {Promise<Array>}
   */
  async _resolveItemRefs(entries) {
    const out = [];
    for (const entry of entries) {
      let item = null;
      if (entry?.uuid) item = await fromUuid(entry.uuid).catch(() => null);
      if (!item && entry?.itemData) {
        item = { id: null, name: entry.itemData.name ?? "未知物品", img: entry.itemData.img ?? "icons/svg/item-bag.svg", type: entry.itemData.type ?? "" };
      }
      if (!item) continue;
      out.push({
        id:   entry.id,
        uuid: entry.uuid ?? "",
        item: { name: item.name, img: item.img, type: item.type },
      });
    }
    return out;
  }

  /**
   * 自动扫描容器，找到第一个可放入的位置。
   * @param {number} w @param {number} h @param {number} [excludeIdx=-1]
   * @returns {{ x:number, y:number, w:number, h:number, rotated:boolean }|null}
   */
  _cgAutoPlace(w, h, excludeIdx = -1) {
    const sys = this.item.system;
    return autoPlace(
      sys.contents ?? [], w, h,
      sys.gridSize?.width ?? 3, sys.gridSize?.height ?? 3,
      { excludeIdx, lockedSet: makeLockedSet(sys.lockedCells ?? []) }
    );
  }

  /** 同步碰撞检测（使用已持久化的 w/h，同时检查锁定格）。 */
  _cgCanPlace(x, y, w, h, cols, rows, excludeIdx = -1) {
    const sys = this.item.system;
    return canPlace(sys.contents ?? [], x, y, w, h, cols, rows, {
      excludeIdx, lockedSet: makeLockedSet(sys.lockedCells ?? []),
    });
  }

  /**
   * 容器网格的全部交互绑定。
   *
   * **必须在 `if (!this.isEditable) return;` 之前调用**：容器可能挂在别人的
   * Actor 上（营地仓库里的箱子最典型），玩家对它只有"查看"权限，isEditable
   * 恒为 false——绑定要是排在那道闸门后面，玩家端连拖动、右键菜单都不会挂上，
   * 表现就是"什么都点不动"。真正的权限判定不在这里，而在写入那一步：
   * `_containerUpdate()` 会在权限不足时转交在线 GM 代执行。
   */
  _bindContainerGrid(html) {
    html.find(".cg-cell").on("dragover",  this._onCgCellDragOver.bind(this));
    html.find(".cg-cell").on("dragleave", this._onCgCellDragLeave.bind(this));
    html.find(".cg-cell").on("drop",      this._onCgCellDrop.bind(this));
    html.find(".cg-cell").on("click",     this._onCgCellClick.bind(this));
    html.find(".cg-item-tile").on("dragstart",   this._onCgTileDragStart.bind(this));
    html.find(".cg-item-tile").on("contextmenu", this._onCgTileMenu.bind(this));
    html.find(".cg-item-tile").on("dblclick",    this._onCgTileDblClick.bind(this));
    // pointer 自绘拖放：图块的拖动交给 GridDnD（幽灵块 / 落点预览 / R 旋转），
    // 格子上的原生 drop 监听保留不动——侧边栏、合集包拖进来仍走原生 DnD，
    // GridDnD 松手时也是合成一个原生 drop 事件投给格子，复用同一套转移逻辑。
    const cgRoot = html.find(".cg-wrap")[0];
    if (cgRoot && this.item.type === "container") {
      this._registerContainerWatch();
      GridDnD.register(cgRoot, {
        key:        `container:${this.item.uuid}`,
        cols:       this.item.system.gridSize?.width  ?? 3,
        rows:       this.item.system.gridSize?.height ?? 3,
        // 容器可能挂在营地等"只读"Actor 上：写操作会转交 GM 代执行，
        // 所以只要有在线 GM 就允许拖动，不能拿 isEditable 一票否决
        editable:   () => this.isEditable || _hasActiveGM(),
        placements: () => this.item.system.contents ?? [],
        lockedSet:  () => makeLockedSet(this.item.system.lockedCells ?? []),
        // 悬停在容器图块上时：这个容器收不收拖着的这件东西
        tileAccepts: (tileEl, payload) => {
          const uuid = tileEl.dataset.itemUuid ?? "";
          const box  = uuid ? fromUuidSync(uuid) : null;
          if (!box || !payload.itemMeta) return true;
          return canContainerAccept(box, payload.itemMeta).ok;
        },
        payloadFor: (tile) => {
          const idx = parseInt(tile.dataset.placementIdx ?? -1);
          const p   = this.item.system.contents?.[idx];
          if (!p) return null;
          const payload = {
            type: "Item",
            x: p.x, y: p.y, w: p.w ?? 1, h: p.h ?? 1,
            placementIdx: idx,
            fromContainer: {
              isWorldContainer: !this.item.parent,
              actorId:          this.item.parent?.id ?? null,
              containerId:      this.item.id,
              placementIdx:     idx,
              offX: 0, offY: 0,
            },
          };
          if (p.uuid)     payload.uuid     = p.uuid;
          if (p.itemData) payload.itemData = p.itemData;
          const doc = p.uuid ? fromUuidSync(p.uuid) : null;
          payload.itemMeta = _itemMetaOf(doc ?? p.itemData);
          return payload;
        },
      });
    }

  }

  /* ─── 事件绑定 ──────────────────────────────────────────────────────────── */

  activateListeners(html) {
    super.activateListeners(html);

    // ── 只读 ─────────────────────────────────────────────────────────────
    html.find(".item-send-chat").on("click", () => this.item.sendToChat?.());
    html.find(".item-start-clash").on("click", this._onStartClash.bind(this));
    html.find(".item-activate").on("click",   this._onActivateItem.bind(this));
    html.find(".item-use-btn").on("click",    this._onUseItem.bind(this));

    // ── 编辑锁切换 ────────────────────────────────────────────────────────
    // 容器网格：放在只读段里绑定——权限判定交给写入时的 GM 代执行通道
    this._bindContainerGrid(html);

    html.find(".sheet-lock-icon").on("click", this._onToggleLock.bind(this));
    html.find(".ego-form-toggle").on("click", this._onEgoFormToggle.bind(this));

    // 攻击容量输入时即时切换扩散设置的显隐（不等重渲染）
    // 扩散设置写哪一套：EGO 在侵蚀形态下写 system.corrode.*，其余写 system.*
    // （不加这一层的话，改侵蚀的扩散方式会把觉醒的也一起改掉）
    const _spreadPath = (key) => {
      const corrode = this.item.type === "ego" && this.item.system?.egoForm === "corrode";
      return corrode ? `system.corrode.${key}` : `system.${key}`;
    };
    const _curSpread = (key, dflt) => {
      const sys = this.item.system ?? {};
      const corrode = this.item.type === "ego" && sys.egoForm === "corrode";
      const cv = corrode ? sys.corrode?.[key] : null;
      return (cv !== null && cv !== undefined) ? cv : (sys[key] ?? dflt);
    };

    html.find(".weight-input[name$='weight']").on("input", (ev) => {
      const n = parseInt(ev.currentTarget.value) || 0;
      const set = _curSpread("spreadMode", "chain") === "spray"
               || _curSpread("spreadRange", 1) > 1;
      html.find(".spread-box").toggleClass("on", n >= 2 || set);
    });
    // 扩散方式 / 范围：不走表单提交，直接写回物品（避免与其它提交逻辑互相覆盖）
    html.find(".spread-mode-sel").on("change", async (ev) => {
      ev.stopPropagation();
      const v = ev.currentTarget.value === "spray" ? "spray" : "chain";
      await this.item.update({ [_spreadPath("spreadMode")]: v });
    });
    html.find(".spread-range-input").on("input", (ev) => {
      const n = Math.min(6, Math.max(1, parseInt(ev.currentTarget.value) || 1));
      html.find(".spread-ft").text(`${(n * 5 + 2.5).toFixed(1)}ft`);
    });
    html.find(".spread-range-input").on("change", async (ev) => {
      ev.stopPropagation();
      const n = Math.min(6, Math.max(1, parseInt(ev.currentTarget.value) || 1));
      ev.currentTarget.value = n;                      // 空值/越界时回填合法值
      await this.item.update({ [_spreadPath("spreadRange")]: n });
    });

    // ── 图标点击：锁定时查看插图，解锁时由 Foundry data-edit 处理 ─────────
    html.find(".item-sheet-icon").on("click", (event) => {
      if (!this.isLocked) return;       // 解锁状态：让 data-edit="img" 正常触发
      event.preventDefault();
      event.stopImmediatePropagation();
      const img = this.item.img;
      if (img) new ImagePopout(img, { title: this.item.name }).render(true);
    });

    // 根元素同步锁定 class（供 CSS 选择器使用）
    if (this.isLocked) html.closest(".app").addClass("item-sheet-locked");
    else               html.closest(".app").removeClass("item-sheet-locked");

    // ── Activity 编辑区折叠 ───────────────────────────────────────────────
    html.find(".activity-edit-toggle").on("click", this._onActivityToggle.bind(this));
    html.find(".activity-add-btn").on("click",    this._onActivityAdd.bind(this));
    html.find(".activity-edit-btn").on("click",   this._onActivityEdit.bind(this));
    html.find(".activity-delete-btn").on("click", this._onActivityDelete.bind(this));
    html.find(".activity-copy-btn").on("click",   this._onActivityCopy.bind(this));
    html.find(".activity-dupe-btn").on("click",   this._onActivityDuplicate.bind(this));
    html.find(".activity-paste-btn").on("click",  this._onActivityPaste.bind(this));
    html.find(".activity-paste-json-btn").on("click", this._onActivityPasteJson.bind(this));

    if (!this.isEditable) return;

    // ── 装备子类型：强制同步当前值（避免浏览器回退首项） ───────────────
    if (this.item.type === "equipment") {
      const subtypeSel = html.find("select[name='system.subtype']");
      if (subtypeSel.length) {
        subtypeSel.val(this.item.system.subtype ?? "weapon");
        subtypeSel.on("change", (ev) => { this._debugSubtypeLast = ev.currentTarget.value; });
      }
    }

    // ── 技能各下拉菜单：强制同步当前值（原理同上，防止浏览器回退首项） ──
    if (this.item.type === "skill") {
      const sys = this.item.system;
      const _syncSel = (name, val) => {
        const el = html.find(`select[name='${name}']`);
        if (el.length) el.val(String(val ?? ""));
      };
      _syncSel("system.type",          sys.type           ?? "basic");
      _syncSel("system.category",      sys.category       ?? "slash");
      _syncSel("system.sinType",       sys.sinType        ?? "wrath");
      _syncSel("system.level",         sys.level          ?? 1);
      _syncSel("system.egoDiceRating", sys.egoDiceRating  ?? "");
      _syncSel("system.counterType",   sys.counterType    ?? "slash");
      _syncSel("system.diceType",      sys.diceType       ?? "normal");
    }

    // ── 链接方向箭头 ──────────────────────────────────────────────────────

    // ── 修正行 [+] ────────────────────────────────────────────────────────
    html.find(".modifier-add-btn").on("click", this._onModifierAdd.bind(this));
    html.find(".modifier-remove-btn").on("click", this._onModifierRemove.bind(this));

    // ── EGO 消耗行 ────────────────────────────────────────────────────────
    html.find(".sin-cost-add-btn").on("click", this._onSinCostAdd.bind(this));
    html.find(".sin-cost-remove-btn").on("click", this._onSinCostRemove.bind(this));
    html.find(".res-change-add-btn").on("click", this._onResChangeAdd.bind(this));
    html.find(".res-change-remove-btn").on("click", this._onResChangeRemove.bind(this));

    // ── 星芒数字直接点击修改（解锁状态） ─────────────────────────────────
    html.find(".stellar-cost-edit").on("click", this._onStellarCostEdit.bind(this));

    // ── 容器搜索 ──────────────────────────────────────────────────────────
    html.find(".container-search").on("input", this._onContainerSearch.bind(this));

    // 解锁状态下，空格子显示 pointer 光标（提示可点击锁定）
    if (!this.isLocked && this.item.type === "container") {
      html.find(".cg-wrap").addClass("cg-edit-unlocked");
    }

    // ── 技能书 ───────────────────────────────────────────────────────────
    html.find(".skillbook-dropzone").on("dragover",  this._onSkillBookDragOver.bind(this));
    html.find(".skillbook-dropzone").on("dragleave", this._onSkillBookDragLeave.bind(this));
    html.find(".skillbook-dropzone").on("drop",      this._onSkillBookDrop.bind(this));
    html.find(".skillbook-slot").on("contextmenu",   this._onSkillBookSlotMenu.bind(this));

    // ── 背景 ─────────────────────────────────────────────────────────────
    html.find(".bg-dropzone").on("dragover",  this._onSkillBookDragOver.bind(this));
    html.find(".bg-dropzone").on("dragleave", this._onSkillBookDragLeave.bind(this));
    html.find(".bg-dropzone").on("drop",      this._onBgItemDrop.bind(this));
    html.find(".bg-item-remove").on("click",  this._onBgItemRemove.bind(this));
    html.find(".bg-add-level").on("click",    this._onBgAddLevelReward.bind(this));
    html.find(".bg-level-remove").on("click", this._onBgRemoveLevelReward.bind(this));
    html.find(".bg-level-input").on("change", this._onBgLevelChange.bind(this));
    html.find(".bg-edit-rewards-btn").on("click", this._onToggleLock.bind(this));
    html.find(".skillbook-learn-btn").on("click",    this._onSkillBookLearn.bind(this));

    // ── 物品图块 / 描述文本内 BUFF/物品悬停 chip：统一 Title 卡绑定 ─────────
    this._titleCardCtrls = [];
    this._bindItemTitleCardHover(html, ".cg-item-tile, .skillbook-slot, .bg-item-chip");
    html.find(".desc-buff-chip").each((_i, el) => {
      this._titleCardCtrls.push(attachHoverableTitleCard(el, () => buildBuffTitleCard(el.dataset.buffName)));
    });
    html.find(".desc-item-chip").each((_i, el) => {
      this._titleCardCtrls.push(attachHoverableTitleCard(el, async () => {
        const item = await _findItemByName(el.dataset.itemName);
        return item ? _buildItemTitleCard(item) : null;
      }));
    });
  }


  async _updateObject(event, formData) {
    if (this.item.type === "equipment") {
      const validSubtypes = ["upper", "lower", "weapon", "accessory"];
      const validResists  = ["x0.5", "x1.0", "x2.0"];

      // Foundry 版本差异下，formData 可能是扁平对象或嵌套对象
      const expanded = formData.system ? foundry.utils.deepClone(formData) : foundry.utils.expandObject(formData);
      expanded.system ??= {};

      const flatSubtype = formData["system.subtype"];
      const domSubtype = this.element?.find?.("[name='system.subtype']")?.val?.();
      const nextSubtype = expanded.system.subtype ?? flatSubtype;
      if (!validSubtypes.includes(nextSubtype)) {
        expanded.system.subtype = this.item.system.subtype ?? "weapon";
      } else {
        expanded.system.subtype = nextSubtype;
      }

      // 关键修复：只应用“当前变化字段”，其余抗性沿用当前值，避免未改字段被回写成 x0.5
      const currentRes = this.item.system.resistanceAdj ?? {};
      expanded.system.resistanceAdj ??= {};
      const changedName = event?.target?.name ?? event?.currentTarget?.name ?? null;
      const changedResKey = changedName?.startsWith("system.resistanceAdj.")
        ? changedName.replace("system.resistanceAdj.", "")
        : null;

      for (const key of ["slash", "blunt", "pierce"]) {
        const nextRes = expanded.system.resistanceAdj[key];

        // 单字段变更提交：非当前字段一律继承旧值
        // 注意：用 || 而非 ??，因为 schema 默认值是 ""（空字符串），?? 不会触发回退
        if (changedResKey && key !== changedResKey) {
          expanded.system.resistanceAdj[key] = currentRes[key] || "x1.0";
          continue;
        }

        if (nextRes === undefined || nextRes === "") {
          expanded.system.resistanceAdj[key] = currentRes[key] || "x1.0";
          continue;
        }
        if (!validResists.includes(nextRes)) {
          expanded.system.resistanceAdj[key] = currentRes[key] || "x1.0";
        }
      }

      // 调试：请把这条日志（equipment submit）内容反馈给我定位现场数据
      console.warn("[LimbusItemSheet][equipment submit]", {
        itemId: this.item.id,
        itemName: this.item.name,
        isLocked: this.isLocked,
        subtypeBefore: this.item.system.subtype,
        subtypeAfter: expanded.system?.subtype,
        subtypeFlat: flatSubtype,
        subtypeDOM: domSubtype,
        subtypeLastChanged: this._debugSubtypeLast,
        changedInputName: event?.target?.name ?? event?.currentTarget?.name ?? null,
        resistanceBefore: this.item.system.resistanceAdj,
        resistanceAfter: expanded.system?.resistanceAdj,
      });

      if (formData.system) {
        Object.assign(formData, expanded);
      } else {
        const flattened = foundry.utils.flattenObject(expanded);
        for (const k of Object.keys(formData)) delete formData[k];
        Object.assign(formData, flattened);
      }
    }

    // ── 标签：输入框里是 "标签1/标签2"，数组型字段要先切成数组再写库 ────────
    // 不切的话 ArrayField 会把整串当成一个元素（["标签1/标签2"]），
    // 卡面上就成了一个连在一起的标签。
    {
      const splitTags = (raw) => String(raw)
        .split(/[\/,，;；]/).map(t => t.trim()).filter(Boolean);
      // 该物品的 tags 是不是数组字段：优先看 schema，其次看当前存的值
      let isArr = Array.isArray(this.item.system?.tags);
      try {
        const field = this.item.system?.schema?.getField?.("tags");
        if (field) isArr = field instanceof foundry.data.fields.ArrayField;
      } catch { /* schema 取不到就沿用上面的判断 */ }

      if (isArr) {
        // 扁平 / 嵌套两种提交形态都要处理（同一次提交里可能只出现其中一种）
        if (typeof formData["system.tags"] === "string") {
          formData["system.tags"] = splitTags(formData["system.tags"]);
        }
        if (typeof formData.system?.tags === "string") {
          formData.system.tags = splitTags(formData.system.tags);
        }
      }
    }

    // ── skill：将用户输入的 diceFormula 文本解析为真正的 schema 字段
    if (this.item.type === "skill") {
      // 侵蚀形态编辑时，骰数写进 system.corrode.*
      const corrode  = this._editCorrode;
      const pre      = corrode ? "system.corrode." : "system.";
      const _isFlat  = !formData.system;
      const nested   = () => (corrode ? formData.system?.corrode : formData.system) ?? {};
      const rawFml   = _isFlat ? formData[`${pre}diceFormula`] : nested().diceFormula;
      if (rawFml !== undefined) {
        const parsed = _parseDiceFormula(String(rawFml));
        if (parsed) {
          if (_isFlat) {
            formData[`${pre}diceCount`]    = parsed.diceCount;
            formData[`${pre}diceFaces`]    = parsed.diceFaces;
            formData[`${pre}baseValue`]    = parsed.baseValue;
            formData[`${pre}negativeDice`] = parsed.negativeDice;
          } else {
            Object.assign(nested(), {
              diceCount:    parsed.diceCount,
              diceFaces:    parsed.diceFaces,
              baseValue:    parsed.baseValue,
              negativeDice: parsed.negativeDice,
            });
          }
        }
        // 无论解析成功与否都丢弃原始文本（prepareDerivedData 会重新生成）
        if (_isFlat) delete formData[`${pre}diceFormula`];
        else         delete nested().diceFormula;
      }
    }

    return super._updateObject(event, formData);
  }


  /* ─── 关闭时清理 ───────────────────────────────────────────────────────── */

  async close(options = {}) {
    this._forceCloseAllTitleCards();
    for (const [hook, id] of Object.entries(this._containerWatchIds ?? {})) Hooks.off(hook, id);
    this._containerWatchIds = null;
    return super.close(options);
  }

  /* ─── 锁切换 ────────────────────────────────────────────────────────────── */

  async _onToggleLock(event) {
    // 变更：不在锁切换时强制提交，避免锁定流程触发二次回写（导致抗性回退）
    this.isLocked = !this.isLocked;
    console.warn("[LimbusItemSheet][lock-toggle]", {
      itemId: this.item.id,
      itemName: this.item.name,
      nowLocked: this.isLocked,
      subtype: this.item.system.subtype,
      resistance: this.item.system.resistanceAdj,
    });
    this.render(false);
  }

  /* ─── 发送聊天框 ────────────────────────────────────────────────────────── */

  async _onSendToChat(event) {
    const item = this.item;
    const sys  = item.system;

    let content = "";
    if (item.type === "skill") {
      const sinColor = CONFIG.LIMBUSCOMPANY.SIN_COLORS?.[sys.sinType] ?? "#5F3E21";
      content = `
        <div class="limbuscompany-card">
          <div class="card-title" style="background:${sinColor}">${item.name}</div>
          <div class="card-body">
            <div><img src="${_getCategoryIcon(sys.category)}" width="16" alt=""> ${(sys.diceFormula ?? "").toUpperCase()}</div>
            <div style="color:var(--text-sub);font-size:.75rem">${ClashManager._itemTags(item).join(" / ")}</div>
            <div style="margin-top:4px">${sys.description ?? sys.effectDesc ?? ""}</div>
          </div>
        </div>`;
    } else if (item.type === "equipment") {
      content = `
        <div class="limbuscompany-card">
          <div class="card-title tc-equip-header">${item.name}</div>
          <div class="card-body">
            <div>${_subtypeLabel(sys.subtype)}　${sys.category ?? ""}</div>
            <div style="margin-top:4px">${sys.description ?? ""}</div>
          </div>
        </div>`;
    } else {
      content = `
        <div class="limbuscompany-card">
          <div class="card-title">${item.name} × ${sys.quantity ?? 1}</div>
          <div class="card-body">${sys.description ?? ""}</div>
        </div>`;
    }

    ChatMessage.create({
      speaker: { alias: game.user.name },
      content,
    });
  }

  /* ─── 发起对抗（与角色卡 item-start-clash 逻辑一致）────────────────────── */

  async _onStartClash(event) {
    const item  = this.item;
    const actor = item.parent ?? null;
    if (!actor) { ui.notifications.warn("请从角色卡背包发起对抗。"); return; }
    // 行动值不再是使用技能的门槛，它代表可承受的拼点失败次数
    await ClashManager.showInitiateDialog(actor, item, -2);
  }

  /* ─── 激活消耗品（与角色卡背包激活逻辑一致）────────────────────────────── */

  async _onActivateItem(event) {
    const item  = this.item;
    const actor = item.parent ?? null;
    if (item.type === "consumable") {
      const qty = item.system.quantity ?? 0;
      if (qty <= 0) { ui.notifications.warn("数量不足。"); return; }
    }
    // 守备技能激活不再消耗行动值，但仍要做[使用时]次数预检
    if (item.type === "skill" && item.system?.type === "defense" && actor) {
      const { blocked, reasons } = ClashManager._checkAllActivitiesBlocked(item, "使用时", actor);
      if (blocked) {
        const detail = reasons.length ? `（${reasons.join("；")}）` : "";
        ui.notifications.warn(`【${item.name}】的使用次数已达上限，本次使用被取消。${detail}`);
        return;
      }
    }
    await ClashManager._applyActivities(item, "使用时", {
      owner: actor, atkActor: actor, defActor: null, _fireCounts: {}, _actMsgs: [],
    });
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

  /* ─── 使用消耗品（旧路径，保留备用）──────────────────────────────────────── */

  async _onUseItem(event) {
    const item     = this.item;
    const qty      = item.system.quantity ?? 0;
    const reusable = item.system.reusable ?? false;
    if (qty <= 0) { ui.notifications.warn("数量不足。"); return; }

    const newQty = qty - 1;
    await item.update({ "system.quantity": newQty });
    ChatMessage.create({
      content: `<div class="limbuscompany-card"><div class="card-title">${item.name}</div><div class="card-body">使用了 1 个 ${item.name}。</div></div>`,
    });

    // 普通消耗品数量归零时，自动从拥有者背包中移除
    if (newQty <= 0 && !reusable && item.parent) {
      await item.delete();
    }

    // 触发消耗品的效果（Activity 系统在阶段7实现）
  }

  /* ─── Activity 编辑区 ───────────────────────────────────────────────────── */

  _onActivityToggle(event) {
    this._activitiesExpanded = !this.activitiesExpanded;
    this.render(false);
  }

  async _onActivityAdd(event) {
    const activities = this._actList;
    activities.push({
      id:            foundry.utils.randomID(),
      name:          "新效果",
      trigger:       "攻击时",
      preconditions: [],
      costs:         [],
      effects:       [],
      limit:         { type: "unlimited", count: 0 },
    });
    await this.item.update({ [this._actPath]: activities });
    this._activitiesExpanded = true;
    this.render(false);
  }

  async _onActivityEdit(event) {
    const idx  = parseInt(event.currentTarget.closest("[data-activity-idx]")?.dataset.activityIdx ?? -1);
    const acts = this._actList;
    if (idx < 0 || idx >= acts.length) return;

    await this._showActivityEditor(acts, idx);
  }

  async _onActivityDelete(event) {
    const idx  = parseInt(event.currentTarget.closest("[data-activity-idx]")?.dataset.activityIdx ?? -1);
    const acts = this._actList;
    if (idx < 0 || idx >= acts.length) return;
    acts.splice(idx, 1);
    await this.item.update({ [this._actPath]: acts });
  }

  /** 复制一条效果到剪贴板（跨物品卡可粘贴） */
  _onActivityCopy(event) {
    event.preventDefault();
    const idx  = parseInt(event.currentTarget.closest("[data-activity-idx]")?.dataset.activityIdx ?? -1);
    const acts = this._actList;
    if (idx < 0 || idx >= acts.length) return;

    _activityClipboard = _normalizeActivity(acts[idx]);
    ui.notifications?.info(`已复制效果「${_activityClipboard.name}」`);
    this.render(false);
  }

  /** 就地复制一条效果（同一物品内再来一份） */
  async _onActivityDuplicate(event) {
    event.preventDefault();
    const idx  = parseInt(event.currentTarget.closest("[data-activity-idx]")?.dataset.activityIdx ?? -1);
    const acts = this._actList;
    if (idx < 0 || idx >= acts.length) return;

    const copy = _normalizeActivity(acts[idx]);   // 已带新 id
    copy.name = `${copy.name}（副本）`;
    acts.splice(idx + 1, 0, copy);          // 紧跟在原条目后面，方便对照着改
    await this.item.update({ [this._actPath]: acts });
    this._activitiesExpanded = true;
    this.render(false);
  }

  /** 把剪贴板里的效果粘到当前列表末尾 */
  /**
   * 「粘贴 JSON」：把一整段效果 JSON 贴进来追加到本物品（给已有物品补效果用）。
   * 接受单个对象、对象数组，或整个 { activities: [...] }。
   */
  async _onActivityPasteJson(event) {
    event.preventDefault();
    const content = `
      <div style="font-size:.75rem;color:#9A8462;margin-bottom:6px;">
        粘贴效果 JSON：可以是单条 <code>{...}</code>、数组 <code>[...]</code>，
        或整个 <code>{ "activities": [...] }</code>。会<b>追加</b>到现有效果后面。
      </div>
      <textarea name="json" style="width:100%;height:220px;font-family:monospace;font-size:.72rem;"
                placeholder='[{"name":"新效果","trigger":"攻击时","preconditions":[],"costs":[],"effects":[]}]'></textarea>`;

    const raw = await new Promise(resolve => {
      new Dialog({
        title: "粘贴效果 JSON",
        content,
        buttons: {
          ok:     { label: "粘贴", callback: (html) => resolve(html.find("[name='json']").val() ?? "") },
          cancel: { label: "取消", callback: () => resolve(null) },
        },
        default: "ok",
        render: (html) => setTimeout(() => html.find("[name='json']").trigger("focus"), 30),
      }, { width: 520 }).render(true);
    });
    if (raw === null) return;

    const text = String(raw).trim();
    if (!text) { ui.notifications?.warn("没有内容可粘贴。"); return; }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (err) { ui.notifications?.error(`JSON 解析失败：${err.message}`); return; }

    // 兼容三种写法：单条对象 / 数组 / { activities: [...] }
    let list = Array.isArray(parsed) ? parsed
             : Array.isArray(parsed?.activities) ? parsed.activities
             : (parsed && typeof parsed === "object") ? [parsed] : null;
    if (!list?.length) { ui.notifications?.error("JSON 里没有找到效果条目。"); return; }

    const acts = this._actList;
    let added = 0;
    for (const raw2 of list) {
      if (!raw2 || typeof raw2 !== "object") continue;
      acts.push({
        id:            foundry.utils.randomID(),          // 一律重新发号，避免与现有条目撞 id
        name:          String(raw2.name ?? "新效果"),
        trigger:       String(raw2.trigger ?? "攻击时"),
        preconditions: Array.isArray(raw2.preconditions) ? raw2.preconditions : [],
        costs:         Array.isArray(raw2.costs)         ? raw2.costs         : [],
        effects:       Array.isArray(raw2.effects)       ? raw2.effects       : [],
        limit: {
          type:  String(raw2.limit?.type ?? "unlimited"),
          count: Number(raw2.limit?.count ?? 0) || 0,
        },
      });
      added++;
    }
    if (!added) { ui.notifications?.error("JSON 里没有可用的效果条目。"); return; }

    await this.item.update({ [this._actPath]: acts });
    this._activitiesExpanded = true;
    this.render(false);
    ui.notifications?.info(`已粘贴 ${added} 条效果到【${this.item.name}】`);
  }

  async _onActivityPaste(event) {
    event.preventDefault();
    if (!_activityClipboard) {
      ui.notifications?.warn("剪贴板里还没有效果——先在任意物品卡上点一条效果的「复制」。");
      return;
    }
    const acts = this._actList;
    const copy = foundry.utils.deepClone(_activityClipboard);
    copy.id = foundry.utils.randomID();
    acts.push(copy);
    await this.item.update({ [this._actPath]: acts });
    this._activitiesExpanded = true;
    this.render(false);
  }

  async _showActivityEditor(acts, idx) {
    const act = acts[idx];
    const cfg = CONFIG.LIMBUSCOMPANY;

    // 迁移旧数据（单对象字段 → 数组）
    const preconditions = Array.isArray(act.preconditions)
      ? foundry.utils.deepClone(act.preconditions)
      : (act.precondition ? [act.precondition] : []);
    const costs = Array.isArray(act.costs)
      ? foundry.utils.deepClone(act.costs)
      : (act.cost ? [act.cost] : []);
    const effects = Array.isArray(act.effects)
      ? foundry.utils.deepClone(act.effects)
      : (act.effect ? [act.effect] : []);
    const limitType = act.limit?.type ?? "unlimited";

    const content = `
      ${_buildBuffDatalistHtml("ae-buff-dl", cfg)}
      ${_buildTriggerBuffDatalistHtml("ae-trig-buff-dl", cfg)}
      ${_buildOwnedSkillDatalistHtml("ae-owned-skill-dl", this.item.parent)}
      ${_buildSpecialTremorDatalistHtml("ae-sp-tremor-dl")}
      <div class="ae-v2 limbuscompany">
        <div class="ae-title-bar">效果触发编辑器</div>
        <div class="ae-gold-line"></div>
        <div class="ae-body">

          <div class="ae-field-row">
            <label class="ae-label">名称</label>
            <input class="ae-input" type="text" name="act-name" value="${_esc(act.name ?? "")}">
          </div>

          <div class="ae-section">
            <div class="ae-section-hd">
              <span class="ae-section-num">①</span>
              <span class="ae-section-title">触发时机</span>
            </div>
            <select class="ae-select" name="act-trigger">
              ${_buildTriggerOpts(act.trigger)}
            </select>
          </div>

          <div class="ae-section">
            <div class="ae-section-hd">
              <span class="ae-section-num">②</span>
              <span class="ae-section-title">前置条件</span>
              <button type="button" class="ae-add-btn ae-add-precond">＋</button>
            </div>
            <div class="ae-precond-list">
              ${preconditions.map((c, i) => _buildCondRow(c, i, cfg)).join("")}
            </div>
          </div>

          <div class="ae-section">
            <div class="ae-section-hd">
              <span class="ae-section-num">③</span>
              <span class="ae-section-title">消耗</span>
              <button type="button" class="ae-add-btn ae-add-cost">＋</button>
            </div>
            <div class="ae-cost-list">
              ${costs.map((c, i) => _buildCostRow(c, i, cfg)).join("")}
            </div>
          </div>

          <div class="ae-section">
            <div class="ae-section-hd">
              <span class="ae-section-num">④</span>
              <span class="ae-section-title">效果</span>
              <button type="button" class="ae-add-btn ae-add-effect">＋</button>
            </div>
            <div class="ae-effect-list">
              ${effects.map((e, i) => _buildEffectRow(e, i, cfg)).join("")}
            </div>
          </div>

          <div class="ae-section">
            <div class="ae-section-hd">
              <span class="ae-section-num">⑤</span>
              <span class="ae-section-title">次数限制</span>
              <button type="button" class="ae-add-btn ae-toggle-limit">＋</button>
            </div>
            <div class="ae-limit-body" style="display:${limitType !== "unlimited" ? "flex" : "none"}">
              <select class="ae-select ae-input-sm" name="act-limit-type">
                <option value="unlimited"  ${limitType === "unlimited"   ? "selected" : ""}>无限制</option>
                <option value="perTurn"    ${limitType === "perTurn"     ? "selected" : ""}>每回合</option>
                <option value="perEncounter" ${limitType === "perEncounter" ? "selected" : ""}>每次遭遇战</option>
              </select>
              <input class="ae-input ae-input-sm" type="number" name="act-limit-count"
                     value="${act.limit?.count ?? 1}" min="1">
              <label class="ae-label">次</label>
            </div>
          </div>

        </div>
      </div>`;

    return new Promise(resolve => {
      new Dialog({
        title: "效果触发编辑器",
        content,
        buttons: {
          save: {
            label: "保存",
            callback: async (html) => {
              acts[idx] = _readActivityForm(html, act);
              await this.item.update({ [this._actPath]: acts });
              resolve(true);
            },
          },
          cancel: { label: "取消", callback: () => resolve(false) },
        },
        default: "save",
        render: (html) => { _setupAeDialog(html, cfg); },
      }, { width: 560, classes: ["dialog", "ae-dialog", "limbuscompany"] }).render(true);
    });
  }

  /* ─── 修正行 ────────────────────────────────────────────────────────────── */

  async _onModifierAdd(event) {
    const mods = foundry.utils.deepClone(this.item.system.modifiers ?? []);
    mods.push({ type: "atk", value: 0 });
    await this.item.update({ "system.modifiers": mods });
  }

  async _onModifierRemove(event) {
    const idx  = parseInt(event.currentTarget.dataset.idx ?? -1);
    const mods = foundry.utils.deepClone(this.item.system.modifiers ?? []);
    if (idx >= 0) { mods.splice(idx, 1); await this.item.update({ "system.modifiers": mods }); }
  }

  /* ─── EGO 罪孽消耗行 ────────────────────────────────────────────────────── */

  async _onSinCostAdd(event) {
    const costs = foundry.utils.deepClone(this.item.system.sinCost ?? []);
    costs.push({ sinType: "wrath", amount: 1 }); // schema 字段名为 sinType
    await this.item.update({ "system.sinCost": costs });
  }

  async _onSinCostRemove(event) {
    const idx   = parseInt(event.currentTarget.dataset.idx ?? -1);
    const costs = foundry.utils.deepClone(this.item.system.sinCost ?? []);
    if (idx >= 0) { costs.splice(idx, 1); await this.item.update({ "system.sinCost": costs }); }
  }

  async _onResChangeAdd(event) {
    // 条目属性为 {sinType, multiplier}
    const changes = foundry.utils.deepClone(this.item.system.egoResistanceAdj ?? []);
    changes.push({ sinType: "wrath", multiplier: "x1.0" });
    await this.item.update({ "system.egoResistanceAdj": changes });
  }

  async _onResChangeRemove(event) {
    const idx     = parseInt(event.currentTarget.dataset.idx ?? -1);
    const changes = foundry.utils.deepClone(this.item.system.egoResistanceAdj ?? []);
    if (idx >= 0) { changes.splice(idx, 1); await this.item.update({ "system.egoResistanceAdj": changes }); }
  }

  /* ─── 星芒费用编辑 ──────────────────────────────────────────────────────── */

  async _onStellarCostEdit(event) {
    const newVal = parseInt(prompt("星芒费用", this.item.system.stellarCost ?? 0));
    if (!isNaN(newVal)) await this.item.update({ "system.stellarCost": Math.max(0, newVal) });
  }

  /* ─── 容器搜索 ──────────────────────────────────────────────────────────── */

  _onContainerSearch(event) {
    this._containerSearch = event.target.value;
    const q = this._containerSearch.toLowerCase();
    this.element.find(".cg-item-tile").each((_, tile) => {
      const name = $(tile).data("item-name") ?? "";
      $(tile).toggle(!q || name.toLowerCase().includes(q));
    });
  }

  /* ─── 容器格：拖入高亮 ──────────────────────────────────────────────────── */

  _onCgCellDragOver(event) {
    event.preventDefault();
    event.originalEvent.dataTransfer.dropEffect = "move";
    $(event.currentTarget).addClass("cg-drag-over");
  }

  _onCgCellDragLeave(event) {
    $(event.currentTarget).removeClass("cg-drag-over");
  }

  /* ─── 容器格：放置 ──────────────────────────────────────────────────────── */

  async _onCgCellDrop(event) {
    event.preventDefault();
    $(event.currentTarget).removeClass("cg-drag-over");

    const cell    = event.currentTarget;
    const targetX = parseInt(cell.dataset.x ?? 0);
    const targetY = parseInt(cell.dataset.y ?? 0);
    const sys     = this.item.system;
    const cols    = sys.gridSize?.width  ?? 3;
    const rows    = sys.gridSize?.height ?? 3;

    let raw;
    try { raw = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain")); }
    catch { return; }

    // ── 容器图块：同容器内部重新定位 ───────────────────────────────────
    if (raw.type === "Item" && raw.fromContainer?.containerId === this.item.id) {
      const { placementIdx: idx, offX = 0, offY = 0 } = raw.fromContainer;
      const contents = foundry.utils.deepClone(sys.contents ?? []);
      const p = contents[idx];
      if (!p) return;
      // GridDnD：拖动中按过 R —— 按旋转后的尺寸落地，抓取偏移随之作废
      const rot = !!raw.rotatePending;
      const pw  = rot ? (p.h ?? 1) : (p.w ?? 1);
      const ph  = rot ? (p.w ?? 1) : (p.h ?? 1);
      const nx  = rot ? targetX : targetX - offX;
      const ny  = rot ? targetY : targetY - offY;
      if (!this._cgCanPlace(nx, ny, pw, ph, cols, rows, idx))
        return void ui.notifications.warn("此位置无法放置（超出边界或与其他物品重叠）");
      p.x = nx; p.y = ny;
      if (rot) { p.w = pw; p.h = ph; p.rotated = !p.rotated; }
      return void await this._containerUpdate({ "system.contents": contents });
    }

    // ── 金库物品拖入（带 itemData，无 UUID）────────────────────────────────
    // 来自世界金库的物品没有有效 UUID，fromDropData 无法解析，需在此提前处理
    if (raw.type === "Item" && raw.itemData && raw.fromContainer
        && raw.fromContainer.containerId !== this.item.id) {
      const itemDataSrc = raw.itemData;
      // 存放限制（类型 AND 分类；容器套容器由类型限制决定）
      const vaultVerdict = canContainerAccept(this.item, itemDataSrc);
      if (!vaultVerdict.ok) return void ui.notifications.warn(vaultVerdict.reason);

      const cap  = itemDataSrc.system?.capacity ?? { w: 1, h: 1 };
      const rot0 = !!raw.rotatePending;                        // GridDnD 的待定旋转
      const w = Math.max(1, (rot0 ? cap.h : cap.w) ?? 1);
      const h = Math.max(1, (rot0 ? cap.w : cap.h) ?? 1);
      // 目标格有效则直接用，否则自动寻找第一个可放入的位置（含旋转尝试）
      const place = this._cgCanPlace(targetX, targetY, w, h, cols, rows)
        ? { x: targetX, y: targetY, w, h, rotated: rot0 }
        : this._cgAutoPlace(w, h);
      if (!place) return void ui.notifications.warn("容器容量空间已满，无法放入。");

      // 从源容器移除占位
      const { containerId: srcId, placementIdx: srcIdx,
              isWorldContainer: srcIsWorld, actorId: srcActorId } = raw.fromContainer;
      if (srcIsWorld) {
        const srcVault = game.items.get(srcId);
        if (srcVault) {
          const sc = foundry.utils.deepClone(srcVault.system.contents ?? []);
          sc.splice(srcIdx, 1);
          await srcVault.update({ "system.contents": sc });
        }
      } else {
        const srcActor2 = srcActorId ? game.actors?.get(srcActorId) : null;
        const srcCont   = srcActor2?.items.get(srcId);
        if (srcCont) {
          const sc = foundry.utils.deepClone(srcCont.system.contents ?? []);
          sc.splice(srcIdx, 1);
          await srcCont.update({ "system.contents": sc });
        }
      }

      // 放入目标容器
      const dstActor  = this.item.parent;
      const contents  = foundry.utils.deepClone(sys.contents ?? []);
      if (dstActor) {
        // 目标是 Actor 内容器：创建嵌入物品，存 UUID
        const newData = foundry.utils.deepClone(itemDataSrc);
        delete newData._id;
        const [newItem] = await dstActor.createEmbeddedDocuments("Item", [newData]);
        contents.push({ uuid: newItem.uuid, x: place.x, y: place.y, w: place.w, h: place.h, rotated: place.rotated });
      } else {
        // 目标也是世界金库：保持 itemData 存储
        contents.push({ uuid: "", itemData: itemDataSrc, x: place.x, y: place.y, w: place.w, h: place.h, rotated: place.rotated });
      }
      return void await this._containerUpdate({ "system.contents": contents });
    }

    // ── 从物品列表或其他容器拖入 ────────────────────────────────────────
    const dropped = await Item.fromDropData(raw).catch(() => null);
    if (!dropped) return;
    if (dropped.uuid === this.item.uuid) return;            // 禁止自引用
    // 存放限制（类型 AND 分类）+ 环检测（容器不能装进自己或自己的后代）
    const verdict = canContainerAccept(this.item, dropped);
    if (!verdict.ok) return void ui.notifications.warn(verdict.reason);
    if (await wouldNest(this.item, dropped)) {
      return void ui.notifications.warn("不能把容器放进它自己或它内部的容器里。");
    }

    // 玩家把营地仓库物品拖入营地自身的容器：全程需 GM 权限，走 socket
    if (raw.fromCampWarehouse && !game.user.isGM
        && this.item.parent?.id === raw.fromCampWarehouse.campActorId) {
      game.socket.emit("system.limbusCompany_FVTT", {
        type:             "campStoreToContainer",
        campActorId:      raw.fromCampWarehouse.campActorId,
        containerItemId:  this.item.id,
        itemUuid:         dropped.uuid,
        fromWarehouseIdx: raw.fromCampWarehouse.placementIdx,
        sourceActorId:    null,
        userId:           game.user.id,
      });
      return;
    }

    const cap  = dropped.system?.capacity ?? { w: 1, h: 1 };
    const rot1 = !!raw.rotatePending;                          // GridDnD 的待定旋转
    const w = Math.max(1, (rot1 ? cap.h : cap.w) ?? 1);
    const h = Math.max(1, (rot1 ? cap.w : cap.h) ?? 1);

    // 目标格有效则直接用，否则自动寻找第一个可放入的位置（含旋转尝试）
    const place = this._cgCanPlace(targetX, targetY, w, h, cols, rows)
      ? { x: targetX, y: targetY, w, h, rotated: rot1 }
      : this._cgAutoPlace(w, h);
    if (!place) return void ui.notifications.warn("容器容量空间已满，无法放入。");

    const containerActor = this.item.parent;
    const sourceActor    = dropped.parent;
    let storedUuid       = dropped.uuid;
    let storedItemData   = null;

    // 跨 Actor 拖入：将物品转移到容器所属 Actor，删除源物品
    if (containerActor && sourceActor && sourceActor.id !== containerActor.id) {
      const itemData = dropped.toObject();
      const [newItem] = await containerActor.createEmbeddedDocuments("Item", [itemData]);
      storedUuid = newItem.uuid;
      if (raw.fromCampWarehouse) {
        // 来自营地仓库：camp 侧清理（移除放置记录 + 删除物品）需 GM 权限
        const { LimbusCampSheet } = await import("./camp-sheet.mjs");
        const payload = {
          type:         "campRemoveFromWarehouse",
          campActorId:  raw.fromCampWarehouse.campActorId,
          placementIdx: raw.fromCampWarehouse.placementIdx,
          itemUuid:     dropped.uuid,
          userId:       game.user.id,
        };
        if (game.user.isGM) await LimbusCampSheet._gmExecuteRemoveFromWarehouse(payload);
        else game.socket.emit("system.limbusCompany_FVTT", payload);
      } else {
        // 若物品来自另一容器，先从源容器移除
        if (raw.fromContainer) {
          const { containerId, placementIdx } = raw.fromContainer;
          const srcContainer = sourceActor.items.get(containerId);
          if (srcContainer) {
            const srcContents = foundry.utils.deepClone(srcContainer.system.contents ?? []);
            srcContents.splice(placementIdx, 1);
            await srcContainer.update({ "system.contents": srcContents });
          }
        }
        await dropped.delete();
      }
    }
    // 世界金库拖入：容器为世界物品（无 Actor），物品来自某个 Actor → 存储完整数据并删除源物品
    else if (!containerActor && sourceActor) {
      storedItemData = dropped.toObject();
      storedUuid = "";
      // 若物品来自某个 Actor 内的容器，先从源容器移除占位
      if (raw.fromContainer) {
        const { containerId: srcId, placementIdx: srcIdx, actorId: srcActId } = raw.fromContainer;
        const srcActor2 = srcActId ? (game.actors?.get(srcActId) ?? sourceActor) : sourceActor;
        const srcCont = srcActor2?.items.get(srcId);
        if (srcCont) {
          const sc = foundry.utils.deepClone(srcCont.system.contents ?? []);
          sc.splice(srcIdx, 1);
          await srcCont.update({ "system.contents": sc });
        }
      }
      await dropped.delete();
    }
    // 同 Actor 从另一容器图块拖入：先从源容器移除占用，物品不删除
    else if (raw.fromContainer && raw.fromContainer.containerId !== this.item.id) {
      const { containerId, placementIdx } = raw.fromContainer;
      const srcContainer = containerActor?.items.get(containerId)
        ?? sourceActor?.items.get(containerId);
      if (srcContainer) {
        const srcContents = foundry.utils.deepClone(srcContainer.system.contents ?? []);
        srcContents.splice(placementIdx, 1);
        await srcContainer.update({ "system.contents": srcContents });
      }
    }
    // 来自仓库网格：移除仓库占位记录，物品本身留在 campActor 中不删除
    else if (raw.fromCampWarehouse) {
      const { campActorId, placementIdx: srcIdx } = raw.fromCampWarehouse;
      const campActor = game.actors?.get(campActorId);
      if (campActor) {
        const wc = foundry.utils.deepClone(campActor.system.warehouseContents ?? []);
        wc.splice(srcIdx, 1);
        await campActor.update({ "system.warehouseContents": wc });
      }
    }

    const contents = foundry.utils.deepClone(sys.contents ?? []);
    const entry = { uuid: storedUuid, x: place.x, y: place.y, w: place.w, h: place.h, rotated: place.rotated };
    if (storedItemData) entry.itemData = storedItemData;
    contents.push(entry);
    await this._containerUpdate({ "system.contents": contents });
  }

  /* ─── 技能书：拖入高亮 ──────────────────────────────────────────────────── */

  _onSkillBookDragOver(event) {
    event.preventDefault();
    event.originalEvent.dataTransfer.dropEffect = "move";
    $(event.currentTarget).addClass("cg-drag-over");
  }

  _onSkillBookDragLeave(event) {
    $(event.currentTarget).removeClass("cg-drag-over");
  }

  /* ─── 技能书：放置（仅接受 skill 类型物品，上限 16） ────────────────────── */

  async _onSkillBookDrop(event) {
    event.preventDefault();
    $(event.currentTarget).removeClass("cg-drag-over");

    const sys     = this.item.system;
    const skills  = foundry.utils.deepClone(sys.skills ?? []);
    if (skills.length >= SKILLBOOK_MAX_SLOTS) {
      return void ui.notifications.warn(`技能书已满（最多 ${SKILLBOOK_MAX_SLOTS} 个技能）`);
    }

    let raw;
    try { raw = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (raw.type !== "Item") return;

    const dropped = await Item.fromDropData(raw).catch(() => null);
    const droppedType = dropped?.type ?? raw.itemData?.type;
    if (droppedType !== "skill") {
      return void ui.notifications.warn("技能书只能存放技能类型的物品。");
    }

    const bookActor   = this.item.parent;
    const sourceActor = dropped?.parent ?? null;

    // 同一角色背包内的技能：仅存引用，不复制不删除
    if (dropped && bookActor && sourceActor && sourceActor.id === bookActor.id) {
      if (skills.some(s => s.uuid === dropped.uuid)) return void ui.notifications.warn("该技能已在技能书中。");
      skills.push({ uuid: dropped.uuid, itemData: null });
      return void await this.item.update({ "system.skills": skills });
    }

    // 跨角色拖入：在技能书所属角色处创建嵌入副本，并删除源技能
    if (dropped && bookActor && sourceActor && sourceActor.id !== bookActor.id) {
      const itemData = dropped.toObject();
      const [newItem] = await bookActor.createEmbeddedDocuments("Item", [itemData]);
      skills.push({ uuid: newItem.uuid, itemData: null });
      await dropped.delete();
      return void await this.item.update({ "system.skills": skills });
    }

    // 技能书为世界金库物品（无所属角色）：保留完整数据快照
    if (dropped && !bookActor) {
      const itemData = dropped.toObject();
      skills.push({ uuid: "", itemData });
      if (sourceActor) await dropped.delete();
      return void await this.item.update({ "system.skills": skills });
    }

    // 直接来自世界金库的拖放数据（无法解析为 Document，仅有 itemData）
    if (!dropped && raw.itemData) {
      skills.push({ uuid: "", itemData: raw.itemData });
      return void await this.item.update({ "system.skills": skills });
    }
  }

  /* ─── 技能书：右键菜单（移除引用，不删除原技能） ─────────────────────────── */

  async _onSkillBookSlotMenu(event) {
    event.preventDefault();
    const slot  = $(event.currentTarget);
    const idx   = parseInt(slot.data("idx") ?? -1);
    const iname = slot.data("item-name") ?? "";
    if (idx < 0) return;

    $(".cg-ctx-menu").remove();
    const menu = $(`<ul class="cg-ctx-menu">
      <li data-action="edit"><i class="fas fa-edit"></i> 编辑 / 查看</li>
      <li class="cg-ctx-sep"></li>
      <li data-action="remove" class="cg-ctx-danger"><i class="fas fa-times"></i> 从技能书移除</li>
    </ul>`).css({ top: event.clientY, left: event.clientX });
    $("body").append(menu);

    const close = () => { menu.remove(); $(document).off("click.skbctx"); };
    setTimeout(() => $(document).on("click.skbctx", close), 10);

    menu.on("click", "li[data-action]", async e => {
      e.stopPropagation();
      const action = $(e.currentTarget).data("action");
      close();

      const skills = foundry.utils.deepClone(this.item.system.skills ?? []);
      const entry  = skills[idx];
      if (!entry) return;

      if (action === "edit") {
        if (entry.uuid) {
          const itm = await fromUuid(entry.uuid).catch(() => null);
          itm?.sheet?.render(true);
        } else if (entry.itemData) {
          const tempData = foundry.utils.deepClone(entry.itemData);
          delete tempData._id;
          const tempItem = await Item.create(tempData, { temporary: true });
          tempItem?.sheet?.render(true);
        }
      } else if (action === "remove") {
        skills.splice(idx, 1);
        await this.item.update({ "system.skills": skills });
        ui.notifications.info(`已从技能书移除「${iname}」（技能本身未删除）`);
      }
    });
  }

  /* ─── 技能书：学习全部技能 ──────────────────────────────────────────────── */

  async _onSkillBookLearn(event) {
    if (!this.item.actor) {
      return void ui.notifications.warn("请将技能书放入角色背包后再学习。");
    }
    const confirmed = await Dialog.confirm({
      title: "学习技能",
      content: `<p>确定学习技能书「${this.item.name}」中的全部技能？技能书将被消耗。</p>`,
    });
    if (!confirmed) return;
    await this.item.learnAllSkills();
  }

  /* ─── 背景：初始物品 / 升级奖励物品 拖入放置（不移动/删除源物品，仅引用+快照） ── */

  async _onBgItemDrop(event) {
    event.preventDefault();
    const $zone = $(event.currentTarget).removeClass("cg-drag-over");
    const levelId = $zone.data("levelId") || null;

    let raw;
    try { raw = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (raw.type !== "Item") {
      return void ui.notifications.warn(`这里只接受物品（收到的是 ${raw.type ?? "未知内容"}）。`);
    }

    // 容器内物品等来源没有可解析的 UUID，只带 itemData 快照——这类同样收下，
    // 只是没有 uuid 就无法跟随源物品更新，只能用快照。
    const dropped  = await Item.fromDropData(raw).catch(() => null);
    const itemData = dropped ? dropped.toObject() : foundry.utils.deepClone(raw.itemData ?? null);
    if (!itemData) {
      return void ui.notifications.warn("无法解析拖入的物品（既取不到 UUID，也没有物品数据）。");
    }
    // 背景的等级物品只收"实物"：背景本身、恐慌卡、技能这三类不能作为奖励物品发放
    // （背景由创建向导指定，恐慌卡走 panicSlots 嵌入，技能靠技能书或直接授予）。
    const droppedType = dropped?.type ?? itemData.type ?? "";
    if (BG_ITEM_BLOCKED_TYPES.includes(droppedType)) {
      const zh = { background: "背景", panic: "恐慌卡", skill: "技能" }[droppedType] ?? droppedType;
      return void ui.notifications.warn(`背景的等级物品不能放入${zh}（技能请改用技能书）。`);
    }

    delete itemData._id;
    const entry = { id: foundry.utils.randomID(), uuid: dropped?.uuid ?? "", itemData };

    if (levelId) {
      const rewards = foundry.utils.deepClone(this.item.system.levelRewards ?? []);
      const lr = rewards.find(r => r.id === levelId);
      if (!lr) return;
      lr.items.push(entry);
      await this.item.update({ "system.levelRewards": rewards });
    } else {
      const items = foundry.utils.deepClone(this.item.system.startingItems ?? []);
      items.push(entry);
      await this.item.update({ "system.startingItems": items });
    }
  }

  async _onBgItemRemove(event) {
    event.stopPropagation();
    const refId   = event.currentTarget.dataset.refId;
    const levelId = event.currentTarget.dataset.levelId || null;
    if (levelId) {
      const rewards = foundry.utils.deepClone(this.item.system.levelRewards ?? []);
      const lr = rewards.find(r => r.id === levelId);
      if (!lr) return;
      lr.items = lr.items.filter(i => i.id !== refId);
      await this.item.update({ "system.levelRewards": rewards });
    } else {
      const items = (this.item.system.startingItems ?? []).filter(i => i.id !== refId);
      await this.item.update({ "system.startingItems": items });
    }
  }

  async _onBgAddLevelReward() {
    const rewards = foundry.utils.deepClone(this.item.system.levelRewards ?? []);
    const nextLevel = rewards.length ? Math.max(...rewards.map(r => r.level)) + 5 : 5;
    rewards.push({ id: foundry.utils.randomID(), level: nextLevel, items: [] });
    await this.item.update({ "system.levelRewards": rewards });
  }

  async _onBgRemoveLevelReward(event) {
    const levelId = event.currentTarget.dataset.levelId;
    const rewards = (this.item.system.levelRewards ?? []).filter(r => r.id !== levelId);
    await this.item.update({ "system.levelRewards": rewards });
  }

  async _onBgLevelChange(event) {
    const levelId = event.currentTarget.dataset.levelId;
    const val = Math.max(1, parseInt(event.currentTarget.value) || 1);
    const rewards = foundry.utils.deepClone(this.item.system.levelRewards ?? []);
    const lr = rewards.find(r => r.id === levelId);
    if (!lr) return;
    lr.level = val;
    await this.item.update({ "system.levelRewards": rewards });
  }

  /* ─── 物品格：开始拖拽（内部重定位）────────────────────────────────────── */

  _onCgTileDragStart(event) {
    this._forceCloseAllTitleCards(); // 拖动开始即关闭 Title 卡
    const tile  = event.currentTarget;
    const idx   = parseInt(tile.dataset.placementIdx ?? 0);
    const uuid  = tile.dataset.itemUuid ?? "";
    const rect  = tile.getBoundingClientRect();
    const step  = 46;   // --cg-cell + --cg-gap
    const offX  = Math.floor((event.clientX - rect.left)  / step);
    const offY  = Math.floor((event.clientY - rect.top)   / step);
    // 世界金库物品：携带 itemData 供拖出时创建
    const p = this.item.system?.contents?.[idx] ?? {};
    const payload = {
      type: "Item",
      fromContainer: {
        isWorldContainer: !this.item.parent,
        actorId:          this.item.parent?.id ?? null,
        containerId:      this.item.id,
        placementIdx:     idx,
        offX, offY,
      },
    };
    if (uuid) payload.uuid = uuid;
    if (p.itemData) payload.itemData = p.itemData;
    event.originalEvent.dataTransfer.setData("text/plain", JSON.stringify(payload));
    event.originalEvent.dataTransfer.effectAllowed = "move";
  }

  /* ─── 物品格：旋转 ──────────────────────────────────────────────────────── */

  async _onCgTileRotate(event) {
    event.preventDefault();
    event.stopPropagation();
    const idx  = parseInt(event.currentTarget.dataset.placementIdx ?? -1);
    if (idx < 0) return;
    const sys  = this.item.system;
    const cols = sys.gridSize?.width  ?? 3;
    const rows = sys.gridSize?.height ?? 3;
    const contents = foundry.utils.deepClone(sys.contents ?? []);
    const p = contents[idx];
    if (!p) return;
    const nw = p.h ?? 1, nh = p.w ?? 1;
    if (!this._cgCanPlace(p.x, p.y, nw, nh, cols, rows, idx))
      return void ui.notifications.warn("旋转后无法放置（超出边界或与其他物品重叠）");
    p.w = nw; p.h = nh; p.rotated = !p.rotated;
    await this._containerUpdate({ "system.contents": contents });
  }

  /* ─── 容器格：左键锁定切换 ──────────────────────────────────────────────── */

  async _onCgCellClick(event) {
    // 仅当编辑锁已解开时才允许锁定/解锁格子
    if (this.isLocked) return;
    const cell = event.currentTarget;
    const x = parseInt(cell.dataset.x ?? 0);
    const y = parseInt(cell.dataset.y ?? 0);
    const lockedCells = foundry.utils.deepClone(this.item.system.lockedCells ?? []);
    const existIdx = lockedCells.findIndex(c => c.x === x && c.y === y);
    if (existIdx >= 0) lockedCells.splice(existIdx, 1);
    else lockedCells.push({ x, y });
    await this.item.update({ "system.lockedCells": lockedCells });
  }

  /* ─── 物品图块 / 描述文本 chip：悬停 Title 卡 ────────────────────────────
   * 统一走 attachHoverableTitleCard（含关闭延迟、鼠标中键锁定、卡片内嵌套
   * chip 悬停）。每次 activateListeners 重新绑定时清空旧 controller 列表，
   * 并在 close()/开始拖拽时统一强制关闭（忽略锁定，避免卡片残留）。
   * ────────────────────────────────────────────────────────────────────── */

  /** 绑定 [selector → 悬停解析 Item] 的 Title 卡；controller 收进 this._titleCardCtrls 统一管理 */
  _bindItemTitleCardHover(html, selector) {
    html.find(selector).each((_i, el) => {
      const ctrl = attachHoverableTitleCard(el, async () => {
        const uuid = el.dataset.itemUuid;
        if (!uuid) return null;
        const item = await fromUuid(uuid).catch(() => null);
        return item ? _buildItemTitleCard(item) : null;
      });
      this._titleCardCtrls.push(ctrl);
    });
  }

  /** 强制关闭当前 sheet 绑定的所有 Title 卡（忽略锁定），sheet 关闭/开始拖拽时调用 */
  _forceCloseAllTitleCards() {
    for (const ctrl of this._titleCardCtrls) ctrl.close();
    this._titleCardCtrls = [];
  }

  /* ─── 物品格：双击打开物品卡 ────────────────────────────────────────────── */

  /**
   * 容器网格里双击图块 → 打开该物品的物品卡（等同右键菜单的「编辑 / 查看」）。
   * 嵌套容器同样直接打开自己的卡（卡上就是它的网格）。
   * 世界金库物品只有 itemData、没有 UUID，临时造一份只读物品来渲染。
   */
  async _onCgTileDblClick(event) {
    event.preventDefault();
    const tile = event.currentTarget;
    const idx  = parseInt(tile.dataset.placementIdx ?? -1);
    const uuid = tile.dataset.itemUuid ?? "";
    if (idx < 0) return;

    // 拖动刚结束时浏览器仍可能补一发 dblclick，别把卡开出来
    if (GridDnD.dragging) return;

    if (uuid) {
      const itm = await fromUuid(uuid).catch(() => null);
      if (!itm) {
        ui.notifications.warn(`找不到物品「${tile.dataset.itemName ?? ""}」，可能已被删除。`);
        return;
      }
      itm.sheet?.render(true, { focus: true });
      return;
    }

    const entry = this.item.system?.contents?.[idx] ?? {};
    if (!entry.itemData) return;
    const tempData = foundry.utils.deepClone(entry.itemData);
    delete tempData._id;
    const tempItem = await Item.create(tempData, { temporary: true });
    tempItem?.sheet?.render(true);
  }

  /* ─── 物品格：右键菜单 ──────────────────────────────────────────────────── */

  async _onCgTileMenu(event) {
    event.preventDefault();
    const tile  = $(event.currentTarget);
    const idx   = parseInt(tile.data("placement-idx") ?? -1);
    const uuid  = tile.data("item-uuid") ?? "";
    const iname = tile.data("item-name") ?? "";
    if (idx < 0) return;

    // 判断是否世界金库物品（无 UUID，只有 itemData）
    const entry = this.item.system?.contents?.[idx] ?? {};
    const isVaultItem = !uuid && !!entry.itemData;

    $(".cg-ctx-menu").remove();

    const takeoutLabel = "取出到我的角色";
    const menu = $(`<ul class="cg-ctx-menu">
      <li data-action="takeout"><i class="fas fa-box-open"></i> ${takeoutLabel}</li>
      <li data-action="edit"><i class="fas fa-edit"></i> 编辑 / 查看</li>
      <li data-action="chat"><i class="fas fa-comment"></i> 发送聊天框</li>
      <li class="cg-ctx-sep"></li>
      <li data-action="delete" class="cg-ctx-danger"><i class="fas fa-trash"></i> 删除</li>
    </ul>`).css({ top: event.clientY, left: event.clientX });
    $("body").append(menu);

    const close = () => { menu.remove(); $(document).off("click.cgctx"); };
    setTimeout(() => $(document).on("click.cgctx", close), 10);

    menu.on("click", "li[data-action]", async e => {
      e.stopPropagation();
      const action = $(e.currentTarget).data("action");
      close();

      const contents = foundry.utils.deepClone(this.item.system.contents ?? []);

      if (action === "takeout") {
        const character = game.user?.character;
        if (!character) {
          ui.notifications.warn("你没有绑定角色，无法取出物品。请在玩家设置中绑定角色。");
          return;
        }
        if (isVaultItem) {
          // itemData 直接存储（世界金库），创建新物品
          const newData = foundry.utils.deepClone(entry.itemData);
          delete newData._id;
          await Item.create(newData, { parent: character });
        } else {
          const srcItem = await fromUuid(uuid).catch(() => null);
          if (!srcItem) {
            ui.notifications.warn(`找不到物品「${iname}」，可能已被删除。`);
            return;
          }
          // 物品已属于该角色（拖入容器的角色自有物品），只需移除引用，不重复创建
          if (srcItem.parent?.id !== character.id) {
            const newData = srcItem.toObject();
            delete newData._id;
            await Item.create(newData, { parent: character });
            // 源物品属于别人（营地/世界容器）：搬走就得删掉原件，
            // 否则会凭空多出一份。没权限时交给在线 GM 代删。
            await ClashManager._safeDocDelete(srcItem);
          }
        }
        contents.splice(idx, 1);
        await this._containerUpdate({ "system.contents": contents });

      } else if (action === "edit") {
        if (isVaultItem) {
          // 临时创建世界物品以供查看（只读），查看后自动清理
          ui.notifications.info(`${iname}（查看模式）`);
          const tempData = foundry.utils.deepClone(entry.itemData);
          delete tempData._id;
          const tempItem = await Item.create(tempData, { temporary: true });
          tempItem?.sheet?.render(true);
        } else {
          const itm = await fromUuid(uuid).catch(() => null);
          itm?.sheet?.render(true);
        }

      } else if (action === "chat") {
        const itm = uuid ? await fromUuid(uuid).catch(() => null) : null;
        if (itm?.sendToChat) {
          await itm.sendToChat();
        } else if (isVaultItem && entry.itemData) {
          // 从存储数据生成聊天消息
          ChatMessage.create({ content: `<b>${iname}</b>`, speaker: ChatMessage.getSpeaker() });
        }

      } else if (action === "delete") {
        const confirmed = await Dialog.confirm({
          title: "删除物品",
          content: `<p>确定从金库删除 <strong>${iname}</strong>？${isVaultItem ? "该物品将永久消失。" : ""}</p>`,
        });
        if (!confirmed) return;
        contents.splice(idx, 1);
        await this._containerUpdate({ "system.contents": contents });
        if (!isVaultItem && uuid) {
          const itm = await fromUuid(uuid).catch(() => null);
          await itm?.delete();
        }
      }
    });
  }
}

/* ─── 模块级辅助函数 ─────────────────────────────────────────────────────── */

/**
 * 将骰子公式字符串解析为 schema 实际字段值。**正/负面骰自动识别**，无需额外开关：
 *   "2d6+3" / "1D4"  → 普通骰（negativeDice: false）
 *   "20-1D8" / "30-d6" → 负面骰（negativeDice: true，基础值 20、1 个 d8 作减项）
 * 大小写均可，忽略空格。解析失败返回 null，调用方应保留旧值。
 */
function _parseDiceFormula(formula) {
  if (!formula) return null;
  const t = String(formula).toLowerCase().replace(/\s+/g, "");

  // 负面骰：基础值在前，骰子作为减项（骰数省略时视为 1）
  const neg = t.match(/^(\d+)-(\d*)d(\d+)$/);
  if (neg) {
    return {
      diceCount:    Math.max(0, parseInt(neg[2] === "" ? "1" : neg[2]) || 0),
      diceFaces:    Math.max(1, parseInt(neg[3]) || 4),
      baseValue:    Math.max(0, parseInt(neg[1]) || 0),
      negativeDice: true,
    };
  }

  const m = t.match(/^(\d+)d(\d+)(?:\+(\d+))?$/);
  if (!m) return null;
  return {
    diceCount:    Math.max(0, parseInt(m[1]) || 0),
    diceFaces:    Math.max(1, parseInt(m[2]) || 4),
    baseValue:    Math.max(0, parseInt(m[3] ?? 0) || 0),
    negativeDice: false,
  };
}

function _getCategoryIcon(category) {
  const cfg = CONFIG.LIMBUSCOMPANY;
  return cfg?.CATEGORY_ICON_PATHS?.[category] ?? "";
}

function _subtypeLabel(sub) {
  return { weapon:"武器", upper:"上装", lower:"下装", accessory:"饰品",
           consumable:"消耗品", material:"材料", container:"容器" }[sub] ?? sub;
}

/**
 * 为任意 Item 构建悬浮 Title 卡（与 actor-sheet._buildTitleCard 风格一致）。
 * 用于容器内物品图块的悬停提示。
 * @param {Item} item
 * @returns {jQuery|null}
 */
export function buildItemTitleCard(item) {
  return _buildItemTitleCard(item);
}

/**
 * 解析 BUFF 名称/type → { type, label, icon, description }。
 * 优先按 CustomBuffRegistry 精确 type 匹配，其次按显示名称模糊匹配已注册自定义 BUFF，
 * 最后回退标准 BUFF_TYPES/BUFF_DESCRIPTIONS。图标路径规则与 ClashManager._addBuff 一致：
 * 自定义注册 BUFF 放在 Custom_buffs/ 子目录，标准 BUFF 直接放在 Buff_icon/ 下。
 * @param {string} nameOrType  物品描述【】里写的文字，可以是 type 或中文显示名
 * @returns {{type:string,label:string,icon:string,description:string}}
 */
export function resolveBuffMeta(nameOrType) {
  const cfg = CONFIG.LIMBUSCOMPANY ?? {};
  // 优先按中文显示名反查 type key（描述文本里写的通常是"流血"而非"bleed"），
  // 找不到再退回 normalizeBuffType（兼容直接写 type key 的情况）
  const labelToKey = _buffLabelToKey(cfg);
  const type = labelToKey[nameOrType] ?? normalizeBuffType(nameOrType, nameOrType);

  const iconBase = "systems/limbusCompany_FVTT/assets/icons/Buff_icon/";
  const custom = CustomBuffRegistry.get(type);
  if (custom) {
    return {
      type,
      label:       custom.label ?? type,
      icon:        `${iconBase}Custom_buffs/${custom.label ?? type}.webp`,
      description: custom.description ?? "",
    };
  }

  const knownLabel = _buffLabelMap()[type];
  if (knownLabel) {
    // 标准/特殊 BUFF：图标在 Buff_icon/ 根目录，说明文字来自 BUFF_DESCRIPTIONS
    return {
      type,
      label:       knownLabel,
      icon:        `${iconBase}${knownLabel}.webp`,
      description: cfg.BUFF_DESCRIPTIONS?.[type] ?? "",
    };
  }

  // 既不在 CustomBuffRegistry，也不在标准 BUFF_TYPES 里 → 视为「计数 BUFF」
  // （只用于层数计数，没有独立效果逻辑），图标仍从 Custom_buffs/ 子目录找
  return {
    type,
    label:       nameOrType,
    icon:        `${iconBase}Custom_buffs/${nameOrType}.webp`,
    description: "计数 BUFF：仅记录层数，无独立效果逻辑",
  };
}

/**
 * 构建 BUFF Title 卡（图标+名字 / 金色渐变分割线 / 说明文字）。
 * @param {string} nameOrType
 * @returns {jQuery}
 */
export function buildBuffTitleCard(nameOrType) {
  const meta = resolveBuffMeta(nameOrType);
  const descHtml = meta.description
    ? linkifyHtml(_esc(meta.description).replace(/\n/g, "<br>"))
    : "（暂无说明）";
  return _wireCardInteractivity($(`<div class="limbus-title-card limbus-buff-title-card">
    <div class="btc-header">
      <img class="btc-icon" src="${_esc(meta.icon)}" alt="${_esc(meta.label)}">
      <span class="btc-name">${_esc(meta.label)}</span>
    </div>
    <div class="btc-divider"></div>
    <div class="btc-desc">${descHtml}</div>
  </div>`));
}

/* ─── Title 卡交互：鼠标中键锁定 + 卡片内 chip 悬停显示嵌套卡 ──────────────
 * 所有由 buildItemTitleCard/buildBuffTitleCard 产出的卡片都自动带上这套交互，
 * 调用方（actor-sheet.mjs 等各处 hover 绑定）无需额外处理，只需把原来
 * "hoverEnd 时无条件 card?.remove()" 改成 closeTitleCardUnlessLocked(card)，
 * 让锁定后的卡片不会因为离开触发源就被摘掉。
 * ────────────────────────────────────────────────────────────────────── */

/** hoverEnd 时用这个代替 `card?.remove()`：卡片被锁定时保留，其余情况照常移除 */
export function closeTitleCardUnlessLocked(card) {
  if (!card || card.data("tcLocked")) return;
  card.remove();
}

/** 无条件关闭：用于"鼠标真正离开卡片本体"这一刻——无论是否锁定都该消失 */
export function closeTitleCard(card) {
  card?.remove();
}

/**
 * Title 卡基准层级。嵌套卡（从卡内 chip 悬停弹出的下一层）会在父卡基础上 +1，
 * 保证"从 A 卡里点开的 B 卡"永远盖在 A 卡上面，而不是被压在后面。
 * 仅作为"触发源不在任何卡片内"时的兜底基准；各调用方（角色卡/HUD/商店卡等）
 * 若自行设置了 z-index，嵌套卡会读取其实际值再 +1，因此不需要统一改成本常量。
 */
const TITLE_CARD_Z = 99990;

/** 定位规则：贴在触发元素左侧，不够则右侧（与既有各处 hover 定位逻辑一致） */
function _positionTitleCard(card, anchorEl) {
  // 网格里的物品图块：贴**整扇窗口**的外侧，而不是图块自己的左边——
  // 否则卡片会盖在网格上，正好挡住旁边那些格子，拖放时非常碍事。
  const gridWrap = anchorEl.closest?.(".cg-wrap");
  const winEl    = gridWrap ? anchorEl.closest(".app, .window-app, .application") : null;
  const rect     = (winEl ?? anchorEl).getBoundingClientRect();

  const cardW = 280, cardH = 500;
  let left = rect.left - cardW - 8;
  if (left < 8) left = rect.right + 8;
  // 右侧也放不下（窗口贴着屏幕右缘）时，夹回可视区内
  if (left + cardW > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - cardW - 8);
  }
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - cardH - 8));

  // 层级：
  // 1) 触发源在某张 Title 卡内部（chip → 嵌套卡）→ 取父卡 +1，保证盖在父卡上；
  // 2) 触发源在某个 Foundry 窗口内（对话框/角色卡等）→ 取该窗口 z-index +1，
  //    否则卡片会被窗口盖住（Foundry 的窗口 z-index 每次聚焦都会自增，
  //    可能超过我们的固定基准值，不能只靠常量）。
  let z;
  const parentCard = anchorEl.closest?.(".limbus-title-card");
  if (parentCard) {
    z = (parseInt(parentCard.style.zIndex) || TITLE_CARD_Z) + 1;
  } else {
    z = TITLE_CARD_Z;
    const appEl = anchorEl.closest?.(".app, .window-app, .application");
    const appZ  = appEl ? parseInt(window.getComputedStyle(appEl).zIndex) : NaN;
    if (!isNaN(appZ)) z = Math.max(z, appZ + 1);
  }
  card.css({ position: "fixed", left, top, zIndex: z });
}

/**
 * 给任意 Title 卡挂上：
 *   - 恒定 pointer-events:auto（不然鼠标中键点击等交互压根传不到卡片上）
 *   - 鼠标中键点击卡片本体 → 锁定（加 .tc-locked，之后离开触发源不再自动关闭）
 *   - 卡片描述文本 linkify 产生的 .desc-buff-chip/.desc-item-chip → 悬停展示嵌套卡
 * @param {jQuery} card
 * @returns {jQuery} 原样返回 card，方便链式调用
 */
/**
 * 中键切换锁定状态（BUFF Title 卡不支持锁定，直接忽略）。
 * 供卡片本体的中键点击、以及触发源（图标/格子）本身的中键点击共用。
 * @param {jQuery} card
 */
export function toggleTitleCardLock(card) {
  if (!card?.length || card.hasClass("limbus-buff-title-card")) return;
  if (card.data("tcLocked")) {
    closeTitleCard(card); // 已锁定：再次中键 = 关闭卡片
  } else {
    card.data("tcLocked", true);
    card.addClass("tc-locked");
  }
}

/** 长按卡片顶部（tc-header/btc-header）拖动整张卡片 */
function _wireCardDrag(card) {
  const header = card.find(".tc-header, .btc-header")[0];
  if (!header) return;
  header.style.cursor = "grab";

  let dragging = false, startX = 0, startY = 0, originLeft = 0, originTop = 0;
  const onMouseMove = (e) => {
    if (!dragging) return;
    card.css({
      left: originLeft + e.clientX - startX,
      top:  originTop  + e.clientY - startY,
    });
  };
  const onMouseUp = () => {
    dragging = false;
    header.style.cursor = "grab";
    $(document).off("mousemove", onMouseMove).off("mouseup", onMouseUp);
  };
  header.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return; // 仅响应鼠标左键
    ev.preventDefault();
    startX = ev.clientX; startY = ev.clientY;
    originLeft = parseInt(card.css("left")) || 0;
    originTop  = parseInt(card.css("top"))  || 0;
    dragging = true;
    header.style.cursor = "grabbing";
    $(document).on("mousemove", onMouseMove).on("mouseup", onMouseUp);
  });
}

function _wireCardInteractivity(card) {
  if (!card?.length) return card;
  card.css("pointer-events", "auto");

  card.on("mousedown", (ev) => {
    if (ev.button !== 1) return; // 仅响应鼠标中键
    ev.preventDefault();
    toggleTitleCardLock(card);
  });

  _wireCardDrag(card);

  card.find(".desc-buff-chip").each((_i, chipEl) => {
    attachHoverableTitleCard(chipEl, () => buildBuffTitleCard(chipEl.dataset.buffName));
  });
  card.find(".desc-item-chip").each((_i, chipEl) => {
    attachHoverableTitleCard(chipEl, async () => {
      const item = await _findItemByName(chipEl.dataset.itemName);
      return item ? _buildItemTitleCard(item) : null;
    });
  });

  return card;
}

/**
 * 通用「悬停出 Title 卡」绑定：处理开合时机（关闭前留一小段延迟，让鼠标来得及
 * 移到卡片上——否则贴着触发源摆放的卡片在鼠标离开触发源瞬间就被摘掉，永远够
 * 不到，鼠标中键锁定也就无从谈起），并自动接入 _wireCardInteractivity（锁定 +
 * 卡片内嵌套 chip 悬停，因此本函数天然支持递归嵌套）。
 * @param {HTMLElement} anchorEl
 * @param {() => (jQuery|null|Promise<jQuery|null>)} buildFn  构建卡片内容，可异步
 * @returns {{ close: () => void }}
 */
export function attachHoverableTitleCard(anchorEl, buildFn) {
  if (!anchorEl) return { close() {} };

  let card = null;
  let closeTimer = null;
  let seq = 0;

  // 锁定的卡片只有一种关闭方式：鼠标中键再点一次（见 _wireCardInteractivity）。
  // 离开触发源/离开卡片本体都不会关闭锁定的卡片，只对未锁定的普通悬停生效。
  const cancelClose = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer = setTimeout(() => {
      if (card && !card.data("tcLocked")) { card.remove(); card = null; }
    }, 150);
  };

  const open = async () => {
    cancelClose();
    const mySeq = ++seq;
    const built = await buildFn();
    if (!built || mySeq !== seq) return;
    card?.remove();
    card = built; // _wireCardInteractivity 已经在 build 阶段挂好了
    _positionTitleCard(card, anchorEl);
    $("body").append(card);
    card.on("mouseenter", cancelClose);
    card.on("mouseleave", scheduleClose);
  };

  anchorEl.addEventListener("mouseenter", open);
  anchorEl.addEventListener("mouseleave", scheduleClose);
  // 触发源（图标/格子）本身也能中键锁定，不必先把鼠标挪到卡片上再点
  anchorEl.addEventListener("mousedown", (ev) => {
    if (ev.button !== 1 || !card) return;
    ev.preventDefault();
    toggleTitleCardLock(card);
  });

  return {
    close() {
      seq++;
      cancelClose();
      card?.remove();
      card = null;
    },
  };
}

/**
 * 按名字搜索物品（世界物品优先，其次全部合集包），供 "物品名字" 描述 chip 悬停解析使用。
 * 精确匹配优先；找不到精确匹配时退回第一个名字包含该文字的结果。
 * @param {string} name
 * @returns {Promise<Item|null>}
 */
async function _findItemByName(name) {
  const term = name.trim().toLowerCase();
  if (!term) return null;

  let fallback = null;
  for (const item of game.items) {
    if (item.name.toLowerCase() === term) return item;
    if (!fallback && item.name.toLowerCase().includes(term)) fallback = item;
  }
  for (const pack of game.packs) {
    if (pack.documentName !== "Item") continue;
    const index = await pack.getIndex({ fields: [] });
    for (const entry of index) {
      if (entry.name.toLowerCase() === term) return await fromUuid(entry.uuid).catch(() => null);
      if (!fallback && entry.name.toLowerCase().includes(term)) {
        fallback = await fromUuid(entry.uuid).catch(() => null);
      }
    }
  }
  return fallback;
}

function _buildItemTitleCard(item) {
  if (!item) return null;
  const sys = item.system;
  const cfg = CONFIG.LIMBUSCOMPANY ?? {};

  if (item.type === "skill") {
    const sinColor    = cfg.SIN_COLORS?.[sys.sinType] ?? "#5F3E21";
    const stellarCost = item.getStellarCost?.() ?? sys.stellarCost ?? 0;
    const tags = (Array.isArray(sys.tags) ? sys.tags : String(sys.tags ?? "").split("/"))
      .map(t => String(t).trim()).filter(Boolean);
    const weightCount = Number(sys.weight ?? 0);
    const descText    = linkifyHtml(sys.effectDesc ?? sys.description ?? "");
    return _wireCardInteractivity($(`<div class="limbus-title-card limbus-title-card-skill">
      <div class="tc-header" style="background:${sinColor}">${item.name}</div>
      <div class="tc-row2">
        <img src="${_getCategoryIcon(sys.category)}" class="tc-cat-icon" alt="">
        <span class="tc-formula">${(sys.diceFormula ?? "").toUpperCase()}</span>
        <span class="tc-tags">${tags.map(t => `<span class="tc-skill-tag">${t}</span>`).join("")}</span>
      </div>
      ${weightCount > 0 ? `<div class="tc-weight"><span class="tc-weight-label">攻击容量</span>${Array.from({length: weightCount}, () => '<span class="tc-weight-sq"></span>').join("")}</div>` : ""}
      <div class="tc-gold-divider-skill"></div>
      <div class="tc-desc">${descText}</div>
      <div class="tc-gold-divider-skill"></div>
      <div class="tc-footer">
        <img src="systems/limbusCompany_FVTT/assets/icons/Base_icon/Starlight.webp" class="tc-starlight-icon" alt="星芒">
        <span class="tc-stellar-cost">${stellarCost}</span>
      </div>
    </div>`));
  }

  // 装备 / 消耗品 / 材料 / 容器
  const typeLabels   = { equipment:"装备", consumable:"消耗品", material:"材料", container:"容器" };
  const stellarCost  = sys.stellarCost ?? 0;
  const tags = (Array.isArray(sys.tags) ? sys.tags : String(sys.tags ?? "").split("/"))
    .map(t => String(t).trim()).filter(Boolean);
  const descText     = linkifyHtml(sys.effect ?? sys.description ?? sys.effectDesc ?? "");

  if (item.type === "equipment") {
    const fmt = v => { const n = Number(v) || 0; return `${n > 0 ? "+" : ""}${n}`; };
    const modRows = [];
    if (sys.subtype === "upper") {
      modRows.push(`<div class="modifier-row">
        <img src="systems/limbusCompany_FVTT/assets/icons/Base_icon/slash.webp" class="mod-icon" alt="斩"><span class="resist-display">${sys.resistanceAdj?.slash ?? "1.0"}</span>
        <img src="systems/limbusCompany_FVTT/assets/icons/Base_icon/blunt.webp" class="mod-icon" alt="打"><span class="resist-display">${sys.resistanceAdj?.blunt ?? "1.0"}</span>
        <img src="systems/limbusCompany_FVTT/assets/icons/Base_icon/pierce.webp" class="mod-icon" alt="突"><span class="resist-display">${sys.resistanceAdj?.pierce ?? "1.0"}</span>
      </div>`);
      modRows.push(`<div class="modifier-row"><img src="systems/limbusCompany_FVTT/assets/icons/Base_icon/Defense_Level.webp" class="mod-icon" alt="DEF"><span class="mod-val">${fmt(sys.defAdj)}</span></div>`);
    } else {
      if (sys.subtype !== "lower") modRows.push(`<div class="modifier-row"><img src="systems/limbusCompany_FVTT/assets/icons/Base_icon/Offense_Level.webp" class="mod-icon" alt="ATK"><span class="mod-val">${fmt(sys.atkAdj)}</span></div>`);
      modRows.push(`<div class="modifier-row"><img src="systems/limbusCompany_FVTT/assets/icons/Base_icon/Defense_Level.webp" class="mod-icon" alt="DEF"><span class="mod-val">${fmt(sys.defAdj)}</span></div>`);
      if (sys.subtype !== "upper") modRows.push(`<div class="modifier-row"><img src="systems/limbusCompany_FVTT/assets/icons/Base_icon/Speed.webp" class="mod-icon" alt="SPD"><span class="mod-val">${fmt(sys.speedAdj)}</span></div>`);
    }
    const tagsHtml = tags.map(t => `<span class="tc-skill-tag">${t}</span>`).join("");
    return _wireCardInteractivity($(`<div class="limbus-title-card limbus-title-card-equip">
      <div class="tc-header tce-header">${item.name}</div>
      <div class="tce-info-row">
        <div class="tce-info-left">
          <div class="tce-subrow">
            <span class="tce-subtype">${_subtypeLabel(sys.subtype ?? item.type)}</span>
            ${sys.category ? `<span class="tce-category">${sys.category}</span>` : ""}
          </div>
          ${modRows.length ? `<div class="tce-modifiers">${modRows.join("")}</div>` : ""}
          ${tagsHtml ? `<div class="tce-tags">${tagsHtml}</div>` : ""}
        </div>
      </div>
      <div class="tc-gold-divider-skill"></div>
      <div class="tc-desc tce-desc">${descText}</div>
      <div class="tc-gold-divider-skill"></div>
      <div class="tc-footer tce-footer">
        <img src="systems/limbusCompany_FVTT/assets/icons/Base_icon/Starlight.webp" class="tc-starlight-icon" alt="星芒">
        <span class="tc-stellar-cost">${stellarCost}</span>
      </div>
    </div>`));
  }

  // 消耗品 / 材料 / 容器 — 简单卡片
  const typeLabel = typeLabels[item.type] ?? item.type;
  const catLabel  = sys.category ? ` · ${sys.category}` : "";
  const tagsHtml  = tags.map(t => `<span class="tc-skill-tag">${t}</span>`).join("");
  return _wireCardInteractivity($(`<div class="limbus-title-card limbus-title-card-equip">
    <div class="tc-header tce-header">${item.name}</div>
    <div class="tce-info-row">
      <div class="tce-info-left">
        <div class="tce-subrow"><span class="tce-subtype">${typeLabel}${catLabel}</span></div>
        ${tagsHtml ? `<div class="tce-tags">${tagsHtml}</div>` : ""}
      </div>
    </div>
    <div class="tc-gold-divider-skill"></div>
    <div class="tc-desc tce-desc">${descText}</div>
    <div class="tc-gold-divider-skill"></div>
    <div class="tc-footer tce-footer">
      <img src="systems/limbusCompany_FVTT/assets/icons/Base_icon/Starlight.webp" class="tc-starlight-icon" alt="星芒">
      <span class="tc-stellar-cost">${stellarCost}</span>
    </div>
  </div>`));
}

function _parseGridSize(str) {
  const parts = String(str).toLowerCase().split(/[x×]/);
  const cols  = parseInt(parts[0]) || 6;
  const rows  = parseInt(parts[1]) || 6;
  return [cols, rows];
}

function _parseModifiers(sys) {
  const mods = [];
  if (sys.atkAdj)   mods.push({ type: "atk",   label: "攻击",    value: sys.atkAdj });
  if (sys.defAdj)   mods.push({ type: "def",    label: "防御",    value: sys.defAdj });
  if (sys.speedAdj) mods.push({ type: "speed",  label: "速度",    value: sys.speedAdj });
  if (sys.subtype === "upper") {
    if (sys.resistanceAdj?.slash)  mods.push({ type: "rSlash",  label: "斩击",  value: sys.resistanceAdj.slash });
    if (sys.resistanceAdj?.blunt)  mods.push({ type: "rBlunt",  label: "打击",  value: sys.resistanceAdj.blunt });
    if (sys.resistanceAdj?.pierce) mods.push({ type: "rPierce", label: "突刺",  value: sys.resistanceAdj.pierce });
  }
  return mods;
}

function _parseSinCosts(sinCost) {
  if (Array.isArray(sinCost)) return sinCost;
  // Legacy: might be object
  return Object.entries(sinCost).map(([sin, amount]) => ({ sin, amount }));
}

function _parseResistanceChanges(egoResistanceChange) {
  if (Array.isArray(egoResistanceChange)) return egoResistanceChange;
  return Object.entries(egoResistanceChange).map(([sin, value]) => ({ sin, value }));
}

/* ─── Activity 编辑器 V2 辅助函数 ────────────────────────────────────────── */

function _esc(s) { return String(s ?? "").replace(/"/g, "&quot;"); }

/**
 * 把一条 activity 整理成当前 schema 的形状（顺带兼容旧的单对象字段），
 * 返回深拷贝，供复制 / 粘贴使用。
 * @param {object} act
 * @returns {object}
 */
function _normalizeActivity(act = {}) {
  const arr = (plural, singular) => Array.isArray(plural)
    ? foundry.utils.deepClone(plural)
    : (singular ? [foundry.utils.deepClone(singular)] : []);

  return {
    id:            foundry.utils.randomID(),
    name:          act.name    ?? "新效果",
    trigger:       act.trigger ?? "攻击时",
    preconditions: arr(act.preconditions, act.precondition),
    costs:         arr(act.costs,         act.cost),
    effects:       arr(act.effects,       act.effect),
    limit: {
      type:  act.limit?.type  ?? "unlimited",
      count: act.limit?.count ?? 0,
    },
  };
}

function _activityEffectLabels() {
  return [
    { value: "addBuff",      label: "添加BUFF" },
    { value: "randomBuff",   label: "随机BUFF" },
    { value: "removeBuff",   label: "移除BUFF" },
    { value: "hpAdj",        label: "生命值调整" },
    { value: "sanityAdj",    label: "理智值调整" },
    { value: "apAdj",        label: "行动值" },
    { value: "weightAdj",    label: "攻击容量" },
    { value: "diceAdj",      label: "骰数" },
    { value: "diceFacesAdj", label: "面数" },
    { value: "baseValue",    label: "基础值" },
    { value: "seismicBlast", label: "震颤引爆" },
    { value: "triggerBuff",  label: "触发BUFF" },
    { value: "useSkill",     label: "使用技能" },
    { value: "diceTypeChg",  label: "骰子类型" },
    { value: "rangeChg",     label: "范围修改" },
    { value: "extraDamage",  label: "追加伤害" },
    { value: "relatedSkillConvert", label: "相关技能转换" },
    { value: "panicCardSwap", label: "替换恐慌卡" },
    { value: "fieldResource", label: "公用场地" },
  ];
}

/** 从 cfg 构建 label→typeKey 反向映射（含 CustomBuffRegistry） */
function _buffLabelToKey(cfg) {
  const map = {};
  const allGroups = [
    ...(cfg.BUFF_GROUPS?.positive ?? []),
    ...(cfg.BUFF_GROUPS?.negative ?? []),
    ...(cfg.BUFF_GROUPS?.special  ?? []),
    ...(cfg.BUFF_GROUPS?.other    ?? []),
    ...(cfg.BUFF_GROUPS?.custom   ?? []),
  ];
  const labelMap = _buffLabelMap();
  for (const k of allGroups) {
    const lbl = labelMap[k] ?? k;
    map[lbl] = k;
  }
  // 动态注册的自定义 BUFF 也加入
  if (CustomBuffRegistry) {
    for (const [k, handler] of CustomBuffRegistry.entries()) {
      if (handler?.label) map[handler.label] = k;
    }
  }
  return map;
}

/** 将存储的 typeKey（可能是旧的 "custom"+buffCustom）转为显示用中文标签 */
function _keyToLabel(key, buffCustom = "") {
  if (!key || key === "custom") return buffCustom || "";
  return _buffLabelMap()[key] ?? key;
}

/** 生成全量 BUFF datalist HTML（所有分组 + 注册自定义） */
function _buildBuffDatalistHtml(id, cfg) {
  const labelToKey = _buffLabelToKey(cfg);
  const opts = Object.keys(labelToKey).map(lbl => `<option value="${_esc(lbl)}">`).join("");
  return `<datalist id="${id}">${opts}</datalist>`;
}

/** 生成触发BUFF专用 datalist（特殊BUFF排除震颤 + 注册自定义） */
function _buildTriggerBuffDatalistHtml(id, cfg) {
  const labelMap = _buffLabelMap();
  const special  = (cfg.BUFF_GROUPS?.special ?? []).filter(k => k !== "tremor");
  const labels   = new Set(special.map(k => labelMap[k] ?? k));
  if (CustomBuffRegistry) {
    for (const [, handler] of CustomBuffRegistry.entries()) {
      if (handler?.label) labels.add(handler.label);
    }
  }
  const opts = [...labels].map(lbl => `<option value="${_esc(lbl)}">`).join("");
  return `<datalist id="${id}">${opts}</datalist>`;
}

/**
 * 生成"背包/技能列表检索"用的 datalist：列出 actor 当前拥有的全部技能物品名字（去重）。
 * actor 为空（如世界/合集包中独立的物品，未挂在任何角色身上）时返回空 datalist，
 * 不影响功能——用户仍可手动输入名字，只是没有自动补全建议。
 */
function _buildOwnedSkillDatalistHtml(id, actor) {
  const names = new Set(
    (actor?.items ?? [])
      .filter(it => it.type === "skill")
      .map(it => it.name)
      .filter(Boolean)
  );
  const opts = [...names].map(n => `<option value="${_esc(n)}">`).join("");
  return `<datalist id="${id}">${opts}</datalist>`;
}

function _buffLabelMap() {
  const base = {
    strong:"强壮", weak:"虚弱", endure:"忍耐", breach:"破绽",
    swift:"迅捷",  bind:"束缚", guard:"守护",  fragile:"易损",
    clashPowerUp:"拼点威力提升", clashPowerDown:"拼点威力降低",
    atkLevelUp:"攻击等级提升",   atkLevelDown:"攻击等级降低",
    defLevelUp:"防御等级提升",   defLevelDown:"防御等级降低",
    burn:"烧伤", bleed:"流血", tremor:"震颤", rupture:"破裂",
    sinking:"沉沦", breathing:"呼吸法", charge:"充能",
    chaos:"陷入混乱", panic:"陷入恐慌", custom:"自定义",
    defensiveStance:"防御姿态",
  };
  // 合并动态注册的自定义 BUFF
  if (CustomBuffRegistry) {
    for (const [k, handler] of CustomBuffRegistry.entries()) {
      if (handler?.label) base[k] = handler.label;
    }
  }
  return base;
}

/** 触发时机下拉（分组：物品 / 技能 / 通用 / 反应） */
function _buildTriggerOpts(selected) {
  const groups = [
    { label: "── 使用 ──",  values: ["使用时", "攻击前", "攻击时", "攻击后",
                                       "拼点时", "拼点胜利", "拼点失败",
                                       "命中时", "暴击命中时"] },
    { label: "── 通用 ──",  values: ["回合开始时", "回合结束时", "受到伤害时"] },
    { label: "── 反应 ──",  values: ["反应"] },
    { label: "── 丢弃 ──",  values: ["丢弃时"] },
    { label: "── 恐慌 ──",  values: ["恐慌触发时", "坚定触发时"] },
    { label: "── 混乱 ──",  values: ["陷入混乱时"] },
  ];
  return groups.map(g =>
    `<optgroup label="${g.label}">${g.values.map(v =>
      `<option value="${v}" ${selected === v ? "selected" : ""}>${v}</option>`
    ).join("")}</optgroup>`
  ).join("");
}

/** 前置条件行 HTML */
function _buildCondRow(cond, idx, cfg) {
  // 旧的【使用等级】已并入【使用技能】：读到老数据就地转换，存回时便是新结构
  if (cond?.type === "level") {
    cond = { ...cond, type: "useSkill", skillLevel: cond.level ?? 1, skillNameOrTag: cond.skillNameOrTag ?? "" };
  }
  const condType   = ["perN","noBuff","baseAttr","useSkill","buffCompare","category","useSin","fieldResource","sinResource","background","equipped","allyTag","equipSlotCategory"].includes(cond?.type) ? cond.type : "hasBuff";
  const isBuffSec  = condType === "hasBuff" || condType === "noBuff" || condType === "perN" || condType === "buffCompare";
  const isUseSinSec = condType === "useSin";
  const selSins    = Array.isArray(cond?.sinTypes) ? cond.sinTypes
                   : (cond?.sinType ? [cond.sinType] : []);
  const isAttrSec  = condType === "baseAttr";
  const isSkillSec = condType === "useSkill";
  const isCatSec   = condType === "category";
  const isFieldSec = condType === "fieldResource";
  const isSinSec   = condType === "sinResource";
  const isBgSec    = condType === "background";
  const isEquipSec = condType === "equipped";
  const isCompare  = condType === "buffCompare";
  const isPerN     = condType === "perN";
  const perNDim    = cond?.perNDim === "intensity" ? "intensity" : "stacks";
  const selCats    = Array.isArray(cond?.categories) ? cond.categories : [];
  const stacksLbl  = isPerN ? (perNDim === "intensity" ? "每N级" : "每N层") : (isCompare ? "层数" : "层数≥");

  const stacksCmpOpts = [
    ["gt","＞"],["gte","≥"],["lt","＜"],["lte","≤"],["eq","＝"],
  ].map(([v,l]) => `<option value="${v}" ${(cond?.comparison ?? "eq") === v ? "selected":""}>${l}</option>`).join("");

  const fieldCmpOpts = [
    ["gt","＞"],["gte","≥"],["lt","＜"],["lte","≤"],["eq","＝"],
  ].map(([v,l]) => `<option value="${v}" ${(cond?.comparison ?? "gte") === v ? "selected":""}>${l}</option>`).join("");

  const cmpDimOpts = [
    ["stacks","层数"],["intensity","强度"],
  ].map(([v,l]) => `<option value="${v}" ${(cond?.compareDim ?? "stacks") === v ? "selected":""}>${l}</option>`).join("");
  const perNDimOpts = [
    ["stacks","层数"],["intensity","强度"],
  ].map(([v,l]) => `<option value="${v}" ${perNDim === v ? "selected":""}>${l}</option>`).join("");
  const buffLabel  = _keyToLabel(cond?.buff ?? "", cond?.buffCustom ?? "");

  const attrTypeOpts = [
    ["hp","生命值"],["sanity","理智值"],["ap","行动值"],
  ].map(([v,l]) => `<option value="${v}" ${(cond?.attrType ?? "hp") === v ? "selected":""}>${l}</option>`).join("");

  const cmpOpts = [
    ["gt","大于"],["gte","大于等于"],["lt","小于"],["lte","小于等于"],["eq","等于"],
  ].map(([v,l]) => `<option value="${v}" ${(cond?.comparison ?? "lt") === v ? "selected":""}>${l}</option>`).join("");

  return `
    <div class="ae-row ae-cond-row">
      <div class="ae-row-hd">
        <span class="ae-row-num">条件 ${idx + 1}</span>
        <button type="button" class="ae-del-btn ae-del-precond">×</button>
      </div>
      <div class="ae-row-fields">
        <div class="ae-line">
        <label>类型</label>
        <select class="ae-sel cond-type">
          <option value="hasBuff"     ${condType === "hasBuff"     ? "selected" : ""}>拥有</option>
          <option value="noBuff"      ${condType === "noBuff"      ? "selected" : ""}>未拥有</option>
          <option value="perN"        ${condType === "perN"        ? "selected" : ""}>每</option>
          <option value="buffCompare" ${condType === "buffCompare" ? "selected" : ""}>比较值</option>
          <option value="baseAttr"    ${condType === "baseAttr"    ? "selected" : ""}>基础属性</option>
          <option value="useSkill"    ${condType === "useSkill"    ? "selected" : ""}>使用技能</option>
          <option value="category"    ${condType === "category"    ? "selected" : ""}>使用分类</option>
          <option value="useSin"      ${condType === "useSin"      ? "selected" : ""}>使用罪孽</option>
          <option value="background"  ${condType === "background"  ? "selected" : ""}>背景</option>
          <option value="equipped"    ${condType === "equipped"    ? "selected" : ""}>已装备</option>
          <option value="allyTag"     ${condType === "allyTag"     ? "selected" : ""}>友方存在</option>
          <option value="equipSlotCategory" ${condType === "equipSlotCategory" ? "selected" : ""}>装备分类</option>
          <option value="fieldResource" ${condType === "fieldResource" ? "selected" : ""}>公用场地</option>
          <option value="sinResource"   ${condType === "sinResource"   ? "selected" : ""}>罪孽资源</option>
        </select>
        </div>
        <div class="ae-line">
        <span class="ae-cond-target-sec" ${(isCatSec || isFieldSec || isSinSec) ? 'style="display:none"' : ""}>
          <label>目标</label>
          <select class="ae-sel cond-target">${_buildTargetOptions(cond?.target ?? "self")}</select>
          ${_buildBgTagFields("cond", cond)}
        </span>
        </div>
        <div class="ae-line">
        <span class="ae-cond-buff-sec" ${isBuffSec ? "" : 'style="display:none"'}>
          <label>BUFF</label>
          <input class="ae-input cond-buff" type="text" list="ae-buff-dl"
                 placeholder="输入或选择BUFF…" autocomplete="off" style="width:100px;"
                 value="${_esc(buffLabel)}">
          <span class="ae-cond-intensity-sec" ${(isCompare || isPerN) ? 'style="display:none"' : ""}>
            <label>强度≥</label>
            <input class="ae-input-sm cond-intensity" type="number" value="${cond?.intensity ?? 0}" min="0">
          </span>
          <span class="ae-cond-pern-dim-sec" ${isPerN ? "" : 'style="display:none"'}>
            <label>维度</label>
            <select class="ae-sel cond-pern-dim">${perNDimOpts}</select>
          </span>
          <label class="cond-stacks-label" ${isCompare ? 'style="display:none"' : ""}>${stacksLbl}</label>
          <span class="ae-cond-cmp-sec" ${isCompare ? "" : 'style="display:none"'}>
            <select class="ae-sel cond-cmp-dim">${cmpDimOpts}</select>
            <select class="ae-sel cond-stacks-cmp">${stacksCmpOpts}</select>
          </span>
          <input class="ae-input-sm cond-stacks" type="number" value="${cond?.stacks ?? 0}" min="0">
          <span class="ae-cond-pern-max" ${isPerN ? "" : 'style="display:none"'}>
            <label>最大倍数</label>
            <input class="ae-input-sm cond-max-times" type="number" value="${cond?.maxTimes ?? 0}" min="0" placeholder="0=无限">
          </span>
        </span>
        <span class="ae-cond-attr-sec" ${isAttrSec ? "" : 'style="display:none"'}>
          <label>属性</label>
          <select class="ae-sel cond-attr-type">${attrTypeOpts}</select>
          <select class="ae-sel cond-comparison">${cmpOpts}</select>
          <input class="ae-input-sm cond-attr-value" type="text"
                 value="${_esc(cond?.attrValue ?? "")}" placeholder="50 或 5%">
        </span>
        <!-- 使用技能：名称/标签 与 等级 均可选，填了的才检查、两个都填则需同时满足 -->
        <span class="ae-cond-skill-sec" ${isSkillSec ? "" : 'style="display:none"'}>
          <label>名称/标签</label>
          <input class="ae-input cond-skill-name-tag" type="text"
                 value="${_esc(cond?.skillNameOrTag ?? "")}" placeholder="技能名称 或 标签（留空=不限）" style="width:150px;">
          <label>等级</label>
          <select class="ae-sel cond-skill-level">
            <option value="0" ${(cond?.skillLevel ?? 0) === 0 ? "selected" : ""}>不限</option>
            <option value="1" ${(cond?.skillLevel ?? 0) === 1 ? "selected" : ""}>Lv.1</option>
            <option value="2" ${(cond?.skillLevel ?? 0) === 2 ? "selected" : ""}>Lv.2</option>
            <option value="3" ${(cond?.skillLevel ?? 0) === 3 ? "selected" : ""}>Lv.3</option>
          </select>
        </span>
        <span class="ae-cond-category-sec" ${isCatSec ? "" : 'style="display:none"'}>
          <label>分类（任一满足）</label>
          <label class="ae-cond-cat-cb"><input type="checkbox" class="cond-category-cb" value="slash"  ${selCats.includes("slash")  ? "checked" : ""}> 斩击</label>
          <label class="ae-cond-cat-cb"><input type="checkbox" class="cond-category-cb" value="blunt"  ${selCats.includes("blunt")  ? "checked" : ""}> 打击</label>
          <label class="ae-cond-cat-cb"><input type="checkbox" class="cond-category-cb" value="pierce" ${selCats.includes("pierce") ? "checked" : ""}> 突刺</label>
        </span>
        <!-- 使用罪孽：本次实际打出的骰的罪孽属性（任一满足） -->
        <span class="ae-cond-usesin-sec" ${isUseSinSec ? "" : 'style="display:none"'}>
          <label>罪孽（任一满足）</label>
          <label class="ae-cond-cat-cb"><input type="checkbox" class="cond-usesin-cb" value="wrath" ${selSins.includes("wrath") ? "checked" : ""}> 暴怒</label>
          <label class="ae-cond-cat-cb"><input type="checkbox" class="cond-usesin-cb" value="lust" ${selSins.includes("lust") ? "checked" : ""}> 色欲</label>
          <label class="ae-cond-cat-cb"><input type="checkbox" class="cond-usesin-cb" value="sloth" ${selSins.includes("sloth") ? "checked" : ""}> 怠惰</label>
          <label class="ae-cond-cat-cb"><input type="checkbox" class="cond-usesin-cb" value="gluttony" ${selSins.includes("gluttony") ? "checked" : ""}> 暴食</label>
          <label class="ae-cond-cat-cb"><input type="checkbox" class="cond-usesin-cb" value="gloom" ${selSins.includes("gloom") ? "checked" : ""}> 忧郁</label>
          <label class="ae-cond-cat-cb"><input type="checkbox" class="cond-usesin-cb" value="pride" ${selSins.includes("pride") ? "checked" : ""}> 傲慢</label>
          <label class="ae-cond-cat-cb"><input type="checkbox" class="cond-usesin-cb" value="envy" ${selSins.includes("envy") ? "checked" : ""}> 嫉妒</label>
        </span>
        <!-- 装备分类：某个部位上装备的物品，其分类是否命中（如"武器的分类是弓刀"）。
             部位留空 = 不限部位；分类可用 / 分隔多个，任一命中即可。 -->
        <span class="ae-cond-slotcat-sec" ${condType === "equipSlotCategory" ? "" : 'style="display:none"'}>
          <label>部位</label>
          <select class="ae-sel cond-equip-slot">
            <option value=""          ${!cond?.equipSlot ? "selected" : ""}>不限</option>
            <option value="weapon"    ${cond?.equipSlot === "weapon"    ? "selected" : ""}>武器</option>
            <option value="upper"     ${cond?.equipSlot === "upper"     ? "selected" : ""}>上装</option>
            <option value="lower"     ${cond?.equipSlot === "lower"     ? "selected" : ""}>下装</option>
            <option value="accessory" ${cond?.equipSlot === "accessory" ? "selected" : ""}>饰品</option>
          </select>
          <label>分类</label>
          <input class="ae-input cond-slot-category" type="text" style="width:130px;"
                 value="${_esc(cond?.equipCategory ?? "")}"
                 placeholder="如：弓刀（多个用 / 分隔）">
        </span>
        <!-- 已装备：数名称/标签/分类符合的装备件数；三个筛选可任意组合、留空即不限。
             勾选"每"时，件数还会成为后续效果的倍数（每装备 1 件 → 加 3 层 …）-->
        <span class="ae-cond-equip-sec" ${isEquipSec ? "" : 'style="display:none"'}>
          <label>名称</label>
          <input class="ae-input cond-equip-name" type="text" style="width:90px;"
                 value="${_esc(cond?.equipName ?? "")}" placeholder="留空=不限">
          <label>标签</label>
          <input class="ae-input cond-equip-tag" type="text" style="width:90px;"
                 value="${_esc(cond?.equipTag ?? "")}" placeholder="如：烙印工坊">
          <label>分类</label>
          <input class="ae-input cond-equip-category" type="text" style="width:90px;"
                 value="${_esc(cond?.equipCategory ?? "")}" placeholder="如：狙击步枪">
          <label>件数≥</label>
          <input class="ae-input-sm cond-equip-count" type="number" min="1"
                 value="${cond?.count ?? 1}">
          <label title="勾选后，符合条件的件数会成为后续效果的倍数">
            <input type="checkbox" class="cond-equip-pereach" ${cond?.perEach ? "checked" : ""}> 每
          </label>
          <span class="ae-cond-equip-max" ${cond?.perEach ? "" : 'style="display:none"'}>
            <label>最大倍数</label>
            <input class="ae-input-sm cond-equip-max" type="number" min="0"
                   value="${cond?.maxTimes ?? 0}" placeholder="0=无限">
          </span>
        </span>
        <!-- 背景：检查所选一方的背景名称或背景标签 -->
        <span class="ae-cond-bg-sec" ${isBgSec ? "" : 'style="display:none"'}>
          <label>背景名/标签</label>
          <input class="ae-input cond-bg-name" type="text"
                 value="${_esc(cond?.bgName ?? "")}" placeholder="如：黎明事务所" style="width:130px;">
        </span>
        <span class="ae-cond-field-sec" ${isFieldSec ? "" : 'style="display:none"'}>
          <label>场地名字</label>
          <input class="ae-input cond-field-name" type="text"
                 value="${_esc(cond?.fieldName ?? "")}" placeholder="如：血宴" style="width:90px;">
          <label>层数</label>
          <select class="ae-sel cond-field-cmp">${fieldCmpOpts}</select>
          <input class="ae-input-sm cond-field-stacks" type="number" value="${cond?.stacks ?? 0}" min="0">
        </span>
        <!-- 罪孽资源：读取全局七宗罪池当前点数（只读，不消耗） -->
        <span class="ae-cond-sin-sec" ${isSinSec ? "" : 'style="display:none"'}>
          <label>罪孽</label>
          <select class="ae-sel cond-sin-type">${_buildSinOptions(cond?.sinType ?? "wrath")}</select>
          <label>点数</label>
          <select class="ae-sel cond-sin-cmp">${fieldCmpOpts}</select>
          <input class="ae-input-sm cond-sin-value" type="number" value="${cond?.value ?? 0}" min="0">
        </span>
        </div>
      </div>
    </div>`;
}

/** 【振幅转换】【振幅纠缠】——这两个 BUFF 会额外要求指定一个随行的【特殊震颤】 */
const _AMPLITUDE_BUFF_TYPES = ["amplitudeConvert", "amplitudeEntangle"];

function _isAmplitudeBuff(key) {
  return _AMPLITUDE_BUFF_TYPES.includes(key);
}

/** 特殊震颤的 datalist（数据源为 CustomBuffRegistry 中标了 specialTremor 的注册项） */
function _buildSpecialTremorDatalistHtml(id) {
  const opts = [...CustomBuffRegistry.entries()]
    .filter(([, h]) => h?.specialTremor === true)
    .map(([type, h]) => `<option value="${_esc(h.label ?? type)}">`)
    .join("");
  return `<datalist id="${id}">${opts}</datalist>`;
}

/** 存储的特殊震颤 type → 显示用标签（未注册的原样返回，便于排查填错） */
function _specialTremorLabel(type) {
  if (!type) return "";
  return CustomBuffRegistry.get(type)?.label ?? type;
}

/** 显示用标签 → 特殊震颤 type；无法匹配时返回原文本 */
function _specialTremorKey(label) {
  const val = String(label ?? "").trim();
  if (!val) return "";
  if (CustomBuffRegistry.get(val)?.specialTremor === true) return val; // 直接填了 type
  for (const [type, h] of CustomBuffRegistry.entries()) {
    if (h?.specialTremor === true && h.label === val) return type;
  }
  return val;
}

/** 罪孽资源下拉选项 HTML（七宗罪，与全局罪孽池一一对应） */
function _buildSinOptions(selected) {
  const cfg = CONFIG.LIMBUSCOMPANY ?? {};
  return (cfg.SINS ?? ["wrath","lust","sloth","gluttony","gloom","pride","envy"])
    .map(s => `<option value="${s}" ${selected === s ? "selected" : ""}>${cfg.SIN_LABELS_ZH?.[s] ?? s}</option>`)
    .join("");
}

/** 目标下拉选项 HTML（含队伍群体目标） */
function _buildTargetOptions(selected) {
  return [
    ["self",          "自己"],
    ["target",        "目标"],
    ["covered",       "被援护的队友"],
    ["allTeam",       "本队全部"],
    ["allTeamOther",  "本队其他全部"],
    ["allEnemy",      "敌对全部"],
    ["allEnemyOther", "敌对其他全部"],
    ["bgTag",         "背景标签"],
    ["bgTagOther",    "背景标签(其他)"],
  ].map(([v, l]) => `<option value="${v}" ${selected === v ? "selected" : ""}>${l}</option>`).join("");
}

/**
 * 「背景标签」目标的附加输入框（标签名字 + 数量）。
 * prefix 区分挂在条件/消耗/效果哪个区块（cond / cost / eff），class 名带前缀以免互相冲突。
 * 语义：本队中"背景带有该标签"的角色数量 ≥ 所填数量时，这些角色均视为合法目标；
 * 数量不足则目标为空（效果不生效）。"背景标签(其他)"与"本队其他全部"同理，
 * 会先排除拥有者自己（自己不受益，数量门槛也按排除自己后的人数判定）。
 */
/** 需要「至多人数」上限的群体目标 */
const _MULTI_TARGETS = new Set([
  "bgTag", "bgTagOther", "allTeam", "allTeamOther", "allEnemy", "allEnemyOther",
]);

function _buildBgTagFields(prefix, obj) {
  const target  = obj?.target ?? "self";
  const isBgTag = target === "bgTag" || target === "bgTagOther";
  const isMulti = _MULTI_TARGETS.has(target);
  return `
    <span class="ae-${prefix}-bgtag-sec" ${isBgTag ? "" : 'style="display:none"'}>
      <label>标签</label>
      <input class="ae-input-sm ${prefix}-bgtag-name" type="text"
             value="${_esc(obj?.targetTag ?? "")}" placeholder="如：剑契组" style="width:70px;">
      <label title="是「至少要有N人在场才触发」的门槛，不是「最多N人生效」的上限——只想不限人数就填1">在场至少≥</label>
      <input class="ae-input-sm ${prefix}-bgtag-count" type="number"
             value="${obj?.targetTagCount ?? 1}" min="1" style="width:50px;"
             title="是「至少要有N人在场才触发」的门槛，不是「最多N人生效」的上限——只想不限人数就填1">
    </span>
    <!-- 至多人数：所有群体目标（背景标签 / 本队 / 敌对）通用，0 = 不限 -->
    <span class="ae-${prefix}-max-sec" ${isMulti ? "" : 'style="display:none"'}>
      <label title="最多对几人生效，0 = 不限">至多人数</label>
      <input class="ae-input-sm ${prefix}-bgtag-max" type="number"
             value="${obj?.targetTagMax ?? 0}" min="0" style="width:50px;"
             title="最多对几人生效，0 = 不限（人数超出时随机抽取）">
    </span>`;
}

/** 从行 DOM 读取「背景标签」目标的附加数据 */
function _readBgTagMeta($r, prefix) {
  return {
    targetTag:      $r.find(`.${prefix}-bgtag-name`).val()?.trim() || "",
    targetTagCount: Math.max(1, parseInt($r.find(`.${prefix}-bgtag-count`).val()) || 1),
    targetTagMax:   Math.max(0, parseInt($r.find(`.${prefix}-bgtag-max`).val()) || 0),
  };
}

/** 消耗行 HTML */
function _buildCostRow(cost, idx, cfg) {
  const selType  = cost?.type ?? "forced";
  const isAttr     = selType === "attribute";
  const isDiscard  = selType === "discard";
  const isPerStack = selType === "perStack";
  const isRandom   = selType === "random";
  // 「扣光」只对 BUFF 类的强制消耗有意义（每/随机/属性/丢弃都有各自的语义）
  const isConsumeAllable = !isPerStack && !isRandom && !isAttr && !isDiscard;
  const costPerNDim = cost?.perNDim === "intensity" ? "intensity" : "stacks";
  const costPerNDimOpts = [
    ["stacks","层数"],["intensity","强度"],
  ].map(([v,l]) => `<option value="${v}" ${costPerNDim === v ? "selected":""}>${l}</option>`).join("");
  const typeOpts = [
    ["perStack",  "每"],
    ["forced",    "强制消耗"],
    ["random",    "随机消耗"],
    ["attribute", "基础属性"],
    ["discard",   "丢弃"],
  ].map(([v, l]) => `<option value="${v}" ${selType === v ? "selected" : ""}>${l}</option>`).join("");

  const attrTypeOpts = [
    ["hp",     "生命值"],
    ["sanity", "理智值"],
    ["ap",     "行动值"],
  ].map(([v, l]) => `<option value="${v}" ${(cost?.attrType ?? "hp") === v ? "selected" : ""}>${l}</option>`).join("");

  const discardModeOpts = [
    ["level",   "Lv等级"],
    ["another", "另一个"],
    ["reserve", "预备区"],
  ].map(([v, l]) => `<option value="${v}" ${(cost?.discardMode ?? "level") === v ? "selected" : ""}>${l}</option>`).join("");

  const discardModeIsLevel = (cost?.discardMode ?? "level") === "level";
  const isField = cost?.target === "field";
  const isSin   = cost?.target === "sin";

  return `
    <div class="ae-row ae-cost-row">
      <div class="ae-row-hd">
        <span class="ae-row-num">消耗 ${idx + 1}</span>
        <button type="button" class="ae-del-btn ae-del-cost">×</button>
      </div>
      <div class="ae-row-fields">
        <div class="ae-line">
        <label>类型</label>
        <select class="ae-sel cost-type">${typeOpts}</select>
        </div>
        <div class="ae-line">
        <label>目标</label>
        <select class="ae-sel cost-target">${_buildTargetOptions(cost?.target ?? "self")}
          <option value="field" ${isField ? "selected" : ""}>公用场地</option>
          <option value="sin"   ${isSin   ? "selected" : ""}>罪孽资源</option>
        </select>
        ${_buildBgTagFields("cost", cost)}
        </div>
        <div class="ae-line">
        <span class="ae-cost-field-sec" ${(isField && !isRandom) ? "" : 'style="display:none"'}>
          <label>场地名字</label>
          <input class="ae-input cost-field-name" type="text"
                 value="${_esc(cost?.fieldName ?? "")}" placeholder="如：血宴" style="width:90px;">
          <label class="cost-stacks-label">${isPerStack ? "每N层" : "层数"}</label>
          <input class="ae-input-sm cost-field-stacks" type="number" value="${cost?.stacks ?? 0}" min="0">
        </span>
        <!-- 罪孽资源：扣除全局七宗罪池的点数；【每】类型时为"每消耗 N 点"，可限制最大倍数 -->
        <span class="ae-cost-sin-sec" ${(isSin && !isRandom) ? "" : 'style="display:none"'}>
          <label>罪孽</label>
          <select class="ae-sel cost-sin-type">${_buildSinOptions(cost?.sinType ?? "wrath")}</select>
          <label class="cost-sin-label">${isPerStack ? "每N点" : "点数"}</label>
          <input class="ae-input-sm cost-sin-value" type="number" value="${cost?.value ?? 0}" min="0">
          <span class="ae-cost-sin-max" ${isPerStack ? "" : 'style="display:none"'}>
            <label>最大倍数</label>
            <input class="ae-input-sm cost-sin-max-times" type="number" value="${cost?.maxTimes ?? 0}" min="0" placeholder="0=无限">
          </span>
        </span>
        <!-- 随机消耗：从候选池中随机抽一条来扣（扣不起的候选自动排除；全都扣不起则整条 Activity 不成立，与强制消耗一致）
             每条候选可分别指定按「层数」或按「强度(级)」扣除，
             例：随机消耗 1 层 或 1 级【生蝶·亡蝶】= 两条候选，同一BUFF、维度分别为层/级 -->
        <span class="ae-cost-random-sec" ${isRandom ? "" : 'style="display:none"'}>
          <div class="ae-pool-list ae-cost-pool-list">
            ${(cost?.randomPool?.length ? cost.randomPool : [{ buff: "", dim: "stacks", amount: 1 }])
              .map(entry => _buildCostPoolRow(entry, cfg)).join("")}
          </div>
          <button type="button" class="ae-add-cost-pool ae-add-btn">＋ 添加候选</button>
          <!-- 「每随机消耗」：能扣几次就扣几次（每次独立抽一条候选），
               扣成功的次数即为后续效果的倍数；最多次数留 0 表示扣到扣不动为止 -->
          <label title="每随机消耗：能扣几次扣几次，扣成功的次数作为效果倍数">每</label>
          <input class="cost-random-pereach" type="checkbox" ${cost?.perEach ? "checked" : ""}>
          <span class="ae-cost-random-max" ${cost?.perEach ? "" : 'style="display:none"'}>
            <label>最多次数</label>
            <input class="ae-input-sm cost-random-max-times" type="number"
                   value="${cost?.maxTimes ?? 0}" min="0" placeholder="0=无限">
          </span>
        </span>
        <span class="ae-cost-buff-sec" ${(isAttr || isDiscard || isField || isSin || isRandom) ? 'style="display:none"' : ""}>
          <label>BUFF</label>
          <input class="ae-input cost-buff" type="text" list="ae-buff-dl"
                 placeholder="输入或选择BUFF…" autocomplete="off" style="width:100px;"
                 value="${_esc(_keyToLabel(cost?.buff ?? "", cost?.buffCustom ?? ""))}">
          <!-- 扣光：「消耗所有 X」的正确写法。勾上后忽略强度/层数，有多少扣多少，
               一层都没有也不会让整条 Activity 失败。不要再用 stacks:99 之类的大数——
               那是强制消耗，预检查要求真有 99 层，永远付不起 -->
          <span class="ae-cost-all-sec" ${isConsumeAllable ? "" : 'style="display:none"'}>
            <label title="消耗所有：有多少扣多少，没有也不算失败（忽略强度/层数）">扣光</label>
            <input class="cost-consume-all" type="checkbox" ${cost?.consumeAll ? "checked" : ""}>
          </span>
          <span class="ae-cost-intensity-sec" ${(isPerStack || cost?.consumeAll) ? 'style="display:none"' : ""}>
            <label>强度</label>
            <input class="ae-input-sm cost-intensity" type="number" value="${cost?.intensity ?? 0}" min="0">
          </span>
          <span class="ae-cost-pern-dim-sec" ${isPerStack ? "" : 'style="display:none"'}>
            <label>维度</label>
            <select class="ae-sel cost-pern-dim">${costPerNDimOpts}</select>
          </span>
          <span class="ae-cost-stacks-sec" ${cost?.consumeAll ? 'style="display:none"' : ""}>
            <label class="cost-stacks-label">${isPerStack ? (costPerNDim === "intensity" ? "每N级" : "每N层") : "层数"}</label>
            <input class="ae-input-sm cost-stacks"    type="number" value="${cost?.stacks ?? 0}"    min="0">
          </span>
          <span class="ae-cost-pern-max" ${isPerStack ? "" : 'style="display:none"'}>
            <label>最大倍数</label>
            <input class="ae-input-sm cost-max-times" type="number" value="${cost?.maxTimes ?? 0}" min="0" placeholder="0=无限">
          </span>
        </span>
        <span class="ae-cost-attr-sec" ${isAttr ? "" : 'style="display:none"'}>
          <label>属性</label>
          <select class="ae-sel cost-attr-type">${attrTypeOpts}</select>
          <label>数值</label>
          <input class="ae-input-sm cost-attr-value" type="number" value="${cost?.value ?? 1}" min="1">
        </span>
        <span class="ae-cost-discard-sec" ${isDiscard ? "" : 'style="display:none"'}>
          <label>丢弃</label>
          <select class="ae-sel cost-discard-mode">${discardModeOpts}</select>
          <span class="ae-cost-discard-level-sec" ${discardModeIsLevel ? "" : 'style="display:none"'}>
            <label>Lv.</label>
            <!-- 多个等级用 "/" 分隔表示"或"，例：2/3 = 丢弃 Lv.2 或 Lv.3 -->
            <input class="ae-input-sm cost-discard-level" type="text" value="${Array.isArray(cost?.discardLevel) ? cost.discardLevel.join("/") : (cost?.discardLevel ?? 1)}"
                   placeholder="2 或 2/3" title="单个等级填数字；多个等级用 / 分隔表示「或」">
          </span>
        </span>
        </div>
      </div>
    </div>`;
}

const _BUFF_EFFECTS    = new Set(["addBuff", "removeBuff"]);
const _USESKILL_EFFECTS = new Set(["useSkill"]);

// 支持"无符号=绝对赋值，+/-=相对增减"语义的效果类型
const _SIGNED_VALUE_EFFECTS = new Set([
  "hpAdj", "sanityAdj", "apAdj", "weightAdj", "diceAdj", "diceFacesAdj", "baseValue",
]);

function _effValuePlaceholder(type) {
  return _SIGNED_VALUE_EFFECTS.has(type)
    ? "3=调整为3，+3/-3=相对增减，或公式1D4+2"
    : "数值或公式，如 1D4+2";
}

const _ROUND_OPTIONS = ["本回合", "下回合", "本回合和下回合"];

/** 效果行 HTML */
function _buildEffectRow(eff, idx, cfg) {
  const type           = eff?.type ?? "addBuff";
  const isBuff         = _BUFF_EFFECTS.has(type);
  const isAddBuff      = type === "addBuff";
  const isRandomBuff   = type === "randomBuff";
  const isTriggerBuff  = type === "triggerBuff";
  const isUseSkill     = type === "useSkill";
  // 来源只保留 [标签+等级] 与 [技能名字]；旧数据的 uuid / equipped 一律回落为标签模式
  const useSkillRef    = eff?.skillRef === "name" ? "name" : "tag";
  const isDiceTypeChg  = type === "diceTypeChg";
  const isRangeChg     = type === "rangeChg";
  const isExtraDamage  = type === "extraDamage";
  const isRelConvert   = type === "relatedSkillConvert";
  const isFieldEff     = type === "fieldResource";
  const isPanicSwap    = type === "panicCardSwap";
  const effOpts    = _activityEffectLabels()
    .map(e => `<option value="${e.value}" ${type === e.value ? "selected" : ""}>${e.label}</option>`).join("");
  const roundVal   = eff?.round ?? "本回合";
  const roundOpts  = _ROUND_OPTIONS
    .map(v => `<option value="${v}" ${roundVal === v ? "selected" : ""}>${v}</option>`).join("");
  const formulaVal = _esc(eff?.value ?? "");
  const isValSec   = !isBuff && !isTriggerBuff && !isRandomBuff && !isUseSkill && !isDiceTypeChg && !isRelConvert && !isFieldEff && !isPanicSwap;
  return `
    <div class="ae-row ae-eff-row">
      <div class="ae-row-hd">
        <span class="ae-row-num">效果 ${idx + 1}</span>
        <button type="button" class="ae-del-btn ae-del-effect">×</button>
      </div>
      <div class="ae-row-fields">
        <div class="ae-line">
        <label>类型</label>
        <select class="ae-sel ae-eff-type eff-type">${effOpts}</select>
        </div>
        <div class="ae-line">
        <span class="ae-eff-target-sec" ${(isUseSkill || isDiceTypeChg || isRelConvert || isFieldEff) ? 'style="display:none"' : ""}>
          <label>目标</label>
          <select class="ae-sel eff-target">${_buildTargetOptions(eff?.target ?? "self")}</select>
          ${_buildBgTagFields("eff", eff)}
        </span>
        </div>
        <div class="ae-line">
        <span class="ae-eff-field-sec" ${isFieldEff ? "" : 'style="display:none"'}>
          <label>场地名字</label>
          <input class="ae-input eff-field-name" type="text"
                 value="${_esc(eff?.fieldName ?? "")}" placeholder="如：血宴" style="width:90px;">
          <label>层数</label>
          <input class="ae-input eff-field-stacks" type="text" placeholder="${_effValuePlaceholder("hpAdj")}"
                 value="${_esc(eff?.value ?? "")}" style="width:110px;">
        </span>
        <span class="ae-eff-round-sec" ${isAddBuff ? "" : 'style="display:none"'}>
          <label>回合</label>
          <select class="ae-sel eff-round">${roundOpts}</select>
        </span>
        <span class="ae-eff-buff-sec" ${isBuff ? "" : 'style="display:none"'}>
          <label>BUFF</label>
          <input class="ae-input eff-buff" type="text" list="ae-buff-dl"
                 placeholder="输入或选择BUFF…" autocomplete="off" style="width:100px;"
                 value="${_esc(_keyToLabel(eff?.buff ?? "", eff?.buffCustom ?? ""))}">
          <label>强度</label>
          <input class="ae-input-sm eff-intensity" type="number" value="${eff?.intensity ?? 0}" min="0">
          <label>层数</label>
          <input class="ae-input-sm eff-stacks" type="number" value="${eff?.stacks ?? 0}" min="0">
          <!-- 选中【振幅转换】/【振幅纠缠】时出现：随之一并施加的【特殊震颤】 -->
          <span class="ae-eff-amp-tremor-sec" ${_isAmplitudeBuff(eff?.buff) ? "" : 'style="display:none"'}>
            <label>特殊震颤</label>
            <input class="ae-input eff-amp-tremor" type="text" list="ae-sp-tremor-dl"
                   placeholder="如：震颤-灼热（留空则不附带）" autocomplete="off" style="width:130px;"
                   value="${_esc(_specialTremorLabel(eff?.ampTremor ?? ""))}">
          </span>
        </span>
        <span class="ae-eff-val-sec" ${isValSec ? "" : 'style="display:none"'}>
          <label>相关数值</label>
          <input class="ae-input eff-value" type="text" placeholder="${_effValuePlaceholder(type)}"
                 value="${formulaVal}" style="width:110px;">
        </span>

        <span class="ae-eff-trig-sec" ${isTriggerBuff ? "" : 'style="display:none"'}>
          <label>BUFF</label>
          <input class="ae-input eff-trig-buff" type="text" list="ae-trig-buff-dl"
                 placeholder="输入或选择BUFF…" autocomplete="off" style="width:100px;"
                 value="${_esc(_keyToLabel(eff?.trigBuff ?? "", eff?.trigBuffCustom ?? ""))}">
          <label>层数</label>
          <input class="ae-input-sm eff-trig-stacks" type="number" value="${eff?.trigStacks ?? 1}" min="1">
        </span>
        <span class="ae-eff-random-sec" ${isRandomBuff ? "" : 'style="display:none"'}>
          <label>回合</label>
          <select class="ae-sel eff-random-round">${roundOpts}</select>
          <label>随机抽取</label>
          <input class="ae-input-sm eff-random-count" type="number" value="${eff?.count ?? 1}" min="1" title="从随机池中抽取几个BUFF">
          <div class="ae-pool-list">
            ${(eff?.buffPool ?? [{ buff: "", intensity: 1, stacks: 1 }])
              .map(entry => _buildBuffPoolRow(entry, cfg)).join("")}
          </div>
          <button type="button" class="ae-add-pool-buff ae-add-btn">＋ 添加BUFF</button>
        </span>
        <span class="ae-eff-useskill-sec" ${isUseSkill ? "" : 'style="display:none"'}>
          <label>来源</label>
          <select class="ae-sel eff-skill-ref">
            <option value="tag"  ${useSkillRef === "tag"  ? "selected" : ""}>标签+等级</option>
            <option value="name" ${useSkillRef === "name" ? "selected" : ""}>技能名字</option>
          </select>
          <!-- 标签+等级：在目标的技能列表中按 [标签]（system.tags，斜杠分隔）
               和 [Lv.等级]（system.level）检索，比 UUID 稳定、比"已装备"灵活 -->
          <span class="eff-useskill-tag-sec" ${useSkillRef === "tag" ? "" : 'style="display:none"'}>
            <label>标签</label>
            <input class="ae-input eff-skill-tag" type="text"
                   value="${_esc(eff?.skillTag ?? "")}" placeholder="如：黑兽" style="width:100px;">
            <label>Lv.</label>
            <select class="ae-sel eff-skill-level">
              <option value="0" ${(eff?.skillLevel ?? 0) === 0 ? "selected" : ""}>不限</option>
              <option value="1" ${(eff?.skillLevel ?? 0) === 1 ? "selected" : ""}>Lv.1</option>
              <option value="2" ${(eff?.skillLevel ?? 0) === 2 ? "selected" : ""}>Lv.2</option>
              <option value="3" ${(eff?.skillLevel ?? 0) === 3 ? "selected" : ""}>Lv.3</option>
            </select>
          </span>
          <span class="eff-useskill-name-sec" ${useSkillRef === "name" ? "" : 'style="display:none"'}>
            <input class="ae-input eff-skill-name" type="text" list="ae-owned-skill-dl"
                   value="${_esc(eff?.skillName ?? "")}" placeholder="技能名字（在背包/技能列表中检索）" style="width:130px;" autocomplete="off">
          </span>
          <!-- 用这个技能打谁：预先锁定对抗卡的目标。任何触发时机都生效——
               [反应] 里"触发者"＝引发反应的那次对抗的攻/守方；
               其余时机里则是本次结算的攻击方 / 防守方（如 [拼点失败] 选"攻击方"＝反打赢了自己的人） -->
          <label title="预先锁定这次对抗打谁；选「不指定」则由玩家在对抗卡上自行响应">对谁使用</label>
          <select class="ae-sel eff-react-target">
            <option value="defender" ${(eff?.reactTarget ?? "defender") === "defender" ? "selected" : ""}>防守方（触发者的目标）</option>
            <option value="attacker" ${eff?.reactTarget === "attacker" ? "selected" : ""}>攻击方（触发者本人）</option>
            <option value="none"     ${eff?.reactTarget === "none"     ? "selected" : ""}>不指定</option>
          </select>
        </span>
        <span class="ae-eff-dicetypechg-sec" ${isDiceTypeChg ? "" : 'style="display:none"'}>
          <label>骰子类型</label>
          <select class="ae-sel eff-dice-type-val">
            <option value="normal"      ${(eff?.diceTypeVal ?? "normal") === "normal"      ? "selected" : ""}>一般骰子</option>
            <option value="unbreakable" ${(eff?.diceTypeVal ?? "normal") === "unbreakable" ? "selected" : ""}>不可摧毁</option>
          </select>
        </span>
        <span class="ae-eff-rangechg-sec" ${isRangeChg ? "" : 'style="display:none"'}>
          <label>攻击方式</label>
          <select class="ae-sel eff-range-mode">
            <option value="melee"  ${(eff?.rangeMode ?? "melee") === "melee"  ? "selected" : ""}>近战</option>
            <option value="ranged" ${eff?.rangeMode === "ranged" ? "selected" : ""}>远程</option>
          </select>
          <label>范围（格）</label>
          <input class="ae-input-sm eff-range-value" type="number" min="0" max="99"
                 value="${eff?.rangeValue ?? 1}" title="只作用于已装备的武器，其他部位忽略">
        </span>
        <span class="ae-eff-extradmg-sec" ${isExtraDamage ? "" : 'style="display:none"'}>
          <label>物理分类</label>
          <select class="ae-sel eff-extradmg-category">
            <option value="" ${!eff?.dmgCategory ? "selected" : ""}>（不计算物理抗性）</option>
            <option value="slash"  ${eff?.dmgCategory === "slash"  ? "selected" : ""}>斩击</option>
            <option value="blunt"  ${eff?.dmgCategory === "blunt"  ? "selected" : ""}>打击</option>
            <option value="pierce" ${eff?.dmgCategory === "pierce" ? "selected" : ""}>突刺</option>
          </select>
          <label>罪孽类型</label>
          <select class="ae-sel eff-extradmg-sin">
            <option value="" ${!eff?.dmgSinType ? "selected" : ""}>（不计算罪孽抗性）</option>
            ${["wrath","lust","sloth","gluttony","gloom","pride","envy"].map(s =>
              `<option value="${s}" ${eff?.dmgSinType === s ? "selected" : ""}>${cfg.SIN_LABELS_ZH?.[s] ?? s}</option>`
            ).join("")}
          </select>
        </span>
        <span class="ae-eff-panicswap-sec" ${isPanicSwap ? "" : 'style="display:none"'}>
          <label>槽位</label>
          <select class="ae-sel eff-panicswap-slot">${
            [["panic","陷入恐慌"],["lowMorale","士气低落"]]
              .map(([v,l]) => `<option value="${v}" ${(eff?.panicSlot ?? "panic") === v ? "selected" : ""}>${l}</option>`)
              .join("")
          }</select>
          <label>恐慌卡名字</label>
          <input class="ae-input eff-panicswap-name" type="text"
                 value="${_esc(eff?.panicCardName ?? "")}"
                 placeholder="恐慌卡名字（世界物品 / 合集包）" style="width:150px;" autocomplete="off">
          <span class="ae-eff-relconvert-hint">按名字在<strong>世界物品与全部合集包</strong>里检索一张恐慌卡，
          复制给目标并占住所选槽位；被顶掉的旧卡若没有别的槽还在用就删除。
          卡上标了另一种类型（士气低落／陷入恐慌）时不会放入。</span>
        </span>
        <span class="ae-eff-relconvert-sec" ${isRelConvert ? "" : 'style="display:none"'}>
          <label>技能名字</label>
          <input class="ae-input eff-relconvert-name" type="text" list="ae-owned-skill-dl"
                 value="${_esc(eff?.relSkillName ?? "")}" placeholder="技能名字（在背包/技能列表中检索）" style="width:130px;" autocomplete="off">
          <label>时长</label>
          <select class="ae-sel eff-relconvert-duration">${
            [["permanent","永久"],["afterUse","使用一次后还原"],
             ["afterClash","本次结算后还原"],["endOfTurn","本回合结束时还原"]]
              .map(([v,l]) => `<option value="${v}" ${(eff?.relDuration ?? "permanent") === v ? "selected" : ""}>${l}</option>`)
              .join("")
          }</select>
          <span class="ae-eff-relconvert-hint">替换本技能在角色技能槽中的位置（在背包/技能列表按名字检索目标技能）。
          「还原」由这条转换自己负责，目标技能上<strong>不需要</strong>再写一条转回去——那样会让共用同一强化形态的其他路径也被一起还原。
          <br>【使用一次后还原】：换上来的形态被真正投出去一次后还原；多个槽位（如基础槽＋守备槽）换成同一张时，
          任一边用掉，另一边也一并还原——整体只算一次。</span>
        </span>
        </div>
      </div>
    </div>`;
}

/** 随机BUFF池单行：文本输入（datalist）+ 强度 + 层数 + 删除 */
function _buildBuffPoolRow(entry, cfg) {
  const buffLabel = _keyToLabel(entry?.buff ?? "", entry?.buffCustom ?? "");
  return `
    <div class="ae-pool-row">
      <input class="ae-input ae-pool-buff-input" type="text" list="ae-buff-dl"
             placeholder="输入或选择BUFF…" autocomplete="off" style="width:100px;"
             value="${_esc(buffLabel)}">
      <label>强度</label>
      <input class="ae-input-sm ae-pool-intensity" type="number" value="${entry?.intensity ?? 0}" min="0">
      <label>层数</label>
      <input class="ae-input-sm ae-pool-stacks" type="number" value="${entry?.stacks ?? 1}" min="1">
      <button type="button" class="ae-del-btn ae-del-pool-buff">×</button>
    </div>`;
}

/** 随机消耗候选单行：文本输入（datalist）+ 维度（层数/强度）+ 数量 + 删除 */
function _buildCostPoolRow(entry, cfg) {
  const buffLabel = _keyToLabel(entry?.buff ?? "", entry?.buffCustom ?? "");
  const dim = entry?.dim === "intensity" ? "intensity" : "stacks";
  const dimOpts = [
    ["stacks",    "层"],
    ["intensity", "级"],
  ].map(([v, l]) => `<option value="${v}" ${dim === v ? "selected" : ""}>${l}</option>`).join("");
  return `
    <div class="ae-pool-row ae-cost-pool-row">
      <label>消耗</label>
      <input class="ae-input-sm ae-cost-pool-amount" type="number" value="${entry?.amount ?? 1}" min="1">
      <select class="ae-sel ae-cost-pool-dim">${dimOpts}</select>
      <input class="ae-input ae-cost-pool-buff" type="text" list="ae-buff-dl"
             placeholder="输入或选择BUFF…" autocomplete="off" style="width:100px;"
             value="${_esc(buffLabel)}">
      <button type="button" class="ae-del-btn ae-del-cost-pool">×</button>
    </div>`;
}

/** 设置 Dialog 动态交互事件 */
function _setupAeDialog(html, cfg) {
  // 添加按钮
  html.find(".ae-add-precond").on("click", () => {
    const list = html.find(".ae-precond-list");
    const idx  = list.find(".ae-cond-row").length;
    list.append(_buildCondRow({}, idx, cfg));
    _bindDel(html);
    _bindCondCostBuff(html);
    _bindCondType(html);
    _bindTargetBgTag(html);
  });
  html.find(".ae-add-cost").on("click", () => {
    const list = html.find(".ae-cost-list");
    const idx  = list.find(".ae-cost-row").length;
    list.append(_buildCostRow({}, idx, cfg));
    _bindDel(html);
    _bindCondCostBuff(html);
    _bindCostType(html);
    _bindTargetBgTag(html);
  });
  html.find(".ae-add-effect").on("click", () => {
    const list = html.find(".ae-effect-list");
    const idx  = list.find(".ae-eff-row").length;
    list.append(_buildEffectRow({}, idx, cfg));
    _bindDel(html);
    _bindEffType(html);
    _bindEffBuffAmplitude(html);
    _bindUseSkillSubtype(html);
    _bindTargetBgTag(html);
  });
  html.on("click", ".ae-add-cost-pool", function () {
    const sec = $(this).closest(".ae-cost-random-sec");
    sec.find(".ae-cost-pool-list").append(_buildCostPoolRow({}, cfg));
    _bindDel(html);
    _bindCondCostBuff(html);
  });
  html.on("click", ".ae-add-pool-buff", function () {
    const sec = $(this).closest(".ae-eff-random-sec");
    sec.find(".ae-pool-list").append(_buildBuffPoolRow({}, cfg));
    _bindDel(html);
  });
  html.find(".ae-toggle-limit").on("click", () => {
    html.find(".ae-limit-body").toggle();
  });

  _bindDel(html);
  _bindEffType(html);
  _bindCondCostBuff(html);
  _bindEffBuffAmplitude(html);
  _bindCostType(html);
  _bindCondType(html);
  _bindSkillUuidPreview(html);
  _bindUseSkillSubtype(html);
  _bindTargetBgTag(html);
}

/** UUID 输入框实时预览技能图标 */
function _bindSkillUuidPreview(html) {
  // 初始加载：填充已有 UUID 的图标
  html.find(".ae-skill-preview[data-uuid-src]").each(async (_, img) => {
    const $img = $(img);
    const inputCls = $img.data("uuid-src");
    const $input = $img.closest("span").find(`.${inputCls}`);
    const uuid = $input.val()?.trim();
    if (!uuid) return;
    const itm = await fromUuid(uuid).catch(() => null);
    if (itm?.img) { $img.attr("src", itm.img).attr("title", itm.name).show(); }
  });

  // 动态监听 UUID 输入变化
  html.on("input", ".cond-skill-uuid, .eff-skill-uuid", async function () {
    const $input = $(this);
    const $img = $input.closest("span").find(".ae-skill-preview");
    const uuid = $input.val()?.trim();
    if (!uuid) { $img.hide(); return; }
    const itm = await fromUuid(uuid).catch(() => null);
    if (itm?.img) { $img.attr("src", itm.img).attr("title", itm.name).show(); }
    else { $img.hide(); }
  });
}

function _bindCondCostBuff(_html) {
  // no-op: BUFF 字段改用文本输入，无需监听 select 变化
}

/** ④效果的 BUFF 输入：选中【振幅转换】/【振幅纠缠】时显示随行【特殊震颤】下拉 */
function _bindEffBuffAmplitude(html) {
  const refresh = (input) => {
    const row = $(input).closest(".ae-eff-row");
    const key = _buffLabelToKey(CONFIG.LIMBUSCOMPANY ?? {})[String($(input).val() ?? "").trim()];
    row.find(".ae-eff-amp-tremor-sec").toggle(_isAmplitudeBuff(key));
  };
  html.find(".eff-buff").off("input.amp change.amp").on("input.amp change.amp", function () {
    refresh(this);
  });
}

/** useSkill 效果：来源模式切换 & 技能槽选择联动 */
function _bindUseSkillSubtype(html) {
  html.find(".eff-skill-ref").off("change").on("change", function () {
    const sec    = $(this).closest(".ae-eff-useskill-sec");
    const isName = $(this).val() === "name";
    sec.find(".eff-useskill-tag-sec").toggle(!isName);
    sec.find(".eff-useskill-name-sec").toggle(isName);
  });
}

/** 切换条件类型时控制各子区段显示 */
function _bindCondType(html) {
  html.find(".cond-type").off("change").on("change", function () {
    const row      = $(this).closest(".ae-cond-row");
    const type     = $(this).val();
    const isBuffSec  = type === "hasBuff" || type === "noBuff" || type === "perN" || type === "buffCompare";
    const isAttrSec  = type === "baseAttr";
    const isSkillSec = type === "useSkill";
    const isCatSec   = type === "category";
    const isFieldSec = type === "fieldResource";
    const isSinSec   = type === "sinResource";
    const isBgSec    = type === "background";
    const isEquipSec = type === "equipped";
    const isCompare  = type === "buffCompare";
    const isPerN     = type === "perN";
    const perNDim    = row.find(".cond-pern-dim").val() === "intensity" ? "intensity" : "stacks";
    row.find(".cond-stacks-label").text(isPerN ? (perNDim === "intensity" ? "每N级" : "每N层") : (isCompare ? "层数" : "层数≥"));
    row.find(".ae-cond-buff-sec").toggle(isBuffSec);
    row.find(".ae-cond-attr-sec").toggle(isAttrSec);
    row.find(".ae-cond-skill-sec").toggle(isSkillSec);
    row.find(".ae-cond-category-sec").toggle(isCatSec);
    row.find(".ae-cond-usesin-sec").toggle(type === "useSin");
    row.find(".ae-cond-field-sec").toggle(isFieldSec);
    row.find(".ae-cond-sin-sec").toggle(isSinSec);
    row.find(".ae-cond-bg-sec").toggle(isBgSec);
    row.find(".ae-cond-equip-sec").toggle(isEquipSec);
    row.find(".ae-cond-slotcat-sec").toggle(type === "equipSlotCategory");
    row.find(".ae-cond-target-sec").toggle(!isCatSec && !isFieldSec && !isSinSec && type !== "useSin");
    row.find(".ae-cond-pern-max").toggle(isPerN);
    row.find(".ae-cond-pern-dim-sec").toggle(isPerN);
    row.find(".ae-cond-intensity-sec").toggle(!isCompare && !isPerN);
    row.find(".cond-stacks-label").toggle(!isCompare);
    row.find(".ae-cond-cmp-sec").toggle(isCompare);
  });
  html.find(".cond-equip-pereach").off("change").on("change", function () {
    $(this).closest(".ae-cond-row").find(".ae-cond-equip-max").toggle(this.checked);
  });
  html.find(".cond-pern-dim").off("change").on("change", function () {
    const row   = $(this).closest(".ae-cond-row");
    const type  = row.find(".cond-type").val();
    if (type !== "perN") return;
    const perNDim = $(this).val() === "intensity" ? "intensity" : "stacks";
    row.find(".cond-stacks-label").text(perNDim === "intensity" ? "每N级" : "每N层");
  });
}

function _bindCostType(html) {
  html.on("change", ".cost-random-pereach", function () {
    $(this).closest(".ae-cost-random-sec").find(".ae-cost-random-max")
      .toggle($(this).prop("checked") === true);
  });

  const refreshRow = (row) => {
    const val        = row.find(".cost-type").val();
    const tgt         = row.find(".cost-target").val();
    const isField     = tgt === "field";
    const isSin       = tgt === "sin";
    const isAttr      = val === "attribute";
    const isDiscard   = val === "discard";
    const isPerStack  = val === "perStack";
    const isRandom    = val === "random";
    const perNDim     = row.find(".cost-pern-dim").val() === "intensity" ? "intensity" : "stacks";
    row.find(".ae-cost-random-sec").toggle(isRandom);
    row.find(".ae-cost-random-max").toggle(isRandom && row.find(".cost-random-pereach").prop("checked") === true);
    row.find(".ae-cost-field-sec").toggle(isField && !isRandom);
    row.find(".ae-cost-sin-sec").toggle(isSin && !isRandom);
    row.find(".ae-cost-sin-max").toggle(isSin && !isRandom && isPerStack);
    row.find(".cost-sin-label").text(isPerStack ? "每N点" : "点数");
    row.find(".ae-cost-buff-sec").toggle(!isAttr && !isDiscard && !isField && !isSin && !isRandom);
    row.find(".ae-cost-attr-sec").toggle(isAttr);
    row.find(".ae-cost-discard-sec").toggle(isDiscard);
    row.find(".cost-stacks-label").text(isPerStack ? (perNDim === "intensity" ? "每N级" : "每N层") : "层数");
    row.find(".ae-cost-pern-max").toggle(isPerStack);
    row.find(".ae-cost-pern-dim-sec").toggle(isPerStack);
    // 扣光：只对 BUFF 强制消耗开放；勾上后强度/层数没有意义，一并隐藏
    const canAll = !isPerStack && !isRandom && !isAttr && !isDiscard && !isField && !isSin;
    const isAll  = canAll && row.find(".cost-consume-all").prop("checked");
    row.find(".ae-cost-all-sec").toggle(canAll);
    row.find(".ae-cost-intensity-sec").toggle(!isPerStack && !isAll);
    row.find(".ae-cost-stacks-sec").toggle(!isAll);
  };
  html.find(".cost-type").off("change").on("change", function () {
    refreshRow($(this).closest(".ae-cost-row"));
  });
  html.find(".cost-target").off("change").on("change", function () {
    refreshRow($(this).closest(".ae-cost-row"));
  });
  html.find(".cost-pern-dim").off("change").on("change", function () {
    const row  = $(this).closest(".ae-cost-row");
    if (row.find(".cost-type").val() !== "perStack") return;
    const dim = $(this).val() === "intensity" ? "intensity" : "stacks";
    row.find(".cost-stacks-label").text(dim === "intensity" ? "每N级" : "每N层");
  });
  html.find(".cost-consume-all").off("change").on("change", function () {
    refreshRow($(this).closest(".ae-cost-row"));
  });
  html.find(".cost-discard-mode").off("change").on("change", function () {
    const row     = $(this).closest(".ae-cost-row");
    const isLevel = $(this).val() === "level";
    row.find(".ae-cost-discard-level-sec").toggle(isLevel);
  });
}

/** 目标下拉切换到「背景标签」时显示标签名字/数量输入框 */
function _bindTargetBgTag(html) {
  html.find(".cond-target, .cost-target, .eff-target").off("change.bgtag").on("change.bgtag", function () {
    const sel    = $(this);
    const prefix = sel.hasClass("cond-target") ? "cond" : sel.hasClass("cost-target") ? "cost" : "eff";
    const val = sel.val();
    const fields = sel.closest(".ae-row-fields");
    fields.find(`.ae-${prefix}-bgtag-sec`).toggle(val === "bgTag" || val === "bgTagOther");
    fields.find(`.ae-${prefix}-max-sec`).toggle(_MULTI_TARGETS.has(val));
  });
}

function _bindDel(html) {
  html.find(".ae-del-precond").off("click").on("click", function () {
    $(this).closest(".ae-cond-row").remove();
    html.find(".ae-cond-row .ae-row-num").each((i, el) => $(el).text(`条件 ${i + 1}`));
  });
  html.find(".ae-del-cost").off("click").on("click", function () {
    $(this).closest(".ae-cost-row").remove();
    html.find(".ae-cost-row .ae-row-num").each((i, el) => $(el).text(`消耗 ${i + 1}`));
  });
  html.find(".ae-del-effect").off("click").on("click", function () {
    $(this).closest(".ae-eff-row").remove();
    html.find(".ae-eff-row .ae-row-num").each((i, el) => $(el).text(`效果 ${i + 1}`));
  });
  html.find(".ae-del-pool-buff").off("click").on("click", function () {
    $(this).closest(".ae-pool-row").remove();
  });
  html.find(".ae-del-cost-pool").off("click").on("click", function () {
    $(this).closest(".ae-cost-pool-row").remove();
  });
}

function _bindEffType(html) {
  html.find(".ae-eff-type").off("change").on("change", function () {
    const row           = $(this).closest(".ae-eff-row");
    const type          = $(this).val();
    const isBuff        = _BUFF_EFFECTS.has(type);
    const isAddBuff     = type === "addBuff";
    const isRandomBuff  = type === "randomBuff";
    const isTriggerBuff = type === "triggerBuff";
    const isUseSkill    = type === "useSkill";
    const isDiceTypeChg = type === "diceTypeChg";
    const isExtraDamage = type === "extraDamage";
    const isRelConvert  = type === "relatedSkillConvert";
    const isFieldEff    = type === "fieldResource";
    const isPanicSwap   = type === "panicCardSwap";
    row.find(".ae-eff-target-sec").toggle(!isUseSkill && !isDiceTypeChg && !isRelConvert && !isFieldEff);
    row.find(".ae-eff-field-sec").toggle(isFieldEff);
    row.find(".eff-field-stacks").attr("placeholder", _effValuePlaceholder("hpAdj"));
    row.find(".ae-eff-round-sec").toggle(isAddBuff);
    row.find(".ae-eff-buff-sec").toggle(isBuff);
    row.find(".ae-eff-val-sec").toggle(!isBuff && !isTriggerBuff && !isRandomBuff && !isUseSkill && !isDiceTypeChg && !isRelConvert && !isFieldEff && !isPanicSwap);
    row.find(".eff-value").attr("placeholder", _effValuePlaceholder(type));
    row.find(".ae-eff-trig-sec").toggle(isTriggerBuff);
    row.find(".ae-eff-random-sec").toggle(isRandomBuff);
    row.find(".ae-eff-useskill-sec").toggle(isUseSkill);
    row.find(".ae-eff-dicetypechg-sec").toggle(isDiceTypeChg);
    row.find(".ae-eff-rangechg-sec").toggle(type === "rangeChg");
    row.find(".ae-eff-extradmg-sec").toggle(isExtraDamage);
    row.find(".ae-eff-relconvert-sec").toggle(isRelConvert);
    row.find(".ae-eff-panicswap-sec").toggle(isPanicSwap);
  });
}

/** 从 Dialog HTML 读取所有数据并返回 activity 对象 */
function _readActivityForm(html, original) {
  const cfg        = CONFIG.LIMBUSCOMPANY;
  const labelToKey = _buffLabelToKey(cfg);
  const resolveKey = (label) => {
    const trimmed = (label || "").trim();
    if (!trimmed) return "";
    // 优先匹配已知标签→typeKey；未知文字直接作为 type 存储（clash.mjs 能正确处理）
    return labelToKey[trimmed] ?? normalizeBuffType(trimmed, trimmed);
  };

  const preconditions = [];
  html.find(".ae-cond-row").each((_, el) => {
    const $r      = $(el);
    const condType = $r.find(".cond-type").val() || "hasBuff";
    if (condType === "baseAttr") {
      preconditions.push({
        type:       "baseAttr",
        target:     $r.find(".cond-target").val() || "self",
        attrType:   $r.find(".cond-attr-type").val() || "hp",
        comparison: $r.find(".cond-comparison").val() || "lt",
        attrValue:  $r.find(".cond-attr-value").val()?.trim() || "0",
        ..._readBgTagMeta($r, "cond"),
      });
    } else if (condType === "useSkill") {
      preconditions.push({
        type:           "useSkill",
        target:         $r.find(".cond-target").val() || "self",
        skillNameOrTag: $r.find(".cond-skill-name-tag").val()?.trim() || "",
        skillLevel:     parseInt($r.find(".cond-skill-level").val()) || 0,
        ..._readBgTagMeta($r, "cond"),
      });
    } else if (condType === "category") {
      const cats = $r.find(".cond-category-cb:checked").map((_, el) => el.value).get();
      preconditions.push({ type: "category", categories: cats });
    } else if (condType === "useSin") {
      const sins = $r.find(".cond-usesin-cb:checked").map((_, el) => el.value).get();
      preconditions.push({ type: "useSin", sinTypes: sins });
    } else if (condType === "equipped") {
      preconditions.push({
        type:          "equipped",
        target:        $r.find(".cond-target").val() || "self",
        equipName:     $r.find(".cond-equip-name").val()?.trim()     || "",
        equipTag:      $r.find(".cond-equip-tag").val()?.trim()      || "",
        equipCategory: $r.find(".cond-equip-category").val()?.trim() || "",
        count:         Math.max(1, parseInt($r.find(".cond-equip-count").val()) || 1),
        perEach:       $r.find(".cond-equip-pereach").is(":checked"),
        maxTimes:      parseInt($r.find(".cond-equip-max").val()) || 0,
      });
    } else if (condType === "allyTag") {
      // 友方存在：目标选 bgTag / bgTagOther 等群体目标，人数门槛用「至少人数」
      preconditions.push({
        type:   "allyTag",
        target: $r.find(".cond-target").val() || "bgTagOther",
        ..._readBgTagMeta($r, "cond"),
      });
    } else if (condType === "equipSlotCategory") {
      // 【装备分类】：某个部位上装备的物品，其分类是否命中
      preconditions.push({
        type:          "equipSlotCategory",
        target:        $r.find(".cond-target").val() || "self",
        equipSlot:     $r.find(".cond-equip-slot").val() || "",
        equipCategory: $r.find(".cond-slot-category").val()?.trim() || "",
      });
    } else if (condType === "background") {
      preconditions.push({
        type:   "background",
        target: $r.find(".cond-target").val() || "self",
        bgName: $r.find(".cond-bg-name").val()?.trim() || "",
      });
    } else if (condType === "fieldResource") {
      preconditions.push({
        type:       "fieldResource",
        fieldName:  $r.find(".cond-field-name").val()?.trim() || "",
        comparison: $r.find(".cond-field-cmp").val() || "gte",
        stacks:     parseInt($r.find(".cond-field-stacks").val()) || 0,
      });
    } else if (condType === "sinResource") {
      preconditions.push({
        type:       "sinResource",
        sinType:    $r.find(".cond-sin-type").val() || "wrath",
        comparison: $r.find(".cond-sin-cmp").val()  || "gte",
        value:      parseInt($r.find(".cond-sin-value").val()) || 0,
      });
    } else if (condType === "buffCompare") {
      preconditions.push({
        type:       "buffCompare",
        target:     $r.find(".cond-target").val() || "self",
        buff:       resolveKey($r.find(".cond-buff").val()),
        buffCustom: "",
        compareDim: $r.find(".cond-cmp-dim").val() || "stacks",
        comparison: $r.find(".cond-stacks-cmp").val() || "eq",
        stacks:     parseInt($r.find(".cond-stacks").val()) || 0,
        ..._readBgTagMeta($r, "cond"),
      });
    } else {
      const isPerN = condType === "perN";
      preconditions.push({
        type:       isPerN ? "perN" : (condType === "noBuff" ? "noBuff" : "hasBuff"),
        target:     $r.find(".cond-target").val()  || "self",
        buff:       resolveKey($r.find(".cond-buff").val()),
        buffCustom: "",
        intensity:  isPerN ? 0 : (parseInt($r.find(".cond-intensity").val()) || 0),
        stacks:     parseInt($r.find(".cond-stacks").val())    || 0,
        ..._readBgTagMeta($r, "cond"),
        ...(isPerN ? {
          maxTimes: parseInt($r.find(".cond-max-times").val()) || 0,
          perNDim:  $r.find(".cond-pern-dim").val() === "intensity" ? "intensity" : "stacks",
        } : {}),
      });
    }
  });

  const costs = [];
  html.find(".ae-cost-row").each((_, el) => {
    const $r    = $(el);
    const type  = $r.find(".cost-type").val()   || "forced";
    const target = $r.find(".cost-target").val() || "self";
    if (type === "random") {
      const randomPool = [];
      $r.find(".ae-cost-pool-row").each((_, pr) => {
        const $pr  = $(pr);
        const buff = resolveKey($pr.find(".ae-cost-pool-buff").val());
        if (!buff) return;
        randomPool.push({
          buff,
          buffCustom: "",
          dim:    $pr.find(".ae-cost-pool-dim").val() === "intensity" ? "intensity" : "stacks",
          amount: Math.max(1, parseInt($pr.find(".ae-cost-pool-amount").val()) || 1),
        });
      });
      const rndPerEach = $r.find(".cost-random-pereach").prop("checked") === true;
      costs.push({
        type,
        target,
        randomPool,
        perEach:  rndPerEach,
        maxTimes: rndPerEach ? (parseInt($r.find(".cost-random-max-times").val()) || 0) : 0,
        ..._readBgTagMeta($r, "cost"),
      });
    } else if (type === "attribute") {
      costs.push({
        type,
        target,
        attrType: $r.find(".cost-attr-type").val()             || "hp",
        value:    parseInt($r.find(".cost-attr-value").val())  || 1,
        ..._readBgTagMeta($r, "cost"),
      });
    } else if (type === "discard") {
      const discardMode = $r.find(".cost-discard-mode").val() || "level";
      costs.push({
        type,
        discardMode,
        // 等级可以是 "2" 或 "2/3"（或），统一存成数组
        ...(discardMode === "level"
          ? { discardLevel: ClashManager._parseDiscardLevels($r.find(".cost-discard-level").val()) }
          : {}),
      });
    } else if (target === "field") {
      costs.push({
        type,
        target,
        fieldName: $r.find(".cost-field-name").val()?.trim() || "",
        stacks:    parseInt($r.find(".cost-field-stacks").val()) || 0,
        ...(type === "perStack" ? { maxTimes: parseInt($r.find(".cost-max-times").val()) || 0 } : {}),
      });
    } else if (target === "sin") {
      costs.push({
        type,
        target,
        sinType: $r.find(".cost-sin-type").val() || "wrath",
        value:   parseInt($r.find(".cost-sin-value").val()) || 0,
        ...(type === "perStack" ? { maxTimes: parseInt($r.find(".cost-sin-max-times").val()) || 0 } : {}),
      });
    } else {
      costs.push({
        type,
        target,
        buff:       resolveKey($r.find(".cost-buff").val()),
        buffCustom: "",
        // 扣光：忽略强度/层数，执行时整条 BUFF 移除
        consumeAll: type !== "perStack" && $r.find(".cost-consume-all").prop("checked") === true,
        intensity:  type === "perStack" ? 0 : (parseInt($r.find(".cost-intensity").val()) || 0),
        stacks:     parseInt($r.find(".cost-stacks").val())    || 0,
        ..._readBgTagMeta($r, "cost"),
        ...(type === "perStack" ? {
          maxTimes: parseInt($r.find(".cost-max-times").val()) || 0,
          perNDim:  $r.find(".cost-pern-dim").val() === "intensity" ? "intensity" : "stacks",
        } : {}),
      });
    }
  });

  const effects = [];
  html.find(".ae-eff-row").each((_, el) => {
    const $r            = $(el);
    const type          = $r.find(".eff-type").val() || "addBuff";
    const isBuff        = _BUFF_EFFECTS.has(type);
    const isRandomBuff  = type === "randomBuff";
    const isTriggerBuff = type === "triggerBuff";
    if (isRandomBuff) {
      const buffPool = [];
      $r.find(".ae-pool-row").each((_, pr) => {
        const $pr = $(pr);
        buffPool.push({
          buff:       resolveKey($pr.find(".ae-pool-buff-input").val()),
          buffCustom: "",
          intensity:  parseInt($pr.find(".ae-pool-intensity").val()) || 0,
          // 0 层是合法值（「只加 N 级、不加层」），不能用 || 1 兜底——
          // 那会让一条只给强度的池子项在编辑器里存一次就变成额外 +1 层
          stacks:     (() => { const v = parseInt($pr.find(".ae-pool-stacks").val());
                               return Number.isFinite(v) ? Math.max(0, v) : 1; })(),
        });
      });
      effects.push({
        type,
        target: $r.find(".eff-target").val() || "self",
        round:  $r.find(".eff-random-round").val() || "本回合",
        count:  Math.max(1, parseInt($r.find(".eff-random-count").val()) || 1),
        buffPool,
        buff: "", buffCustom: "", intensity: 0, stacks: 0,
        value: "", trigBuff: "", trigBuffCustom: "", trigStacks: 0,
        ..._readBgTagMeta($r, "eff"),
      });
      return;
    }
    const isAddBuff     = type === "addBuff";
    const isUseSkill    = type === "useSkill";
    const isDiceTypeChg = type === "diceTypeChg";
    if (isUseSkill) {
      const skillRef = $r.find(".eff-skill-ref").val() === "name" ? "name" : "tag";
      effects.push({
        type,
        target:     $r.find(".eff-target").val() || "self",
        skillRef,
        skillTag:   skillRef === "tag"  ? ($r.find(".eff-skill-tag").val()?.trim()  || "") : "",
        skillLevel: skillRef === "tag"  ? (parseInt($r.find(".eff-skill-level").val()) || 0) : 0,
        skillName:  skillRef === "name" ? ($r.find(".eff-skill-name").val()?.trim() || "") : "",
        reactTarget: $r.find(".eff-react-target").val() || "defender",
        ..._readBgTagMeta($r, "eff"),
      });
      return;
    }
    if (isDiceTypeChg) {
      effects.push({
        type,
        diceTypeVal: $r.find(".eff-dice-type-val").val() || "normal",
      });
      return;
    }
    if (type === "rangeChg") {
      effects.push({
        type,
        rangeMode:  $r.find(".eff-range-mode").val() || "melee",
        rangeValue: Math.max(0, parseInt($r.find(".eff-range-value").val()) || 0),
      });
      return;
    }
    if (type === "fieldResource") {
      effects.push({
        type,
        fieldName: $r.find(".eff-field-name").val()?.trim() || "",
        value:     $r.find(".eff-field-stacks").val()?.trim() || "",
      });
      return;
    }
    if (type === "panicCardSwap") {
      effects.push({
        type,
        target:        $r.find(".eff-target").val() || "target",
        panicSlot:     $r.find(".eff-panicswap-slot").val() || "panic",
        panicCardName: $r.find(".eff-panicswap-name").val()?.trim() || "",
        ..._readBgTagMeta($r, "eff"),
      });
      return;
    }
    if (type === "relatedSkillConvert") {
      effects.push({
        type,
        relMode:      "byName",
        relSkillName: $r.find(".eff-relconvert-name").val()?.trim() || "",
        relDuration:  $r.find(".eff-relconvert-duration").val() || "permanent",
      });
      return;
    }
    const isExtraDamage = type === "extraDamage";
    effects.push({
      type,
      target:         $r.find(".eff-target").val()    || "self",
      round:          isAddBuff     ? ($r.find(".eff-round").val() || "本回合") : undefined,
      buff:           isBuff        ? resolveKey($r.find(".eff-buff").val()) : "",
      buffCustom:     "",
      intensity:      isBuff        ? (parseInt($r.find(".eff-intensity").val()) || 0) : 0,
      stacks:         isBuff        ? (parseInt($r.find(".eff-stacks").val())    || 0) : 0,
      ampTremor:      isBuff        ? _specialTremorKey($r.find(".eff-amp-tremor").val()) : "",
      value:          (!isBuff && !isTriggerBuff) ? ($r.find(".eff-value").val()?.trim() || "") : "",
      trigBuff:       isTriggerBuff ? resolveKey($r.find(".eff-trig-buff").val()) : "",
      trigBuffCustom: "",
      trigStacks:     isTriggerBuff ? (parseInt($r.find(".eff-trig-stacks").val()) || 1) : 0,
      ..._readBgTagMeta($r, "eff"),
      ...(isExtraDamage ? {
        dmgCategory: $r.find(".eff-extradmg-category").val() || "",
        dmgSinType:  $r.find(".eff-extradmg-sin").val()      || "",
      } : {}),
    });
  });

  const limitVisible = html.find(".ae-limit-body").is(":visible");
  const limitCount   = parseInt(html.find("[name='act-limit-count']").val()) || 1;
  const limitTypeVal = html.find("[name='act-limit-type']").val() || "perTurn";

  return {
    ...original,
    name:          html.find("[name='act-name']").val()    || "新效果",
    trigger:       html.find("[name='act-trigger']").val() || "攻击时",
    preconditions,
    costs,
    effects,
    limit: {
      type:  limitVisible ? limitTypeVal : "unlimited",
      count: limitVisible ? limitCount : 0,
    },
  };
}
