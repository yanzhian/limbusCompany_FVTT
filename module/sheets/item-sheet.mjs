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
      height:   760,
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
      context.isBasic   = sys.type === "basic";
      context.isDefense = sys.type === "defense";
      context.isEgo     = sys.type === "ego";

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
      if (context.isEgo) {
        context.sinCosts = _parseSinCosts(sys.sinCost ?? []);
        context.egoResChanges = _parseResistanceChanges(sys.egoResistanceChange ?? []);
      }

      // 攻击/守备类别选项
      context.attackCategories  = cfg.ATTACK_CATEGORIES;
      context.defenseCategories = cfg.DEFENSE_CATEGORIES;
      context.skillSinTypes     = cfg.SIN_LABELS ?? {};

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
      context.resistanceValues = cfg.RESISTANCE_VALUES ?? ["x0.5", "x1.0", "x2.0"];
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
        if (changedResKey && key !== changedResKey) {
          expanded.system.resistanceAdj[key] = currentRes[key] ?? "x1.0";
          continue;
        }

        if (nextRes === undefined || nextRes === "") {
          expanded.system.resistanceAdj[key] = currentRes[key] ?? "x1.0";
          continue;
        }
        if (!validResists.includes(nextRes)) {
          expanded.system.resistanceAdj[key] = currentRes[key] ?? "x1.0";
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
      id:      foundry.utils.randomID(),
      name:    "新效果",
      trigger: "攻击时",
      precondition: null,
      cost:         null,
      effect: { type: "addBuff", target: "self", intensity: 1, stacks: 1 },
      limit:  { type: "unlimited", count: 0 },
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

    // 构建触发时机选项
    const triggerOpts = (cfg.ACTIVITY_TRIGGERS ?? [])
      .map(t => `<option value="${t}" ${act.trigger === t ? "selected" : ""}>${t}</option>`)
      .join("");

    // 构建效果类型选项
    const effectLabels = _activityEffectLabels();
    const effectOpts   = effectLabels
      .map(e => `<option value="${e.value}" ${act.effect?.type === e.value ? "selected" : ""}>${e.label}</option>`)
      .join("");

    // 构建 BUFF 选项
    const buffOpts = _buildBuffGroupOptions(cfg, act.effect?.buff);

    const preJson  = act.precondition ? JSON.stringify(act.precondition, null, 2) : "";
    const costJson = act.cost         ? JSON.stringify(act.cost, null, 2)         : "";

    const content = `
      <div class="limbuscompany activity-editor-dialog">
        <div class="form-group">
          <label>名称</label>
          <input type="text" name="name" value="${act.name ?? ""}" placeholder="输入本文"/>
        </div>
        <div class="form-group">
          <label>触发时机</label>
          <select name="trigger">${triggerOpts}</select>
        </div>
        <hr/>
        <div class="form-group">
          <label>效果类型</label>
          <select name="effectType">${effectOpts}</select>
        </div>
        <div class="form-group">
          <label>目标</label>
          <select name="effectTarget">
            <option value="self"   ${act.effect?.target === "self"   ? "selected" : ""}>自己</option>
            <option value="target" ${act.effect?.target === "target" ? "selected" : ""}>目标</option>
          </select>
        </div>
        <div class="form-group ae-buff-row">
          <label>选择BUFF</label>
          <select name="effectBuff">${buffOpts}</select>
        </div>
        <div class="form-group ae-buff-custom" style="display:none">
          <label>自定义BUFF</label>
          <input type="text" name="buffCustom" value="${act.effect?.buffCustom ?? ""}" placeholder="输入文本"/>
        </div>
        <div class="form-group inline-row">
          <label>强度</label><input type="number" name="intensity" value="${act.effect?.intensity ?? 1}" style="width:60px"/>
          <label style="margin-left:8px">层数</label><input type="number" name="stacks" value="${act.effect?.stacks ?? 1}" style="width:60px"/>
        </div>
        <div class="form-group">
          <label>次数限制 (0=不限)</label>
          <input type="number" name="limitCount" value="${act.limit?.count ?? 0}" style="width:60px"/>
        </div>
      </div>`;

    new Dialog({
      title: "效果触发-编辑器",
      content,
      buttons: {
        save: {
          label: "保存",
          callback: async (html) => {
            acts[idx] = {
              ...act,
              name:    html.find("[name='name']").val(),
              trigger: html.find("[name='trigger']").val(),
              effect: {
                type:        html.find("[name='effectType']").val(),
                target:      html.find("[name='effectTarget']").val(),
                buff:        html.find("[name='effectBuff']").val(),
                buffCustom:  html.find("[name='buffCustom']").val(),
                intensity:   parseInt(html.find("[name='intensity']").val()) || 1,
                stacks:      parseInt(html.find("[name='stacks']").val())    || 1,
              },
              limit: {
                type:  html.find("[name='limitCount']").val() === "0" ? "unlimited" : "perTurn",
                count: parseInt(html.find("[name='limitCount']").val()) || 0,
              },
            };
            await this.item.update({ "system.activities": acts });
          },
        },
        cancel: { label: "取消编辑" },
      },
      default: "save",
    }).render(true);
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
    costs.push({ sin: "wrath", amount: 1 });
    await this.item.update({ "system.sinCost": costs });
  }

  async _onSinCostRemove(event) {
    const idx   = parseInt(event.currentTarget.dataset.idx ?? -1);
    const costs = foundry.utils.deepClone(this.item.system.sinCost ?? []);
    if (idx >= 0) { costs.splice(idx, 1); await this.item.update({ "system.sinCost": costs }); }
  }

  async _onResChangeAdd(event) {
    const changes = foundry.utils.deepClone(this.item.system.egoResistanceChange ?? []);
    changes.push({ sin: "wrath", value: "x1.0" });
    await this.item.update({ "system.egoResistanceChange": changes });
  }

  async _onResChangeRemove(event) {
    const idx     = parseInt(event.currentTarget.dataset.idx ?? -1);
    const changes = foundry.utils.deepClone(this.item.system.egoResistanceChange ?? []);
    if (idx >= 0) { changes.splice(idx, 1); await this.item.update({ "system.egoResistanceChange": changes }); }
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

function _getCategoryIcon(category) {
  const base = "systems/limbusCompany_FVTT/assets/icons/Base_icon/";
  const map  = {
    slash:"Slash.webp", blunt:"Blunt.webp", pierce:"Pierce.webp",
    dodge:"闪避.webp",  block:"防御.webp",  counter:"反击.webp",
    clashBlock:"可拼点防御.webp", clashCounter:"可拼点防御.webp",
  };
  return map[category] ? base + map[category] : "";
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

function _activityEffectLabels() {
  return [
    { value: "addBuff",           label: "添加BUFF" },
    { value: "removeBuff",        label: "移除BUFF" },
    { value: "hpAdj",             label: "生命值调整" },
    { value: "sanityAdj",         label: "理智值调整" },
    { value: "atkAdj",            label: "攻击等级调整" },
    { value: "defAdj",            label: "防御等级调整" },
    { value: "speedAdj",          label: "速度调整" },
    { value: "baseValue",         label: "基础值" },
    { value: "diceAdj",           label: "骰数" },
    { value: "relatedSkillConvert", label: "相关技能转换" },
    { value: "seismicBlast",      label: "震颤引爆" },
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
