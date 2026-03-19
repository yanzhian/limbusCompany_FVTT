/**
 * camp-sheet.mjs — 营地角色卡 Sheet
 *
 * 双栏布局：
 *   左栏：仓库（嵌入物品列表，支持拖入/拖出/右键取出）
 *   右栏：配方列表（制作按钮 + GM 编辑）
 *
 * 权限区分：
 *   GM   → 可编辑仓库（拖入物品）/ 添加-编辑-删除-隐藏配方
 *   玩家 → 查看仓库、查看可见配方、点击制作（socket → GM 执行）、右键取出物品（socket → GM 执行）
 */
export class LimbusCampSheet extends ActorSheet {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes:   ["limbuscompany", "sheet", "actor", "camp"],
      template:  "systems/limbusCompany_FVTT/templates/actor/camp-sheet.hbs",
      width:     800,
      height:    540,
      resizable: true,
    });
  }

  /* ─── 状态 ──────────────────────────────────────────────────────────── */

  /** GM 编辑锁（false = 锁定） */
  _editUnlocked = false;

  /* ─── getData ────────────────────────────────────────────────────────── */

  /** @override */
  async getData(options = {}) {
    const ctx   = await super.getData(options);
    const actor = this.actor;
    const sys   = actor.system;
    const isGM  = game.user.isGM;

    ctx.isGM         = isGM;
    ctx.editUnlocked = this._editUnlocked;
    ctx.description  = sys.description ?? "";

    // ── 仓库物品列表（嵌入该 Actor 的所有 Item） ─────────────────────────
    ctx.warehouseItems = actor.items.contents.map(item => ({
      id:       item.id,
      name:     item.name,
      img:      item.img,
      type:     item.type,
      quantity: item.system?.quantity ?? 1,
    }));

    // ── 配方列表（玩家过滤隐藏） ──────────────────────────────────────────
    const allItems = actor.items.contents;
    ctx.recipes = (sys.recipes ?? [])
      .filter(r => isGM || !r.hidden)
      .map(recipe => {
        const canCraft     = this._canCraft(recipe, allItems);
        const ingDetails   = this._getIngredientDetails(recipe, allItems);
        return { ...recipe, canCraft, ingDetails };
      });

    return ctx;
  }

  /* ─── 配方检查 ─────────────────────────────────────────────────────── */

  /** 检查仓库中原料是否充足 */
  _canCraft(recipe, warehouseItems) {
    for (const ing of (recipe.ingredients ?? [])) {
      if (!ing.name) continue;
      const total = warehouseItems
        .filter(i => i.name === ing.name)
        .reduce((s, i) => s + (i.system?.quantity ?? 1), 0);
      if (total < ing.quantity) return false;
    }
    return recipe.ingredients?.length > 0 && !!recipe.outputItemData;
  }

  /** 返回每种原料的可用数量（供模板着色显示） */
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

    // 编辑锁切换（GM 专用）
    html.find(".camp-lock-toggle").on("click", () => {
      this._editUnlocked = !this._editUnlocked;
      this.render(false);
    });

    // GM：添加配方
    html.find(".camp-add-recipe").on("click", this._onAddRecipe.bind(this));

    // GM：编辑配方
    html.find(".camp-recipe-edit").on("click", this._onEditRecipe.bind(this));

    // GM：删除配方
    html.find(".camp-recipe-delete").on("click", this._onDeleteRecipe.bind(this));

    // GM：隐藏/显示配方
    html.find(".camp-recipe-hide").on("click", this._onToggleRecipeHidden.bind(this));

    // GM：仓库物品数量直接编辑
    html.find(".camp-item-qty-input").on("change", this._onWarehouseQtyChange.bind(this));

    // GM：移除仓库物品
    html.find(".camp-warehouse-remove").on("click", this._onRemoveWarehouseItem.bind(this));

    // 制作按钮
    html.find(".camp-craft-btn:not([disabled])").on("click", this._onCraft.bind(this));

    // 仓库物品拖动（拖出到角色卡背包）
    html.find(".camp-warehouse-item[draggable]").on("dragstart", this._onWarehouseDragStart.bind(this));

    // 仓库物品右键菜单
    html.find(".camp-warehouse-item").on("contextmenu", (e) => {
      e.preventDefault();
      const itemId = e.currentTarget.dataset.itemId;
      this._showWarehouseContextMenu(html, itemId, e.pageX, e.pageY);
    });
  }

  /* ─── 拖拽接受（GM 拖入物品到仓库） ──────────────────────────────────── */

  /** @override */
  async _onDrop(event) {
    if (!game.user.isGM) return;

    // 只在仓库区域接受拖放
    if (!event.target.closest(".camp-warehouse-area")) return;

    let data;
    try {
      data = JSON.parse(event.dataTransfer?.getData("text/plain") ?? "{}");
    } catch {
      return;
    }
    if (data.type !== "Item") return;

    const srcItem = await fromUuid(data.uuid);
    if (!srcItem) return;

    // 拒绝放入 container 类型，防止嵌套
    if (srcItem.type === "container" || srcItem.type === "camp") return;

    const itemData = srcItem.toObject();
    // 如果是从某个 Actor 身上拖来的，只复制数据（不移动）
    await this.actor.createEmbeddedDocuments("Item", [itemData]);
    ui.notifications.info(`${srcItem.name} 已添加到仓库。`);
  }

  /* ─── 仓库物品数量编辑 ────────────────────────────────────────────── */

  async _onWarehouseQtyChange(event) {
    const itemId = event.currentTarget.dataset.itemId;
    const newQty = Math.max(0, parseInt(event.currentTarget.value) || 0);
    const item   = this.actor.items.get(itemId);
    if (!item) return;
    if (newQty <= 0) {
      await item.delete();
    } else {
      await item.update({ "system.quantity": newQty });
    }
  }

  /* ─── 移除仓库物品 ────────────────────────────────────────────────── */

  async _onRemoveWarehouseItem(event) {
    event.stopPropagation();
    const itemId = event.currentTarget.dataset.itemId;
    await this.actor.items.get(itemId)?.delete();
  }

  /* ─── 仓库物品拖出 ────────────────────────────────────────────────── */

  _onWarehouseDragStart(event) {
    const itemId = event.currentTarget.dataset.itemId;
    const item   = this.actor.items.get(itemId);
    if (!item) return;
    const dragData = item.toDragData();
    event.originalEvent?.dataTransfer?.setData("text/plain", JSON.stringify(dragData));
  }

  /* ─── 仓库物品右键菜单 ────────────────────────────────────────────── */

  _showWarehouseContextMenu(html, itemId, x, y) {
    const item = this.actor.items.get(itemId);
    if (!item) return;

    // 使用 ContextMenu 需要挂载点，改用简单 Dialog
    const maxQty = item.system?.quantity ?? 1;
    const actor  = this.actor;
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
            await sheet._executeItemTake(actor.id, itemId, qty);
          },
        },
        cancel: { label: "取消" },
      },
      default: "take",
    }).render(true);
  }

  /**
   * 执行取出操作：GM 直接执行，玩家通过 socket 委托 GM。
   */
  async _executeItemTake(campActorId, itemId, quantity) {
    if (game.user.isGM) {
      await LimbusCampSheet._gmExecuteTakeItem({ campActorId, itemId, quantity, userId: game.user.id });
    } else {
      game.socket.emit("system.limbusCompany_FVTT", {
        type:         "campTakeItem",
        campActorId,
        itemId,
        quantity,
        userId:       game.user.id,
        charId:       game.user.character?.id ?? null,
      });
    }
  }

  /* ─── 配方操作 ─────────────────────────────────────────────────────── */

  async _onAddRecipe() {
    const recipes = foundry.utils.deepClone(this.actor.system.recipes ?? []);
    recipes.push({
      id:             foundry.utils.randomID(),
      name:           "新配方",
      hidden:         false,
      ingredients:    [],
      outputName:     "",
      outputImg:      "icons/svg/item-bag.svg",
      outputQuantity: 1,
      outputItemData: null,
    });
    await this.actor.update({ "system.recipes": recipes });
  }

  async _onDeleteRecipe(event) {
    event.stopPropagation();
    const recipeId = event.currentTarget.dataset.recipeId;
    const recipes  = (this.actor.system.recipes ?? []).filter(r => r.id !== recipeId);
    await this.actor.update({ "system.recipes": recipes });
  }

  async _onToggleRecipeHidden(event) {
    event.stopPropagation();
    const recipeId = event.currentTarget.dataset.recipeId;
    const recipes  = (this.actor.system.recipes ?? []).map(r =>
      r.id === recipeId ? { ...r, hidden: !r.hidden } : r
    );
    await this.actor.update({ "system.recipes": recipes });
  }

  /* ─── 配方编辑 Dialog ─────────────────────────────────────────────── */

  async _onEditRecipe(event) {
    event.stopPropagation();
    const recipeId = event.currentTarget.dataset.recipeId;
    const recipe   = (this.actor.system.recipes ?? []).find(r => r.id === recipeId);
    if (!recipe) return;

    // 构建原料行 HTML
    const buildIngRow = (ing, idx) => `
      <div class="camp-recipe-ing-row" data-idx="${idx}">
        <img src="${ing.img || "icons/svg/item-bag.svg"}" width="22" height="22"
             class="camp-ing-drag-target" title="拖拽物品到此处自动填入">
        <input type="text" class="camp-ing-name" value="${foundry.utils.escapeHTML(ing.name)}" placeholder="原料名称" style="width:130px"/>
        <span>×</span>
        <input type="number" class="camp-ing-qty" value="${ing.quantity}" min="1" style="width:50px"/>
        <button type="button" class="camp-ing-remove" title="移除">×</button>
      </div>`;

    const ingHtml = (recipe.ingredients ?? []).map((ing, i) => buildIngRow(ing, i)).join("");

    const outputImg  = recipe.outputImg  || "icons/svg/item-bag.svg";
    const outputName = recipe.outputName || "";
    const outputQty  = recipe.outputQuantity || 1;

    const dialogContent = `
      <form class="limbuscompany camp-recipe-editor" autocomplete="off">
        <div class="camp-editor-row">
          <label>配方名称</label>
          <input type="text" id="re-name" value="${foundry.utils.escapeHTML(recipe.name)}" style="flex:1"/>
        </div>

        <div class="camp-editor-section-title">原料</div>
        <div id="re-ing-list" class="camp-editor-ing-list">${ingHtml}</div>
        <button type="button" id="re-add-ing" class="camp-editor-add-btn">+ 添加原料</button>

        <div class="camp-editor-section-title">产出</div>
        <div class="camp-editor-row camp-editor-output-row">
          <img id="re-output-img" src="${outputImg}" width="32" height="32"
               class="camp-output-drag-target" title="拖拽物品到此处自动填入物品数据">
          <input type="text" id="re-output-name" value="${foundry.utils.escapeHTML(outputName)}" placeholder="产出物品名称" style="width:140px"/>
          <span>×</span>
          <input type="number" id="re-output-qty" value="${outputQty}" min="1" style="width:50px"/>
        </div>
        <div class="camp-editor-hint">将物品图标拖到"产出"区域或原料图标处，自动填入名称与图片</div>
        ${recipe.outputItemData ? `<div class="camp-editor-hint" style="color:#7CFC00">✓ 已绑定产出物品数据</div>` : `<div class="camp-editor-hint" style="color:orange">⚠ 尚未绑定产出物品，玩家制作后不会产生物品</div>`}
      </form>`;

    // 临时存储产出物品数据（在 Dialog render 回调中通过 closure 传递）
    let pendingOutputItemData = recipe.outputItemData ? foundry.utils.deepClone(recipe.outputItemData) : null;
    let pendingOutputImg      = outputImg;

    const campActor = this.actor;

    new Dialog({
      title: `编辑配方：${recipe.name}`,
      content: dialogContent,
      buttons: {
        save: {
          label: "保存",
          callback: async (html) => {
            const name         = html.find("#re-name").val()?.trim() || recipe.name;
            const outName      = html.find("#re-output-name").val()?.trim() || "";
            const outQty       = Math.max(1, parseInt(html.find("#re-output-qty").val()) || 1);
            const outImg       = pendingOutputImg;

            const ingredients = [];
            html.find(".camp-recipe-ing-row").each((_, row) => {
              const $row   = $(row);
              const ingName = $row.find(".camp-ing-name").val()?.trim();
              const ingQty  = Math.max(1, parseInt($row.find(".camp-ing-qty").val()) || 1);
              const ingImg  = $row.find("img").attr("src") || "icons/svg/item-bag.svg";
              if (ingName) ingredients.push({ name: ingName, img: ingImg, quantity: ingQty });
            });

            const recipes = (campActor.system.recipes ?? []).map(r => {
              if (r.id !== recipeId) return r;
              return {
                ...r,
                name:           name,
                ingredients:    ingredients,
                outputName:     outName,
                outputImg:      outImg,
                outputQuantity: outQty,
                outputItemData: pendingOutputItemData,
              };
            });
            await campActor.update({ "system.recipes": recipes });
          },
        },
        cancel: { label: "取消" },
      },
      default: "save",
      render: (html) => {
        // ── 添加原料按钮 ────────────────────────────────────────────────
        html.find("#re-add-ing").on("click", () => {
          const idx    = html.find(".camp-recipe-ing-row").length;
          const newRow = $(buildIngRow({ name: "", img: "icons/svg/item-bag.svg", quantity: 1 }, idx));
          html.find("#re-ing-list").append(newRow);
          bindIngRow(newRow);
        });

        // ── 移除原料按钮 ────────────────────────────────────────────────
        const bindIngRow = ($row) => {
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
        html.find(".camp-recipe-ing-row").each((_, row) => bindIngRow($(row)));

        // ── 产出图标拖拽 ────────────────────────────────────────────────
        const outputImgEl = html.find("#re-output-img")[0];
        outputImgEl.addEventListener("dragover", e => e.preventDefault());
        outputImgEl.addEventListener("drop", async e => {
          e.preventDefault();
          const data = LimbusCampSheet._getDragData(e);
          if (!data || data.type !== "Item") return;
          const itm = await fromUuid(data.uuid);
          if (!itm) return;
          pendingOutputItemData = itm.toObject();
          pendingOutputImg      = itm.img;
          $(outputImgEl).attr("src", itm.img);
          html.find("#re-output-name").val(itm.name);
          // 更新提示
          html.find(".camp-editor-hint").last().remove();
          html.find(".camp-editor-hint").last().remove();
          html.find(".camp-recipe-editor").append(
            `<div class="camp-editor-hint" style="color:#7CFC00">✓ 已绑定产出物品：${itm.name}</div>`
          );
        });
      },
    }).render(true);
  }

  /* ─── 制作 ─────────────────────────────────────────────────────────── */

  async _onCraft(event) {
    const recipeId = event.currentTarget.dataset.recipeId;
    const recipe   = (this.actor.system.recipes ?? []).find(r => r.id === recipeId);
    if (!recipe) return;

    if (game.user.isGM) {
      await LimbusCampSheet._gmExecuteCraft({
        campActorId: this.actor.id,
        recipeId,
        charId:  game.user.character?.id ?? null,
        userId:  game.user.id,
      });
    } else {
      const myChar = game.user.character;
      if (!myChar) {
        ui.notifications.warn("找不到你的角色，无法领取制作产物。");
        return;
      }
      game.socket.emit("system.limbusCompany_FVTT", {
        type:        "campCraft",
        campActorId: this.actor.id,
        recipeId,
        charId:      myChar.id,
        userId:      game.user.id,
      });
    }
  }

  /* ─── 静态：GM 端执行制作（socket 回调 & 直接调用） ───────────────── */

  static async _gmExecuteCraft({ campActorId, recipeId, charId, userId }) {
    const campActor  = game.actors.get(campActorId);
    const recipe     = (campActor?.system?.recipes ?? []).find(r => r.id === recipeId);
    if (!campActor || !recipe) {
      console.error("[Camp] _gmExecuteCraft: camp 或配方不存在", { campActorId, recipeId });
      return;
    }

    const playerChar = game.actors.get(charId) ??
      game.actors.find(a => a.type === "character" && a.ownership?.[userId] >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);

    if (!playerChar) {
      const user = game.users.get(userId);
      ui.notifications.warn(`[营地] 找不到 ${user?.name ?? "玩家"} 的角色，制作失败。`);
      return;
    }

    // 检查原料
    const allItems = campActor.items.contents;
    const sheet    = { _canCraft: LimbusCampSheet._staticCanCraft };
    if (!LimbusCampSheet._staticCanCraft(recipe, allItems)) {
      ui.notifications.warn("仓库中原料不足，无法制作。");
      return;
    }

    // 消耗原料
    for (const ing of (recipe.ingredients ?? [])) {
      if (!ing.name) continue;
      let remaining = ing.quantity;
      const matching = [...allItems].filter(i => i.name === ing.name);
      for (const item of matching) {
        if (remaining <= 0) break;
        const qty = item.system?.quantity ?? 1;
        if (qty <= remaining) {
          remaining -= qty;
          await item.delete();
        } else {
          await item.update({ "system.quantity": qty - remaining });
          remaining = 0;
        }
      }
    }

    // 创建产出物品
    if (recipe.outputItemData) {
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
    } else {
      ui.notifications.warn(`配方「${recipe.name}」未绑定产出物品。`);
    }
  }

  static _staticCanCraft(recipe, warehouseItems) {
    for (const ing of (recipe.ingredients ?? [])) {
      if (!ing.name) continue;
      const total = warehouseItems
        .filter(i => i.name === ing.name)
        .reduce((s, i) => s + (i.system?.quantity ?? 1), 0);
      if (total < ing.quantity) return false;
    }
    return recipe.ingredients?.length > 0 && !!recipe.outputItemData;
  }

  /* ─── 静态：GM 端执行取出物品（socket 回调 & 直接调用） ──────────── */

  static async _gmExecuteTakeItem({ campActorId, itemId, quantity, userId, charId }) {
    const campActor = game.actors.get(campActorId);
    const item      = campActor?.items.get(itemId);
    if (!campActor || !item) return;

    const playerChar = game.actors.get(charId) ??
      game.actors.find(a => a.type === "character" && a.ownership?.[userId] >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);

    if (!playerChar) {
      ui.notifications.warn("[营地] 找不到目标角色，取出失败。");
      return;
    }

    const maxQty = item.system?.quantity ?? 1;
    const qty    = Math.min(maxQty, Math.max(1, quantity));
    const newQty = maxQty - qty;

    if (newQty <= 0) await item.delete();
    else await item.update({ "system.quantity": newQty });

    const itemData = item.toObject();
    if (itemData.system?.quantity !== undefined) itemData.system.quantity = qty;
    await playerChar.createEmbeddedDocuments("Item", [itemData]);

    ui.notifications.info(`${item.name} ×${qty} 已移至 ${playerChar.name} 的背包。`);
  }

  /* ─── 处理 Socket 消息（由 limbusCompany_FVTT.mjs 调用） ──────────── */

  static async handleSocketMsg(msg) {
    if (!game.user.isGM) return;

    if (msg.type === "campCraft") {
      await LimbusCampSheet._gmExecuteCraft(msg);
    } else if (msg.type === "campTakeItem") {
      await LimbusCampSheet._gmExecuteTakeItem(msg);
    }
  }

  /* ─── 工具 ─────────────────────────────────────────────────────────── */

  static _getDragData(event) {
    try {
      return JSON.parse(event.dataTransfer?.getData("text/plain") ?? "{}");
    } catch {
      return null;
    }
  }
}
