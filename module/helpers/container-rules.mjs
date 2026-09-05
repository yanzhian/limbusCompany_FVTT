/**
 * container-rules.mjs — 容器存放限制
 *
 * 容器可以声明两条限制，**同时满足**才收（AND）：
 *   · 类型限制 `system.allowTypes`      —— 物品类型，如「消耗品/材料」
 *   · 分类限制 `system.allowCategories` —— 物品分类，如「食材/食物」
 *
 * 两条都用 `/` 分隔多个可选值，留空 = 该条不限制。两条都留空 = 什么都能放。
 *
 * 例：
 *   医疗箱        类型【消耗品/材料】 分类【医疗】
 *   食品冷冻箱    类型【消耗品/材料】 分类【食材/食物】
 *   武器箱        类型【装备/消耗品】 分类（留空）
 *   scav垃圾箱    类型【材料】        分类【建材/工具/器具/采集物】
 *   弹药箱        类型【容器/消耗品】 分类【弹药/弹药包】   ← 允许套包
 *   弹药包        类型【消耗品】      分类【弹药】
 *
 * 「容器不能装容器」原先是写死的，现在改由类型限制决定：只有把「容器」
 * 明确列进 allowTypes 的容器才收容器（弹药箱收弹药包）。没写类型限制的
 * 容器一律不收容器——保持旧行为，也避免随手套娃。
 * 无论怎么配置，容器都不能装进它自己或自己的后代（会形成环）。
 */

/** 物品类型 → 中文名（限制里写的就是这些中文） */
export const ITEM_TYPE_LABELS = {
  equipment:  "装备",
  consumable: "消耗品",
  material:   "材料",
  container:  "容器",
  skillbook:  "技能书",
  recipebook: "配方表",
  background: "背景",
  panic:      "恐慌卡",
  skill:      "技能",
};

/** 装备子类型 → 中文名（类型限制里也认，方便写「武器箱：类型【武器】」） */
const SUBTYPE_LABELS = {
  weapon: "武器", upper: "上装", lower: "下装", accessory: "饰品",
};

/** 「A/B/C」→ ["A","B","C"]，去空白、去空项 */
export function splitRule(text) {
  return String(text ?? "")
    .split("/")
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * 取一件物品在限制里的"类型名"集合。
 * 含类型本身与装备子类型，命中任意一个即算类型匹配。
 * @param {object} itemLike  Item 文档或 toObject() 快照
 */
function typeNamesOf(itemLike) {
  const out = [];
  const label = ITEM_TYPE_LABELS[itemLike?.type];
  if (label) out.push(label);
  const sub = SUBTYPE_LABELS[itemLike?.system?.subtype];
  if (sub) out.push(sub);
  return out;
}

/** 取一件物品的分类集合（分类字段本身也允许用 `/` 写多个） */
function categoriesOf(itemLike) {
  return splitRule(itemLike?.system?.category ?? "");
}

/**
 * 判断某容器能否收下某物品。
 *
 * @param {Item}   container  容器物品
 * @param {object} itemLike   要放入的 Item 文档或数据快照（需有 type / system）
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canContainerAccept(container, itemLike) {
  if (!container || !itemLike) return { ok: false, reason: "找不到容器或物品。" };

  const sys        = container.system ?? {};
  const allowTypes = splitRule(sys.allowTypes);
  const allowCats  = splitRule(sys.allowCategories);

  // 容器套容器：必须被类型限制明确允许
  if (itemLike.type === "container" && !allowTypes.includes("容器")) {
    return { ok: false, reason: `【${container.name}】不能存放容器。` };
  }

  // 类型限制
  if (allowTypes.length) {
    const names = typeNamesOf(itemLike);
    if (!names.some(n => allowTypes.includes(n))) {
      return {
        ok: false,
        reason: `【${container.name}】只能存放【${allowTypes.join(" / ")}】类型的物品。`,
      };
    }
  }

  // 分类限制
  if (allowCats.length) {
    const cats = categoriesOf(itemLike);
    if (!cats.some(c => allowCats.includes(c))) {
      const own = cats.length ? `（该物品分类：${cats.join(" / ")}）` : "（该物品没有分类）";
      return {
        ok: false,
        reason: `【${container.name}】只收分类为【${allowCats.join(" / ")}】的物品${own}。`,
      };
    }
  }

  return { ok: true };
}

/**
 * 环检测：目标容器是否就是这件物品本身，或藏在这件物品（也是容器）内部。
 * 放进去会形成自己装自己的环，必须拦住。
 * @param {Item} container  目标容器
 * @param {Item} itemDoc    要放入的物品（Item 文档；快照没有 uuid 无从追溯，直接放行）
 * @returns {Promise<boolean>} true = 会形成环
 */
export async function wouldNest(container, itemDoc) {
  if (!container || !itemDoc?.uuid) return false;
  if (container.uuid === itemDoc.uuid) return true;
  if (itemDoc.type !== "container") return false;

  const seen = new Set();
  const walk = async (node) => {
    for (const p of (node?.system?.contents ?? [])) {
      if (!p?.uuid || seen.has(p.uuid)) continue;
      seen.add(p.uuid);
      if (p.uuid === container.uuid) return true;
      const child = await fromUuid(p.uuid).catch(() => null);
      if (child?.type === "container" && await walk(child)) return true;
    }
    return false;
  };
  return walk(itemDoc);
}
