/**
 * item-lookup.mjs —— 按名字找一件已存在的物品
 *
 * CSV 里填不了 UUID（导出后会变、人也记不住），但物品名是唯一可读的抓手。
 * 背景的初始物品/等级奖励、技能书的技能列表都是「引用另一件物品」，
 * 导入时就靠这里把名字换成真正的 Item。
 *
 * 搜索范围：**世界物品 → 全部合集包**，先找到的赢。合集包只读索引（name+type），
 * 命中之后才 getDocument 把整份取出来——一次导入几十行也不至于把所有包都载进内存。
 *
 * 与 asset-lookup.mjs 的分工：那个按名字找**图**，这个按名字找**物品**。
 */

/** 名字归一化：去空白、去常见分隔符、忽略大小写（与 asset-lookup 同一套口径） */
function _norm(s) {
  return String(s ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[·・‧\-—–_]/g, "")
    .toLowerCase();
}

/** 归一化名 → { pack, id } 的合集包索引缓存；一次导入只建一次 */
let _packIndex = null;

async function _buildPackIndex() {
  if (_packIndex) return _packIndex;
  const map = new Map();
  _packIndex = map;                       // 先占位，避免并发重复建
  for (const pack of (game.packs ?? [])) {
    if (pack.documentName !== "Item") continue;
    let index;
    try { index = await pack.getIndex(); }
    catch { continue; }                   // 取不到索引的包直接跳过
    for (const e of index) {
      const key = _norm(e.name);
      if (!map.has(key)) map.set(key, { pack: pack.collection, id: e._id });
    }
  }
  return map;
}

/** 清缓存（世界里新建了物品之后想让下一次导入重新扫） */
export function clearItemIndex() { _packIndex = null; }

/**
 * 按名字找一件物品。
 * @param {string} name
 * @returns {Promise<Item|null>}
 */
export async function findItemByName(name) {
  const key = _norm(name);
  if (!key) return null;

  // 世界物品优先：GM 手改过的那份才是"现在生效"的
  const world = game.items?.find?.(i => _norm(i.name) === key);
  if (world) return world;

  const hit = (await _buildPackIndex()).get(key);
  if (!hit) return null;
  const pack = game.packs.get(hit.pack);
  if (!pack) return null;
  try { return await pack.getDocument(hit.id); }
  catch { return null; }
}

/**
 * 名字 → 物品引用（`makeItemRefSchema()` 的形状）。
 * `itemData` 存一份快照，源物品以后被删了卡面也还能显示。
 * @returns {Promise<{id:string,uuid:string,itemData:object}|null>}
 */
export async function makeItemRef(name) {
  const item = await findItemByName(name);
  if (!item) return null;
  const data = item.toObject();
  delete data._id;
  return { id: foundry.utils.randomID(), uuid: item.uuid, itemData: data };
}

/**
 * 把一批「待解析的引用」换成真正的引用结构，直接写进物品数据。
 *
 * 解析在**导入时**做而不是解析 CSV 时：查合集包是异步的，而 CSV 预览要同步出结果。
 * 所以解析阶段只把名字挂在 `data[PENDING_REFS]` 上，到这里才落地。
 *
 * @param {object[]} datas  Item 创建/更新数据（会被就地修改）
 * @param {string[]} warnings  找不到的名字往这里记
 * @returns {Promise<number>} 成功解析的引用条数
 */
export async function resolvePendingRefs(entries, warnings = []) {
  let n = 0;
  const missing = new Map();              // 名字 → 用到它的物品名，去重后一起报

  /** 只要图和快照，找不到就留个占位图，不算错——配方允许引用还没做出来的产物 */
  const softLook = async (name) => {
    const item = await findItemByName(name);
    return item ?? null;
  };

  const refsOf = async (names, ownerName) => {
    const out = [];
    for (const nm of names) {
      const ref = await makeItemRef(nm);
      if (ref) { out.push(ref); n++; }
      else {
        if (!missing.has(nm)) missing.set(nm, new Set());
        missing.get(nm).add(ownerName);
      }
    }
    return out;
  };

  for (const entry of (entries ?? [])) {
    // 覆盖导入时传 { data, doc }，新建时直接传数据本身
    const d   = entry?.data ?? entry;
    const doc = entry?.doc ?? null;
    const pending = d?.[PENDING_REFS];
    if (!pending) continue;
    delete d[PENDING_REFS];               // 不能写进文档

    if (pending.startingItems?.length) {
      foundry.utils.setProperty(d, "system.startingItems",
        await refsOf(pending.startingItems, d.name));
    }
    // 技能书：{ uuid, itemData } 的形状，与卡上拖入时一致。
    // 份数就是**重复几条**——slots 是按下标渲染的，重复条目各占一格。
    if (pending.skills?.length) {
      const skills = [];
      for (const { name, count } of pending.skills) {
        const item = await findItemByName(name);
        if (!item) {
          if (!missing.has(name)) missing.set(name, new Set());
          missing.get(name).add(d.name);
          continue;
        }
        for (let i = 0; i < Math.max(1, count ?? 1); i++) {
          skills.push({ uuid: item.uuid, itemData: null });
          n++;
        }
      }
      foundry.utils.setProperty(d, "system.skills", skills);
    }
    // 配方表：ingredients 存的是 名字+图+数量（不是 uuid 引用），所以找不到
    // 也能建——只是没有图。产出额外存一份快照，卡面能显示产物的图标与信息。
    if (pending.recipes?.length) {
      const built = [];
      for (const r of pending.recipes) {
        const out = await softLook(r.outputName);
        const ingredients = [];
        for (const ing of r.ingredients) {
          const it = await softLook(ing.name);
          ingredients.push({
            name:     ing.name,
            img:      it?.img ?? "icons/svg/item-bag.svg",
            quantity: ing.quantity,
          });
          if (it) n++;
        }
        const outData = out ? out.toObject() : null;
        if (outData) { delete outData._id; n++; }
        built.push({
          id:             foundry.utils.randomID(),
          name:           r.outputName,          // 配方名就用产物名
          hidden:         false,
          ingredients,
          outputName:     r.outputName,
          outputImg:      out?.img ?? "icons/svg/item-bag.svg",
          outputQuantity: r.outputQuantity,
          outputItemData: outData,
        });
      }
      // 覆盖已有配方表时是**合并**：同名配方替换，新配方追加，原有的别的配方保留
      if (doc) {
        const old  = foundry.utils.deepClone(doc.system?.recipes ?? []);
        const byName = new Map(built.map(r => [r.outputName, r]));
        const kept = old.map(o => {
          const hit = byName.get(o.outputName);
          if (!hit) return o;
          byName.delete(o.outputName);
          return { ...hit, id: o.id };           // 保留原 id，营地那边的引用不断
        });
        foundry.utils.setProperty(d, "system.recipes", [...kept, ...byName.values()]);
      } else {
        foundry.utils.setProperty(d, "system.recipes", built);
      }
    }
    if (pending.levelRewards?.length) {
      const rewards = [];
      for (const grp of pending.levelRewards) {
        const items = await refsOf(grp.names, d.name);
        rewards.push({ id: foundry.utils.randomID(), level: grp.level, items });
      }
      foundry.utils.setProperty(d, "system.levelRewards", rewards);
    }
  }

  for (const [nm, owners] of missing) {
    warnings.push(`找不到物品「${nm}」（${[...owners].join("、")} 里引用了它）`
      + `——请先导入/新建它再导这一行。`);
  }
  return n;
}

/** 挂在物品数据上的临时字段：待解析的引用。写库前必须剥掉 */
export const PENDING_REFS = "__pendingRefs";
