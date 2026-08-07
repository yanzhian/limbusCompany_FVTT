/**
 * level-up-dialog.mjs — 角色升级确认对话框
 *
 * 展示：提升生命值(原→现)、增加星光值(原→现)、升级奖励（背景该等级对应物品）。
 * 点击"确认升级"后调用 actor.levelUpByXp() 实际写入数据并发放奖励物品。
 */
import { buildItemTitleCard } from "./item-sheet.mjs";

export class LevelUpDialog extends Application {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "level-up-dialog",
      classes:   ["limbuscompany", "level-up-dialog"],
      template:  "systems/limbusCompany_FVTT/templates/apps/level-up-dialog.hbs",
      title:     "角色升级",
      width:     420,
      height:    "auto",
      resizable: false,
    });
  }

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this._titleCard = null;
  }

  async getData(options = {}) {
    const ctx = await super.getData(options);
    ctx.preview = await this.actor.getLevelUpPreview();
    return ctx;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".lud-confirm").on("click", this._onConfirm.bind(this));
    html.find(".lud-cancel").on("click", () => this.close());
    html.find(".lud-item-chip[data-item-uuid]")
      .on("mouseenter", this._onHover.bind(this))
      .on("mouseleave", this._onHoverEnd.bind(this));
  }

  async _onHover(event) {
    const uuid = event.currentTarget.dataset.itemUuid;
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

  async _onConfirm(event) {
    event.preventDefault();
    const preview = await this.actor.levelUpByXp();
    if (!preview) return;

    const rewardsHtml = preview.rewards.length
      ? `<div class="lud-chat-rewards">${preview.rewards.map(r =>
          `<div class="lud-chat-reward"><img src="${r.img}" alt="${r.name}"><span>${r.name}</span></div>`
        ).join("")}</div>`
      : "";

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: `
        <div class="limbus-title-card">
          <div class="tc-header"><strong>${this.actor.name}</strong> 升级至 <strong>Lv ${preview.nextLevel}</strong></div>
          <div class="lud-chat-row">生命值上限：${preview.hpFrom} → ${preview.hpTo}</div>
          <div class="lud-chat-row">星芒上限：${preview.stellarFrom} → ${preview.stellarTo}</div>
          ${rewardsHtml}
        </div>`,
    });

    ui.notifications.info(`已升级至 Lv ${preview.nextLevel}。`);
    this.close();
  }

  close(options) {
    this._onHoverEnd();
    return super.close(options);
  }
}
