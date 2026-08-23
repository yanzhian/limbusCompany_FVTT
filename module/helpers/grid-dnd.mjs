/**
 * grid-dnd.mjs — 网格拖放引擎（pointer 事件自绘，塔科夫式手感）
 *
 * 取代原先四处（容器卡 / 角色背包 / 营地仓库 / 战利品）各自依赖的 HTML5 拖放**手感**。
 * HTML5 DnD 有两个绕不开的限制：拖影的样式与透明度归浏览器管，拖动过程中也拿不到
 * 稳定的键盘事件——所以"原物品消失""不透明拖影""按 R 旋转""实时落点预览"都做不出来。
 * 本模块改用 pointerdown/move/up 全程自己画：
 *
 *   · 跟随光标的是自己造的**不透明**幽灵块，原图块整个隐藏
 *   · 实时预览落点：能放绿、不能放红；格间缝隙直接判定为不可放
 *   · 拖动中按 R 旋转，幽灵与预览同步转；Esc 取消
 *   · 跨窗口靠 document.elementFromPoint 命中，不依赖任何原生 DnD
 *
 * ── 与既有转移逻辑的关系 ────────────────────────────────────────────────
 * "物品从 A 挪到 B"这件事本身**不重写**：各 Sheet 里已有的 `drop` 处理器
 * 包含了大量来之不易的规则（营地仓库要走 GM socket、世界金库存快照而非 UUID、
 * 跨 Actor 要删源物品、同 Actor 只挪占位……）。本模块在松手时**合成一个原生
 * `drop` 事件**投给目标格子，payload 与原来 dragstart 写的完全一致，于是所有
 * 转移逻辑原封不动地复用。本模块只负责"怎么拖得好看、落点对不对"。
 *
 * payload 里额外多一个 `rotatePending` 字段：拖动中按过 R 时为 true，
 * 各 Sheet 的 drop 处理器据此把落地尺寸的宽高对调。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   GridDnD.register(html.find(".cg-wrap")[0], {
 *     key:        `container:${item.uuid}`,   // 同一网格的唯一标识
 *     cols, rows,
 *     editable:   () => this.isEditable,
 *     placements: () => item.system.contents, // 碰撞检测用（x/y/w/h）
 *     lockedSet:  () => makeLockedSet(item.system.lockedCells),
 *     payloadFor: (tileEl) => ({ ... }),      // 返回 null 表示这块不能拖
 *   });
 *
 * adapter 生命周期跟随 DOM：Sheet 重渲染后旧 root 不在 document 里，
 * 下次查询时自动剔除，不需要手动注销。
 */

import { canPlace } from "./grid-layout.mjs";

/** root 元素 → adapter */
const _grids = new Map();

/** 当前拖动状态（全局唯一，跨 Sheet 共享） */
let _drag = null;

/** 起拖阈值：按下后移动超过这么多像素才算拖动，否则算点击 */
const DRAG_THRESHOLD = 4;

export const GridDnD = {

  /**
   * 注册一个网格。重复注册同一个 root 会覆盖旧 adapter。
   * @param {HTMLElement} root     `.cg-wrap` 元素
   * @param {object}      adapter  见文件头注释
   */
  register(root, adapter) {
    if (!root || !adapter) return;
    _grids.set(root, adapter);
    // 图块交给 pointer 流程接管：禁掉原生拖放，免得两套机制打架。
    // 注意只禁图块——格子仍要能接住来自侧边栏/合集包的原生拖放。
    for (const tile of root.querySelectorAll(".cg-item-tile")) {
      tile.setAttribute("draggable", "false");
      tile.addEventListener("dragstart", _blockNativeDrag);
    }
    root.addEventListener("pointerdown", _onPointerDown);
  },

  unregister(root) { _grids.delete(root); },

  /** 是否正在拖动（Sheet 可据此跳过重渲染等） */
  get dragging() { return !!_drag && _drag.phase === "active"; },
};

function _blockNativeDrag(ev) {
  ev.preventDefault();
  ev.stopPropagation();
}

/** 清掉已经不在文档里的注册项（Sheet 重渲染后旧 root 会失效） */
function _pruneGrids() {
  for (const root of [..._grids.keys()]) {
    if (!root.isConnected) _grids.delete(root);
  }
}

/** 命中检测：光标下那个已注册网格 */
function _gridAt(clientX, clientY) {
  _pruneGrids();
  const el = document.elementFromPoint(clientX, clientY);
  const root = el?.closest?.(".cg-wrap");
  if (!root) return null;
  const adapter = _grids.get(root);
  return adapter ? { root, adapter } : null;
}

/**
 * 光标坐标 → 格子坐标。
 * 落在格间缝隙（gap）或内边距上时返回 null —— 缝隙不是合法落点。
 * @returns {{x:number,y:number}|null}
 */
function _cellAt(root, clientX, clientY) {
  const rect = root.getBoundingClientRect();
  const cs   = getComputedStyle(root);
  const cell = parseFloat(cs.getPropertyValue("--cg-cell")) || 44;
  const gap  = parseFloat(cs.getPropertyValue("--cg-gap"))  || 2;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padT = parseFloat(cs.paddingTop)  || 0;
  const step = cell + gap;

  const lx = clientX - rect.left - padL + root.scrollLeft;
  const ly = clientY - rect.top  - padT + root.scrollTop;
  if (lx < 0 || ly < 0) return null;

  const x = Math.floor(lx / step);
  const y = Math.floor(ly / step);
  if (lx - x * step > cell) return null;   // 落在竖向缝隙里
  if (ly - y * step > cell) return null;   // 落在横向缝隙里
  return { x, y };
}

/* ═══════════════════════════════════════════════════════════════════════
   拖动流程
   ═══════════════════════════════════════════════════════════════════════ */

function _onPointerDown(ev) {
  if (ev.button !== 0) return;                      // 只接左键，右键留给上下文菜单
  const tile = ev.target.closest?.(".cg-item-tile");
  if (!tile) return;
  if (ev.target.closest("button")) return;          // 图块上的小按钮不触发拖动

  const root    = ev.currentTarget;
  const adapter = _grids.get(root);
  if (!adapter || adapter.editable?.() === false) return;

  const payload = adapter.payloadFor?.(tile);
  if (!payload) return;

  _drag = {
    phase:   "pending",
    startX:  ev.clientX,
    startY:  ev.clientY,
    tile, root, adapter, payload,
    w:       Math.max(1, payload.w ?? 1),
    h:       Math.max(1, payload.h ?? 1),
    rotated: false,
    offX: 0, offY: 0,
    ghost: null, preview: null, hover: null,
  };

  // 抓取偏移：按住的是物品的第几格，落地时以此对齐
  const cellPos = _cellAt(root, ev.clientX, ev.clientY);
  if (cellPos && payload.x !== undefined) {
    _drag.offX = Math.max(0, Math.min(_drag.w - 1, cellPos.x - payload.x));
    _drag.offY = Math.max(0, Math.min(_drag.h - 1, cellPos.y - payload.y));
  }

  window.addEventListener("pointermove", _onPointerMove);
  window.addEventListener("pointerup",   _onPointerUp);
  window.addEventListener("keydown",     _onDragKey, true);
}

function _onPointerMove(ev) {
  if (!_drag) return;

  if (_drag.phase === "pending") {
    if (Math.hypot(ev.clientX - _drag.startX, ev.clientY - _drag.startY) < DRAG_THRESHOLD) return;
    _beginDrag();
  }
  _moveGhost(ev.clientX, ev.clientY);
  _updateHover(ev.clientX, ev.clientY);
}

/** 真正开始拖：造幽灵块、藏原图块 */
function _beginDrag() {
  _drag.phase = "active";

  const tile  = _drag.tile;
  const rect  = tile.getBoundingClientRect();
  const ghost = tile.cloneNode(true);
  // 系统样式全部写在 .limbuscompany 作用域下；幽灵挂在 body 上，
  // 不带这个类的话名称、数量这些子元素会丢掉全部样式（只剩图片）
  ghost.classList.add("cg-drag-ghost", "limbuscompany");
  ghost.classList.remove("cg-hidden");
  ghost.style.width  = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.appendChild(ghost);

  _drag.ghost  = ghost;
  _drag.ghostW = rect.width;
  _drag.ghostH = rect.height;
  // 幽灵以"抓住的那一格"为锚点，跟手
  _drag.anchorX = rect.width  * ((_drag.offX + 0.5) / _drag.w);
  _drag.anchorY = rect.height * ((_drag.offY + 0.5) / _drag.h);

  tile.classList.add("cg-dragging");
  document.body.classList.add("cg-dragging-active");
}

function _moveGhost(clientX, clientY) {
  const g = _drag.ghost;
  if (!g) return;
  g.style.left = `${clientX - _drag.anchorX}px`;
  g.style.top  = `${clientY - _drag.anchorY}px`;
}

/** 刷新落点预览（绿可放 / 红不可放） */
function _updateHover(clientX, clientY) {
  _clearPreview();

  const hit = _gridAt(clientX, clientY);
  if (!hit) { _drag.hover = null; return; }

  const { root, adapter } = hit;
  if (adapter.editable?.() === false) { _drag.hover = null; return; }

  // 容器图块：整块视为一个"存进去"的投放点（自动寻位由接收端负责），
  // 不参与格子碰撞——否则永远压在容器自己身上，判成红色放不进去。
  const overTile = document.elementFromPoint(clientX, clientY)
    ?.closest?.(".cg-item-tile.cg-tile-container");
  if (overTile && overTile !== _drag.tile && _drag.payload.uuid) {
    _drag.hover = { root, adapter, tileEl: overTile, ok: true };
    _drawTilePreview(overTile);
    return;
  }

  const cellPos = _cellAt(root, clientX, clientY);
  if (!cellPos) { _drag.hover = null; return; }     // 缝隙：没有落点

  const x = cellPos.x - _drag.offX;
  const y = cellPos.y - _drag.offY;
  const sameGrid   = adapter.key === _drag.adapter.key;
  const excludeIdx = sameGrid ? (_drag.payload.placementIdx ?? -1) : -1;
  const ok = canPlace(adapter.placements?.() ?? [], x, y, _drag.w, _drag.h,
                      adapter.cols, adapter.rows,
                      { excludeIdx, lockedSet: adapter.lockedSet?.() ?? null });

  _drag.hover = { root, adapter, x, y, ok };
  _drawPreview(root, x, y, ok, adapter.cols);
}

/** 容器图块上的"存入"提示：直接罩在这块图块上（金色） */
function _drawTilePreview(tileEl) {
  const el = document.createElement("div");
  el.className = "cg-drop-preview cg-into";
  el.style.gridColumn = tileEl.style.gridColumn;
  el.style.gridRow    = tileEl.style.gridRow;
  tileEl.parentElement?.appendChild(el);
  _drag.preview = el;
}

function _drawPreview(root, x, y, ok, cols) {
  const el = document.createElement("div");
  el.className = `cg-drop-preview ${ok ? "cg-ok" : "cg-bad"}`;
  // 越界时把坐标夹回网格内，红框仍能提示"这儿放不下"
  const cx = Math.max(0, Math.min(x, Math.max(0, (cols ?? 99) - 1)));
  const cy = Math.max(0, y);
  el.style.gridColumn = `${cx + 1} / span ${_drag.w}`;
  el.style.gridRow    = `${cy + 1} / span ${_drag.h}`;
  root.appendChild(el);
  _drag.preview = el;
}

function _clearPreview() {
  _drag?.preview?.remove();
  if (_drag) _drag.preview = null;
}

/** 拖动中：R 旋转，Esc 取消 */
function _onDragKey(ev) {
  if (!_drag || _drag.phase !== "active") return;

  if (ev.key === "Escape") {
    ev.preventDefault(); ev.stopPropagation();
    _endDrag();
    return;
  }
  if (ev.key !== "r" && ev.key !== "R") return;
  ev.preventDefault(); ev.stopPropagation();

  [_drag.w, _drag.h] = [_drag.h, _drag.w];
  _drag.rotated = !_drag.rotated;
  _drag.offX = 0;                    // 旋转后原抓取偏移失去意义，回到左上角
  _drag.offY = 0;

  const g = _drag.ghost;
  if (g) {
    [_drag.ghostW, _drag.ghostH] = [_drag.ghostH, _drag.ghostW];
    g.style.width  = `${_drag.ghostW}px`;
    g.style.height = `${_drag.ghostH}px`;
    _drag.anchorX  = _drag.ghostW / (_drag.w * 2);
    _drag.anchorY  = _drag.ghostH / (_drag.h * 2);
  }
}

function _onPointerUp(ev) {
  if (!_drag) return;
  const drag  = _drag;
  const phase = drag.phase;
  const hover = drag.hover;
  _endDrag();

  if (phase === "pending") return;                  // 没超过阈值：算点击，交给别的监听
  if (!hover?.ok) return;                           // 缝隙 / 越界 / 重叠：原样退回

  // 把落点换算成目标格子元素，合成一个原生 drop 事件投过去——
  // 转移规则一律沿用各 Sheet 既有的 drop 处理器，本模块不重复实现。
  // 投给**落点左上角**那个格子，而不是光标底下那个：payload 里的抓取偏移
  // 统一写死为 0，接收端 `nx = targetX - offX` 才会正好等于 hover.x。
  // （抓大件物品时按住的多半是中间某一格，投错格子就会整体右下偏移。）
  // 目标是容器图块时直接投给它（接收端会在容器里自动寻位），
  // 否则投给落点左上角那个格子。
  const cell = hover.tileEl ?? hover.root.querySelector(
    `.cg-cell[data-x="${hover.x}"][data-y="${hover.y}"]`);
  if (!cell) return;

  // dropX/dropY = 已经算好抓取偏移与旋转的落点左上角。
  // 老的 drop 处理器仍按自己的 offX/offY 换算（行为不变），新写的直接用这两个值。
  const payload = {
    ...drag.payload,
    rotatePending: drag.rotated,
    dropX: hover.x, dropY: hover.y,
  };
  let dt;
  try {
    dt = new DataTransfer();
    dt.setData("text/plain", JSON.stringify(payload));
  } catch {
    ui.notifications?.error("当前浏览器不支持合成拖放数据，放置取消。");
    return;
  }
  cell.dispatchEvent(new DragEvent("drop", {
    bubbles: true, cancelable: true, dataTransfer: dt,
    clientX: ev.clientX, clientY: ev.clientY,
  }));
}

/** 收尾：拆监听、拆幽灵、恢复原图块 */
function _endDrag() {
  if (!_drag) return;
  _clearPreview();
  _drag.ghost?.remove();
  _drag.tile?.classList.remove("cg-dragging");
  document.body.classList.remove("cg-dragging-active");
  _drag = null;
  window.removeEventListener("pointermove", _onPointerMove);
  window.removeEventListener("pointerup",   _onPointerUp);
  window.removeEventListener("keydown",     _onDragKey, true);
}
