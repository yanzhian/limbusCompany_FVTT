/**
 * item-sheet.mjs — 物品卡界面
 * LimbusItemSheet extends ItemSheet
 *
 * 支持类型：equipment / skill / consumable / material / container
 * 特性：
 *   - 🔒/🔓 编辑锁（runtime状态，不持久化）
 *   - 效果触发编辑器（Activity editor，折叠/展开）
 *   - 技能：相关技能展开（[+] 展开）
 *   - 装备：链接方向切换（黑/白）
 *   - 容器：自定义网格
 */

import { ClashManager } from "../helpers/clash.mjs";
import { SKILLBOOK_MAX_SLOTS } from "../documents/item.mjs";
import { CustomBuffRegistry, normalizeBuffType } from "../helpers/custom-buffs.mjs";

export class LimbusItemSheet extends ItemSheet {

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
    };
    const name = typeMap[this.item.type] ?? "equipment-sheet";
    return `systems/limbusCompany_FVTT/templates/item/${name}.hbs`;
  }

  /* ─── 编辑锁 runtime 状态 ──────────────────────────────────────────────── */

  get isLocked() { return this._isLocked ?? true; }
  set isLocked(v) { this._isLocked = v; }

  /* ─── 活动编辑器展开状态 ────────────────────────────────────────────────── */

  get activitiesExpanded() { return this._activitiesExpanded ?? false; }

  /* ─── 相关技能展开状态（技能类型专用） ──────────────────────────────────── */

  get relatedExpanded() { return this._relatedExpanded ?? false; }

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
    context.relatedExpanded    = this.relatedExpanded;

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

      // 相关技能解析
      const relUuid = sys.relatedSkill?.itemUuid;
      if (relUuid) {
        const relItem = await fromUuid(relUuid).catch(() => null);
        context.relatedSkillItem = relItem ? {
          _id:          relItem.id,
          name:         relItem.name,
          img:          relItem.img,
          system:       relItem.system,
          sinColor:     cfg.SIN_COLORS?.[relItem.system?.sinType] ?? "#2A7A2A",
          categoryIcon: _getCategoryIcon(relItem.system?.category),
        } : null;
      } else {
        context.relatedSkillItem = null;
      }

      // EGO 消耗行
      // 注意：schema 字段名为 sinCost[].sinType 和 egoResistanceAdj[].{sinType,multiplier}
      if (context.isEgo) {
        context.sinCosts = sys.sinCost ?? [];
        context.egoResChanges = sys.egoResistanceAdj ?? [];
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

      // 触发条件
      context.relatedTriggers = cfg.RELATED_SKILL_TRIGGERS ?? [];
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

    // ── 相关技能 [+] ─────────────────────────────────────────────────────
    html.find(".related-skill-toggle").on("click", this._onRelatedToggle.bind(this));

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
    html.find(".cg-item-tile").on("mouseenter",  this._onCgTileHover.bind(this));
    html.find(".cg-item-tile").on("mouseleave",  this._onCgTileHoverEnd.bind(this));
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
    html.find(".skillbook-slot").on("mouseenter",    this._onCgTileHover.bind(this));
    html.find(".skillbook-slot").on("mouseleave",    this._onCgTileHoverEnd.bind(this));
    html.find(".skillbook-learn-btn").on("click",    this._onSkillBookLearn.bind(this));
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
    this._onCgTileHoverEnd();
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
    if ((actor.system.ap?.value ?? 0) <= 0) {
      ui.notifications.warn("行动值不足，无法发起对抗");
      return;
    }
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
    const hasLimit = act.limit?.type === "perTurn";

    const content = `
      ${_buildBuffDatalistHtml("ae-buff-dl", cfg)}
      ${_buildTriggerBuffDatalistHtml("ae-trig-buff-dl", cfg)}
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
            <div class="ae-limit-body" style="display:${hasLimit ? "flex" : "none"}">
              <label class="ae-label">每回合上限</label>
              <input class="ae-input ae-input-sm" type="number" name="act-limit-count"
                     value="${act.limit?.count ?? 1}" min="1">
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

  /* ─── 相关技能展开 ──────────────────────────────────────────────────────── */

  _onRelatedToggle(event) {
    this._relatedExpanded = !this.relatedExpanded;
    this.render(false);
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
    // schema 字段名为 egoResistanceAdj，条目属性为 {sinType, multiplier}
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

  /* ─── 物品格：开始拖拽（内部重定位）────────────────────────────────────── */

  _onCgTileDragStart(event) {
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

  /* ─── 物品图块：悬停 Title 卡 ───────────────────────────────────────────── */

  async _onCgTileHover(event) {
    const tile = event.currentTarget;
    const uuid = tile.dataset.itemUuid;
    if (!uuid) return;

    this._onCgTileHoverEnd();

    const item = await fromUuid(uuid).catch(() => null);
    if (!item) return;

    this._cgTitleCard = _buildItemTitleCard(item);
    if (!this._cgTitleCard) return;

    // 定位：在物品卡左侧，不够则右侧
    const rect  = this.element[0].getBoundingClientRect();
    const cardW = 280, cardH = 500;
    let left = rect.left - cardW - 8;
    if (left < 8) left = rect.right + 8;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - cardH - 8));

    this._cgTitleCard.css({ position: "fixed", left, top, zIndex: 99998 });
    $("body").append(this._cgTitleCard);
  }

  _onCgTileHoverEnd() {
    this._cgTitleCard?.remove();
    this._cgTitleCard = null;
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
    const descText    = sys.effectDesc ?? sys.description ?? "";
    return $(`<div class="limbus-title-card limbus-title-card-skill">
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
    </div>`);
  }

  // 装备 / 消耗品 / 材料 / 容器
  const typeLabels   = { equipment:"装备", consumable:"消耗品", material:"材料", container:"容器" };
  const stellarCost  = sys.stellarCost ?? 0;
  const tags = (Array.isArray(sys.tags) ? sys.tags : String(sys.tags ?? "").split("/"))
    .map(t => String(t).trim()).filter(Boolean);
  const descText     = sys.effect ?? sys.description ?? sys.effectDesc ?? "";

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
    return $(`<div class="limbus-title-card limbus-title-card-equip">
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
    </div>`);
  }

  // 消耗品 / 材料 / 容器 — 简单卡片
  const typeLabel = typeLabels[item.type] ?? item.type;
  const catLabel  = sys.category ? ` · ${sys.category}` : "";
  const tagsHtml  = tags.map(t => `<span class="tc-skill-tag">${t}</span>`).join("");
  return $(`<div class="limbus-title-card limbus-title-card-equip">
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
  </div>`);
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
  ];
  return groups.map(g =>
    `<optgroup label="${g.label}">${g.values.map(v =>
      `<option value="${v}" ${selected === v ? "selected" : ""}>${v}</option>`
    ).join("")}</optgroup>`
  ).join("");
}

/** 前置条件行 HTML */
function _buildCondRow(cond, idx, cfg) {
  const condType   = ["perN","baseAttr","useSkill"].includes(cond?.type) ? cond.type : "hasBuff";
  const isBuffSec  = condType === "hasBuff" || condType === "perN";
  const isAttrSec  = condType === "baseAttr";
  const isSkillSec = condType === "useSkill";
  const stacksLbl  = condType === "perN" ? "每N层" : "层数≥";
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
        <label>类型</label>
        <select class="ae-sel cond-type">
          <option value="hasBuff"  ${condType === "hasBuff"  ? "selected" : ""}>拥有</option>
          <option value="perN"     ${condType === "perN"     ? "selected" : ""}>每</option>
          <option value="baseAttr" ${condType === "baseAttr" ? "selected" : ""}>基础属性</option>
          <option value="useSkill" ${condType === "useSkill" ? "selected" : ""}>使用技能</option>
        </select>
        <label>目标</label>
        <select class="ae-sel cond-target">${_buildTargetOptions(cond?.target ?? "self")}</select>
        <span class="ae-cond-buff-sec" ${isBuffSec ? "" : 'style="display:none"'}>
          <label>BUFF</label>
          <input class="ae-input cond-buff" type="text" list="ae-buff-dl"
                 placeholder="输入或选择BUFF…" autocomplete="off" style="width:100px;"
                 value="${_esc(buffLabel)}">
          <label>强度≥</label>
          <input class="ae-input-sm cond-intensity" type="number" value="${cond?.intensity ?? 0}" min="0">
          <label class="cond-stacks-label">${stacksLbl}</label>
          <input class="ae-input-sm cond-stacks" type="number" value="${cond?.stacks ?? 1}" min="0">
        </span>
        <span class="ae-cond-attr-sec" ${isAttrSec ? "" : 'style="display:none"'}>
          <label>属性</label>
          <select class="ae-sel cond-attr-type">${attrTypeOpts}</select>
          <select class="ae-sel cond-comparison">${cmpOpts}</select>
          <input class="ae-input-sm cond-attr-value" type="text"
                 value="${_esc(cond?.attrValue ?? "")}" placeholder="50 或 5%">
        </span>
        <span class="ae-cond-skill-sec" ${isSkillSec ? "" : 'style="display:none"'}>
          <label>技能UUID</label>
          <input class="ae-input cond-skill-uuid" type="text"
                 value="${_esc(cond?.skillUuid ?? "")}" placeholder="Item.xxx…" style="width:130px;">
          <img class="ae-skill-preview" data-uuid-src="cond-skill-uuid"
               src="${_esc(cond?.skillUuid ? "icons/svg/item-bag.svg" : "")}"
               style="width:20px;height:20px;object-fit:cover;border-radius:3px;vertical-align:middle;${cond?.skillUuid ? "" : "display:none;"}">
        </span>
      </div>
    </div>`;
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
  ].map(([v, l]) => `<option value="${v}" ${selected === v ? "selected" : ""}>${l}</option>`).join("");
}

/** 消耗行 HTML */
function _buildCostRow(cost, idx, cfg) {
  const selType  = cost?.type ?? "forced";
  const isAttr   = selType === "attribute";
  const typeOpts = [
    ["perStack",  "【每】"],
    ["forced",    "强制消耗"],
    ["optional",  "可选消耗"],
    ["attribute", "基础属性"],
  ].map(([v, l]) => `<option value="${v}" ${selType === v ? "selected" : ""}>${l}</option>`).join("");

  const attrTypeOpts = [
    ["hp",     "生命值"],
    ["sanity", "理智值"],
    ["ap",     "行动值"],
  ].map(([v, l]) => `<option value="${v}" ${(cost?.attrType ?? "hp") === v ? "selected" : ""}>${l}</option>`).join("");

  return `
    <div class="ae-row ae-cost-row">
      <div class="ae-row-hd">
        <span class="ae-row-num">消耗 ${idx + 1}</span>
        <button type="button" class="ae-del-btn ae-del-cost">×</button>
      </div>
      <div class="ae-row-fields">
        <label>类型</label>
        <select class="ae-sel cost-type">${typeOpts}</select>
        <label>目标</label>
        <select class="ae-sel cost-target">${_buildTargetOptions(cost?.target ?? "self")}</select>
        <span class="ae-cost-buff-sec" ${isAttr ? 'style="display:none"' : ""}>
          <label>BUFF</label>
          <input class="ae-input cost-buff" type="text" list="ae-buff-dl"
                 placeholder="输入或选择BUFF…" autocomplete="off" style="width:100px;"
                 value="${_esc(_keyToLabel(cost?.buff ?? "", cost?.buffCustom ?? ""))}">
          <label>强度</label>
          <input class="ae-input-sm cost-intensity" type="number" value="${cost?.intensity ?? 0}" min="0">
          <label>层数</label>
          <input class="ae-input-sm cost-stacks"    type="number" value="${cost?.stacks ?? 1}"    min="0">
        </span>
        <span class="ae-cost-attr-sec" ${isAttr ? "" : 'style="display:none"'}>
          <label>属性</label>
          <select class="ae-sel cost-attr-type">${attrTypeOpts}</select>
          <label>数值</label>
          <input class="ae-input-sm cost-attr-value" type="number" value="${cost?.value ?? 1}" min="1">
        </span>
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
  const effOpts    = _activityEffectLabels()
    .map(e => `<option value="${e.value}" ${type === e.value ? "selected" : ""}>${e.label}</option>`).join("");
  const roundVal   = eff?.round ?? "本回合";
  const roundOpts  = _ROUND_OPTIONS
    .map(v => `<option value="${v}" ${roundVal === v ? "selected" : ""}>${v}</option>`).join("");
  const formulaVal = _esc(eff?.value ?? "");
  const isValSec   = !isBuff && !isTriggerBuff && !isRandomBuff && !isUseSkill;
  return `
    <div class="ae-row ae-eff-row">
      <div class="ae-row-hd">
        <span class="ae-row-num">效果 ${idx + 1}</span>
        <button type="button" class="ae-del-btn ae-del-effect">×</button>
      </div>
      <div class="ae-row-fields">
        <label>类型</label>
        <select class="ae-sel ae-eff-type eff-type">${effOpts}</select>
        <span class="ae-eff-target-sec" ${isUseSkill ? 'style="display:none"' : ""}>
          <label>目标</label>
          <select class="ae-sel eff-target">${_buildTargetOptions(eff?.target ?? "self")}</select>
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
          <input class="ae-input-sm eff-stacks" type="number" value="${eff?.stacks ?? 1}" min="0">
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
          <label>技能UUID</label>
          <input class="ae-input eff-skill-uuid" type="text"
                 value="${_esc(eff?.skillUuid ?? "")}" placeholder="Item.xxx…" style="width:130px;">
          <img class="ae-skill-preview" data-uuid-src="eff-skill-uuid"
               src="${_esc(eff?.skillUuid ? "icons/svg/item-bag.svg" : "")}"
               style="width:20px;height:20px;object-fit:cover;border-radius:3px;vertical-align:middle;${eff?.skillUuid ? "" : "display:none;"}">
        </span>
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
  });
  html.find(".ae-add-cost").on("click", () => {
    const list = html.find(".ae-cost-list");
    const idx  = list.find(".ae-cost-row").length;
    list.append(_buildCostRow({}, idx, cfg));
    _bindDel(html);
    _bindCondCostBuff(html);
    _bindCostType(html);
  });
  html.find(".ae-add-effect").on("click", () => {
    const list = html.find(".ae-effect-list");
    const idx  = list.find(".ae-eff-row").length;
    list.append(_buildEffectRow({}, idx, cfg));
    _bindDel(html);
    _bindEffType(html);
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
  _bindCostType(html);
  _bindCondType(html);
  _bindSkillUuidPreview(html);
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

/** 切换条件类型时控制各子区段显示 */
function _bindCondType(html) {
  html.find(".cond-type").off("change").on("change", function () {
    const row      = $(this).closest(".ae-cond-row");
    const type     = $(this).val();
    const isBuffSec  = type === "hasBuff" || type === "perN";
    const isAttrSec  = type === "baseAttr";
    const isSkillSec = type === "useSkill";
    row.find(".cond-stacks-label").text(type === "perN" ? "每N层" : "层数≥");
    row.find(".ae-cond-buff-sec").toggle(isBuffSec);
    row.find(".ae-cond-attr-sec").toggle(isAttrSec);
    row.find(".ae-cond-skill-sec").toggle(isSkillSec);
  });
}

function _bindCostType(html) {
  html.find(".cost-type").off("change").on("change", function () {
    const row    = $(this).closest(".ae-cost-row");
    const isAttr = $(this).val() === "attribute";
    row.find(".ae-cost-buff-sec").toggle(!isAttr);
    row.find(".ae-cost-attr-sec").toggle(isAttr);
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
    row.find(".ae-eff-target-sec").toggle(!isUseSkill);
    row.find(".ae-eff-round-sec").toggle(isAddBuff);
    row.find(".ae-eff-buff-sec").toggle(isBuff);
    row.find(".ae-eff-val-sec").toggle(!isBuff && !isTriggerBuff && !isRandomBuff && !isUseSkill);
    row.find(".eff-value").attr("placeholder", _effValuePlaceholder(type));
    row.find(".ae-eff-trig-sec").toggle(isTriggerBuff);
    row.find(".ae-eff-random-sec").toggle(isRandomBuff);
    row.find(".ae-eff-useskill-sec").toggle(isUseSkill);
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
      });
    } else if (condType === "useSkill") {
      preconditions.push({
        type:      "useSkill",
        target:    $r.find(".cond-target").val() || "self",
        skillUuid: $r.find(".cond-skill-uuid").val()?.trim() || "",
      });
    } else {
      preconditions.push({
        type:       condType === "perN" ? "perN" : "hasBuff",
        target:     $r.find(".cond-target").val()  || "self",
        buff:       resolveKey($r.find(".cond-buff").val()),
        buffCustom: "",
        intensity:  parseInt($r.find(".cond-intensity").val()) || 0,
        stacks:     parseInt($r.find(".cond-stacks").val())    || 1,
      });
    }
  });

  const costs = [];
  html.find(".ae-cost-row").each((_, el) => {
    const $r    = $(el);
    const type  = $r.find(".cost-type").val()   || "forced";
    const target = $r.find(".cost-target").val() || "self";
    if (type === "attribute") {
      costs.push({
        type,
        target,
        attrType: $r.find(".cost-attr-type").val()             || "hp",
        value:    parseInt($r.find(".cost-attr-value").val())  || 1,
      });
    } else {
      costs.push({
        type,
        target,
        buff:       resolveKey($r.find(".cost-buff").val()),
        buffCustom: "",
        intensity:  parseInt($r.find(".cost-intensity").val()) || 0,
        stacks:     parseInt($r.find(".cost-stacks").val())    || 1,
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
      });
      return;
    }
    const isAddBuff  = type === "addBuff";
    const isUseSkill = type === "useSkill";
    if (isUseSkill) {
      effects.push({
        type,
        target:    $r.find(".eff-target").val() || "self",
        skillUuid: $r.find(".eff-skill-uuid").val()?.trim() || "",
      });
      return;
    }
    effects.push({
      type,
      target:         $r.find(".eff-target").val()    || "self",
      round:          isAddBuff     ? ($r.find(".eff-round").val() || "本回合") : undefined,
      buff:           isBuff        ? resolveKey($r.find(".eff-buff").val()) : "",
      buffCustom:     "",
      intensity:      isBuff        ? (parseInt($r.find(".eff-intensity").val()) || 0) : 0,
      stacks:         isBuff        ? (parseInt($r.find(".eff-stacks").val())    || 1) : 0,
      value:          (!isBuff && !isTriggerBuff) ? ($r.find(".eff-value").val()?.trim() || "") : "",
      trigBuff:       isTriggerBuff ? resolveKey($r.find(".eff-trig-buff").val()) : "",
      trigBuffCustom: "",
      trigStacks:     isTriggerBuff ? (parseInt($r.find(".eff-trig-stacks").val()) || 1) : 0,
    });
  });

  const limitVisible = html.find(".ae-limit-body").is(":visible");
  const limitCount   = parseInt(html.find("[name='act-limit-count']").val()) || 1;

  return {
    ...original,
    name:          html.find("[name='act-name']").val()    || "新效果",
    trigger:       html.find("[name='act-trigger']").val() || "攻击时",
    preconditions,
    costs,
    effects,
    limit: {
      type:  limitVisible ? "perTurn" : "unlimited",
      count: limitVisible ? limitCount : 0,
    },
  };
}
