/**
 * camp-sheet.mjs — 营地角色卡 Sheet
 *
 * 双栏布局：
 *   左栏：仓库网格（7×7 默认，与容器网格完全相同的 cg-wrap 机制）
 *   右栏：配方列表（制作 + GM 编辑）
 *
 * 权限区分：
 *   GM   → 解锁后可拖入物品、调整网格尺寸、增删改隐藏配方
 *   玩家 → 查看仓库、右键取出物品、查看可见配方、点击制作
 *         （玩家操作通过 socket 委托 GM 执行）
 */
export class LimbusCampSheet extends ActorSheet {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes:   ["limbuscompany", "sheet", "actor", "camp"],
      template:  "systems/limbusCompany_FVTT/templates/actor/camp-sheet.hbs",
      width:     880,
      height:    580,
      resizable: true,
    });
  }

  /* ─── 状态 ──────────────────────────────────────────────────────────── */

  /** GM 编辑锁 */
  _editUnlocked = false;

  /** 仓库搜索关键词 */
  _warehouseSearch = "";

  /** 正在等待服务端确认的制作配方 ID（防止重复点击） */
  _pendingCraftIds = new Set();

  /**
   * 每个营地 Actor 的 GM 端操作序列化队列。
   * 防止"快速取出后立刻制作"导致两条 socket 消息并发执行产生竞态条件。
   * @type {Map<string, Promise<void>>}
   */
  static _opQueues = new Map();

  /* ─── getData ────────────────────────────────────────────────────────── */

  /** @override */
  async getData(options = {}) {
    const ctx   = await super.getData(options);
    const actor = this.actor;
    const sys   = actor.system;
    const isGM  = game.user.isGM;

    ctx.isGM            = isGM;
    ctx.editUnlocked    = this._editUnlocked;
    ctx.description     = sys.description ?? "";
    ctx.warehouseSearch = this._warehouseSearch ?? "";

    // ── 仓库网格 ──────────────────────────────────────────────────────────
    const cols = Math.max(1, Math.min(20, sys.warehouseSize?.width  ?? 7));
    const rows = Math.max(1, Math.min(20, sys.warehouseSize?.height ?? 7));
    ctx.gridCols      = cols;
    ctx.gridRows      = rows;
    ctx.gridSizeLabel = `${cols} × ${rows}`;

    const { placedItems, allCells } = await this._buildWarehouseGrid(
      sys.warehouseContents ?? [], cols, rows
    );
    ctx.placedItems    = placedItems;
    ctx.allCells       = allCells;
    ctx.warehouseUsed  = placedItems.length;
    ctx.warehouseMax   = cols * rows;
    ctx.warehouseAvail = allCells.filter(c => !c.occupied).length;

    // ── 配方列表 ──────────────────────────────────────────────────────────
    // 只统计实际放置在仓库格中的物品（warehouseContents 有记录的），
    // 避免已删除但缓存未刷新的孤立物品，或同名产出物品被错误计入原料。
    const _placedIds = new Set(
      (sys.warehouseContents ?? []).map(p => p.uuid.split(".").pop())
    );
    const _warehouseItems = actor.items.contents.filter(i => _placedIds.has(i.id));

    ctx.recipes = (sys.recipes ?? [])
      .filter(r => isGM || !r.hidden)
      .map(recipe => {
        const ingDetails = this._getIngredientDetails(recipe, _warehouseItems);
        const canCraft   = ingDetails.every(d => d.sufficient) &&
                           ingDetails.length > 0 &&
                           !!recipe.outputItemData &&
                           !this._pendingCraftIds.has(recipe.id);
        return { ...recipe, canCraft, ingDetails };
      });

    return ctx;
  }

  /* ─── 仓库网格构建（与容器 _buildContainerGrid 同逻辑） ─────────────── */

  async _buildWarehouseGrid(placements, cols, rows) {
    const placedItems = [];
    const occupied    = new Set(); // "x,y"
    const q           = (this._warehouseSearch ?? "").toLowerCase();

    for (let idx = 0; idx < placements.length; idx++) {
      const p    = placements[idx];
      let   item = null;
      if (p?.uuid) item = await fromUuid(p.uuid).catch(() => null);
      if (!item) continue;

      const w = Math.max(1, p.w ?? 1);
      const h = Math.max(1, p.h ?? 1);
      if (p.x + w > cols || p.y + h > rows || p.x < 0 || p.y < 0) continue;

      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++)
          occupied.add(`${p.x + dx},${p.y + dy}`);

      const show = !q || item.name.toLowerCase().includes(q);
      placedItems.push({
        idx,
        uuid:    p.uuid,
        x: p.x, y: p.y, w, h,
        col:     p.x + 1,
        row:     p.y + 1,
        rotated: p.rotated ?? false,
        show,
        item: { _id: item.id, name: item.name, img: item.img,
                quantity: item.system?.quantity ?? 1 },
      });
    }

    const allCells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        allCells.push({ x: c, y: r, col: c + 1, row: r + 1,
          occupied: occupied.has(`${c},${r}`) });
      }
    }
    return { placedItems, allCells };
  }

  /* ─── 碰撞检测 ──────────────────────────────────────────────────────── */

  _whCanPlace(x, y, w, h, cols, rows, excludeIdx = -1) {
    if (x < 0 || y < 0 || x + w > cols || y + h > rows) return false;
    const contents = this.actor.system.warehouseContents ?? [];
    for (let i = 0; i < contents.length; i++) {
      if (i === excludeIdx) continue;
      const p = contents[i];
      const pw = p.w ?? 1, ph = p.h ?? 1;
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++)
          if (p.x <= x + dx && x + dx < p.x + pw &&
              p.y <= y + dy && y + dy < p.y + ph) return false;
    }
    return true;
  }

  _whAutoPlace(w, h) {
    const sys  = this.actor.system;
    const cols = sys.warehouseSize?.width  ?? 7;
    const rows = sys.warehouseSize?.height ?? 7;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (this._whCanPlace(x, y, w, h, cols, rows))
          return { x, y, w, h, rotated: false };
        if (w !== h && this._whCanPlace(x, y, h, w, cols, rows))
          return { x, y, w: h, h: w, rotated: true };
      }
    }
    return null;
  }

  /* ─── 配方检查 ──────────────────────────────────────────────────────── */

  _getIngredientDetails(recipe, warehouseItems) {
    return (recipe.ingredients ?? []).map(ing => {
      const matches = warehouseItems.filter(i => i.name === ing.name);
      // 无限耐久物品：只要仓库中存在即视为数量充足
      const hasInfinite = matches.some(i => i.system?.infinite);
      const available = hasInfinite
        ? ing.quantity
        : matches.reduce((s, i) => s + (i.system?.quantity ?? 1), 0);
      return { ...ing, available, sufficient: available >= ing.quantity };
    });
  }

  /* ─── 事件绑定 ─────────────────────────────────────────────────────── */

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    // 编辑锁（GM 专用）
    html.find(".camp-lock-toggle").on("click", () => {
      this._editUnlocked = !this._editUnlocked;
      this.render(false);
    });

    // 仓库搜索
    html.find(".camp-warehouse-search").on("input", e => {
      this._warehouseSearch = e.target.value;
      const q = this._warehouseSearch.toLowerCase();
      html.find(".cg-item-tile").each((_, tile) => {
        const name = $(tile).data("item-name") ?? "";
        $(tile).toggle(!q || name.toLowerCase().includes(q));
      });
    });

    // GM：仓库网格尺寸编辑（失焦/Enter 提交）
    html.find(".camp-grid-dim").on("change", this._onGridSizeChange.bind(this));

    // 仓库网格：拖放
    html.find(".cg-cell").on("dragover",   this._onCgCellDragOver.bind(this));
    html.find(".cg-cell").on("dragleave",  this._onCgCellDragLeave.bind(this));
    html.find(".cg-cell").on("drop",       this._onCgCellDrop.bind(this));

    // 仓库图块：拖拽开始
    html.find(".cg-item-tile").on("dragstart", this._onCgTileDragStart.bind(this));
    html.find(".cg-item-tile").on("mouseenter",  this._onCgTileHoverStart.bind(this));
    html.find(".cg-item-tile").on("mouseleave",  this._onCgTileHoverEnd.bind(this));

    // 仓库图块：右键菜单
    html.find(".cg-item-tile").on("contextmenu", this._onCgTileMenu.bind(this));

    // 仓库图块：旋转（GM 解锁时显示）
    html.find(".cg-rotate-btn").on("click", this._onCgTileRotate.bind(this));

    // GM：解锁时给网格加编辑样式
    if (game.user.isGM && this._editUnlocked) {
      html.find(".cg-wrap").addClass("cg-edit-unlocked");
    }

    // 配方操作
    html.find(".camp-add-recipe").on("click",       this._onAddRecipe.bind(this));
    html.find(".camp-recipe-edit").on("click",      this._onEditRecipe.bind(this));
    html.find(".camp-recipe-delete").on("click",    this._onDeleteRecipe.bind(this));
    html.find(".camp-recipe-hide").on("click",      this._onToggleRecipeHidden.bind(this));
    html.find(".camp-craft-btn:not([disabled])").on("click", this._onCraft.bind(this));
  }

  /* ─── 网格尺寸编辑（GM） ─────────────────────────────────────────────── */

  async _onGridSizeChange(event) {
    const field = event.currentTarget;
    const axis  = field.dataset.axis; // "width" | "height"
    const val   = Math.max(1, Math.min(20, parseInt(field.value) || 7));
    await this.actor.update({ [`system.warehouseSize.${axis}`]: val });
  }

  /* ─── 网格拖放 ───────────────────────────────────────────────────────── */

  _onCgCellDragOver(event) {
    event.preventDefault();
    event.originalEvent.dataTransfer.dropEffect = "move";
    $(event.currentTarget).addClass("cg-drag-over");
  }

  _onCgCellDragLeave(event) {
    $(event.currentTarget).removeClass("cg-drag-over");
  }

  async _onCgCellDrop(event) {
    event.preventDefault();
    $(event.currentTarget).removeClass("cg-drag-over");

    const cell    = event.currentTarget;
    const targetX = parseInt(cell.dataset.x ?? 0);
    const targetY = parseInt(cell.dataset.y ?? 0);
    const sys     = this.actor.system;
    const cols    = sys.warehouseSize?.width  ?? 7;
    const rows    = sys.warehouseSize?.height ?? 7;

    let raw;
    try { raw = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain")); }
    catch { return; }

    // ── 仓库内图块移动 ────────────────────────────────────────────────
    if (raw.type === "Item" && raw.fromCampWarehouse?.campActorId === this.actor.id) {
      const { placementIdx: idx, offX = 0, offY = 0 } = raw.fromCampWarehouse;
      const nx = targetX - offX, ny = targetY - offY;

      if (game.user.isGM) {
        const contents = foundry.utils.deepClone(sys.warehouseContents ?? []);
        const p = contents[idx];
        if (!p) return;
        if (!this._whCanPlace(nx, ny, p.w ?? 1, p.h ?? 1, cols, rows, idx))
          return void ui.notifications.warn("此位置无法放置（超出边界或与其他物品重叠）");
        p.x = nx; p.y = ny;
        return void await this.actor.update({ "system.warehouseContents": contents });
      } else {
        // 玩家通过 socket 委托 GM 执行移动
        game.socket.emit("system.limbusCompany_FVTT", {
          type: "campMoveItem",
          campActorId: this.actor.id, placementIdx: idx, nx, ny,
          userId: game.user.id,
        });
        return;
      }
    }

    // ── 外部物品拖入 ──────────────────────────────────────────────────
    const dropped = await Item.fromDropData(raw).catch(() => null);
    if (!dropped) return;
    if (dropped.type === "camp") return;

    const sourceActor = dropped.parent;

    if (!game.user.isGM) {
      // 玩家只能拖入自己背包中的物品，通过 socket 委托 GM 执行
      const myChar = game.user.character;
      if (!myChar || !sourceActor || sourceActor.id !== myChar.id) {
        ui.notifications.warn("只能将自己背包中的物品存入仓库。");
        return;
      }
      game.socket.emit("system.limbusCompany_FVTT", {
        type:          "campDropItem",
        campActorId:   this.actor.id,
        itemUuid:      dropped.uuid,
        sourceActorId: sourceActor.id,
        itemData:      dropped.toObject(),
        targetX, targetY,
        userId: game.user.id,
      });
      return;
    }

    // GM 直接执行
    const cap = dropped.system?.capacity ?? { w: 1, h: 1 };
    const w = Math.max(1, cap.w ?? 1), h = Math.max(1, cap.h ?? 1);

    const place = this._whCanPlace(targetX, targetY, w, h, cols, rows)
      ? { x: targetX, y: targetY, w, h, rotated: false }
      : this._whAutoPlace(w, h);
    if (!place) return void ui.notifications.warn("仓库空间不足，无法放置该物品。");

    let storedUuid = dropped.uuid;

    if (sourceActor && sourceActor.id !== this.actor.id) {
      // 跨 Actor 拖入：复制到仓库并从源角色删除
      const itemData = dropped.toObject();
      const [newItem] = await this.actor.createEmbeddedDocuments("Item", [itemData]);
      storedUuid = newItem.uuid;
      await dropped.delete();
    } else if (!sourceActor) {
      // 世界物品（无 actor）：复制数据
      const itemData = dropped.toObject();
      const [newItem] = await this.actor.createEmbeddedDocuments("Item", [itemData]);
      storedUuid = newItem.uuid;
    }

    // ── 若来自本营地的容器，移除容器内的占位记录 ──────────────────────
    if (raw.fromContainer && raw.fromContainer.actorId === this.actor.id) {
      const { containerId, placementIdx: srcIdx } = raw.fromContainer;
      const containerItem = this.actor.items.get(containerId);
      if (containerItem) {
        const sc = foundry.utils.deepClone(containerItem.system.contents ?? []);
        sc.splice(srcIdx, 1);
        await containerItem.update({ "system.contents": sc });
      }
    }

    const contents = foundry.utils.deepClone(sys.warehouseContents ?? []);
    contents.push({ uuid: storedUuid, x: place.x, y: place.y, w: place.w, h: place.h, rotated: place.rotated });
    await this.actor.update({ "system.warehouseContents": contents });
  }

  /* ─── 仓库图块拖拽开始 ───────────────────────────────────────────────── */

  _onCgTileDragStart(event) {
    const tile = event.currentTarget;
    const idx  = parseInt(tile.dataset.placementIdx ?? "-1");
    if (idx < 0) return;

    const step = 46;   // --cg-cell(44px) + --cg-gap(2px)，与容器保持一致
    const rect = tile.getBoundingClientRect();
    const offX = Math.floor((event.clientX - rect.left)  / step);
    const offY = Math.floor((event.clientY - rect.top)   / step);

    const dragData = {
      type:             "Item",
      uuid:             tile.dataset.itemUuid ?? "",
      fromCampWarehouse: {
        campActorId:  this.actor.id,
        placementIdx: idx,
        offX, offY,
      },
    };
    event.originalEvent.dataTransfer.setData("text/plain", JSON.stringify(dragData));
    event.originalEvent.dataTransfer.effectAllowed = "move";
  }

  /* ─── 仓库图块 Hover（轮廓高亮） ────────────────────────────────────── */

  _onCgTileHoverStart(event) {
    $(event.currentTarget).addClass("cg-tile-hover");
  }

  _onCgTileHoverEnd(event) {
    $(event.currentTarget).removeClass("cg-tile-hover");
  }

  /* ─── 仓库图块旋转（GM） ─────────────────────────────────────────────── */

  async _onCgTileRotate(event) {
    event.preventDefault();
    event.stopPropagation();
    const idx = parseInt(event.currentTarget.dataset.placementIdx ?? "-1");
    if (idx < 0) return;

    if (game.user.isGM) {
      const contents = foundry.utils.deepClone(this.actor.system.warehouseContents ?? []);
      const p = contents[idx];
      if (!p) return;
      const sys  = this.actor.system;
      const cols = sys.warehouseSize?.width  ?? 7;
      const rows = sys.warehouseSize?.height ?? 7;
      const newW = p.h ?? 1, newH = p.w ?? 1;
      if (!this._whCanPlace(p.x, p.y, newW, newH, cols, rows, idx))
        return void ui.notifications.warn("无法旋转：此位置放不下旋转后的物品。");
      p.w = newW; p.h = newH; p.rotated = !(p.rotated ?? false);
      await this.actor.update({ "system.warehouseContents": contents });
    } else {
      game.socket.emit("system.limbusCompany_FVTT", {
        type: "campRotateItem", campActorId: this.actor.id,
        placementIdx: idx, userId: game.user.id,
      });
    }
  }

  /* ─── 图块右键菜单（与容器保持一致） ────────────────────────────────── */

  async _onCgTileMenu(event) {
    event.preventDefault();
    const tile  = $(event.currentTarget);
    const idx   = parseInt(tile.data("placementIdx") ?? tile.data("placement-idx") ?? -1);
    const uuid  = tile.data("itemUuid") ?? tile.data("item-uuid") ?? "";
    const iname = tile.data("itemName") ?? tile.data("item-name") ?? "";
    if (idx < 0) return;

    $(".cg-ctx-menu").remove();

    const menu = $(`<ul class="cg-ctx-menu">
      <li data-action="takeout"><i class="fas fa-box-open"></i> 取出到我的角色</li>
      <li data-action="edit"><i class="fas fa-edit"></i> 编辑 / 查看</li>
      <li data-action="chat"><i class="fas fa-comment"></i> 发送聊天框</li>
      <li class="cg-ctx-sep"></li>
      <li data-action="delete" class="cg-ctx-danger"><i class="fas fa-trash"></i> 删除</li>
    </ul>`).css({ top: event.clientY, left: event.clientX });
    $("body").append(menu);

    const close = () => { menu.remove(); $(document).off("click.cgctx"); };
    setTimeout(() => $(document).on("click.cgctx", close), 10);

    const sheet = this;
    menu.on("click", "li[data-action]", async e => {
      e.stopPropagation();
      const action = $(e.currentTarget).data("action");
      close();

      if (action === "takeout") {
        const item = await fromUuid(uuid).catch(() => null);
        if (!item) { ui.notifications.warn(`找不到物品「${iname}」，可能已被删除。`); return; }
        const maxQty = item.system?.quantity ?? 1;
        new Dialog({
          title: `取出 — ${item.name}`,
          content: `<div class="limbuscompany" style="padding:6px 0">
            <p>将物品移至你的角色背包。</p>
            <label style="display:flex;align-items:center;gap:8px">
              取出数量：
              <input type="number" id="take-qty" value="1" min="1" max="${maxQty}" style="width:60px"/>
              <span>（仓库剩余：${maxQty}）</span>
            </label>
          </div>`,
          buttons: {
            take: {
              label: "取出",
              callback: async (html) => {
                const qty = Math.min(maxQty, Math.max(1, parseInt(html.find("#take-qty").val()) || 1));
                await sheet._executeItemTake(sheet.actor.id, uuid, idx, qty);
              },
            },
            cancel: { label: "取消" },
          },
          default: "take",
        }).render(true);

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
          content: `<p>确定从仓库删除 <strong>${iname}</strong>？</p>`,
        });
        if (!confirmed) return;
        const contents = foundry.utils.deepClone(sheet.actor.system.warehouseContents ?? []);
        contents.splice(idx, 1);
        await sheet.actor.update({ "system.warehouseContents": contents });
        const itm = await fromUuid(uuid).catch(() => null);
        if (itm?.parent?.id === sheet.actor.id) await itm.delete();
      }
    });
  }

  /**
   * 取出物品执行：GM 直接执行，玩家通过 socket 委托 GM。
   */
  async _executeItemTake(campActorId, itemUuid, placementIdx, quantity) {
    if (game.user.isGM) {
      await LimbusCampSheet._gmExecuteTakeItem({
        campActorId, itemUuid, placementIdx, quantity, userId: game.user.id,
        charId: game.user.character?.id ?? null,
      });
    } else {
      const myChar = game.user.character;
      if (!myChar) { ui.notifications.warn("找不到你的角色。"); return; }
      game.socket.emit("system.limbusCompany_FVTT", {
        type: "campTakeItem",
        campActorId, itemUuid, placementIdx, quantity,
        userId: game.user.id,
        charId: myChar.id,
      });
    }
  }

  /* ─── 配方操作 ─────────────────────────────────────────────────────── */

  async _onAddRecipe() {
    const recipes = foundry.utils.deepClone(this.actor.system.recipes ?? []);
    recipes.push({
      id: foundry.utils.randomID(), name: "新配方", hidden: false,
      ingredients: [], outputName: "", outputImg: "icons/svg/item-bag.svg",
      outputQuantity: 1, outputItemData: null,
    });
    await this.actor.update({ "system.recipes": recipes });
  }

  async _onDeleteRecipe(event) {
    event.stopPropagation();
    const recipeId = event.currentTarget.dataset.recipeId;
    await this.actor.update({
      "system.recipes": (this.actor.system.recipes ?? []).filter(r => r.id !== recipeId),
    });
  }

  async _onToggleRecipeHidden(event) {
    event.stopPropagation();
    const recipeId = event.currentTarget.dataset.recipeId;
    await this.actor.update({
      "system.recipes": (this.actor.system.recipes ?? []).map(r =>
        r.id === recipeId ? { ...r, hidden: !r.hidden } : r),
    });
  }

  /* ─── 配方编辑 Dialog ─────────────────────────────────────────────── */

  async _onEditRecipe(event) {
    event.stopPropagation();
    const recipeId = event.currentTarget.dataset.recipeId;
    const recipe   = (this.actor.system.recipes ?? []).find(r => r.id === recipeId);
    if (!recipe) return;

    const buildIngRow = (ing, idx) => `
      <div class="camp-recipe-ing-row" data-idx="${idx}">
        <img src="${ing.img || "icons/svg/item-bag.svg"}" width="22" height="22"
             class="camp-ing-drag-target" title="拖拽物品到此处自动填入">
        <input type="text"   class="camp-ing-name" value="${foundry.utils.escapeHTML(ing.name)}" placeholder="原料名称" style="width:130px"/>
        <span>×</span>
        <input type="number" class="camp-ing-qty"  value="${ing.quantity}" min="1" style="width:50px"/>
        <button type="button" class="camp-ing-remove" title="移除">×</button>
      </div>`;

    let pendingOutputItemData = recipe.outputItemData ? foundry.utils.deepClone(recipe.outputItemData) : null;
    let pendingOutputImg      = recipe.outputImg || "icons/svg/item-bag.svg";
    const campActor           = this.actor;

    new Dialog({
      title:   `编辑配方：${recipe.name}`,
      content: `
        <form class="limbuscompany camp-recipe-editor" autocomplete="off">
          <div class="camp-editor-row">
            <label>配方名称</label>
            <input type="text" id="re-name" value="${foundry.utils.escapeHTML(recipe.name)}" style="flex:1"/>
          </div>
          <div class="camp-editor-section-title">原料</div>
          <div id="re-ing-list" class="camp-editor-ing-list">
            ${(recipe.ingredients ?? []).map((ing, i) => buildIngRow(ing, i)).join("")}
          </div>
          <button type="button" id="re-add-ing" class="camp-editor-add-btn">+ 添加原料</button>
          <div class="camp-editor-section-title">产出</div>
          <div class="camp-editor-row camp-editor-output-row">
            <img id="re-output-img" src="${pendingOutputImg}" width="32" height="32"
                 class="camp-output-drag-target" title="拖拽物品到此处自动填入">
            <input type="text"   id="re-output-name" value="${foundry.utils.escapeHTML(recipe.outputName || "")}" placeholder="产出物品名称" style="width:140px"/>
            <span>×</span>
            <input type="number" id="re-output-qty"  value="${recipe.outputQuantity || 1}" min="1" style="width:50px"/>
          </div>
          ${pendingOutputItemData
            ? `<div class="camp-editor-hint" style="color:#7CFC00" id="re-output-status">✓ 已绑定产出物品</div>`
            : `<div class="camp-editor-hint" style="color:orange" id="re-output-status">⚠ 尚未绑定产出物品</div>`}
          <div class="camp-editor-hint">将物品图标拖到产出区域或原料图标处，自动填入名称与图片</div>
        </form>`,
      buttons: {
        save: {
          label: "保存",
          callback: async (html) => {
            const name    = html.find("#re-name").val()?.trim() || recipe.name;
            const outName = html.find("#re-output-name").val()?.trim() || "";
            const outQty  = Math.max(1, parseInt(html.find("#re-output-qty").val()) || 1);

            const ingredients = [];
            html.find(".camp-recipe-ing-row").each((_, row) => {
              const $row   = $(row);
              const ingName = $row.find(".camp-ing-name").val()?.trim();
              const ingQty  = Math.max(1, parseInt($row.find(".camp-ing-qty").val()) || 1);
              const ingImg  = $row.find("img").attr("src") || "icons/svg/item-bag.svg";
              if (ingName) ingredients.push({ name: ingName, img: ingImg, quantity: ingQty });
            });

            await campActor.update({
              "system.recipes": (campActor.system.recipes ?? []).map(r =>
                r.id !== recipeId ? r : {
                  ...r, name, ingredients,
                  outputName: outName, outputImg: pendingOutputImg,
                  outputQuantity: outQty, outputItemData: pendingOutputItemData,
                }),
            });
          },
        },
        cancel: { label: "取消" },
      },
      default: "save",
      render: (html) => {
        // 添加原料行
        html.find("#re-add-ing").on("click", () => {
          const idx    = html.find(".camp-recipe-ing-row").length;
          const newRow = $(buildIngRow({ name: "", img: "icons/svg/item-bag.svg", quantity: 1 }, idx));
          html.find("#re-ing-list").append(newRow);
          bindRow(newRow);
        });

        // 绑定原料行事件
        const bindRow = ($row) => {
          $row.find(".camp-ing-remove").on("click", () => $row.remove());
          const imgEl = $row.find("img.camp-ing-drag-target")[0];
          imgEl.addEventListener("dragover", e => e.preventDefault());
          imgEl.addEventListener("drop", async e => {
            e.preventDefault();
            const data = LimbusCampSheet._getDragData(e);
            if (!data || data.type !== "Item") return;
            const itm = await fromUuid(data.uuid);
            if (!itm) return;
            $(imgEl).attr("src", itm.img);
            $row.find(".camp-ing-name").val(itm.name);
          });
        };
        html.find(".camp-recipe-ing-row").each((_, row) => bindRow($(row)));

        // 产出图标拖拽
        const outImgEl = html.find("#re-output-img")[0];
        outImgEl.addEventListener("dragover", e => e.preventDefault());
        outImgEl.addEventListener("drop", async e => {
          e.preventDefault();
          const data = LimbusCampSheet._getDragData(e);
          if (!data || data.type !== "Item") return;
          const itm = await fromUuid(data.uuid);
          if (!itm) return;
          pendingOutputItemData = itm.toObject();
          pendingOutputImg      = itm.img;
          $(outImgEl).attr("src", itm.img);
          html.find("#re-output-name").val(itm.name);
          html.find("#re-output-status").text("✓ 已绑定产出物品：" + itm.name).css("color", "#7CFC00");
        });
      },
    }).render(true);
  }

  /* ─── 制作 ─────────────────────────────────────────────────────────── */

  async _onCraft(event) {
    const recipeId = event.currentTarget.dataset.recipeId;
    if (this._pendingCraftIds.has(recipeId)) return;

    // 乐观锁：立即禁用按钮，防止重复点击
    this._pendingCraftIds.add(recipeId);
    this.render(false);

    if (game.user.isGM) {
      try {
        await LimbusCampSheet._gmExecuteCraft({
          campActorId: this.actor.id, recipeId, userId: game.user.id,
        });
      } finally {
        // GM 侧：制作完成（成功或失败）后立即解锁
        this._pendingCraftIds.delete(recipeId);
        this.render(false);
      }
    } else {
      game.socket.emit("system.limbusCompany_FVTT", {
        type: "campCraft", campActorId: this.actor.id, recipeId, userId: game.user.id,
      });
      // 玩家侧：1 秒超时保底解锁（正常情况下服务端同步会更新按钮状态）
      setTimeout(() => {
        if (this._pendingCraftIds.delete(recipeId)) this.render(false);
      }, 1000);
    }
  }

  /* ─── 静态：GM 端执行制作 ────────────────────────────────────────────── */

  static async _gmExecuteCraft({ campActorId, recipeId, userId }) {
    const campActor = game.actors.get(campActorId);
    const recipe    = (campActor?.system?.recipes ?? []).find(r => r.id === recipeId);
    if (!campActor || !recipe) return;

    // ── 1. 检查原料（只计算实际放置在仓库格中的物品，与 getData 逻辑一致） ──
    const placedIds    = new Set(
      (campActor.system.warehouseContents ?? []).map(p => p.uuid.split(".").pop())
    );
    const currentItems = campActor.items.contents.filter(i => placedIds.has(i.id));
    const ingDetails   = (recipe.ingredients ?? []).map(ing => {
      const matches = currentItems.filter(i => i.name === ing.name);
      const hasInfinite = matches.some(i => i.system?.infinite);
      const available = hasInfinite
        ? ing.quantity
        : matches.reduce((s, i) => s + (i.system?.quantity ?? 1), 0);
      return { ...ing, available, sufficient: available >= ing.quantity };
    });

    if (!ingDetails.every(d => d.sufficient) || ingDetails.length === 0 || !recipe.outputItemData) {
      ui.notifications.warn("原料不足或配方未配置产出，无法制作。");
      return;
    }

    // ── 2. 计算要删除/更新的物品 ────────────────────────────────────
    const idsToDelete = [];
    const bulkUpdates = [];

    for (const ing of (recipe.ingredients ?? [])) {
      const ingItems = currentItems.filter(i => i.name === ing.name);
      // 无限耐久：仓库中存在即满足，完全不消耗数量
      if (ingItems.some(i => i.system?.infinite)) continue;

      let remaining = ing.quantity;
      for (const item of ingItems) {
        if (remaining <= 0) break;
        const qty      = item.system?.quantity ?? 1;
        const reusable = item.system?.reusable  ?? false;
        if (qty <= remaining) {
          remaining -= qty;
          if (reusable) {
            // 可复用物品：数量归零保留，与正常使用语义一致
            bulkUpdates.push({ _id: item.id, "system.quantity": 0 });
          } else {
            idsToDelete.push(item.id);
          }
        } else {
          bulkUpdates.push({ _id: item.id, "system.quantity": qty - remaining });
          remaining = 0;
        }
      }
    }

    // ── 3. 执行原料消耗 ──────────────────────────────────────────────
    if (idsToDelete.length)
      await campActor.deleteEmbeddedDocuments("Item", idsToDelete);
    if (bulkUpdates.length)
      await campActor.updateEmbeddedDocuments("Item", bulkUpdates);

    // ── 4. 创建产出物品 ──────────────────────────────────────────────
    const outData = foundry.utils.deepClone(recipe.outputItemData);
    delete outData._id;
    if (outData.system?.quantity !== undefined) outData.system.quantity = recipe.outputQuantity;
    const [outItem] = await campActor.createEmbeddedDocuments("Item", [outData]);

    // ── 5. 用预先计算的 idsToDelete 集合过滤 warehouseContents ──────
    // 不依赖 campActor.items.contents 的即时刷新状态（EmbeddedCollection
    // 在 deleteEmbeddedDocuments resolve 时可能仍有短暂缓存延迟），
    // 而是明确排除本次制作中已标记删除的物品 ID。
    const deletedIds  = new Set(idsToDelete);
    const newContents = (campActor.system.warehouseContents ?? []).filter(p =>
      !deletedIds.has(p.uuid.split(".").pop())
    );

    const sys  = campActor.system;
    const cols = sys.warehouseSize?.width  ?? 7;
    const rows = sys.warehouseSize?.height ?? 7;
    const cap  = outData.system?.capacity ?? { w: 1, h: 1 };
    const ow   = Math.max(1, cap.w ?? 1), oh = Math.max(1, cap.h ?? 1);

    const canPlaceStatic = (x, y, w, h, cur) => {
      if (x < 0 || y < 0 || x + w > cols || y + h > rows) return false;
      for (const p of cur) {
        const pw = p.w ?? 1, ph = p.h ?? 1;
        for (let dy = 0; dy < h; dy++)
          for (let dx = 0; dx < w; dx++)
            if (p.x <= x + dx && x + dx < p.x + pw &&
                p.y <= y + dy && y + dy < p.y + ph) return false;
      }
      return true;
    };

    let place = null;
    outer: for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (canPlaceStatic(x, y, ow, oh, newContents)) { place = { x, y, w: ow, h: oh, rotated: false }; break outer; }
        if (ow !== oh && canPlaceStatic(x, y, oh, ow, newContents)) { place = { x, y, w: oh, h: ow, rotated: true }; break outer; }
      }
    }

    if (place) {
      newContents.push({ uuid: outItem.uuid, ...place });
    } else {
      ui.notifications.warn(`[营地] 产出 ${recipe.outputName} 无法放入仓库（空间不足），已创建为悬空物品。`);
    }
    await campActor.update({ "system.warehouseContents": newContents });

    const triggerUser = game.users.get(userId);
    await ChatMessage.create({
      content: `<div class="limbuscompany chat-camp">
        ${triggerUser ? `<strong>${triggerUser.name}</strong> 在` : ""}营地【${campActor.name}】制作了
        <img src="${recipe.outputImg}" width="16" height="16" style="vertical-align:middle">
        <strong>${recipe.outputName} ×${recipe.outputQuantity}</strong>，已存入仓库！
      </div>`,
    });
  }

  /* ─── 静态：GM 端执行取出物品 ──────────────────────────────────────── */

  static async _gmExecuteTakeItem({ campActorId, itemUuid, placementIdx, quantity, userId, charId }) {
    const campActor = game.actors.get(campActorId);
    if (!campActor) return;

    const item = await fromUuid(itemUuid).catch(() => null);
    if (!item || item.parent?.id !== campActorId) return;

    const playerChar = game.actors.get(charId) ??
      game.actors.find(a => a.type === "character" &&
        a.ownership?.[userId] >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    if (!playerChar) { ui.notifications.warn("[营地] 找不到目标角色，取出失败。"); return; }

    const maxQty = item.system?.quantity ?? 1;
    const qty    = Math.min(maxQty, Math.max(1, quantity));
    const newQty = maxQty - qty;

    // 取出前快照物品数据（delete 后 toObject 仍可用，但提前保存更安全）
    const itemData = item.toObject();

    // 更新仓库 contents：若数量归零则同时移除放置记录并删除物品
    const contents = foundry.utils.deepClone(campActor.system.warehouseContents ?? []);
    if (newQty <= 0) {
      contents.splice(placementIdx, 1);
      await campActor.update({ "system.warehouseContents": contents });
      // 再次确认物品仍属于仓库（防竞态：可能已被并发制作消耗）
      const stillExists = campActor.items.get(item.id);
      if (!stillExists) {
        ui.notifications.warn(`[营地] ${item.name} 已被制作消耗，无法取回。`);
        return;
      }
      await item.delete();
    } else {
      await item.update({ "system.quantity": newQty });
    }

    // 创建物品到玩家角色
    if (itemData.system?.quantity !== undefined) itemData.system.quantity = qty;
    await playerChar.createEmbeddedDocuments("Item", [itemData]);
    ui.notifications.info(`${item.name} ×${qty} 已移至 ${playerChar.name} 的背包。`);
  }

  /* ─── 静态：GM 端执行玩家拖入物品 ─────────────────────────────────── */

  static async _gmExecuteDropItem({ campActorId, itemUuid, sourceActorId, itemData, targetX, targetY }) {
    const campActor = game.actors.get(campActorId);
    if (!campActor) return;

    const sys  = campActor.system;
    const cols = sys.warehouseSize?.width  ?? 7;
    const rows = sys.warehouseSize?.height ?? 7;
    const cur  = foundry.utils.deepClone(sys.warehouseContents ?? []);

    // 碰撞检测（内联静态版）
    const canPlace = (x, y, w, h) => {
      if (x < 0 || y < 0 || x + w > cols || y + h > rows) return false;
      for (const p of cur) {
        const pw = p.w ?? 1, ph = p.h ?? 1;
        for (let dy = 0; dy < h; dy++)
          for (let dx = 0; dx < w; dx++)
            if (p.x <= x + dx && x + dx < p.x + pw &&
                p.y <= y + dy && y + dy < p.y + ph) return false;
      }
      return true;
    };

    const data = foundry.utils.deepClone(itemData);
    delete data._id;
    const cap = data.system?.capacity ?? { w: 1, h: 1 };
    const w = Math.max(1, cap.w ?? 1), h = Math.max(1, cap.h ?? 1);

    // 优先放目标格，否则自动寻位
    let place = canPlace(targetX, targetY, w, h)
      ? { x: targetX, y: targetY, w, h, rotated: false }
      : null;
    if (!place) {
      outer: for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if (canPlace(x, y, w, h)) { place = { x, y, w, h, rotated: false }; break outer; }
          if (w !== h && canPlace(x, y, h, w)) { place = { x, y, w: h, h: w, rotated: true }; break outer; }
        }
      }
    }
    if (!place) { ui.notifications.warn("仓库空间不足，无法存入。"); return; }

    // 在仓库创建物品
    const [newItem] = await campActor.createEmbeddedDocuments("Item", [data]);
    cur.push({ uuid: newItem.uuid, x: place.x, y: place.y, w: place.w, h: place.h, rotated: place.rotated });
    await campActor.update({ "system.warehouseContents": cur });

    // 从源角色删除原物品
    const srcItem = await fromUuid(itemUuid).catch(() => null);
    if (srcItem && srcItem.parent?.id === sourceActorId) await srcItem.delete();
  }

  /* ─── 静态：GM 端执行玩家移动仓库物品 ──────────────────────────────── */

  static async _gmExecuteMoveItem({ campActorId, placementIdx, nx, ny }) {
    const campActor = game.actors.get(campActorId);
    if (!campActor) return;

    const sys      = campActor.system;
    const cols     = sys.warehouseSize?.width  ?? 7;
    const rows     = sys.warehouseSize?.height ?? 7;
    const contents = foundry.utils.deepClone(sys.warehouseContents ?? []);
    const p        = contents[placementIdx];
    if (!p) return;

    const pw = p.w ?? 1, ph = p.h ?? 1;
    if (nx < 0 || ny < 0 || nx + pw > cols || ny + ph > rows) {
      ui.notifications.warn("此位置超出仓库边界。"); return;
    }
    for (let i = 0; i < contents.length; i++) {
      if (i === placementIdx) continue;
      const q = contents[i], qw = q.w ?? 1, qh = q.h ?? 1;
      for (let dy = 0; dy < ph; dy++)
        for (let dx = 0; dx < pw; dx++)
          if (q.x <= nx + dx && nx + dx < q.x + qw &&
              q.y <= ny + dy && ny + dy < q.y + qh) {
            ui.notifications.warn("此位置与其他物品重叠。"); return;
          }
    }
    p.x = nx; p.y = ny;
    await campActor.update({ "system.warehouseContents": contents });
  }

  /* ─── 静态：GM 端执行玩家旋转仓库物品 ──────────────────────────────── */

  static async _gmExecuteRotateItem({ campActorId, placementIdx }) {
    const campActor = game.actors.get(campActorId);
    if (!campActor) return;
    const sys      = campActor.system;
    const cols     = sys.warehouseSize?.width  ?? 7;
    const rows     = sys.warehouseSize?.height ?? 7;
    const contents = foundry.utils.deepClone(sys.warehouseContents ?? []);
    const p        = contents[placementIdx];
    if (!p) return;
    const newW = p.h ?? 1, newH = p.w ?? 1;
    // 碰撞检测
    if (newW < 0 || newH < 0 || p.x + newW > cols || p.y + newH > rows) {
      return; // 超出边界，忽略
    }
    for (let i = 0; i < contents.length; i++) {
      if (i === placementIdx) continue;
      const q = contents[i], qw = q.w ?? 1, qh = q.h ?? 1;
      for (let dy = 0; dy < newH; dy++)
        for (let dx = 0; dx < newW; dx++)
          if (q.x <= p.x + dx && p.x + dx < q.x + qw &&
              q.y <= p.y + dy && p.y + dy < q.y + qh) return; // 重叠，忽略
    }
    p.w = newW; p.h = newH; p.rotated = !(p.rotated ?? false);
    await campActor.update({ "system.warehouseContents": contents });
  }

  /* ─── Socket 消息处理（操作序列化，防竞态） ──────────────────────── */

  static async handleSocketMsg(msg) {
    if (!game.user.isGM) return;
    const campActorId = msg.campActorId;
    if (!campActorId) return;

    // 将操作排入该营地 Actor 的串行队列，避免并发导致竞态
    const prev = LimbusCampSheet._opQueues.get(campActorId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      if      (msg.type === "campCraft")      await LimbusCampSheet._gmExecuteCraft(msg);
      else if (msg.type === "campTakeItem")   await LimbusCampSheet._gmExecuteTakeItem(msg);
      else if (msg.type === "campDropItem")   await LimbusCampSheet._gmExecuteDropItem(msg);
      else if (msg.type === "campMoveItem")   await LimbusCampSheet._gmExecuteMoveItem(msg);
      else if (msg.type === "campRotateItem") await LimbusCampSheet._gmExecuteRotateItem(msg);
    }).finally(() => {
      if (LimbusCampSheet._opQueues.get(campActorId) === next)
        LimbusCampSheet._opQueues.delete(campActorId);
    });
    LimbusCampSheet._opQueues.set(campActorId, next);
  }

  /* ─── 工具 ─────────────────────────────────────────────────────────── */

  static _getDragData(event) {
    try { return JSON.parse(event.dataTransfer?.getData("text/plain") ?? "{}"); }
    catch { return null; }
  }
}
