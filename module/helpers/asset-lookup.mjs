/**
 * asset-lookup.mjs —— 按物品名去 assets/ 里找同名图片
 *
 * CSV 里一个个填图片路径太累，而仓库里的素材基本就是拿物品名当文件名的
 * （assets/material/一包糖.webp、assets/equipment/二协会-巨剑.webp……）。
 * 所以导入时没写「图片」列的，就按 类型 → 目录 去捞一张同名图。
 *
 * 目录是按 Item 类型分的：
 *   材料 / 消耗品 / 容器 → assets/material
 *   装备               → assets/equipment
 *   技能（含 E.G.O）    → assets/skill
 *   恐惧卡             → assets/panice
 *   背景               → assets/background
 *
 * 找不到就什么都不做（保持 Foundry 默认图标），不报错、不猜别的目录——
 * 猜错了比没有更难排查。
 */

const ROOT = "systems/limbusCompany_FVTT/assets";

/** Item 类型 → 素材目录 */
const TYPE_DIRS = {
  material:   `${ROOT}/material`,
  consumable: `${ROOT}/material`,
  container:  `${ROOT}/material`,
  equipment:  `${ROOT}/equipment`,
  skill:      `${ROOT}/skill`,
  panic:      `${ROOT}/panice`,
  background: `${ROOT}/background`,
};

/** 认得的图片后缀（.aseprite 之类的源文件不算） */
const IMG_EXT = /\.(webp|png|jpe?g|gif|svg|avif)$/i;

/** Foundry 的默认图标：这些等于「没图」，可以被自动填的覆盖掉 */
const DEFAULT_IMGS = new Set([
  "", "icons/svg/item-bag.svg", "icons/svg/mystery-man.svg", "icons/svg/aura.svg",
  "icons/svg/book.svg", "icons/svg/sword.svg", "icons/svg/chest.svg",
]);

/** 目录 → { 归一化名: 完整路径 } 的缓存，一次导入只 browse 一遍 */
const _cache = new Map();

/** 名字归一化：去掉空白和常见分隔符，全角括号折成半角，忽略大小写 */
function _norm(s) {
  return String(s ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[·・‧\-—–_]/g, "")
    .replace(/[（）]/g, m => (m === "（" ? "(" : ")"))
    .toLowerCase();
}

/** v13 把 FilePicker 挪进了 foundry.applications.apps，老版本还在全局 */
function _picker() {
  return foundry?.applications?.apps?.FilePicker?.implementation
      ?? globalThis.FilePicker;
}

/**
 * 列出一个目录（含下一层子目录）里的图片，建成 归一化名 → 路径 的表。
 * 目录不存在 / 没权限时返回空表，调用方按「没找到」处理。
 */
async function _indexDir(dir) {
  if (_cache.has(dir)) return _cache.get(dir);

  const map = new Map();
  _cache.set(dir, map);                     // 先占位，避免并发重复 browse

  const FP = _picker();
  if (!FP?.browse) return map;

  const scan = async (path, depth) => {
    let res;
    try { res = await FP.browse("data", path); }
    catch { return; }                       // 目录不存在就当没有
    for (const f of (res.files ?? [])) {
      if (!IMG_EXT.test(f)) continue;
      const base = decodeURIComponent(f.split("/").pop()).replace(/\.[^.]+$/, "");
      const key  = _norm(base);
      if (!map.has(key)) map.set(key, f);   // 先来的赢，避免子目录盖掉主目录
    }
    if (depth > 0) for (const d of (res.dirs ?? [])) await scan(d, depth - 1);
  };
  await scan(dir, 1);

  return map;
}

/** 清掉缓存（素材换了之后想让下一次导入重新扫） */
export function clearAssetIndex() { _cache.clear(); }

/**
 * 按名字找一张图。
 * @param {string} name  物品名
 * @param {string} type  Item 类型
 * @returns {Promise<string|null>} 图片路径，找不到为 null
 */
export async function findItemImage(name, type) {
  const dir = TYPE_DIRS[type];
  if (!dir || !name) return null;
  const map = await _indexDir(dir);
  return map.get(_norm(name)) ?? null;
}

/**
 * 批量给「要新建的物品数据」补图片。
 * 已经写了 img 的行不动——CSV 里手填的优先级最高。
 * @param {object[]} datas  Item 创建数据
 * @returns {Promise<number>} 实际补上的数量
 */
export async function fillMissingImages(datas) {
  let n = 0;
  for (const d of (datas ?? [])) {
    if (d.img) continue;
    const img = await findItemImage(d.name, d.type);
    if (img) { d.img = img; n++; }
  }
  return n;
}

/**
 * 批量给「要覆盖的已有物品」补图片。
 * 只在原物品还是默认图标时才填——玩家自己换过的图不该被一次导入抹掉。
 * @param {{doc: Item, data: object}[]} updates
 * @returns {Promise<number>} 实际补上的数量
 */
export async function fillMissingImagesForUpdates(updates) {
  let n = 0;
  for (const u of (updates ?? [])) {
    if (u.data.img) continue;
    const cur = u.doc?.img ?? "";
    if (!DEFAULT_IMGS.has(cur)) continue;
    const img = await findItemImage(u.data.name ?? u.doc?.name, u.doc?.type);
    if (img) { u.data.img = img; n++; }
  }
  return n;
}
