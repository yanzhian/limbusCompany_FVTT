/**
 * grid-layout.mjs — 网格放置算法共用 helper
 *
 * 容器物品卡（ContainerData.contents）、营地仓库（CampData.warehouseContents）
 * 与角色背包打包（bag-grid.mjs）共用同一套「放置记录 → 网格」的算法：
 *
 *   放置记录（placement）统一形状：{ x, y, w, h, rotated?, uuid?, itemData? }
 *   坐标一律 0-indexed；模板用的 CSS grid 坐标（col/row）由本模块 +1 产出。
 *
 * 本模块只做纯计算与解析，不碰任何 Document 更新、Socket 或 DOM —
 * 那些留在各自的 Sheet 里。
 */

/** 占用集合的键 */
export const cellKey = (x, y) => `${x},${y}`;

/**
 * 由锁定格列表构造快速查询集合。
 * @param {{x:number,y:number}[]} lockedCells
 * @returns {Set<string>}
 */
export function makeLockedSet(lockedCells = []) {
  return new Set((lockedCells ?? []).map(c => cellKey(c.x, c.y)));
}

/**
 * 判断 (x,y,w,h) 是否可以放置。
 *
 * @param {object[]} placements            现有放置记录
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {number} cols @param {number} rows
 * @param {object} [opts]
 * @param {number} [opts.excludeIdx=-1]    忽略该索引的记录（移动自身时用）
 * @param {Set<string>} [opts.lockedSet]   锁定格集合（不可覆盖）
 * @returns {boolean}
 */
export function canPlace(placements, x, y, w, h, cols, rows, { excludeIdx = -1, lockedSet = null } = {}) {
  if (x < 0 || y < 0 || x + w > cols || y + h > rows) return false;

  // 锁定格
  if (lockedSet?.size) {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        if (lockedSet.has(cellKey(x + dx, y + dy))) return false;
  }

  // 与已有物品的矩形相交检测
  const list = placements ?? [];
  for (let i = 0; i < list.length; i++) {
    if (i === excludeIdx) continue;
    const p = list[i];
    if (!p) continue;
    const pw = p.w ?? 1, ph = p.h ?? 1;
    const noOverlap = x + w <= p.x || p.x + pw <= x || y + h <= p.y || p.y + ph <= y;
    if (!noOverlap) return false;
  }
  return true;
}

/**
 * 行优先扫描，找到第一个可放入的位置；同一格先试原始尺寸，再试旋转尺寸。
 *
 * @param {object[]} placements
 * @param {number} w @param {number} h
 * @param {number} cols @param {number} rows
 * @param {object} [opts]  同 canPlace，额外 allowRotate（默认 true）
 * @returns {{x:number,y:number,w:number,h:number,rotated:boolean}|null}
 */
export function autoPlace(placements, w, h, cols, rows, { excludeIdx = -1, lockedSet = null, allowRotate = true } = {}) {
  const opts = { excludeIdx, lockedSet };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (canPlace(placements, x, y, w, h, cols, rows, opts))
        return { x, y, w, h, rotated: false };
      if (allowRotate && w !== h && canPlace(placements, x, y, h, w, cols, rows, opts))
        return { x, y, w: h, h: w, rotated: true };
    }
  }
  return null;
}

/**
 * 生成模板用的背景格列表。
 * @param {number} cols @param {number} rows
 * @param {Set<string>} occupied
 * @param {Set<string>} [lockedSet]
 * @returns {object[]} { x, y, col, row, occupied, locked }
 */
export function buildCells(cols, rows, occupied = new Set(), lockedSet = null) {
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: c, y: r, col: c + 1, row: r + 1,
        occupied: occupied.has(cellKey(c, r)),
        locked:   !!lockedSet?.has(cellKey(c, r)),
      });
    }
  }
  return cells;
}

/** 把一条放置记录占的格子写入 occupied 集合。 */
export function markOccupied(occupied, x, y, w, h) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      occupied.add(cellKey(x + dx, y + dy));
}

/**
 * 解析放置记录 → 模板数据（容器格与营地仓库共用）。
 *
 * 记录既可能带 `uuid`（Actor 内嵌物品 / 世界物品，走 fromUuid 解析），
 * 也可能只带 `itemData`（世界金库快照，无 UUID）。
 *
 * @param {object[]} placements
 * @param {object} opts
 * @param {number} opts.cols @param {number} opts.rows
 * @param {{x:number,y:number}[]} [opts.lockedCells=[]]
 * @param {string} [opts.search=""]                搜索词（不匹配的图块 show:false，仍占格）
 * @param {boolean} [opts.keepOrphanOccupancy=false]
 *        源物品已被删除的孤儿记录：true 仍占格（视觉与碰撞一致），false 直接忽略
 * @param {(ctx:{entry:object, placement:object, item:object}) => object|void} [opts.decorate]
 *        逐条加工钩子（战利品的「未揭晓遮蔽」等各卡专属逻辑）；
 *        返回新对象则取代该条目，返回 undefined 则沿用原地修改结果
 * @returns {Promise<{placedItems:object[], allCells:object[], orphanedIndices:number[]}>}
 */
export async function buildPlacementGrid(placements, {
  cols, rows, lockedCells = [], search = "", keepOrphanOccupancy = false, decorate = null,
} = {}) {
  const placedItems     = [];
  const occupied        = new Set();
  const orphanedIndices = [];
  const lockedSet       = makeLockedSet(lockedCells);
  const q               = (search ?? "").toLowerCase();
  const list            = placements ?? [];

  for (let idx = 0; idx < list.length; idx++) {
    const p = list[idx];
    if (!p) continue;

    let item = null;
    if (p.uuid)          item = await fromUuid(p.uuid).catch(() => null);
    else if (p.itemData) item = { id: null, type: p.itemData.type, name: p.itemData.name ?? "未知物品",
                                  img: p.itemData.img ?? "icons/svg/item-bag.svg",
                                  system: p.itemData.system ?? {} };

    const w        = Math.max(1, p.w ?? 1);
    const h        = Math.max(1, p.h ?? 1);
    const inBounds = p.x >= 0 && p.y >= 0 && p.x + w <= cols && p.y + h <= rows;

    if (!item) {
      if (keepOrphanOccupancy && inBounds) markOccupied(occupied, p.x, p.y, w, h);
      orphanedIndices.push(idx);
      continue;
    }
    if (!inBounds) continue;

    markOccupied(occupied, p.x, p.y, w, h);

    const entry = {
      idx,
      uuid:        p.uuid ?? "",
      x: p.x, y: p.y, w, h,
      col:         p.x + 1,   // CSS grid 1-indexed
      row:         p.y + 1,
      rotated:     p.rotated ?? false,
      show:        !q || (item.name ?? "").toLowerCase().includes(q),
      isContainer: item.type === "container",
      item: {
        _id:      item.id,
        name:     item.name,
        img:      item.img,
        quantity: item.system?.quantity ?? 1,
      },
    };
    placedItems.push(decorate ? (decorate({ entry, placement: p, item }) ?? entry) : entry);
  }

  return { placedItems, allCells: buildCells(cols, rows, occupied, lockedSet), orphanedIndices };
}
