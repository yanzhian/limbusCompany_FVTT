/**
 * squad-hud.mjs — 小队状态 HUD
 *
 * GM 可将任意 character 类型的 Actor 加入队伍1或队伍2。
 * 实时显示每位成员的 HP / 理智 / 行动值 / BUFF 状态。
 * 队伍成员列表持久化到世界设置（squadTeam1 / squadTeam2）。
 *
 * 快捷键：Z = 切换队伍1，X = 切换队伍2（在 limbusCompany_FVTT.mjs 注册）
 */

const BUFF_ICON_BASE = "systems/limbusCompany_FVTT/assets/icons/Buff_icon/";
const BUFF_ICON_MAP  = {
  strong:        "强壮.webp",        weak:          "虚弱.webp",
  endure:        "忍耐.webp",        breach:        "破绽.webp",
  swift:         "迅捷.webp",        bind:          "束缚.webp",
  guard:         "守护.webp",        fragile:       "易损.webp",
  clashPowerUp:  "拼点威力提升.webp", clashPowerDown:"拼点威力降低.webp",
  atkLevelUp:    "攻击等级提升.webp", atkLevelDown:  "攻击等级降低.webp",
  defLevelUp:    "防御等级提升.webp", defLevelDown:  "防御等级降低.webp",
  burn:          "烧伤.webp",        bleed:         "流血.webp",
  tremor:        "震颤.webp",        rupture:       "破裂.webp",
  sinking:       "沉沦.webp",        breathing:     "呼吸法.webp",
  charge:        "充能.webp",        chaos:         "陷入混乱.webp",
  panic:         "陷入恐慌.webp",
};

function _buffIconPath(type, name = "") {
  if (BUFF_ICON_MAP[type]) return BUFF_ICON_BASE + BUFF_ICON_MAP[type];
  const customName = name || type;
  return customName ? `${BUFF_ICON_BASE}Custom_buffs/${customName}.webp` : "";
}

/* ═══════════════════════════════════════════════════════════════════════════
   SquadHUD Application
═══════════════════════════════════════════════════════════════════════════ */

export class SquadHUD extends Application {

  /** 两支队伍各一个实例 */
  static _instances = { 1: null, 2: null };

  constructor(teamId) {
    super();
    this.teamId    = teamId;   // 1 | 2
    this._savedLeft = null;
    this._savedTop  = null;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      template:    "systems/limbusCompany_FVTT/templates/squad-hud.hbs",
      classes:     ["limbus-squad-hud-app"],
      popOut:      false,
      resizable:   false,
      minimizable: false,
    });
  }

  /** 覆写 id，使两个实例拥有独立 DOM 节点 */
  get id() {
    return `limbus-squad-hud-${this.teamId}`;
  }

  /* ─── 注册世界设置（在 Hooks.once("init") 中调用） ─────────────────── */

  static init() {
    for (const n of [1, 2]) {
      game.settings.register("limbusCompany_FVTT", `squadTeam${n}`, {
        scope:   "world",
        config:  false,
        type:    Array,
        default: [],
      });
    }
  }

  /* ─── 单例 toggle ──────────────────────────────────────────────────── */

  static toggle(teamId) {
    const inst = SquadHUD._instances[teamId];
    if (inst) {
      inst.close();
    } else {
      const hud = new SquadHUD(teamId);
      SquadHUD._instances[teamId] = hud;
      hud.render(true);
    }
  }

  /* ─── Actor 更新回调（在 updateActor hook 中调用） ─────────────────── */

  static onActorUpdate(actor) {
    for (const hud of Object.values(SquadHUD._instances)) {
      if (!hud) continue;
      if (hud._getActorIds().includes(actor.id)) hud.render(false);
    }
  }

  /* ─── 成员 ID 读写 ─────────────────────────────────────────────────── */

  _getActorIds() {
    try {
      return game.settings.get("limbusCompany_FVTT", `squadTeam${this.teamId}`) ?? [];
    } catch {
      return [];
    }
  }

  async _setActorIds(ids) {
    await game.settings.set("limbusCompany_FVTT", `squadTeam${this.teamId}`, ids);
  }

  _getMembers() {
    return this._getActorIds()
      .map(id => game.actors?.get(id))
      .filter(Boolean);
  }

  /* ─── 数据准备 ─────────────────────────────────────────────────────── */

  async getData() {
    const members = this._getMembers().map(actor => {
      const sys    = actor.system;
      const hpVal  = sys.hp?.value    ?? 0;
      const hpMax  = Math.max(1, sys.hp?.max ?? 1);
      const sanVal = sys.sanity?.value ?? 50;
      const apVal  = sys.ap?.value    ?? 0;

      const hpPct  = Math.round(Math.max(0, Math.min(100, hpVal / hpMax * 100)));
      const sanPct = Math.round(Math.max(0, Math.min(100, (sanVal - 5) / 90 * 100)));

      // HP 颜色阶段
      const hpClass = hpPct > 60 ? "hp-high" : hpPct > 30 ? "hp-mid" : "hp-low";
      // 理智颜色阶段
      const sanClass = sanVal <= 5 ? "san-panic" : sanVal <= 20 ? "san-low" : "san-normal";

      // AP 硬币（最多3个）
      const apMax   = sys.ap?.max ?? 3;
      const apCoins = Array.from({ length: apMax }, (_, i) => ({ active: i < apVal }));

      // BUFF（只显示本回合有效的）
      const buffs = (sys.buffs ?? [])
        .filter(b => b.whenAdded !== "下回合")
        .map(b => ({
          ...b,
          iconPath: _buffIconPath(b.type, b.name),
          label: `${b.name ?? b.type}　强度:${b.intensity ?? "—"}　层数:${b.stacks ?? "—"}`,
        }));

      return {
        id: actor.id, name: actor.name, img: actor.img,
        hp:  { value: hpVal,  max: hpMax,  pct: hpPct,  cls: hpClass  },
        san: { value: sanVal, pct: sanPct, cls: sanClass },
        apCoins, buffs,
      };
    });

    return {
      teamId:    this.teamId,
      teamLabel: `队伍 ${this.teamId}`,
      members,
      isGM:      game.user?.isGM ?? false,
    };
  }

  /* ─── 渲染（非弹出式 Application，直接注入 body） ───────────────────── */

  async _injectHTML(html) {
    this._saveCurrentPosition();
    $(`#${this.id}`).remove();
    $("body.game").append(html);
    this._element = html;
    this._applyPosition(html);
  }

  async _replaceHTML(element, html) {
    this._saveCurrentPosition();
    element.replaceWith(html);
    this._element = html;
    this._applyPosition(html);
  }

  _saveCurrentPosition() {
    const el = $(`#${this.id}`);
    if (!el.length) return;
    const l = parseInt(el.css("left"));
    const t = parseInt(el.css("top"));
    if (!isNaN(l)) this._savedLeft = l;
    if (!isNaN(t)) this._savedTop  = t;
  }

  _applyPosition(html) {
    if (this._savedLeft != null && !isNaN(this._savedLeft)) {
      html.css({ left: this._savedLeft, top: this._savedTop });
    } else {
      // 默认位置：队伍1靠左，队伍2稍偏右
      html.css({
        left: this.teamId === 1 ? 10  : 230,
        top:  200,
      });
    }
  }

  /* ─── 事件监听 ─────────────────────────────────────────────────────── */

  activateListeners(html) {
    super.activateListeners(html);

    // 标题栏拖动
    html.find(".squad-header").on("mousedown", (e) => {
      if (e.button !== 0) return;
      this._startDrag(e, html[0]);
    });

    // 移除成员
    html.find(".squad-remove-btn").on("click", async (e) => {
      if (!game.user?.isGM) return;
      const actorId = e.currentTarget.dataset.actorId;
      await this._setActorIds(this._getActorIds().filter(id => id !== actorId));
      this.render(false);
    });

    // 拖放接收（接受 token / actor）
    html[0].addEventListener("dragover", (e) => e.preventDefault());
    html[0].addEventListener("drop",     (e) => this._onDrop(e));
  }

  _startDrag(startEvent, el) {
    startEvent.preventDefault();
    const ox = startEvent.clientX - el.offsetLeft;
    const oy = startEvent.clientY - el.offsetTop;

    const onMove = (e) => {
      el.style.left = `${e.clientX - ox}px`;
      el.style.top  = `${e.clientY - oy}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
      this._saveCurrentPosition();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  }

  async _onDrop(event) {
    if (!game.user?.isGM) return;
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }

    let actorId = null;
    if (data.type === "Actor") {
      actorId = data.id ?? data.uuid?.split(".").pop();
    } else if (data.type === "Token") {
      const token = canvas.tokens?.get(data.tokenId ?? data.id);
      actorId = token?.actor?.id;
    }

    if (!actorId) return;
    const actor = game.actors?.get(actorId);
    if (!actor || actor.type !== "character") {
      ui.notifications?.warn("只能将玩家角色（character）加入小队");
      return;
    }

    const ids = [...new Set([...this._getActorIds(), actorId])];
    await this._setActorIds(ids);
    this.render(false);
  }

  /* ─── 关闭 ─────────────────────────────────────────────────────────── */

  async close(options = {}) {
    $(`#${this.id}`).remove();
    this._element = null;
    SquadHUD._instances[this.teamId] = null;
    return super.close(options);
  }
}
