/**
 * limbusCompany_FVTT.mjs — 系统主入口
 * Foundry VTT v13+ 边狱巴士都市规则
 *
 * 初始化流程：
 *   Hooks.once("init")     → 注册数据模型、文档类、Sheet、设置
 *   Hooks.once("setup")    → 完成国际化字符串注册
 *   Hooks.once("ready")    → 系统就绪通知
 */

import { LIMBUSCOMPANY }   from "./config.mjs";
import { LimbusActor, CharacterData }  from "./documents/actor.mjs";
import {
  LimbusItem,
  EquipmentData,
  SkillData,
  ConsumableData,
  MaterialData,
  ContainerData,
} from "./documents/item.mjs";
import { LimbusActorSheet } from "./sheets/actor-sheet.mjs";
import { LimbusItemSheet }  from "./sheets/item-sheet.mjs";
import { ClashManager }     from "./helpers/clash.mjs";
import { SinResourceHUD }   from "./helpers/sin-resource-hud.mjs";
import { QuickActionHUD }   from "./sheets/quick-action-hud.mjs";

/* ─── DiceSoNice 硬币外观注册（d2：1=反面 / 2=正面） ─────────────────────── */

Hooks.once("diceSoNiceReady", (dice3d) => {
  dice3d.addSystem(
    { id: "limbusCompany_FVTT", name: "边狱公司" },
    "preferred"
  );
  dice3d.addDicePreset({
    type: "d2",
    labels: [
      "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_反面.webp", // face 1
      "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_正面.webp", // face 2
    ],
    system: "limbusCompany_FVTT",
  });
});

/* ─── Hooks.once("init") ─────────────────────────────────────────────────── */

/* ─── 全局静默 Foundry v13 聊天清理竞态错误 ──────────────────────────────── */
// Foundry v13 在 ChatMessage.create 后会 fire-and-forget 一个内部清理 Promise。
// 多条消息并发创建时，该 Promise 因"消息已被删除"产生两种噪音：
//   1. console.error 直接输出（foundry.mjs 内部调用）→ 过滤 console.error
//   2. Uncaught (in promise) rejection → unhandledrejection 事件拦截
// 两种都精确匹配 /ChatMessage "[A-Za-z0-9]+" does not exist!/ 格式，不影响其他错误。
(function _suppressFoundryChatPurgeNoise() {
  const _RE = /ChatMessage\s+"[A-Za-z0-9]+" does not exist!/;

  // ① 过滤 console.error 直接输出
  const _origError = console.error.bind(console);
  console.error = (...args) => {
    if (args.length > 0 && typeof args[0] === "string" && _RE.test(args[0])) return;
    _origError(...args);
  };

  // ② 拦截未捕获 Promise rejection
  window.addEventListener("unhandledrejection", (event) => {
    if (_RE.test(event?.reason?.message ?? "")) event.preventDefault();
  });
}());

Hooks.once("init", () => {
  console.log("limbusCompany_FVTT | 初始化系统…");

  // 将常量挂载到全局 CONFIG
  CONFIG.LIMBUSCOMPANY = LIMBUSCOMPANY;

  // 暴露 SinResourceHUD 到全局，供宏/控制台调用
  globalThis.SinResourceHUD = SinResourceHUD;

  // 注册全局罪孽资源 setting + socket（需在 init 阶段注册 setting）
  SinResourceHUD.init();

  // 先攻公式：1D6 + 敏捷（战斗跟踪器默认骰掷使用）
  CONFIG.Combat.initiative.formula = "1d6 + @attributes.agi";
  CONFIG.Combat.initiative.decimals = 0;

  // ── 注册文档类 ─────────────────────────────────────────────────────────
  CONFIG.Actor.documentClass = LimbusActor;
  CONFIG.Item.documentClass  = LimbusItem;

  // ── 注册 TypeDataModel（数据模型） ────────────────────────────────────
  CONFIG.Actor.dataModels = {
    character: CharacterData,
  };

  CONFIG.Item.dataModels = {
    equipment:  EquipmentData,
    skill:      SkillData,
    consumable: ConsumableData,
    material:   MaterialData,
    container:  ContainerData,
  };

  // ── 注册 Actor Sheet ───────────────────────────────────────────────────
  Actors.registerSheet("limbusCompany_FVTT", LimbusActorSheet, {
    types:       ["character"],
    makeDefault: true,
    label:       "LIMBUSCOMPANY.Sheet.Character",
  });

  // ── 注册 Item Sheet ────────────────────────────────────────────────────
  Items.registerSheet("limbusCompany_FVTT", LimbusItemSheet, {
    makeDefault: true,
    label:       "LIMBUSCOMPANY.Sheet.Item",
  });

  // ── 注册游戏系统设置 ───────────────────────────────────────────────────
  _registerSettings();

  // ── 预加载 HBS 模板 ───────────────────────────────────────────────────
  _preloadTemplates();

  console.log("limbusCompany_FVTT | 系统初始化完成。");
});

/* ─── Hooks.once("setup") ────────────────────────────────────────────────── */

Hooks.once("setup", () => {
  // 本阶段可做国际化字符串注册后的处理（如本地化常量标签）
  _localizeConfig();
});

/* ─── Hooks.once("ready") ────────────────────────────────────────────────── */

Hooks.once("ready", () => {
  console.log("limbusCompany_FVTT | 系统已就绪。");

  // 显示全局罪孽资源 HUD
  SinResourceHUD.create();

  // 创建快捷操作 HUD 单例（选中 Token 时自动渲染）
  QuickActionHUD.create();

  // ── 过滤 ui.notifications 弹出的聊天清理竞态红色警告 ──────────────────
  // ui.notifications 在 ready 之后才可用，因此在此处 patch
  const _RE_NOTIFY = /ChatMessage\s+"[A-Za-z0-9]+" does not exist!/;
  const _origNotifyError = ui.notifications.error.bind(ui.notifications);
  ui.notifications.error = (msg, ...rest) => {
    if (typeof msg === "string" && _RE_NOTIFY.test(msg)) return;
    return _origNotifyError(msg, ...rest);
  };

  _installTokenDoubleClickOpenActorSheet();
  // 某些加载时序下 ready 阶段 Token 原型尚未就绪，做一次延迟补丁兜底
  setTimeout(() => _installTokenDoubleClickOpenActorSheet(), 200);

  // GM 在线时执行一次迁移：把所有现有角色及其场景 Token 改为 linked
  if (game.user.isGM) _migrateTokenLinks();
});

// 画布每次就绪时再次确保双击补丁存在（重连/重载场景后仍生效）
Hooks.on("canvasReady", () => {
  _installTokenDoubleClickOpenActorSheet();
});

/* ─── 对抗聊天框按钮交互 ─────────────────────────────────────────────────── */

Hooks.on("renderChatMessage", (_message, html, _data) => {
  const flags = _message.flags?.limbusCompany_FVTT;
  if (!flags?.type) return;

  // ── 发起对抗聊天框：对抗 / 承受 ──
  if (flags.type === "clash-initiate") {
    html.find(".clash-btn-clash").on("click", () => {
      ClashManager.showRespondDialog(_message.id, flags);
    });
    html.find(".clash-btn-take").on("click", () => {
      ClashManager.handleDirectTake(flags);
    });
  }

  // ── 加重扩散承受聊天框 ──
  if (flags.type === "clash-weight-spread") {
    html.find(".clash-btn-weight-take").on("click", () => {
      ClashManager.handleWeightTake(_message.id, flags);
    });
  }

  // ── 拼点结算聊天框：承受（扣血） / 再次骰掷（平局） ──
  if (flags.type === "clash-resolve") {
    html.find(".clash-btn-apply-damage").on("click", async (e) => {
      const targetActorId = e.currentTarget.dataset.targetActorId ?? flags.targetActorId;
      const damage        = parseInt(e.currentTarget.dataset.damage ?? flags.damage) || 0;
      await ClashManager.handleApplyDamage(targetActorId, damage);
      // 加重扩散：攻击方赢且 weight>=2 时，在扣血后发出扩散承受卡
      const ws = flags.weightSpread;
      if (ws && (ws.weight ?? 1) >= 2) {
        const atkActor = game.actors.get(ws.attackerId);
        await ClashManager._sendWeightSpreadCard(ws, atkActor);
      }
    });
    html.find(".clash-btn-reroll").on("click", () => {
      ClashManager.rerollClash(flags.rerollData);
    });
  }

  // ── 反击聊天框：双方承受按钮 ──
  if (flags.type === "clash-counter") {
    html.find(".clash-btn-apply-damage").on("click", (e) => {
      const targetActorId = e.currentTarget.dataset.targetActorId;
      const damage        = parseInt(e.currentTarget.dataset.damage) || 0;
      ClashManager.handleApplyDamage(targetActorId, damage);
    });
  }

  // ── 格挡聊天框：承受按钮 ──
  if (flags.type === "clash-block") {
    html.find(".clash-btn-apply-damage").on("click", (e) => {
      const targetActorId = e.currentTarget.dataset.targetActorId ?? flags.targetActorId;
      const damage        = parseInt(e.currentTarget.dataset.damage ?? flags.damage) || 0;
      ClashManager.handleApplyDamage(targetActorId, damage);
    });
  }
});


/* ─── 角色卡 <-> 场上 Token 双向同步（非链接 Token） ─────────────────────── */

Hooks.on("updateActor", async (actor, changed, options) => {
  if (actor.type !== "character") return;
  if (options?.fromTokenSync) return;

  const hasActorDataChange =
    ("system" in changed) ||
    ("name" in changed) ||
    ("img" in changed);
  if (!hasActorDataChange) return;

  const scenes = game.scenes?.contents ?? [];
  const tokenUpdates = [];

  for (const scene of scenes) {
    for (const token of scene.tokens.contents) {
      if (token.actorId !== actor.id) continue;
      if (token.actorLink) continue; // 链接 Token 由 Foundry 自带同步

      tokenUpdates.push({
        _id: token.id,
        delta: {
          system: actor.system.toObject(),
        },
      });
    }

    if (tokenUpdates.length > 0) {
      await scene.updateEmbeddedDocuments("Token", tokenUpdates, { fromActorSync: true, diff: false });
      tokenUpdates.length = 0;
    }
  }
});

Hooks.on("updateToken", async (token, changed, options) => {
  if (options?.fromActorSync) return;
  if (token.actorLink) return; // 链接 Token 会自动写回 Actor

  const baseActor = game.actors?.get(token.actorId);
  if (!baseActor || baseActor.type !== "character") return;

  const hasSystemDelta =
    Boolean(changed?.delta?.system) ||
    Boolean(changed?.actorData?.system) ||
    Boolean(changed?.system);
  if (!hasSystemDelta) return;

  const tokenSystem = token.actor?.system?.toObject?.();
  if (!tokenSystem) return;

  await baseActor.update({ system: tokenSystem }, { fromTokenSync: true, diff: false });
});

/* ─── 快捷操作 HUD 钩子 ─────────────────────────────────────────────────── */

/** 选中 Token 变化 → 更新 HUD 显示 */
Hooks.on("controlToken", () => {
  QuickActionHUD.onControlToken();
});

/** Actor 数据变化 → 刷新 HUD（若追踪的就是该 actor） */
Hooks.on("updateActor", (actor) => {
  QuickActionHUD.onActorUpdate(actor);
});

/** Token 数据变化（非链接 Token）→ 也刷新 HUD */
Hooks.on("updateToken", (token) => {
  const actor = token.actor;
  if (actor) QuickActionHUD.onActorUpdate(actor);
});

/* ─── 战斗钩子 ───────────────────────────────────────────────────────────── */

/**
 * 进入战斗时自动重置 AP / 理智 / 混乱阈值
 */
Hooks.on("combatStart", (combat) => {
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor || actor.type !== "character") continue;
    actor.longRest().then(() => {
      // longRest 已重置 HP/理智/AP/混乱阈值
      // 但战斗开始时不重置 HP，仅重置其他值
      actor.update({
        "system.sanity.value":    50,
        "system.ap.value":        3,
        "system.chaosThresholds": actor.system.getDefaultChaosThresholds?.() ?? [],
      });
    });
  }
});

/**
 * 回合结束时处理特殊状态（陷入混乱/陷入恐慌 自动移除）
 */
Hooks.on("combatRound", (combat, _updateData, _options) => {
  // 在每个 combatant 轮次末尾由 combatTurn 钩子处理
});

Hooks.on("updateCombat", async (combat, changed) => {
  // ── 每轮（round）结束：统一清 BUFF + 燃烧/充能/呼吸衰减（仅 GM 执行） ──
  if (!("round" in changed)) return;
  if (!game.user.isGM) return;

  const TURN_END = CONFIG.LIMBUSCOMPANY?.TURN_END_BUFF_TYPES ?? new Set();

  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor || actor.type !== "character") continue;
    const buffs = actor.system.buffs ?? [];

    // 每轮重置拼点胜利计数（用于理智增加量递增计算）
    await actor.unsetFlag("limbusCompany_FVTT", "clashWinsThisRound");

    // ── 回合结束 BUFF 清理与晋升 ────────────────────────────────────────
    // 移除本轮有效的临时 BUFF（强壮/虚弱/混乱/恐慌等），将下回合 BUFF 转为本回合
    const panicActivating = buffs.some(b => b.type === "panic" && b.whenAdded === "下回合");
    const updatedBuffs = buffs
      .filter(b => !(TURN_END.has(b.type) && b.whenAdded !== "下回合"))
      .map(b => b.whenAdded === "下回合" ? { ...b, whenAdded: "本回合" } : b);
    await actor.update({ "system.buffs": updatedBuffs });

    // 恐慌 BUFF 本回合首次激活：清空 AP 并公告
    if (panicActivating) {
      await actor.update({ "system.ap.value": 0 });
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="limbuscompany chat-clash"><strong>${actor.name}</strong>【陷入恐慌】！无法使用基础及守备技能，E.G.O 不消耗理智但罪孽资源 ×1.5。</div>`,
      });
    }

    // 更新后重新读取 buffs（上面 update 已改变数据）
    const freshBuffs = actor.system.buffs ?? [];

    // 【燃烧】：受到强度点固定伤害，层数-1
    const burnBuff = freshBuffs.find(b => b.type === "burn");
    if (burnBuff && burnBuff.stacks > 0) {
      const dmg   = burnBuff.intensity ?? 0;
      const oldHp = actor.system.hp?.value ?? 0;
      const newHp = Math.max(0, oldHp - dmg);
      const maxHpForBurn = actor.system.hp?.max ?? 1;
      const chaosTriggeredByBurn = (actor.system.chaosThresholds ?? []).some(
        t => !t.triggered && newHp <= maxHpForBurn * t.percent / 100
      );
      await actor.update({ "system.hp.value": newHp });
      await actor.reduceBuffStacks?.("burn");
      if (actor.checkAndTriggerChaos) await actor.checkAndTriggerChaos(newHp, oldHp, { silent: true });
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="limbuscompany chat-clash">
          <strong>${actor.name}</strong>【燃烧】发作：受到 <strong>${dmg}</strong> 点固定伤害。
          （HP ${oldHp} → ${newHp}）${chaosTriggeredByBurn ? "　<span style='color:#E84444;font-weight:bold;'>——【陷入混乱】！</span>" : ""}
        </div>`,
      });
    }

    // 【充能】：层数-1（最大 20 层，衰减即可）
    const chargeBuff = freshBuffs.find(b => b.type === "charge");
    if (chargeBuff && chargeBuff.stacks > 0) {
      await actor.reduceBuffStacks?.("charge");
    }

    // 【呼吸】：层数-1（每轮结束衰减）
    const breatheBuff = freshBuffs.find(b => b.type === "breathing");
    if (breatheBuff && breatheBuff.stacks > 0) {
      await actor.reduceBuffStacks?.("breathing");
    }

    // ── Activity 触发：[回合结束时] 与 [回合开始时] ─────────────────────
    const sys      = actor.system ?? {};
    const roundCtx = { owner: actor, atkActor: actor, defActor: null };

    // 已装备技能
    const skillIds = [
      ...(sys.skills?.basic ?? []),
      sys.skills?.defense ?? null,
      ...Object.values(sys.skills?.ego ?? {}),
    ].filter(Boolean);
    for (const skillId of skillIds) {
      const skillItem = actor.items.get(skillId);
      if (!skillItem) continue;
      await ClashManager._applyActivities(skillItem, "回合结束时", { ...roundCtx, _fireCounts: {} });
      await ClashManager._applyActivities(skillItem, "回合开始时", { ...roundCtx, _fireCounts: {} });
    }

    // 装备栏中的物品（只有装入装备格的才触发）
    for (let i = 0; i < 9; i++) {
      const eqId   = sys.equipment?.[`slot${i}`];
      const eqItem = eqId ? actor.items.get(eqId) : null;
      if (!eqItem) continue;
      await ClashManager._applyActivities(eqItem, "回合结束时", { ...roundCtx, _fireCounts: {} });
      await ClashManager._applyActivities(eqItem, "回合开始时", { ...roundCtx, _fireCounts: {} });
    }
  }

  // ── 每轮开始时重新骰掷所有角色先攻 ─────────────────────────────────────
  // 第 0 → 1 轮跳过（战斗开始时已由 combatStart 钩子处理），之后每轮重掷
  if ((changed.round ?? 0) > 1) {
    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "character") continue;
      await actor.rollSpeedInitiative();
    }
  }
});


/* ─── Token 双击直接打开角色卡（无 Token 配置窗口过渡）──────────────────── */


function _installTokenDoubleClickOpenActorSheet() {
  const tokenProto = globalThis.Token?.prototype ?? CONFIG.Token?.objectClass?.prototype;
  if (!tokenProto || tokenProto.__limbusDblClickPatched) return;

  const original = tokenProto._onClickLeft2;
  if (typeof original !== "function") return;

  tokenProto._onClickLeft2 = function(event, ...args) {
    try {
      const tokenActor = this.actor;
      const baseActorId = this.document?.actorId ?? tokenActor?.id;
      const baseActor = game.actors?.get(baseActorId) ?? tokenActor;

      if (baseActor?.type === "character" && baseActor.testUserPermission(game.user, "OBSERVER")) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        this.release?.();
        baseActor.sheet?.render(true, { focus: true });
        return;
      }

    } catch (err) {
      console.warn("limbusCompany_FVTT | Token 双击打开角色卡失败，回退默认行为", err);
    }
    return original.call(this, event, ...args);
  };

  tokenProto.__limbusDblClickPatched = true;
}

/* ─── Token linked 迁移（GM 启动时自动修复）────────────────────────────── */

/**
 * 将所有 character 类型 Actor 的 prototypeToken.actorLink 置为 true，
 * 并对所有场景中已放置的非 linked Token 做同样处理。
 * 幂等：已经是 linked 的不会重复写入。
 */
async function _migrateTokenLinks() {
  // ── 1. 修复角色原型 Token ─────────────────────────────────────────────
  const actorUpdates = game.actors.contents
    .filter(a => a.type === "character" && !a.prototypeToken?.actorLink)
    .map(a => ({ _id: a.id, "prototypeToken.actorLink": true }));

  if (actorUpdates.length > 0) {
    await Actor.updateDocuments(actorUpdates);
    console.log(`limbusCompany_FVTT | 已修复 ${actorUpdates.length} 个角色的原型 Token（→ linked）`);
  }

  // ── 2. 修复各场景中已放置的非 linked Token ───────────────────────────
  let tokenFixed = 0;
  for (const scene of game.scenes.contents) {
    const tokenUpdates = scene.tokens.contents
      .filter(t => t.actorId && !t.actorLink)
      .map(t => ({ _id: t.id, actorLink: true }));

    if (tokenUpdates.length > 0) {
      await scene.updateEmbeddedDocuments("Token", tokenUpdates);
      tokenFixed += tokenUpdates.length;
    }
  }

  if (tokenFixed > 0) {
    console.log(`limbusCompany_FVTT | 已修复 ${tokenFixed} 个场景 Token（→ linked）`);
    ui.notifications.info(`已自动将 ${tokenFixed} 个 Token 设置为"链接角色数据"`, { permanent: false });
  }
}

/* ─── 内部辅助函数 ───────────────────────────────────────────────────────── */

/**
 * 注册游戏系统设置（globalSins 已由 SinResourceHUD.init() 在 init 钩子中注册）
 */
function _registerSettings() {
  // 保留槽位，后续阶段按需添加
}

/**
 * 预加载 Handlebars 模板（提升首次渲染速度）
 */
async function _preloadTemplates() {
  const templatePaths = [
    // Actor sheets
    "systems/limbusCompany_FVTT/templates/actor/character-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/actor/parts/header.hbs",
    "systems/limbusCompany_FVTT/templates/actor/parts/tab-items.hbs",
    "systems/limbusCompany_FVTT/templates/actor/parts/tab-skills.hbs",
    "systems/limbusCompany_FVTT/templates/actor/parts/tab-combat.hbs",
    // Item sheets
    "systems/limbusCompany_FVTT/templates/item/equipment-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/item/skill-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/item/consumable-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/item/container-sheet.hbs",
    // Combat
    "systems/limbusCompany_FVTT/templates/combat/combat-hud.hbs",
    // Partials
    "systems/limbusCompany_FVTT/templates/partials/title-card.hbs",
    "systems/limbusCompany_FVTT/templates/partials/activity-editor.hbs",
    // HUD
    "systems/limbusCompany_FVTT/templates/sin-resource-hud.hbs",
    "systems/limbusCompany_FVTT/templates/quick-action-hud.hbs",
  ];
  return loadTemplates(templatePaths);
}

/**
 * 本地化常量中的标签键（在 setup 阶段 i18n 已就绪后调用）
 */
function _localizeConfig() {
  const cfg = CONFIG.LIMBUSCOMPANY;

  // 本地化罪孽标签
  for (const [key, i18nKey] of Object.entries(cfg.SIN_LABELS)) {
    cfg.SIN_LABELS[key] = game.i18n.localize(i18nKey);
  }

  // 本地化属性标签
  for (const [key, i18nKey] of Object.entries(cfg.ATTRIBUTE_LABELS)) {
    cfg.ATTRIBUTE_LABELS[key] = game.i18n.localize(i18nKey);
  }

  // 本地化 BUFF 标签
  for (const [key, i18nKey] of Object.entries(cfg.BUFF_TYPES)) {
    cfg.BUFF_TYPES[key] = game.i18n.localize(i18nKey);
  }

  // 本地化技能类型标签
  for (const [key, i18nKey] of Object.entries(cfg.SKILL_TYPES)) {
    cfg.SKILL_TYPES[key] = game.i18n.localize(i18nKey);
  }
}

/* ─── Handlebars 辅助函数注册 ────────────────────────────────────────────── */

Hooks.once("init", () => {
  // 注册 Handlebars helpers（供 HBS 模板使用）

  /** 返回数组某索引的值 */
  Handlebars.registerHelper("arrayIndex", (arr, idx) => arr?.[idx] ?? null);

  /** 将值限定在 min–max 范围内 */
  Handlebars.registerHelper("clamp", (val, min, max) => Math.min(max, Math.max(min, val)));

  /** 计算百分比（保留 1 位小数） */
  Handlebars.registerHelper("percent", (val, max) =>
    max > 0 ? ((val / max) * 100).toFixed(1) : 0
  );

  /** 返回 n 次重复的数组（用于 each 循环生成 n 个元素） */
  Handlebars.registerHelper("times", (n, _options) => Array.from({ length: n }, (_, i) => i));

  /** 判断两个值是否相等 */
  Handlebars.registerHelper("eq", (a, b) => a === b);

  /** 逻辑与（子表达式用：(and a b)） */
  Handlebars.registerHelper("and", (a, b) => Boolean(a) && Boolean(b));

  /** 逻辑非（子表达式用：(not a)） */
  Handlebars.registerHelper("not", (a) => !a);

  /** 分割字符串为数组（SafeString 安全）*/
  Handlebars.registerHelper("split", (str, sep) => {
    const s    = str instanceof Handlebars.SafeString ? str.toString() : String(str ?? "");
    const sep2 = sep instanceof Handlebars.SafeString ? sep.toString() : String(sep ?? "/");
    return s.split(sep2).filter(Boolean);
  });

  /** 去除字符串首尾空格 */
  Handlebars.registerHelper("trim", (str) => {
    const s = str instanceof Handlebars.SafeString ? str.toString() : String(str ?? "");
    return s.trim();
  });

  /** 判断值是否大于 */
  Handlebars.registerHelper("gt", (a, b) => a > b);

  /** 判断值是否小于等于 */
  Handlebars.registerHelper("lte", (a, b) => a <= b);

  /** 本地化 i18n 字符串 */
  Handlebars.registerHelper("lc", (key) => game.i18n.localize(key));

  /** 格式化 i18n 字符串（含变量替换） */
  Handlebars.registerHelper("lcf", (key, data) => game.i18n.format(key, data));

  /** 返回罪孽对应颜色 */
  Handlebars.registerHelper("sinColor", (sinType) =>
    CONFIG.LIMBUSCOMPANY?.SIN_COLORS?.[sinType] ?? "#E8CAA2"
  );

  /** 将骰子公式字符串格式化为大写（1d4 → 1D4） */
  Handlebars.registerHelper("fmtDice", (formula) =>
    (formula ?? "").toUpperCase().replace(/D/g, "D")
  );

  /** 判断抗性倍率是否为弱性（> x1.0） */
  Handlebars.registerHelper("isResistWeak", (val) => {
    const num = parseFloat((val ?? "x1.0").replace("x", ""));
    return num > 1.0;
  });

  /** 判断抗性倍率是否为抗性（< x1.0） */
  Handlebars.registerHelper("isResistStrong", (val) => {
    const num = parseFloat((val ?? "x1.0").replace("x", ""));
    return num < 1.0;
  });

  /** 计算混乱阈值刻度线位置（百分比） */
  Handlebars.registerHelper("chaosLinePos", (percent) => `${percent}%`);

  /** 返回攻/守类型图标路径 */
  Handlebars.registerHelper("categoryIcon", (category) => {
    return CONFIG.LIMBUSCOMPANY?.CATEGORY_ICON_PATHS?.[category] ?? "";
  });

  /** 返回罪孽图标路径 */
  Handlebars.registerHelper("sinIcon", (sinType) => {
    const sin = sinType?.charAt(0).toUpperCase() + sinType?.slice(1);
    return `systems/limbusCompany_FVTT/assets/icons/Base_icon/${sin}_icon.webp`;
  });
});
