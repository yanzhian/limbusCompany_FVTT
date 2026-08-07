/**
 * background-wizard.mjs — 角色创建向导（背景 / 属性分配 / 恐慌卡 / 初始物品）
 *
 * 四步流程：
 *   1. 选择背景（合集包浏览器：世界物品 + 合集包内 type="background" 的物品）
 *   2. 分配属性点（预算固定为 6 项属性初始值之和，±按钮调整）
 *   3. 选择恐慌卡（士气低落 / 陷入恐慌，各自从 type="panic" 物品中选择）
 *   4. 确认初始物品（预览背景提供的初始物品，完成后写入角色）
 */
import { buildItemTitleCard } from "./item-sheet.mjs";

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
  }

  /* ─── 数据收集：世界物品 + 合集包物品 ──────────────────────────────────── */

  /**
   * 收集指定类型的物品（世界物品 + 全部合集包），并解析「合集」名称：
   * 优先使用所在文件夹名称（世界物品的 Folder / 合集包的 Folder），
   * 没有文件夹时退回 system.category 字段，都没有则归为「未分类」。
   * @param {string} type   物品类型（如 "background" / "panic"）
   * @returns {Promise<Array<{uuid,name,img,category}>>} 未经搜索/筛选过滤的全量列表
   */
  async _gatherAll(type) {
    const out  = [];
    const seen = new Set();

    const pushItem = (uuid, name, img, category) => {
      if (seen.has(uuid)) return;
      seen.add(uuid);
      out.push({ uuid, name, img, category: category || "未分类" });
    };

    for (const item of game.items) {
      if (item.type !== type) continue;
      const category = item.folder?.name || item.system?.category || "";
      pushItem(item.uuid, item.name, item.img, category);
    }

    for (const pack of game.packs) {
      if (pack.documentName !== "Item") continue;
      const index = await pack.getIndex({ fields: ["type", "system.category", "img", "folder"] });
      for (const entry of index) {
        if (entry.type !== type) continue;
        const folder = entry.folder ? pack.folders.get(entry.folder) : null;
        const category = folder?.name || entry.system?.category || "";
        pushItem(entry.uuid, entry.name, entry.img, category);
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

    html.find(".bgw-back").on("click", () => { this.step = Math.max(1, this.step - 1); this.render(); });
    html.find(".bgw-next").on("click", () => this._onNext());
    html.find(".bgw-finish").on("click", () => this._onFinish());

    // Step1
    html.find(".bgw-search-input[data-target='bg']").on("input", (ev) => {
      this.bgSearch = ev.currentTarget.value;
      this.render();
    });
    html.find(".bgw-list-item[data-bg-uuid]").on("click", (ev) => {
      this.selectedBgUuid = ev.currentTarget.dataset.bgUuid;
      this.render();
    });
    html.find(".bgw-cat-check[data-category]").on("click", (ev) => {
      const cat = ev.currentTarget.dataset.category;
      if (this.bgCategoryFilter.has(cat)) this.bgCategoryFilter.delete(cat);
      else this.bgCategoryFilter.add(cat);
      this.render();
    });
    html.find(".bgw-list-item[data-item-uuid], .bgw-item-chip[data-item-uuid]")
      .on("mouseenter", this._onHover.bind(this))
      .on("mouseleave", this._onHoverEnd.bind(this));

    // Step2
    html.find(".bgw-attr-plus").on("click", (ev) => this._onAttrAdjust(ev, 1));
    html.find(".bgw-attr-minus").on("click", (ev) => this._onAttrAdjust(ev, -1));

    // Step3
    html.find(".bgw-search-input[data-target='lowMorale']").on("input", (ev) => {
      this.panicSearch.lowMorale = ev.currentTarget.value; this.render();
    });
    html.find(".bgw-search-input[data-target='panic']").on("input", (ev) => {
      this.panicSearch.panic = ev.currentTarget.value; this.render();
    });
    html.find(".bgw-panic-item[data-slot][data-item-uuid]").on("click", (ev) => {
      const { slot, itemUuid } = ev.currentTarget.dataset;
      this.panicSelected[slot] = itemUuid;
      this.render();
    });
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
    this._onHoverEnd();
    if (!item) return;
    const card = buildItemTitleCard(item);
    if (!card) return;
    const rect = event.currentTarget.getBoundingClientRect();
    card.css({ position: "fixed", left: rect.right + 8, top: rect.top, zIndex: 10010 });
    $("body").append(card);
    this._titleCard = card;
  }

  _onHoverEnd() {
    this._titleCard?.remove();
    this._titleCard = null;
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
}
