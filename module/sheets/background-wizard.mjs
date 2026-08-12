/**
 * background-wizard.mjs — 角色创建向导（背景 / 属性分配 / 恐慌卡 / 初始物品）
 *
 * 四步流程：
 *   1. 选择背景（合集包浏览器：世界物品 + 合集包内 type="background" 的物品）
 *   2. 分配属性点（预算固定为 6 项属性初始值之和，±按钮调整）
 *   3. 选择恐慌卡（士气低落 / 陷入恐慌，各自从 type="panic" 物品中选择）
 *   4. 确认初始物品（预览背景提供的初始物品，完成后写入角色）
 */
import { buildItemTitleCard, closeTitleCardUnlessLocked, toggleTitleCardLock } from "./item-sheet.mjs";

const ATTR_KEYS = ["str", "agi", "con", "int", "per", "cha"];
const ATTR_MIN = 2;
const ATTR_MAX = 8;
const ATTR_LABELS = { str: "力量", agi: "敏捷", con: "体质", int: "智力", per: "感知", cha: "魅力" };

export class BackgroundWizard extends Application {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "background-wizard",
      classes:   ["limbuscompany", "background-wizard"],
      template:  "systems/limbusCompany_FVTT/templates/apps/background-wizard.hbs",
      title:     "背景选项",
      width:     780,
      height:    680,
      resizable: true,
    });
  }

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;

    /** @type {1|2|3|4} */
    this.step = 1;

    // Step 1
    this.bgSearch       = "";
    this.bgCategoryFilter = new Set(); // 左侧「合集」勾选筛选（文件夹名）
    this.selectedBgUuid = actor.system.background?.uuid ?? "";

    // Step 2 —— 从当前角色属性出发，允许在固定预算内重新分配
    const cur = actor.system.attributes ?? {};
    this.attrs  = {};
    for (const k of ATTR_KEYS) this.attrs[k] = cur[k] ?? 5;
    this.attrBudget = ATTR_KEYS.reduce((s, k) => s + this.attrs[k], 0);

    // Step 3
    this.panicSearch = { lowMorale: "", panic: "" };
    this.panicSelected = {
      lowMorale: actor.system.panicSlots?.lowMorale
        ? actor.items.get(actor.system.panicSlots.lowMorale)?.uuid ?? ""
        : "",
      panic: actor.system.panicSlots?.panic
        ? actor.items.get(actor.system.panicSlots.panic)?.uuid ?? ""
        : "",
    };

    this._titleCard = null;
    this._focusState = null; // { selector, start, end } —— 重渲染后恢复搜索框焦点/光标位置
    this._composing = false; // 是否正处于输入法组合输入会话中
    this._searchDebounceTimer = null;
  }

  /* ─── 数据收集：世界物品 + 合集包物品 ──────────────────────────────────── */

  /**
   * 收集指定类型的物品（世界物品 + 全部合集包），并解析「合集」名称：
   * 优先使用所在文件夹名称（世界物品的 Folder / 合集包的 Folder），
   * 没有文件夹时退回 system.category 字段，都没有则归为「未分类」。
   * @param {string} type   物品类型（如 "background" / "panic"）
   * @returns {Promise<Array<{uuid,name,img,category,subtitle}>>} 未经搜索/筛选过滤的全量列表
   */
  async _gatherAll(type) {
    const out  = [];
    const seen = new Set();

    const pushItem = (uuid, name, img, category, subtitle) => {
      if (seen.has(uuid)) return;
      seen.add(uuid);
      out.push({ uuid, name, img, category: category || "未分类", subtitle: subtitle || "" });
    };

    for (const item of game.items) {
      if (item.type !== type) continue;
      const category = item.folder?.name || item.system?.category || "";
      pushItem(item.uuid, item.name, item.img, category, item.system?.subtitle ?? "");
    }

    for (const pack of game.packs) {
      if (pack.documentName !== "Item") continue;
      const index = await pack.getIndex({ fields: ["type", "system.category", "system.subtitle", "img", "folder"] });
      for (const entry of index) {
        if (entry.type !== type) continue;
        const folder = entry.folder ? pack.folders.get(entry.folder) : null;
        const category = folder?.name || entry.system?.category || "";
        pushItem(entry.uuid, entry.name, entry.img, category, entry.system?.subtitle ?? "");
      }
    }

    out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    return out;
  }

  /**
   * 按搜索词 + 已勾选合集筛选 _gatherAll() 的结果。
   * @param {string} type
   * @param {string} search
   * @param {Set<string>} [categoryFilter]  为空表示不筛选（显示全部合集）
   */
  async _gatherItems(type, search = "", categoryFilter = null) {
    const all  = await this._gatherAll(type);
    const term = search.trim().toLowerCase();
    return all.filter((it) => {
      if (categoryFilter && categoryFilter.size && !categoryFilter.has(it.category)) return false;
      if (term && !it.name.toLowerCase().includes(term) && !it.category.toLowerCase().includes(term)) return false;
      return true;
    });
  }

  /* ─── getData ────────────────────────────────────────────────────────── */

  async getData(options = {}) {
    const ctx = await super.getData(options);
    ctx.step = this.step;
    ctx.bgName = this.selectedBgUuid
      ? (await fromUuid(this.selectedBgUuid).catch(() => null))?.name ?? ""
      : "";

    if (this.step === 1) {
      const all = await this._gatherAll("background");
      ctx.bgCategories = [...new Set(all.map(i => i.category))].sort((a, b) => a.localeCompare(b, "zh"))
        .map((name) => ({ name, active: this.bgCategoryFilter.has(name) }));
      ctx.bgSearch = this.bgSearch;
      ctx.bgList   = await this._gatherItems("background", this.bgSearch, this.bgCategoryFilter);
      ctx.selectedBgUuid = this.selectedBgUuid;
      ctx.canNext = !!this.selectedBgUuid;
    }

    if (this.step === 2) {
      ctx.attrs  = ATTR_KEYS.map((k) => ({ key: k, label: ATTR_LABELS[k], value: this.attrs[k] }));
      const used = ATTR_KEYS.reduce((s, k) => s + this.attrs[k], 0);
      ctx.remaining = this.attrBudget - used;
      ctx.attrMin = ATTR_MIN;
      ctx.attrMax = ATTR_MAX;
      ctx.canNext = ctx.remaining === 0;
    }

    if (this.step === 3) {
      ctx.panicSearch = this.panicSearch;
      ctx.lowMoraleList = await this._gatherItems("panic", this.panicSearch.lowMorale);
      ctx.panicList     = await this._gatherItems("panic", this.panicSearch.panic);
      ctx.panicSelected = this.panicSelected;
      ctx.canNext = !!this.panicSelected.lowMorale && !!this.panicSelected.panic;
    }

    if (this.step === 4) {
      const bg = this.selectedBgUuid ? await fromUuid(this.selectedBgUuid).catch(() => null) : null;
      ctx.background = bg ? { name: bg.name, img: bg.img } : null;
      ctx.startingItems = [];
      if (bg) {
        for (const ref of bg.system.startingItems ?? []) {
          const it = ref.uuid ? await fromUuid(ref.uuid).catch(() => null) : null;
          ctx.startingItems.push({
            uuid: ref.uuid,
            name: it?.name ?? ref.itemData?.name ?? "（未知物品）",
            img:  it?.img  ?? ref.itemData?.img  ?? "icons/svg/item-bag.svg",
          });
        }
      }
    }

    return ctx;
  }

  /* ─── 监听 ──────────────────────────────────────────────────────────── */

  activateListeners(html) {
    super.activateListeners(html);

    html.find(".bgw-back").on("click", () => { this._focusState = null; this.step = Math.max(1, this.step - 1); this.render(); });
    html.find(".bgw-next").on("click", () => this._onNext());
    html.find(".bgw-finish").on("click", () => this._onFinish());

    // 搜索框：重渲染后恢复光标焦点（否则每输入 1 个字符就因整块重渲染而失焦）
    this._restoreFocus(html);

    // Step1
    this._bindSearchInput(html, ".bgw-search-input[data-target='bg']", (v) => { this.bgSearch = v; });
    html.find(".bgw-list-item[data-bg-uuid]").on("click", (ev) => {
      this.selectedBgUuid = ev.currentTarget.dataset.bgUuid;
      this.render();
    });
    // 点击图标：打开对应背景物品卡预览，不触发所在行的选中逻辑
    html.find(".bgw-list-item[data-bg-uuid] .bgw-list-icon").on("click", async (ev) => {
      ev.stopPropagation();
      const uuid = ev.currentTarget.closest("[data-bg-uuid]")?.dataset.bgUuid;
      if (!uuid) return;
      const item = await fromUuid(uuid).catch(() => null);
      item?.sheet?.render(true);
    });
    html.find(".bgw-cat-check[data-category]").on("click", (ev) => {
      const cat = ev.currentTarget.dataset.category;
      if (this.bgCategoryFilter.has(cat)) this.bgCategoryFilter.delete(cat);
      else this.bgCategoryFilter.add(cat);
      this.render();
    });
    html.find(".bgw-list-item[data-item-uuid], .bgw-item-chip[data-item-uuid]")
      .on("mouseenter", this._onHover.bind(this))
      .on("mouseleave", () => this._onHoverEnd())
      .on("mousedown", (ev) => {
        if (ev.button !== 1) return;
        ev.preventDefault();
        toggleTitleCardLock(this._titleCard);
      });

    // Step2
    html.find(".bgw-attr-plus").on("click", (ev) => this._onAttrAdjust(ev, 1));
    html.find(".bgw-attr-minus").on("click", (ev) => this._onAttrAdjust(ev, -1));

    // Step3
    this._bindSearchInput(html, ".bgw-search-input[data-target='lowMorale']", (v) => { this.panicSearch.lowMorale = v; });
    this._bindSearchInput(html, ".bgw-search-input[data-target='panic']",     (v) => { this.panicSearch.panic     = v; });
    html.find(".bgw-panic-item[data-slot][data-item-uuid]").on("click", (ev) => {
      const { slot, itemUuid } = ev.currentTarget.dataset;
      this.panicSelected[slot] = itemUuid;
      this.render();
    });
  }

  /**
   * 绑定搜索框：兼容中文输入法（IME）组合输入，并对重渲染做防抖。
   * 原先每次 `input` 都同步 `this.render()`，会在浏览器仍在处理当前按键事件、
   * 或输入法组合会话进行中时就把 input 的 DOM 节点整体替换掉，导致：
   *   1. 英文输入：偶发重复插入字符（DOM 在事件分发中途被替换）
   *   2. 中文输入：输入法组合窗口被打断，无法正常拼字上屏
   * 修复方式：组合输入期间（compositionstart~compositionend）不触发重渲染；
   * 非组合输入用短防抖延迟重渲染，让浏览器先完整处理完当前按键。
   */
  _bindSearchInput(html, selector, apply) {
    const el = html.find(selector)[0];
    if (!el) return;

    el.addEventListener("compositionstart", () => { this._composing = true; });
    el.addEventListener("compositionend", () => {
      this._composing = false;
      apply(el.value);
      this._saveFocus(el);
      this._scheduleRender();
    });
    el.addEventListener("input", () => {
      apply(el.value);
      this._saveFocus(el);
      if (this._composing) return; // 组合输入进行中，等待 compositionend 再重渲染
      this._scheduleRender();
    });
  }

  /** 防抖重渲染：避免在浏览器仍处理当前按键事件时就替换 DOM。 */
  _scheduleRender() {
    clearTimeout(this._searchDebounceTimer);
    this._searchDebounceTimer = setTimeout(() => this.render(), 120);
  }

  /** 记录当前搜索框的焦点位置（data-target 值 + 光标选区），供重渲染后恢复。 */
  _saveFocus(el) {
    this._focusState = {
      target: el.dataset.target,
      start:  el.selectionStart,
      end:    el.selectionEnd,
    };
  }

  /** 重渲染完成后恢复搜索框焦点与光标位置（整块模板重渲染会销毁原 input DOM）。 */
  _restoreFocus(html) {
    const state = this._focusState;
    if (!state) return;
    const el = html.find(`.bgw-search-input[data-target='${state.target}']`)[0];
    if (!el) return;
    el.focus();
    el.setSelectionRange(state.start, state.end);
  }

  _onAttrAdjust(ev, dir) {
    const key = ev.currentTarget.dataset.attr;
    if (!ATTR_KEYS.includes(key)) return;
    const cur = this.attrs[key];
    const next = cur + dir;
    if (next < ATTR_MIN || next > ATTR_MAX) return;
    const used = ATTR_KEYS.reduce((s, k) => s + this.attrs[k], 0);
    if (dir > 0 && used >= this.attrBudget) return; // 预算不足
    this.attrs[key] = next;
    this.render();
  }

  async _onHover(event) {
    const uuid = event.currentTarget.dataset.bgUuid ?? event.currentTarget.dataset.itemUuid;
    if (!uuid) return;
    const item = await fromUuid(uuid).catch(() => null);
    this._onHoverEnd(true);
    if (!item) return;
    const card = buildItemTitleCard(item);
    if (!card) return;
    const rect = event.currentTarget.getBoundingClientRect();
    card.css({ position: "fixed", left: rect.right + 8, top: rect.top, zIndex: 10010 });
    $("body").append(card);
    this._titleCard = card;
    // 卡片本体挂上悬停取消/重排关闭，给鼠标移到卡片上（鼠标中键锁定）的机会
    card.on("mouseenter", () => clearTimeout(this._titleCardCloseTimer));
    card.on("mouseleave", () => this._onHoverEnd());
  }

  /**
   * @param {boolean} [force=false]  true=立即强制关闭（忽略锁定）；
   *   false=延迟 150ms 软关闭（锁定的卡片会被 closeTitleCardUnlessLocked 拦下）
   */
  _onHoverEnd(force = false) {
    if (!force) {
      clearTimeout(this._titleCardCloseTimer);
      this._titleCardCloseTimer = setTimeout(() => this._onHoverEnd(true), 150);
      return;
    }
    clearTimeout(this._titleCardCloseTimer);
    closeTitleCardUnlessLocked(this._titleCard);
    if (!this._titleCard?.data("tcLocked")) this._titleCard = null;
  }

  _onNext() {
    if (this.step === 1 && !this.selectedBgUuid) { ui.notifications.warn("请先选择一个背景。"); return; }
    if (this.step === 2) {
      const used = ATTR_KEYS.reduce((s, k) => s + this.attrs[k], 0);
      if (used !== this.attrBudget) { ui.notifications.warn(`属性点未分配完，剩余 ${this.attrBudget - used} 点。`); return; }
    }
    if (this.step === 3 && (!this.panicSelected.lowMorale || !this.panicSelected.panic)) {
      ui.notifications.warn("请选择士气低落与陷入恐慌对应的卡片。"); return;
    }
    this._focusState = null;
    this.step = Math.min(4, this.step + 1);
    this.render();
  }

  /* ─── 完成：写入角色 ────────────────────────────────────────────────── */

  async _onFinish() {
    const bg = this.selectedBgUuid ? await fromUuid(this.selectedBgUuid).catch(() => null) : null;
    if (!bg) { ui.notifications.error("背景无效，无法完成。"); return; }

    // 1. 背景引用 + 属性
    const updateData = {
      "system.background.uuid": this.selectedBgUuid,
      "system.attributes.str": this.attrs.str,
      "system.attributes.agi": this.attrs.agi,
      "system.attributes.con": this.attrs.con,
      "system.attributes.int": this.attrs.int,
      "system.attributes.per": this.attrs.per,
      "system.attributes.cha": this.attrs.cha,
    };
    await this.actor.update(updateData);

    // 2. 恐慌卡：复制嵌入角色，写入槽位（沿用 _onPanicSlotDrop 的嵌入模式）
    for (const slot of ["lowMorale", "panic"]) {
      const uuid = this.panicSelected[slot];
      if (!uuid) continue;
      const src = await fromUuid(uuid).catch(() => null);
      if (!src || src.type !== "panic") continue;
      const oldId = this.actor.system.panicSlots?.[slot] ?? "";
      let itemId;
      if (src.parent?.id === this.actor.id) {
        itemId = src.id;
      } else {
        const data = src.toObject();
        delete data._id;
        const [newItem] = await this.actor.createEmbeddedDocuments("Item", [data]);
        itemId = newItem.id;
      }
      await this.actor.update({ [`system.panicSlots.${slot}`]: itemId });
      if (oldId && oldId !== itemId) {
        const stillUsed = Object.entries(this.actor.system.panicSlots ?? {})
          .some(([k, v]) => k !== slot && v === oldId);
        if (!stillUsed) await this.actor.items.get(oldId)?.delete();
      }
    }

    // 3. 初始物品：复制嵌入角色背包
    const toCreate = [];
    for (const ref of bg.system.startingItems ?? []) {
      const src = ref.uuid ? await fromUuid(ref.uuid).catch(() => null) : null;
      const data = src ? src.toObject() : foundry.utils.deepClone(ref.itemData);
      if (!data) continue;
      delete data._id;
      toCreate.push(data);
    }
    if (toCreate.length) await this.actor.createEmbeddedDocuments("Item", toCreate);

    ui.notifications.info(`背景「${bg.name}」已应用。`);
    this.close();
    this.actor.sheet?.render(false);
  }

  close(options) {
    clearTimeout(this._searchDebounceTimer);
    this._onHoverEnd(true);
    return super.close(options);
  }
}
