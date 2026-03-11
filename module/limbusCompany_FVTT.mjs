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

/* ─── Hooks.once("init") ─────────────────────────────────────────────────── */

Hooks.once("init", () => {
  console.log("limbusCompany_FVTT | 初始化系统…");

  // 将常量挂载到全局 CONFIG
  CONFIG.LIMBUSCOMPANY = LIMBUSCOMPANY;

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

  // ── 拼点结算聊天框：承受（扣血） / 再次骰掷（平局） ──
  if (flags.type === "clash-resolve") {
    html.find(".clash-btn-apply-damage").on("click", (e) => {
      const targetActorId = e.currentTarget.dataset.targetActorId ?? flags.targetActorId;
      const damage        = parseInt(e.currentTarget.dataset.damage ?? flags.damage) || 0;
      ClashManager.handleApplyDamage(targetActorId, damage);
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
  // ── 每个 combatant 轮次末：移除【陷入混乱】和【陷入恐慌】 ──────────────
  if ("turn" in changed) {
    const prevTurnIdx = (changed.turn - 1 + combat.turns.length) % combat.turns.length;
    const prevTurn    = combat.turns[prevTurnIdx];
    const actor       = prevTurn?.actor;
    if (actor?.type === "character") {
      actor.removeBuffsByType("chaos");
      actor.removeBuffsByType("chaos_plus");
      actor.removeBuffsByType("chaos_double_plus");
      actor.removeBuffsByType("panic");
    }
  }

  // ── 每轮（round）结束：燃烧伤害、充能衰减、呼吸衰减（仅 GM 执行） ────
  if (!("round" in changed)) return;
  if (!game.user.isGM) return;

  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor || actor.type !== "character") continue;
    const buffs = actor.system.buffs ?? [];

    // 【燃烧】：受到强度点固定伤害，层数-1
    const burnBuff = buffs.find(b => b.type === "burn");
    if (burnBuff && burnBuff.stacks > 0) {
      const dmg   = burnBuff.intensity ?? 0;
      const oldHp = actor.system.hp?.value ?? 0;
      const newHp = Math.max(0, oldHp - dmg);
      // 预判混乱触发（避免 checkAndTriggerChaos 再创建消息造成 Foundry 清理竞态）
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
    const chargeBuff = buffs.find(b => b.type === "charge");
    if (chargeBuff && chargeBuff.stacks > 0) {
      await actor.reduceBuffStacks?.("charge");
    }

    // 【呼吸】：层数-1（每轮结束衰减）
    const breatheBuff = buffs.find(b => b.type === "breathing");
    if (breatheBuff && breatheBuff.stacks > 0) {
      await actor.reduceBuffStacks?.("breathing");
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
 * 注册游戏系统设置
 */
function _registerSettings() {
  // 保留槽位，后续阶段按需添加
  // 示例：
  // game.settings.register("limbusCompany_FVTT", "globalSins", {
  //   name: "全局罪孽资源",
  //   scope: "world",
  //   config: false,
  //   type: Object,
  //   default: { wrath:0, lust:0, sloth:0, gluttony:0, gloom:0, pride:0, envy:0 },
  // });
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
