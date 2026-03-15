/**
 * quick-action-hud.mjs — 快捷操作 HUD
 *
 * 仅当选中恰好一个 character 类型的 Token 时显示。
 * 与角色卡双向同步：读取 actor.system 数据，写入通过 actor.update()。
 *
 * 提供快捷访问：
 *   - 行动值（AP）硬币（点击切换）
 *   - 角色头像（单击折叠面板，双击打开角色卡，拖动移动 HUD）
 *   - 消耗品 / 装备 / 基础技能 / EGO技能 展开面板
 *   - HP 球 / 状态栏 / 理智球
 */

import { ClashManager } from "../helpers/clash.mjs";

/* ─── 常量 ────────────────────────────────────────────────────────────────── */

const BUFF_ICON_BASE = "systems/limbusCompany_FVTT/assets/icons/Buff_icon/";
const BUFF_ICON_MAP  = {
  strong:        "强壮.webp",        weak:          "虚弱.webp",
  endure:        "忍耐.webp",        breach:        "破绽.webp",
  swift:         "迅捷.webp",        bind:          "束缚.webp",
  guard:         "守护.webp",        fragile:       "易损.webp",
  clashPowerUp:  "拼点威力提升.webp", clashPowerDown:"拼点威力降低.webp",
  atkLevelUp:    "攻击等级提升.webp", atkLevelDown:  "攻击等级降低.webp",
  defLevelUp:    "防御等级提升.webp", defLevelDown:  "防御等级降低.webp",
  burn:          "烧伤.webp",        bleed:         "流血.webp",
  tremor:        "震颤.webp",        rupture:       "破裂.webp",
  sinking:       "沉沦.webp",        breathing:     "呼吸法.webp",
  charge:        "充能.webp",        chaos:         "陷入混乱.webp",
  panic:         "陷入恐慌.webp",
};

function _buffIcon(type, fallback = "") {
  return BUFF_ICON_MAP[type] ? (BUFF_ICON_BASE + BUFF_ICON_MAP[type]) : (fallback || "");
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
  return _buffIcon(type, "");
}

/* ═══════════════════════════════════════════════════════════════════════════
   QuickActionHUD Application
═══════════════════════════════════════════════════════════════════════════ */

export class QuickActionHUD extends Application {

  /** 单例引用 */
  static instance = null;

  /** 当前追踪的角色（选中 token 绑定的 actor） */
  _actor = null;

  /** 当前展开的面板集合（"consumable" | "equipment" | "basic" | "ego"） */
  _openPanels = new Set();

  /* ─── 默认选项 ─────────────────────────────────────────────────────────── */

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:          "limbus-quick-action-hud",
      template:    "systems/limbusCompany_FVTT/templates/quick-action-hud.hbs",
      classes:     ["limbus-qa-hud"],
      popOut:      false,
      resizable:   false,
      minimizable: false,
    });
  }

  /* ─── 初始化 & 单例管理 ─────────────────────────────────────────────────── */

  static create() {
    if (QuickActionHUD.instance) return;
    QuickActionHUD.instance = new QuickActionHUD();
    // 等待 token 选中后才渲染
  }

  /* ─── Token 控制变化回调 ────────────────────────────────────────────────── */

  static onControlToken() {
    const hud = QuickActionHUD.instance;
    if (!hud) return;

    const controlled = canvas.tokens?.controlled ?? [];
    if (controlled.length !== 1) {
      hud._hide();
      return;
    }

    const actor = controlled[0].actor;
    if (!actor || actor.type !== "character") {
      hud._hide();
      return;
    }

    const sameActor = hud._actor?.id === actor.id;
    hud._actor = actor;
    if (!sameActor) hud._openPanels.clear();
    hud.render(true);
  }

  /* ─── Actor 数据变化回调（用于双向同步） ─────────────────────────────────── */

  static onActorUpdate(actor) {
    const hud = QuickActionHUD.instance;
    if (!hud || !hud._actor) return;
    if (hud._actor.id === actor.id) hud.render(false);
  }

  /* ─── 隐藏 HUD ──────────────────────────────────────────────────────────── */

  _hide() {
    $(`#${this.id}`).remove();
    this._element = null;
    this._actor   = null;
    this._openPanels.clear();
  }

  /* ─── 位置持久化 ─────────────────────────────────────────────────────────── */

  _saveCurrentPosition() {
    const el = $(`#${this.id}`);
    if (!el.length) return;
    const left = parseInt(el.css("left"));
    const top  = parseInt(el.css("top"));
    if (!isNaN(left)) this._savedLeft = left;
    if (!isNaN(top))  this._savedTop  = top;
  }

  _applyPosition(html) {
    if (this._savedLeft != null) {
      html.css({ left: this._savedLeft, top: this._savedTop });
    } else {
      // 默认位置：画布下方居中
      html.css({
        left: Math.max(0, Math.floor((window.innerWidth - 560) / 2)),
        top:  Math.max(0, window.innerHeight - 230),
      });
    }
  }

  /* ─── 渲染挂钩（非弹出式 Application 必须覆写） ─────────────────────────── */

  async _injectHTML(html) {
    this._saveCurrentPosition();
    $(`#${this.id}`).remove();
    $("body.game").append(html);
    this._element = html;
    this._applyPosition(html);
    this._restorePanels(html);
  }

  async _replaceHTML(element, html) {
    this._saveCurrentPosition();
    element.replaceWith(html);
    this._element = html;
    this._applyPosition(html);
    this._restorePanels(html);
  }

  /** 重渲后恢复已展开面板的显示状态和按钮高亮 */
  _restorePanels(html) {
    this._openPanels.forEach(p => {
      html.find(`.qa-panel[data-panel="${p}"]`).css("display", "flex");
      html.find(`.qa-btn[data-panel="${p}"]`).addClass("qa-btn--active");
    });
    this._syncEgoRelatedHud(html);
  }

  /** 恢复 EGO 相关技能切换按钮状态，恐慌时自动激活侵蚀形态 */
  _syncEgoRelatedHud(html) {
    if (!this._actor) return;
    if (!this._egoRelatedHudMode) this._egoRelatedHudMode = {};

    const sys      = this._actor.system;
    const cfg      = CONFIG.LIMBUSCOMPANY ?? {};
    const hasPanic = (sys.buffs ?? []).some(b => b.type === "panic" && b.whenAdded !== "下回合");

    // 恐慌时自动激活有侵蚀形态的 EGO 槽
    if (hasPanic) {
      for (const grade of (cfg.EGO_GRADES ?? [])) {
        const itemId  = sys.skills?.ego?.[grade];
        if (!itemId) continue;
        const egoItem = this._actor.items.get(itemId);
        if (egoItem?.system?.relatedSkill?.erodeUuid) {
          this._egoRelatedHudMode[itemId] = true;
        }
      }
    }

    // 将状态应用到 DOM
    for (const [itemId, isRelated] of Object.entries(this._egoRelatedHudMode)) {
      if (!isRelated) continue;
      const $btn  = html.find(`.qa-ego-related-toggle[data-item-id="${itemId}"]`);
      const $slot = html.find(`.qa-ego-skill-slot[data-item-id="${itemId}"] img`);
      $btn.addClass("related-active");
      const mainItem = this._actor.items.get(itemId);
      if (!mainItem) continue;
      const uuid = (hasPanic && mainItem.system?.relatedSkill?.erodeUuid)
        ? mainItem.system.relatedSkill.erodeUuid
        : mainItem.system?.relatedSkill?.itemUuid;
      const relItem = uuid && typeof fromUuidSync !== "undefined" ? fromUuidSync(uuid) : null;
      if (relItem) $slot.attr("src", relItem.img ?? "");
    }
  }

  /* ─── 数据准备 ───────────────────────────────────────────────────────────── */

  async getData() {
    const actor = this._actor;
    if (!actor) return {};

    const sys = actor.system;
    const cfg = CONFIG.LIMBUSCOMPANY ?? {};

    // AP 硬币
    const apCoins = [0, 1, 2].map(i => ({
      index:  i,
      active: i < (sys.ap?.value ?? 0),
    }));

    // 状态 BUFF：仅显示本回合有效的（排除"下回合"）
    const activeBuffs = (sys.buffs ?? []).filter(b => b.whenAdded !== "下回合");
    // 补齐至 8 的整数倍，最少 8 格
    const slotCount = Math.max(8, Math.ceil(activeBuffs.length / 8) * 8);
    const buffSlots = Array.from({ length: slotCount }, (_, i) => {
      const buff = activeBuffs[i] ?? null;
      return { index: i, buff, icon: buff ? _buffIcon(buff.type, buff.icon) : "" };
    });

    // 装备格物品（排除空格）
    const equipmentItems = Object.values(sys.equipment ?? {})
      .map(id => (id ? actor.items.get(id) : null))
      .filter(Boolean);

    // 消耗品
    const consumableItems = actor.items.filter(i => i.type === "consumable");

    // 基础技能：取战斗袋前3槽（若无则取已装备前3）
    const bagState    = actor.sheet?._combatBagState;
    const basicSlotIds = bagState
      ? [bagState.slots[0], bagState.slots[1], bagState.slots[2]]
      : (sys.skills?.basic ?? []).slice(0, 3);
    const basicSkills = basicSlotIds.map((id, i) => {
      const item = id ? actor.items.get(id) : null;
      return {
        slotIndex: i,
        item,
        sinColor:  item ? (cfg.SIN_COLORS?.[item.system?.sinType] ?? "#C9A84C") : "#443322",
        isActive:  i < 2,   // 0,1 = 激活中（金色边框），2 = 预备（红色边框）
      };
    });

    // EGO 技能
    const egoSkills = (cfg.EGO_GRADES ?? []).map(grade => {
      const itemId = sys.skills?.ego?.[grade] ?? null;
      const item   = itemId ? actor.items.get(itemId) : null;
      return {
        grade,
        item,
        sinColor:   item ? (cfg.SIN_COLORS?.[item.system?.sinType] ?? "#443322") : "#443322",
        hasRelated: !!(item?.system?.relatedSkill?.itemUuid),
      };
    });

    return {
      actorImg:       actor.img  ?? "icons/svg/mystery-man.svg",
      actorName:      actor.name ?? "",
      apCoins,
      hpValue:        sys.hp?.value     ?? 0,
      sanValue:       sys.sanity?.value ?? 50,
      buffSlots,
      equipmentItems,
      consumableItems,
      basicSkills,
      egoSkills,
    };
  }

  async close(options = {}) {
    this._onHudItemHoverEnd();
    return super.close(options);
  }

  /* ─── 事件监听 ───────────────────────────────────────────────────────────── */

  activateListeners(html) {
    super.activateListeners(html);

    // ── AP 硬币点击（与角色卡逻辑一致） ──────────────────────────────────
    html.find(".qa-ap-coin").on("click", async (e) => {
      if (!this._actor) return;
      const idx    = parseInt(e.currentTarget.dataset.index);
      const cur    = this._actor.system.ap.value;
      const newVal = idx < cur ? idx : idx + 1;
      await this._actor.update({ "system.ap.value": Math.min(3, Math.max(0, newVal)) });
    });

    // ── 面板展开/折叠按钮 ─────────────────────────────────────────────────
    html.find(".qa-btn[data-panel]").on("click", (e) => {
      const panelKey = e.currentTarget.dataset.panel;
      if (!panelKey) return;
      const $panel = html.find(`.qa-panel[data-panel="${panelKey}"]`);
      const $btn   = $(e.currentTarget);
      if (this._openPanels.has(panelKey)) {
        this._openPanels.delete(panelKey);
        $panel.hide();
        $btn.removeClass("qa-btn--active");
      } else {
        this._openPanels.add(panelKey);
        $panel.css("display", "flex");
        $btn.addClass("qa-btn--active");
      }
    });

    // ── 头像交互 ─────────────────────────────────────────────────────────
    // 单击折叠所有已开面板；双击打开角色卡；拖动移动 HUD
    let _clickTimer = null;

    html.find(".qa-avatar").on("click", (e) => {
      if (_clickTimer) return;   // 等待双击判定
      _clickTimer = setTimeout(() => {
        _clickTimer = null;
        if (this._dragging) return;   // 拖动后不触发单击
        // 有面板开着 → 全部关闭；全关着 → 不做操作
        if (this._openPanels.size > 0) {
          this._openPanels.clear();
          html.find(".qa-panel").hide();
          html.find(".qa-btn[data-panel]").removeClass("qa-btn--active");
        }
      }, 220);
    });

    html.find(".qa-avatar").on("dblclick", () => {
      clearTimeout(_clickTimer);
      _clickTimer = null;
      this._actor?.sheet?.render(true);
    });

    // ── 拖动（按住头像拖动整个 HUD） ──────────────────────────────────────
    let dragStartX = 0, dragStartY = 0, originLeft = 0, originTop = 0;

    const onMouseMove = (e) => {
      if (!this._dragging) return;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - html.outerWidth(),  originLeft + e.clientX - dragStartX));
      const newTop  = Math.max(0, Math.min(window.innerHeight - html.outerHeight(), originTop  + e.clientY - dragStartY));
      this._savedLeft = newLeft;
      this._savedTop  = newTop;
      html.css({ left: newLeft, top: newTop });
    };

    const onMouseUp = () => {
      this._dragging = false;
      $(document).off("mousemove.qahud mouseup.qahud");
    };

    html.find(".qa-avatar").on("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      originLeft = parseInt(html.css("left")) || 0;
      originTop  = parseInt(html.css("top"))  || 0;
      this._dragging = false;   // 仅 mousemove 触发后才标为拖动
      const onFirstMove = () => {
        this._dragging = true;
        $(document).off("mousemove.qahud_init");
      };
      $(document)
        .on("mousemove.qahud_init", onFirstMove)
        .on("mousemove.qahud", onMouseMove)
        .on("mouseup.qahud",   onMouseUp);
    });

    // ── 状态栏：空格 → 添加 BUFF；有 BUFF 格 → 打开角色卡战斗页 ─────────
    html.find(".qa-buff-slot--empty").on("click", () => this._showAddBuffDialog());
    html.find(".qa-buff-slot--filled").on("click", () => this._openCombatTab());

    // ── HP / 理智球点击：打开角色卡 ──────────────────────────────────────
    html.find(".qa-hp-ball, .qa-san-ball").on("click", () => this._actor?.sheet?.render(true));

    // ── 装备激活 ──────────────────────────────────────────────────────────
    html.find(".qa-equip-activate").on("click", async (e) => {
      e.stopPropagation();
      const itemId = e.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      const item   = this._actor?.items.get(itemId);
      if (!item) return;
      await this._activateItem(item);
    });

    // ── 消耗品激活 ────────────────────────────────────────────────────────
    html.find(".qa-consumable-activate").on("click", async (e) => {
      e.stopPropagation();
      const itemId = e.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      const item   = this._actor?.items.get(itemId);
      if (!item) return;
      await this._activateItem(item);
    });

    // ── 基础技能槽点击 → 发起对抗（与角色卡战斗Tab 逻辑一致） ────────────
    html.find(".qa-basic-skill-slot[data-item-id]").on("click", async (e) => {
      const itemId    = e.currentTarget.dataset.itemId;
      const slotIndex = parseInt(e.currentTarget.dataset.slotIndex ?? "-1");
      if (!itemId || !this._actor) return;
      const item = this._actor.items.get(itemId);
      if (!item) return;

      // 只有激活槽（0, 1）可以发起对抗，预备槽（2）不可点击
      if (slotIndex > 1) {
        ui.notifications.warn("只有激活槽中的技能可以发起对抗");
        return;
      }

      if ((this._actor.system.ap?.value ?? 0) <= 0) {
        ui.notifications.warn("行动值不足，无法发起对抗");
        return;
      }

      // 确保战斗袋已初始化
      this._ensureBagState();

      // 记录 sheet 是否已渲染（用于判断是否需要手动推进袋）
      const sheetRendered = !!(this._actor.sheet?.rendered && this._actor.sheet?.element?.length);

      // 传入真实 slotIndex，ClashManager 会调用 sheet._animateCombatSkillUse(slotIndex)
      await ClashManager.showInitiateDialog(this._actor, item, slotIndex);

      // 若 sheet 未渲染（_animateCombatSkillUse 提前 return），手动推进袋状态
      if (!sheetRendered) {
        this._advanceBagStateManually(slotIndex);
      }

      // 在袋状态更新后重渲 HUD（有动画时等 400ms，无动画时稍微延迟）
      setTimeout(() => this.render(false), sheetRendered ? 420 : 60);
    });

    // ── EGO 技能槽点击 → 发起对抗 ────────────────────────────────────────
    html.find(".qa-ego-skill-slot[data-item-id]").on("click", async (e) => {
      const itemId = e.currentTarget.dataset.itemId;
      if (!itemId || !this._actor) return;
      let item = this._actor.items.get(itemId);
      if (!item) return;

      // 若处于相关技能模式，使用相关技能（恐慌时用侵蚀形态）
      if (this._egoRelatedHudMode?.[itemId]) {
        const hasPanic = (this._actor.system.buffs ?? []).some(
          b => b.type === "panic" && b.whenAdded !== "下回合"
        );
        const uuid = (hasPanic && item.system?.relatedSkill?.erodeUuid)
          ? item.system.relatedSkill.erodeUuid
          : item.system?.relatedSkill?.itemUuid;
        if (uuid) {
          const relItem = typeof fromUuidSync !== "undefined" ? fromUuidSync(uuid) : null;
          if (relItem) item = relItem;
        }
      }
      await ClashManager.showInitiateDialog(this._actor, item, -2);
    });

    // ── EGO 相关技能切换按钮 ────────────────────────────────────────────
    html.find(".qa-ego-related-toggle").on("click", (e) => {
      e.stopPropagation();
      const itemId = e.currentTarget.dataset.itemId;
      if (!itemId || !this._actor) return;
      if (!this._egoRelatedHudMode) this._egoRelatedHudMode = {};

      const isNowRelated = !this._egoRelatedHudMode[itemId];
      this._egoRelatedHudMode[itemId] = isNowRelated;
      $(e.currentTarget).toggleClass("related-active", isNowRelated);

      // 同步到角色卡 sheet 状态
      const sheet = this._actor.sheet;
      if (sheet) {
        if (!sheet._egoRelatedMode) sheet._egoRelatedMode = {};
        sheet._egoRelatedMode[itemId] = isNowRelated;
      }

      // 更新 EGO 槽图片
      const mainItem = this._actor.items.get(itemId);
      if (!mainItem) return;
      const hasPanic = (this._actor.system.buffs ?? []).some(
        b => b.type === "panic" && b.whenAdded !== "下回合"
      );
      const $slot = html.find(`.qa-ego-skill-slot[data-item-id="${itemId}"] img`);
      if (isNowRelated) {
        const uuid = (hasPanic && mainItem.system?.relatedSkill?.erodeUuid)
          ? mainItem.system.relatedSkill.erodeUuid
          : mainItem.system?.relatedSkill?.itemUuid;
        const relItem = uuid && typeof fromUuidSync !== "undefined" ? fromUuidSync(uuid) : null;
        if (relItem) $slot.attr("src", relItem.img ?? "");
      } else {
        $slot.attr("src", mainItem.img ?? "");
      }
    });

    // ── 技能 / 物品悬浮 Title 卡（与角色卡一致） ──────────────────────────
    const hoverTargets = [
      ".qa-basic-skill-slot[data-item-id]",
      ".qa-ego-skill-slot[data-item-id]",
      ".qa-panel-item[data-item-id]",
    ].join(", ");

    html.find(hoverTargets)
      .on("mouseenter", (e) => this._onHudItemHover(e))
      .on("mouseleave", () => this._onHudItemHoverEnd());
  }

  /* ─── 内部辅助 ───────────────────────────────────────────────────────────── */

  /** 激活物品（触发 [使用时]；消耗品数量 -1 / 归零删除） */
  async _activateItem(item) {
    await ClashManager._applyActivities(item, "使用时", {
      owner: this._actor, atkActor: this._actor, defActor: null, _fireCounts: {},
    });
    if (item.type === "consumable") {
      const qty = (item.system.quantity ?? 1) - 1;
      if (qty <= 0) await item.delete();
      else          await item.update({ "system.quantity": qty });
    }
  }

  /** HUD 物品/技能悬浮 → 显示与角色卡完全相同的 Title 卡 */
  _onHudItemHover(event) {
    const el     = event.currentTarget;
    const itemId = el.dataset.itemId;
    if (!itemId || !this._actor) return;

    const item   = this._actor.items.get(itemId);
    if (!item) return;

    const sheet  = this._actor.sheet;
    if (!sheet?._buildTitleCard) return;

    this._onHudItemHoverEnd();
    this._hudTitleCard = sheet._buildTitleCard(item);

    // HUD 尺寸较小，优先显示在 HUD 左侧；空间不足则显示在右侧
    const hudEl  = this.element?.[0];
    const rect   = hudEl ? hudEl.getBoundingClientRect() : el.getBoundingClientRect();
    const cardW  = 280;
    const cardH  = 500;
    let   left   = rect.left - cardW - 8;
    if (left < 8) left = rect.right + 8;
    const top    = Math.max(8, Math.min(rect.top, window.innerHeight - cardH - 8));

    this._hudTitleCard.css({ position: "fixed", left, top, zIndex: 99999 });
    $("body").append(this._hudTitleCard);

    // 允许鼠标在图标上滚动时滚动描述区
    this._hudTitleCardWheelEl = el;
    this._hudTitleCardWheelHandler = (ev) => {
      const desc = this._hudTitleCard?.find(".tc-desc, .tce-desc")[0];
      if (!desc || desc.scrollHeight <= desc.clientHeight) return;
      desc.scrollTop += ev.deltaY;
      ev.preventDefault();
    };
    el.addEventListener("wheel", this._hudTitleCardWheelHandler, { passive: false });
  }

  _onHudItemHoverEnd() {
    if (this._hudTitleCardWheelEl && this._hudTitleCardWheelHandler) {
      this._hudTitleCardWheelEl.removeEventListener("wheel", this._hudTitleCardWheelHandler);
    }
    this._hudTitleCardWheelEl = null;
    this._hudTitleCardWheelHandler = null;
    this._hudTitleCard?.remove();
    this._hudTitleCard = null;
  }

  /**
   * 确保战斗袋状态已初始化（与 actor-sheet._syncCombatSlots 初始化逻辑一致）。
   * 若 bag state 已存在则跳过。
   */
  _ensureBagState() {
    const actor = this._actor;
    if (!actor?.sheet) return;
    if (actor.sheet._combatBagState) return;  // 已存在，不重新初始化

    const basicIds = (actor.system.skills?.basic ?? []).filter(Boolean);
    if (!basicIds.length) return;

    const bag1 = [...basicIds].sort(() => Math.random() - 0.5);
    const bag2 = [...basicIds].sort(() => Math.random() - 0.5);
    actor.sheet._combatBagState = {
      equipped:    basicIds,
      slots:       bag1.slice(0, 6),
      pool:        bag2,
      relatedMode: {},
    };
  }

  /**
   * 手动推进战斗袋（当角色卡 sheet 未渲染、_animateCombatSkillUse 提前返回时调用）。
   * 逻辑与 actor-sheet._drawNextFromPool + slots.splice/push 一致。
   */
  _advanceBagStateManually(slotIndex) {
    const state = this._actor?.sheet?._combatBagState;
    if (!state) return;

    // 移除已使用的槽
    state.slots.splice(slotIndex, 1);

    // 从 pool 取下一张；pool 耗尽则重洗
    if (!state.pool.length) {
      state.pool = [...(state.equipped ?? [])].sort(() => Math.random() - 0.5);
    }
    const nextId = state.pool.shift() ?? null;
    state.slots.push(nextId);
    // state 是 Map 中对象的引用，直接 mutate 即已生效，无需重新 set
  }

  /** 打开角色卡并切换到战斗 Tab */
  _openCombatTab() {
    const sheet = this._actor?.sheet;
    if (!sheet) return;
    sheet.render(true);
    setTimeout(() => {
      sheet.element?.find(".sheet-tabs [data-tab='战斗']").click();
    }, 120);
  }

  /** 显示"添加 BUFF"对话框（与角色卡逻辑一致） */
  async _showAddBuffDialog() {
    if (!this._actor) return;
    const cfg    = CONFIG.LIMBUSCOMPANY;
    const groups = cfg.BUFF_GROUPS;

    const buildGroupOptions = () => {
      const sections = [
        { label: "增益", keys: groups.positive },
        { label: "减益", keys: groups.negative },
        { label: "特殊", keys: groups.special },
        { label: "其他", keys: groups.other },
      ];
      return sections.map(sec =>
        `<optgroup label="${sec.label}">${sec.keys.map(k =>
          `<option value="${k}">${_buffLabel(k)}</option>`).join("")}</optgroup>`
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

    const actor = this._actor;
    const dlg   = new Dialog({
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
            await actor.addBuff({ type, name, intensity, stacks, whenAdded,
              icon: _buffIconPath(type) });
          },
        },
        cancel: { label: "取消" },
      },
      default: "add",
    });

    dlg.render(true);
    setTimeout(() => {
      dlg.element?.find("[name='buffType']").on("change", (e) => {
        dlg.element.find(".custom-buff-row").toggle(e.target.value === "custom");
      });
    }, 50);
  }
}
