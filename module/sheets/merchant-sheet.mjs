/**
 * merchant-sheet.mjs — 商人（网格版）
 *
 * 左＝当前玩家主控角色的背包网格，右＝商人货架网格，两块都用
 * helpers/grid-layout + grid-dnd 那一套（与营地仓库、容器完全同源）。
 *
 * ── 交互约定 ────────────────────────────────────────────────────────────
 *   · 玩家只能拖动**自己**的物品：货架图块的 payloadFor 对非 GM 返回 null，
 *     于是它在 GridDnD 眼里根本不可拖。
 *   · 拖自己的物品到货架 = 出售，落点就是它在货架上的位置；卖错了双击那件
 *     商品原价买回来（卖出时会把回收价写成新的上架原价）。
 *   · 双击货架商品 = 购买；GM 双击 = 改价 / 改数量 / 下架。
 *   · 【多选】开启后点击选择（两边都能选），【一键买卖】汇总成一笔。
 *
 * ── 权限 ────────────────────────────────────────────────────────────────
 * 玩家对商人 Actor 通常只有「查看」权限，所有会改数据的操作一律经 socket
 * 交给 GM 端执行（`_gmExecute*`），并按 merchantId 串行排队防止并发超卖。
 * 这与营地仓库同一套路子。
 */

import { buildItemTitleCard, toggleTitleCardLock } from "./item-sheet.mjs";
import { GridDnD } from "../helpers/grid-dnd.mjs";
import { canPlace, autoPlace, buildPlacementGrid } from "../helpers/grid-layout.mjs";
import { getBagItems, packBagGrid, BAG_COLS, BAG_ROWS } from "../helpers/bag-grid.mjs";

/**
 * 这件东西有没有「数量」的说法。
 * 由物品自己的【可堆叠】开关决定（只有消耗品/材料有这个字段）——
 * 同是消耗品，丹药可以堆、一次性的护符就不该堆，光看类型判断不了。
 */
export const hasQty = (item) => !!item?.system?.stackable;

/** 货架尺寸：与玩家背包一致的竖版 5 宽 × 8 高，两边看着才对称 */
export const EYE_ICON = "systems/limbusCompany_FVTT/assets/icons/Base_icon/眼.webp";

export const SHELF_COLS = BAG_COLS;
export const SHELF_ROWS = BAG_ROWS;

/** 货架分类筛选（按物品 type） */
const CAT_FILTERS = [
  { key: "",           label: "全部" },
  { key: "equipment",  label: "装备" },
  { key: "consumable", label: "消耗品" },
  { key: "material",   label: "材料" },
  { key: "skillbook",  label: "技能书" },
];

export class LimbusMerchantSheet extends ActorSheet {

  /**
   * 左栏画的是**别的 Actor**（玩家角色）的背包，那边变了不会自动重渲染这张卡。
   * 在 ready 里挂一次钩子，角色的钱/物品/摆放一变就刷新所有打开着的商人卡。
   */
  static init() {
    const refresh = (actor) => {
      if (actor?.type !== "character") return;
      for (const app of Object.values(ui.windows)) {
        if (app instanceof LimbusMerchantSheet) app.render(false);
      }
    };
    Hooks.on("updateActor", refresh);
    Hooks.on("createItem", (item) => refresh(item?.parent));
    Hooks.on("deleteItem", (item) => refresh(item?.parent));
    Hooks.on("updateItem", (item) => refresh(item?.parent));
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes:  ["limbuscompany", "sheet", "actor", "merchant-sheet"],
      template: "systems/limbusCompany_FVTT/templates/actor/merchant-sheet.hbs",
      width:    600,
      height:   650,
      resizable: true,
    });
  }

  /* ─── 界面状态（不持久化） ───────────────────────────────────────────── */

  _editUnlocked = false;
  _catFilter    = "";
  _multi        = false;
  /** 选中的图块：`shop:<placementIdx>` / `bag:<itemId>` */
  _sel          = new Set();
  _charGrid     = null;
  _titleCard    = null;

  /* ─── 并发与聊天播报（沿用旧版） ─────────────────────────────────────── */

  /** merchantId → 串行队列，防止两个人同时买最后一件 */
  static _opQueues = new Map();
  static _enqueue(merchantId, fn) {
    const prev = LimbusMerchantSheet._opQueues.get(merchantId) ?? Promise.resolve();
    const next = prev.then(fn).catch(err => console.error("[商人] 操作失败", err));
    LimbusMerchantSheet._opQueues.set(merchantId, next);
    return next;
  }

  /** 30 秒内的连续买/卖合并成一条聊天卡，避免刷屏 */
  static _chatSessions = new Map();
  static _chatTimers   = new Map();

  /** 「数字 + 眼图标」，代替到处写「xxx 眼」 */
  static eyeHtml(n, cls = "") {
    return `<b class="mc-eye ${cls}">${n}</b>`
      + `<img class="mc-eye-ic" src="${EYE_ICON}" alt="眼">`;
  }

  /**
   * 卡片结构：
   *   商人立绘(55px) │ 【商人名】
   *                  │ 购买清单
   *   ──────── 金线 ────────
   *   购买方 PL
   *     [图标] 物品名          价格
   *     总计                   价格
   *   （每个 PL 一组，组间空一行）
   */
  static _buildTradeChatContent({ merchant, items }) {
    const gold = `<div style="height:1px;background:linear-gradient(90deg,
      rgba(201,168,76,0),rgba(201,168,76,.75),rgba(201,168,76,0));margin:5px 0;"></div>`;

    // 按 PL 分组，保持首次出现的顺序
    const groups = new Map();
    for (const i of items) {
      if (!groups.has(i.charId)) groups.set(i.charId, { name: i.charName, list: [] });
      groups.get(i.charId).list.push(i);
    }

    const hasSell = items.some(i => i.kind !== "buy");
    const title   = hasSell ? "交易清单" : "购买清单";

    const blocks = [...groups.values()].map(g => {
      let total = 0;
      const rows = g.list.map(i => {
        const buy = i.kind === "buy";
        const sum = i.price * (i.qty ?? 1);
        total += buy ? sum : -sum;
        return `
        <div style="display:flex;align-items:center;gap:6px;padding:1px 0;">
          <img src="${i.img}" style="width:26px;height:26px;object-fit:cover;border:1px solid #5F3E22;" alt="">
          <span style="flex:1;color:#E8C9A2;font-size:.82rem;">${
            buy ? "" : `<span style="color:#7AAB6A;font-size:.72rem;">卖出 </span>`
          }${i.name}${i.qty > 1 ? ` ×${i.qty}` : ""}</span>
          <span style="font-size:.82rem;white-space:nowrap;color:${buy ? "#E5BA25" : "#7AAB6A"};">
            ${LimbusMerchantSheet.eyeHtml(sum)}</span>
        </div>`;
      }).join("");
      return `
        <div style="margin-bottom:6px;">
          <div style="color:#C9A84C;font-size:.78rem;margin-bottom:2px;">${g.name}</div>
          ${rows}
          <div style="display:flex;justify-content:space-between;align-items:center;padding-top:2px;">
            <span style="color:#9A8462;font-size:.78rem;">总计</span>
            <span style="font-size:.82rem;white-space:nowrap;color:${total >= 0 ? "#E5BA25" : "#7AAB6A"};">
              ${LimbusMerchantSheet.eyeHtml(Math.abs(total))}</span>
          </div>
        </div>`;
    }).join("");

    return `
      <div class="limbus-clash-card" data-clash-type="trade">
        <div style="display:flex;align-items:center;gap:10px;">
          <img src="${merchant.img}" style="width:55px;height:55px;object-fit:cover;
               border:1px solid #5F3E22;border-radius:3px;flex:0 0 55px;" alt="">
          <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
            <b style="color:#E8C9A2;">【${merchant.name}】</b>
            <span style="color:#C9A84C;font-size:.78rem;">${title}</span>
          </div>
        </div>
        ${gold}
        ${blocks}
      </div>`;
  }

  /**
   * 同一个商人的连续交易共用一条聊天信息：
   * 第一笔立刻发卡，之后 30 秒内所有 PL 在这个商人处的买/卖都往这条卡里追加
   * （按 PL 分组，各自带总计）。计时器每笔刷新，停手满 30 秒才结束会话。
   */
  static _scheduleTradeMsg(kind, merchant, char, name, img, price, qty = 1) {
    const key  = `${merchant.id}`;
    const sess = LimbusMerchantSheet._chatSessions.get(key)
      ?? { items: [], msgId: null, busy: false, rendered: 0 };
    sess.items.push({ kind, name, img, price, qty, charId: char.id, charName: char.name });
    LimbusMerchantSheet._chatSessions.set(key, sess);

    clearTimeout(LimbusMerchantSheet._chatTimers.get(key));
    LimbusMerchantSheet._chatTimers.set(key, setTimeout(() => {
      LimbusMerchantSheet._chatSessions.delete(key);
      LimbusMerchantSheet._chatTimers.delete(key);
    }, 30000));

    LimbusMerchantSheet._syncTradeMsg(key, merchant);
  }

  /** 串行化建卡/改卡，避免同一会话里两笔并发各建一张卡 */
  static async _syncTradeMsg(key, merchant) {
    const sess = LimbusMerchantSheet._chatSessions.get(key);
    if (!sess || sess.busy) return;   // 正在写的那一趟结束后会自己补上
    sess.busy = true;
    try {
      // 每一趟都以「当前全部条目」重建，写完发现又多了就再来一趟
      while (sess.rendered !== sess.items.length) {
        const n = sess.items.length;
        const content = LimbusMerchantSheet._buildTradeChatContent({
          merchant, items: sess.items.slice(0, n),
        });
        const msg = sess.msgId ? game.messages.get(sess.msgId) : null;
        if (msg) await msg.update({ content });
        else {
          const created = await ChatMessage.create({ content });
          sess.msgId = created?.id ?? null;
        }
        sess.rendered = n;
      }
    } finally {
      sess.busy = false;
    }
  }

  /* ─── 价格 ───────────────────────────────────────────────────────────── */

  /** 折扣只作用于买入；rate 以「折」计（10 = 原价） */
  static buyPriceOf(merchant, placement) {
    const base = placement?.price ?? 0;
    const sale = merchant?.system?.sale ?? {};
    if (!sale.enabled) return base;
    return Math.max(1, Math.round(base * (sale.rate ?? 10) / 10));
  }
  /** 物品的基础价格：物品卡上「眼」那一栏（cost-display 显示的就是它） */
  static baseCostOf(item) {
    return item?.system?.cost ?? 0;
  }
  /** 回收价固定半价，不吃折扣——压低回收价只会让人不想卖 */
  static sellPriceOf(item) {
    return Math.floor(LimbusMerchantSheet.baseCostOf(item) / 2);
  }

  /* ─── getData ────────────────────────────────────────────────────────── */

  async getData(options = {}) {
    const ctx   = await super.getData(options);
    const actor = this.actor;
    const sys   = actor.system;
    const isGM  = game.user.isGM;

    ctx.isGM         = isGM;
    ctx.editUnlocked = this._editUnlocked;
    ctx.system       = sys;
    ctx.multi        = this._multi;
    ctx.saleRateLabel = `${sys.sale?.rate ?? 10} 折`;
    ctx.eyeIcon      = EYE_ICON;
    ctx.tokenImg     = actor.prototypeToken?.texture?.src || actor.img;

    // ── 左：当前玩家主控角色的背包 ──────────────────────────────────────
    // GM 通常拥有全部角色，回退查找只对玩家生效，避免 GM 随机显示一个角色
    const myChar = game.user.character
      ?? (isGM ? null : game.actors.find(a => a.type === "character" && a.isOwner));
    if (myChar) {
      const items = getBagItems(myChar);
      const { tiles, rows, cells, usedCells } =
        packBagGrid(items, BAG_COLS, BAG_ROWS, myChar.system?.bagLayout ?? []);
      for (const t of tiles) {
        const doc = myChar.items.get(t.id);
        t.showQty   = hasQty(doc) && (doc?.system?.quantity ?? 1) > 1;
        t.quantity  = doc?.system?.quantity ?? 1;
        t.sellPrice = LimbusMerchantSheet.sellPriceOf(doc);
        t.selected  = this._sel.has(`bag:${t.id}`);
      }
      this._charGrid = { tiles, rows, actorId: myChar.id };
      ctx.myChar = {
        id: myChar.id, name: myChar.name, img: myChar.img,
        currency: myChar.system?.currency ?? 0,
        tiles, rows, cells, cols: BAG_COLS, used: usedCells,
      };
    } else {
      this._charGrid = null;
      ctx.myChar = null;
    }

    // ── 右：货架 ────────────────────────────────────────────────────────
    const cols = Math.max(1, sys.shelfSize?.width  ?? SHELF_COLS);
    const rows = Math.max(1, sys.shelfSize?.height ?? SHELF_ROWS);
    ctx.shelfCols = cols;
    ctx.shelfRows = rows;

    const placements = sys.shelfContents ?? [];
    const { placedItems, allCells, orphanedIndices } =
      await buildPlacementGrid(placements, { cols, rows, keepOrphanOccupancy: true });

    // 孤儿条目（物品被删了但摆放记录还在）：GM 端延迟清掉，defer 出本次 getData
    if (orphanedIndices.length && isGM) {
      const dead = new Set(orphanedIndices);
      setTimeout(() => this.actor.update({
        "system.shelfContents": placements.filter((_, i) => !dead.has(i)),
      }), 0);
    }

    const purse = ctx.myChar?.currency ?? 0;
    ctx.shelfItems = placedItems.map(p => {
      const doc  = actor.items.get(String(p.uuid ?? "").split(".").pop());
      const pl   = placements[p.idx] ?? {};
      const base = pl.price ?? 0;
      const buy  = LimbusMerchantSheet.buyPriceOf(actor, pl);
      const show = !this._catFilter || doc?.type === this._catFilter;
      return {
        ...p,
        // buildPlacementGrid 把名字/图标放在 entry.item 下，摊平给模板
        name: p.item?.name ?? "", img: p.item?.img ?? "",
        basePrice: base, buyPrice: buy,
        discounted: buy !== base,
        affordable: buy <= purse,
        showQty:  hasQty(doc) && (doc?.system?.quantity ?? 1) > 1,
        quantity: doc?.system?.quantity ?? 1,
        selected: this._sel.has(`shop:${p.idx}`),
        show,
      };
    });
    ctx.shelfCells = allCells;
    ctx.catFilters = CAT_FILTERS.map(c => ({ ...c, on: c.key === this._catFilter }));

    const n = this._sel.size;
    ctx.selInfo = this._multi
      ? (n ? `已选 ${n} 件（两边都能选）` : "点击图块选择，两边都能选")
      : "双击商品可单件买卖";

    return ctx;
  }

  /* ─── 监听 ───────────────────────────────────────────────────────────── */

  activateListeners(html) {
    super.activateListeners(html);

    const isGM = game.user.isGM;

    // GM 编辑锁
    html.find(".sheet-lock-toggle").on("click", () => {
      this._editUnlocked = !this._editUnlocked;
      this.render(false);
    });

    // 解锁后：点 Token 图换图（立绘走 data-edit="img" 的原生流程）
    html.find(".mc-token-edit").on("click", (ev) => {
      ev.preventDefault();
      const cur = this.actor.prototypeToken?.texture?.src || "";
      const FP  = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
      new FP({
        type: "image", current: cur,
        callback: (path) => this.actor.update({ "prototypeToken.texture.src": path }),
      }).browse(cur);
    });

    // 折扣
    html.find(".mc-sale-toggle").on("click", async () => {
      await this.actor.update({ "system.sale.enabled": !(this.actor.system.sale?.enabled) });
    });
    html.find(".mc-sale-rate").on("change", async (ev) => {
      await this.actor.update({ "system.sale.rate": Number(ev.currentTarget.value) || 10 });
    });
    // 拖动过程中只更新读数，松手才写库（避免每一像素一次 update）
    html.find(".mc-sale-rate").on("input", (ev) => {
      html.find(".mc-sale-num").text(`${ev.currentTarget.value} 折`);
    });

    // 搜索 / 分类
    html.find(".mc-cat").on("click", (ev) => {
      this._catFilter = ev.currentTarget.dataset.cat ?? "";
      this.render(false);
    });

    // 多选
    html.find(".mc-multi-toggle").on("click", () => {
      this._multi = !this._multi;
      this._sel.clear();
      this.render(false);
    });
    html.find(".mc-clear-sel").on("click", () => { this._sel.clear(); this.render(false); });
    html.find(".mc-trade-btn").on("click", () => this._onBatchTrade());

    // 图块：点击（多选）/ 双击（买卖或 GM 改价）
    html.find(".mc-tile").on("click", (ev) => {
      if (!this._multi) return;
      const el = ev.currentTarget;
      const key = el.dataset.side === "shop"
        ? `shop:${el.dataset.placementIdx}` : `bag:${el.dataset.itemId}`;
      this._sel.has(key) ? this._sel.delete(key) : this._sel.add(key);
      this.render(false);
    });
    html.find(".mc-tile").on("dblclick", (ev) => {
      if (this._multi) return;
      const el = ev.currentTarget;
      if (el.dataset.side === "shop") {
        const idx = parseInt(el.dataset.placementIdx ?? "-1");
        if (isGM) this._onGMEditListing(idx);
        else      this._onBuy(idx);
      } else {
        this._onSell(el.dataset.itemId);
      }
    });

    // 悬停 Title 卡
    html.find(".mc-tile").on("mouseenter", this._onTileHover.bind(this));
    html.find(".mc-tile").on("mouseleave", () => this._closeTitleCard());
    html.find(".mc-tile").on("mousedown", (ev) => {
      if (ev.button === 1) { ev.preventDefault(); toggleTitleCardLock(this._titleCard); }
    });

    // ── 网格拖放 ────────────────────────────────────────────────────────
    const bagRoot   = html.find(".mc-cg--bag")[0];
    const shelfRoot = html.find(".mc-cg--shop")[0];

    if (bagRoot && this._charGrid) {
      const grid  = this._charGrid;
      const owner = game.actors.get(grid.actorId);
      html.find(".mc-cg--bag .cg-cell").on("dragover", (ev) => ev.preventDefault());
      html.find(".mc-cg--bag .cg-cell").on("drop", this._onBagDrop.bind(this));
      GridDnD.register(bagRoot, {
        key:        `merchantBag:${owner?.uuid ?? grid.actorId}`,
        cols:       BAG_COLS,
        rows:       grid.rows ?? BAG_ROWS,
        editable:   () => !!owner?.isOwner && !this._multi,
        placements: () => (grid.tiles ?? []).map(t => ({ x: t.x, y: t.y, w: t.w, h: t.h })),
        payloadFor: (tile) => {
          const t = (grid.tiles ?? []).find(x => x.uuid === tile.dataset.itemUuid);
          if (!t) return null;
          return {
            type: "Item", uuid: t.uuid,
            x: t.x, y: t.y, w: t.w, h: t.h,
            fromBag: { actorId: grid.actorId, itemId: t.id },
          };
        },
      });
    }

    if (shelfRoot) {
      html.find(".mc-cg--shop .cg-cell").on("dragover", (ev) => ev.preventDefault());
      html.find(".mc-cg--shop .cg-cell").on("drop", this._onShelfDrop.bind(this));
      GridDnD.register(shelfRoot, {
        key:        `merchantShelf:${this.actor.uuid}`,
        cols:       this.actor.system.shelfSize?.width  ?? 8,
        rows:       this.actor.system.shelfSize?.height ?? 5,
        // 玩家动不了货架：不可编辑 → 货架图块拖不起来（这就是"只能移动自己的物品"）
        editable:   () => isGM && !this._multi,
        placements: () => this.actor.system.shelfContents ?? [],
        payloadFor: (tile) => {
          if (!isGM) return null;
          const idx = parseInt(tile.dataset.placementIdx ?? "-1");
          const p   = this.actor.system.shelfContents?.[idx];
          if (idx < 0 || !p) return null;
          return {
            type: "Item", uuid: p.uuid,
            x: p.x, y: p.y, w: p.w ?? 1, h: p.h ?? 1,
            fromShelf: { merchantId: this.actor.id, placementIdx: idx },
          };
        },
      });
    }

    if (isGM && this._editUnlocked) html.find(".cg-wrap").addClass("cg-edit-unlocked");
  }

  /* ─── 悬停预览 ───────────────────────────────────────────────────────── */

  async _onTileHover(event) {
    this._closeTitleCard();
    const uuid = event.currentTarget.dataset.itemUuid;
    const item = uuid ? await fromUuid(uuid).catch(() => null) : null;
    if (!item) return;
    const card = buildItemTitleCard(item);
    if (!card) return;
    const r = event.currentTarget.getBoundingClientRect();
    card.css({ position: "fixed", left: `${r.right + 8}px`, top: `${r.top}px`, zIndex: 200 });
    $("body").append(card);
    this._titleCard = card;
  }
  _closeTitleCard() { this._titleCard?.remove?.(); this._titleCard = null; }
  async close(options) { this._closeTitleCard(); return super.close(options); }

  /* ─── 拖放落点 ───────────────────────────────────────────────────────── */

  /** 落在背包格：自家挪位（货架 → 背包不走拖拽，买必须经过弹窗） */
  async _onBagDrop(event) {
    event.preventDefault(); event.stopPropagation();
    let raw; try { raw = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain")); } catch { return; }
    const grid = this._charGrid;
    if (!grid || raw?.fromBag?.actorId !== grid.actorId) return;

    const actor = game.actors.get(grid.actorId);
    const item  = actor?.items.get(raw.fromBag.itemId);
    if (!actor?.isOwner || !item) return;

    const x = raw.dropX ?? parseInt(event.currentTarget.dataset.x ?? 0);
    const y = raw.dropY ?? parseInt(event.currentTarget.dataset.y ?? 0);
    const layout = foundry.utils.deepClone(actor.system.bagLayout ?? []);
    const entry  = layout.find(e => e.itemId === item.id) ?? null;
    const rot    = raw.rotatePending ? !(entry?.rotated ?? false) : (entry?.rotated ?? false);
    const cap    = item.system?.capacity ?? {};
    const w = Math.max(1, rot ? (cap.h ?? 1) : (cap.w ?? 1));
    const h = Math.max(1, rot ? (cap.w ?? 1) : (cap.h ?? 1));
    const others = (grid.tiles ?? []).filter(t => t.id !== item.id)
      .map(t => ({ x: t.x, y: t.y, w: t.w, h: t.h }));
    if (!canPlace(others, x, y, w, h, BAG_COLS, grid.rows ?? BAG_ROWS)) {
      return void ui.notifications.warn("此位置放不下（越界或与其他物品重叠）");
    }
    if (entry) { entry.x = x; entry.y = y; entry.rotated = rot; }
    else       layout.push({ itemId: item.id, x, y, rotated: rot });
    await actor.update({ "system.bagLayout": layout });
  }

  /** 落在货架格：自家物品 → 出售；GM 拖货架内物品 → 挪位；GM 外部拖入 → 上架 */
  async _onShelfDrop(event) {
    event.preventDefault(); event.stopPropagation();
    let raw; try { raw = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain")); } catch { return; }
    const x = raw.dropX ?? parseInt(event.currentTarget.dataset.x ?? 0);
    const y = raw.dropY ?? parseInt(event.currentTarget.dataset.y ?? 0);

    // ① 玩家出售
    if (raw?.fromBag?.actorId) return void this._onSell(raw.fromBag.itemId, { x, y });

    // ② GM：货架内挪位
    if (raw?.fromShelf?.merchantId === this.actor.id) {
      if (!game.user.isGM) return;
      const idx  = raw.fromShelf.placementIdx;
      const list = foundry.utils.deepClone(this.actor.system.shelfContents ?? []);
      const p    = list[idx];
      if (!p) return;
      const rot = raw.rotatePending ? !p.rotated : p.rotated;
      const w = rot === p.rotated ? p.w : p.h;
      const h = rot === p.rotated ? p.h : p.w;
      if (!canPlace(list, x, y, w, h,
            this.actor.system.shelfSize?.width ?? SHELF_COLS,
            this.actor.system.shelfSize?.height ?? SHELF_ROWS, { excludeIdx: idx })) {
        return void ui.notifications.warn("此位置放不下（越界或与其他商品重叠）");
      }
      list[idx] = { ...p, x, y, w, h, rotated: rot };
      return void await this.actor.update({ "system.shelfContents": list });
    }

    // ③ GM：从侧栏/合集包拖入 → 上架
    if (!game.user.isGM) return;
    const doc = raw?.uuid ? await fromUuid(raw.uuid).catch(() => null) : null;
    if (!doc || doc.documentName !== "Item") return;
    await this._listItem(doc, x, y);
  }

  /** GM：把一件物品放上货架（复制成商人的嵌入物品） */
  async _listItem(srcItem, x, y) {
    const cols = this.actor.system.shelfSize?.width  ?? SHELF_COLS;
    const rows = this.actor.system.shelfSize?.height ?? SHELF_ROWS;
    const cap  = srcItem.system?.capacity ?? {};
    const w = Math.max(1, cap.w ?? 1), h = Math.max(1, cap.h ?? 1);
    const list = foundry.utils.deepClone(this.actor.system.shelfContents ?? []);

    // autoPlace 返回的 w/h 已经是旋转后的尺寸，直接用，别再自己换算
    let spot = canPlace(list, x, y, w, h, cols, rows)
      ? { x, y, w, h, rotated: false }
      : autoPlace(list, w, h, cols, rows);
    if (!spot) return void ui.notifications.warn("货架放不下了");

    const data = srcItem.toObject();
    delete data._id;
    const [made] = await this.actor.createEmbeddedDocuments("Item", [data]);
    if (!made) return;
    list.push({
      uuid: made.uuid, x: spot.x, y: spot.y, w: spot.w, h: spot.h,
      rotated: !!spot.rotated,
      // GM 拖入默认取物品卡上的基础价格（cost），之后可双击手动改
      price: LimbusMerchantSheet.baseCostOf(srcItem),
    });
    await this.actor.update({ "system.shelfContents": list });
  }

  /** 侧栏原生拖放（Foundry 的默认入口，落到面板空白处时也能上架） */
  async _onDropItem(event, data) {
    if (!game.user.isGM) return;
    const item = await Item.fromDropData(data);
    if (!item) return;
    await this._listItem(item, 0, 0);
  }

  /* ─── 买 / 卖 ────────────────────────────────────────────────────────── */

  _myChar() {
    return game.user.character
      ?? (game.user.isGM ? null : game.actors.find(a => a.type === "character" && a.isOwner));
  }

  async _onBuy(placementIdx) {
    const char = this._myChar();
    if (!char) return void ui.notifications.warn("没有主控角色，无法购买。");
    const p    = this.actor.system.shelfContents?.[placementIdx];
    const item = p ? this.actor.items.get(String(p.uuid).split(".").pop()) : null;
    if (!item) return;

    const unit = LimbusMerchantSheet.buyPriceOf(this.actor, p);
    const max  = hasQty(item) ? (item.system?.quantity ?? 1) : 1;
    const qty  = await this._askQty({
      title: "购买", item, unitLabel: this.actor.system.sale?.enabled
        ? `单价（${this.actor.system.sale.rate} 折）` : "单价",
      unit, max, purse: char.system?.currency ?? 0, mode: "buy",
    });
    if (!qty) return;
    this._send({ type: "merchantBuy", merchantId: this.actor.id, charId: char.id,
                 placementIdx, qty, userId: game.user.id });
  }

  async _onSell(itemId, dropAt = null) {
    const char = this._myChar();
    const item = char?.items.get(itemId);
    if (!char || !item) return;
    const unit = LimbusMerchantSheet.sellPriceOf(item);
    if (unit <= 0) return void ui.notifications.warn(`「${item.name}」没有定价，无法出售。`);

    const max = hasQty(item) ? (item.system?.quantity ?? 1) : 1;
    const qty = await this._askQty({
      title: "出售", item, unitLabel: "回收单价", unit, max,
      purse: this.actor.system.merchantCurrency ?? 0, mode: "sell",
    });
    if (!qty) return;
    this._send({ type: "merchantSell", merchantId: this.actor.id, charId: char.id,
                 itemId, qty, dropAt, userId: game.user.id });
  }

  /** 数量 / 确认弹窗；没有数量概念的物品直接只问确认 */
  async _askQty({ title, item, unitLabel, unit, max, purse, mode }) {
    const buy = mode === "buy";
    const qtyRow = max > 1 ? `
      <div style="display:flex;align-items:center;gap:8px;margin:8px 0 4px;">
        <span>数量</span>
        <input type="range" name="qty" min="1" max="${max}" value="1" style="flex:1;">
        <b class="mc-qty-n" style="width:34px;text-align:right;">1</b>
      </div>` : "";
    const content = `
      <div class="limbuscompany" style="font-size:.85rem;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <img src="${item.img}" style="width:34px;height:34px;object-fit:cover;border:1px solid #5F3E22;" alt="">
          <b>${item.name}</b>
        </div>
        <div style="display:flex;justify-content:space-between;"><span>${unitLabel}</span>
          <span>${LimbusMerchantSheet.eyeHtml(unit)}</span></div>
        ${qtyRow}
        <div style="display:flex;justify-content:space-between;margin-top:4px;">
          <span>${buy ? "合计支出" : "合计收入"}</span>
          <span class="mc-total">${LimbusMerchantSheet.eyeHtml(unit)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;color:#9A8462;">
          <span>${buy ? "交易后持有" : "商人余额"}</span>
          <span class="mc-after">${LimbusMerchantSheet.eyeHtml(purse - unit)}</span>
        </div>
      </div>`;

    return new Promise(resolve => {
      const dlg = new Dialog({
        title: `${title}：${item.name}`,
        content,
        buttons: {
          ok: { label: title, callback: (html) => resolve(parseInt(html.find("[name=qty]").val() ?? "1") || 1) },
          no: { label: "取消", callback: () => resolve(0) },
        },
        default: "ok",
        close: () => resolve(0),
        render: (html) => {
          const upd = () => {
            const n = parseInt(html.find("[name=qty]").val() ?? "1") || 1;
            const total = unit * n;
            html.find(".mc-qty-n").text(n);
            html.find(".mc-total").html(LimbusMerchantSheet.eyeHtml(total));
            html.find(".mc-after").html(LimbusMerchantSheet.eyeHtml(purse - total));
            const bad = total > purse;
            html.find(".mc-total").css("color", bad ? "#E94745" : "");
            // Foundry 的 Dialog 按钮带 data-button，别按 class 找
            $(html).closest(".app").find('[data-button="ok"]').prop("disabled", bad);
          };
          html.find("[name=qty]").on("input", upd);
          upd();
        },
      });
      dlg.render(true);
    });
  }

  /* ─── 一键买卖 ───────────────────────────────────────────────────────── */

  async _onBatchTrade() {
    const char = this._myChar();
    if (!char) return void ui.notifications.warn("没有主控角色。");

    const buys = [], sells = [];
    for (const key of this._sel) {
      const [side, id] = key.split(":");
      if (side === "shop") {
        const idx = parseInt(id);
        const p   = this.actor.system.shelfContents?.[idx];
        const doc = p ? this.actor.items.get(String(p.uuid).split(".").pop()) : null;
        if (doc) buys.push({ idx, doc, qty: hasQty(doc) ? (doc.system?.quantity ?? 1) : 1,
                             unit: LimbusMerchantSheet.buyPriceOf(this.actor, p) });
      } else {
        const doc = char.items.get(id);
        if (doc) sells.push({ id, doc, qty: hasQty(doc) ? (doc.system?.quantity ?? 1) : 1,
                              unit: LimbusMerchantSheet.sellPriceOf(doc) });
      }
    }
    if (!buys.length && !sells.length) return;

    const cost   = buys .reduce((a, i) => a + i.unit * i.qty, 0);
    const income = sells.reduce((a, i) => a + i.unit * i.qty, 0);
    const net    = cost - income;
    const purse  = char.system?.currency ?? 0;
    const rows = (list, color) => list.map(i => `
      <div style="display:flex;justify-content:space-between;padding:1px 0;">
        <span>${i.doc.name}${i.qty > 1 ? ` ×${i.qty}` : ""}</span>
        <b style="color:${color}">${i.unit * i.qty}</b></div>`).join("");

    const ok = await Dialog.confirm({
      title: "一键买卖",
      content: `<div class="limbuscompany" style="font-size:.85rem;">
        ${buys.length  ? `<div style="color:#C9A84C;">买入</div>${rows(buys,  "#E5BA25")}` : ""}
        ${sells.length ? `<div style="color:#C9A84C;margin-top:4px;">卖出</div>${rows(sells, "#7AAB6A")}` : ""}
        <div style="display:flex;justify-content:space-between;margin-top:6px;
                    border-top:1px solid rgba(201,168,76,.35);padding-top:4px;">
          <span>${net >= 0 ? "净支出" : "净收入"}</span>
          <span>${LimbusMerchantSheet.eyeHtml(Math.abs(net))}</span></div>
        <div style="display:flex;justify-content:space-between;color:${net > purse ? "#E94745" : "#9A8462"};">
          <span>交易后持有</span><span>${LimbusMerchantSheet.eyeHtml(purse - net)}</span></div>
      </div>`,
    });
    if (!ok) return;
    if (net > purse) return void ui.notifications.warn("眼不够，交易取消。");

    // 先卖后买：卖完手里有钱，买得起的概率更高
    for (const s of sells) {
      this._send({ type: "merchantSell", merchantId: this.actor.id, charId: char.id,
                   itemId: s.id, qty: s.qty, dropAt: null, userId: game.user.id });
    }
    // 买入按 placementIdx 从大到小送，GM 端按序删除时下标不会互相错位
    for (const b of buys.sort((a, c) => c.idx - a.idx)) {
      this._send({ type: "merchantBuy", merchantId: this.actor.id, charId: char.id,
                   placementIdx: b.idx, qty: b.qty, userId: game.user.id });
    }
    this._sel.clear();
  }

  /* ─── GM：改价 / 改数量 / 下架 ───────────────────────────────────────── */

  async _onGMEditListing(idx) {
    const list = this.actor.system.shelfContents ?? [];
    const p    = list[idx];
    const item = p ? this.actor.items.get(String(p.uuid).split(".").pop()) : null;
    if (!item) return;
    const qtyRow = hasQty(item) ? `
      <div class="form-group"><label>数量</label>
        <input type="number" name="qty" min="1" value="${item.system?.quantity ?? 1}"></div>` : "";

    new Dialog({
      title: `GM · ${item.name}`,
      content: `<form class="limbuscompany">
        <div class="form-group"><label>原价（眼）</label>
          <input type="number" name="price" min="0" step="5" value="${p.price ?? 0}"></div>
        ${qtyRow}
      </form>`,
      buttons: {
        save: {
          label: "保存",
          callback: async (html) => {
            const price = Math.max(0, parseInt(html.find("[name=price]").val()) || 0);
            const next  = foundry.utils.deepClone(this.actor.system.shelfContents ?? []);
            if (next[idx]) next[idx].price = price;
            await this.actor.update({ "system.shelfContents": next });
            const q = html.find("[name=qty]").val();
            if (q != null) await item.update({ "system.quantity": Math.max(1, parseInt(q) || 1) });
          },
        },
        remove: {
          label: "下架",
          callback: async () => {
            const next = (this.actor.system.shelfContents ?? []).filter((_, i) => i !== idx);
            await this.actor.update({ "system.shelfContents": next });
            await item.delete();
          },
        },
      },
      default: "save",
    }).render(true);
  }

  /* ─── socket：玩家端只发消息，GM 端权威执行 ─────────────────────────── */

  _send(msg) {
    if (game.user.isGM) return void LimbusMerchantSheet.handleSocketMsg(msg);
    game.socket.emit("system.limbusCompany_FVTT", msg);
  }

  static async handleSocketMsg(msg) {
    if (!game.user.isGM) return;
    if (msg?.type !== "merchantBuy" && msg?.type !== "merchantSell") return;
    if (!msg.merchantId) return;
    LimbusMerchantSheet._enqueue(msg.merchantId, () =>
      msg.type === "merchantBuy"
        ? LimbusMerchantSheet._gmBuy(msg)
        : LimbusMerchantSheet._gmSell(msg));
  }

  static _fail(userId, text) {
    ChatMessage.create({
      content: `<div class="limbuscompany chat-clash">${text}</div>`,
      whisper: [userId],
    });
  }

  static async _gmBuy({ merchantId, charId, placementIdx, qty = 1, userId }) {
    const merchant = game.actors.get(merchantId);
    const char     = game.actors.get(charId);
    if (!merchant || !char) return;
    const list = foundry.utils.deepClone(merchant.system.shelfContents ?? []);
    const p    = list[placementIdx];
    const item = p ? merchant.items.get(String(p.uuid).split(".").pop()) : null;
    if (!item) return void LimbusMerchantSheet._fail(userId, "商品已经不在货架上了。");

    const per   = hasQty(item);
    const stock = per ? (item.system?.quantity ?? 1) : 1;
    const n     = Math.max(1, Math.min(qty, stock));
    const unit  = LimbusMerchantSheet.buyPriceOf(merchant, p);
    const total = unit * n;
    const purse = char.system?.currency ?? 0;
    if (purse < total) {
      return void LimbusMerchantSheet._fail(userId, `眼不足（需要 ${total}，持有 ${purse}）。`);
    }

    await char.update({ "system.currency": purse - total });
    await merchant.update({
      "system.merchantCurrency": (merchant.system.merchantCurrency ?? 0) + total,
    });

    const data = item.toObject();
    delete data._id;
    if (per) data.system.quantity = n;
    await char.createEmbeddedDocuments("Item", [data]);

    // 有数量的扣数量、扣完下架；没数量的一件即一件，直接下架
    if (per && stock > n) {
      await item.update({ "system.quantity": stock - n });
    } else {
      await merchant.update({
        "system.shelfContents": list.filter((_, i) => i !== placementIdx),
      });
      await item.delete();
    }
    LimbusMerchantSheet._scheduleTradeMsg("buy", merchant, char, item.name, item.img, unit, n);
  }

  static async _gmSell({ merchantId, charId, itemId, qty = 1, dropAt, userId }) {
    const merchant = game.actors.get(merchantId);
    const char     = game.actors.get(charId);
    const item     = char?.items.get(itemId);
    if (!merchant || !char || !item) return;

    const per   = hasQty(item);
    const have  = per ? (item.system?.quantity ?? 1) : 1;
    const n     = Math.max(1, Math.min(qty, have));
    const unit  = LimbusMerchantSheet.sellPriceOf(item);
    const total = unit * n;
    if (unit <= 0) return void LimbusMerchantSheet._fail(userId, "该物品没有定价，无法出售。");
    const mPurse = merchant.system.merchantCurrency ?? 0;
    if (mPurse < total) {
      return void LimbusMerchantSheet._fail(userId, `商人资金不足（${mPurse} 眼），收不下。`);
    }

    const cols = merchant.system.shelfSize?.width  ?? SHELF_COLS;
    const rows = merchant.system.shelfSize?.height ?? SHELF_ROWS;
    const list = foundry.utils.deepClone(merchant.system.shelfContents ?? []);
    const cap  = item.system?.capacity ?? {};
    const w = Math.max(1, cap.w ?? 1), h = Math.max(1, cap.h ?? 1);

    const spot = dropAt && canPlace(list, dropAt.x, dropAt.y, w, h, cols, rows)
      ? { x: dropAt.x, y: dropAt.y, w, h, rotated: false }
      : autoPlace(list, w, h, cols, rows);
    if (!spot) return void LimbusMerchantSheet._fail(userId, "货架放不下了。");

    // 结算
    await char.update({ "system.currency": (char.system?.currency ?? 0) + total });
    await merchant.update({ "system.merchantCurrency": mPurse - total });

    const name = item.name, img = item.img;
    const data = item.toObject();
    delete data._id;
    if (per) data.system.quantity = n;
    const [made] = await merchant.createEmbeddedDocuments("Item", [data]);

    if (per && have > n) await item.update({ "system.quantity": have - n });
    else await item.delete();

    list.push({
      uuid: made.uuid, x: spot.x, y: spot.y, w: spot.w, h: spot.h,
      rotated: !!spot.rotated,
      // 上架原价 = 回收价：玩家想反悔就按原样买回来，不亏不赚
      price: unit,
    });
    await merchant.update({ "system.shelfContents": list });
    LimbusMerchantSheet._scheduleTradeMsg("sell", merchant, char, name, img, unit, n);
  }
}
