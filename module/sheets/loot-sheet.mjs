/**
 * loot-sheet.mjs — 战利品 Actor Sheet
 *
 * 两种视角：
 *   GM      → 编辑锁控制：拖入物品、调整网格尺寸、编辑/填充货币
 *   玩家    → 限制权限：查看网格、右键拿走物品、货币【拿走】【一键平分】
 *
 * 玩家操作均通过 socket 委托 GM 执行，保证数据一致性。
 * socket 消息类型：lootTakeItem / lootTakeCurrency / lootSplitCurrency / lootMoveItem
 */
export class LimbusLootSheet extends ActorSheet {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes:   ["limbuscompany", "sheet", "actor", "loot"],
      template:  "systems/limbusCompany_FVTT/templates/actor/loot-sheet.hbs",
      width:     400,
      height:    520,
      resizable: true,
    });
  }

  /* ─── 状态 ─────────────────────────────────────────────────────────────── */

  /** GM 编辑锁 */
  _editUnlocked = false;

  /** 揭示动画版本号（每次调用 _maybePlayReveal 自增，用于取消旧动画） */
  _revealId = 0;

  /** 每个战利品 Actor 的操作串行队列（防竞态） */
  static _opQueues = new Map();

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

    return ctx;
  }

  /* ─── 网格构建 ─────────────────────────────────────────────────────────── */

  async _buildGrid(placements, cols, rows) {
    const placedItems     = [];
    const occupied        = new Set();
    const orphanedIndices = [];

    for (let idx = 0; idx < placements.length; idx++) {
      const p    = placements[idx];
      let   item = null;
      if (p?.uuid) item = await fromUuid(p.uuid).catch(() => null);

      const w        = Math.max(1, p.w ?? 1);
      const h        = Math.max(1, p.h ?? 1);
      const inBounds = p.x >= 0 && p.y >= 0 && p.x + w <= cols && p.y + h <= rows;

      if (!item) {
        if (inBounds) {
          for (let dy = 0; dy < h; dy++)
            for (let dx = 0; dx < w; dx++)
              occupied.add(`${p.x + dx},${p.y + dy}`);
        }
        orphanedIndices.push(idx);
        continue;
      }
      if (!inBounds) continue;

      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++)
          occupied.add(`${p.x + dx},${p.y + dy}`);

      placedItems.push({
        uuid: p.uuid, idx,
        item: { id: item.id, name: item.name, img: item.img,
                quantity: item.system?.quantity ?? null },
        x: p.x, y: p.y, w, h,
        col: p.x + 1, row: p.y + 1,
        rotated: p.rotated && w !== h,
        show: true,
      });
    }

    // 孤儿条目自动清理（GM 端延迟执行，避免 getData 重入）
    if (orphanedIndices.length > 0 && game.user.isGM) {
      setTimeout(async () => {
        const fresh   = foundry.utils.deepClone(this.actor.system.lootContents ?? []);
        const cleaned = fresh.filter((_, i) => !orphanedIndices.includes(i));
        if (cleaned.length !== fresh.length)
          await this.actor.update({ "system.lootContents": cleaned });
      }, 0);
    }

    const allCells = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        allCells.push({ x: c, y: r, col: c + 1, row: r + 1,
                        occupied: occupied.has(`${c},${r}`) });

    return { placedItems, allCells };
  }

  /* ─── 放置检测辅助 ─────────────────────────────────────────────────────── */

  _canPlace(x, y, w, h, cols, rows, excludeIdx = -1) {
    if (x < 0 || y < 0 || x + w > cols || y + h > rows) return false;
    const contents = this.actor.system.lootContents ?? [];
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

  _autoPlace(w, h) {
    const sys  = this.actor.system;
    const cols = sys.gridSize?.width  ?? 5;
    const rows = sys.gridSize?.height ?? 5;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        if (this._canPlace(x, y, w, h, cols, rows))
          return { x, y, w, h, rotated: false };
        if (w !== h && this._canPlace(x, y, h, w, cols, rows))
          return { x, y, w: h, h: w, rotated: true };
      }
    return null;
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

    if (isGM) {
      this._activateGMListeners(html);
    } else {
      this._activatePlayerListeners(html);
      // 玩家首次打开时播放揭示动画（GM 跳过）
      this._maybePlayReveal(html);
    }
  }

  /* ─── 关闭时取消揭示动画 ───────────────────────────────────────────────── */

  /** @override */
  async close(options) {
    this._revealId++; // 令进行中的揭示循环提前退出
    return super.close(options);
  }

  /* ─── 战利品揭示动画 ────────────────────────────────────────────────────── */

  /**
   * 玩家首次打开战利品时：全部物品呈现黑色剪影 + ♻ 旋转，
   * 每隔 1 秒依次揭示一件，完成后将"已揭示"状态写入用户 Flag。
   * 再次打开时直接跳过动画。
   */
  async _maybePlayReveal(html) {
    const flagKey = `lootRevealed_${this.actor.id}`;
    if (game.user.getFlag("limbusCompany_FVTT", flagKey)) return;

    const tiles = html.find(".cg-item-tile").toArray();
    if (tiles.length === 0) {
      // 空战利品：直接标记已见过
      await game.user.setFlag("limbusCompany_FVTT", flagKey, true);
      return;
    }

    // 用版本号标记本次动画，关闭或重新渲染时自增以终止旧循环
    const myId = ++this._revealId;

    // 初始：全部变为剪影
    $(tiles).addClass("loot-tile--silhouette");

    for (const tile of tiles) {
      // 等待 1s（搜索中…）
      await new Promise(r => setTimeout(r, 1000));
      if (this._revealId !== myId) return; // 动画已被取消

      // 揭示该物品
      const $t = $(tile);
      $t.removeClass("loot-tile--silhouette").addClass("loot-tile--revealing");
      setTimeout(() => $t.removeClass("loot-tile--revealing"), 450);
    }

    // 全部揭示完成，持久化标记
    if (this._revealId === myId) {
      await game.user.setFlag("limbusCompany_FVTT", flagKey, true);
    }
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
    const tile     = event.currentTarget;
    const idx      = parseInt(tile.dataset.placementIdx ?? -1);
    if (idx < 0) return;
    const rect     = tile.getBoundingClientRect();
    const cellSize = 50;
    const offX     = Math.max(0, Math.floor((event.clientX - rect.left) / cellSize));
    const offY     = Math.max(0, Math.floor((event.clientY - rect.top)  / cellSize));
    event.dataTransfer.setData("text/plain", JSON.stringify({
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
    await ChatMessage.create({
      content: `<div class="limbuscompany">
        <strong>${playerChar.name}</strong> 从战利品【${lootActor.name}】中取出了
        <img src="${itemData.img}" width="16" height="16" style="vertical-align:middle">
        <strong>${itemData.name} ×${qty}</strong>。
      </div>`,
    });
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
    }).finally(() => {
      if (LimbusLootSheet._opQueues.get(lootActorId) === next)
        LimbusLootSheet._opQueues.delete(lootActorId);
    });
    LimbusLootSheet._opQueues.set(lootActorId, next);
  }
}
