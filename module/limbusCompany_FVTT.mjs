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
import { registerHeaderCollapse } from "./helpers/window-header.mjs";
import { LimbusActor, CharacterData, MerchantData, CampData, LootData }  from "./documents/actor.mjs";
import {
  LimbusItem,
  EquipmentData,
  SkillData,
  ConsumableData,
  MaterialData,
  ContainerData,
  SkillBookData,
  RecipeBookData,
  PanicData,
  BackgroundData,
} from "./documents/item.mjs";
import { LimbusActorSheet }   from "./sheets/actor-sheet.mjs";
import { LimbusItemSheet }    from "./sheets/item-sheet.mjs";
import { LimbusMerchantSheet } from "./sheets/merchant-sheet.mjs";
import { LimbusCampSheet }    from "./sheets/camp-sheet.mjs";
import { LimbusLootSheet }    from "./sheets/loot-sheet.mjs";
import { GMConsole }          from "./sheets/gm-console.mjs";
import { SquadHUD }           from "./sheets/squad-hud.mjs";
import { ClashManager }     from "./helpers/clash.mjs";
import { CustomBuffRegistry, resolveBuffHandler, FieldResourceRegistry } from "./helpers/custom-buffs.mjs";
import { linkifyHtml } from "./helpers/linkify.mjs";
import { SinResourceHUD }   from "./helpers/sin-resource-hud.mjs";
import { QuickActionHUD }   from "./sheets/quick-action-hud.mjs";
import { registerItemPiles } from "./helpers/item-piles.mjs";
import { ChaosTokenLabel }   from "./helpers/chaos-token-label.mjs";
import { ClashTotalFX }     from "./helpers/clash-total-fx.mjs";
import { ClashKnockback } from "./helpers/knockback.mjs";
import { ClashVFX }       from "./helpers/clash-vfx.mjs";
import { TokenRingHUD }   from "./helpers/token-ring-hud.mjs";

/* ─── Item Piles 联动注册 ─────────────────────────────────────────────────── */

Hooks.once("item-piles-ready", registerItemPiles);

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
  // 调试用：控制台里可直接 ClashTotalFX.DEBUG = true 观察 TOTAL 演出参数
  globalThis.ClashTotalFX = ClashTotalFX;
  // 击退系统：ClashKnockback.ENABLED = false 可随时整套关掉
  globalThis.ClashKnockback = ClashKnockback;
  globalThis.ClashVFX = ClashVFX;

  // 注册全局罪孽资源 setting（需在 init 阶段注册 setting）
  SinResourceHUD.init();

  // 注册系统 socket 监听器（在 init 阶段注册，与原 setSins 监听时机一致）
  // 单一监听器统一处理所有消息类型，避免多次 game.socket.on 的冲突风险
  game.socket.on("system.limbusCompany_FVTT", async (msg) => {
    await SinResourceHUD.handleSocketMsg(msg);
    await ClashManager.handleSocketMsg(msg);
    await ClashTotalFX.handleSocketMsg(msg);
    ClashVFX.handleSocketMsg(msg);
    await LimbusMerchantSheet.handleSocketMsg(msg);
    await LimbusCampSheet.handleSocketMsg(msg);
    await LimbusLootSheet.handleSocketMsg(msg);
  });

  // 先攻公式：1D6 + 敏捷（战斗跟踪器默认骰掷使用）
  CONFIG.Combat.initiative.formula = "1d6 + @attributes.agi";
  CONFIG.Combat.initiative.decimals = 0;

  // ── 注册文档类 ─────────────────────────────────────────────────────────
  CONFIG.Actor.documentClass = LimbusActor;
  CONFIG.Item.documentClass  = LimbusItem;

  // ── 注册 TypeDataModel（数据模型） ────────────────────────────────────
  CONFIG.Actor.dataModels = {
    character: CharacterData,
    merchant:  MerchantData,
    camp:      CampData,
    loot:      LootData,
  };

  CONFIG.Item.dataModels = {
    equipment:  EquipmentData,
    skill:      SkillData,
    consumable: ConsumableData,
    material:   MaterialData,
    container:  ContainerData,
    skillbook:  SkillBookData,
    recipebook: RecipeBookData,
    panic:      PanicData,
    background: BackgroundData,
  };

  // ── 注册 Actor Sheet ───────────────────────────────────────────────────
  Actors.registerSheet("limbusCompany_FVTT", LimbusActorSheet, {
    types:       ["character"],
    makeDefault: true,
    label:       "LIMBUSCOMPANY.Sheet.Character",
  });

  Actors.registerSheet("limbusCompany_FVTT", LimbusMerchantSheet, {
    types:       ["merchant"],
    makeDefault: true,
    label:       "LIMBUSCOMPANY.Sheet.Merchant",
  });

  Actors.registerSheet("limbusCompany_FVTT", LimbusCampSheet, {
    types:       ["camp"],
    makeDefault: true,
    label:       "LIMBUSCOMPANY.Sheet.Camp",
  });

  Actors.registerSheet("limbusCompany_FVTT", LimbusLootSheet, {
    types:       ["loot"],
    makeDefault: true,
    label:       "LIMBUSCOMPANY.Sheet.Loot",
  });

  // ── 注册 Item Sheet ────────────────────────────────────────────────────
  Items.registerSheet("limbusCompany_FVTT", LimbusItemSheet, {
    makeDefault: true,
    label:       "LIMBUSCOMPANY.Sheet.Item",
  });

  // ── 注册游戏系统设置 ───────────────────────────────────────────────────
  _registerSettings();

  // ── 注册快捷键 ────────────────────────────────────────────────────────
  game.keybindings.register("limbusCompany_FVTT", "openGMConsole", {
    name: "GM 控制台",
    editable: [{ key: "KeyM" }],
    onDown: () => { GMConsole.toggle(); return true; },
    restricted: true,
  });

  game.keybindings.register("limbusCompany_FVTT", "toggleSquadTeam1", {
    name: "小队 HUD — 队伍1",
    editable: [{ key: "KeyZ" }],
    onDown: () => { SquadHUD.toggle(1); return true; },
    restricted: true,
  });

  game.keybindings.register("limbusCompany_FVTT", "toggleSquadTeam2", {
    name: "小队 HUD — 队伍2",
    editable: [{ key: "KeyX" }],
    onDown: () => { SquadHUD.toggle(2); return true; },
    restricted: true,
  });

  // 注册小队 HUD 世界设置
  SquadHUD.init();

  // Token 生命环 HUD（客户端开关）
  TokenRingHUD.init();

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
  // 窗口标题栏整合：隐藏标题，除关闭外的按钮收进右上角 ⋮
  registerHeaderCollapse([
    "LimbusActorSheet", "LimbusItemSheet", "LimbusMerchantSheet",
    "LimbusCampSheet", "LimbusLootSheet",
    "BackgroundWizard", "LevelUpDialog", "GMConsole", "CSVImportDialog",
  ]);

  console.log("limbusCompany_FVTT | 系统已就绪。");

  // 【展示稀有度】：开关状态落到 body 上
  _applyRarityDisplay(game.settings.get("limbusCompany_FVTT", "showRarity"));

  // 显示全局罪孽资源 HUD
  SinResourceHUD.create();

  // Token 生命环 HUD：挂钩子并画一遍现有 Token
  TokenRingHUD.ready();

  // 商人卡左栏画的是玩家角色的背包，那边变了要跟着刷新
  LimbusMerchantSheet.init();

  // 创建快捷操作 HUD 单例（选中 Token 时自动渲染）
  QuickActionHUD.create();

  // 【陷入混乱】token 悬浮字样
  ChaosTokenLabel.init();
  ChaosTokenLabel.refresh();

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

  // GM 在线时校正一次超标的 BUFF 层数（规矩就是规矩）
  if (game.user.isGM) _clampBuffStacks();

  // GM 在线时还原一次残留的临时骰面改动（上次对抗中途断线/刷新留下的）
  if (game.user.isGM) _restoreItemTempMods();

  // GM 在线时把粘连在一起的标签拆开（历史数据修复）
  if (game.user.isGM) _normalizeItemTags();
});

/**
 * 加载时修复：把 ["收尾人/黎明事务所"] 这种粘连在一起的标签拆成多个。
 *
 * 数组型 tags 曾经被整串写进一个元素（输入框里的 "a/b" 直接塞给 ArrayField），
 * 导致卡面上两个标签连成一个、标签匹配也对不上。这里在世界加载时统一拆开。
 */
async function _normalizeItemTags() {
  const SEP = /[\/,，;；]/;
  let fixed = 0;
  const scan = async (items) => {
    for (const item of items ?? []) {
      const raw = item.system?.tags;
      if (!Array.isArray(raw) || !raw.some(t => SEP.test(String(t)))) continue;
      const list = raw.flatMap(t => String(t).split(SEP)).map(t => t.trim()).filter(Boolean);
      try {
        await item.update({ "system.tags": list });
        fixed++;
        console.log(`limbusCompany_FVTT | 标签拆分：${item.name} → ${list.join(" / ")}`);
      } catch (err) {
        console.warn("limbusCompany_FVTT | 标签拆分失败", item.name, err);
      }
    }
  };
  await scan(game.items);
  for (const actor of game.actors) await scan(actor.items);
  if (fixed) ui.notifications.info(`已拆分 ${fixed} 件物品里粘连的标签`);
}

/**
 * 加载时兜底：把上次攻击没来得及还原的骰数/面数/基础值/攻击容量改回原值。
 *
 * 正常流程会在 [攻击后] 之后还原（见 ClashManager._restoreAllItemMods），
 * 中途刷新页面或断线时可能留下 flags.limbusCompany_FVTT.tempMods，这里补一刀。
 */
async function _restoreItemTempMods() {
  const { ClashManager } = await import("./helpers/clash.mjs");
  let fixed = 0;
  const scan = async (items) => {
    for (const item of items ?? []) {
      const mods = item.getFlag?.("limbusCompany_FVTT", "tempMods");
      if (!mods || !Object.keys(mods).length) continue;
      try { await ClashManager._restoreItemMods(item); fixed++; }
      catch (err) { console.warn("limbusCompany_FVTT | 临时骰面还原失败", item.name, err); }
    }
  };
  await scan(game.items);
  for (const actor of game.actors) await scan(actor.items);
  if (fixed) console.log(`limbusCompany_FVTT | 已还原 ${fixed} 件物品的临时骰面改动`);
}

/**
 * 加载时校正：把所有角色身上超过注册上限（maxStacks）的 BUFF 层数钳回上限。
 *
 * 上限此前因为「自定义 BUFF 以中文名当 type」而失效过，存量存档里可能留着
 * 15 层上限却叠到 99 的 BUFF；这里在世界加载时一次性纠正，之后由 _addBuff 把关。
 */
async function _clampBuffStacks() {
  let fixedActors = 0, fixedBuffs = 0;
  for (const actor of game.actors) {
    const buffs = actor.system?.buffs;
    if (!Array.isArray(buffs) || !buffs.length) continue;

    let changed = false;
    const next = buffs.map(b => {
      const h      = resolveBuffHandler(b);
      const maxS   = h?.maxStacks    ?? Infinity;
      const maxI   = h?.maxIntensity ?? Infinity;
      const overS  = Number.isFinite(maxS) && (b.stacks    ?? 0) > maxS;
      const overI  = Number.isFinite(maxI) && (b.intensity ?? 0) > maxI;
      if (!overS && !overI) return b;
      changed = true; fixedBuffs++;
      const parts = [];
      if (overS) parts.push(`层数 ${b.stacks} → ${maxS}`);
      if (overI) parts.push(`强度 ${b.intensity} → ${maxI}`);
      console.warn(`limbusCompany_FVTT | 【${b.name ?? b.type}】${parts.join("，")}（${actor.name}）`);
      return { ...b, ...(overS ? { stacks: maxS } : {}), ...(overI ? { intensity: maxI } : {}) };
    });
    if (!changed) continue;

    try {
      await actor.update({ "system.buffs": next });
      fixedActors++;
    } catch (err) {
      console.warn("limbusCompany_FVTT | BUFF 层数校正失败", actor.name, err);
    }
  }
  if (fixedBuffs) {
    ui.notifications.info(`已校正 ${fixedActors} 名角色的 ${fixedBuffs} 个超上限 BUFF`);
  }
}

// 画布每次就绪时再次确保双击补丁存在（重连/重载场景后仍生效）
Hooks.on("canvasReady", () => {
  _installTokenDoubleClickOpenActorSheet();
});

/* ─── 物品侧边栏：批量导入按钮（仅 GM） ─────────────────────────────────── */

Hooks.on("renderItemDirectory", (app, html) => {
  if (!game.user.isGM) return;
  // v13 传入原生 HTMLElement，旧版传 jQuery，这里统一取原生节点
  const root = html instanceof HTMLElement ? html : html?.[0];
  const header = root?.querySelector(".directory-header .header-actions")
              ?? root?.querySelector(".directory-header");
  if (!header || header.querySelector(".limbus-csv-import")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "limbus-csv-import";
  btn.innerHTML = `<i class="fas fa-file-csv"></i> 批量导入`;
  btn.addEventListener("click", async () => {
    const { CSVImportDialog } = await import("./sheets/csv-import-dialog.mjs");
    CSVImportDialog.open();
  });
  header.appendChild(btn);
});

/* ─── 对抗结算触发：GM 端捕获玩家委托的结算请求 ──────────────────────────── */

Hooks.on("createChatMessage", async (message) => {
  if (!game.user.isGM) return;
  const flags = message.flags?.limbusCompany_FVTT;
  if (flags?.type !== "clashResolveTrigger") return;

  // 延迟删除触发消息：让 Foundry 完成当前渲染周期后再删，
  // 避免 #postNotification 在消息被删除后仍试图操作 DOM 产生竞态错误
  setTimeout(() => message.delete().catch(() => {}), 300);

  const defActor = game.actors.get(flags.defActorId);
  const defItem  = defActor?.items.get(flags.defItemId);
  if (!defActor || !defItem) {
    console.error("[ClashManager] clashResolveTrigger: 找不到 defActor/defItem", flags);
    ui.notifications.error("对抗结算出错：找不到角色或技能");
    return;
  }

  console.log("[ClashManager] GM 收到结算触发，开始执行 | defActor:", defActor.name, "| defItem:", defItem.name);
  try {
    const defRoll = { total: flags.defRollTotal };
    await ClashManager._sendResponseAndResolve(
      defActor, defItem, defRoll, flags.defFormula,
      flags.initMsgId, flags.initFlags, flags.slotIdx ?? -1
    );
  } catch (err) {
    console.error("[ClashManager] 对抗结算出错:", err);
    ui.notifications.error("对抗结算出错，请检查控制台日志");
  }
});

/* ─── 对抗聊天框按钮交互 ─────────────────────────────────────────────────── */

Hooks.on("renderChatMessage", (_message, html, _data) => {
  // 「▼ 详细信息」等折叠：拼点对抗 / 单方面攻击 / 容量扩散 / 先攻骰掷都有。
  // 必须绑在 flags 守卫**之前**——先攻骰掷那张卡是纯 content、没有 flags，
  // 挡在守卫后面的话它的折叠永远点不开。
  html.find(".limbus-detail-toggle-row").on("click", function () {
    const $sec = $(this).next(".limbus-detail-section");
    const open = $sec.toggle().is(":visible");
    const $cap = $(this).find(".limbus-detail-toggle");
    $cap.text((open ? "▲" : "▼") + $cap.text().slice(1));
  });

  const flags = _message.flags?.limbusCompany_FVTT;
  if (!flags?.type) return;

  // ── 发起对抗聊天框：对抗 / 承受 ──
  if (flags.type === "clash-initiate") {
    html.find(".clash-btn-clash").on("click", () => {
      // 【无法拼点】：兜底拦截（按钮本身已不渲染，旧卡或手动调用仍可能走到这里）
      if (flags.noClash) {
        ui.notifications?.warn("这张技能【无法拼点】，只能承受。");
        return;
      }
      ClashManager.showRespondDialog(_message.id, flags);
    });
    html.find(".clash-btn-take").on("click", () => {
      ClashManager.handleDirectTake(flags);
    });
  }

  // ── 容量扩散承受聊天框 ──
  if (flags.type === "clash-weight-spread") {
    html.find(".clash-btn-weight-take").on("click", () => {
      ClashManager.handleWeightTake(_message.id, flags);
    });
  }

  // ── 拼点结算聊天框：结算结果（自动扣血）/ 重新骰掷（仅 GM）──
  if (flags.type === "clash-resolve") {
    // 整局重掷：仅 GM，按钮本身也只渲染给 GM
    html.find(".clash-btn-redo").on("click", async () => {
      if (!game.user.isGM) return;
      const ok = await Dialog.confirm({
        title:   "重新骰掷",
        content: "<p>把这一场对抗从头再打一遍？</p>"
               + "<p style='color:#B84444;font-size:.85rem;'>上一次已经发生的效果不会回滚"
               + "（加出去的 BUFF、扣掉的资源都还在），重打会再触发一次。</p>",
      });
      if (!ok) return;
      // 单方面攻击卡复用同一处理器，重掷走各自的入口
      if (flags.directRedo) await ClashManager.redoDirectTake(flags.directRedo);
      else                  await ClashManager.redoClash(flags.redoData);
    });
    html.find(".clash-btn-settle").on("click", async (e) => {
      const targetActorId = e.currentTarget.dataset.targetActorId ?? flags.targetActorId;
      const damage        = parseInt(e.currentTarget.dataset.damage ?? flags.damage) || 0;
      // 本场对抗的全部承受合并成一张卡：【流血】要排在拼点伤害之前记账，
      // 血条的「先前生命值」才是流血之前那个数
      ClashManager._beginTakeAgg();
      // 沉沦降理智可能把人打进【士气低落】——聚合成一张【恐慌鉴定】卡
      ClashManager._beginPanicAgg();
      await ClashManager.settleBleed(flags.bleedMsgs ?? []);
      // 闪避/完全格挡 + 【不可摧毁】反击 / [追加伤害]：拼点本身 0 伤害，
      // 只落挂在后面那几份
      if (damage > 0 || !(flags.unbreakable || flags.extraDmg)) {
        await ClashManager.handleApplyDamage(targetActorId, damage, flags.takeEffects ?? [],
          flags.attackerId ?? "");
      }
      // 【不可摧毁】拼点失败反击：和拼点伤害同一个按钮一起结算
      const ub = flags.unbreakable;
      if (ub?.targetActorId && (ub.damage ?? 0) > 0) {
        await ClashManager.handleApplyDamage(ub.targetActorId, ub.damage, [], ub.attackerId ?? "");
      }
      // [追加伤害]：时间上在主伤害之后，排在最后记账
      await ClashManager.runExtraDamage(flags.extraDmg ?? []);
      await ClashManager._flushTakeAgg();
      await ClashManager._flushPanicAgg();
      // [拼点失败] 之类的效果发起的新对抗：排到这里，伤害落地之后再弹
      if (flags.skillLaunches) await ClashManager.runSkillLaunches(flags.skillLaunches);
      // 反应检查：延后到伤害落地之后，前置条件读到的才是结算后的数值
      if (flags.reactionCheck) await ClashManager.runReactionCheck(flags.reactionCheck);
      // 容量扩散：打出伤害的一方攻击容量 >=2 时，在扣血后发出扩散承受卡
      const ws = flags.weightSpread;
      if (ws && (ws.weight ?? 1) >= 2) {
        const atkActor = game.actors.get(ws.attackerId);
        const tgt      = game.actors.get(targetActorId);
        await ClashManager._sendWeightSpreadCard(ws, atkActor, tgt ? {
          actorId: tgt.id, name: tgt.name, dmg: damage, note: "拼点命中",
        } : null);
      }
    });
    // 理智变化折叠行
    html.find(".limbus-sanity-toggle-row").on("click", function () {
      const $sec = $(this).next(".limbus-sanity-section");
      const open = $sec.toggle().is(":visible");
      $(this).find(".limbus-sanity-toggle").text(open ? "▲ 理智" : "▼ 理智");
    });
  }

  // ── 反击聊天框：双方承受按钮 ──
  if (flags.type === "clash-counter") {
    // 反击是一次交锋两边同时挨打，结算就该是一下——和拼点对抗一样，
    // 一个【结算结果】把双方的伤害一起落地，不再拆成两个按钮各点各的
    html.find(".clash-btn-settle").on("click", async () => {
      ClashManager._beginTakeAgg();
      // 沉沦降理智可能把人打进【士气低落】——聚合成一张【恐慌鉴定】卡
      ClashManager._beginPanicAgg();
      await ClashManager.settleBleed(flags.bleedMsgs ?? []);
      // 反击是一次交锋两边同时挨打：各自的伤害来源就是对面
      await ClashManager.handleApplyDamage(flags.defActorId, flags.damageToDefActor ?? 0, [], flags.atkActorId ?? "");
      await ClashManager.handleApplyDamage(flags.atkActorId, flags.damageToAtkActor ?? 0, [], flags.defActorId ?? "");
      await ClashManager.runExtraDamage(flags.extraDmg ?? []);
      await ClashManager._flushTakeAgg();
      await ClashManager._flushPanicAgg();
      // [拼点失败] 之类的效果发起的新对抗：排到这里，伤害落地之后再弹
      if (flags.skillLaunches) await ClashManager.runSkillLaunches(flags.skillLaunches);
      if (flags.reactionCheck) await ClashManager.runReactionCheck(flags.reactionCheck);
    });
    html.find(".clash-btn-redo").on("click", async () => {
      if (!game.user.isGM) return;
      const ok = await Dialog.confirm({
        title:   "重新骰掷",
        content: "<p>把这一场对抗从头再打一遍？</p>"
               + "<p style='color:#B84444;font-size:.85rem;'>上一次已经发生的效果不会回滚"
               + "（加出去的 BUFF、扣掉的资源都还在），重打会再触发一次。</p>",
      });
      if (ok) await ClashManager.redoClash(flags.redoData);
    });
  }

  // ── 格挡聊天框：承受按钮 ──
  if (flags.type === "clash-block") {
    html.find(".clash-btn-apply-damage").on("click", async (e) => {
      const targetActorId = e.currentTarget.dataset.targetActorId ?? flags.targetActorId;
      const damage        = parseInt(e.currentTarget.dataset.damage ?? flags.damage) || 0;
      ClashManager._beginTakeAgg();
      // 沉沦降理智可能把人打进【士气低落】——聚合成一张【恐慌鉴定】卡
      ClashManager._beginPanicAgg();
      await ClashManager.settleBleed(flags.bleedMsgs ?? []);
      await ClashManager.handleApplyDamage(targetActorId, damage, [], flags.atkActorId ?? "");
      await ClashManager.runExtraDamage(flags.extraDmg ?? []);
      await ClashManager._flushTakeAgg();
      await ClashManager._flushPanicAgg();
      // [拼点失败] 之类的效果发起的新对抗：排到这里，伤害落地之后再弹
      if (flags.skillLaunches) await ClashManager.runSkillLaunches(flags.skillLaunches);
      if (flags.reactionCheck) await ClashManager.runReactionCheck(flags.reactionCheck);
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
  SquadHUD.onActorUpdate(actor);
});

/** 角色物品增删改 → 刷新打开中的营地卡（左栏角色背包面板） */
const _refreshOpenCampSheets = (item) => {
  if (item?.parent?.type !== "character") return;
  for (const app of Object.values(ui.windows)) {
    if (app instanceof LimbusCampSheet) app.render(false);
  }
};
Hooks.on("createItem", _refreshOpenCampSheets);
Hooks.on("deleteItem", _refreshOpenCampSheets);
Hooks.on("updateItem", _refreshOpenCampSheets);

/** Token 数据变化（非链接 Token）→ 也刷新 HUD */
Hooks.on("updateToken", (token) => {
  const actor = token.actor;
  if (actor) {
    QuickActionHUD.onActorUpdate(actor);
    SquadHUD.onActorUpdate(actor);
  }
});

/** 战斗轮次/回合变化 → 刷新 HUD，让"下个回合"按钮及时出现或消失 */
const _refreshHudOnCombat = () => QuickActionHUD.onCombatChange();
Hooks.on("updateCombat",  _refreshHudOnCombat);
Hooks.on("deleteCombat",  _refreshHudOnCombat);
Hooks.on("createCombat",  _refreshHudOnCombat);

/* ─── 战斗钩子 ───────────────────────────────────────────────────────────── */

/**
 * 进入战斗时自动重置 AP / 理智 / 混乱阈值
 */
Hooks.on("combatStart", (combat) => {
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor || actor.type !== "character") continue;
    actor.longRest().then(async () => {
      // longRest 已重置 HP/理智/AP/混乱阈值
      // 但战斗开始时不重置 HP，仅重置其他值
      await actor.update({
        "system.sanity.value":         50,
        "system.ap.value":             3,
        "system.chaosThresholds":      actor.system.getDefaultChaosThresholds?.() ?? [],
        "system.panicCounters.fear":    0,
        "system.panicCounters.resolve": 0,
      });
      await actor.unsetFlag("limbusCompany_FVTT", "lowMoraleFiredEncounter");
    });
  }

  // ── 场地资源：遭遇战开始时，扫描全体角色背景 tags，命中则激活对应场地 ──
  // 仅 GM 端执行一次，避免多客户端并发写入 world setting
  if (game.user.isGM) {
    (async () => {
      const tagSet = new Set();
      for (const combatant of combat.combatants) {
        const actor  = combatant.actor;
        const bgUuid = actor?.system?.background?.uuid;
        if (!bgUuid) continue;
        const bgItem = await fromUuid(bgUuid).catch(() => null);
        for (const t of ClashManager._itemTags(bgItem)) {
          const trimmed = t.trim();
          if (trimmed) tagSet.add(trimmed);
        }
      }
      for (const [name, def] of FieldResourceRegistry) {
        if (def.triggerBackgroundTags?.some(t => tagSet.has(t))) {
          await SinResourceHUD.ensureFieldResourceActive(name);
        }
      }
    })();
  }
});

/** 战斗结束（删除 Combat 文档）：重置遭遇战触发次数计数 */
Hooks.on("deleteCombat", async (combat) => {
  if (!game.user.isGM) return;
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor) continue;
    await actor.unsetFlag("limbusCompany_FVTT", "encounterFireCounts");
    await actor.unsetFlag("limbusCompany_FVTT", "turnFireCounts");
    // 每回合 BUFF 获得额度（maxGainPerRound）重置
    await actor.unsetFlag("limbusCompany_FVTT", "buffRoundGain");
    await actor.unsetFlag("limbusCompany_FVTT", "lowMoraleFiredEncounter");
    if (actor.type === "character") {
      await actor.update({ "system.panicCounters.fear": 0, "system.panicCounters.resolve": 0 });
    }
  }
});

/**
 * 回合结束时处理特殊状态（陷入混乱/陷入恐慌 自动移除）
 */
Hooks.on("combatRound", (combat, _updateData, _options) => {
  // 在每个 combatant 轮次末尾由 combatTurn 钩子处理
});

// 去重：记录最近已处理的 combatId+round，防止 updateEmbeddedDocuments 引发的二次触发
const _processedRoundKey = new Map();

Hooks.on("updateCombat", async (combat, changed) => {
  // ── 每轮（round）结束：统一清 BUFF + 燃烧/充能/呼吸衰减（仅 GM 执行） ──
  if (!("round" in changed)) return;
  if (!game.user.isGM) return;

  // 同一场战斗同一 round 只处理一次（防止批量更新先攻引发二次触发）
  const dedupKey = `${combat.id}:${combat.round}`;
  if (_processedRoundKey.get(dedupKey)) return;
  _processedRoundKey.set(dedupKey, true);

  const TURN_END     = CONFIG.LIMBUSCOMPANY?.TURN_END_BUFF_TYPES ?? new Set();
  const CHAOS_TYPES  = CONFIG.LIMBUSCOMPANY?.CHAOS_TYPES ?? ["chaos", "chaos_plus", "chaos_double_plus"];
  const CHAOS_EXTEND = CONFIG.LIMBUSCOMPANY?.CHAOS_EXTEND_TAG ?? "延续回合";

  // 全体角色的回合开始/结束 Activity 消息各汇总为一条折叠消息
  const endMsgs   = [];
  const startMsgs = [];
  // 回合结束期间的 [陷入混乱时]（烧伤跳动打进混乱那类）收进「上回合结束」
  const _prevAmbient = ClashManager._ambientActMsgs;
  ClashManager._ambientActMsgs = endMsgs;
  // 全体角色的恐慌/坚定鉴定合并成一张【恐慌鉴定】卡（结构比照【先攻骰掷】）
  ClashManager._beginPanicAgg();

  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor || actor.type !== "character") continue;
    const buffs = actor.system.buffs ?? [];

    // 每轮重置拼点胜利计数 & 每回合效果触发次数
    await actor.unsetFlag("limbusCompany_FVTT", "clashWinsThisRound");
    await actor.unsetFlag("limbusCompany_FVTT", "turnFireCounts");
    // 骰数/面数/基础值/攻击容量的临时改动兜底还原。
    // 对抗流程在 [攻击后] 会精确还原参战的那几件，但【激活】([使用时])、
    // [回合开始时]、[反应] 这些非对抗路径同样能改这四个字段，却没有收尾——
    // 不兜这一下就永久留在物品上了。
    await ClashManager.restoreActorItemMods(actor);

    // 每回合 BUFF 获得额度（maxGainPerRound）——这里才是"每回合"。
    // 漏了这一句时它只在 deleteCombat 里清，等于整场战斗共用一份额度：
    // 【炎蝶之棺】攒满 20 层后，后面每一轮都再也加不上，直到战斗结束。
    await actor.unsetFlag("limbusCompany_FVTT", "buffRoundGain");

    // ── 回合结束 BUFF 清理与晋升 ────────────────────────────────────────
    // 移除本轮有效的临时 BUFF（强壮/虚弱/混乱/恐慌等），将下回合 BUFF 转为本回合
    const panicWasActive  = buffs.some(b => b.type === "panic" && b.whenAdded !== "下回合");
    const panicActivating = buffs.some(b => b.type === "panic" && b.whenAdded === "下回合");

    // Step 1: 移除本回合结束即清除的 BUFF
    // 【陷入混乱】例外：持续「本回合 + 下回合」，本轮结束时不移除，
    // 而是打上 CHAOS_EXTEND 标记（仍视为已生效），下一轮结束才真正移除。
    const afterRemove = buffs.filter(b => {
      if (CHAOS_TYPES.includes(b.type)) return b.whenAdded !== CHAOS_EXTEND;
      return !(TURN_END.has(b.type) && b.whenAdded !== "下回合");
    });

    // Step 2: 将下回合 BUFF 晋升为本回合；混乱则由本回合转入延续回合
    const promoted = afterRemove.map(b => {
      if (CHAOS_TYPES.includes(b.type) && b.whenAdded !== "下回合") {
        return { ...b, whenAdded: CHAOS_EXTEND };
      }
      return b.whenAdded === "下回合" ? { ...b, whenAdded: "本回合" } : b;
    });

    // Step 3: 合并同类型 BUFF（intensity 与 stacks 相加，保留先出现者的 id/name/icon）
    const mergedMap = new Map();
    for (const b of promoted) {
      if (mergedMap.has(b.type)) {
        const ex = mergedMap.get(b.type);
        ex.intensity = (ex.intensity ?? 0) + (b.intensity ?? 0);
        ex.stacks    = (ex.stacks    ?? 0) + (b.stacks    ?? 0);
      } else {
        mergedMap.set(b.type, { ...b });
      }
    }
    const updatedBuffs = [...mergedMap.values()];
    await actor.update({ "system.buffs": updatedBuffs });

    // 恐慌结束（上回合有恐慌，且本轮没有新的下回合恐慌）：恢复理智至 50
    if (panicWasActive && !panicActivating) {
      await actor.update({ "system.sanity.value": 50 });
      endMsgs.push({
        trigger: "回合结束时", itemName: "恐慌结束",
        msgs: [`<strong>${actor.name}</strong> 恢复神志，理智恢复至 <strong>50</strong>`],
      });
    }

    // 恐慌 BUFF 本回合首次激活：公告并触发恐慌卡效果
    // （具体效果如清空 AP 由恐慌卡的「恐慌触发时」activities 配置）
    if (panicActivating) {
      endMsgs.push({
        trigger: "回合结束时", itemName: "陷入恐慌",
        msgs: [`<strong>${actor.name}</strong>【陷入恐慌】！无法使用基础及守备技能，`
             + `E.G.O 不消耗理智但罪孽资源 ×1.5`],
      });
      await actor.triggerPanicActivities?.("panic");
    }
    // 一轮结束进入下一轮：行动值恢复到默认值（已高于默认值的不动，也不封顶）
    // （第 0→1 轮由 combatStart 钩子已处理，跳过）
    else if ((changed.round ?? 0) > 1) {
      const apDefault = actor.system.ap?.max ?? 3;
      if ((actor.system.ap?.value ?? 0) < apDefault) {
        await actor.update({ "system.ap.value": apDefault });
      }
    }


    // 陷入恐慌：理智 ≤10 时，回合结束自动做一次坚定/恐慌鉴定
    if ((actor.system.sanity?.value ?? 50) <= 10) {
      await actor.performPanicCheck?.();
    }

    // 回合开始（本次 hook 同时代表"下一回合开始"）：
    // 若恐慌/坚定计数存在已点亮的"3"，清空双方计数
    await actor.clearPanicCountersIfTriggered?.();

    // 更新后重新读取 buffs（上面 update 已改变数据）
    const freshBuffs = actor.system.buffs ?? [];

    // 【燃烧】：受到强度点固定伤害，层数-1
    const burnBuff = freshBuffs.find(b => b.type === "burn");
    if (burnBuff && burnBuff.stacks > 0) {
      // 自定义 BUFF 可修正烧伤伤害 / 设定生命值下限（如【炎蝶之棺】【黎明之火】）
      const burnMods = ClashManager.applyTickDamageMods(actor, burnBuff.intensity ?? 0, "burn");
      const dmg   = burnMods.damage;
      const oldHp = actor.system.hp?.value ?? 0;
      const newHp = ClashManager.applyHpFloor(oldHp, oldHp - dmg, burnMods.hpFloor);
      const maxHpForBurn = actor.system.hp?.max ?? 1;
      const chaosTriggeredByBurn = (actor.system.chaosThresholds ?? []).some(
        t => !t.triggered && newHp <= maxHpForBurn * t.percent / 100
      );
      await actor.update({ "system.hp.value": newHp });
      await actor.reduceBuffStacks?.("burn");
      await ClashManager._tickFieldResources("burn", dmg, 1);
      if (actor.checkAndTriggerChaos) await actor.checkAndTriggerChaos(newHp, oldHp, { silent: true, source: "burn" });
      endMsgs.push({
        trigger: "回合结束时", itemName: "燃烧",
        msgs: [`<strong>${actor.name}</strong> 受到 <strong>${dmg}</strong> 点固定伤害`
             + `（HP ${oldHp} → ${newHp}）`
             + (chaosTriggeredByBurn ? `　<span style="color:#E84444;font-weight:bold;">【陷入混乱】</span>` : "")],
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

    // ── 自定义 BUFF onRoundEnd 钩子 ──────────────────────────────────────
    // 重新读取 freshBuffs（上面的 reduceBuffStacks 可能已修改数据）
    const customBuffsSnapshot = [...(actor.system?.buffs ?? [])];
    for (const buff of customBuffsSnapshot) {
      const handler = resolveBuffHandler(buff);
      if (typeof handler?.onRoundEnd !== "function") continue;
      // 与 onRoundStart 对称：返回字符串则并入「回合结束时」折叠汇总消息
      const msg = await handler.onRoundEnd(actor, buff);
      if (typeof msg === "string" && msg) {
        endMsgs.push({ trigger: "回合结束时", itemName: handler.label ?? buff.name ?? buff.type, msgs: [msg] });
      }
    }

    // ── 临时技能转换：还原「本回合结束时」到期的那些 ─────────────────────
    await ClashManager._revertTempSkillConverts(actor, "endOfTurn");

    // ── 场地资源 onRoundStart 钩子：每回合开始对每个行动角色调用一次 ──────
    for (const [fieldName, def] of FieldResourceRegistry) {
      if (typeof def.onRoundStart !== "function") continue;
      try {
        await def.onRoundStart({
          actor,
          addBuff: (type, intensity, stacks, whenAdded) =>
            ClashManager._addBuff(actor, type, intensity, stacks, whenAdded),
        });
      } catch (err) {
        console.error(`场地资源【${fieldName}】onRoundStart 执行出错`, err);
      }
    }

    // ── 【震颤】回合结束衰减：层数 -1（特殊震颤由同步跟随，归零则一并消失）──
    const tremorLeft = await ClashManager.decayTremorFamily(actor);
    if (tremorLeft === 0) {
      endMsgs.push({
        trigger: "回合结束时", itemName: "震颤",
        msgs: [`<strong>${actor.name}</strong> 的【震颤】已消散。`],
      });
    }

    // ── 震颤族全部消失时，连带移除【振幅转换】【振幅纠缠】 ────────────────
    await ClashManager._cleanupTremorDependents(actor);

    // ── 自定义 BUFF onRoundStart 钩子 ────────────────────────────────────
    // 在 onRoundEnd 之后重新取快照：回合结束时被移除的 BUFF 不应再吃回合开始效果
    for (const buff of [...(actor.system?.buffs ?? [])]) {
      const handler = resolveBuffHandler(buff);
      if (typeof handler?.onRoundStart !== "function") continue;
      const msg = await handler.onRoundStart(actor, buff);
      if (typeof msg === "string" && msg) {
        startMsgs.push({ trigger: "回合开始时", itemName: handler.label ?? buff.name ?? buff.type, msgs: [msg] });
      }
    }

    // ── Activity 触发：[回合结束时] 与 [回合开始时] ─────────────────────
    // 收集到全体共享的桶，循环结束后统一发折叠汇总消息（避免刷屏）
    const sys       = actor.system ?? {};
    const roundCtx  = { owner: actor, atkActor: actor, defActor: null };

    // 已装备技能
    const skillIds = [
      ...(sys.skills?.basic ?? []),
      sys.skills?.defense ?? null,
      ...Object.values(sys.skills?.ego ?? {}),
    ].filter(Boolean);
    for (const skillId of skillIds) {
      const skillItem = actor.items.get(skillId);
      if (!skillItem) continue;
      await ClashManager._applyActivities(skillItem, "回合结束时", { ...roundCtx, _fireCounts: {}, _actMsgs: endMsgs });
      await ClashManager._applyActivities(skillItem, "回合开始时", { ...roundCtx, _fireCounts: {}, _actMsgs: startMsgs });
    }

    // 装备栏中的物品（只有装入装备格的才触发）
    for (let i = 0; i < 9; i++) {
      const eqId   = sys.equipment?.[`slot${i}`];
      const eqItem = eqId ? actor.items.get(eqId) : null;
      if (!eqItem) continue;
      await ClashManager._applyActivities(eqItem, "回合结束时", { ...roundCtx, _fireCounts: {}, _actMsgs: endMsgs });
      await ClashManager._applyActivities(eqItem, "回合开始时", { ...roundCtx, _fireCounts: {}, _actMsgs: startMsgs });
    }
  }

  ClashManager._ambientActMsgs = _prevAmbient;
  await ClashManager._flushPanicAgg();

  // 回合结束/开始的触发汇总不再各发一条，统一并进下面那张先攻骰掷卡。
  // 没有先攻卡可挂时（第 0→1 轮、或全场没有 character）才退回单独发。
  const _hasInitCard = (changed.round ?? 0) > 1;
  if (!_hasInitCard) {
    await ClashManager._flushActMsgs(endMsgs,   null, { title: "回合结束时" });
    await ClashManager._flushActMsgs(startMsgs, null, { title: "回合开始时" });
  }

  // ── 一轮结束进入下一轮：重掷所有角色先攻 ──────────────────────────────
  // 第 0 → 1 轮跳过（战斗开始时已由 combatStart 钩子处理），之后每轮重掷
  // 先全部骰好并发聊天，最后一次性批量写入先攻值，只触发一次排序
  if ((changed.round ?? 0) > 1) {
    const initiativeUpdates = [];
    const initiativeRows    = [];
    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor || actor.type !== "character") continue;
      const roll = await actor.rollSpeedInitiative({ updateCombatant: false, chatMessage: false });
      const finalTotal = roll.finalTotal ?? roll.total;
      initiativeUpdates.push({ _id: combatant.id, initiative: finalTotal });
      initiativeRows.push({
        id:       combatant.id,
        img:      actor.img,
        name:     actor.name,
        speedMin: roll.speedMin ?? 0,
        speedMax: roll.speedMax ?? 0,
        finalTotal,
      });
    }
    if (initiativeUpdates.length > 0) {
      await combat.updateEmbeddedDocuments("Combatant", initiativeUpdates);

      // ── 重掷之后必须把行动指针拨回新顺序的第一位 ──────────────────────
      // Combat#_onUpdateDescendantDocuments 在 Combatant 改动后会重排 turns，
      // 并把 turn 调成「原来那个当前角色」在新顺序里的下标——那是为"战斗中途
      // 手改某人先攻、不该打断当前行动者"设计的。但本系统是每轮重掷全员先攻，
      // nextRound() 刚把 turn 归 0（旧顺序的第一位 A），重排后 Foundry 又把
      // turn 拨回 A 在新顺序里的位置，于是「新顺序是 B,D,A,C 却从 A 开始」。
      // 这里在重排落地后再显式写一次 turn，覆盖掉那次自动校正。
      // 注意：此刻本地 combat.turn 仍是 0（那次自动 update 尚未回程），
      // 必须 diff:false，否则会被差分成空更新而发不出去。
      // turn === null 表示"当前没有轮到任何人"（nextRound 会原样保留），不干预。
      if (combat.turn !== null) {
        let newTurn = 0;
        if (combat.settings?.skipDefeated) {
          const alive = combat.turns.findIndex(t => !t.isDefeated);
          if (alive > 0) newTurn = alive;
        }
        await combat.update({ turn: newTurn }, { diff: false });
      }

      // 全体先攻汇总为一张卡：按战斗跟踪器重排后的真实顺序列出（含序号）
      const turnOrder = new Map(combat.turns.map((t, i) => [t.id, i]));
      initiativeRows.sort((a, b) => (turnOrder.get(a.id) ?? 0) - (turnOrder.get(b.id) ?? 0));
      const rowsHtml = initiativeRows.map(r => `
        <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
          <span style="color:#E8C9A2;opacity:.6;font-size:.8rem;min-width:1.2em;text-align:right;">${(turnOrder.get(r.id) ?? 0) + 1}</span>
          <img src="${r.img}" alt="${r.name}"
               style="width:30px;height:30px;object-fit:cover;border-radius:50%;border:2px solid #3A5A1A;">
          <span style="color:#E8C9A2;font-size:.85rem;flex:1;">${r.name}</span>
          <span class="initiative-speed-range">${r.speedMin}–${r.speedMax}</span>
          <span class="initiative-arrow">→</span>
          <span class="initiative-total">${r.finalTotal}</span>
        </div>`).join("");
      // 上回合结束 / 本回合开始的触发效果并进来，各自折叠
      const endFold = ClashManager._buildDetailsFold(endMsgs,   { label: "上回合结束" });
      const startFold = ClashManager._buildDetailsFold(startMsgs, { label: "回合开始" });
      await ChatMessage.create({
        content: `
          <div class="limbus-initiative-card" style="padding:10px 12px 8px;">
            <div class="ic-title" style="font-size:20px;">第 ${changed.round} 回合 · 先攻骰掷</div>
            <div style="height:30px;"></div>
            <div class="ic-gold-divider"></div>
            ${rowsHtml}
            <div class="ic-gold-divider"></div>
            ${endFold}
            ${endFold ? '<div style="height:30px;"></div>' : ""}
            ${startFold}
            ${startFold ? '<div style="height:30px;"></div>' : ""}
            ${(endFold || startFold) ? '<div class="ic-gold-divider"></div>' : ""}
          </div>`,
      });
    } else {
      // 没人可骰先攻 → 没有卡可挂，触发汇总照旧单独发
      await ClashManager._flushActMsgs(endMsgs,   null, { title: "回合结束时" });
      await ClashManager._flushActMsgs(startMsgs, null, { title: "回合开始时" });
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
  // 拼点 TOTAL 演出开关（每个玩家各自设置）
  game.settings.register("limbusCompany_FVTT", "clashTotalFx", {
    name:    "拼点 TOTAL 演出",
    hint:    "双方确定技能开骰时播放全屏 TOTAL 动画；关闭后只保留骰子动画。",
    scope:   "client",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // 演出节奏：一回合往往要打好几次拼点，标准节奏容易拖沓
  game.settings.register("limbusCompany_FVTT", "knockbackMode", {
    name:    "击退模式",
    hint:    "开启后，贴身拼点每次分出胜负都会按胜方点数把对手击退（10/20/30 点 → 1/2/3 格），"
           + "胜方随即瞬移追击；被击退的一方背后若是墙则撞墙，触发【震颤引爆】。"
           + "关闭则双方始终原地对拼。由 GM 设定，对全场生效。",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
  });

  // 营地 / 商人的「站得够近才能开」判定半径
  game.settings.register("limbusCompany_FVTT", "interactRange", {
    name:    "营地 / 商人 交互距离（格）",
    hint:    "玩家的 Token 与营地 / 商人 Token 之间不超过这个格数才能打开面板"
           + "（按 Token 占地的边缘算，紧贴＝1 格，斜向也算 1 格）。"
           + "填 0 关闭距离限制。GM 永远不受限；任一方在当前场景没有 Token 时也放行。",
    scope:   "world",
    config:  true,
    type:    Number,
    range:   { min: 0, max: 20, step: 1 },
    default: 3,
  });

  // 角色卡改良版外观：并行的试验模板，方便边用边调，默认关闭
  game.settings.register("limbusCompany_FVTT", "sheetRedesign", {
    name:    "角色卡·改良版外观（调试）",
    hint:    "换用 character-sheet-redesign.hbs / .css 这套试验外观："
           + "三层视觉层级（身份区 / 主导航 / 工作区）、带图标的 Tab、底部资源栏。"
           + "功能与旧版完全一致（复用同一批 parts），只是外框与样式不同；"
           + "改样式只需刷新页面，不用重启世界。",
    scope:   "client",
    config:  true,
    type:    Boolean,
    default: false,
    onChange: () => {
      // 立刻把已打开的角色卡换成另一套模板
      for (const app of Object.values(ui.windows)) {
        if (app?.actor?.type === "character") app.render(true);
      }
    },
  });

  // 形象（纸娃娃）系统：整套功能的总开关，默认关闭
  game.settings.register("limbusCompany_FVTT", "dollSystem", {
    name:    "启用形象系统",
    hint:    "开启后角色卡【物品】页左栏多一个【形象】视图：把各装备的贴图和一张头部图片"
           + "拼成角色形象，可拖动摆放、R 旋转、E 缩放、滚轮调图层前后。"
           + "关闭则左栏只有九宫格装备栏（默认）。由 GM 设定，对全场生效。",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
  });

  // 稀有度光晕：纯装饰，GM 可以整场关掉（不想用稀有度、或不想让玩家一眼看穿箱子里的货色）
  game.settings.register("limbusCompany_FVTT", "showRarity", {
    name:    "展示稀有度",
    hint:    "在背包 / 货架 / 仓库 / 战利品箱的物品格上，按稀有度画一层中心光晕"
           + "（平装绿 → 精良蓝 → 史诗紫 → 艺术金 → 神话红，越稀有越亮）。"
           + "关闭后只是不画光晕，物品卡上的稀有度仍可正常设置。由 GM 设定，对全场生效。",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: true,
    onChange: (v) => _applyRarityDisplay(v),
  });

  game.settings.register("limbusCompany_FVTT", "clashTotalFxSpeed", {
    name:    "拼点 TOTAL 演出节奏",
    hint:    "缩放演出各阶段的时长（不含骰子动画本身——那取决于 Dice So Nice 的动画速度设置）。",
    scope:   "client",
    config:  true,
    type:    String,
    choices: {
      slow:     "慢速（默认的 3 倍时长）",
      standard: "默认",
      fast:     "快速（默认的 1/3 时长）",
    },
    default: "standard",
  });
}

/**
 * 【展示稀有度】开关落到 <body> 上：关掉时挂 .limbus-no-rarity，
 * CSS 那边一条规则把所有格子的光晕 display:none，不用重渲染任何面板。
 */
function _applyRarityDisplay(enabled) {
  document.body?.classList.toggle("limbus-no-rarity", !enabled);
}

/**
 * 预加载 Handlebars 模板（提升首次渲染速度）
 */
async function _preloadTemplates() {
  const templatePaths = [
    // Actor sheets
    "systems/limbusCompany_FVTT/templates/actor/merchant-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/actor/character-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/actor/character-sheet-redesign.hbs",
    "systems/limbusCompany_FVTT/templates/actor/camp-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/actor/parts/header.hbs",
    "systems/limbusCompany_FVTT/templates/actor/parts/tab-items.hbs",
    "systems/limbusCompany_FVTT/templates/actor/parts/tab-skills.hbs",
    "systems/limbusCompany_FVTT/templates/actor/parts/tab-combat.hbs",
    // Item sheets
    "systems/limbusCompany_FVTT/templates/item/equipment-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/item/skill-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/item/consumable-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/item/container-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/item/skillbook-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/item/recipebook-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/item/panic-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/item/background-sheet.hbs",
    "systems/limbusCompany_FVTT/templates/apps/background-wizard.hbs",
    "systems/limbusCompany_FVTT/templates/apps/level-up-dialog.hbs",
    "systems/limbusCompany_FVTT/templates/apps/csv-import.hbs",
    // Partials
    "systems/limbusCompany_FVTT/templates/partials/title-card.hbs",
    "systems/limbusCompany_FVTT/templates/partials/activity-editor.hbs",
    // HUD
    "systems/limbusCompany_FVTT/templates/sin-resource-hud.hbs",
    "systems/limbusCompany_FVTT/templates/quick-action-hud.hbs",
    // GM Console
    "systems/limbusCompany_FVTT/templates/gm-console.hbs",
    // Squad HUD
    "systems/limbusCompany_FVTT/templates/squad-hud.hbs",
    // Loot sheet
    "systems/limbusCompany_FVTT/templates/actor/loot-sheet.hbs",
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

  /**
   * 判断两个值是否相等。**两种用法都支持**：
   *   · 子表达式：`{{#if (eq a b)}}`      → 返回布尔值
   *   · 块助手：  `{{#eq a b}}selected{{/eq}}` → 相等时输出块内容
   * 只写成值助手的话，块用法里 Handlebars 会把 options 当第二个参数传进来，
   * 助手又从不调用 options.fn，结果块内容永远不输出——所有
   * `{{#eq}}selected{{/eq}}` 的下拉都会退回第一项（选了远程却显示近战就是这么来的）。
   */
  Handlebars.registerHelper("eq", function (a, b, options) {
    const same = a === b;
    if (options && typeof options.fn === "function") {
      return same ? options.fn(this) : options.inverse(this);
    }
    return same;
  });

  /** 逻辑与（子表达式用：(and a b)） */
  Handlebars.registerHelper("and", (a, b) => Boolean(a) && Boolean(b));

  /** 逻辑非（子表达式用：(not a)） */
  Handlebars.registerHelper("not", (a) => !a);

  /** 逻辑或：任意个参数，任一为真即真（末位的 options 对象自动忽略） */
  Handlebars.registerHelper("or", (...args) => {
    args.pop();                       // Handlebars 总会在末尾塞一个 options
    return args.some(Boolean);
  });

  /** 分割字符串为数组（SafeString 安全）*/
  Handlebars.registerHelper("split", (str, sep) => {
    // tags 这类字段有的类型存数组、有的存 "标签1/标签2" 字符串，两种都要认——
    // 数组直接用，否则才按分隔符切（数组走 String() 会被拼成 "a,b"，切不出来）
    if (Array.isArray(str)) return str.map(t => String(t).trim()).filter(Boolean);
    const s    = str instanceof Handlebars.SafeString ? str.toString() : String(str ?? "");
    const sep2 = sep instanceof Handlebars.SafeString ? sep.toString() : String(sep ?? "/");
    return s.split(sep2).map(t => t.trim()).filter(Boolean);
  });

  /** 数组 → "a/b" 文本（输入框回显用；字符串原样返回） */
  Handlebars.registerHelper("join", (arr, sep) => {
    const sep2 = sep instanceof Handlebars.SafeString ? sep.toString() : String(sep ?? "/");
    if (Array.isArray(arr)) return arr.map(t => String(t).trim()).filter(Boolean).join(sep2);
    return String(arr ?? "");
  });

  /** 去除字符串首尾空格 */
  Handlebars.registerHelper("trim", (str) => {
    const s = str instanceof Handlebars.SafeString ? str.toString() : String(str ?? "");
    return s.trim();
  });

  /**
   * 物品描述文本自动替换（三种记号互不冲突，各管各的）：
   *   【XXX】 → BUFF 图标+名字的可悬停 chip（悬停显示 BUFF Title 卡）
   *   "XXX"  → 物品引用的可悬停 chip（悬停按名字搜索世界物品/合集包，显示物品 Title 卡）
   *   [XXX]  → 触发时机静态标签（按类别着色，不可悬停搜索）
   * 核心逻辑在 helpers/linkify.mjs（item-sheet.mjs 构建 Title 卡时也复用同一份），
   * 与 item-sheet.mjs 的 .desc-buff-chip / .desc-item-chip 悬停绑定配套使用。
   */
  Handlebars.registerHelper("linkify", (html) => {
    const raw = html instanceof Handlebars.SafeString ? html.toString() : String(html ?? "");
    return new Handlebars.SafeString(linkifyHtml(raw));
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
    if (typeof sinType !== "string" || !sinType) return "";
    const sin = sinType.charAt(0).toUpperCase() + sinType.slice(1);
    return `systems/limbusCompany_FVTT/assets/icons/Base_icon/${sin}_icon.webp`;
  });
});
