/**
 * merchant-sheet.mjs — NPC 商人角色卡 Sheet
 *
 * 两栏式布局：
 *   左栏：Tab（买入/卖出 或 正在出售/填充物品）+ 立绘 + 描述
 *   右栏：货物表格
 *
 * 权限区分：
 *   GM   → 正在出售（只读货架）/ 填充物品（可拖入）+ 编辑/隐藏/删除操作
 *   玩家 → 买入 / 卖出
 *
 * 交易一致性：买入/卖出均由 GM 端权威执行（socket merchantBuy /
 * merchantSell），按 merchantId 串行队列防并发超卖；库存/货币校验
 * 以 GM 端数据为准，客户端校验仅作友好提示。
 */
import { buildItemTitleCard } from "./item-sheet.mjs";

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
      // 重渲染（买卖后）保持各 Tab 表格的滚动位置
      scrollY:   [".merchant-tab-content", ".merchant-desc-wrap"],
    });
  }

  /* ─── 状态（每个 Sheet 实例独立） ──────────────────────────────────────── */

  /** 当前激活 Tab（"sell" | "stock" | "buy" | "player-sell"） */
  _activeTab = "sell";

  /** 是否显示隐藏物品（GM专用，默认只显示未隐藏） */
  _showHidden = false;

  /** 玩家选择的购买角色 ID */
  _selectedCharId = null;

  /** 编辑锁（false = 锁定，true = 解锁可编辑） */
  _editUnlocked = false;

  /** 每个商人 Actor 的 GM 端操作串行队列（防并发超卖） */
  static _opQueues = new Map();

  /* ─── getData ────────────────────────────────────────────────────────── */

  /** @override */
  async getData(options = {}) {
    const ctx    = await super.getData(options);
    const actor  = this.actor;
    const sys    = actor.system;
    const isGM   = game.user.isGM;

    ctx.isGM             = isGM;
    ctx.showHidden       = this._showHidden;
    ctx.editUnlocked     = this._editUnlocked; // 编辑锁：true = 可编辑
    ctx.shopDesc         = sys.shopDesc ?? "";
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
      ctx.selectedCharId       = this._selectedCharId;
      const selectedChar = game.actors.get(this._selectedCharId);
      ctx.selectedCharCurrency = selectedChar?.system?.currency ?? 0;
      ctx.selectedCharName     = selectedChar?.name ?? "—";

      // ── 卖出Tab：读取选中角色的背包物品 ─────────────────────────────────
      ctx.sellItems = (selectedChar?.items.contents ?? [])
        .map(item => ({
          id:        item.id,
          name:      item.name,
          img:       item.img,
          type:      item.type,
          sellPrice: item.system.cost ?? 0,   // item-cost-group 字段
          quantity:  item.system.quantity ?? 1,
        }))
        .filter(i => i.type !== "skill");      // 技能不可出售（无实体）
    }

    return ctx;
  }

  /* ─── _onRender ──────────────────────────────────────────────────────── */

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    const isGM = game.user.isGM;

    // Foundry v13 base class 在 !isEditable（Limited 权限）时会将所有 button/input
    // 设为 disabled。对玩家而言，购买/卖出/角色选择框不依赖 merchant 的编辑权限
    // （修改的是玩家自己的角色，库存扣减通过 socket 委托 GM），需手动恢复。
    if (!isGM && !this.isEditable) {
      html.find(".merchant-item-buy, .merchant-item-sell, .merchant-char-select")
          .prop("disabled", false);
    }

    // ── 悬停 Title 卡（货物行 & 卖出行） ──────────────────────────────────
    html.find(".merchant-item-row").on("mouseenter", this._onRowHoverStart.bind(this));
    html.find(".merchant-item-row").on("mouseleave", this._onRowHoverEnd.bind(this));

    // ── 编辑锁（GM 专用）────────────────────────────────────────────────
    if (isGM) {
      html.find(".merchant-lock-toggle").on("click", () => {
        this._editUnlocked = !this._editUnlocked;
        this._applyEditLockState(html);
      });
      // 渲染完成后立即应用当前锁状态（保持上次的 unlock 状态）
      this._applyEditLockState(html);
      this._activateGMListeners(html);
    } else {
      this._activatePlayerListeners(html);
    }
  }

  /* ─── 悬停 Title 卡 ──────────────────────────────────────────────────── */

  _onRowHoverStart(event) {
    const row = event.currentTarget;
    // 货物行（商人物品）或卖出行（角色物品）
    let item = null;
    if (row.dataset.itemId) {
      item = this.actor.items.get(row.dataset.itemId);
    } else if (row.dataset.charItemId) {
      item = game.actors.get(this._selectedCharId)?.items.get(row.dataset.charItemId);
    }
    if (!item) return;

    this._onRowHoverEnd();
    this._merchantTitleCard = buildItemTitleCard(item);
    if (!this._merchantTitleCard) return;

    const rect  = this.element[0].getBoundingClientRect();
    const cardW = 280, cardH = 500;
    let left = rect.right + 8;
    if (left + cardW > window.innerWidth - 8) left = rect.left - cardW - 8;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - cardH - 8));
    this._merchantTitleCard.css({ position: "fixed", left, top, zIndex: 99998 });
    $("body").append(this._merchantTitleCard);
  }

  _onRowHoverEnd() {
    this._merchantTitleCard?.remove();
    this._merchantTitleCard = null;
  }

  /** @override 关闭时清理悬浮卡 */
  async close(options) {
    this._onRowHoverEnd();
    return super.close(options);
  }

  /* ─── 编辑锁 ─────────────────────────────────────────────────────────── */

  _applyEditLockState(html) {
    const root = html?.find ? html : this.element;
    if (!root?.length) return;

    const btn = root.find(".merchant-lock-toggle");
    if (this._editUnlocked) {
      btn.removeClass("locked").html('<i class="fas fa-lock-open"></i>');
      root.find(".merchant-editable-only").show();
      root.find(".merchant-locked-only").hide();
      root.find(".merchant-editable-field").prop("disabled", false);
    } else {
      btn.addClass("locked").html('<i class="fas fa-lock"></i>');
      root.find(".merchant-editable-only").hide();
      root.find(".merchant-locked-only").show();
      root.find(".merchant-editable-field").prop("disabled", true);
    }
  }

  /** GM 专属交互 */
  _activateGMListeners(html) {
    // 立绘点击 → 弹出图片选择器
    html.find('[data-action="portrait"]').on("click", () => {
      const fp = new FilePicker({
        type: "image",
        current: this.actor.img,
        callback: async (path) => {
          await this.actor.update({ img: path });
        },
      });
      fp.browse();
    });

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

    // [移除] 按钮 → 从商人库存中删除该商品
    html.find(".merchant-item-remove").on("click", async (e) => {
      const itemId = e.currentTarget.closest("[data-item-id]").dataset.itemId;
      const item   = this.actor.items.get(itemId);
      if (!item) return;
      const confirmed = await Dialog.confirm({
        title: "移除商品",
        content: `<p>确定要从货物列表中移除「${item.name}」吗？</p>`,
      });
      if (confirmed) await item.delete();
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

    // [卖出] 按钮
    html.find(".merchant-item-sell").on("click", async (e) => {
      const row    = e.currentTarget.closest("[data-char-item-id]");
      const itemId = row.dataset.charItemId;
      await this._onSell(itemId);
    });
  }

  /* ─── 购买逻辑 ───────────────────────────────────────────────────────── */

  async _onPurchase(itemId) {
    const item = this.actor.items.get(itemId);
    if (!item) return;

    const char = game.actors.get(this._selectedCharId);
    if (!char) { ui.notifications.warn("请先选择购买角色！"); return; }

    // 客户端友好校验（权威校验在 GM 端执行器内再做一次）
    const price = item.system.price ?? 0;
    const stock = item.system.stock ?? -1;
    if (stock === 0) { ui.notifications.warn(`${item.name} 已售罄！`); return; }
    const currency = char.system?.currency ?? 0;
    if (currency < price) {
      ui.notifications.warn(`眼不足！需要 ${price} 眼，当前持有 ${currency} 眼。`);
      return;
    }

    const payload = {
      type:       "merchantBuy",
      merchantId: this.actor.id,
      itemId,
      charId:     char.id,
      userId:     game.user.id,
    };
    if (game.user.isGM) await LimbusMerchantSheet.handleSocketMsg(payload);
    else game.socket.emit("system.limbusCompany_FVTT", payload);
  }

  /* ─── 卖出逻辑 ───────────────────────────────────────────────────────── */

  async _onSell(itemId) {
    const char = game.actors.get(this._selectedCharId);
    if (!char) { ui.notifications.warn("请先选择卖出角色！"); return; }

    const item = char.items.get(itemId);
    if (!item) return;

    const sellPrice = item.system.cost ?? 0;
    if (sellPrice <= 0) { ui.notifications.warn("该物品未设定出售价格。"); return; }

    // 客户端友好校验：商人资金上限（权威校验在 GM 端再做一次）
    if ((this.actor.system.merchantCurrency ?? 0) < sellPrice) {
      ui.notifications.warn(`商人资金不足（${this.actor.system.merchantCurrency ?? 0} 眼），无法收购。`);
      return;
    }

    const confirmed = await Dialog.confirm({
      title:   "确认出售",
      content: `<p>确定以 <strong>${sellPrice}</strong> 眼出售「${item.name}」？</p>
                <p style="font-size:.78rem;color:#7a6a58">出售后物品会以原价停留在商人货架，可以买回。</p>`,
    });
    if (!confirmed) return;

    const payload = {
      type:       "merchantSell",
      merchantId: this.actor.id,
      charItemId: itemId,
      charId:     char.id,
      userId:     game.user.id,
    };
    if (game.user.isGM) await LimbusMerchantSheet.handleSocketMsg(payload);
    else game.socket.emit("system.limbusCompany_FVTT", payload);
  }

  /* ─── GM 端权威执行：购买 ────────────────────────────────────────────── */

  static async _gmExecuteBuy({ merchantId, itemId, charId, userId }) {
    const merchant = game.actors.get(merchantId);
    const item     = merchant?.items.get(itemId);
    const char     = game.actors.get(charId);
    if (!merchant || !item || !char) return;

    const fail = (reason) => ChatMessage.create({
      content: `<div class="limbuscompany chat-clash">购买失败：${reason}</div>`,
      whisper: [userId],
    });

    // 权威校验（GM 端最新数据）
    const price = item.system.price ?? 0;
    const stock = item.system.stock ?? -1;
    if (stock === 0) return void fail(`「${item.name}」已售罄。`);
    const currency = char.system?.currency ?? 0;
    if (currency < price) return void fail(`眼不足（需要 ${price}，持有 ${currency}）。`);

    // ① 扣角色货币，商人收款
    await char.update({ "system.currency": currency - price });
    await merchant.update({
      "system.merchantCurrency": (merchant.system.merchantCurrency ?? 0) + price,
    });

    // ② 物品复制进背包（重置商人字段）
    const itemData = item.toObject();
    itemData.system.stock  = -1;
    itemData.system.hidden = false;
    await char.createEmbeddedDocuments("Item", [itemData]);

    // ③ 扣库存
    if (stock !== -1) {
      await item.update({ "system.stock": Math.max(0, stock - 1) });
    }

    // ④ 公开聊天卡
    await ChatMessage.create({
      content: LimbusMerchantSheet._buildTradeCard(merchant, char, item.name, item.img,
        `从 ${merchant.name} 购买`, `花费 <strong>${price}</strong> 眼`),
      speaker: ChatMessage.getSpeaker({ actor: char }),
    });
  }

  /* ─── GM 端权威执行：卖出（物品原价上架商人货架，可买回） ─────────────── */

  static async _gmExecuteSell({ merchantId, charItemId, charId, userId }) {
    const merchant = game.actors.get(merchantId);
    const char     = game.actors.get(charId);
    const item     = char?.items.get(charItemId);
    if (!merchant || !char || !item) return;

    const fail = (reason) => ChatMessage.create({
      content: `<div class="limbuscompany chat-clash">出售失败：${reason}</div>`,
      whisper: [userId],
    });

    const sellPrice = item.system.cost ?? 0;
    if (sellPrice <= 0) return void fail("该物品未设定出售价格。");

    // 权威校验：商人资金上限
    const mCurrency = merchant.system.merchantCurrency ?? 0;
    if (mCurrency < sellPrice) return void fail(`商人资金不足（${mCurrency} 眼），无法收购。`);

    const itemName = item.name;
    const itemImg  = item.img;
    const itemData = item.toObject();
    delete itemData._id;

    // ① 从角色移除物品，结算货币
    await item.delete();
    await char.update({ "system.currency": (char.system.currency ?? 0) + sellPrice });
    await merchant.update({ "system.merchantCurrency": mCurrency - sellPrice });

    // ② 原价上架商人货架（可买回反悔）：售价=收购价，库存=数量
    itemData.system.price  = sellPrice;
    itemData.system.stock  = itemData.system.quantity ?? 1;
    itemData.system.hidden = false;
    await merchant.createEmbeddedDocuments("Item", [itemData]);

    // ③ 公开聊天卡
    await ChatMessage.create({
      content: LimbusMerchantSheet._buildTradeCard(merchant, char, itemName, itemImg,
        `卖给 ${merchant.name}`, `获得 <strong>${sellPrice}</strong> 眼`),
      speaker: ChatMessage.getSpeaker({ actor: char }),
    });
  }

  /** 交易聊天卡 HTML */
  static _buildTradeCard(merchant, char, itemName, itemImg, subLabel, priceLabel) {
    return `
      <div class="limbus-merchant-purchase-card">
        <div class="purchase-header">
          <img src="${merchant.img}" class="purchase-merchant-img" alt="${merchant.name}">
          <div class="purchase-title">
            <span class="purchase-name">${char.name}</span>
            <span class="purchase-sub">${subLabel}</span>
          </div>
        </div>
        <div class="ic-gold-divider"></div>
        <div class="purchase-item-row">
          <img src="${itemImg}" class="purchase-item-icon" alt="${itemName}">
          <span class="purchase-item-name">${itemName}</span>
          <span class="purchase-item-price">${priceLabel}</span>
        </div>
        <div class="ic-gold-divider"></div>
      </div>`;
  }

  /* ─── Socket 消息处理（按 merchantId 串行队列，防并发超卖） ───────────── */

  static async handleSocketMsg(msg) {
    if (!game.user.isGM) return;
    const merchantId = msg.merchantId;
    if (!merchantId) return;
    if (msg.type !== "merchantBuy" && msg.type !== "merchantSell") return;

    const prev = LimbusMerchantSheet._opQueues.get(merchantId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      if      (msg.type === "merchantBuy")  await LimbusMerchantSheet._gmExecuteBuy(msg);
      else if (msg.type === "merchantSell") await LimbusMerchantSheet._gmExecuteSell(msg);
    }).finally(() => {
      if (LimbusMerchantSheet._opQueues.get(merchantId) === next)
        LimbusMerchantSheet._opQueues.delete(merchantId);
    });
    LimbusMerchantSheet._opQueues.set(merchantId, next);
    return next;
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
