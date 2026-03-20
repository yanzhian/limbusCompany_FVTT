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
    ctx.recipes = (sys.recipes ?? [])
      .filter(r => isGM || !r.hidden)
      .map(recipe => {
        const ingDetails = this._getIngredientDetails(recipe, actor.items.contents);
        const canCraft   = ingDetails.every(d => d.sufficient) &&
                           ingDetails.length > 0 &&
                           !!recipe.outputItemData;
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
      const available = warehouseItems
        .filter(i => i.name === ing.name)
        .reduce((s, i) => s + (i.system?.quantity ?? 1), 0);
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

    // 仓库图块：右键取出
    html.find(".cg-item-tile").on("contextmenu", e => {
      e.preventDefault();
      const idx  = parseInt(e.currentTarget.dataset.placementIdx ?? "-1");
      this._showTileContextMenu(idx);
    });

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

    // 玩家不能拖放到仓库
    if (!game.user.isGM) return;

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
      const contents = foundry.utils.deepClone(sys.warehouseContents ?? []);
      const p = contents[idx];
      if (!p) return;
      const nx = targetX - offX, ny = targetY - offY;
      if (!this._whCanPlace(nx, ny, p.w ?? 1, p.h ?? 1, cols, rows, idx))
        return void ui.notifications.warn("此位置无法放置（超出边界或与其他物品重叠）");
      p.x = nx; p.y = ny;
      return void await this.actor.update({ "system.warehouseContents": contents });
    }

    // ── 外部物品拖入 ──────────────────────────────────────────────────
    const dropped = await Item.fromDropData(raw).catch(() => null);
    if (!dropped) return;
    if (dropped.type === "container" || dropped.type === "camp") return;

    const cap = dropped.system?.capacity ?? { w: 1, h: 1 };
    const w = Math.max(1, cap.w ?? 1), h = Math.max(1, cap.h ?? 1);

    const place = this._whCanPlace(targetX, targetY, w, h, cols, rows)
      ? { x: targetX, y: targetY, w, h, rotated: false }
      : this._whAutoPlace(w, h);
    if (!place) return void ui.notifications.warn("仓库空间不足，无法放置该物品。");

    const sourceActor = dropped.parent;
    let   storedUuid  = dropped.uuid;

    // 跨 Actor 拖入：复制物品到 camp actor（不删除源物品，仓库是"存入"）
    if (sourceActor && sourceActor.id !== this.actor.id) {
      const itemData = dropped.toObject();
      const [newItem] = await this.actor.createEmbeddedDocuments("Item", [itemData]);
      storedUuid = newItem.uuid;
    } else if (!sourceActor) {
      // 世界物品（无 actor）：复制数据
      const itemData = dropped.toObject();
      const [newItem] = await this.actor.createEmbeddedDocuments("Item", [itemData]);
      storedUuid = newItem.uuid;
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

    // 计算鼠标在图块内的偏移（格子单位）
    const cellSize = 36; // 像素（与 CSS 一致）
    const rect     = tile.getBoundingClientRect();
    const offX     = Math.floor((event.originalEvent.clientX - rect.left)  / cellSize);
    const offY     = Math.floor((event.originalEvent.clientY - rect.top)   / cellSize);

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
    event.stopPropagation();
    if (!game.user.isGM || !this._editUnlocked) return;
    const idx = parseInt(event.currentTarget.dataset.placementIdx ?? "-1");
    if (idx < 0) return;

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
  }

  /* ─── 图块右键：取出物品 ────────────────────────────────────────────── */

  _showTileContextMenu(placementIdx) {
    const contents = this.actor.system.warehouseContents ?? [];
    const p        = contents[placementIdx];
    if (!p) return;

    // 通过 UUID 获取物品名（async → 使用 Promise）
    fromUuid(p.uuid).then(item => {
      if (!item) return;
      const maxQty = item.system?.quantity ?? 1;
      const sheet  = this;

      new Dialog({
        title: `取出 — ${item.name}`,
        content: `
          <div class="limbuscompany" style="padding:6px 0">
            <p>将物品移至你的角色背包。</p>
            <label style="display:flex;align-items:center;gap:8px">
              取出数量：
              <input type="number" id="take-qty" value="${Math.min(1, maxQty)}" min="1" max="${maxQty}" style="width:60px"/>
              <span>（仓库剩余：${maxQty}）</span>
            </label>
          </div>`,
        buttons: {
          take: {
            label: "取出",
            callback: async (html) => {
              const qty = Math.min(maxQty, Math.max(1, parseInt(html.find("#take-qty").val()) || 1));
              await sheet._executeItemTake(sheet.actor.id, p.uuid, placementIdx, qty);
            },
          },
          cancel: { label: "取消" },
        },
        default: "take",
      }).render(true);
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

    if (game.user.isGM) {
      await LimbusCampSheet._gmExecuteCraft({
        campActorId: this.actor.id, recipeId,
        charId: game.user.character?.id ?? null, userId: game.user.id,
      });
    } else {
      const myChar = game.user.character;
      if (!myChar) { ui.notifications.warn("找不到你的角色，无法领取制作产物。"); return; }
      game.socket.emit("system.limbusCompany_FVTT", {
        type: "campCraft", campActorId: this.actor.id, recipeId,
        charId: myChar.id, userId: game.user.id,
      });
    }
  }

  /* ─── 静态：GM 端执行制作 ────────────────────────────────────────────── */

  static async _gmExecuteCraft({ campActorId, recipeId, charId, userId }) {
    const campActor = game.actors.get(campActorId);
    const recipe    = (campActor?.system?.recipes ?? []).find(r => r.id === recipeId);
    if (!campActor || !recipe) return;

    const playerChar = game.actors.get(charId) ??
      game.actors.find(a => a.type === "character" &&
        a.ownership?.[userId] >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    if (!playerChar) {
      ui.notifications.warn(`[营地] 找不到玩家角色，制作失败。`);
      return;
    }

    const allItems   = campActor.items.contents;
    const ingDetails = (recipe.ingredients ?? []).map(ing => {
      const available = allItems.filter(i => i.name === ing.name)
        .reduce((s, i) => s + (i.system?.quantity ?? 1), 0);
      return { ...ing, available, sufficient: available >= ing.quantity };
    });

    if (!ingDetails.every(d => d.sufficient) || ingDetails.length === 0 || !recipe.outputItemData) {
      ui.notifications.warn("原料不足或配方未配置产出，无法制作。");
      return;
    }

    // 消耗原料
    for (const ing of (recipe.ingredients ?? [])) {
      let remaining = ing.quantity;
      for (const item of [...allItems].filter(i => i.name === ing.name)) {
        if (remaining <= 0) break;
        const qty = item.system?.quantity ?? 1;
        if (qty <= remaining) { remaining -= qty; await item.delete(); }
        else { await item.update({ "system.quantity": qty - remaining }); remaining = 0; }
      }
    }

    // 创建产出
    const outData = foundry.utils.deepClone(recipe.outputItemData);
    if (outData.system?.quantity !== undefined) outData.system.quantity = recipe.outputQuantity;
    await playerChar.createEmbeddedDocuments("Item", [outData]);

    await ChatMessage.create({
      content: `<div class="limbuscompany chat-camp">
        <strong>${playerChar.name}</strong> 在营地【${campActor.name}】制作了
        <img src="${recipe.outputImg}" width="16" height="16" style="vertical-align:middle">
        <strong>${recipe.outputName} ×${recipe.outputQuantity}</strong>！
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

    // 更新仓库 contents：若数量归零则同时移除放置记录
    const contents = foundry.utils.deepClone(campActor.system.warehouseContents ?? []);
    if (newQty <= 0) {
      contents.splice(placementIdx, 1);
      await campActor.update({ "system.warehouseContents": contents });
      await item.delete();
    } else {
      await item.update({ "system.quantity": newQty });
    }

    // 创建物品到玩家角色
    const itemData = item.toObject();
    if (itemData.system?.quantity !== undefined) itemData.system.quantity = qty;
    await playerChar.createEmbeddedDocuments("Item", [itemData]);
    ui.notifications.info(`${item.name} ×${qty} 已移至 ${playerChar.name} 的背包。`);
  }

  /* ─── Socket 消息处理 ─────────────────────────────────────────────── */

  static async handleSocketMsg(msg) {
    if (!game.user.isGM) return;
    if      (msg.type === "campCraft")    await LimbusCampSheet._gmExecuteCraft(msg);
    else if (msg.type === "campTakeItem") await LimbusCampSheet._gmExecuteTakeItem(msg);
  }

  /* ─── 工具 ─────────────────────────────────────────────────────────── */

  static _getDragData(event) {
    try { return JSON.parse(event.dataTransfer?.getData("text/plain") ?? "{}"); }
    catch { return null; }
  }
}
