/**
 * level-up-dialog.mjs — 角色升级对话框
 *
 * 两阶段：
 *   1. 提升生命值/星光（等级/生命值/星光：原→现），点击"下一步"实际应用升级
 *      （写入数据 + 按背景 levelRewards 发放本级奖励物品）
 *   2. 等级奖励物品展示，点击"完成"关闭对话框
 */
import { buildItemTitleCard, closeTitleCardUnlessLocked } from "./item-sheet.mjs";

export class LevelUpDialog extends Application {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "level-up-dialog",
      classes:   ["limbuscompany", "level-up-dialog"],
      template:  "systems/limbusCompany_FVTT/templates/apps/level-up-dialog.hbs",
      title:     "升级",
      width:     420,
      height:    "auto",
      resizable: false,
    });
  }

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.step = 1;
    this.result = null; // levelUpByXp() 返回的预览/结果数据，第 2 步展示用
    this._titleCard = null;
  }

  async getData(options = {}) {
    const ctx = await super.getData(options);
    ctx.step = this.step;
    ctx.bgName = (await fromUuid(this.actor.system.background?.uuid ?? "").catch(() => null))?.name ?? "";
    ctx.preview = this.step === 1 ? await this.actor.getLevelUpPreview() : this.result;
    return ctx;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".lud-next").on("click", this._onNext.bind(this));
    html.find(".lud-finish, .lud-cancel").on("click", () => this.close());
    html.find(".lud-item-chip[data-item-uuid]")
      .on("mouseenter", this._onHover.bind(this))
      .on("mouseleave", () => this._onHoverEnd());
  }

  async _onHover(event) {
    const uuid = event.currentTarget.dataset.itemUuid;
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

  async _onNext(event) {
    event.preventDefault();
    const result = await this.actor.levelUpByXp();
    if (!result) return;
    this.result = result;
    this.step = 2;
    this.render();
  }

  close(options) {
    this._onHoverEnd(true);
    return super.close(options);
  }
}
