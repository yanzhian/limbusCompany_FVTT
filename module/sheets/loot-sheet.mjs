/**
 * loot-sheet.mjs — 战利品 Actor Sheet（宝箱：物品单向流向玩家角色）
 *
 * 两种视角：
 *   GM      → 编辑锁控制：拖入物品、调整网格尺寸、编辑/填充货币；
 *             右栏"战利品清单"：拖入随机表(RollTable)/物品快速建表，
 *             底部【补充战利品】按权重随机抽取 N 次填充网格
 *   玩家    → 双击剪影揭晓物品（揭晓中不可拾取），揭晓后双击确认
 *             放入自己的角色背包；右键菜单可部分取出；货币【拿走】【一键平分】
 *
 * 玩家操作均通过 socket 委托 GM 执行，保证数据一致性。
 * socket 消息类型：lootTakeItem / lootTakeCurrency / lootSplitCurrency /
 *                lootMoveItem / lootRevealItem
 */
import { buildItemTitleCard, closeTitleCardUnlessLocked, toggleTitleCardLock } from "./item-sheet.mjs";
import { buildPlacementGrid, canPlace, autoPlace } from "../helpers/grid-layout.mjs";

export class LimbusLootSheet extends ActorSheet {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes:   ["limbuscompany", "sheet", "actor", "loot"],
      template:  "systems/limbusCompany_FVTT/templates/actor/loot-sheet.hbs",
      width:     game.user?.isGM ? 700 : 400,
      height:    520,
      resizable: true,
      scrollY:   [".loot-grid-wrap", ".loot-table-list"],
    });
  }

  /* ─── 状态 ─────────────────────────────────────────────────────────────── */

  /** GM 编辑锁 */
  _editUnlocked = false;

  /** 揭示动画版本号（每次调用 _maybePlayReveal 自增，用于取消旧动画） */
  _revealId = 0;

  /** 每个战利品 Actor 的操作串行队列（防竞态） */
  static _opQueues = new Map();

  /**
   * 聊天消息实时聚合器
   * key: `${charId}_${lootActorId}`
   * value: { playerChar, lootActor, items, msg, chain }
   *
   * 策略：第一件物品立即创建聊天消息；后续物品通过 update() 追加到同一条消息。
   * 30 秒无新取出操作后清理会话，下次取出重新开始新消息。
   */
  static _chatSessions = new Map();
  static _chatTimers   = new Map();

  /** 构建聊天消息 HTML 内容（相同物品合并计数，商人交易卡同款风格） */
  static _buildLootChatContent({ playerChar, lootActor, items }) {
    // 按物品名称合并数量
    const merged = [];
    const seen   = new Map(); // name -> index in merged
    for (const i of items) {
      if (seen.has(i.name)) {
        merged[seen.get(i.name)].qty += i.qty;
      } else {
        seen.set(i.name, merged.length);
        merged.push({ ...i });
      }
    }
    const rows = merged.map(i => `
      <div class="purchase-item-row">
        <img src="${i.img}" class="purchase-item-icon" alt="${i.name}">
        <span class="purchase-item-name">${i.name}${i.qty > 1 ? ` ×${i.qty}` : ""}</span>
      </div>`).join("");
    return `
      <div class="limbus-merchant-purchase-card">
        <div class="purchase-header">
          <img src="${lootActor.img}" class="purchase-merchant-img" alt="${lootActor.name}">
          <div class="purchase-title">
            <span class="purchase-name">${playerChar.name}</span>
            <span class="purchase-sub">从战利品【${lootActor.name}】中取出</span>
          </div>
        </div>
        <div class="ic-gold-divider"></div>
        ${rows}
        <div class="ic-gold-divider"></div>
      </div>`;
  }

  /**
   * 记录一次取出操作：首次取出立即创建聊天消息，
   * 后续操作 update 同一条消息追加物品行。
   * 所有异步操作通过 entry.chain 串行化，避免竞态。
   */
  static _scheduleChatMsg(lootActor, playerChar, itemName, itemImg, qty) {
    const key = `${playerChar.id}_${lootActor.id}`;

    let entry = LimbusLootSheet._chatSessions.get(key);
    if (!entry) {
      entry = { playerChar, lootActor, items: [], msg: null, chain: Promise.resolve() };
      LimbusLootSheet._chatSessions.set(key, entry);
    }

    entry.items.push({ name: itemName, img: itemImg, qty });

    // 串行执行：创建或更新消息
    entry.chain = entry.chain.then(async () => {
      const content = LimbusLootSheet._buildLootChatContent(entry);
      if (!entry.msg) {
        entry.msg = await ChatMessage.create({
          content, speaker: ChatMessage.getSpeaker({ actor: entry.playerChar }),
        });
      } else {
        await entry.msg.update({ content });
      }
    });

    // 重置 30s 清理计时器（30s 内无新操作则结束本次会话）
    clearTimeout(LimbusLootSheet._chatTimers.get(key));
    LimbusLootSheet._chatTimers.set(key, setTimeout(() => {
      LimbusLootSheet._chatSessions.delete(key);
      LimbusLootSheet._chatTimers.delete(key);
    }, 30_000));
  }

  /* ─── getData ──────────────────────────────────────────────────────────── */

  /** @override */
  async getData(options = {}) {
    const ctx   = await super.getData(options);
    const actor = this.actor;
    const sys   = actor.system;
    const isGM  = game.user.isGM;

    ctx.isGM         = isGM;
    ctx.editUnlocked = this._editUnlocked;
    ctx.currency     = sys.currency ?? 0;

    const cols = Math.max(1, Math.min(20, sys.gridSize?.width  ?? 5));
    const rows = Math.max(1, Math.min(20, sys.gridSize?.height ?? 5));
    ctx.gridCols      = cols;
    ctx.gridRows      = rows;
    ctx.gridSizeLabel = `${cols} × ${rows}`;

    const { placedItems, allCells } = await this._buildGrid(
      sys.lootContents ?? [], cols, rows
    );
    ctx.placedItems = placedItems;
    ctx.allCells    = allCells;

    // GM 右栏：战利品清单
    ctx.lootTable = (sys.lootTable ?? []).map(e => ({ ...e }));

    return ctx;
  }

  /* ─── 网格构建（算法见 helpers/grid-layout.mjs，与容器 / 仓库共用） ──── */

  async _buildGrid(placements, cols, rows) {
    const { placedItems, allCells, orphanedIndices } = await buildPlacementGrid(placements, {
      cols, rows,
      // 孤儿条目仍占格，保持视觉与碰撞一致
      keepOrphanOccupancy: true,
      // 玩家视角：未揭晓的物品遮蔽名称/图标/数量（剪影 + ???）
      decorate: ({ entry, placement, item }) => {
        const revealed = placement.revealed ?? false;
        const masked   = !revealed && !game.user.isGM;
        entry.revealed = revealed;
        entry.masked   = masked;
        entry.rotated  = placement.rotated && entry.w !== entry.h;
        entry.item     = masked
          ? { id: item.id, name: "???", img: "icons/svg/mystery-man.svg", quantity: null }
          : { id: item.id, name: item.name, img: item.img,
              quantity: item.system?.quantity ?? null };
      },
    });

    // 孤儿条目自动清理（GM 端延迟执行，避免 getData 重入）
    if (orphanedIndices.length > 0 && game.user.isGM) {
      const orphanSet = new Set(orphanedIndices);
      setTimeout(async () => {
        const fresh   = foundry.utils.deepClone(this.actor.system.lootContents ?? []);
        const cleaned = fresh.filter((_, i) => !orphanSet.has(i));
        if (cleaned.length !== fresh.length)
          await this.actor.update({ "system.lootContents": cleaned });
      }, 0);
    }

    return { placedItems, allCells };
  }

  /* ─── 放置检测辅助 ─────────────────────────────────────────────────────── */

  _canPlace(x, y, w, h, cols, rows, excludeIdx = -1) {
    return canPlace(this.actor.system.lootContents ?? [], x, y, w, h, cols, rows, { excludeIdx });
  }

  _autoPlace(w, h) {
    const sys = this.actor.system;
    return autoPlace(
      sys.lootContents ?? [], w, h,
      sys.gridSize?.width ?? 5, sys.gridSize?.height ?? 5
    );
  }

  /* ─── activateListeners ────────────────────────────────────────────────── */

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    const isGM = game.user.isGM;

    // Foundry base class 在 !isEditable（Limited 权限）时禁用所有 button。
    // 玩家的拿走/平分操作不依赖 loot actor 的编辑权限，需手动恢复。
    if (!isGM && !this.isEditable) {
      html.find(".loot-take-currency-btn, .loot-split-currency-btn")
          .prop("disabled", false);
    }

    // ── 网格：拖放（GM 和玩家共用：玩家可在网格内移动） ──────────────────
    html.find(".cg-cell").on("dragover",  this._onCellDragOver.bind(this));
    html.find(".cg-cell").on("dragleave", this._onCellDragLeave.bind(this));
    html.find(".cg-cell").on("drop",      this._onCellDrop.bind(this));

    // ── 图块拖拽（GM 解锁时或玩家均可拖动图块在内部移动） ────────────────
    html.find(".cg-item-tile").on("dragstart",   this._onTileDragStart.bind(this));
    html.find(".cg-item-tile").on("contextmenu", this._onTileContextMenu.bind(this));

    // ── 图块双击：玩家揭晓 / 拾取 ────────────────────────────────────────
    html.find(".cg-item-tile").on("dblclick", this._onTileDblClick.bind(this));

    // ── 图块悬停 Title 卡（未揭晓的玩家视角不显示，避免剧透） ────────────
    html.find(".cg-item-tile").on("mouseenter", this._onTileHoverStart.bind(this));
    html.find(".cg-item-tile").on("mousedown", (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      toggleTitleCardLock(this._lootTitleCard);
    });
    html.find(".cg-item-tile").on("mouseleave", () => this._onTileHoverEnd());

    if (isGM) {
      this._activateGMListeners(html);
    } else {
      this._activatePlayerListeners(html);
    }
  }

  /* ─── 图块悬停 Title 卡 ──────────────────────────────────────────────── */

  async _onTileHoverStart(event) {
    const tile = event.currentTarget;
    // 玩家视角：未揭晓（剪影）不显示 Title 卡
    if (!game.user.isGM && tile.dataset.revealed !== "true") return;

    const seq  = this._lootHoverSeq = (this._lootHoverSeq ?? 0) + 1;
    const uuid = tile.dataset.itemUuid ?? "";
    const item = await fromUuid(uuid).catch(() => null);
    if (!item || seq !== this._lootHoverSeq) return;

    this._onTileHoverEnd(true);
    this._lootTitleCard = buildItemTitleCard(item);
    if (!this._lootTitleCard) return;

    const rect  = this.element[0].getBoundingClientRect();
    const cardW = 280, cardH = 500;
    let left = rect.right + 8;
    if (left + cardW > window.innerWidth - 8) left = rect.left - cardW - 8;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - cardH - 8));
    this._lootTitleCard.css({ position: "fixed", left, top, zIndex: 99998 });
    $("body").append(this._lootTitleCard);
    this._lootTitleCard.on("mouseenter", () => clearTimeout(this._lootCloseTimer));
    this._lootTitleCard.on("mouseleave", () => this._onTileHoverEnd());
  }

  /**
   * @param {boolean} [force=false]  true=立即强制关闭（忽略锁定）；
   *   false=延迟 150ms 软关闭（锁定的卡片会被 closeTitleCardUnlessLocked 拦下）
   */
  _onTileHoverEnd(force = false) {
    if (!force) {
      clearTimeout(this._lootCloseTimer);
      this._lootCloseTimer = setTimeout(() => this._onTileHoverEnd(true), 150);
      return;
    }
    clearTimeout(this._lootCloseTimer);
    this._lootHoverSeq = (this._lootHoverSeq ?? 0) + 1;
    closeTitleCardUnlessLocked(this._lootTitleCard);
    if (!this._lootTitleCard?.data("tcLocked")) this._lootTitleCard = null;
  }

  /* ─── 图块双击：揭晓 / 拾取 ──────────────────────────────────────────── */

  async _onTileDblClick(event) {
    const tile = event.currentTarget;
    const idx  = parseInt(tile.dataset.placementIdx ?? -1);
    const uuid = tile.dataset.itemUuid ?? "";
    if (idx < 0) return;

    // GM 双击：直接打开物品卡
    if (game.user.isGM) {
      const itm = await fromUuid(uuid).catch(() => null);
      itm?.sheet?.render(true);
      return;
    }

    const revealed = tile.dataset.revealed === "true";

    // ── 未揭晓：播放揭晓动画，结束后持久化 revealed ─────────────────────
    if (!revealed) {
      this._revealingSet ??= new Set();
      if (this._revealingSet.has(idx)) return; // 揭晓动画进行中
      this._revealingSet.add(idx);

      const $t = $(tile);
      // 揭晓中：保持剪影 + 旋转 ♻（期间 revealed 仍为 false，无法拾取）
      $t.addClass("loot-tile--searching");
      setTimeout(() => {
        this._revealingSet.delete(idx);
        $t.removeClass("loot-tile--silhouette loot-tile--searching")
          .addClass("loot-tile--revealing");
        game.socket.emit("system.limbusCompany_FVTT", {
          type: "lootRevealItem",
          lootActorId: this.actor.id, placementIdx: idx, itemUuid: uuid,
          userId: game.user.id,
        });
      }, 800);
      return;
    }

    // ── 已揭晓：确认后放入自己的角色背包（全部数量） ────────────────────
    const item = await fromUuid(uuid).catch(() => null);
    if (!item) { ui.notifications.warn("物品不存在，可能已被取走。"); return; }
    const myChar = game.user.character
      ?? game.actors.find(a => a.type === "character" && a.isOwner);
    if (!myChar) { ui.notifications.warn("找不到你的角色，无法拾取。"); return; }

    const qty = item.system?.quantity ?? 1;
    const confirmed = await Dialog.confirm({
      title:   "拾取战利品",
      content: `<p>将 <strong>${item.name}</strong>${qty > 1 ? ` ×${qty}` : ""} 放入 <strong>${myChar.name}</strong> 的背包？</p>`,
    });
    if (!confirmed) return;
    await this._executeItemTake(this.actor.id, uuid, idx, qty);
  }

  _activateGMListeners(html) {
    // 编辑锁切换
    html.find(".loot-lock-toggle").on("click", () => {
      this._editUnlocked = !this._editUnlocked;
      this.render(false);
    });

    if (this._editUnlocked) {
      html.find(".cg-wrap").addClass("cg-edit-unlocked");

      // 网格尺寸修改
      html.find(".loot-grid-dim").on("change", async (e) => {
        const axis = e.currentTarget.dataset.axis;
        const val  = Math.max(1, Math.min(20, parseInt(e.currentTarget.value) || 5));
        await this.actor.update({ [`system.gridSize.${axis}`]: val });
      });

      // 旋转按钮
      html.find(".cg-rotate-btn").on("click", this._onTileRotate.bind(this));
    }

    // 填充货币按钮
    html.find(".loot-fill-btn").on("click", () => this._onFillCurrency());

    // ── 战利品清单（右栏） ──────────────────────────────────────────────
    const panel = html.find(".loot-table-panel");
    panel.on("dragover", (e) => { e.preventDefault(); panel.addClass("cg-drag-over"); });
    panel.on("dragleave", () => panel.removeClass("cg-drag-over"));
    panel.on("drop", this._onLootTableDrop.bind(this));

    // 条目权重编辑
    html.find(".loot-table-weight").on("change", async (e) => {
      const id     = e.currentTarget.closest("[data-entry-id]")?.dataset.entryId;
      const weight = Math.max(0, parseInt(e.currentTarget.value) || 0);
      const table  = foundry.utils.deepClone(this.actor.system.lootTable ?? []);
      const entry  = table.find(t => t.id === id);
      if (!entry) return;
      entry.weight = weight;
      await this.actor.update({ "system.lootTable": table });
    });

    // 条目删除
    html.find(".loot-table-del").on("click", async (e) => {
      const id    = e.currentTarget.closest("[data-entry-id]")?.dataset.entryId;
      const table = (this.actor.system.lootTable ?? []).filter(t => t.id !== id);
      await this.actor.update({ "system.lootTable": table });
    });

    // 补充战利品
    html.find(".loot-refill-btn").on("click", () => this._onRefillLoot());
  }

  /* ─── 战利品清单：拖入随机表(RollTable)或物品 ─────────────────────────── */

  async _onLootTableDrop(event) {
    event.preventDefault();
    this.element.find(".loot-table-panel").removeClass("cg-drag-over");

    let raw;
    try { raw = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain")); }
    catch { return; }

    const table = foundry.utils.deepClone(this.actor.system.lootTable ?? []);

    // ── 拖入 Foundry 随机表：展开全部结果为清单条目 ─────────────────────
    if (raw?.type === "RollTable") {
      const rollTable = await fromUuid(raw.uuid).catch(() => null);
      if (!rollTable) return;
      let added = 0, skipped = 0;
      for (const result of rollTable.results) {
        // 仅处理指向文档（Item）的结果
        const docUuid = result.documentUuid
          ?? (result.documentCollection && result.documentId
              ? (result.documentCollection.includes(".")
                  ? `Compendium.${result.documentCollection}.Item.${result.documentId}`
                  : `${result.documentCollection}.${result.documentId}`)
              : null);
        const doc = docUuid ? await fromUuid(docUuid).catch(() => null) : null;
        if (!doc || doc.documentName !== "Item") { skipped++; continue; }
        const data = doc.toObject();
        delete data._id;
        table.push({
          id:       foundry.utils.randomID(),
          name:     doc.name,
          img:      doc.img,
          weight:   Math.max(0, Math.round(result.weight ?? 1)),
          itemData: data,
        });
        added++;
      }
      await this.actor.update({ "system.lootTable": table });
      ui.notifications.info(`已从随机表「${rollTable.name}」导入 ${added} 个条目${skipped ? `（跳过 ${skipped} 个非物品结果）` : ""}。`);
      return;
    }

    // ── 拖入单个物品：添加一条 ──────────────────────────────────────────
    if (raw?.type === "Item") {
      const item = await Item.fromDropData(raw).catch(() => null);
      if (!item) return;
      const data = item.toObject();
      delete data._id;
      table.push({
        id:       foundry.utils.randomID(),
        name:     item.name,
        img:      item.img,
        weight:   1,
        itemData: data,
      });
      await this.actor.update({ "system.lootTable": table });
    }
  }

  /* ─── 补充战利品：按权重从清单随机抽取 N 次填入网格 ───────────────────── */

  async _onRefillLoot() {
    const entries = (this.actor.system.lootTable ?? []).filter(e => (e.weight ?? 0) > 0 && e.itemData);
    if (!entries.length) {
      ui.notifications.warn("战利品清单为空（或所有条目权重为 0），请先拖入随机表或物品。");
      return;
    }

    const sheet = this;
    new Dialog({
      title: "补充战利品",
      content: `<div class="limbuscompany" style="padding:6px 0">
        <label style="display:flex;align-items:center;gap:8px">
          骰掷次数：
          <input type="number" id="loot-refill-count" value="1" min="1" max="50" style="width:60px">
          <span>（从清单按权重随机抽取）</span>
        </label>
      </div>`,
      buttons: {
        roll: {
          label: "骰掷",
          callback: async (dlg) => {
            const count = Math.min(50, Math.max(1, parseInt(dlg.find("#loot-refill-count").val()) || 1));
            await sheet._executeRefill(entries, count);
          },
        },
        cancel: { label: "取消" },
      },
      default: "roll",
    }).render(true);
  }

  async _executeRefill(entries, count) {
    const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
    const pulled = [];
    for (let i = 0; i < count; i++) {
      let r = Math.random() * totalWeight;
      for (const e of entries) {
        r -= e.weight;
        if (r < 0) { pulled.push(e); break; }
      }
    }

    let placedCount = 0;
    const names = [];
    for (const entry of pulled) {
      const data = foundry.utils.deepClone(entry.itemData);
      delete data._id;
      const cap = data.system?.capacity ?? { w: 1, h: 1 };
      const w = Math.max(1, cap.w ?? 1), h = Math.max(1, cap.h ?? 1);
      const place = this._autoPlace(w, h);
      if (!place) {
        ui.notifications.warn(`网格空间不足，仅放入 ${placedCount}/${pulled.length} 件。`);
        break;
      }
      const [newItem] = await this.actor.createEmbeddedDocuments("Item", [data]);
      const contents  = foundry.utils.deepClone(this.actor.system.lootContents ?? []);
      contents.push({ uuid: newItem.uuid, x: place.x, y: place.y, w: place.w, h: place.h,
                      rotated: place.rotated, revealed: false });
      await this.actor.update({ "system.lootContents": contents });
      names.push(entry.name);
      placedCount++;
    }
    if (placedCount > 0) {
      ui.notifications.info(`补充了 ${placedCount} 件战利品：${names.join("、")}`);
    }
  }

  _activatePlayerListeners(html) {
    // 拿走货币
    html.find(".loot-take-currency-btn").on("click", () => this._onTakeCurrency());
    // 一键平分
    html.find(".loot-split-currency-btn").on("click", () => this._onSplitCurrency());
  }

  /* ─── 网格拖放事件 ─────────────────────────────────────────────────────── */

  _onCellDragOver(event) {
    event.preventDefault();
    $(event.currentTarget).addClass("cg-drag-over");
  }

  _onCellDragLeave(event) {
    $(event.currentTarget).removeClass("cg-drag-over");
  }

  _onTileDragStart(event) {
    this._onTileHoverEnd(true); // 拖动开始即强制关闭 Title 卡（忽略锁定）
    const tile     = event.currentTarget;
    const idx      = parseInt(tile.dataset.placementIdx ?? -1);
    if (idx < 0) return;
    const rect     = tile.getBoundingClientRect();
    const cellSize = 50;
    const offX     = Math.max(0, Math.floor((event.clientX - rect.left) / cellSize));
    const offY     = Math.max(0, Math.floor((event.clientY - rect.top)  / cellSize));
    // jQuery 包装的事件不代理 dataTransfer，需取 originalEvent
    const dt = (event.originalEvent ?? event).dataTransfer;
    if (!dt) return;
    dt.setData("text/plain", JSON.stringify({
      type: "Item",
      uuid: tile.dataset.itemUuid ?? "",
      fromLootGrid: { lootActorId: this.actor.id, placementIdx: idx, offX, offY },
    }));
  }

  async _onCellDrop(event) {
    event.preventDefault();
    $(event.currentTarget).removeClass("cg-drag-over");

    const targetX = parseInt(event.currentTarget.dataset.x ?? 0);
    const targetY = parseInt(event.currentTarget.dataset.y ?? 0);
    const sys     = this.actor.system;
    const cols    = sys.gridSize?.width  ?? 5;
    const rows    = sys.gridSize?.height ?? 5;

    let raw;
    try { raw = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain")); }
    catch { return; }

    // ── 网格内部移动 ──────────────────────────────────────────────────────
    if (raw.type === "Item" && raw.fromLootGrid?.lootActorId === this.actor.id) {
      const { placementIdx: idx, offX = 0, offY = 0 } = raw.fromLootGrid;
      const nx = targetX - offX, ny = targetY - offY;

      if (game.user.isGM) {
        const contents = foundry.utils.deepClone(sys.lootContents ?? []);
        const p = contents[idx];
        if (!p) return;
        if (!this._canPlace(nx, ny, p.w ?? 1, p.h ?? 1, cols, rows, idx))
          return void ui.notifications.warn("此位置无法放置（超出边界或与其他物品重叠）");
        p.x = nx; p.y = ny;
        return void await this.actor.update({ "system.lootContents": contents });
      } else {
        game.socket.emit("system.limbusCompany_FVTT", {
          type: "lootMoveItem",
          lootActorId: this.actor.id, placementIdx: idx, nx, ny,
          userId: game.user.id,
        });
        return;
      }
    }

    // ── 外部物品拖入（仅 GM 解锁时） ─────────────────────────────────────
    if (!game.user.isGM || !this._editUnlocked) return;

    const dropped = await Item.fromDropData(raw).catch(() => null);
    if (!dropped) return;

    const sourceActor = dropped.parent;
    const cap = dropped.system?.capacity ?? { w: 1, h: 1 };
    const w   = Math.max(1, cap.w ?? 1);
    const h   = Math.max(1, cap.h ?? 1);

    const place = this._canPlace(targetX, targetY, w, h, cols, rows)
      ? { x: targetX, y: targetY, w, h, rotated: false }
      : this._autoPlace(w, h);
    if (!place) return void ui.notifications.warn("战利品空间不足，无法放置该物品。");

    let storedUuid = dropped.uuid;
    if (sourceActor && sourceActor.id !== this.actor.id) {
      const [newItem] = await this.actor.createEmbeddedDocuments("Item", [dropped.toObject()]);
      storedUuid = newItem.uuid;
      await dropped.delete();
    } else if (!sourceActor) {
      const [newItem] = await this.actor.createEmbeddedDocuments("Item", [dropped.toObject()]);
      storedUuid = newItem.uuid;
    }

    const contents = foundry.utils.deepClone(sys.lootContents ?? []);
    contents.push({ uuid: storedUuid, x: place.x, y: place.y, w: place.w, h: place.h, rotated: place.rotated });
    await this.actor.update({ "system.lootContents": contents });
  }

  /* ─── 旋转 ─────────────────────────────────────────────────────────────── */

  async _onTileRotate(event) {
    event.stopPropagation();
    const idx = parseInt(event.currentTarget.dataset.placementIdx ?? -1);
    if (idx < 0) return;
    const contents = foundry.utils.deepClone(this.actor.system.lootContents ?? []);
    const p = contents[idx];
    if (!p) return;
    [p.w, p.h] = [p.h, p.w];
    p.rotated = !p.rotated;
    await this.actor.update({ "system.lootContents": contents });
  }

  /* ─── 右键菜单 ─────────────────────────────────────────────────────────── */

  async _onTileContextMenu(event) {
    event.preventDefault();
    const tile  = $(event.currentTarget);
    const idx   = parseInt(tile.data("placementIdx") ?? tile.data("placement-idx") ?? -1);
    const uuid  = tile.data("itemUuid") ?? tile.data("item-uuid") ?? "";
    const iname = tile.data("itemName") ?? tile.data("item-name") ?? "";
    if (idx < 0) return;

    // 玩家：未揭晓的物品不可操作（先双击揭晓）
    if (!game.user.isGM && event.currentTarget.dataset.revealed !== "true") {
      ui.notifications.warn("双击揭晓后才能拾取。");
      return;
    }

    $(".cg-ctx-menu").remove();

    const isGM = game.user.isGM;
    let menuHtml = `<li data-action="takeout"><i class="fas fa-box-open"></i> 取出到我的角色</li>
                    <li data-action="chat"><i class="fas fa-comment"></i> 发送聊天框</li>`;
    if (isGM) {
      menuHtml += `<li class="cg-ctx-sep"></li>
                   <li data-action="edit"><i class="fas fa-edit"></i> 编辑</li>
                   <li data-action="delete" class="cg-ctx-danger"><i class="fas fa-trash"></i> 删除</li>`;
    }

    const menu = $(`<ul class="cg-ctx-menu">${menuHtml}</ul>`)
      .css({ top: event.clientY, left: event.clientX });
    $("body").append(menu);

    const close = () => { menu.remove(); $(document).off("click.lootctx"); };
    setTimeout(() => $(document).on("click.lootctx", close), 10);

    const sheet = this;
    menu.on("click", "li[data-action]", async e => {
      e.stopPropagation();
      const action = $(e.currentTarget).data("action");
      close();

      if (action === "takeout") {
        const item = await fromUuid(uuid).catch(() => null);
        if (!item) { ui.notifications.warn(`找不到物品「${iname}」，可能已被取走。`); return; }
        const maxQty = item.system?.quantity ?? 1;
        // 数量为 1 时直接取出，无需弹窗确认
        if (maxQty === 1) {
          await sheet._executeItemTake(sheet.actor.id, uuid, idx, 1);
        } else {
          new Dialog({
            title: `取出 — ${item.name}`,
            content: `<div class="limbuscompany" style="padding:6px 0">
              <p>将物品移至你的角色背包。</p>
              <label style="display:flex;align-items:center;gap:8px">
                取出数量：
                <input type="number" id="loot-take-qty" value="1" min="1" max="${maxQty}" style="width:60px">
                <span>（战利品剩余：${maxQty}）</span>
              </label>
            </div>`,
            buttons: {
              take: {
                label: "取出",
                callback: async (dlg) => {
                  const qty = Math.min(maxQty, Math.max(1, parseInt(dlg.find("#loot-take-qty").val()) || 1));
                  await sheet._executeItemTake(sheet.actor.id, uuid, idx, qty);
                },
              },
              cancel: { label: "取消" },
            },
            default: "take",
          }).render(true);
        }

      } else if (action === "edit") {
        const itm = await fromUuid(uuid).catch(() => null);
        itm?.sheet?.render(true);

      } else if (action === "chat") {
        const itm = await fromUuid(uuid).catch(() => null);
        if (itm?.sendToChat) await itm.sendToChat();
        else ChatMessage.create({ content: `<b>${iname}</b>`, speaker: ChatMessage.getSpeaker() });

      } else if (action === "delete") {
        const confirmed = await Dialog.confirm({
          title: "删除物品",
          content: `<p>确定从战利品中删除 <strong>${iname}</strong>？</p>`,
        });
        if (!confirmed) return;
        const contents = foundry.utils.deepClone(sheet.actor.system.lootContents ?? []);
        contents.splice(idx, 1);
        await sheet.actor.update({ "system.lootContents": contents });
        const itm = await fromUuid(uuid).catch(() => null);
        if (itm?.parent?.id === sheet.actor.id) await itm.delete();
      }
    });
  }

  /* ─── 拿走物品 ─────────────────────────────────────────────────────────── */

  async _executeItemTake(lootActorId, itemUuid, placementIdx, quantity) {
    if (game.user.isGM) {
      await LimbusLootSheet._gmExecuteTakeItem({
        lootActorId, itemUuid, placementIdx, quantity,
        userId: game.user.id, charId: game.user.character?.id ?? null,
      });
    } else {
      const myChar = game.user.character;
      if (!myChar) { ui.notifications.warn("找不到你的角色，无法拿走物品。"); return; }
      game.socket.emit("system.limbusCompany_FVTT", {
        type: "lootTakeItem",
        lootActorId, itemUuid, placementIdx, quantity,
        userId: game.user.id, charId: myChar.id,
      });
    }
  }

  /* ─── 拿走货币 ─────────────────────────────────────────────────────────── */

  _onTakeCurrency() {
    const total = this.actor.system.currency ?? 0;
    if (total <= 0) { ui.notifications.warn("战利品中没有眼可以拿走。"); return; }

    const sheet = this;
    new Dialog({
      title: "拿走眼",
      content: `<div class="limbuscompany" style="padding:6px 0">
        <label style="display:flex;align-items:center;gap:8px">
          拿走数量：
          <input type="number" id="loot-take-curr" value="${total}" min="1" max="${total}" style="width:80px">
          <span>（共 ${total} 眼）</span>
        </label>
      </div>`,
      buttons: {
        take: {
          label: "拿走",
          callback: async (dlg) => {
            const amt = Math.min(total, Math.max(1, parseInt(dlg.find("#loot-take-curr").val()) || 1));
            if (game.user.isGM) {
              await LimbusLootSheet._gmExecuteTakeCurrency({
                lootActorId: sheet.actor.id, amount: amt,
                userId: game.user.id, charId: game.user.character?.id ?? null,
              });
            } else {
              const myChar = game.user.character;
              if (!myChar) { ui.notifications.warn("找不到你的角色。"); return; }
              game.socket.emit("system.limbusCompany_FVTT", {
                type: "lootTakeCurrency",
                lootActorId: sheet.actor.id, amount: amt,
                userId: game.user.id, charId: myChar.id,
              });
            }
          },
        },
        cancel: { label: "取消" },
      },
      default: "take",
    }).render(true);
  }

  /* ─── 一键平分 ─────────────────────────────────────────────────────────── */

  async _onSplitCurrency() {
    const total = this.actor.system.currency ?? 0;
    if (total <= 0) { ui.notifications.warn("战利品中没有眼可以平分。"); return; }

    let team1Ids;
    try { team1Ids = game.settings.get("limbusCompany_FVTT", "squadTeam1") ?? []; }
    catch { team1Ids = []; }

    const team1Actors = team1Ids.map(id => game.actors?.get(id)).filter(a => a?.type === "character");
    if (team1Actors.length === 0) {
      ui.notifications.warn("队伍1中没有角色，请先在小队 HUD（Z键）中添加队员。");
      return;
    }

    const each      = Math.floor(total / team1Actors.length);
    const remainder = total % team1Actors.length;

    const confirmed = await Dialog.confirm({
      title: "一键平分眼",
      content: `<div class="limbuscompany" style="padding:4px 0">
        <p>将 <strong>${total}</strong> 眼平分给队伍1的 <strong>${team1Actors.length}</strong> 位成员？</p>
        <p>每人获得 <strong>${each}</strong> 眼${remainder > 0 ? `，余 <strong>${remainder}</strong> 眼留在战利品中` : "，均分完毕"}。</p>
        <p style="font-size:.78rem;color:#7a6a58">队伍1：${team1Actors.map(a => a.name).join("、")}</p>
      </div>`,
    });
    if (!confirmed) return;

    if (game.user.isGM) {
      await LimbusLootSheet._gmExecuteSplitCurrency({
        lootActorId: this.actor.id, teamActorIds: team1Ids,
      });
    } else {
      game.socket.emit("system.limbusCompany_FVTT", {
        type: "lootSplitCurrency",
        lootActorId: this.actor.id, teamActorIds: team1Ids,
        userId: game.user.id,
      });
    }
  }

  /* ─── GM 填充货币 ──────────────────────────────────────────────────────── */

  _onFillCurrency() {
    const cur   = this.actor.system.currency ?? 0;
    const sheet = this;
    new Dialog({
      title: "填充战利品 眼",
      content: `<div class="limbuscompany" style="padding:6px 0">
        <p style="margin:0 0 6px;font-size:.85rem;color:#7a6a58">当前：${cur} 眼</p>
        <label style="display:flex;align-items:center;gap:8px">
          添加眼数量：
          <input type="number" id="loot-fill-amt" value="0" min="0" style="width:80px">
        </label>
      </div>`,
      buttons: {
        set: {
          label: "确定",
          callback: async (dlg) => {
            const add = Math.max(0, parseInt(dlg.find("#loot-fill-amt").val()) || 0);
            await sheet.actor.update({ "system.currency": cur + add });
          },
        },
        cancel: { label: "取消" },
      },
      default: "set",
    }).render(true);
  }

  /* ─── 静态 GM 执行方法 ─────────────────────────────────────────────────── */

  static async _gmExecuteTakeItem({ lootActorId, itemUuid, placementIdx, quantity, userId, charId }) {
    const lootActor = game.actors.get(lootActorId);
    if (!lootActor) return;

    const item = await fromUuid(itemUuid).catch(() => null);
    if (!item || item.parent?.id !== lootActorId) return;

    // 玩家发起的取出必须先揭晓（GM 不受限制）
    const triggerUser = game.users.get(userId);
    const placement   = (lootActor.system.lootContents ?? [])[placementIdx];
    if (!triggerUser?.isGM && !(placement?.revealed ?? false)) {
      ui.notifications.warn(`[战利品] ${item.name} 尚未揭晓，无法拾取。`);
      return;
    }

    const playerChar = game.actors.get(charId) ??
      game.actors.find(a => a.type === "character" &&
        (a.ownership?.[userId] ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    if (!playerChar) { ui.notifications.warn("[战利品] 找不到目标角色，拿走失败。"); return; }

    const maxQty  = item.system?.quantity ?? 1;
    const qty     = Math.min(maxQty, Math.max(1, quantity));
    const newQty  = maxQty - qty;
    const itemData = item.toObject();

    const contents = foundry.utils.deepClone(lootActor.system.lootContents ?? []);
    if (newQty <= 0) {
      contents.splice(placementIdx, 1);
      await lootActor.update({ "system.lootContents": contents });
      if (!lootActor.items.get(item.id)) {
        ui.notifications.warn(`[战利品] ${item.name} 已被他人拿走。`);
        return;
      }
      await item.delete();
    } else {
      await item.update({ "system.quantity": newQty });
    }

    if (itemData.system?.quantity !== undefined) itemData.system.quantity = qty;
    await playerChar.createEmbeddedDocuments("Item", [itemData]);
    LimbusLootSheet._scheduleChatMsg(lootActor, playerChar, itemData.name, itemData.img, qty);
  }

  static async _gmExecuteTakeCurrency({ lootActorId, amount, userId, charId }) {
    const lootActor = game.actors.get(lootActorId);
    if (!lootActor) return;

    const playerChar = game.actors.get(charId) ??
      game.actors.find(a => a.type === "character" &&
        (a.ownership?.[userId] ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    if (!playerChar) { ui.notifications.warn("[战利品] 找不到目标角色。"); return; }

    const current = lootActor.system.currency ?? 0;
    const take    = Math.min(current, Math.max(1, amount));
    if (take <= 0) return;

    await lootActor.update({ "system.currency": current - take });
    const charCurrency = playerChar.system?.currency ?? 0;
    await playerChar.update({ "system.currency": charCurrency + take });
    ui.notifications.info(`${playerChar.name} 获得 ${take} 眼。`);
  }

  static async _gmExecuteSplitCurrency({ lootActorId, teamActorIds }) {
    const lootActor = game.actors.get(lootActorId);
    if (!lootActor) return;

    const total = lootActor.system.currency ?? 0;
    if (total <= 0) return;

    const teamActors = (teamActorIds ?? [])
      .map(id => game.actors?.get(id))
      .filter(a => a?.type === "character");
    if (teamActors.length === 0) return;

    const each      = Math.floor(total / teamActors.length);
    const remainder = total % teamActors.length;

    for (const actor of teamActors) {
      const cur = actor.system?.currency ?? 0;
      await actor.update({ "system.currency": cur + each });
    }
    await lootActor.update({ "system.currency": remainder });

    ui.notifications.info(
      `已平分 ${total - remainder} 眼给 ${teamActors.length} 位队员` +
      (remainder > 0 ? `，余 ${remainder} 眼留在战利品中。` : "。")
    );
  }

  /** 玩家双击揭晓：写入 placement.revealed = true */
  static async _gmExecuteRevealItem({ lootActorId, placementIdx, itemUuid }) {
    const lootActor = game.actors.get(lootActorId);
    if (!lootActor) return;
    const contents = foundry.utils.deepClone(lootActor.system.lootContents ?? []);
    const p = contents[placementIdx];
    if (!p || p.uuid !== itemUuid) return; // 防竞态：索引已变
    if (p.revealed) return;
    p.revealed = true;
    await lootActor.update({ "system.lootContents": contents });
  }

  static async _gmExecuteMoveItem({ lootActorId, placementIdx, nx, ny }) {
    const lootActor = game.actors.get(lootActorId);
    if (!lootActor) return;
    const sys  = lootActor.system;
    const cols = sys.gridSize?.width  ?? 5;
    const rows = sys.gridSize?.height ?? 5;

    const contents = foundry.utils.deepClone(sys.lootContents ?? []);
    const p        = contents[placementIdx];
    if (!p) return;
    if (nx < 0 || ny < 0 || nx + (p.w ?? 1) > cols || ny + (p.h ?? 1) > rows) return;
    p.x = nx; p.y = ny;
    await lootActor.update({ "system.lootContents": contents });
  }

  /* ─── Socket 消息处理（在 init hook 的 socket.on 中注册） ──────────────── */

  static async handleSocketMsg(msg) {
    if (!game.user.isGM) return;
    const lootActorId = msg.lootActorId;
    if (!lootActorId) return;

    // 串行化同一战利品的所有操作，防止并发竞态
    const prev = LimbusLootSheet._opQueues.get(lootActorId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      if      (msg.type === "lootTakeItem")      await LimbusLootSheet._gmExecuteTakeItem(msg);
      else if (msg.type === "lootTakeCurrency")  await LimbusLootSheet._gmExecuteTakeCurrency(msg);
      else if (msg.type === "lootSplitCurrency") await LimbusLootSheet._gmExecuteSplitCurrency(msg);
      else if (msg.type === "lootMoveItem")      await LimbusLootSheet._gmExecuteMoveItem(msg);
      else if (msg.type === "lootRevealItem")    await LimbusLootSheet._gmExecuteRevealItem(msg);
    }).finally(() => {
      if (LimbusLootSheet._opQueues.get(lootActorId) === next)
        LimbusLootSheet._opQueues.delete(lootActorId);
    });
    LimbusLootSheet._opQueues.set(lootActorId, next);
  }
}
