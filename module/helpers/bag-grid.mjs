/**
 * bag-grid.mjs — 角色背包网格打包器
 *
 * 背包摆放坐标持久化在 `actor.system.bagLayout`（玩家拖过的物品才有记录）。
 * 本工具把有记录的按原位落位、没记录的按容量（capacity.w × capacity.h）
 * 首适应补进 5 列网格。
 * 供 camp-sheet（营地左栏角色面板）与 actor-sheet（物品 Tab 网格视图）共用。
 */

import { autoPlace, buildCells, canPlace, markOccupied } from "./grid-layout.mjs";

/** 背包网格尺寸：横 5 格 × 竖 8 格（营地左栏与角色卡物品 Tab 共用） */
export const BAG_COLS = 5;
export const BAG_ROWS = 8;

/** 计入背包容量的物品类型 */
export const BAG_ITEM_TYPES = ["equipment", "consumable", "material", "container", "skillbook", "recipebook", "background"];

/**
 * 返回 actor 的背包物品（排除已放入容器内的物品）。
 * @param {Actor} actor
 * @returns {Item[]}
 */
export function getBagItems(actor) {
  if (!actor) return [];
  // 收集容器内物品 uuid
  const inContainer = new Set();
  for (const item of actor.items) {
    if (item.type !== "container") continue;
    for (const p of (item.system?.contents ?? [])) {
      if (p?.uuid) inContainer.add(p.uuid);
    }
  }
  return actor.items.contents.filter(i =>
    BAG_ITEM_TYPES.includes(i.type) && !inContainer.has(i.uuid)
  );
}

/** 首适应扫描的行数安全上限 */
const PACK_ROW_LIMIT = 200;

/**
 * 将物品打包进 cols 列网格。
 * 放置算法复用 helpers/grid-layout.mjs（与容器 / 营地仓库同一套碰撞与旋转规则），
 * 区别是背包行数不设上限（按内容自然增长）。
 * @param {Item[]} items
 * @param {number} cols     列数（默认 BAG_COLS）
 * @param {number} minRows  最少行数（默认 BAG_ROWS）
 * @param {object[]} layout  持久化摆放记录 actor.system.bagLayout
 * @returns {{ tiles: object[], rows: number, cells: object[], usedCells: number }}
 *   tiles: { id, uuid, name, img, quantity, isContainer, x, y, w, h, col, row }
 */
export function packBagGrid(items, cols = BAG_COLS, minRows = BAG_ROWS, layout = []) {
  const placements = [];   // { x, y, w, h } —— 供 autoPlace 做碰撞检测
  const tiles      = [];
  const occupied   = new Set();
  let   maxRow     = 0;

  // 有持久化坐标的先按坐标落位，剩下的再首适应补位——
  // 否则自动补位可能先占掉别人摆好的格子。
  const saved = new Map((layout ?? []).map(e => [e.itemId, e]));
  const ordered = [
    ...items.filter(i => saved.has(i.id)),
    ...items.filter(i => !saved.has(i.id)),
  ];

  for (const item of ordered) {
    const cap  = item.system?.capacity ?? {};
    const ent  = saved.get(item.id) ?? null;
    const rot  = !!ent?.rotated;
    const rawW = Math.max(1, cap.w ?? 1);
    const rawH = Math.max(1, cap.h ?? 1);
    const w = Math.max(1, Math.min(cols, rot ? rawH : rawW));
    const h = Math.max(1, rot ? rawW : rawH);

    // 摆过的按原位放；位置已失效（网格变窄、与别人重叠）时退回自动补位
    let place = null;
    if (ent && canPlace(placements, ent.x, ent.y, w, h, cols, PACK_ROW_LIMIT)) {
      place = { x: ent.x, y: ent.y, w, h, rotated: rot };
    } else {
      place = autoPlace(placements, w, h, cols, PACK_ROW_LIMIT);
    }
    if (!place) continue;

    placements.push(place);
    markOccupied(occupied, place.x, place.y, place.w, place.h);
    maxRow = Math.max(maxRow, place.y + place.h);

    tiles.push({
      id:          item.id,
      uuid:        item.uuid,
      name:        item.name,
      img:         item.img,
      quantity:    item.system?.quantity ?? 1,
      // 数量角标只给「可堆叠且不止一件」的：×1 是废话，名字有 Title 卡可看
      showQty:     !!item.system?.stackable && (item.system?.quantity ?? 1) > 1,
      isContainer: item.type === "container",
      // 稀有度：只有装备/消耗品/材料/容器有这个字段，其余类型给空串（模板不上光晕类）
      rarity:      item.system?.rarity ?? "",
      rotated:     !!place.rotated,
      x: place.x, y: place.y, w: place.w, h: place.h,
      col: place.x + 1, row: place.y + 1,
    });
  }

  const rows = Math.max(minRows, maxRow);
  return { tiles, rows, cells: buildCells(cols, rows, occupied), usedCells: occupied.size };
}
