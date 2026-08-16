/**
 * csv-import.mjs — 物品批量导入（CSV / TSV）
 *
 * 用途：把 Excel / 表格里整理好的物品数据一次性导入为世界物品或合集包物品，
 * 免去逐个手动录入。
 *
 * 设计要点：
 *   - 解析：自建 RFC4180 风格解析器（支持引号包裹、字段内换行、"" 转义、BOM、
 *     CRLF）。分隔符可自动嗅探（, / ; / Tab）。
 *   - 列头：既支持直接写 schema 路径（如 `system.atkAdj`），也支持中文别名
 *     （如 `攻击修正`）。别名表见 COLUMN_ALIASES。
 *   - 取值：按 TypeDataModel schema 的字段类型自动转换（数字 / 布尔 / 字符串
 *     数组 / 对象），而不是硬编码字段列表——新增 schema 字段后无需改这里。
 *   - 只做纯数据处理，不碰 DOM，方便单独调用：
 *       const rows = parseDelimited(text);
 *       const { items, errors } = buildItemData(rows, "equipment");
 *       await Item.createDocuments(items);
 */

// ═══════════════════════════════════════════════════════════════════════════
//  分隔符文本解析
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 嗅探分隔符：取首行（忽略引号内内容）出现次数最多的候选。
 * @param {string} text
 * @returns {string}
 */
export function sniffDelimiter(text) {
  const candidates = ["\t", ",", ";"];
  let firstLine = "";
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    firstLine += ch;
  }
  let best = ",";
  let bestCount = 0;
  for (const d of candidates) {
    const n = firstLine.split(d).length - 1;
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

/**
 * 解析 CSV / TSV 文本为二维数组。
 * @param {string} text        原始文本
 * @param {string} [delimiter] 分隔符，缺省自动嗅探
 * @returns {string[][]}       行 → 单元格
 */
export function parseDelimited(text, delimiter) {
  if (typeof text !== "string") return [];
  // 去 BOM，统一换行
  let src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const d = delimiter || sniffDelimiter(src);

  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }   // "" → 字面引号
        else inQuotes = false;
      } else cell += ch;
      continue;
    }

    if (ch === '"' && cell === "") { inQuotes = true; continue; }
    if (ch === d)    { row.push(cell); cell = ""; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  // 收尾（文件末尾没有换行时）
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }

  // 丢弃完全空白的行
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}

// ═══════════════════════════════════════════════════════════════════════════
//  列头别名
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 中文（及常见英文）列头 → 文档路径。
 * 未列出的列头会被当作路径本身处理：
 *   - `name` / `img` / `folder` 直接落在文档根上
 *   - 其余没有前缀的列头视为 `system.<列头>`
 */
export const COLUMN_ALIASES = {
  // ── 文档级 ────────────────────────────────────────────────────────────
  "名称": "name", "名字": "name", "物品名": "name", "name": "name",
  "图标": "img", "图片": "img", "img": "img",
  "文件夹": "folder", "folder": "folder",

  // ── 通用 ──────────────────────────────────────────────────────────────
  "分类": "system.category", "类别": "system.category",
  "类型名": "system.typeName", "种类": "system.typeName",
  "数量": "system.quantity",
  "标签": "system.tags",
  "描述": "system.effect", "效果": "system.effect", "效果描述": "system.effect",
  "简介": "system.description",
  "副标题": "system.subtitle",
  "收藏": "system.favorited",
  "可重复使用": "system.reusable",
  "无限": "system.infinite",
  "价格": "system.price", "售价": "system.price",
  "眼价格": "system.cost", "成本": "system.cost",
  "库存": "system.stock",
  "隐藏": "system.hidden",
  "占格宽": "system.capacity.w", "宽": "system.capacity.w",
  "占格高": "system.capacity.h", "高": "system.capacity.h",

  // ── 装备 ──────────────────────────────────────────────────────────────
  "部位": "system.subtype", "子类型": "system.subtype",
  "攻击修正": "system.atkAdj",
  "防御修正": "system.defAdj",
  "速度修正": "system.speedAdj",
  "星芒": "system.stellarCost", "星芒费用": "system.stellarCost",
  "斩击抗性": "system.resistanceAdj.slash",
  "打击抗性": "system.resistanceAdj.blunt",
  "穿刺抗性": "system.resistanceAdj.pierce",

  // ── 技能 ──────────────────────────────────────────────────────────────
  "技能类型": "system.type",
  "等级": "system.level",
  "攻击类型": "system.category", "守备类型": "system.category",
  "反击类型": "system.counterType",
  "罪孽": "system.sinType", "罪孽属性": "system.sinType",
  "EGO等级": "system.egoDiceRating", "ego等级": "system.egoDiceRating",
  "加重": "system.weight", "加重值": "system.weight",
  "骰子类型": "system.diceType",
  "基础值": "system.baseValue",
  "骰数": "system.diceCount",
  "骰面": "system.diceFaces",
  "技能描述": "system.effectDesc",
  "理智消耗": "system.sanityCost",
  "武器限制": "system.weaponRestriction",
  "无法装备": "system.noEquip",

  // ── 容器 ──────────────────────────────────────────────────────────────
  "网格宽": "system.gridSize.width",
  "网格高": "system.gridSize.height",
};

/** 子类型/枚举值的中文 → 内部值映射（大小写不敏感，按列路径区分） */
const VALUE_ALIASES = {
  "system.subtype": { "上装": "upper", "下装": "lower", "武器": "weapon", "饰品": "accessory" },
  "system.type":    { "基础": "basic", "守备": "defense", "EGO": "ego" },
  "system.category": {
    "斩击": "slash", "打击": "blunt", "穿刺": "pierce",
    "闪避": "dodge", "格挡": "block", "反击": "counter",
    "拼点格挡": "clashBlock", "拼点反击": "clashCounter",
  },
  "system.counterType": { "斩击": "slash", "打击": "blunt", "穿刺": "pierce" },
  "system.sinType": {
    "愤怒": "wrath", "色欲": "lust", "怠惰": "sloth", "暴食": "gluttony",
    "忧郁": "gloom", "傲慢": "pride", "嫉妒": "envy",
  },
  "system.diceType": { "普通": "normal", "不可破": "unbreakable", "斩断": "severing" },
};

/**
 * 把一个列头解析成文档路径。
 * @param {string} header
 * @returns {string|null} 路径；空列头返回 null
 */
export function resolveColumnPath(header) {
  const raw = String(header ?? "").trim();
  if (!raw) return null;
  const alias = COLUMN_ALIASES[raw] ?? COLUMN_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  // 已经是路径形式（system.xxx / flags.xxx / 根字段）
  if (raw.startsWith("system.") || raw.startsWith("flags.")) return raw;
  if (["name", "img", "folder", "type"].includes(raw)) return raw;
  return `system.${raw}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  取值转换
// ═══════════════════════════════════════════════════════════════════════════

const TRUE_WORDS  = ["true", "1", "yes", "y", "是", "真", "有", "√", "✓", "on"];
const FALSE_WORDS = ["false", "0", "no", "n", "否", "假", "无", "×", "off", ""];

/**
 * 取得某物品类型的 schema（TypeDataModel）。
 * @param {string} itemType
 * @returns {foundry.data.fields.SchemaField|null}
 */
function getSystemSchema(itemType) {
  const model = CONFIG?.Item?.dataModels?.[itemType];
  return model?.schema ?? null;
}

/**
 * 同义字段兜底：不同物品类型里"描述"落在不同字段上
 * （effect / effectDesc / description）。若别名给出的路径在该类型的 schema 中
 * 不存在，则按同义组顺序找一个真实存在的字段。
 * @param {string} path
 * @param {string} itemType
 * @returns {string}
 */
export function adjustPathForType(path, itemType) {
  const schema = getSystemSchema(itemType);
  if (!schema || !path.startsWith("system.")) return path;
  const key = path.slice("system.".length);
  if (schema.getField?.(key)) return path;

  const SYNONYMS = [
    ["effect", "effectDesc", "description"],
    ["category", "typeName"],
  ];
  const group = SYNONYMS.find(g => g.includes(key));
  if (!group) return path;
  const hit = group.find(k => schema.getField?.(k));
  return hit ? `system.${hit}` : path;
}

/**
 * 按 schema 字段类型转换单元格文本。
 * @param {string} path   完整路径（含 system. 前缀）
 * @param {string} raw    单元格原文
 * @param {string} itemType
 * @returns {{ value:any }|{ error:string }}
 */
export function coerceValue(path, raw, itemType) {
  const text = String(raw ?? "").trim();

  // 文档根字段一律按字符串处理
  if (!path.startsWith("system.")) return { value: text };

  const fields = foundry.data?.fields ?? {};
  const schema = getSystemSchema(itemType);
  const field  = schema?.getField?.(path.slice("system.".length)) ?? null;

  // 值别名（枚举中文写法）
  const valueMap = VALUE_ALIASES[path];
  if (valueMap) {
    const mapped = valueMap[text] ?? valueMap[text.toUpperCase()];
    if (mapped !== undefined) return { value: mapped };
  }

  // schema 里没有这个字段：保留原文，由调用方决定是否警告
  if (!field) return { value: text, unknown: true };

  // 数字
  if (fields.NumberField && field instanceof fields.NumberField) {
    if (text === "") return { value: field.initial ?? 0 };
    const n = Number(text);
    if (Number.isNaN(n)) return { error: `「${text}」不是数字` };
    return { value: field.integer ? Math.round(n) : n };
  }

  // 布尔
  if (fields.BooleanField && field instanceof fields.BooleanField) {
    const low = text.toLowerCase();
    if (TRUE_WORDS.includes(low))  return { value: true };
    if (FALSE_WORDS.includes(low)) return { value: false };
    return { error: `「${text}」不是布尔值（可填 是/否、true/false、1/0）` };
  }

  // 数组
  if (fields.ArrayField && field instanceof fields.ArrayField) {
    if (text === "") return { value: [] };
    // 字符串数组（如 tags）：按 / 、 , 、； 分隔
    if (fields.StringField && field.element instanceof fields.StringField) {
      return { value: text.split(/[\/,，;；]/).map(s => s.trim()).filter(Boolean) };
    }
    // 复杂数组（如 activities）：要求填 JSON
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return { error: `「${path}」需要 JSON 数组` };
      return { value: parsed };
    } catch {
      return { error: `「${path}」的 JSON 解析失败` };
    }
  }

  // 纯对象字段：JSON
  if (fields.ObjectField && field instanceof fields.ObjectField
      && !(fields.SchemaField && field instanceof fields.SchemaField)) {
    if (text === "") return { value: {} };
    try { return { value: JSON.parse(text) }; }
    catch { return { error: `「${path}」的 JSON 解析失败` }; }
  }

  // 其余（StringField / HTMLField / SchemaField 的叶子等）按字符串
  return { value: text };
}

// ═══════════════════════════════════════════════════════════════════════════
//  行 → 物品数据
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把解析后的表格转换成可直接交给 Item.createDocuments 的数据数组。
 *
 * 表格第一行必须是列头。若表中含有 `type` 列（或列头写 `类型`），则每行各自
 * 决定物品类型；否则使用 defaultType。
 *
 * @param {string[][]} rows          parseDelimited 的结果
 * @param {string}     defaultType   缺省物品类型
 * @returns {{ items:object[], errors:string[], warnings:string[] }}
 */
export function buildItemData(rows, defaultType) {
  const errors   = [];
  const warnings = [];
  const items    = [];

  if (!rows.length) return { items, errors: ["表格是空的。"], warnings };

  const headerRow = rows[0];
  const paths = headerRow.map(h => {
    const t = String(h ?? "").trim();
    if (t === "类型" || t.toLowerCase() === "type") return "type";
    return resolveColumnPath(h);
  });

  if (!paths.some(p => p === "name")) {
    errors.push("缺少「名称」列（列头写 名称 或 name）。");
    return { items, errors, warnings };
  }

  const validTypes = Object.keys(CONFIG?.Item?.dataModels ?? {});
  const unknownReported = new Set();

  for (let r = 1; r < rows.length; r++) {
    const row    = rows[r];
    const lineNo = r + 1;

    // 先定类型（决定后续按哪个 schema 转换）
    let itemType = defaultType;
    const typeIdx = paths.indexOf("type");
    if (typeIdx >= 0) {
      const t = String(row[typeIdx] ?? "").trim();
      if (t) itemType = t;
    }
    if (validTypes.length && !validTypes.includes(itemType)) {
      errors.push(`第 ${lineNo} 行：未知物品类型「${itemType}」`);
      continue;
    }

    const data = { type: itemType, system: {} };
    let rowFailed = false;

    for (let c = 0; c < paths.length; c++) {
      const path = paths[c] ? adjustPathForType(paths[c], itemType) : null;
      if (!path || path === "type") continue;
      const raw = row[c];
      if (raw === undefined) continue;
      // 空单元格：跳过，保留 schema 默认值
      if (String(raw).trim() === "" && path !== "name") continue;

      const res = coerceValue(path, raw, itemType);
      if (res.error) {
        errors.push(`第 ${lineNo} 行 · 列「${headerRow[c]}」：${res.error}`);
        rowFailed = true;
        continue;
      }
      if (res.unknown && !unknownReported.has(path)) {
        unknownReported.add(path);
        warnings.push(`列「${headerRow[c]}」在「${itemType}」的数据模型中不存在，将按文本原样写入。`);
      }
      foundry.utils.setProperty(data, path, res.value);
    }

    if (rowFailed) continue;

    if (!String(data.name ?? "").trim()) {
      errors.push(`第 ${lineNo} 行：名称为空，已跳过。`);
      continue;
    }

    items.push(data);
  }

  return { items, errors, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════
//  模板 CSV 生成
// ═══════════════════════════════════════════════════════════════════════════

/** 各类型的推荐模板列（中文列头，顺序即模板列顺序） */
const TEMPLATE_COLUMNS = {
  equipment:  ["名称", "部位", "分类", "数量", "攻击修正", "防御修正", "速度修正",
               "星芒费用", "斩击抗性", "打击抗性", "穿刺抗性", "标签", "描述",
               "眼价格", "价格", "库存", "占格宽", "占格高"],
  skill:      ["名称", "技能类型", "等级", "攻击类型", "罪孽", "加重值", "骰子类型",
               "基础值", "骰数", "骰面", "星芒费用", "武器限制", "标签", "技能描述",
               "理智消耗", "价格", "库存"],
  consumable: ["名称", "分类", "类型名", "数量", "可重复使用", "无限", "标签",
               "描述", "眼价格", "价格", "库存", "占格宽", "占格高"],
  material:   ["名称", "分类", "类型名", "数量", "标签", "描述",
               "眼价格", "价格", "库存", "占格宽", "占格高"],
  container:  ["名称", "网格宽", "网格高", "眼价格", "价格", "库存", "占格宽", "占格高"],
  skillbook:  ["名称", "分类", "标签", "眼价格", "价格", "库存", "占格宽", "占格高"],
  panic:      ["名称", "标签", "描述"],
  background: ["名称", "副标题", "分类", "标签", "简介"],
};

/**
 * 生成某物品类型的模板 CSV 文本（含 BOM，Excel 直接双击不乱码）。
 * @param {string} itemType
 * @returns {string}
 */
export function buildTemplateCSV(itemType) {
  // 「描述」等同义列头由 adjustPathForType 在导入时按类型自动落到正确字段
  const cols = TEMPLATE_COLUMNS[itemType] ?? ["名称", "分类", "标签", "描述"];
  const example = cols.map(c => (c === "名称" ? "示例物品" : ""));
  return "﻿" + [cols.join(","), example.join(",")].join("\r\n") + "\r\n";
}

/**
 * 列出某物品类型可用的列头（供对照表展示）。
 * @param {string} itemType
 * @returns {{ header:string, path:string }[]}
 */
export function listAvailableColumns(itemType) {
  const schema = getSystemSchema(itemType);
  const out = [{ header: "名称", path: "name" }, { header: "图标", path: "img" }];
  if (!schema) return out;

  // 反向别名表：路径 → 首个中文别名
  const aliasByPath = {};
  for (const [zh, path] of Object.entries(COLUMN_ALIASES)) {
    if (!aliasByPath[path] && /[一-龥]/.test(zh)) aliasByPath[path] = zh;
  }

  const walk = (schemaField, prefix) => {
    const fields = foundry.data?.fields ?? {};
    for (const [key, field] of Object.entries(schemaField.fields ?? {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (fields.SchemaField && field instanceof fields.SchemaField) {
        walk(field, path);
        continue;
      }
      const full = `system.${path}`;
      out.push({ header: aliasByPath[full] ?? full, path: full });
    }
  };
  walk(schema, "");
  return out;
}
