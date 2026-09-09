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

/**
 * 当前用户在本场景里"算数"的 Token：选中的 > 主控角色的 > 场上任一自己拥有的角色。
 *
 * 第三档是后来补的：没设主控角色、又没选中 Token 的玩家（双击设施打开面板
 * 时很常见——他压根没点自己的小人）原本会落到"找不到 Token"，而那条分支是
 * **放行**，于是距离限制形同虚设。
 */
function _myTokens() {
  // 只认「自己的角色」。设施 Token 现在也是可以选中的（双击要靠它成立），
  // 不过滤的话：点一下设施 → 它成了"选中的 Token" → 自己跟自己算距离 → 永远 0 格。
  const isMyChar = (t) => t?.actor?.type === "character" && t.actor.isOwner;

  const controlled = (canvas?.tokens?.controlled ?? []).filter(isMyChar);
  if (controlled.length) return controlled;

  const mine = game.user?.character?.getActiveTokens?.(false, false) ?? [];
  const inScene = mine.filter(t => t?.scene?.id === canvas?.scene?.id || !t?.scene);
  if (inScene.length) return inScene;

  return (canvas?.tokens?.placeables ?? []).filter(isMyChar);
}

/**
 * 玩家的 Token 是否离这个 Actor 的 Token 足够近。
 *
 * @param {Actor} actor 营地 / 商人
 * @returns {{ok: boolean, gap: number|null, range: number}}
 *          ok=false 时 gap 是最近的那个距离（null 表示压根没找到 Token）
 */
/**
 * 调试开关。控制台里 `limbusProximityDebug(true)` 打开，之后每次判定都会把
 * 完整过程打到控制台：设置里的格数、双方 Token、算出来的间隙、放行原因。
 * 「距离被无视」有五六条不同的短路路径（GM、range=0、找不到 Token…），
 * 光看结果分不出是哪一条，所以把每一条都写清楚。
 */
let _debug = false;
export function setProximityDebug(on = true) {
  _debug = !!on;
  console.log(`limbusCompany_FVTT | 距离判定调试：${_debug ? "开" : "关"}`);
  return _debug;
}
function _log(verdict, detail) {
  if (!_debug) return;
  console.log(`limbusCompany_FVTT | 距离判定 → ${verdict}`, detail);
}

export function isWithinInteractRange(actor, { token = null } = {}) {
  let range = 3;
  try { range = game.settings.get("limbusCompany_FVTT", "interactRange") ?? 3; }
  catch { /* 设置没注册（早期加载）时用默认值 */ }

  // 0 = 关闭距离限制；GM 不受限
  if (!range) { _log("放行：设置里的距离为 0（限制已关闭）", { range }); return { ok: true, gap: null, range }; }
  if (game.user?.isGM) { _log("放行：你是 GM", { range }); return { ok: true, gap: null, range }; }

  // 明确给了 Token（双击进来的那一块）就只跟它比：同名设施可能摆了好几处，
  // 拿"任意一块最近的"算距离会让站在 A 号箱子旁边的人打开 B 号箱子。
  const targets = token ? [token] : (actor?.getActiveTokens?.(false, false) ?? []);
  const mine    = _myTokens();
  // 任一方在当前场景没有 Token：放行（见文件头说明）
  if (!targets.length || !mine.length) {
    _log("放行：找不到 Token（设施侧或你这侧）", {
      range,
      设施Token: targets.map(t => t?.name ?? t?.document?.name),
      我方Token: mine.map(t => t?.name),
      提示: targets.length ? "你这边没有可用 Token：没选中、没设主控角色、场上也没有你拥有的角色"
                          : "这个设施在当前场景没有 Token（用宏/侧边栏打开时就是这种）",
    });
    return { ok: true, gap: null, range };
  }

  let best = null;
  for (const t of targets) {
    for (const m of mine) {
      const gap = tokenGridGap(m, t);
      if (gap === null) continue;
      if (best === null || gap < best) best = gap;
    }
  }
  if (best === null) {
    _log("放行：两两之间都算不出格数（Token 不在同一场景？）", { range });
    return { ok: true, gap: null, range };
  }
  _log(best <= range ? `放行：${best} 格 ≤ ${range} 格` : `拦下：${best} 格 > ${range} 格`, {
    range, gap: best,
    设施Token: targets.map(t => t?.name ?? t?.document?.name),
    我方Token: mine.map(t => t?.name),
    指名的Token: token ? (token.name ?? token.document?.name) : "（没指名，跟该设施的所有 Token 比取最近）",
  });
  return { ok: best <= range, gap: best, range };
}

/**
 * 面板打开前的守卫：太远就弹提示并拦下。
 * @param {Actor} actor
 * @param {string} label 面板名，用于提示文案（"营地" / "商人"）
 * @returns {boolean} 允许打开
 */
export function guardInteractRange(actor, label = "面板", opts = {}) {
  const { ok, gap, range } = isWithinInteractRange(actor, opts);
  if (ok) return true;
  ui.notifications?.warn(
    `离${label}太远了（${gap} 格），需要走到 ${range} 格以内。`);
  return false;
}
