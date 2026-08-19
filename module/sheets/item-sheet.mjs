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

    // ── 活动列表 ─────────────────────────────────────────────────────────
    context.activities = sys.activities ?? [];

    // ── 技能专用数据 ──────────────────────────────────────────────────────
    if (item.type === "skill") {
      context.sinColor = cfg.SIN_COLORS?.[sys.sinType] ?? "#5F3E21";
      context.categoryIcon = _getCategoryIcon(sys.category);
      context.isBasic       = sys.type === "basic";
      context.isDefense     = sys.type === "defense";
      context.isEgo         = sys.type === "ego";
      context.isCounterType = sys.type === "defense" &&
        (sys.category === "counter" || sys.category === "clashCounter");

      // EGO 消耗行
      // 注意：schema 字段名为 sinCost[].sinType 和 egoResistanceAdj[].{sinType,multiplier}
      if (context.isEgo) {
        // 【觉醒】/【侵蚀】两套数据，卡面按 system.egoForm 切换编辑哪一套
        const corrode = sys.egoForm === "corrode";
        context.egoForm      = corrode ? "corrode" : "awaken";
        context.isCorrode    = corrode;
        context.egoFormLabel = corrode ? "侵蚀" : "觉醒";
        context.egoCostPath  = corrode ? "corrodeSinCost" : "sinCost";
        context.egoResPath   = corrode ? "corrodeEgoResistanceAdj" : "egoResistanceAdj";
        context.sinCosts      = (corrode ? sys.corrodeSinCost : sys.sinCost) ?? [];
        context.egoResChanges = (corrode ? sys.corrodeEgoResistanceAdj : sys.egoResistanceAdj) ?? [];
      }

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

      // 技能骰公式（格式化为大写）
      context.diceFormulaDisplay = (sys.diceFormula ?? "").toUpperCase();

      // 加重值小方块
      context.weightSquares = Array.from({ length: sys.weight ?? 0 }, (_, i) => i);

      // 图标边框：与 HUD / 技能槽同一套（罪孽+等级空心框，EGO 为圆环）
      context.skillFrame = ClashManager._skillFrameIcon(item);
    }

    // ── 装备专用数据 ──────────────────────────────────────────────────────
    if (item.type === "equipment") {
      context.isWeapon    = sys.subtype === "weapon";
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

  /* ─── 容器网格构建 ──────────────────────────────────────────────────────── */

  /**
   * 将 contents 放置记录解析为模板所需数据。
   * @returns {{ placedItems: Array, allCells: Array }}
   */
  async _buildContainerGrid(placements, cols, rows, lockedCells = []) {
    const placedItems = [];
    const occupied    = new Set(); // "x,y"
    const lockedSet   = new Set(lockedCells.map(c => `${c.x},${c.y}`));

    for (let idx = 0; idx < placements.length; idx++) {
      const p = placements[idx];
      // 世界金库物品：无 UUID，改用 itemData 显示
      let item = null;
      if (p?.uuid) {
        item = await fromUuid(p.uuid).catch(() => null);
      } else if (p?.itemData) {
        item = { id: null, name: p.itemData.name ?? "未知物品", img: p.itemData.img ?? "icons/svg/item-bag.svg" };
      }
      if (!item) continue;

      const w = Math.max(1, p.w ?? 1);
      const h = Math.max(1, p.h ?? 1);
      if (p.x + w > cols || p.y + h > rows || p.x < 0 || p.y < 0) continue;

      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++)
          occupied.add(`${p.x + dx},${p.y + dy}`);

      const q = (this._containerSearch ?? "").toLowerCase();
      const show = !q || item.name.toLowerCase().includes(q);

      placedItems.push({
        idx, uuid: p.uuid ?? "",
        x: p.x, y: p.y, w, h,
        col: p.x + 1, row: p.y + 1,   // CSS grid 1-indexed
        rotated: p.rotated ?? false,
        show,
        item: { _id: item.id, name: item.name, img: item.img },
      });
    }

    const allCells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        allCells.push({ x: c, y: r, col: c + 1, row: r + 1,
          occupied: occupied.has(`${c},${r}`),
          locked: lockedSet.has(`${c},${r}`) });
      }
    }
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
   * 按行优先顺序扫描：先以原始尺寸尝试，找不到则以旋转尺寸再次扫描。
   * @param {number} w @param {number} h @param {number} [excludeIdx=-1]
   * @returns {{ x:number, y:number, w:number, h:number, rotated:boolean }|null}
   */
  _cgAutoPlace(w, h, excludeIdx = -1) {
    const sys  = this.item.system;
    const cols = sys.gridSize?.width  ?? 3;
    const rows = sys.gridSize?.height ?? 3;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (this._cgCanPlace(x, y, w, h, cols, rows, excludeIdx))
          return { x, y, w, h, rotated: false };
        if (w !== h && this._cgCanPlace(x, y, h, w, cols, rows, excludeIdx))
          return { x, y, w: h, h: w, rotated: true };
      }
    }
    return null;
  }

  /** 同步碰撞检测（使用已持久化的 w/h，同时检查锁定格）。 */
  _cgCanPlace(x, y, w, h, cols, rows, excludeIdx = -1) {
    if (x < 0 || y < 0 || x + w > cols || y + h > rows) return false;
    const contents    = this.item.system.contents ?? [];
    const lockedCells = this.item.system.lockedCells ?? [];
    const lockedSet   = new Set(lockedCells.map(c => `${c.x},${c.y}`));
    // 检查是否覆盖锁定格
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        if (lockedSet.has(`${x + dx},${y + dy}`)) return false;
    // 检查与已有物品的碰撞
    for (let i = 0; i < contents.length; i++) {
      if (i === excludeIdx) continue;
      const p = contents[i];
      const pw = p.w ?? 1, ph = p.h ?? 1;
      const noOverlap = x + w <= p.x || p.x + pw <= x || y + h <= p.y || p.y + ph <= y;
      if (!noOverlap) return false;
    }
    return true;
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
    html.find(".sheet-lock-icon").on("click", this._onToggleLock.bind(this));
    html.find(".ego-form-toggle").on("click", this._onEgoFormToggle.bind(this));

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

    // ── 容器网格（新）─────────────────────────────────────────────────────
    html.find(".cg-cell").on("dragover",  this._onCgCellDragOver.bind(this));
    html.find(".cg-cell").on("dragleave", this._onCgCellDragLeave.bind(this));
    html.find(".cg-cell").on("drop",      this._onCgCellDrop.bind(this));
    html.find(".cg-cell").on("click",     this._onCgCellClick.bind(this));
    html.find(".cg-item-tile").on("dragstart",   this._onCgTileDragStart.bind(this));
    html.find(".cg-item-tile").on("contextmenu", this._onCgTileMenu.bind(this));
    html.find(".cg-rotate-btn").on("click",      this._onCgTileRotate.bind(this));
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

    // ── skill：将用户输入的 diceFormula 文本解析为真正的 schema 字段
    if (this.item.type === "skill") {
      const _isFlat  = !formData.system;
      const rawFml   = _isFlat ? formData["system.diceFormula"] : formData.system?.diceFormula;
      if (rawFml !== undefined) {
        const parsed = _parseDiceFormula(String(rawFml));
        if (parsed) {
          if (_isFlat) {
            formData["system.diceCount"]  = parsed.diceCount;
            formData["system.diceFaces"]  = parsed.diceFaces;
            formData["system.baseValue"]  = parsed.baseValue;
          } else {
            formData.system.diceCount  = parsed.diceCount;
            formData.system.diceFaces  = parsed.diceFaces;
            formData.system.baseValue  = parsed.baseValue;
          }
        }
        // 无论解析成功与否都丢弃原始文本（prepareDerivedData 会重新生成）
        if (_isFlat) delete formData["system.diceFormula"];
        else         delete formData.system.diceFormula;
      }
    }

    return super._updateObject(event, formData);
  }


  /* ─── 关闭时清理 ───────────────────────────────────────────────────────── */

  async close(options = {}) {
    this._forceCloseAllTitleCards();
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
            <div style="color:var(--text-sub);font-size:.75rem">${sys.tags ?? ""}</div>
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
    const activities = foundry.utils.deepClone(this.item.system.activities ?? []);
    activities.push({
      id:            foundry.utils.randomID(),
      name:          "新效果",
      trigger:       "攻击时",
      preconditions: [],
      costs:         [],
      effects:       [],
      limit:         { type: "unlimited", count: 0 },
    });
    await this.item.update({ "system.activities": activities });
    this._activitiesExpanded = true;
    this.render(false);
  }

  async _onActivityEdit(event) {
    const idx  = parseInt(event.currentTarget.closest("[data-activity-idx]")?.dataset.activityIdx ?? -1);
    const acts = foundry.utils.deepClone(this.item.system.activities ?? []);
    if (idx < 0 || idx >= acts.length) return;

    await this._showActivityEditor(acts, idx);
  }

  async _onActivityDelete(event) {
    const idx  = parseInt(event.currentTarget.closest("[data-activity-idx]")?.dataset.activityIdx ?? -1);
    const acts = foundry.utils.deepClone(this.item.system.activities ?? []);
    if (idx < 0 || idx >= acts.length) return;
    acts.splice(idx, 1);
    await this.item.update({ "system.activities": acts });
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
              await this.item.update({ "system.activities": acts });
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

  /** 当前编辑的形态对应的字段名（【觉醒】/【侵蚀】各一套） */
  get _egoCostPath() {
    return this.item.system.egoForm === "corrode" ? "corrodeSinCost" : "sinCost";
  }
  get _egoResPath() {
    return this.item.system.egoForm === "corrode" ? "corrodeEgoResistanceAdj" : "egoResistanceAdj";
  }

  /** 右上角 [觉醒/侵蚀] 切换 */
  async _onEgoFormToggle(event) {
    event.preventDefault();
    const next = this.item.system.egoForm === "corrode" ? "awaken" : "corrode";
    await this.item.update({ "system.egoForm": next });
  }

  async _onSinCostAdd(event) {
    const path  = this._egoCostPath;
    const costs = foundry.utils.deepClone(this.item.system[path] ?? []);
    costs.push({ sinType: "wrath", amount: 1 }); // schema 字段名为 sinType
    await this.item.update({ [`system.${path}`]: costs });
  }

  async _onSinCostRemove(event) {
    const idx   = parseInt(event.currentTarget.dataset.idx ?? -1);
    const path  = this._egoCostPath;
    const costs = foundry.utils.deepClone(this.item.system[path] ?? []);
    if (idx >= 0) { costs.splice(idx, 1); await this.item.update({ [`system.${path}`]: costs }); }
  }

  async _onResChangeAdd(event) {
    // 条目属性为 {sinType, multiplier}
    const path    = this._egoResPath;
    const changes = foundry.utils.deepClone(this.item.system[path] ?? []);
    changes.push({ sinType: "wrath", multiplier: "x1.0" });
    await this.item.update({ [`system.${path}`]: changes });
  }

  async _onResChangeRemove(event) {
    const idx     = parseInt(event.currentTarget.dataset.idx ?? -1);
    const path    = this._egoResPath;
    const changes = foundry.utils.deepClone(this.item.system[path] ?? []);
    if (idx >= 0) { changes.splice(idx, 1); await this.item.update({ [`system.${path}`]: changes }); }
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
      const nx = targetX - offX, ny = targetY - offY;
      if (!this._cgCanPlace(nx, ny, p.w ?? 1, p.h ?? 1, cols, rows, idx))
        return void ui.notifications.warn("此位置无法放置（超出边界或与其他物品重叠）");
      p.x = nx; p.y = ny;
      return void await this.item.update({ "system.contents": contents });
    }

    // ── 金库物品拖入（带 itemData，无 UUID）────────────────────────────────
    // 来自世界金库的物品没有有效 UUID，fromDropData 无法解析，需在此提前处理
    if (raw.type === "Item" && raw.itemData && raw.fromContainer
        && raw.fromContainer.containerId !== this.item.id) {
      const itemDataSrc = raw.itemData;
      if (itemDataSrc.type === "container") return;           // 禁止容器嵌套

      const cap = itemDataSrc.system?.capacity ?? { w: 1, h: 1 };
      const w = Math.max(1, cap.w ?? 1), h = Math.max(1, cap.h ?? 1);
      // 目标格有效则直接用，否则自动寻找第一个可放入的位置（含旋转尝试）
      const place = this._cgCanPlace(targetX, targetY, w, h, cols, rows)
        ? { x: targetX, y: targetY, w, h, rotated: false }
        : this._cgAutoPlace(w, h);
      if (!place) return void ui.notifications.warn("容器空间不足，无法放置该物品。");

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
      return void await this.item.update({ "system.contents": contents });
    }

    // ── 从物品列表或其他容器拖入 ────────────────────────────────────────
    const dropped = await Item.fromDropData(raw).catch(() => null);
    if (!dropped || dropped.type === "container") return;
    if (dropped.uuid === this.item.uuid) return;            // 禁止自引用

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

    const cap = dropped.system?.capacity ?? { w: 1, h: 1 };
    const w = Math.max(1, cap.w ?? 1), h = Math.max(1, cap.h ?? 1);

    // 目标格有效则直接用，否则自动寻找第一个可放入的位置（含旋转尝试）
    const place = this._cgCanPlace(targetX, targetY, w, h, cols, rows)
      ? { x: targetX, y: targetY, w, h, rotated: false }
      : this._cgAutoPlace(w, h);
    if (!place) return void ui.notifications.warn("容器空间不足，无法放置该物品。");

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
    await this.item.update({ "system.contents": contents });
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
    if (raw.type !== "Item") return;

    const dropped = await Item.fromDropData(raw).catch(() => null);
    if (!dropped) { ui.notifications.warn("无法解析拖入的物品。"); return; }

    const itemData = dropped.toObject();
    delete itemData._id;
    const entry = { id: foundry.utils.randomID(), uuid: dropped.uuid ?? "", itemData };

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
    await this.item.update({ "system.contents": contents });
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
          }
        }
        contents.splice(idx, 1);
        await this.item.update({ "system.contents": contents });

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
        await this.item.update({ "system.contents": contents });
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
 * 将 "2d6+3" / "1D4" 风格的骰子公式字符串解析为 schema 实际字段值。
 * 支持格式：NdF、NdF+B（大小写均可，忽略空格）。
 * 解析失败返回 null，调用方应保留旧值。
 */
function _parseDiceFormula(formula) {
  if (!formula) return null;
  const m = String(formula).toLowerCase().replace(/\s+/g, "")
    .match(/^(\d+)d(\d+)(?:\+(\d+))?$/);
  if (!m) return null;
  return {
    diceCount: Math.max(0, parseInt(m[1]) || 0),
    diceFaces: Math.max(1, parseInt(m[2]) || 4),
    baseValue: Math.max(0, parseInt(m[3] ?? 0) || 0),
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
  const rect  = anchorEl.getBoundingClientRect();
  const cardW = 280, cardH = 500;
  let left = rect.left - cardW - 8;
  if (left < 8) left = rect.right + 8;
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
      ${weightCount > 0 ? `<div class="tc-weight"><span class="tc-weight-label">加重值</span>${Array.from({length: weightCount}, () => '<span class="tc-weight-sq"></span>').join("")}</div>` : ""}
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

function _activityEffectLabels() {
  return [
    { value: "addBuff",      label: "添加BUFF" },
    { value: "randomBuff",   label: "随机BUFF" },
    { value: "removeBuff",   label: "移除BUFF" },
    { value: "hpAdj",        label: "生命值调整" },
    { value: "sanityAdj",    label: "理智值调整" },
    { value: "apAdj",        label: "行动值" },
    { value: "weightAdj",    label: "加重值" },
    { value: "diceAdj",      label: "骰数" },
    { value: "diceFacesAdj", label: "面数" },
    { value: "baseValue",    label: "基础值" },
    { value: "seismicBlast", label: "震颤引爆" },
    { value: "triggerBuff",  label: "触发BUFF" },
    { value: "useSkill",     label: "使用技能" },
    { value: "diceTypeChg",  label: "骰子类型" },
    { value: "extraDamage",  label: "追加伤害" },
    { value: "relatedSkillConvert", label: "相关技能转换" },
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
                                       "拼点时", "拼点成功", "拼点失败",
                                       "命中时", "暴击命中时"] },
    { label: "── 通用 ──",  values: ["回合开始时", "回合结束时", "受到伤害时"] },
    { label: "── 反应 ──",  values: ["反应"] },
    { label: "── 丢弃 ──",  values: ["丢弃时"] },
    { label: "── 恐慌 ──",  values: ["恐慌触发时", "坚定触发时"] },
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
  const condType   = ["perN","baseAttr","useSkill","buffCompare","category","fieldResource","sinResource","background","equipped"].includes(cond?.type) ? cond.type : "hasBuff";
  const isBuffSec  = condType === "hasBuff" || condType === "perN" || condType === "buffCompare";
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
          <option value="perN"        ${condType === "perN"        ? "selected" : ""}>每</option>
          <option value="buffCompare" ${condType === "buffCompare" ? "selected" : ""}>比较值</option>
          <option value="baseAttr"    ${condType === "baseAttr"    ? "selected" : ""}>基础属性</option>
          <option value="useSkill"    ${condType === "useSkill"    ? "selected" : ""}>使用技能</option>
          <option value="category"    ${condType === "category"    ? "selected" : ""}>使用分类</option>
          <option value="background"  ${condType === "background"  ? "selected" : ""}>背景</option>
          <option value="equipped"    ${condType === "equipped"    ? "selected" : ""}>已装备</option>
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
        <!-- 随机消耗：从候选池中随机抽一条来扣（扣不起的候选自动排除；全都扣不起则整条消耗跳过，不阻断效果）
             每条候选可分别指定按「层数」或按「强度(级)」扣除，
             例：随机消耗 1 层 或 1 级【生蝶·亡蝶】= 两条候选，同一BUFF、维度分别为层/级 -->
        <span class="ae-cost-random-sec" ${isRandom ? "" : 'style="display:none"'}>
          <div class="ae-pool-list ae-cost-pool-list">
            ${(cost?.randomPool?.length ? cost.randomPool : [{ buff: "", dim: "stacks", amount: 1 }])
              .map(entry => _buildCostPoolRow(entry, cfg)).join("")}
          </div>
          <button type="button" class="ae-add-cost-pool ae-add-btn">＋ 添加候选</button>
        </span>
        <span class="ae-cost-buff-sec" ${(isAttr || isDiscard || isField || isSin || isRandom) ? 'style="display:none"' : ""}>
          <label>BUFF</label>
          <input class="ae-input cost-buff" type="text" list="ae-buff-dl"
                 placeholder="输入或选择BUFF…" autocomplete="off" style="width:100px;"
                 value="${_esc(_keyToLabel(cost?.buff ?? "", cost?.buffCustom ?? ""))}">
          <span class="ae-cost-intensity-sec" ${isPerStack ? 'style="display:none"' : ""}>
            <label>强度</label>
            <input class="ae-input-sm cost-intensity" type="number" value="${cost?.intensity ?? 0}" min="0">
          </span>
          <span class="ae-cost-pern-dim-sec" ${isPerStack ? "" : 'style="display:none"'}>
            <label>维度</label>
            <select class="ae-sel cost-pern-dim">${costPerNDimOpts}</select>
          </span>
          <label class="cost-stacks-label">${isPerStack ? (costPerNDim === "intensity" ? "每N级" : "每N层") : "层数"}</label>
          <input class="ae-input-sm cost-stacks"    type="number" value="${cost?.stacks ?? 0}"    min="0">
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
            <input class="ae-input-sm cost-discard-level" type="number" value="${cost?.discardLevel ?? 1}" min="1" max="3">
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
  const isExtraDamage  = type === "extraDamage";
  const isRelConvert   = type === "relatedSkillConvert";
  const isFieldEff     = type === "fieldResource";
  const effOpts    = _activityEffectLabels()
    .map(e => `<option value="${e.value}" ${type === e.value ? "selected" : ""}>${e.label}</option>`).join("");
  const roundVal   = eff?.round ?? "本回合";
  const roundOpts  = _ROUND_OPTIONS
    .map(v => `<option value="${v}" ${roundVal === v ? "selected" : ""}>${v}</option>`).join("");
  const formulaVal = _esc(eff?.value ?? "");
  const isValSec   = !isBuff && !isTriggerBuff && !isRandomBuff && !isUseSkill && !isDiceTypeChg && !isRelConvert && !isFieldEff;
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
          <!-- [反应] 里用这个技能打谁：默认打"触发者攻击的那个目标"（补刀），
               其余触发时机下该选项不起作用 -->
          <label>[反应]对谁</label>
          <select class="ae-sel eff-react-target">
            <option value="defender" ${(eff?.reactTarget ?? "defender") === "defender" ? "selected" : ""}>触发者的目标</option>
            <option value="attacker" ${eff?.reactTarget === "attacker" ? "selected" : ""}>触发者本人</option>
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
        <span class="ae-eff-relconvert-sec" ${isRelConvert ? "" : 'style="display:none"'}>
          <label>技能名字</label>
          <input class="ae-input eff-relconvert-name" type="text" list="ae-owned-skill-dl"
                 value="${_esc(eff?.relSkillName ?? "")}" placeholder="技能名字（在背包/技能列表中检索）" style="width:130px;" autocomplete="off">
          <span class="ae-eff-relconvert-hint">永久替换本技能在角色技能槽中的位置（在背包/技能列表按名字检索目标技能）</span>
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
    const isBuffSec  = type === "hasBuff" || type === "perN" || type === "buffCompare";
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
    row.find(".ae-cond-field-sec").toggle(isFieldSec);
    row.find(".ae-cond-sin-sec").toggle(isSinSec);
    row.find(".ae-cond-bg-sec").toggle(isBgSec);
    row.find(".ae-cond-equip-sec").toggle(isEquipSec);
    row.find(".ae-cond-target-sec").toggle(!isCatSec && !isFieldSec && !isSinSec);
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
    row.find(".ae-cost-intensity-sec").toggle(!isPerStack);
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
    row.find(".ae-eff-target-sec").toggle(!isUseSkill && !isDiceTypeChg && !isRelConvert && !isFieldEff);
    row.find(".ae-eff-field-sec").toggle(isFieldEff);
    row.find(".eff-field-stacks").attr("placeholder", _effValuePlaceholder("hpAdj"));
    row.find(".ae-eff-round-sec").toggle(isAddBuff);
    row.find(".ae-eff-buff-sec").toggle(isBuff);
    row.find(".ae-eff-val-sec").toggle(!isBuff && !isTriggerBuff && !isRandomBuff && !isUseSkill && !isDiceTypeChg && !isRelConvert && !isFieldEff);
    row.find(".eff-value").attr("placeholder", _effValuePlaceholder(type));
    row.find(".ae-eff-trig-sec").toggle(isTriggerBuff);
    row.find(".ae-eff-random-sec").toggle(isRandomBuff);
    row.find(".ae-eff-useskill-sec").toggle(isUseSkill);
    row.find(".ae-eff-dicetypechg-sec").toggle(isDiceTypeChg);
    row.find(".ae-eff-extradmg-sec").toggle(isExtraDamage);
    row.find(".ae-eff-relconvert-sec").toggle(isRelConvert);
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
        type:       isPerN ? "perN" : "hasBuff",
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
      costs.push({
        type,
        target,
        randomPool,
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
        ...(discardMode === "level" ? { discardLevel: parseInt($r.find(".cost-discard-level").val()) || 1 } : {}),
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
          stacks:     parseInt($pr.find(".ae-pool-stacks").val())    || 1,
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
    if (type === "fieldResource") {
      effects.push({
        type,
        fieldName: $r.find(".eff-field-name").val()?.trim() || "",
        value:     $r.find(".eff-field-stacks").val()?.trim() || "",
      });
      return;
    }
    if (type === "relatedSkillConvert") {
      effects.push({
        type,
        relMode:      "byName",
        relSkillName: $r.find(".eff-relconvert-name").val()?.trim() || "",
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
