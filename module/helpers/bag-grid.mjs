/**
 * bag-grid.mjs — 角色背包网格打包器
 *
 * character 没有持久化的背包坐标数据，本工具在渲染时将背包物品
 * 按容量（capacity.w × capacity.h）首适应打包进 6 列网格，仅供显示。
 * 供 camp-sheet（营地左栏角色面板）与 actor-sheet（物品 Tab 网格视图）共用。
 */

import { autoPlace, buildCells, markOccupied } from "./grid-layout.mjs";

/** 计入背包容量的物品类型 */
export const BAG_ITEM_TYPES = ["equipment", "consumable", "material", "container", "skillbook", "background"];

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
 * 将物品首适应打包进 cols 列网格。
 * 放置算法复用 helpers/grid-layout.mjs（与容器 / 营地仓库同一套碰撞与旋转规则），
 * 区别是背包没有持久化坐标，行数不设上限、每次渲染重新打包。
 * @param {Item[]} items
 * @param {number} cols     列数（默认 6）
 * @param {number} minRows  最少行数（默认 6）
 * @returns {{ tiles: object[], rows: number, cells: object[], usedCells: number }}
 *   tiles: { id, uuid, name, img, quantity, isContainer, x, y, w, h, col, row }
 */
export function packBagGrid(items, cols = 6, minRows = 6) {
  const placements = [];   // { x, y, w, h } —— 供 autoPlace 做碰撞检测
  const tiles      = [];
  const occupied   = new Set();
  let   maxRow     = 0;

  for (const item of items) {
    const cap = item.system?.capacity ?? {};
    const w = Math.max(1, Math.min(cols, cap.w ?? 1));
    const h = Math.max(1, cap.h ?? 1);

    const place = autoPlace(placements, w, h, cols, PACK_ROW_LIMIT);
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
      isContainer: item.type === "container",
      x: place.x, y: place.y, w: place.w, h: place.h,
      col: place.x + 1, row: place.y + 1,
    });
  }

  const rows = Math.max(minRows, maxRow);
  return { tiles, rows, cells: buildCells(cols, rows, occupied), usedCells: occupied.size };
}
