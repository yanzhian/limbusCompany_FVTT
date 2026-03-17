/**
 * sin-resource-hud.mjs — 全局罪孽资源浮动面板
 *
 * 全局罪孽资源挂在 game.settings（world 范围），
 * 所有玩家实时同步；GM 可直接修改数值或点击重置。
 *
 * 公共 API（供 clash.mjs / actor-sheet.mjs 调用）：
 *   SinResourceHUD.addSin(sinType, amount)       增加指定罪孽
 *   SinResourceHUD.consumeSins(sinCostArray)      扣除 EGO 罪孽消耗（GM/触发者代理）
 *   SinResourceHUD.canAffordSins(sinCostArray)    检查是否足够
 *   SinResourceHUD.instance                       当前面板实例
 */

const SETTING_KEY = "globalSins";
const SINS        = ["wrath", "lust", "sloth", "gluttony", "gloom", "pride", "envy"];
const LABELS_ZH   = {
  wrath: "暴怒", lust: "色欲", sloth: "怠惰",
  gluttony: "暴食", gloom: "忧郁", pride: "傲慢", envy: "嫉妒",
};

/* ── 读写全局罪孽资源（任意客户端均可通过 GM 代理写入） ─────────────────── */

function _getSins() {
  return game.settings.get("limbusCompany_FVTT", SETTING_KEY) ?? _defaultSins();
}

function _defaultSins() {
  return Object.fromEntries(SINS.map(s => [s, 0]));
}

async function _setSins(data) {
  if (!game.user.isGM) {
    // 非 GM：通过 socket 请求 GM 代写
    game.socket.emit("system.limbusCompany_FVTT", { type: "setSins", data });
  } else {
    await game.settings.set("limbusCompany_FVTT", SETTING_KEY, { ..._getSins(), ...data });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SinResourceHUD Application
═══════════════════════════════════════════════════════════════════════════ */

export class SinResourceHUD extends Application {

  /** 单例引用 */
  static instance = null;

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:          "limbus-sin-resource-hud",
      template:    "systems/limbusCompany_FVTT/templates/sin-resource-hud.hbs",
      classes:     ["limbus-sin-hud"],
      popOut:      false,      // 非弹出式：渲染到 body
      resizable:   false,
      minimizable: false,
    });
  }

  /** 初始化：注册 setting + socket，创建单例并渲染 */
  static init() {
    // 注册全局罪孽资源 setting
    game.settings.register("limbusCompany_FVTT", SETTING_KEY, {
      name:    "全局罪孽资源",
      scope:   "world",
      config:  false,
      type:    Object,
      default: _defaultSins(),
      onChange: () => SinResourceHUD.instance?.render(false),
    });

    // GM 监听 socket，代替非 GM 玩家写入 setting 或更新 Actor
    game.socket.on("system.limbusCompany_FVTT", async (msg) => {
      if (!game.user.isGM) return;
      if (msg.type === "setSins") {
        await game.settings.set("limbusCompany_FVTT", SETTING_KEY, { ..._getSins(), ...msg.data });
      } else if (msg.type === "actorUpdate") {
        const actor = game.actors.get(msg.actorId);
        if (actor) await actor.update(msg.updateData, msg.options ?? {});
      }
    });
  }

  /** ready 阶段调用，创建并渲染单例 */
  static create() {
    if (SinResourceHUD.instance) { SinResourceHUD.instance.render(true); return; }
    const hud = new SinResourceHUD();
    SinResourceHUD.instance = hud;
    hud.render(true);
  }

  /* ─── 数据 ──────────────────────────────────────────────────────────────── */

  async getData() {
    const sins    = _getSins();
    const cfg     = CONFIG.LIMBUSCOMPANY ?? {};
    const isGM    = game.user.isGM;

    const entries = SINS.map(s => ({
      key:   s,
      label: LABELS_ZH[s] ?? s,
      icon:  cfg.SIN_ICON_PATHS?.[s] ?? "",
      color: cfg.SIN_COLORS?.[s] ?? "#E8CAA2",
      value: sins[s] ?? 0,
    }));

    return { entries, isGM };
  }

  /* ─── 渲染 ──────────────────────────────────────────────────────────────── */

  async _renderInner(data) {
    const inner = await super._renderInner(data);
    return inner;
  }

  /** 将当前 DOM 元素的位置存入实例（re-render 前调用） */
  _saveCurrentPosition() {
    const el = $("#limbus-sin-resource-hud");
    if (!el.length) return;
    const left = parseInt(el.css("left"));
    const top  = parseInt(el.css("top"));
    if (!isNaN(left)) this._savedLeft = left;
    if (!isNaN(top))  this._savedTop  = top;
  }

  /** 将实例存储的位置应用到 html 元素 */
  _applyPosition(html) {
    if (this._savedLeft != null) html.css({ left: this._savedLeft, top: this._savedTop });
  }

  /** 首次渲染：注入 body */
  async _injectHTML(html) {
    this._saveCurrentPosition();
    $("#limbus-sin-resource-hud").remove();
    $("body.game").append(html);
    this._element = html;
    this._applyPosition(html);
  }

  /** 后续 re-render：替换已有元素（Foundry 对已渲染 Application 走这条路） */
  async _replaceHTML(element, html) {
    this._saveCurrentPosition();
    element.replaceWith(html);
    this._element = html;
    this._applyPosition(html);
  }

  activateListeners(html) {
    super.activateListeners(html);

    // 重置按钮
    html.find(".sin-hud-reset").on("click", async (e) => {
      e.preventDefault();
      if (!game.user.isGM) return;
      await _setSins(_defaultSins());
    });

    // GM 直接输入数值
    html.find(".sin-hud-value-input").on("change", async (e) => {
      if (!game.user.isGM) return;
      const sinType = e.currentTarget.dataset.sin;
      const val     = Math.max(0, parseInt(e.currentTarget.value) || 0);
      await _setSins({ [sinType]: val });
    });

    // 鼠标移入：显示背景/标题
    html.on("mouseenter", () => html.addClass("sin-hud-hover"));
    html.on("mouseleave", () => {
      if (!this._dragging) html.removeClass("sin-hud-hover");
    });

    // ── 标题拖动（直接按下即可拖动） ───────────────────────────────────────
    const title = html.find(".sin-hud-title")[0];
    let startX = 0, startY = 0, originLeft = 0, originTop = 0;

    const onMouseMove = (e) => {
      if (!this._dragging) return;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - html.outerWidth(),  originLeft + e.clientX - startX));
      const newTop  = Math.max(0, Math.min(window.innerHeight - html.outerHeight(), originTop  + e.clientY - startY));
      this._savedLeft = newLeft;
      this._savedTop  = newTop;
      html.css({ left: newLeft, top: newTop });
    };

    const onMouseUp = () => {
      if (this._dragging) {
        this._dragging = false;
        html.removeClass("sin-hud-dragging sin-hud-hover");
      }
      $(document).off("mousemove", onMouseMove).off("mouseup", onMouseUp);
    };

    $(title).on("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startX     = e.clientX;
      startY     = e.clientY;
      originLeft = parseInt(html.css("left")) || 0;
      originTop  = parseInt(html.css("top"))  || 0;
      this._dragging = true;
      html.addClass("sin-hud-dragging");
      $(document).on("mousemove", onMouseMove).on("mouseup", onMouseUp);
    });
  }

  /* ─── 公共 API ──────────────────────────────────────────────────────────── */

  /**
   * 增加指定罪孽资源（技能使用后调用）
   * @param {string} sinType  罪孽键名
   * @param {number} [amount=1]
   */
  static async addSin(sinType, amount = 1) {
    if (!SINS.includes(sinType)) return;
    const sins = _getSins();
    sins[sinType] = (sins[sinType] ?? 0) + amount;
    await _setSins(sins);
  }

  /**
   * 检查罪孽资源是否足够支付
   * @param {Array<{sinType:string, amount:number}>} sinCostArray
   * @returns {boolean}
   */
  static canAffordSins(sinCostArray) {
    if (!sinCostArray?.length) return true;
    const sins = _getSins();
    for (const { sinType, amount } of sinCostArray) {
      if ((sins[sinType] ?? 0) < (amount ?? 0)) return false;
    }
    return true;
  }

  /**
   * 扣除罪孽资源（EGO 技能消耗）
   * @param {Array<{sinType:string, amount:number}>} sinCostArray
   */
  static async consumeSins(sinCostArray) {
    if (!sinCostArray?.length) return;
    const sins = { ..._getSins() };
    for (const { sinType, amount } of sinCostArray) {
      sins[sinType] = Math.max(0, (sins[sinType] ?? 0) - (amount ?? 0));
    }
    await _setSins(sins);
  }

  /**
   * 获取当前罪孽资源对象
   * @returns {{ [sin: string]: number }}
   */
  static getSins() {
    return _getSins();
  }
}
