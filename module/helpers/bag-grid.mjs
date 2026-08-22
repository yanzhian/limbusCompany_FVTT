/**
 * bag-grid.mjs — 角色背包网格打包器
 *
 * character 没有持久化的背包坐标数据，本工具在渲染时将背包物品
 * 按容量（capacity.w × capacity.h）首适应打包进 6 列网格，仅供显示。
 * 供 camp-sheet（营地左栏角色面板）与 actor-sheet（物品 Tab 网格视图）共用。
 */

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

/**
 * 将物品首适应打包进 cols 列网格。
 * @param {Item[]} items
 * @param {number} cols     列数（默认 6）
 * @param {number} minRows  最少行数（默认 6）
 * @returns {{ tiles: object[], rows: number, usedCells: number }}
 *   tiles: { id, uuid, name, img, quantity, x, y, w, h, col, row }
 */
export function packBagGrid(items, cols = 6, minRows = 6) {
  const occupied = new Set(); // "x,y"
  const tiles    = [];
  let   maxRow   = 0;

  const fits = (x, y, w, h) => {
    if (x + w > cols) return false;
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        if (occupied.has(`${x + dx},${y + dy}`)) return false;
    return true;
  };

  for (const item of items) {
    const cap = item.system?.capacity ?? {};
    let w = Math.max(1, Math.min(cols, cap.w ?? 1));
    let h = Math.max(1, cap.h ?? 1);

    // 首适应扫描（行数不设上限，放不下就往下扩展）
    let place = null;
    for (let y = 0; place === null; y++) {
      for (let x = 0; x < cols; x++) {
        if (fits(x, y, w, h))          { place = { x, y, w, h };          break; }
        if (w !== h && fits(x, y, h, w)) { place = { x, y, w: h, h: w }; break; }
      }
      if (y > 200) break; // 安全上限
    }
    if (!place) continue;

    for (let dy = 0; dy < place.h; dy++)
      for (let dx = 0; dx < place.w; dx++)
        occupied.add(`${place.x + dx},${place.y + dy}`);

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

  // 背景格
  const cells = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      cells.push({ x, y, col: x + 1, row: y + 1, occupied: occupied.has(`${x},${y}`) });

  return { tiles, rows, cells, usedCells: occupied.size };
}
