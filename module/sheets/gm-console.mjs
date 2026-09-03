/**
 * gm-console.mjs — GM 控制台
 *
 * 快捷键 M 开启/关闭，仅限 GM 使用。
 * 功能：
 *   - 集体长休（HP / 理智 / AP / 混乱阈值 / 清除 BUFF 可单独勾选）
 *   - 经验分配（统一输入 XP 值分发给选中角色）
 *
 * 角色列表：默认显示所有 character 类型 Actor，支持从角色侧边栏拖入。
 */

export class GMConsole extends Application {

  /* ─── 单例 ────────────────────────────────────────────────────────── */

  static _instance = null;

  static toggle() {
    if (!game.user.isGM) return;
    if (GMConsole._instance?.rendered) {
      GMConsole._instance.close();
    } else {
      GMConsole._instance ??= new GMConsole();
      GMConsole._instance.render(true);
    }
  }

  /* ─── 默认选项 ───────────────────────────────────────────────────── */

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "gm-console",
      title:     "GM 控制台",
      template:  "systems/limbusCompany_FVTT/templates/gm-console.hbs",
      width:     500,
      height:    "auto",
      resizable: true,
      classes:   ["limbuscompany", "gm-console"],
    });
  }

  /* ─── 实例状态 ───────────────────────────────────────────────────── */

  constructor(...args) {
    super(...args);
    // 默认选中所有 character 角色
    this._selectedIds = new Set(
      game.actors.filter(a => a.type === "character").map(a => a.id)
    );
    // 长休勾选项
    this._lrOpts = { hp: true, sanity: true, ap: true, chaos: true, buffs: true };
    // 展开着的文件夹名（默认全部折叠）/ 搜索词
    this._expanded = new Set();
    this._search    = "";
  }

  /* ─── 数据准备 ───────────────────────────────────────────────────── */

  /** 角色所在文件夹的完整路径名（"外勤组 / 第二小队"），无文件夹则 null */
  static _folderPath(actor) {
    let f = actor.folder;
    if (!f) return null;
    const parts = [];
    let guard = 0;
    while (f && guard++ < 20) { parts.unshift(f.name); f = f.folder; }
    return parts.join(" / ");
  }

  getData() {
    // 列表：仓库中所有 character 角色 + 手动拖入但不在全局列表里的角色
    const allChars = game.actors.filter(a => a.type === "character");

    // 手动拖入但当前不在游戏角色列表的 Actor（理论上不存在，防御性保留）
    const extraIds = [...this._selectedIds].filter(
      id => !allChars.find(a => a.id === id)
    );
    const extra = extraIds
      .map(id => game.actors.get(id))
      .filter(Boolean);

    const actors = [...allChars, ...extra]
      .map(a => ({
        id:       a.id,
        name:     a.name,
        img:      a.img,
        selected: this._selectedIds.has(a.id),
        folder:   GMConsole._folderPath(a) ?? "未分类",
      }));

    // 按文件夹分组（未分类永远排最后）
    const byFolder = new Map();
    for (const a of actors) {
      if (!byFolder.has(a.folder)) byFolder.set(a.folder, []);
      byFolder.get(a.folder).push(a);
    }
    const folders = [...byFolder.entries()]
      .sort((x, y) => x[0] === "未分类" ? 1 : y[0] === "未分类" ? -1 : x[0].localeCompare(y[0], "zh"))
      .map(([name, list]) => ({
        name,
        key:       name,
        actors:    list,
        total:     list.length,
        chosen:    list.filter(a => a.selected).length,
        collapsed: !this._expanded.has(name),
      }));

    return {
      actors, folders,
      search: this._search ?? "",
      selectedCount: [...this._selectedIds].filter(
        id => game.actors.get(id)?.type === "character"
      ).length,
      lrOpts: this._lrOpts,
    };
  }

  /* ─── 事件绑定 ───────────────────────────────────────────────────── */

  activateListeners(html) {
    super.activateListeners(html);

    // ── 角色图块点击：切换选中 ────────────────────────────────────
    html.find(".gmc-actor-tile").on("click", e => {
      const id = e.currentTarget.dataset.actorId;
      if (this._selectedIds.has(id)) this._selectedIds.delete(id);
      else                            this._selectedIds.add(id);
      this.render(false);
    });

    // ── 全选 / 清空 ───────────────────────────────────────────────
    html.find(".gmc-select-all").on("click", () => {
      game.actors.filter(a => a.type === "character")
        .forEach(a => this._selectedIds.add(a.id));
      this.render(false);
    });
    html.find(".gmc-deselect-all").on("click", () => {
      this._selectedIds.clear();
      this.render(false);
    });

    // ── 文件夹折叠 ────────────────────────────────────────────────
    html.find(".gmc-folder-head").on("click", e => {
      if ($(e.target).closest(".gmc-folder-btn").length) return;   // 组内按钮不触发折叠
      const key = e.currentTarget.dataset.folder;
      if (this._expanded.has(key)) this._expanded.delete(key);
      else                         this._expanded.add(key);
      this.render(false);
    });

    // ── 按文件夹全选 / 清空 ───────────────────────────────────────
    html.find(".gmc-folder-btn").on("click", e => {
      e.stopPropagation();
      const key  = e.currentTarget.closest("[data-folder]")?.dataset.folder;
      const on   = e.currentTarget.dataset.act === "all";
      const list = game.actors.filter(a =>
        a.type === "character" && (GMConsole._folderPath(a) ?? "未分类") === key);
      for (const a of list) {
        if (on) this._selectedIds.add(a.id);
        else    this._selectedIds.delete(a.id);
      }
      this.render(false);
    });

    // ── 搜索角色 ──────────────────────────────────────────────────
    // 纯 DOM 过滤，不重渲染：重渲染会销毁输入框，中文输入法打一半就断了
    html.find(".gmc-search").on("input", e => {
      const q = (e.target.value ?? "").toLowerCase().trim();
      this._search = e.target.value;
      html.find(".gmc-folder").each((_, grp) => {
        let visible = 0;
        $(grp).find(".gmc-actor-tile").each((_i, tile) => {
          const hit = !q || (tile.dataset.name ?? "").toLowerCase().includes(q);
          tile.style.display = hit ? "" : "none";
          if (hit) visible++;
        });
        grp.style.display = visible ? "" : "none";
        // 搜索时临时展开命中的组（清空搜索词后恢复各自的折叠状态）
        if (q) grp.classList.remove("gmc-folder-collapsed");
        else   grp.classList.toggle("gmc-folder-collapsed", !this._expanded.has(grp.dataset.folder));
      });
    });

    // ── 长休勾选项 ────────────────────────────────────────────────
    html.find(".gmc-lr-cb").on("change", e => {
      const key = e.currentTarget.dataset.key;
      this._lrOpts[key] = e.currentTarget.checked;
    });

    // ── 执行长休 ──────────────────────────────────────────────────
    html.find(".gmc-btn-long-rest").on("click", this._onLongRest.bind(this));

    // ── 分配经验 ──────────────────────────────────────────────────
    html.find(".gmc-btn-xp").on("click", this._onAddXP.bind(this));

    // ── 批量导入物品（CSV / 表格）─────────────────────────────────
    html.find(".gmc-btn-csv-import").on("click", async () => {
      const { CSVImportDialog } = await import("./csv-import-dialog.mjs");
      CSVImportDialog.open();
    });

    // ── 拖放区域：接收侧边栏角色 ──────────────────────────────────
    const drop = html.find(".gmc-drop-zone")[0];
    drop.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    drop.addEventListener("drop",     this._onDropActor.bind(this));
  }

  /* ─── 关闭时清理单例 ─────────────────────────────────────────── */

  async close(options = {}) {
    GMConsole._instance = null;
    return super.close(options);
  }

  /* ─── 集体长休 ───────────────────────────────────────────────────── */

  async _onLongRest() {
    const actors = this._getSelectedActors();
    if (!actors.length) { ui.notifications.warn("没有选中角色。"); return; }

    const o = this._lrOpts;
    let count = 0;

    for (const actor of actors) {
      const sys     = actor.system;
      const updates = {};

      if (o.hp)     updates["system.hp.value"]        = sys.hp.max;
      if (o.sanity) updates["system.sanity.value"]     = 50;
      if (o.ap)     updates["system.ap.value"]         = 3;
      if (o.chaos) {
        updates["system.chaosThresholds"] =
          sys.getDefaultChaosThresholds?.() ??
          [{ percent: 60, triggered: false }, { percent: 30, triggered: false }];
      }
      if (o.buffs)  updates["system.buffs"]            = [];

      if (Object.keys(updates).length) {
        await actor.update(updates);
        count++;
      }
    }

    ui.notifications.info(`已对 ${count} 名角色执行长休。`);
  }

  /* ─── 经验分配 ───────────────────────────────────────────────────── */

  async _onAddXP() {
    const amount = parseInt(this.element.find(".gmc-xp-input").val()) || 0;
    if (amount <= 0) { ui.notifications.warn("请输入大于 0 的经验值。"); return; }

    const actors = this._getSelectedActors();
    if (!actors.length) { ui.notifications.warn("没有选中角色。"); return; }

    for (const actor of actors) await actor.addXP(amount);

    ui.notifications.info(`已为 ${actors.length} 名角色分配 ${amount} 点经验。`);
  }

  /* ─── 拖入角色 ───────────────────────────────────────────────────── */

  async _onDropActor(event) {
    event.preventDefault();
    let raw;
    try { raw = JSON.parse(event.dataTransfer.getData("text/plain")); }
    catch { return; }

    if (raw.type !== "Actor") return;

    const actor = (raw.uuid ? await fromUuid(raw.uuid).catch(() => null) : null)
      ?? game.actors.get(raw.id);
    if (!actor || actor.type !== "character") return;

    this._selectedIds.add(actor.id);
    this.render(false);
  }

  /* ─── 私有辅助 ───────────────────────────────────────────────────── */

  _getSelectedActors() {
    return [...this._selectedIds]
      .map(id => game.actors.get(id))
      .filter(a => a?.type === "character");
  }
}
