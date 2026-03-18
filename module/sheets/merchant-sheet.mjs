/**
 * merchant-sheet.mjs — NPC 商人角色卡 Sheet
 *
 * 两栏式布局：
 *   左栏：Tab（买入/卖出 或 正在出售/填充物品）+ 立绘 + 描述
 *   右栏：搜索框 + 货物表格
 *
 * 权限区分：
 *   GM   → 正在出售（只读货架）/ 填充物品（可拖入）+ 编辑/隐藏/删除操作
 *   玩家 → 买入（可购买）/ 卖出（占位）
 */
export class LimbusMerchantSheet extends ActorSheet {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes:   ["limbuscompany", "sheet", "actor", "merchant"],
      template:  "systems/limbusCompany_FVTT/templates/actor/merchant-sheet.hbs",
      width:     760,
      height:    560,
      resizable: true,
      tabs: [{ navSelector: ".merchant-tabs", contentSelector: ".merchant-tab-body", initial: "sell" }],
    });
  }

  /* ─── 状态（每个 Sheet 实例独立） ──────────────────────────────────────── */

  /** 当前激活 Tab（"sell" | "stock" | "buy" | "player-sell"） */
  _activeTab = "sell";

  /** 是否显示隐藏物品（GM专用，默认只显示未隐藏） */
  _showHidden = false;

  /** 搜索关键词 */
  _searchQuery = "";

  /** 玩家选择的购买角色 ID */
  _selectedCharId = null;

  /* ─── getData ────────────────────────────────────────────────────────── */

  /** @override */
  async getData(options = {}) {
    const ctx    = await super.getData(options);
    const actor  = this.actor;
    const sys    = actor.system;
    const isGM   = game.user.isGM;

    ctx.isGM        = isGM;
    ctx.shopDesc    = sys.shopDesc ?? "";
    ctx.merchantCurrency = sys.merchantCurrency ?? 0;

    // ── 货物列表 ─────────────────────────────────────────────────────────
    let items = actor.items.contents.map(item => ({
      id:       item.id,
      name:     item.name,
      img:      item.img,
      type:     item.type,
      price:    item.system.price  ?? 0,
      stock:    item.system.stock  ?? -1,
      hidden:   item.system.hidden ?? false,
      isSoldOut: (item.system.stock !== -1 && item.system.stock <= 0),
    }));

    if (!isGM) {
      // 玩家：过滤隐藏物品
      items = items.filter(i => !i.hidden);
    } else if (!this._showHidden) {
      // GM 未开启"显示隐藏"过滤时，仍显示全部（只是视觉标记 hidden=true 的行）
      // 不过滤，保留全部，仅在模板中加半透明样式
    }

    // 搜索过滤
    if (this._searchQuery) {
      const q = this._searchQuery.toLowerCase();
      items = items.filter(i => i.name.toLowerCase().includes(q));
    }

    ctx.shopItems = items;

    // ── 玩家持有的角色列表（用于选择购买身份） ───────────────────────────
    if (!isGM) {
      ctx.ownedCharacters = game.actors.contents.filter(
        a => a.type === "character" && a.testUserPermission(game.user, "OWNER")
      );
      // 初始化选中角色（优先记忆，否则取第一个）
      if (!this._selectedCharId && ctx.ownedCharacters.length > 0) {
        this._selectedCharId = ctx.ownedCharacters[0].id;
      }
      ctx.selectedCharId = this._selectedCharId;
      const selectedChar = game.actors.get(this._selectedCharId);
      ctx.selectedCharCurrency = selectedChar?.system?.currency ?? 0;
      ctx.selectedCharName     = selectedChar?.name ?? "—";
    }

    return ctx;
  }

  /* ─── _onRender ──────────────────────────────────────────────────────── */

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    const isGM = game.user.isGM;

    // ── 搜索框 ────────────────────────────────────────────────────────────
    html.find(".merchant-search").on("input", (e) => {
      this._searchQuery = e.target.value ?? "";
      this.render(false);
    });

    if (isGM) {
      this._activateGMListeners(html);
    } else {
      this._activatePlayerListeners(html);
    }
  }

  /** GM 专属交互 */
  _activateGMListeners(html) {
    // 切换"显示隐藏物品"锁图标
    html.find(".merchant-hidden-toggle").on("click", () => {
      this._showHidden = !this._showHidden;
      this.render(false);
    });

    // [编辑] 按钮 → 弹出 price/stock 编辑对话框
    html.find(".merchant-item-edit").on("click", async (e) => {
      const itemId = e.currentTarget.closest("[data-item-id]").dataset.itemId;
      const item   = this.actor.items.get(itemId);
      if (!item) return;
      await this._onEditItemDialog(item);
    });

    // [隐藏/显示] 按钮 → 切换 hidden 状态
    html.find(".merchant-item-hide").on("click", async (e) => {
      const itemId = e.currentTarget.closest("[data-item-id]").dataset.itemId;
      const item   = this.actor.items.get(itemId);
      if (!item) return;
      await item.update({ "system.hidden": !item.system.hidden });
    });

    // [+补充货币] 按钮
    html.find(".merchant-restock-currency").on("click", async () => {
      await this._onRestockCurrencyDialog();
    });

    // 物品图标点击 → 打开物品卡
    html.find(".merchant-item-icon").on("click", (e) => {
      const itemId = e.currentTarget.closest("[data-item-id]").dataset.itemId;
      const item   = this.actor.items.get(itemId);
      item?.sheet?.render(true);
    });
  }

  /** 玩家专属交互 */
  _activatePlayerListeners(html) {
    // 角色选择器变化 → 更新货币显示
    html.find(".merchant-char-select").on("change", (e) => {
      this._selectedCharId = e.target.value;
      // 更新底栏货币数字（无需完整 render，直接改 DOM）
      const char     = game.actors.get(this._selectedCharId);
      const currency = char?.system?.currency ?? 0;
      html.find(".merchant-player-currency").text(currency.toLocaleString());
    });

    // [购买] 按钮
    html.find(".merchant-item-buy").on("click", async (e) => {
      const itemId = e.currentTarget.closest("[data-item-id]").dataset.itemId;
      await this._onPurchase(itemId);
    });
  }

  /* ─── 购买逻辑 ───────────────────────────────────────────────────────── */

  async _onPurchase(itemId) {
    const item   = this.actor.items.get(itemId);
    if (!item) return;

    const price = item.system.price ?? 0;
    const stock = item.system.stock ?? -1;

    // 选择角色
    const char = game.actors.get(this._selectedCharId);
    if (!char) {
      ui.notifications.warn("请先选择购买角色！");
      return;
    }

    // 前置校验
    if (stock === 0) {
      ui.notifications.warn(`${item.name} 已售罄！`);
      return;
    }
    const currency = char.system?.currency ?? 0;
    if (currency < price) {
      ui.notifications.warn(`眼不足！需要 ${price} 眼，当前持有 ${currency} 眼。`);
      return;
    }

    // ① 扣除玩家角色货币
    await char.update({ "system.currency": currency - price });

    // ② 将物品复制进玩家背包（重置商人专属字段，stock 回 -1 避免混乱）
    const itemData = item.toObject();
    itemData.system.stock  = -1;
    itemData.system.hidden = false;
    await char.createEmbeddedDocuments("Item", [itemData]);

    // ③ 公开聊天消息
    const merchantName = this.actor.name;
    await ChatMessage.create({
      content: `
        <div class="limbus-merchant-purchase-card">
          <div class="purchase-header">
            <img src="${this.actor.img}" class="purchase-merchant-img" alt="${merchantName}">
            <div class="purchase-title">
              <span class="purchase-name">${char.name}</span>
              <span class="purchase-sub">从 ${merchantName} 购买</span>
            </div>
          </div>
          <div class="ic-gold-divider"></div>
          <div class="purchase-item-row">
            <img src="${item.img}" class="purchase-item-icon" alt="${item.name}">
            <span class="purchase-item-name">${item.name}</span>
            <span class="purchase-item-price">花费 <strong>${price}</strong> 眼</span>
          </div>
          <div class="ic-gold-divider"></div>
        </div>`,
      speaker: ChatMessage.getSpeaker({ actor: char }),
    });

    // ④ Socket 通知 GM 扣库存（merchant actor 归 GM 所有）
    if (stock !== -1) {
      game.socket.emit("system.limbusCompany_FVTT", {
        type:       "merchantPurchase",
        merchantId: this.actor.id,
        itemId:     itemId,
      });
    }

    ui.notifications.info(`购买成功：${item.name}`);
  }

  /* ─── GM 对话框：编辑价格/库存 ──────────────────────────────────────── */

  async _onEditItemDialog(item) {
    const currentPrice = item.system.price ?? 0;
    const currentStock = item.system.stock ?? -1;

    return new Promise((resolve) => {
      new Dialog({
        title:   `编辑：${item.name}`,
        content: `
          <form class="merchant-edit-dialog">
            <div class="form-group">
              <label>价格（眼）</label>
              <input type="number" name="price" value="${currentPrice}" min="0" step="1">
            </div>
            <div class="form-group">
              <label>库存（-1 = 无限）</label>
              <input type="number" name="stock" value="${currentStock}" min="-1" step="1">
            </div>
          </form>`,
        buttons: {
          save: {
            icon:  '<i class="fas fa-save"></i>',
            label: "保存",
            callback: async (html) => {
              const price = parseInt(html.find('[name="price"]').val()) || 0;
              const stock = parseInt(html.find('[name="stock"]').val());
              await item.update({
                "system.price": Math.max(0, price),
                "system.stock": isNaN(stock) ? -1 : Math.max(-1, stock),
              });
              resolve();
            },
          },
          cancel: {
            icon:  '<i class="fas fa-times"></i>',
            label: "取消",
            callback: () => resolve(),
          },
        },
        default: "save",
      }).render(true);
    });
  }

  /* ─── GM 对话框：补充货币 ────────────────────────────────────────────── */

  async _onRestockCurrencyDialog() {
    return new Promise((resolve) => {
      new Dialog({
        title:   "补充货币",
        content: `
          <form class="merchant-edit-dialog">
            <div class="form-group">
              <label>增加眼的数量</label>
              <input type="number" name="amount" value="0" min="0" step="1" autofocus>
            </div>
          </form>`,
        buttons: {
          add: {
            icon:  '<i class="fas fa-plus"></i>',
            label: "添加",
            callback: async (html) => {
              const amount = parseInt(html.find('[name="amount"]').val()) || 0;
              if (amount <= 0) return resolve();
              const current = this.actor.system.merchantCurrency ?? 0;
              await this.actor.update({ "system.merchantCurrency": current + amount });
              resolve();
            },
          },
          cancel: {
            icon:  '<i class="fas fa-times"></i>',
            label: "取消",
            callback: () => resolve(),
          },
        },
        default: "add",
      }).render(true);
    });
  }

  /* ─── 拖拽接收（仅 GM + 填充物品 Tab 激活时） ───────────────────────── */

  /** @override */
  async _onDropItem(event, data) {
    if (!game.user.isGM) return false;
    // 只在"填充物品" Tab 激活时接受拖入
    if (this._activeTab !== "stock") return false;

    const item = await Item.fromDropData(data);
    if (!item) return false;

    // 将物品嵌入商人，并设置商人专属默认值
    const itemData = item.toObject();
    itemData.system.price  = itemData.system.price  ?? 0;
    itemData.system.stock  = itemData.system.stock  ?? -1;
    itemData.system.hidden = false;

    return this.actor.createEmbeddedDocuments("Item", [itemData]);
  }

  /** @override 拦截 Tab 切换事件，同步 _activeTab */
  _onChangeTab(event, tabs, active) {
    this._activeTab = active;
    super._onChangeTab(event, tabs, active);
  }
}
