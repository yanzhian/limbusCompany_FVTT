/**
 * quick-action-hud.mjs — 快捷操作 HUD
 *
 * 仅当选中恰好一个 character 类型的 Token 时显示。
 * 与角色卡双向同步：读取 actor.system 数据，写入通过 actor.update()。
 *
 * 提供快捷访问：
 *   - 行动值（AP）硬币（点击切换）
 *   - 角色头像（单击折叠面板，双击打开角色卡，拖动移动 HUD）
 *   - 消耗品 / 装备 展开面板；基础技能三格（点击/拖拽发起对抗）
 *   - HP 球 / 状态栏 / 理智球
 */

import { ClashManager } from "../helpers/clash.mjs";
import { CustomBuffRegistry } from "../helpers/custom-buffs.mjs";
import { closeTitleCardUnlessLocked, toggleTitleCardLock,
         attachHoverableTitleCard, buildBuffTitleCard } from "./item-sheet.mjs";

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

function _buffIconPath(type, name = "") {
  if (BUFF_ICON_MAP[type]) return BUFF_ICON_BASE + BUFF_ICON_MAP[type];
  const customName = name || type;
  return customName ? `${BUFF_ICON_BASE}Custom_buffs/${customName}.webp` : "";
}

/* ═══════════════════════════════════════════════════════════════════════════
   中央七边形血环几何常量
   角度以正上方为 0°、顺时针增加（与 CSS conic-gradient / rotate 一致）。
   起点 180° = 底部尖角，顺时针铺 310°，右下留 50° 缺口（由理智球盖住）。
   扣血时红色从右下终点逆时针缩回底部尖角。混乱阈值刻度线共用这套映射。
═══════════════════════════════════════════════════════════════════════════ */
const QA_ARC_FROM = 180;
const QA_ARC_LEN  = 310;

/* 拖拽幽灵图标居中偏移量（= .qa-skill-drag-ghost 尺寸的一半，改 CSS 时同步） */
const QA_GHOST_HALF = 50;

/* BUFF 状态栏：默认格数 / 每行上限（每行上限需与 CSS 的
   .qa-status-bar max-width 计算保持一致） */
const QA_BUFF_DEFAULT = 8;
const QA_BUFF_PER_ROW = 16;

/* 技能边框图：assets/icons/Skill/{罪孽首字母大写}_lv{等级}.webp
   注意这是中空的七边形【边框】，不是技能图本身——技能自身的图用
   item.img，边框叠在其上层（见模板 .qa-skill-art / .qa-skill-frame）。 */
const SKILL_ICON_BASE = "systems/limbusCompany_FVTT/assets/icons/Skill/";
const SIN_ICON_NAME = {
  wrath: "Wrath", lust: "Lust", sloth: "Sloth", gluttony: "Gluttony",
  gloom: "Gloom", pride: "Pride", envy: "Envy",
};
/** 按罪孽+等级取技能图标；EGO 用专属图标，取不到则回退通用图 */
function _skillIcon(item) {
  if (!item) return "";
  const sys = item.system ?? {};
  if (sys.type === "ego") return `${SKILL_ICON_BASE}E.G.O.webp`;
  const sin = SIN_ICON_NAME[sys.sinType];
  const lv  = Math.max(1, Math.min(3, sys.level ?? 1));
  return sin ? `${SKILL_ICON_BASE}${sin}_lv${lv}.webp` : `${SKILL_ICON_BASE}Normalsin.webp`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   QuickActionHUD Application
═══════════════════════════════════════════════════════════════════════════ */

export class QuickActionHUD extends Application {

  /** 单例引用 */
  static instance = null;

  /** 当前追踪的角色（选中 token 绑定的 actor） */
  _actor = null;

  /** 当前展开的面板集合（"consumable" | "equipment"） */
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

  /** 战斗轮次/回合变化 → 重渲染，让"下个回合"按钮及时出现或消失 */
  static onCombatChange() {
    const hud = QuickActionHUD.instance;
    if (hud?._actor) hud.render(false);
  }

  /* ─── 隐藏 HUD ──────────────────────────────────────────────────────────── */

  _hide() {
    // 关闭前先摘掉 BUFF 悬浮卡，避免 HUD 消失后卡片残留在屏幕上
    this._buffCardCtrls?.forEach(c => c.close?.());
    this._buffCardCtrls = [];
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
    // 槽位数量：默认 8 格；超过 8 个后先向右补满整行（16 格），
    // 装满 16 格才继续向下换行（每行 16 格，由 CSS 的 max-width 控制换行位置）
    const slotCount = activeBuffs.length <= QA_BUFF_DEFAULT
      ? QA_BUFF_DEFAULT
      : Math.ceil(activeBuffs.length / QA_BUFF_PER_ROW) * QA_BUFF_PER_ROW;
    const buffSlots = Array.from({ length: slotCount }, (_, i) => {
      const buff = activeBuffs[i] ?? null;
      const handler = buff ? CustomBuffRegistry.get(buff.type) : null;
      return {
        index: i, buff,
        icon:        buff ? _buffIcon(buff.type, buff.icon) : "",
        description: handler?.description ?? "",
      };
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
        icon:      _skillIcon(item),
        sinColor:  item ? (cfg.SIN_COLORS?.[item.system?.sinType] ?? "#C9A84C") : "#443322",
        isActive:  i < 2,   // 0,1 = 激活可用；2 = 准备（半透明，下一个补上来的）
        isPending: i === 2,
      };
    });

    // ── 中央七边形：生命值血环 / 混乱阈值刻度 ────────────────────────────
    // 血环几何：起点 180°（底部尖角），顺时针铺 310°，右下留 50° 缺口（被理智球盖住）
    const hpValue = sys.hp?.value ?? 0;
    const hpMax   = Math.max(1, sys.hp?.max ?? 1);
    const hpPct   = Math.max(0, Math.min(1, hpValue / hpMax));

    // 混乱阈值白线：与血环同一套映射，落在"血量掉到该百分比时红色会退到的位置"
    const chaosLines = (sys.chaosThresholds ?? []).map(t => ({
      percent:   t.percent ?? 0,
      triggered: !!t.triggered,
      angle:     QA_ARC_FROM + QA_ARC_LEN * ((t.percent ?? 0) / 100),
    }));

    // ── "下一回合"按钮显示条件 ───────────────────────────────────────────
    // 玩家：必须处于已开始的遭遇战中、且当前正轮到本角色行动；
    // GM：只要遭遇战进行中就一直显示（GM 同时控制多个角色，不受"轮到谁"限制）。
    const combat       = game.combat;
    const inCombat     = !!combat?.started;
    const isMyTurn     = inCombat && combat.combatant?.actor?.id === actor.id;
    const showNextTurn = inCombat && (game.user.isGM || isMyTurn);

    return {
      actorImg:       actor.img  ?? "icons/svg/mystery-man.svg",
      actorName:      actor.name ?? "",
      apCoins,
      showNextTurn,
      isMyTurn,
      hpValue,
      hpMax,
      hpPct:          hpPct.toFixed(4),
      chaosLines,
      panicFear:      sys.panicCounters?.fear    ?? 0,
      panicResolve:   sys.panicCounters?.resolve ?? 0,
      sanValue:       sys.sanity?.value ?? 50,
      buffSlots,
      equipmentItems,
      consumableItems,
      basicSkills,
    };
  }

  async close(options = {}) {
    this._onHudItemHoverEnd(true);
    this._buffCardCtrls?.forEach(c => c.close?.());
    this._buffCardCtrls = [];
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
        // 关闭其他已开面板，保持同一时刻只有一个面板展开
        html.find(".qa-panel").hide();
        html.find(".qa-btn[data-panel]").removeClass("qa-btn--active");
        this._openPanels.clear();
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

    // ── 基础技能格：点击发起对抗 / 长按拖到 token 指定目标 ───────────────
    this._bindSkillSlots(html);

    // ── 下一回合：推进战斗轮次 ──────────────────────────────────────────
    html.find(".qa-next-turn-btn").on("click", () => this._nextTurn());

    // ── 刷新：同步角色卡战斗页基础技能（未激活则代替执行"激活"）─────────
    html.find(".qa-refresh-btn").on("click", async (e) => {
      const btn = $(e.currentTarget);
      btn.addClass("qa-spin");
      setTimeout(() => btn.removeClass("qa-spin"), 340);
      await this._refreshCombatBag();
    });

    // ── 状态栏：空格 → 添加 BUFF；有 BUFF 格 → 打开角色卡战斗页 ─────────
    html.find(".qa-buff-slot--empty").on("click", () => this._showAddBuffDialog());
    html.find(".qa-buff-slot--filled").on("click", () => this._openCombatTab());

    // ── 七边形 HP / 理智数字点击：打开角色卡 ─────────────────────────────
    html.find(".qa-hex-hp, .qa-hex-san").on("click", () => this._actor?.sheet?.render(true));

    // ── 恐惧鉴定：点击打开角色卡战斗页（恐慌计数在那里可手动调整） ───────
    html.find(".qa-panic-check").on("click", () => this._openCombatTab());

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

    // ── 技能 / 物品悬浮 Title 卡（与角色卡一致） ──────────────────────────
    const hoverTargets = [
      ".qa-skill-slot[data-item-id]",
      ".qa-panel-item[data-item-id]",
    ].join(", ");

    html.find(hoverTargets)
      .on("mouseenter", (e) => this._onHudItemHover(e))
      .on("mouseleave", () => this._onHudItemHoverEnd())
      .on("mousedown", (ev) => {
        if (ev.button !== 1) return;
        ev.preventDefault();
        toggleTitleCardLock(this._hudTitleCard);
      });

    // ── BUFF 格悬浮 Title 卡（复用物品卡/角色卡同一套 BUFF 卡片）───────────
    // attachHoverableTitleCard 自带中键锁定与卡内 chip 嵌套卡逻辑，
    // 返回的 controller 需在重渲染/关闭时清理，避免卡片残留。
    this._buffCardCtrls?.forEach(c => c.close?.());
    this._buffCardCtrls = [];
    html.find(".qa-buff-slot--filled[data-buff-name]").each((_, el) => {
      this._buffCardCtrls.push(
        attachHoverableTitleCard(el, () => buildBuffTitleCard(el.dataset.buffName))
      );
    });
  }

  /* ─── 内部辅助 ───────────────────────────────────────────────────────────── */

  /** 激活物品（触发 [使用时]；消耗品数量 -1 / 归零删除） */
  async _activateItem(item) {
    if (item.type === "consumable" && (item.system.quantity ?? 0) <= 0) {
      ui.notifications.warn("数量不足。"); return;
    }
    // 装备激活消耗 1 行动值
    if (item.type === "equipment") {
      const curAp = this._actor?.system?.ap?.value ?? 0;
      if (curAp < 1) {
        ui.notifications.warn("行动值不足，无法激活装备。"); return;
      }
      await this._actor.update({ "system.ap.value": curAp - 1 });
    }
    await ClashManager._applyActivities(item, "使用时", {
      owner: this._actor, atkActor: this._actor, defActor: null, _fireCounts: {},
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

  /** HUD 物品/技能悬浮 → 显示与角色卡完全相同的 Title 卡 */
  _onHudItemHover(event) {
    const el     = event.currentTarget;
    const itemId = el.dataset.itemId;
    if (!itemId || !this._actor) return;

    const item   = this._actor.items.get(itemId);
    if (!item) return;

    const sheet  = this._actor.sheet;
    if (!sheet?._buildTitleCard) return;

    this._onHudItemHoverEnd(true);
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
    this._hudTitleCard.on("mouseenter", () => clearTimeout(this._hudTitleCardCloseTimer));
    this._hudTitleCard.on("mouseleave", () => this._onHudItemHoverEnd());

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

  /**
   * @param {boolean} [force=false]  true=立即强制关闭（忽略锁定）；
   *   false=延迟 150ms 软关闭（锁定的卡片会被 closeTitleCardUnlessLocked 拦下）
   */
  _clearHudTitleCardWheel() {
    if (this._hudTitleCardWheelEl && this._hudTitleCardWheelHandler) {
      this._hudTitleCardWheelEl.removeEventListener("wheel", this._hudTitleCardWheelHandler);
    }
    this._hudTitleCardWheelEl = null;
    this._hudTitleCardWheelHandler = null;
  }

  _onHudItemHoverEnd(force = false) {
    if (!force) {
      clearTimeout(this._hudTitleCardCloseTimer);
      this._hudTitleCardCloseTimer = setTimeout(() => this._onHudItemHoverEnd(true), 150);
      return;
    }
    clearTimeout(this._hudTitleCardCloseTimer);
    this._clearHudTitleCardWheel();
    closeTitleCardUnlessLocked(this._hudTitleCard);
    if (!this._hudTitleCard?.data("tcLocked")) this._hudTitleCard = null;
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

  // 注：原 _advanceBagStateManually() 已移除。
  // 战斗袋的推进统一由 actor-sheet._animateCombatSkillUse() 负责——它内部
  // 已区分角色卡开着（播完动画再推进）与关着（直接推进）两种情况。HUD 侧
  // 再补一次会导致关闭角色卡时重复推进，技能跳着走。

  /* ─── 基础技能格：点击发起对抗 / 长按拖到 token 指定目标 ───────────────── */

  /**
   * 绑定三个基础技能格的交互：
   * - 单击            → 发起对抗（不指定目标）
   * - 长按 300ms 后拖拽 → 拖到画布 token 上松开，指定该角色为唯一可响应目标
   * 两条路径最终都走 ClashManager.showInitiateDialog（弹"发起对抗"确认框，
   * 可填加值修正），确认后才真正打出；取消则技能保留、不消耗行动值。
   */
  _bindSkillSlots(html) {
    const LONG_PRESS_MS = 300;
    let pressTimer = null, dragging = null, ghost = null;

    const clearDrag = () => {
      if (dragging) dragging.el.removeClass("qa-skill-slot--dragging");
      ghost?.remove();
      ghost = null; dragging = null;
      $(document).off("mousemove.qaSkillDrag mouseup.qaSkillDrag");
    };

    /** 屏幕坐标 → 画布 token */
    const tokenAt = (clientX, clientY) => {
      if (!canvas?.ready) return null;
      const t = canvas.canvasCoordinatesFromClient?.({ x: clientX, y: clientY })
        ?? canvas.clientCoordinatesToCanvas?.({ x: clientX, y: clientY });
      if (!t) return null;
      return canvas.tokens?.placeables?.find(tk =>
        t.x >= tk.x && t.x <= tk.x + tk.w && t.y >= tk.y && t.y <= tk.y + tk.h) ?? null;
    };

    html.find(".qa-skill-slot--ready").on("mousedown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();

      const el        = $(ev.currentTarget);
      const itemId    = el.data("itemId");
      const slotIndex = Number(el.data("slotIndex"));
      if (!itemId) return;

      pressTimer = setTimeout(() => {
        pressTimer = null;
        dragging = { el, itemId, slotIndex };
        el.addClass("qa-skill-slot--dragging");
        ghost = $(`<div class="qa-skill-drag-ghost">${el.html()}</div>`)
          .css({ left: ev.clientX - QA_GHOST_HALF, top: ev.clientY - QA_GHOST_HALF })
          .appendTo(document.body);
        ui.notifications.info("拖到目标 Token 上松开：指定该角色为唯一可对抗目标");
      }, LONG_PRESS_MS);

      $(document)
        .on("mousemove.qaSkillDrag", (e) => {
          if (!dragging || !ghost) return;
          ghost.css({ left: e.clientX - QA_GHOST_HALF, top: e.clientY - QA_GHOST_HALF });
        })
        .on("mouseup.qaSkillDrag", async (e) => {
          // 未到长按阈值 → 视为单击，不指定目标
          if (pressTimer) {
            clearTimeout(pressTimer); pressTimer = null;
            clearDrag();
            await this._castSkill(itemId, slotIndex, "");
            return;
          }
          if (!dragging) { clearDrag(); return; }
          const tk = tokenAt(e.clientX, e.clientY);
          const targetActorId = tk?.actor?.id ?? "";
          clearDrag();
          if (!targetActorId) {
            ui.notifications.warn("未拖到任何 Token 上，已取消本次指定");
            return;
          }
          await this._castSkill(itemId, slotIndex, targetActorId);
        });
    });
  }

  /**
   * 打出一个基础技能：弹发起对抗确认框，确认后播"飞走 + 补位"动画。
   * showInitiateDialog 内部已负责扣 AP / 推进 6-bag（slotIndex >= 0），
   * 这里只负责 HUD 侧的动画表现，动画结束后重渲染取最新状态。
   */
  async _castSkill(itemId, slotIndex, targetActorId = "") {
    const actor = this._actor;
    const item  = actor?.items.get(itemId);
    if (!actor || !item) return;

    // 只有激活槽（0/1）可以发起对抗，准备槽（2）不可用
    if (slotIndex > 1) {
      ui.notifications.warn("只有激活槽中的技能可以发起对抗");
      return;
    }
    if ((actor.system.ap?.value ?? 0) <= 0) {
      ui.notifications.warn(`${actor.name} 行动值不足，无法发起对抗`);
      return;
    }

    // 确保战斗袋已初始化（状态存在模块级 Map 中，按 actorId 索引，
    // 关闭角色卡也不会丢失）
    this._ensureBagState();

    const ok = await ClashManager.showInitiateDialog(actor, item, slotIndex, targetActorId);
    if (!ok) return;   // 取消：技能保留在槽位，不播动画、不推进袋

    // 注意：战斗袋的推进完全交给 clash.mjs → sheet._animateCombatSkillUse()，
    // 它内部已分别处理"角色卡开着"（播动画后推进）与"角色卡关着"
    // （!this.element.length 时直接推进）两种情况。这里不能再补一次
    // _advanceBagStateManually，否则角色卡关闭时会推进两次，技能跳着走、
    // 看起来像被打乱。

    // 打出格向上飞走；它右侧的格子左移补位，左侧的保持不动
    const row = this.element?.find(".qa-skill-row");
    row?.find(`.qa-skill-slot[data-slot-index="${slotIndex}"]`).addClass("qa-skill-slot--casting");
    row?.find(".qa-skill-slot").each((_, el) => {
      const idx = Number(el.dataset.slotIndex);
      if (idx > slotIndex) $(el).addClass("qa-skill-slot--shifting");
    });
    setTimeout(() => this.render(false), 430);
  }

  /**
   * 推进到下一回合。
   * GM 直接调用 combat.nextTurn()；玩家没有修改 Combat 文档的权限，
   * 通过既有的 system.limbusCompany_FVTT socket 通道委托 GM 执行
   * （与 ClashManager._safeDocUpdate 的委托思路一致）。
   */
  async _nextTurn() {
    const combat = game.combat;
    if (!combat?.started) {
      ui.notifications.warn("当前没有进行中的遭遇战");
      return;
    }

    if (game.user.isGM) {
      await combat.nextTurn();
      return;
    }

    // 玩家：仅允许在轮到自己控制的角色时结束回合
    if (combat.combatant?.actor?.id !== this._actor?.id) {
      ui.notifications.warn("现在不是你的回合");
      return;
    }
    game.socket.emit("system.limbusCompany_FVTT", {
      type:     "gmNextTurn",
      combatId: combat.id,
      userId:   game.user.id,
    });
  }

  /**
   * 刷新：与角色卡战斗页的 6-bag 同步。
   * 角色卡尚未激活战斗槽时，代替执行一次"激活"（初始化 6-bag）。
   */
  async _refreshCombatBag() {
    const sheet = this._actor?.sheet;
    if (!sheet) return;

    if (!sheet._combatBagState) {
      // 未激活 → 代替执行"激活"：初始化 6-bag（不依赖角色卡是否已渲染）
      this._ensureBagState();
      if (!sheet._combatBagState) {
        ui.notifications.warn("没有已装备的基础技能，无法激活战斗槽");
        return;
      }
      ui.notifications.info("已激活战斗槽（6-bag）");
    }

    // 角色卡开着时同步刷新它的槽位显示，两边保持一致
    if (sheet.rendered && sheet.element?.length) sheet._renderCombatSlots?.(sheet.element);
    this.render(false);
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
              icon: _buffIconPath(type, name) });
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
