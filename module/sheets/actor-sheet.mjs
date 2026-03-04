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

export class LimbusActorSheet extends ActorSheet {

  /* ─── 默认选项 ──────────────────────────────────────────────────────────── */

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes:  ["limbuscompany", "sheet", "actor", "character"],
      width:    880,
      height:   810,
      tabs:     [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "items" }],
      dragDrop: [{ dragSelector: ".equip-slot[data-item-id], .skill-slot-wrap[data-item-id], .item-row .item-icon, .skill-row .item-icon", dropSelector: ".equip-grid, .basic-skill-slots, .ego-skill-slots, .defense-skill-slot" }],
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

    // ── 攻防总值（base + extra） ──────────────────────────────────────────
    context.atkTotal = (system.atk.base ?? 0) + (system.atk.extra ?? 0);
    context.defTotal = (system.def.base ?? 0) + (system.def.extra ?? 0);

    // ── 九宫格装备槽 ──────────────────────────────────────────────────────
    context.equipmentGrid = [];
    for (let i = 0; i < 9; i++) {
      const id   = system.equipment?.[`slot${i}`] ?? null;
      const item = id ? actor.items.get(id) : null;
      context.equipmentGrid.push({ slotIndex: i, item, itemId: id });
    }

    // ── 技能槽 ────────────────────────────────────────────────────────────
    const basicIds = system.skills?.basic ?? [null, null, null, null, null, null];
    context.basicSkills = basicIds.map((id, idx) => ({
      slotIndex: idx,
      item:      id ? actor.items.get(id) : null,
      itemId:    id ?? null,
    }));

    context.defenseSkill = {
      item:   system.skills?.defense ? actor.items.get(system.skills.defense) : null,
      itemId: system.skills?.defense ?? null,
    };

    context.egoSkills = cfg.EGO_GRADES.map(grade => ({
      grade,
      item:   system.skills?.ego?.[grade] ? actor.items.get(system.skills.ego[grade]) : null,
      itemId: system.skills?.ego?.[grade] ?? null,
    }));

    // ── 物品分组（物品 Tab） ───────────────────────────────────────────────
    context.itemGroups  = this._groupEquipmentItems();
    // ── 技能分组（技能 Tab） ───────────────────────────────────────────────
    context.skillGroups = this._groupSkillItems();

    // ── BUFF 列表（战斗 Tab） ─────────────────────────────────────────────
    context.buffs = system.buffs ?? [];
    context.buffIcons = _buildBuffIconMap();

    // ── 混乱阈值（HP条刻度） ──────────────────────────────────────────────
    context.chaosThresholds = system.chaosThresholds ?? [];

    // ── 战斗行动值显示（3枚硬币） ─────────────────────────────────────────
    context.apCoins = [0, 1, 2].map(i => ({ index: i, active: i < (system.ap.value ?? 0) }));

    // ── 本地过滤状态（不持久化） ──────────────────────────────────────────
    context.filterState = this._filterState ?? { categories: [], links: [] };

    return context;
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
    return {
      _id:         item.id,
      name:        item.name,
      img:         item.img,
      type:        item.type,
      system:      sys,
      stellarCost: item.getStellarCost?.() ?? 0,
      isEquipped:  this._isItemEquipped(item.id),
      isFavorite:  this._favorites.has(item.id),
      sinColor:    CONFIG.LIMBUSCOMPANY.SIN_COLORS?.[sys.sinType] ?? "#E8CAA2",
    };
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

    // Tab 切换到 combat → 初始化战斗槽
    html.find(".sheet-tabs .item[data-tab='combat']").on("click", () => {
      setTimeout(() => this._syncCombatSlots(html), 50);
    });

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

    // ── 战斗技能槽点击（发起对抗） ────────────────────────────────────────
    html.find(".combat-skill-slot[data-item-id]").on("click", this._onCombatSkillClick.bind(this));
    html.find(".combat-skill-related-toggle").on("click", this._onRelatedSkillToggle.bind(this));
  }

  /* ─── 拖放处理 ──────────────────────────────────────────────────────────── */

  _onDragStart(event) {
    const dragEl = event.currentTarget;
    const slotEl = dragEl?.closest?.(".equip-slot[data-item-id]");

    if (slotEl) {
      const itemId = slotEl.dataset.itemId;
      const slotIndex = Number(slotEl.dataset.slot);
      const item = this.actor.items.get(itemId);
      if (!item) return;

      const dragData = {
        type: "Item",
        uuid: item.uuid,
        fromEquipSlot: Number.isInteger(slotIndex) ? slotIndex : null,
      };
      event.dataTransfer.setData("text/plain", JSON.stringify(dragData));
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

      // 常规拖入：按装备逻辑处理（含星芒消耗）
      await this.actor.equipToGrid(owned.id, slotIdx);
      return;
    }

    // ── 拖入基础技能槽 ────────────────────────────────────────────────────
    const basicSlot = $target.closest(".basic-skill-slots");
    if (basicSlot.length && item.type === "skill" && item.system.type === "basic") {
      const owned = ownedItem ?? await this._importItemToActor(item);
      if (owned) await this.actor.equipSkill(owned.id);
      return;
    }

    // ── 拖入 EGO 槽 ───────────────────────────────────────────────────────
    const egoSlot = $target.closest(".ego-skill-slot-wrap");
    if (egoSlot.length && item.type === "skill" && item.system.type === "ego") {
      const owned = ownedItem ?? await this._importItemToActor(item);
      if (owned) await this.actor.equipSkill(owned.id);
      return;
    }

    // ── 拖入守备槽 ────────────────────────────────────────────────────────
    const defSlot = $target.closest(".defense-skill-slot");
    if (defSlot.length && item.type === "skill" && item.system.type === "defense") {
      const owned = ownedItem ?? await this._importItemToActor(item);
      if (owned) await this.actor.equipSkill(owned.id);
      return;
    }

    // ── 从装备栏拖到其他区域：视为卸下（源槽清空） ───────────────────────
    const fromSlot = Number.isInteger(data.fromEquipSlot) ? data.fromEquipSlot : parseInt(data.fromEquipSlot);
    if (Number.isInteger(fromSlot) && fromSlot >= 0 && fromSlot <= 8) {
      await this.actor.unequipFromGrid(fromSlot);
      return;
    }

    // ── 默认：添加物品到 actor ────────────────────────────────────────────
    if (!ownedItem) {
      await this._importItemToActor(item);
    }
  }

  async _importItemToActor(item) {
    const created = await Item.create(item.toObject(), { parent: this.actor });
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

            const coinHtml = Array.from({ length: coins }, (_, i) => {
              const isFace = i < headCount;
              const src = isFace
                ? "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_正面.webp"
                : "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_反面.webp";
              return `<img src="${src}" width="24" height="24" alt="coin">`;
            }).join("");

            ChatMessage.create({
              speaker: ChatMessage.getSpeaker({ actor: this.actor }),
              content: `
              <div class="limbuscompany-card ${resultClass}">
                <div class="card-title">${label}鉴定结果</div>
                <div class="card-body">
                  <div>难度等级 ${difficulty}</div>
                  <div class="result-text">${resultText}</div>
                  <div class="coin-result-row">${coinHtml}</div>
                </div>
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

  async _showClashDialog(item) {
    const sys    = item.system;
    const formula = sys.diceFormula ?? "1d4";
    const content = `
      <div class="limbuscompany clash-dialog">
        <div class="clash-skill-info">
          <strong>${item.name}</strong>
          <span class="clash-formula">${formula.toUpperCase()}</span>
        </div>
        <div class="form-group">
          <label>加值修正</label>
          <input type="text" name="bonus" placeholder="加值修正?" style="width:100px"/>
        </div>
      </div>`;

    new Dialog({
      title: "发起对抗",
      content,
      buttons: {
        clash: {
          label: "发起对抗",
          callback: async (html) => {
            const bonusStr = html.find("[name='bonus']").val()?.trim() || "";
            const bonus    = parseInt(bonusStr) || 0;
            const fullFormula = bonus !== 0 ? `${formula}${bonus >= 0 ? "+" : ""}${bonus}` : formula;

            // 滚动骰子
            const roll = new Roll(fullFormula);
            await roll.evaluate();

            ChatMessage.create({
              speaker: ChatMessage.getSpeaker({ actor: this.actor }),
              content: `
              <div class="limbuscompany clash-card">
                <div class="clash-header">发起对抗</div>
                <div class="card-body">
                  <div class="clash-vs-row">
                    <div class="skill-slot">
                      <img src="${item.img}" width="56" height="56" style="clip-path:polygon(25% 0%,75% 0%,100% 25%,100% 75%,75% 100%,25% 100%,0% 75%,0% 25%);border-radius:0;" alt="${item.name}">
                    </div>
                    <div>
                      <div style="font-size:1rem;font-weight:bold;">${item.name}</div>
                      <div style="color:var(--text-sub)">${fullFormula.toUpperCase()}</div>
                    </div>
                  </div>
                  <div class="clash-action-btns" data-item-id="${item.id}" data-roll-total="${roll.total}" data-formula="${fullFormula}">
                    <button class="clash-action-btn" data-action="clash">对抗</button>
                    <button class="clash-action-btn danger" data-action="take">承受</button>
                  </div>
                </div>
              </div>`,
              flags: { limbusCompany_FVTT: { type: "clash-initiate", attackerId: this.actor.id, itemId: item.id, rollTotal: roll.total } },
            });
          },
        },
      },
      default: "clash",
    }).render(true);
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
    this._syncCombatSlots(this.element);
  }

  _onCombatClear(event) {
    this._combatBagState = null;
    this._renderCombatSlots(this.element);
  }

  _syncCombatSlots(html) {
    if (!this._combatBagState) {
      // 初始化 6-bag：从已装备的基础技能构建
      const basicIds = (this.actor.system.skills?.basic ?? []).filter(Boolean);
      this._combatBagState = {
        bag:     [...basicIds],          // 剩余可抽取
        active:  [basicIds[0] ?? null, basicIds[1] ?? null],
        reserve: basicIds[2] ?? null,
        used:    [],
      };
    }
    this._renderCombatSlots(html);
  }

  _renderCombatSlots(html) {
    const state = this._combatBagState;
    if (!state) return;

    const slots = html.find(".combat-skill-slot");
    slots.each((i, el) => {
      const $el  = $(el);
      const id   = state.active[i] ?? null;
      const item = id ? this.actor.items.get(id) : null;

      $el.find("img").attr("src", item ? item.img : "systems/limbusCompany_FVTT/assets/icons/Skill/Normalsin.webp");
      $el.data("item-id", id ?? "").attr("data-item-id", id ?? "");

      // 状态样式
      $el.removeClass("slot-active slot-reserve slot-empty");
      if (i < 2 && id) $el.addClass("slot-active");
      else              $el.addClass("slot-empty");
    });

    // 预备槽
    const reserveEl = html.find(".combat-reserve-slot");
    const resItem   = state.reserve ? this.actor.items.get(state.reserve) : null;
    reserveEl.find("img").attr("src", resItem?.img ?? "systems/limbusCompany_FVTT/assets/icons/Skill/Normalsin.webp");
  }

  _onCombatSkillClick(event) {
    const itemId = event.currentTarget.dataset.itemId;
    if (!itemId) return;
    const item = this.actor.items.get(itemId);
    if (!item) return;
    this._showClashDialog(item);
  }

  _onRelatedSkillToggle(event) {
    // 切换相关技能
    const wrap = $(event.currentTarget).closest(".combat-skill-slot-wrap");
    wrap.find(".related-indicator").toggleClass("active");
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
    ui.notifications.info(`触发 【${buff.name}】 强度:${buff.intensity} 层数:${buff.stacks}`);
    // 实际触发逻辑在 helpers/buff.mjs 阶段实现
  }

  async _onBuffDelete(event) {
    const buffId = event.currentTarget.closest("[data-buff-id]")?.dataset.buffId;
    await this.actor.removeBuff(buffId);
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
          <span class="tc-tags">${(sys.tags ?? "").split("/").filter(Boolean).map(t => `<span class="tag">${t.trim()}</span>`).join("")}</span>
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
  const base = "systems/limbusCompany_FVTT/assets/icons/Base_icon/";
  const map  = {
    slash:"Slash.webp", blunt:"Blunt.webp", pierce:"Pierce.webp",
    dodge:"闪避.webp",  block:"防御.webp",  counter:"反击.webp",
    clashBlock:"可拼点防御.webp", clashCounter:"可拼点防御.webp",
  };
  return map[category] ? base + map[category] : "";
}

function _subtypeLabel(subtype) {
  return { weapon:"武器", upper:"上装", lower:"下装", accessory:"饰品",
           consumable:"消耗品", material:"材料", container:"容器" }[subtype] ?? subtype;
}
