/**
 * proximity.mjs — 「站得够近才能开」的距离判定
 *
 * 营地 / 商人这类场景 Actor，玩家得把自己的 Token 走到旁边才能打开面板。
 * 判定用**格数**（不是像素、也不是场景距离单位），并且按 Token 占地的
 * **矩形间隙**算：大 Token 的边缘贴着就算 0 格，不会因为中心点远而误判。
 *
 * GM 永远不受限制；场景里找不到任一方的 Token 时一律放行——宁可放宽，
 * 也不要因为 GM 忘了放 Token 就把玩家锁在面板外面。
 */

/** Token 占据的格子矩形（左上角格坐标 + 宽高格数） */
function _tokenRect(token) {
  const doc  = token?.document ?? token;
  const size = canvas?.grid?.size ?? 100;
  if (!doc) return null;
  return {
    i: Math.floor((doc.y ?? 0) / size),          // 行
    j: Math.floor((doc.x ?? 0) / size),          // 列
    h: Math.max(1, Math.round(doc.height ?? 1)),
    w: Math.max(1, Math.round(doc.width  ?? 1)),
  };
}

/**
 * 两个 Token 之间的格数间隙（切比雪夫距离，斜着也算 1 格）。
 * 紧贴 = 1，中间隔一格 = 2，重叠 = 0。
 * @returns {number|null} 算不出来时返回 null
 */
export function tokenGridGap(a, b) {
  const ra = _tokenRect(a), rb = _tokenRect(b);
  if (!ra || !rb) return null;
  // 两个矩形在各轴上的间隔（重叠时为 0）
  const dRow = Math.max(0, ra.i - (rb.i + rb.h - 1), rb.i - (ra.i + ra.h - 1));
  const dCol = Math.max(0, ra.j - (rb.j + rb.w - 1), rb.j - (ra.j + ra.w - 1));
  return Math.max(dRow, dCol);
}

/** 当前用户在本场景里"算数"的 Token：选中的 > 主控角色的 */
function _myTokens() {
  const controlled = canvas?.tokens?.controlled ?? [];
  if (controlled.length) return controlled;
  const mine = game.user?.character?.getActiveTokens?.(false, false) ?? [];
  return mine.filter(t => t?.scene?.id === canvas?.scene?.id || !t?.scene);
}

/**
 * 玩家的 Token 是否离这个 Actor 的 Token 足够近。
 *
 * @param {Actor} actor 营地 / 商人
 * @returns {{ok: boolean, gap: number|null, range: number}}
 *          ok=false 时 gap 是最近的那个距离（null 表示压根没找到 Token）
 */
export function isWithinInteractRange(actor) {
  let range = 3;
  try { range = game.settings.get("limbusCompany_FVTT", "interactRange") ?? 3; }
  catch { /* 设置没注册（早期加载）时用默认值 */ }

  // 0 = 关闭距离限制；GM 不受限
  if (!range || game.user?.isGM) return { ok: true, gap: null, range };

  const targets = actor?.getActiveTokens?.(false, false) ?? [];
  const mine    = _myTokens();
  // 任一方在当前场景没有 Token：放行（见文件头说明）
  if (!targets.length || !mine.length) return { ok: true, gap: null, range };

  let best = null;
  for (const t of targets) {
    for (const m of mine) {
      const gap = tokenGridGap(m, t);
      if (gap === null) continue;
      if (best === null || gap < best) best = gap;
    }
  }
  if (best === null) return { ok: true, gap: null, range };
  return { ok: best <= range, gap: best, range };
}

/**
 * 面板打开前的守卫：太远就弹提示并拦下。
 * @param {Actor} actor
 * @param {string} label 面板名，用于提示文案（"营地" / "商人"）
 * @returns {boolean} 允许打开
 */
export function guardInteractRange(actor, label = "面板") {
  const { ok, gap, range } = isWithinInteractRange(actor);
  if (ok) return true;
  ui.notifications?.warn(
    `离${label}太远了（${gap} 格），需要走到 ${range} 格以内。`);
  return false;
}
