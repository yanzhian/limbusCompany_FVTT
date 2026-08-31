/**
 * csv-import-dialog.mjs — 物品批量导入对话框（CSV / TSV / Excel 复制粘贴）
 *
 * 流程：选择物品类型 → 选文件或直接粘贴表格 → 预览 + 校验 → 导入到
 * 世界物品列表或某个合集包。
 *
 * 解析/转换逻辑全在 helpers/csv-import.mjs，这里只负责界面与落库。
 */

import {
  parseDelimited,
  buildItemData,
  buildTemplateCSV,
  listAvailableColumns,
} from "../helpers/csv-import.mjs";

const PREVIEW_ROWS = 8;

export class CSVImportDialog extends Application {

  /* ─── 单例 ────────────────────────────────────────────────────────── */

  static _instance = null;

  static open(itemType = "equipment") {
    if (!game.user.isGM) { ui.notifications?.warn("仅 GM 可批量导入物品。"); return; }
    CSVImportDialog._instance ??= new CSVImportDialog();
    CSVImportDialog._instance.itemType = itemType;
    CSVImportDialog._instance.render(true);
    return CSVImportDialog._instance;
  }

  /* ─── 默认选项 ───────────────────────────────────────────────────── */

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "limbus-csv-import",
      title:     "批量导入物品（CSV / 表格）",
      template:  "systems/limbusCompany_FVTT/templates/apps/csv-import.hbs",
      width:     720,
      height:    "auto",
      resizable: true,
      classes:   ["limbuscompany", "csv-import"],
    });
  }

  /* ─── 实例状态 ───────────────────────────────────────────────────── */

  constructor(...args) {
    super(...args);
    this.itemType   = "equipment";
    this.rawText    = "";
    this.fileName   = "";
    this.target     = "world";   // "world" | 合集包 collection id
    this.showColumns = false;
    /** @type {{items:object[], errors:string[], warnings:string[], rows:string[][]}|null} */
    this._parsed = null;
  }

  /* ─── 数据准备 ───────────────────────────────────────────────────── */

  getData() {
    const typeLabels = {
      equipment: "装备", skill: "技能", consumable: "消耗品", material: "材料",
      container: "容器", skillbook: "技能书", recipebook: "配方表", panic: "恐慌卡", background: "背景",
    };
    const types = Object.keys(CONFIG.Item?.dataModels ?? typeLabels).map(t => ({
      value:    t,
      label:    typeLabels[t] ?? t,
      selected: t === this.itemType,
    }));

    // 可写入的物品合集包
    const packs = game.packs
      .filter(p => p.documentName === "Item" && !p.locked)
      .map(p => ({
        value:    p.collection,
        label:    `${p.metadata.label}（${p.metadata.packageName}）`,
        selected: this.target === p.collection,
      }));

    this._parse();
    const p = this._parsed;

    // 预览表格：列头 + 前 N 行
    let preview = null;
    if (p?.rows?.length) {
      preview = {
        headers: p.rows[0],
        rows:    p.rows.slice(1, 1 + PREVIEW_ROWS),
        more:    Math.max(0, p.rows.length - 1 - PREVIEW_ROWS),
      };
    }

    return {
      types,
      packs,
      hasPacks:    packs.length > 0,
      targetWorld: this.target === "world",
      fileName:    this.fileName,
      rawText:     this.rawText,
      preview,
      count:       p?.items.length ?? 0,
      errors:      p?.errors ?? [],
      warnings:    p?.warnings ?? [],
      canImport:   (p?.items.length ?? 0) > 0,
      showColumns: this.showColumns,
      columns:     this.showColumns ? listAvailableColumns(this.itemType) : [],
    };
  }

  /** 解析当前文本（结果缓存到 this._parsed） */
  _parse() {
    if (!this.rawText.trim()) { this._parsed = null; return; }
    const rows = parseDelimited(this.rawText);
    const { items, errors, warnings } = buildItemData(rows, this.itemType);
    this._parsed = { rows, items, errors, warnings };
  }

  /* ─── 事件绑定 ───────────────────────────────────────────────────── */

  activateListeners(html) {
    super.activateListeners(html);

    // 物品类型
    html.find(".csvi-type").on("change", e => {
      this.itemType = e.currentTarget.value;
      this.render(false);
    });

    // 导入目标
    html.find(".csvi-target").on("change", e => {
      this.target = e.currentTarget.value;
      this.render(false);
    });

    // 选择文件
    html.find(".csvi-file").on("change", async e => {
      const file = e.currentTarget.files?.[0];
      if (!file) return;
      this.fileName = file.name;
      this.rawText  = await file.text();
      this.render(false);
    });

    // 粘贴区（失焦时才重解析，避免边打字边重绘输入框）
    html.find(".csvi-paste").on("change blur", e => {
      const val = e.currentTarget.value;
      if (val === this.rawText) return;
      this.rawText  = val;
      this.fileName = "";
      this.render(false);
    });

    // 清空
    html.find(".csvi-clear").on("click", () => {
      this.rawText = "";
      this.fileName = "";
      this._parsed = null;
      this.render(false);
    });

    // 下载模板
    html.find(".csvi-template").on("click", () => {
      const csv  = buildTemplateCSV(this.itemType);
      const save = foundry.utils.saveDataToFile ?? globalThis.saveDataToFile;
      save(csv, "text/csv;charset=utf-8", `${this.itemType}-模板.csv`);
    });

    // 列头对照表折叠
    html.find(".csvi-toggle-columns").on("click", () => {
      this.showColumns = !this.showColumns;
      this.render(false);
    });

    // 执行导入
    html.find(".csvi-import").on("click", this._onImport.bind(this));

    // 拖入文件
    const zone = html.find(".csvi-dropzone")[0];
    if (zone) {
      zone.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
      zone.addEventListener("drop", async e => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        this.fileName = file.name;
        this.rawText  = await file.text();
        this.render(false);
      });
    }
  }

  /* ─── 关闭时清理单例 ─────────────────────────────────────────────── */

  async close(options = {}) {
    CSVImportDialog._instance = null;
    return super.close(options);
  }

  /* ─── 执行导入 ───────────────────────────────────────────────────── */

  async _onImport() {
    this._parse();
    const items = this._parsed?.items ?? [];
    if (!items.length) { ui.notifications.warn("没有可导入的数据。"); return; }

    const targetLabel = this.target === "world"
      ? "世界物品列表"
      : (game.packs.get(this.target)?.metadata.label ?? this.target);

    const ok = await Dialog.confirm({
      title:   "确认批量导入",
      content: `<p>将创建 <b>${items.length}</b> 个物品到 <b>${targetLabel}</b>。</p>
                <p>此操作不会覆盖已有同名物品，而是新建。确定继续？</p>`,
      defaultYes: false,
    });
    if (!ok) return;

    try {
      if (this.target === "world") {
        await Item.createDocuments(items);
      } else {
        const pack = game.packs.get(this.target);
        if (!pack) { ui.notifications.error("目标合集包不存在。"); return; }
        await Item.createDocuments(items, { pack: this.target });
      }
      ui.notifications.info(`已导入 ${items.length} 个物品到「${targetLabel}」。`);
      this.rawText  = "";
      this.fileName = "";
      this._parsed  = null;
      this.render(false);
    } catch (err) {
      console.error("limbusCompany_FVTT | CSV 导入失败", err);
      ui.notifications.error(`导入失败：${err.message}`);
    }
  }
}
