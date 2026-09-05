/**
 * level-up-dialog.mjs — 角色升级对话框
 *
 * 三阶段：
 *   1. 提升生命值/星光（等级/生命值/星光/经验：原→现），点击"下一步"实际应用升级
 *      （写入数据 + 按背景 levelRewards 发放本次跨过的每一级的奖励物品）
 *   2. 训练等级强化：每 TRAIN_UPGRADE_EVERY 级 1 次名额，挑技能升阶。
 *      已装备的 6 基础 + 1 守备排在前面，但**不限于**它们——技能列表里
 *      没装上去的同样能挑（「强化 Lv.3 技能」常常就是还没装的那张）。
 *      本次没有名额时这一步自动跳过。
 *   3. 等级奖励物品展示，点击"完成"关闭对话框
 */
import { buildItemTitleCard, closeTitleCardUnlessLocked, toggleTitleCardLock } from "./item-sheet.mjs";

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
    this.result = null; // levelUpByXp() 返回的预览/结果数据，后两步展示用
    this._trainLeft = 0; // 本次还剩几次训练等级强化名额
    this._trainDone = []; // 已经升过的：[{ name, from, to }]
    this._titleCard = null;
  }

  async getData(options = {}) {
    const ctx = await super.getData(options);
    ctx.step = this.step;
    ctx.bgName = (await fromUuid(this.actor.system.background?.uuid ?? "").catch(() => null))?.name ?? "";
    ctx.preview = this.step === 1 ? await this.actor.getLevelUpPreview() : this.result;
    if (this.step === 2) {
      ctx.trainLeft  = this._trainLeft;
      ctx.trainDone  = this._trainDone;
      ctx.candidates = this.actor.getTrainUpgradeCandidates();
      ctx.equippedCount = ctx.candidates.filter(c => c.equipped).length;
    }
    return ctx;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".lud-next").on("click", this._onNext.bind(this));
    html.find(".lud-skip").on("click", (ev) => { ev.preventDefault(); this._toStep3(); });
    html.find(".lud-train-row:not(.disabled)").on("click", this._onPickTrain.bind(this));
    html.find(".lud-finish, .lud-cancel").on("click", () => this.close());
    html.find(".lud-item-chip[data-item-uuid]")
      .on("mouseenter", this._onHover.bind(this))
      .on("mouseleave", () => this._onHoverEnd())
      .on("mousedown", (ev) => {
        if (ev.button !== 1) return;
        ev.preventDefault();
        toggleTitleCardLock(this._titleCard);
      });
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
    this._trainLeft = result.trainUpgrades ?? 0;
    this._trainDone = [];
    // 这一级没给强化名额就直接跳到奖励物品那一步
    if (this._trainLeft > 0) { this.step = 2; this.render(); }
    else this._toStep3();
  }

  /** 选中一个技能，训练等级 +1；名额用完自动进入下一步 */
  async _onPickTrain(event) {
    event.preventDefault();
    if (this._trainLeft <= 0) return;
    const row = event.currentTarget;
    const id  = row.dataset.itemId;
    const item = this.actor.items.get(id);
    if (!item) return;
    const from = item.system?.trainLevel ?? 3;
    if (!await this.actor.applyTrainUpgrade(id)) return;
    const NUM = { 1: "Ⅰ", 2: "Ⅱ", 3: "Ⅲ", 4: "Ⅳ", 5: "Ⅴ" };
    this._trainDone.push({ name: item.name, from: NUM[from] ?? from, to: NUM[from + 1] ?? from + 1 });
    this._trainLeft -= 1;
    if (this._trainLeft > 0) this.render();
    else this._toStep3();
  }

  _toStep3() {
    this.step = 3;
    this.render();
  }

  close(options) {
    this._onHoverEnd(true);
    return super.close(options);
  }
}
