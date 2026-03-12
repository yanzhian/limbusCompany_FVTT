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

      // 链接方向
      context.linkDirs = ["up", "down", "left", "right"];
      context.linksActive = sys.links ?? { up: false, down: false, left: false, right: false };
    }

    // ── 消耗品/材料专用数据 ───────────────────────────────────────────────
    if (item.type === "consumable" || item.type === "material") {
      context.isConsumable = item.type === "consumable";
      context.isMaterial   = item.type === "material";
      context.typeLabel    = item.type === "consumable" ? "消耗品" : "材料";
    }

    // ── 容器专用数据 ──────────────────────────────────────────────────────
    if (item.type === "container") {
      const [cols, rows] = _parseGridSize(sys.gridSize ?? "6x6");
      context.gridCols  = cols;
      context.gridRows  = rows;
      context.gridCells = await this._buildContainerGrid(sys.contents ?? [], cols * rows);
      context.gridSizeLabel = `${cols} x ${rows}`;
      context.containerSearch = this._containerSearch ?? "";
    }

    // ── Activity 触发时机 & 效果类型选项 ─────────────────────────────────
    context.activityTriggers = cfg.ACTIVITY_TRIGGERS ?? [];
    context.activityEffects  = _activityEffectLabels();
    context.buffGroupOptions = _buildBuffGroupOptions(cfg);

    return context;
  }

  /* ─── 容器网格构建 ──────────────────────────────────────────────────────── */

  async _buildContainerGrid(contentIds, totalCells) {
    const cells = [];
    for (let i = 0; i < totalCells; i++) {
      const id   = contentIds[i] ?? null;
      const item = id ? await fromUuid(id).catch(() => null) : null;
      const query = (this._containerSearch ?? "").toLowerCase();
      const show  = !query || !item || item.name.toLowerCase().includes(query);
      cells.push({ index: i, item, itemId: id, show });
    }
    return cells;
  }

  /* ─── 事件绑定 ──────────────────────────────────────────────────────────── */

  activateListeners(html) {
    super.activateListeners(html);

    // ── 只读 ─────────────────────────────────────────────────────────────
    html.find(".item-send-chat").on("click", this._onSendToChat.bind(this));
    html.find(".item-start-clash").on("click", this._onStartClash.bind(this));
    html.find(".item-use-btn").on("click", this._onUseItem.bind(this));

    // ── 编辑锁切换 ────────────────────────────────────────────────────────
    html.find(".sheet-lock-icon").on("click", this._onToggleLock.bind(this));

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
    html.find(".link-dir-btn").on("click", this._onLinkDirToggle.bind(this));

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

    // ── 容器网格拖放 ──────────────────────────────────────────────────────
    html.find(".container-cell").on("dragover", e => e.preventDefault());
    html.find(".container-cell").on("drop", this._onContainerCellDrop.bind(this));
    html.find(".container-cell[data-item-id]").on("contextmenu", this._onContainerCellMenu.bind(this));
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

  /* ─── 发起对抗 ──────────────────────────────────────────────────────────── */

  async _onStartClash(event) {
    const item    = this.item;
    const formula = item.system.diceFormula ?? "1d4";

    const content = `
      <div class="limbuscompany clash-dialog">
        <div class="clash-skill-info"><strong>${item.name}</strong> <span>${formula.toUpperCase()}</span></div>
        <div class="form-group">
          <label>加值修正</label>
          <input type="text" name="bonus" placeholder="加值修正?"/>
        </div>
      </div>`;

    new Dialog({
      title: "发起对抗",
      content,
      buttons: {
        go: {
          label: "发起对抗",
          callback: async (html) => {
            const bonus  = parseInt(html.find("[name='bonus']").val()) || 0;
            const full   = bonus !== 0 ? `${formula}${bonus >= 0 ? "+" : ""}${bonus}` : formula;
            const roll   = new Roll(full);
            await roll.evaluate();

            ChatMessage.create({
              content: `
              <div class="limbuscompany clash-card">
                <div class="clash-header">发起对抗</div>
                <div class="card-body">
                  <div><strong>${item.name}</strong>　${full.toUpperCase()}</div>
                  <div class="clash-action-btns" data-roll-total="${roll.total}" data-formula="${full}">
                    <button class="clash-action-btn" data-action="clash">对抗</button>
                    <button class="clash-action-btn danger" data-action="take">承受</button>
                  </div>
                </div>
              </div>`,
              flags: { limbusCompany_FVTT: { type: "clash-initiate", itemId: item.id, rollTotal: roll.total } },
            });
          },
        },
      },
      default: "go",
    }).render(true);
  }

  /* ─── 使用消耗品 ────────────────────────────────────────────────────────── */

  async _onUseItem(event) {
    const item = this.item;
    const qty  = item.system.quantity ?? 0;
    if (qty <= 0) { ui.notifications.warn("数量不足。"); return; }

    await item.update({ "system.quantity": qty - 1 });
    ChatMessage.create({
      content: `<div class="limbuscompany-card"><div class="card-title">${item.name}</div><div class="card-body">使用了 1 个 ${item.name}。</div></div>`,
    });

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

  /* ─── 链接方向 ──────────────────────────────────────────────────────────── */

  async _onLinkDirToggle(event) {
    event.preventDefault();
    if (this.isLocked) return;
    const dir     = event.currentTarget.dataset.dir;
    const current = this.item.system.links?.[dir] ?? false;
    await this.item.update({ [`system.links.${dir}`]: !current });
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
    this.element.find(".container-cell").each((_, cell) => {
      const name = $(cell).data("item-name") ?? "";
      $(cell).toggle(!q || name.toLowerCase().includes(q));
    });
  }

  /* ─── 容器格拖放 ────────────────────────────────────────────────────────── */

  async _onContainerCellDrop(event) {
    event.preventDefault();
    const data   = TextEditor.getDragEventData(event);
    const droppedItem = await Item.fromDropData(data).catch(() => null);
    if (!droppedItem || droppedItem.type === "container") return;

    const cellIdx = parseInt($(event.currentTarget).data("cell-index") ?? -1);
    if (cellIdx < 0) return;

    const contents = foundry.utils.deepClone(this.item.system.contents ?? []);
    contents[cellIdx] = droppedItem.uuid;
    await this.item.update({ "system.contents": contents });
  }

  async _onContainerCellMenu(event) {
    event.preventDefault();
    const cell    = $(event.currentTarget);
    const cellIdx = parseInt(cell.data("cell-index") ?? -1);
    const contents = foundry.utils.deepClone(this.item.system.contents ?? []);

    const menuItems = [
      { name: "取出", icon: "<i class='fas fa-box-open'></i>", callback: async () => {
        contents[cellIdx] = null;
        await this.item.update({ "system.contents": contents });
      }},
    ];

    const menu = $('<nav class="limbus-context-menu context-menu"></nav>');
    for (const mi of menuItems) {
      const li = $(`<li class="context-item">${mi.icon} ${mi.name}</li>`);
      li.on("click", (e) => { e.stopPropagation(); menu.remove(); mi.callback(); });
      menu.append(li);
    }
    menu.css({ position: "fixed", left: event.clientX, top: event.clientY, zIndex: 99999 });
    $("body").append(menu);
    const close = (e) => { if (!$(e.target).closest(".limbus-context-menu").length) { menu.remove(); $(document).off("click", close); } };
    setTimeout(() => $(document).on("click", close), 10);
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
    { value: "addBuff",             label: "添加BUFF" },
    { value: "removeBuff",          label: "移除BUFF" },
    { value: "hpAdj",               label: "生命值调整" },
    { value: "sanityAdj",           label: "理智值调整" },
    { value: "atkAdj",              label: "攻击等级调整" },
    { value: "defAdj",              label: "防御等级调整" },
    { value: "speedAdj",            label: "速度调整" },
    { value: "baseValue",           label: "基础值" },
    { value: "diceAdj",             label: "骰数" },
    { value: "relatedSkillConvert", label: "相关技能转换" },
    { value: "seismicBlast",        label: "震颤引爆" },
  ];
}

function _buildBuffGroupOptions(cfg, selected) {
  const groups   = cfg.BUFF_GROUPS ?? {};
  const labels   = _buffLabelMap();
  const sections = [
    { label: "增益", keys: groups.positive ?? [] },
    { label: "减益", keys: groups.negative ?? [] },
    { label: "特殊", keys: groups.special ?? [] },
    { label: "其他", keys: groups.other   ?? [] },
  ];
  return sections.map(sec =>
    `<optgroup label="${sec.label}">${sec.keys.map(k =>
      `<option value="${k}" ${selected === k ? "selected" : ""}>${labels[k] ?? k}</option>`
    ).join("")}</optgroup>`
  ).join("");
}

function _buffLabelMap() {
  return {
    strong:"强壮", weak:"虚弱", endure:"忍耐", breach:"破绽",
    swift:"迅捷",  bind:"束缚", guard:"守护",  fragile:"易损",
    clashPowerUp:"拼点威力提升", clashPowerDown:"拼点威力降低",
    atkLevelUp:"攻击等级提升",   atkLevelDown:"攻击等级降低",
    defLevelUp:"防御等级提升",   defLevelDown:"防御等级降低",
    burn:"烧伤", bleed:"流血", tremor:"震颤", rupture:"破裂",
    sinking:"沉沦", breathing:"呼吸法", charge:"充能",
    chaos:"陷入混乱", panic:"陷入恐慌", custom:"自定义",
  };
}

/** 触发时机下拉（分组：物品 / 技能 / 通用） */
function _buildTriggerOpts(selected) {
  const groups = [
    { label: "── 物品 ──",  values: ["使用时"] },
    { label: "── 技能 ──",  values: ["使用时", "攻击前", "攻击时", "攻击后",
                                       "拼点时", "拼点成功", "拼点失败",
                                       "命中时", "暴击命中时"] },
    { label: "── 通用 ──",  values: ["回合开始时", "回合结束时", "受到伤害时"] },
  ];
  return groups.map(g =>
    `<optgroup label="${g.label}">${g.values.map(v =>
      `<option value="${v}" ${selected === v ? "selected" : ""}>${v}</option>`
    ).join("")}</optgroup>`
  ).join("");
}

/** 前置条件行 HTML */
function _buildCondRow(cond, idx, cfg) {
  const buffOpts = _buildBuffGroupOptions(cfg, cond?.buff);
  return `
    <div class="ae-row ae-cond-row">
      <div class="ae-row-hd">
        <span class="ae-row-num">条件 ${idx + 1}</span>
        <button type="button" class="ae-del-btn ae-del-precond">×</button>
      </div>
      <div class="ae-row-fields">
        <label>目标</label>
        <select class="ae-sel cond-target">
          <option value="self"   ${(cond?.target ?? "self") === "self"   ? "selected" : ""}>自己</option>
          <option value="target" ${cond?.target === "target" ? "selected" : ""}>目标</option>
        </select>
        <label>BUFF</label>
        <select class="ae-sel cond-buff">${buffOpts}</select>
        <label>强度≥</label>
        <input class="ae-input-sm cond-intensity" type="number" value="${cond?.intensity ?? 1}" min="0">
        <label>层数≥</label>
        <input class="ae-input-sm cond-stacks"    type="number" value="${cond?.stacks ?? 1}"    min="0">
      </div>
    </div>`;
}

/** 消耗行 HTML */
function _buildCostRow(cost, idx, cfg) {
  const buffOpts  = _buildBuffGroupOptions(cfg, cost?.buff);
  const typeOpts  = [["none","无消耗"],["forced","强制消耗"],["optional","可选消耗"]]
    .map(([v,l]) => `<option value="${v}" ${(cost?.type ?? "forced") === v ? "selected" : ""}>${l}</option>`).join("");
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
        <select class="ae-sel cost-target">
          <option value="self"   ${(cost?.target ?? "self") === "self"   ? "selected" : ""}>自己</option>
          <option value="target" ${cost?.target === "target" ? "selected" : ""}>目标</option>
        </select>
        <label>BUFF</label>
        <select class="ae-sel cost-buff">${buffOpts}</select>
        <label>强度</label>
        <input class="ae-input-sm cost-intensity" type="number" value="${cost?.intensity ?? 1}" min="0">
        <label>层数</label>
        <input class="ae-input-sm cost-stacks"    type="number" value="${cost?.stacks ?? 1}"    min="0">
      </div>
    </div>`;
}

const _BUFF_EFFECTS   = new Set(["addBuff", "removeBuff"]);
const _NOVAL_EFFECTS  = new Set(["relatedSkillConvert"]);

/** 效果行 HTML */
function _buildEffectRow(eff, idx, cfg) {
  const type     = eff?.type ?? "addBuff";
  const isBuff   = _BUFF_EFFECTS.has(type);
  const isNoVal  = _NOVAL_EFFECTS.has(type);
  const effOpts  = _activityEffectLabels()
    .map(e => `<option value="${e.value}" ${type === e.value ? "selected" : ""}>${e.label}</option>`).join("");
  const buffOpts = _buildBuffGroupOptions(cfg, eff?.buff);
  return `
    <div class="ae-row ae-eff-row">
      <div class="ae-row-hd">
        <span class="ae-row-num">效果 ${idx + 1}</span>
        <button type="button" class="ae-del-btn ae-del-effect">×</button>
      </div>
      <div class="ae-row-fields">
        <label>类型</label>
        <select class="ae-sel ae-eff-type eff-type">${effOpts}</select>
        <label>目标</label>
        <select class="ae-sel eff-target">
          <option value="self"   ${(eff?.target ?? "self") === "self"   ? "selected" : ""}>自己</option>
          <option value="target" ${eff?.target === "target" ? "selected" : ""}>目标</option>
        </select>
        <span class="ae-eff-buff-sec" ${isBuff ? "" : 'style="display:none"'}>
          <label>BUFF</label>
          <select class="ae-sel eff-buff">${buffOpts}</select>
          <label>强度</label>
          <input class="ae-input-sm eff-intensity" type="number" value="${eff?.intensity ?? 1}" min="0">
          <label>层数</label>
          <input class="ae-input-sm eff-stacks" type="number" value="${eff?.stacks ?? 1}" min="0">
        </span>
        <span class="ae-eff-val-sec" ${(!isBuff && !isNoVal) ? "" : 'style="display:none"'}>
          <label>数值</label>
          <input class="ae-input-sm eff-value" type="number" value="${eff?.value ?? 0}">
        </span>
      </div>
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
  });
  html.find(".ae-add-cost").on("click", () => {
    const list = html.find(".ae-cost-list");
    const idx  = list.find(".ae-cost-row").length;
    list.append(_buildCostRow({}, idx, cfg));
    _bindDel(html);
  });
  html.find(".ae-add-effect").on("click", () => {
    const list = html.find(".ae-effect-list");
    const idx  = list.find(".ae-eff-row").length;
    list.append(_buildEffectRow({}, idx, cfg));
    _bindDel(html);
    _bindEffType(html);
  });
  html.find(".ae-toggle-limit").on("click", () => {
    html.find(".ae-limit-body").toggle();
  });

  _bindDel(html);
  _bindEffType(html);
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
}

function _bindEffType(html) {
  html.find(".ae-eff-type").off("change").on("change", function () {
    const row    = $(this).closest(".ae-eff-row");
    const type   = $(this).val();
    const isBuff = _BUFF_EFFECTS.has(type);
    const isNoV  = _NOVAL_EFFECTS.has(type);
    row.find(".ae-eff-buff-sec").toggle(isBuff);
    row.find(".ae-eff-val-sec").toggle(!isBuff && !isNoV);
  });
}

/** 从 Dialog HTML 读取所有数据并返回 activity 对象 */
function _readActivityForm(html, original) {
  const preconditions = [];
  html.find(".ae-cond-row").each((_, el) => {
    const $r = $(el);
    preconditions.push({
      type:      "hasBuff",
      target:    $r.find(".cond-target").val()  || "self",
      buff:      $r.find(".cond-buff").val()    || "",
      intensity: parseInt($r.find(".cond-intensity").val()) || 1,
      stacks:    parseInt($r.find(".cond-stacks").val())    || 1,
    });
  });

  const costs = [];
  html.find(".ae-cost-row").each((_, el) => {
    const $r = $(el);
    costs.push({
      type:      $r.find(".cost-type").val()    || "forced",
      target:    $r.find(".cost-target").val()  || "self",
      buff:      $r.find(".cost-buff").val()    || "",
      intensity: parseInt($r.find(".cost-intensity").val()) || 1,
      stacks:    parseInt($r.find(".cost-stacks").val())    || 1,
    });
  });

  const effects = [];
  html.find(".ae-eff-row").each((_, el) => {
    const $r    = $(el);
    const type  = $r.find(".eff-type").val() || "addBuff";
    const isBuff = _BUFF_EFFECTS.has(type);
    effects.push({
      type,
      target:    $r.find(".eff-target").val()   || "self",
      buff:      isBuff ? ($r.find(".eff-buff").val() || "") : "",
      intensity: isBuff ? (parseInt($r.find(".eff-intensity").val()) || 1) : 0,
      stacks:    isBuff ? (parseInt($r.find(".eff-stacks").val())    || 1) : 0,
      value:    !isBuff ? (parseInt($r.find(".eff-value").val())     || 0) : 0,
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
