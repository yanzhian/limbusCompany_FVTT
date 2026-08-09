/**
 * sin-resource-hud.mjs — 全局罪孽资源浮动面板（同时承载「场地资源」条）
 *
 * 全局罪孽资源挂在 game.settings（world 范围），
 * 所有玩家实时同步；GM 可直接修改数值或点击重置。
 *
 * 场地资源（FieldResourceRegistry 定义、本文件负责存储/同步）与七宗罪池共用
 * 同一条浮动面板显示，但各自独立一份 world setting，互不影响。场地资源只有
 * 被"激活"（遭遇战开始时命中背景 tags，或 GM 手动添加）后才会出现在面板上，
 * GM 可直接改层数或移除；玩家只读。
 *
 * 公共 API（供 clash.mjs / actor-sheet.mjs / limbusCompany_FVTT.mjs 调用）：
 *   SinResourceHUD.addSin(sinType, amount)              增加指定罪孽
 *   SinResourceHUD.consumeSins(sinCostArray)             扣除 EGO 罪孽消耗（GM/触发者代理）
 *   SinResourceHUD.canAffordSins(sinCostArray)           检查是否足够
 *   SinResourceHUD.ensureFieldResourceActive(name)       激活场地资源（已存在则不清空）
 *   SinResourceHUD.addFieldResourceStacks(name, delta)   增减场地资源层数（按 maxStacks 截断）
 *   SinResourceHUD.getFieldResourceStacks(name)          读取当前层数
 *   SinResourceHUD.instance                              当前面板实例
 */

import { FieldResourceRegistry } from "./custom-buffs.mjs";

const SETTING_KEY       = "globalSins";
const FIELD_SETTING_KEY = "activeFieldResources";
const SINS              = ["wrath", "lust", "sloth", "gluttony", "gloom", "pride", "envy"];
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

/* ── 读写场地资源（同样任意客户端均可通过 GM 代理写入） ─────────────────── */

function _getFieldResources() {
  return game.settings.get("limbusCompany_FVTT", FIELD_SETTING_KEY) ?? {};
}

/** 与旧值浅合并写入（同 _setSins 语义） */
async function _setFieldResources(data) {
  if (!game.user.isGM) {
    game.socket.emit("system.limbusCompany_FVTT", { type: "setFieldResources", data });
  } else {
    await game.settings.set("limbusCompany_FVTT", FIELD_SETTING_KEY, { ..._getFieldResources(), ...data });
  }
}

/** 整体覆盖式写入（用于删除某个 key，调用方传入完整新对象） */
async function _replaceFieldResources(fullData) {
  if (!game.user.isGM) {
    game.socket.emit("system.limbusCompany_FVTT", { type: "replaceFieldResources", data: fullData });
  } else {
    await game.settings.set("limbusCompany_FVTT", FIELD_SETTING_KEY, fullData);
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

  /** 初始化：注册 setting（socket 监听统一在主入口 ready 阶段注册） */
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

    // 注册场地资源 setting（{ [场地名字]: 层数 }，只存"已激活"的场地）
    game.settings.register("limbusCompany_FVTT", FIELD_SETTING_KEY, {
      name:    "已激活的场地资源",
      scope:   "world",
      config:  false,
      type:    Object,
      default: {},
      onChange: () => SinResourceHUD.instance?.render(false),
    });
  }

  /** GM 端处理 setSins / setFieldResources socket 消息 */
  static async handleSocketMsg(msg) {
    if (msg.type === "setSins" && game.user.isGM) {
      await game.settings.set("limbusCompany_FVTT", SETTING_KEY, { ..._getSins(), ...msg.data });
    }
    if (msg.type === "setFieldResources" && game.user.isGM) {
      await game.settings.set("limbusCompany_FVTT", FIELD_SETTING_KEY, { ..._getFieldResources(), ...msg.data });
    }
    if (msg.type === "replaceFieldResources" && game.user.isGM) {
      await game.settings.set("limbusCompany_FVTT", FIELD_SETTING_KEY, msg.data);
    }
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

    // 场地资源：只显示已激活（存在于 setting 里）的条目
    const fields      = _getFieldResources();
    const fieldEntries = Object.keys(fields).map(name => ({
      name,
      icon:      FieldResourceRegistry.get(name)?.icon || "icons/svg/mystery-man.svg",
      value:     fields[name] ?? 0,
      maxStacks: FieldResourceRegistry.get(name)?.maxStacks ?? Infinity,
    }));

    return { entries, fieldEntries, isGM };
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

    // 场地资源：GM 直接输入层数
    html.find(".field-hud-value-input").on("change", async (e) => {
      if (!game.user.isGM) return;
      const name = e.currentTarget.dataset.field;
      const max  = FieldResourceRegistry.get(name)?.maxStacks ?? Infinity;
      const val  = Math.max(0, Math.min(max, parseInt(e.currentTarget.value) || 0));
      await SinResourceHUD.setFieldResourceStacks(name, val);
    });

    // 场地资源：GM 手动移除（不再显示，不影响其定义本身，下次遭遇战符合条件仍会重新激活）
    html.find(".field-hud-remove").on("click", async (e) => {
      e.preventDefault();
      if (!game.user.isGM) return;
      const name = e.currentTarget.dataset.field;
      await SinResourceHUD.removeFieldResource(name);
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

  /* ─── 场地资源公共 API ──────────────────────────────────────────────────── */

  /**
   * 激活一个场地资源（若已激活则不清空当前层数）。
   * 供 combatStart 钩子（背景 tags 命中）或 GM 手动调用。
   * @param {string} name
   */
  static async ensureFieldResourceActive(name) {
    const fields = _getFieldResources();
    if (Object.prototype.hasOwnProperty.call(fields, name)) return;
    await _setFieldResources({ [name]: 0 });
  }

  /**
   * 增减场地资源层数（按注册的 maxStacks 截断，下限 0）。若尚未激活则视为从 0 开始
   * 并隐式激活——供 Activity 效果「公用场地」这类明确指名操作场地资源的场景使用，
   * 这里的"添加"是有意为之的动作，不应被静默拦截。
   * （自动触发型 onStatusTick 是否需要"已激活"前提，由调用方 _tickFieldResources
   * 自行判断，见 clash.mjs，不在本方法内处理——避免这里管得太宽，误伤明确调用。）
   * @param {string} name
   * @param {number} delta  正数增加，负数减少
   */
  static async addFieldResourceStacks(name, delta) {
    const fields = _getFieldResources();
    const max    = FieldResourceRegistry.get(name)?.maxStacks ?? Infinity;
    const cur    = fields[name] ?? 0;
    const next   = Math.max(0, Math.min(max, cur + Number(delta || 0)));
    await _setFieldResources({ [name]: next });
  }

  /** 场地资源是否已激活（存在于当前存储中，即便层数为0） */
  static isFieldResourceActive(name) {
    return Object.prototype.hasOwnProperty.call(_getFieldResources(), name);
  }

  /**
   * 尝试消耗指定层数（不足则不扣除，返回 false）。
   * 供 Activity 编辑器的【消耗】类型「目标=公用场地」使用。
   * @param {string} name
   * @param {number} amount
   * @returns {Promise<boolean>} 是否成功扣除
   */
  static async consumeFieldResourceStacks(name, amount) {
    const fields = _getFieldResources();
    const cur    = fields[name] ?? 0;
    const need   = Number(amount || 0);
    if (cur < need) return false;
    await _setFieldResources({ [name]: cur - need });

    // 联动：被消耗的场地资源自身可注册 onConsumed 钩子（如"消耗XX总数"统计场地）
    const def = FieldResourceRegistry.get(name);
    if (typeof def?.onConsumed === "function") {
      try {
        await def.onConsumed({
          amount: need,
          addStacksTo: (otherName, delta) => SinResourceHUD.addFieldResourceStacks(otherName, delta),
        });
      } catch (err) {
        console.error(`场地资源【${name}】onConsumed 执行出错`, err);
      }
    }

    return true;
  }

  /** 直接设置层数（GM 手动编辑面板用） */
  static async setFieldResourceStacks(name, value) {
    const max = FieldResourceRegistry.get(name)?.maxStacks ?? Infinity;
    await _setFieldResources({ [name]: Math.max(0, Math.min(max, Number(value || 0))) });
  }

  /** 读取当前层数（未激活视为 0） */
  static getFieldResourceStacks(name) {
    return _getFieldResources()[name] ?? 0;
  }

  /** GM 手动从面板移除（整体覆盖式写入，因为需要真正删掉这个 key） */
  static async removeFieldResource(name) {
    const fields = { ..._getFieldResources() };
    delete fields[name];
    await _replaceFieldResources(fields);
  }
}
