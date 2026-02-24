import { LimbusActor } from "./module/documents/actor.mjs";
import { LimbusItem }  from "./module/documents/item.mjs";
import { LC }          from "./module/helpers/config.mjs";

/* ============================================================
   初始化 Hook
   ============================================================ */
Hooks.once("init", function () {
  console.log("LimbusCompany | 初始化 Limbus Company TRPG 系统...");

  // 全局挂载
  game.limbusCompany = { LimbusActor, LimbusItem, LC };
  CONFIG.LC = LC;

  // 注册文档类
  CONFIG.Actor.documentClass = LimbusActor;
  CONFIG.Item.documentClass  = LimbusItem;

  // ── 注册公共罪孽资源池（世界级持久化设置）──────────────────────────────
  game.settings.register("limbusCompany", "sinPool", {
    name:    "公共罪孽资源池",
    hint:    "七种罪孽的公共资源，任何人使用罪孽技能时对应资源+1",
    scope:   "world",
    config:  false,
    type:    Object,
    default: { ...LC.sinPoolDefault },
  });

  // ── 注册 Handlebars 辅助函数 ────────────────────────────────────────────
  Handlebars.registerHelper("lc_eq",  (a, b) => a === b);
  Handlebars.registerHelper("lc_neq", (a, b) => a !== b);
  Handlebars.registerHelper("lc_gt",  (a, b) => a > b);
  Handlebars.registerHelper("lc_lt",  (a, b) => a < b);
  Handlebars.registerHelper("lc_gte", (a, b) => a >= b);

  Handlebars.registerHelper("lc_localize", (key) => game.i18n.localize(key));

  Handlebars.registerHelper("lc_resistance_label", (key) => {
    const entry = LC.resistanceLevels[key];
    return entry ? game.i18n.localize(entry.label) : key;
  });

  Handlebars.registerHelper("lc_resistance_multiplier", (key) => {
    return LC.resistanceLevels[key]?.multiplier ?? 1.0;
  });

  Handlebars.registerHelper("lc_includes", (arr, val) =>
    Array.isArray(arr) && arr.includes(val)
  );

  Handlebars.registerHelper("times", (n, block) => {
    let out = "";
    for (let i = 0; i < n; i++) out += block.fn(i);
    return out;
  });

  // ── 注意：角色卡 Sheet 和物品 Sheet 尚未实现，暂不注册自定义 Sheet ───
  // 待 UI 阶段完成后在此添加：
  // Actors.unregisterSheet("core", ActorSheet);
  // Actors.registerSheet("limbusCompany", LimbusActorSheet, { makeDefault: true });
  // Items.unregisterSheet("core", ItemSheet);
  // Items.registerSheet("limbusCompany", LimbusItemSheet, { makeDefault: true });
});

/* ============================================================
   Ready Hook
   ============================================================ */
Hooks.once("ready", function () {
  console.log("LimbusCompany | 系统准备就绪。");
  console.log("LimbusCompany | 当前公共罪孽池：", game.limbusCompany.getSinPool());
});

/* ============================================================
   公共罪孽资源池工具方法
   挂载到 game.limbusCompany，方便宏和模块调用
   ============================================================ */
Hooks.once("init", function () {
  // 读取当前罪孽池
  game.limbusCompany.getSinPool = function () {
    return game.settings.get("limbusCompany", "sinPool");
  };

  // 调整某种罪孽资源（delta 可为正或负）
  game.limbusCompany.adjustSin = async function (sinKey, delta) {
    if (!(sinKey in LC.sinPoolDefault)) {
      console.warn(`LimbusCompany | 未知罪孽类型: ${sinKey}`);
      return;
    }
    const pool = game.limbusCompany.getSinPool();
    pool[sinKey] = Math.max(0, (pool[sinKey] ?? 0) + delta);
    await game.settings.set("limbusCompany", "sinPool", pool);
    console.log(`LimbusCompany | 罪孽池更新 [${sinKey}] → ${pool[sinKey]}`);
    return pool;
  };

  // 重置罪孽池（长休用）
  game.limbusCompany.resetSinPool = async function () {
    await game.settings.set("limbusCompany", "sinPool", { ...LC.sinPoolDefault });
    console.log("LimbusCompany | 公共罪孽池已重置。");
  };

  // 检查是否有足够的罪孽资源激活 EGO
  // sinCost 格式：{ wrath: 2, gluttony: 1 }
  game.limbusCompany.canActivateEgo = function (sinCost) {
    const pool = game.limbusCompany.getSinPool();
    for (const [sin, amount] of Object.entries(sinCost)) {
      if (amount > 0 && (pool[sin] ?? 0) < amount) return false;
    }
    return true;
  };
});
