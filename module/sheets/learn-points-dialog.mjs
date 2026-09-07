/**
 * learn-points-dialog.mjs —— 学习等级
 *
 * 升级对话框第 2 步的常驻版本。开它的两个理由：
 *
 *   ① 升级时点太快、把强化那一步跳过去了 —— 点数还在，随时回来花。
 *   ② 点数**不止升级才有**：完成任务、请高人指点、剧情奖励都可以给，
 *      所以 GM 需要一个能直接改数字的地方，而不是只能靠升级发放。
 *
 * 花点数走的仍然是 actor.applyTrainUpgrade()（扣费与校验都在那里），
 * 所以这里和升级对话框、宏三条路的口径完全一致。
 */
import { buildItemTitleCard, closeTitleCardUnlessLocked, toggleTitleCardLock } from "./item-sheet.mjs";

export class LearnPointsDialog extends Application {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "learn-points-dialog",
      classes:   ["limbuscompany", "level-up-dialog", "learn-points-dialog"],
      template:  "systems/limbusCompany_FVTT/templates/apps/learn-points-dialog.hbs",
      title:     "学习等级",
      width:     420,
      height:    "auto",
      resizable: false,
    });
  }

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this._done = [];        // 本次开着期间买过的：[{ name, from, to, cost }]
    this._titleCard = null;
  }

  /** 同一个角色只开一扇窗，免得两扇窗各显示各的余额 */
  get id() { return `learn-points-${this.actor.id}`; }

  async getData(options = {}) {
    const ctx = await super.getData(options);
    ctx.actorName  = this.actor.name;
    ctx.isGM       = game.user.isGM;
    ctx.points     = this.actor.system.learnPoints ?? 0;
    ctx.candidates = this.actor.getTrainUpgradeCandidates();
    ctx.done       = this._done;
    ctx.canBuyAny  = ctx.candidates.some(c => c.canUpgrade);
    // 一个都买不起时给句人话，说清楚是没钱还是没有可升的卡
    ctx.hasUpgradable = ctx.candidates.some(c => c.hasNextData && !c.maxed);
    return ctx;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".lud-train-row:not(.disabled)").on("click", this._onPick.bind(this));
    html.find(".lpd-save").on("click", this._onSavePoints.bind(this));
    html.find(".lpd-input").on("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); this._onSavePoints(ev); }
    });
    html.find(".lud-finish").on("click", () => this.close());
    html.find(".lud-train-row[data-item-uuid]")
      .on("mouseenter", this._onHover.bind(this))
      .on("mouseleave", () => this._onHoverEnd())
      .on("mousedown", (ev) => {
        if (ev.button !== 1) return;
        ev.preventDefault();
        toggleTitleCardLock(this._titleCard);
      });
  }

  /** 花点数升一阶。扣费在 applyTrainUpgrade 里，付不起会自己提示 */
  async _onPick(event) {
    event.preventDefault();
    const row  = event.currentTarget;
    const id   = row.dataset.itemId;
    const item = this.actor.items.get(id);
    if (!item) return;
    const from = item.system?.trainLevel ?? 3;
    const cost = Number(row.dataset.cost) || 0;
    if (!await this.actor.applyTrainUpgrade(id)) return;
    const NUM = { 1: "Ⅰ", 2: "Ⅱ", 3: "Ⅲ", 4: "Ⅳ", 5: "Ⅴ" };
    this._done.push({
      name: item.name, cost,
      from: NUM[from] ?? from, to: NUM[from + 1] ?? from + 1,
    });
    this.render();
  }

  /**
   * GM 直接改余额。任务奖励、高人指点这类来源没有固定规则，
   * 与其做一堆发放入口，不如让 GM 改数字——差额会写进聊天框留痕。
   */
  async _onSavePoints(event) {
    event.preventDefault();
    if (!game.user.isGM) return;
    const input = this.element.find(".lpd-input")[0];
    const next  = Math.max(0, parseInt(input?.value) || 0);
    const cur   = this.actor.system.learnPoints ?? 0;
    if (next === cur) return;
    await this.actor.update({ "system.learnPoints": next });
    const diff = next - cur;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: `<p><strong>${this.actor.name}</strong> 的学习点数 `
             + `${cur} → <strong>${next}</strong>（${diff > 0 ? "+" : ""}${diff}）</p>`,
    });
    this.render();
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
    card.css({ position: "fixed", left: `${rect.right + 12}px`, top: `${rect.top}px`, zIndex: 100000 });
    $("body").append(card);
    this._titleCard = card;
  }

  _onHoverEnd(force = false) {
    if (force) { this._titleCard?.remove(); this._titleCard = null; return; }
    closeTitleCardUnlessLocked(this._titleCard);
    if (!this._titleCard?.data("tcLocked")) this._titleCard = null;
  }

  close(options) {
    this._onHoverEnd(true);
    return super.close(options);
  }
}
