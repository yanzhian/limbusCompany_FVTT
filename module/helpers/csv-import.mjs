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

/** 需要专门解析的"虚拟列"标记（不是直接的 schema 路径） */
const IGNORE      = "__ignore";
const V_CATEGORY  = "__category";
const V_CAPACITY  = "__capacity";
const V_GRID      = "__grid";
const V_DICE      = "__dice";
const V_LEVEL     = "__level";
const V_RESIST    = "__resist";
const V_WEAK      = "__weak";
const V_SIN_COST  = "__sinCost";
const V_SPREAD    = "__spread";
const V_EGO_RES   = "__egoRes";
/** 「攻击范围」列：留空 = 近战 1 格；"2" = 近战 2 格；"远程6" = 远程 6 格 */
const V_RANGE     = "__range";
/** 「完成」列：值为真时整行跳过（已经导入过的条目不再重复导入） */
const V_DONE      = "__done";

/** 抗性 / 弱性列的倍率写法 */
const RESIST_MULT = "x0.5";
const WEAK_MULT   = "x2.0";

/**
 * 中文（及常见英文）列头 → 文档路径。
 * 未列出的列头会被当作路径本身处理：
 *   - `name` / `img` / `folder` 直接落在文档根上
 *   - 其余没有前缀的列头视为 `system.<列头>`
 */
export const COLUMN_ALIASES = {
  // ── 仅供表格自己看的列，导入时忽略 ────────────────────────────────────
  "图标": IGNORE, "备注": IGNORE,
  // 「完成」列填 是/TRUE/√ 等真值时，整行跳过不导入
  "完成": V_DONE, "已完成": V_DONE, "done": V_DONE,
  "区域1": IGNORE, "区域2": IGNORE, "区域3": IGNORE,
  "区域4": IGNORE, "区域5": IGNORE, "区域6": IGNORE,

  // ── 文档级 ────────────────────────────────────────────────────────────
  "名称": "name", "名字": "name", "物品名": "name", "name": "name",
  "图片": "img", "img": "img",
  "文件夹": "folder", "folder": "folder",

  // ── 通用 ──────────────────────────────────────────────────────────────
  "分类": V_CATEGORY,               // 技能：斩击 / 反击-打击 / 可拼点反击-斩击；其余：自由文本
  "标签": "system.tags",
  "效果": "system.effect", "描述": "system.effect", "效果描述": "system.effect",
  "副标题": "system.subtitle",
  "简介": "system.description", "背景描述": "system.description",
  "星芒": "system.stellarCost", "星芒费用": "system.stellarCost",
  "容量": V_CAPACITY,               // "2x3" → capacity.w / capacity.h
  "价格": "system.price", "售价": "system.price",
  "数量": "system.quantity",
  "库存": "system.stock",
  "隐藏": "system.hidden",
  "收藏": "system.favorited",
  "稀有度": "system.rarity",        // 平装 / 精良 / 史诗 / 艺术 / 神话
  "可堆叠": "system.stackable",

  // ── 装备 ──────────────────────────────────────────────────────────────
  "攻击等级": "system.atkAdj", "攻击修正": "system.atkAdj",
  "防御等级": "system.defAdj", "防御修正": "system.defAdj",
  "速度":     "system.speedAdj", "速度修正": "system.speedAdj",
  "攻击范围": V_RANGE, "射程": V_RANGE,   // 留空=近战1；"2"=近战2；"远程6"=远程6
  "抗性": V_RESIST,                 // "打" → 打击抗性 x0.5
  "弱性": V_WEAK,                   // "突" → 突刺抗性 x2.0
  "斩击抗性": "system.resistanceAdj.slash",
  "打击抗性": "system.resistanceAdj.blunt",
  "突刺抗性": "system.resistanceAdj.pierce",
  "穿刺抗性": "system.resistanceAdj.pierce",

  // ── 技能 ──────────────────────────────────────────────────────────────
  "罪孽": "system.sinType", "罪孽属性": "system.sinType",
  "等级": V_LEVEL,               // 基础/守备写数字；EGO 写 ZAYIN/TET/HE/WAW/ALEPH
  "骰数": V_DICE,                   // "1D4+2" / "20-1D8"（负面骰）→ diceCount / diceFaces / baseValue
  "攻击容量": "system.weight", "加重值": "system.weight", "加重": "system.weight",
  "骰类型": "system.diceType", "骰子类型": "system.diceType",
  "无法装备": "system.noEquip",
  "援护防御": "system.coverDefense",
  "无法拼点": "system.noClash",
  "无差别攻击": "system.indiscriminate", "无差别": "system.indiscriminate",

  // ── 容器：存放限制（两条 AND，留空 = 不限制，多个用 / 分隔）─────────
  "允许类型": "system.allowTypes", "存放限制-类型": "system.allowTypes",
  "允许分类": "system.allowCategories", "存放限制-分类": "system.allowCategories",
  "容量扩散": V_SPREAD, "扩散": V_SPREAD,   // "[链式扩散3]" / "广域乱射2"
  "理智消耗": "system.sanityCost",
  "罪孽资源消耗": V_SIN_COST,       // "暴怒2/嫉妒1"
  "抗性修改": V_EGO_RES,            // "暴怒x0.5/嫉妒x2.0"
  "EGO等级": "system.egoDiceRating", "ego等级": "system.egoDiceRating",
  "武器限制": "system.weaponRestriction",
  "技能描述": "system.effectDesc",
  // 训练等级：同名的几行会合并成同一张卡的多阶数值，见 mergeTrainLevels
  "训练等级": "system.trainLevel", "阶段等级": "system.trainLevel",

  // ── 消耗品 / 材料 / 容器 ──────────────────────────────────────────────
  "可复用": "system.reusable", "可重复使用": "system.reusable",
  "无限耐久": "system.infinite", "无限": "system.infinite",
  "内部数量": V_GRID,               // "4x8" → gridSize.width / height
  "网格宽": "system.gridSize.width",
  "网格高": "system.gridSize.height",
};

/** 子类型/枚举值的中文 → 内部值映射（大小写不敏感，按列路径区分） */
const VALUE_ALIASES = {
  "system.rarity": {
    "平装": "common", "普通": "common", "白": "common",
    "精良": "fine",   "优良": "fine",   "蓝": "fine",
    "史诗": "epic",   "紫": "epic",
    "艺术": "artistic", "金": "artistic",
    "神话": "mythic", "红": "mythic",
  },
  // 训练等级：罗马数字 / 阿拉伯数字 / 规则书里的叫法都收
  "system.trainLevel": {
    "Ⅰ": 1, "I": 1, "1": 1,
    "Ⅱ": 2, "II": 2, "2": 2,
    "Ⅲ": 3, "III": 3, "3": 3, "默认": 3, "基础": 3,
    "Ⅳ": 4, "IV": 4, "4": 4, "精通": 4,
    "Ⅴ": 5, "V": 5, "5": 5, "强化": 5,
  },
  "system.sinType": {
    "暴怒": "wrath", "愤怒": "wrath", "色欲": "lust", "怠惰": "sloth",
    "暴食": "gluttony", "忧郁": "gloom", "傲慢": "pride", "嫉妒": "envy",
  },
  "system.diceType": {
    "": "normal", "-": "normal", "普通": "normal", "一般": "normal", "一般骰子": "normal",
    "不可摧毁": "unbreakable", "不可破": "unbreakable", "斩断": "severing",
  },
};

/** 「类型」列 → 物品类型 + 随类型固定的附加字段 */
const TYPE_ALIASES = {
  "基础技能": { type: "skill", extra: { "system.type": "basic" } },
  "守备技能": { type: "skill", extra: { "system.type": "defense" } },
  "EGO":     { type: "skill", extra: { "system.type": "ego" } },
  "E.G.O":   { type: "skill", extra: { "system.type": "ego" } },
  "上装":    { type: "equipment", extra: { "system.subtype": "upper" } },
  "下装":    { type: "equipment", extra: { "system.subtype": "lower" } },
  "武器":    { type: "equipment", extra: { "system.subtype": "weapon" } },
  "饰品":    { type: "equipment", extra: { "system.subtype": "accessory" } },
  "消耗品":  { type: "consumable", extra: {} },
  "材料":    { type: "material",   extra: {} },
  "容器":    { type: "container",  extra: {} },
  "技能书":  { type: "skillbook",  extra: {} },
  "配方表":  { type: "recipebook", extra: {} },
  "恐慌卡":  { type: "panic",      extra: {} },
  "背景":    { type: "background", extra: {} },
};

/** 攻击分类 / 守备分类的中文写法 */
const ATTACK_CATS  = { "斩击": "slash", "打击": "blunt", "突刺": "pierce", "穿刺": "pierce" };
const DEFENSE_CATS = {
  "闪避": "dodge", "格挡": "block", "反击": "counter",
  "可拼点格挡": "clashBlock", "拼点格挡": "clashBlock",
  "可拼点反击": "clashCounter", "拼点反击": "clashCounter",
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
  if (alias) return alias;   // 可能是 IGNORE 或 __xxx 虚拟列标记
  // 「完成」列的列头写法很多（是否完成 / 完成？ / 完成情况…），含「完成」二字就认
  if (raw.includes("完成")) return V_DONE;
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

  // 富文本（效果 / 描述 / 简介）：换行转 <br>，没有换行时按触发时机自动断行
  if (fields.HTMLField && field instanceof fields.HTMLField) {
    return { value: richTextFromCsv(text) };
  }

  // 其余（StringField / SchemaField 的叶子等）按字符串
  return { value: text };
}

/**
 * 把 CSV 单元格里的描述文本整理成物品卡上的富文本。
 *
 * · 单元格里本来就有换行（Excel 里 Alt+Enter）→ 逐行转 <br>
 * · 全挤在一行 → 在每个 [触发时机] 前断行，例如
 *   "…【广域乱射】 [攻击前]：… [攻击时]：…"
 *   → "…【广域乱射】<br>[攻击前]：…<br>[攻击时]：…"
 * @param {string} text
 * @returns {string}
 */
export function richTextFromCsv(text = "") {
  const raw = String(text).replace(/\r\n?/g, "\n").trim();
  if (!raw) return "";

  let lines;
  if (raw.includes("\n")) {
    lines = raw.split("\n");
  } else {
    // 在 “[xxx]：” 这种触发时机标记前断行（行首那个不断）
    lines = raw
      .replace(/\s*(?=[\[［][^\[\]［］]{1,12}[\]］][：:])/g, "\n")
      .split("\n");
  }

  return lines.map(l => l.trim()).filter(Boolean).join("<br>");
}

// ═══════════════════════════════════════════════════════════════════════════
//  虚拟列解析（一列写多个字段 / 需要拆分的写法）
// ═══════════════════════════════════════════════════════════════════════════

/** "-" 与空串在表里都表示"没有"，统一按空处理 */
const isBlank = (t) => t === "" || t === "-" || t === "—" || t === "/";

/**
 * 「完成」列的真值判定 —— 反向白名单。
 * 只有这些写法（大小写、全半角都认）算「未完成」：
 *   空 / - / — / / / 否 / 假 / 未 / 未完成 / 没有 / no / n / false / f / 0 / x / × / ✗ / ✘
 * 其余任何非空内容（TRUE、是、√、已导入、日期、备注…）一律视为已完成，整行跳过。
 * 这样写是因为表格里这一列的写法五花八门，漏判会导致重复导入。
 */
const DONE_FALSE = new Set([
  "否", "假", "未", "未完成", "没有", "no", "n", "false", "f", "0", "x", "×", "✗", "✘",
]);
function isDoneMark(text) {
  const t = String(text ?? "").trim();
  if (isBlank(t)) return false;
  return !DONE_FALSE.has(t.toLowerCase());
}

/**
 * 【分类】列。
 * - 攻击类技能：斩击 / 打击 / 突刺
 * - 守备类技能：闪避 / 格挡 / 反击-打击 / 可拼点反击-斩击
 *   连字符后面是反击伤害类型，拆成 category + counterType 两个字段。
 * - 其余物品（消耗品/材料/容器/装备）：自由文本，原样写入。
 */
function parseCategory(text, itemType) {
  if (isBlank(text)) return {};
  if (itemType !== "skill") return { "system.category": text };

  const [head, tail] = text.split(/[-－—]/).map(t => (t ?? "").trim());
  const def = DEFENSE_CATS[head];
  if (def) {
    const out = { "system.category": def };
    if (tail && ATTACK_CATS[tail]) out["system.counterType"] = ATTACK_CATS[tail];
    return out;
  }
  const atk = ATTACK_CATS[head];
  return atk ? { "system.category": atk } : { "system.category": text };
}

/**
 * 【骰数】列："1D4+2" / "1d10" / "20-1D8"（负面骰）/ "-" 空
 * → diceCount / diceFaces / baseValue / negativeDice
 * 正负面骰自动识别，不需要额外开一列。
 */
function parseDice(text) {
  if (isBlank(text)) return { "system.diceCount": 0 };

  // 负面骰：基础值在前、骰作为减项（骰数省略视为 1）
  const neg = /^\s*(\d+)\s*-\s*(\d*)\s*[dD]\s*(\d+)\s*$/.exec(text);
  if (neg) {
    return {
      "system.diceCount":    neg[2] === "" ? 1 : Number(neg[2]),
      "system.diceFaces":    Number(neg[3]),
      "system.baseValue":    Number(neg[1]),
      "system.negativeDice": true,
    };
  }

  const m = /^\s*(\d*)\s*[dD]\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/.exec(text);
  if (!m) {
    // 没有骰子、只有一个数字时视为纯基础值
    const n = Number(text);
    if (!Number.isNaN(n)) return { "system.diceCount": 0, "system.baseValue": Math.round(n) };
    return { __error: `骰数「${text}」无法解析（应形如 1D4、1D4+2，或负面骰 20-1D8）` };
  }
  const [, count, faces, sign, bonus] = m;
  const base = bonus ? (sign === "-" ? -Number(bonus) : Number(bonus)) : 0;
  return {
    "system.diceCount":    count === "" ? 1 : Number(count),
    "system.diceFaces":    Number(faces),
    "system.baseValue":    Math.max(0, base),
    "system.negativeDice": false,
  };
}

/** 【容量】/【内部数量】列："2x3" → { w:2, h:3 } */
function parseWxH(text) {
  if (isBlank(text)) return null;
  const m = /^\s*(\d+)\s*[xX×*]\s*(\d+)\s*$/.exec(text);
  if (!m) return { __error: `「${text}」无法解析（应形如 2x3）` };
  return { w: Number(m[1]), h: Number(m[2]) };
}

/** 【抗性】/【弱性】列："打" / "斩 突" → { resistanceAdj.blunt: "x0.5", … } */
function parsePhysList(text, mult) {
  if (isBlank(text)) return {};
  const SHORT = { "斩": "slash", "打": "blunt", "突": "pierce", "刺": "pierce" };
  const out = {};
  for (const part of text.split(/[\/,，、\s]+/).map(t => t.trim()).filter(Boolean)) {
    const key = SHORT[part] ?? ATTACK_CATS[part];
    if (key) out[`system.resistanceAdj.${key}`] = mult;
  }
  return out;
}

/** EGO 等级评级 */
const EGO_GRADES = ["ZAYIN", "TET", "HE", "WAW", "ALEPH"];

/**
 * 【等级】列：基础/守备技能是数字等级；EGO 技能填的是评级（HE / WAW…），
 * 同一列两种含义，按内容判断落到 level 还是 egoDiceRating。
 */
function parseLevel(text) {
  if (isBlank(text)) return {};
  const upper = text.toUpperCase().replace(/[.\s]/g, "");
  if (EGO_GRADES.includes(upper)) return { "system.egoDiceRating": upper };
  const n = Number(text);
  if (Number.isNaN(n)) return { __error: `等级「${text}」无法解析（数字或 ZAYIN/TET/HE/WAW/ALEPH）` };
  return { "system.level": Math.round(n) };
}

/** 罪孽名的匹配用正则片段（按长度倒序，避免短名先匹配掉） */
function sinNamePattern() {
  return Object.keys(VALUE_ALIASES["system.sinType"])
    .sort((a, b) => b.length - a.length).join("|");
}

/**
 * 【罪孽资源消耗】列："暴怒2，怠惰2，傲慢4"，也允许不写分隔符连着排。
 * 一律用扫描式匹配，分隔符（/ , ，、空格）有没有都不影响。
 */
function parseSinCost(text) {
  if (isBlank(text)) return {};
  const sins = VALUE_ALIASES["system.sinType"];
  const re   = new RegExp(`(${sinNamePattern()})\\s*(\\d+)`, "g");
  const list = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    list.push({ sinType: sins[m[1]], amount: Number(m[2]) });
  }
  if (!list.length) return { __error: `罪孽资源消耗「${text}」无法解析（应形如 暴怒2，怠惰2）` };
  return { "system.sinCost": list };
}

/**
 * 【容量扩散】列："[链式扩散3]" / "广域乱射2" / "链式扩散 3"
 * 方括号、空格可有可无；数字是扩散范围（格），省略时按 1 格算。
 */
function parseSpread(text) {
  if (isBlank(text)) return {};
  const m = /(链式扩散|链式|广域乱射|乱射)\s*(\d+)?/.exec(String(text));
  if (!m) return { __error: `容量扩散「${text}」无法解析（应形如 [链式扩散3] 或 广域乱射2）` };
  const mode  = m[1].includes("乱射") ? "spray" : "chain";
  const range = Math.min(6, Math.max(1, Number(m[2] ?? 1)));
  return { "system.spreadMode": mode, "system.spreadRange": range };
}

/**
 * 【攻击范围】列（仅武器）。绝大多数武器都是近战，所以只留一列：
 *   留空      → 近战 1 格（默认）
 *   "2"       → 近战 2 格（长矛、锁链这类）
 *   "远程6"   → 远程 6 格
 *   "远程"    → 远程 1 格
 */
function parseRange(text) {
  if (isBlank(String(text ?? "").trim())) return {};
  const raw    = String(text).trim();
  const ranged = /远程|远距|ranged/i.test(raw);
  const m      = /(\d+)/.exec(raw);
  const n      = m ? Math.max(0, Number(m[1])) : 1;
  return {
    "system.rangeType": ranged ? "ranged" : "melee",
    "system.range":     n,
  };
}

/**
 * 【抗性修改】列："暴怒x0.5傲慢x0.5怠惰x2.0嫉妒x2.0"
 * 实际表里是不带分隔符连写的，同样用扫描式匹配。
 */
function parseEgoRes(text) {
  if (isBlank(text)) return {};
  const sins = VALUE_ALIASES["system.sinType"];
  const re   = new RegExp(`(${sinNamePattern()})\\s*[xX×]\\s*([\\d.]+)`, "g");
  const list = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    list.push({ sinType: sins[m[1]], multiplier: `x${Number(m[2]).toFixed(1)}` });
  }
  if (!list.length) return { __error: `抗性修改「${text}」无法解析（应形如 暴怒x0.5傲慢x2.0）` };
  return { "system.egoResistanceAdj": list };
}

/**
 * 解析一个虚拟列，返回 { 路径: 值 } 映射或 { __error }。
 */
function parseVirtualColumn(marker, text, itemType) {
  switch (marker) {
    case V_CATEGORY: return parseCategory(text, itemType);
    case V_DICE:     return parseDice(text);
    case V_LEVEL:    return parseLevel(text);
    case V_RESIST:   return parsePhysList(text, RESIST_MULT);
    case V_WEAK:     return parsePhysList(text, WEAK_MULT);
    case V_SIN_COST: return parseSinCost(text);
    case V_SPREAD:   return parseSpread(text);
    case V_RANGE:    return parseRange(text);
    case V_EGO_RES:  return parseEgoRes(text);
    case V_CAPACITY: {
      const r = parseWxH(text);
      if (!r) return {};
      if (r.__error) return r;
      return { "system.capacity.w": r.w, "system.capacity.h": r.h };
    }
    case V_GRID: {
      const r = parseWxH(text);
      if (!r) return {};
      if (r.__error) return r;
      return { "system.gridSize.width": r.w, "system.gridSize.height": r.h };
    }
    default: return {};
  }
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
  const typeIdx = paths.indexOf("type");
  const doneIdx = paths.indexOf(V_DONE);
  let   skipped = 0;                     // 因「完成」而跳过的行数

  for (let r = 1; r < rows.length; r++) {
    const row    = rows[r];
    const lineNo = r + 1;

    // ── 「完成」列为真 → 整行跳过 ────────────────────────────────────────
    // 放在最前面：已完成的行不参与类型判定，也不逐列解析，
    // 因此这行即便有解析不了的内容也不会报错。
    if (doneIdx >= 0 && isDoneMark(row[doneIdx])) { skipped++; continue; }

    // ── 先定类型：中文写法（基础技能 / 上装 / 消耗品…）映射到物品类型，
    //    并带出随类型固定的字段（技能的 system.type、装备的 system.subtype）──
    let itemType = defaultType;
    let typeExtra = {};
    if (typeIdx >= 0) {
      const t = String(row[typeIdx] ?? "").trim();
      if (t) {
        const mapped = TYPE_ALIASES[t] ?? TYPE_ALIASES[t.toUpperCase()];
        if (mapped) { itemType = mapped.type; typeExtra = mapped.extra; }
        else        { itemType = t; }
      }
    }
    if (validTypes.length && !validTypes.includes(itemType)) {
      errors.push(`第 ${lineNo} 行：未知类型「${itemType}」`);
      continue;
    }

    const data = { type: itemType, system: {} };
    for (const [path, value] of Object.entries(typeExtra)) {
      foundry.utils.setProperty(data, path, value);
    }
    let rowFailed = false;

    for (let c = 0; c < paths.length; c++) {
      const marker = paths[c];
      if (!marker || marker === "type" || marker === IGNORE) continue;

      const raw  = row[c];
      if (raw === undefined) continue;
      const text = String(raw).trim();

      // ── 虚拟列：一列拆成多个字段 ──────────────────────────────────────
      if (marker.startsWith("__")) {
        const res = parseVirtualColumn(marker, text, itemType);
        if (res.__error) {
          errors.push(`第 ${lineNo} 行 · 列「${headerRow[c]}」：${res.__error}`);
          rowFailed = true;
          continue;
        }
        for (const [path, value] of Object.entries(res)) {
          foundry.utils.setProperty(data, path, value);
        }
        continue;
      }

      const path = adjustPathForType(marker, itemType);
      // 空单元格：跳过，保留 schema 默认值（"-" 同样视为留空）
      if (isBlank(text) && path !== "name") continue;

      const res = coerceValue(path, text, itemType);
      if (res.error) {
        errors.push(`第 ${lineNo} 行 · 列「${headerRow[c]}」：${res.error}`);
        rowFailed = true;
        continue;
      }
      // schema 里没有这个字段：跳过而不是硬写。
      // 三种布局共用一张表时（材料/消耗品/容器同表），必然有些列对某些类型不适用，
      // 硬写会往 system 里塞进 "FALSE" 这类无意义字符串。
      if (res.unknown) {
        const key = `${itemType}|${path}`;
        if (!unknownReported.has(key)) {
          unknownReported.add(key);
          warnings.push(`列「${headerRow[c]}」对「${itemType}」不适用，已跳过。`);
        }
        continue;
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

  if (skipped > 0) {
    warnings.push(`「完成」列已标记的 ${skipped} 行已跳过，未导入。`);
  }

  return { items: mergeTrainLevels(items, warnings), errors, warnings };
}

/**
 * 把「同名 + 填了训练等级」的几行技能合并成**同一张卡**的多阶数值。
 *
 * 规则书里 Ⅲ→Ⅳ→Ⅴ 是同一个技能被练上去，不是三张不同的卡；因此走和
 * E.G.O【觉醒/侵蚀】一样的做法：最低的一阶留在顶层字段（trainBaseLevel），
 * 更高的几阶写进 system.trainForms.lvN。
 *
 * 留空的单元格不会写进 form —— 于是"没填的字段自动沿用低阶"这件事天然成立，
 * 表里只需要填 Ⅳ 阶真正变了的那几列。
 *
 * @param {object[]} items    解析出来的物品数据
 * @param {string[]} warnings 合并情况写回这里给导入面板显示
 * @returns {object[]} 合并后的物品数据
 */
export function mergeTrainLevels(items, warnings = []) {
  // 只有明确填了训练等级的技能行才参与合并；没填的保持原样各是各的卡。
  // 名称 / 类型 / 分类 / 罪孽 / 等级 / 标签 跨阶共用，一律取最低那一阶的，
  // 高阶行里就算填了也不会生效（在这里被丢掉）。
  const OVERRIDABLE = ["baseValue", "diceCount", "diceFaces", "negativeDice",
                       "diceType", "counterType", "weight", "spreadMode", "spreadRange",
                       "indiscriminate", "noEquip", "coverDefense", "noClash",
                       "sanityCost", "stellarCost", "weaponRestriction",
                       "effectDesc", "activities"];
  const SHARED_LABELS = { name: "名称", type: "类型", category: "分类",
                          sinType: "罪孽", level: "等级", tags: "标签" };

  const groups = new Map();                       // 名称 → 行下标数组
  items.forEach((it, i) => {
    if (it?.type !== "skill") return;
    if (it.system?.trainLevel === undefined) return;
    const key = String(it.name ?? "").trim();
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });

  const dropped = new Set();
  for (const [name, idxs] of groups) {
    // 单独一行也要把 trainBaseLevel 对齐，否则徽章会以为它是 Ⅲ 阶
    if (idxs.length === 1) {
      const only = items[idxs[0]];
      only.system.trainBaseLevel = only.system.trainLevel;
      continue;
    }

    // 同名的几行必须是同一种技能（基础/守备/EGO），否则不合并
    const kinds = new Set(idxs.map(i => items[i].system?.type ?? "basic"));
    if (kinds.size > 1) {
      warnings.push(`「${name}」同名但技能类型不一致（${[...kinds].join(" / ")}），未合并训练等级。`);
      continue;
    }
    // E.G.O 用的是【觉醒/侵蚀】，不参与训练等级
    if (kinds.has("ego")) {
      warnings.push(`「${name}」是 E.G.O，训练等级不适用（E.G.O 用觉醒/侵蚀形态），未合并。`);
      continue;
    }

    const sorted = [...idxs].sort((a, b) => items[a].system.trainLevel - items[b].system.trainLevel);
    const base   = items[sorted[0]];
    base.system.trainBaseLevel = base.system.trainLevel;

    const seen = new Set([base.system.trainLevel]);
    for (const i of sorted.slice(1)) {
      const row = items[i];
      const lv  = row.system.trainLevel;
      if (seen.has(lv)) {
        warnings.push(`「${name}」有两行都填了训练等级 ${lv}，后一行已忽略。`);
        dropped.add(i);
        continue;
      }
      seen.add(lv);

      // 高阶行里填了跨阶共用的列 → 提醒一声它不会生效，免得表填了半天没反应
      const ignored = [];
      for (const [k, label] of Object.entries(SHARED_LABELS)) {
        if (k === "name") continue;                       // 同名才会走到这里
        const rv = row.system[k];
        if (rv === undefined) continue;
        const bv = base.system[k];
        const same = Array.isArray(rv) && Array.isArray(bv)
          ? rv.join("/") === bv.join("/") : rv === bv;
        if (!same) ignored.push(label);
      }
      if (ignored.length) {
        warnings.push(`「${name}」训练等级 ${lv} 那一行填的「${ignored.join("、")}」不会生效`
          + `——这几项跨阶共用，一律取最低阶那一行的值。`);
      }

      // 只搬这一行真的填了的字段；没填的留 null = 沿用低阶
      const form = { initialized: true };
      for (const k of OVERRIDABLE) {
        if (row.system[k] !== undefined) form[k] = row.system[k];
      }
      foundry.utils.setProperty(base, `system.trainForms.lv${lv}`, form);
      dropped.add(i);
    }

    // 导入后默认停在最低那一阶，跟角色实际练度对齐由玩家自己点徽章切
    base.system.trainLevel = base.system.trainBaseLevel;
    warnings.push(`「${name}」的 ${seen.size} 个训练等级（${[...seen].sort().join(" / ")}）已合并为同一张卡。`);
  }

  return items.filter((_, i) => !dropped.has(i));
}

// ═══════════════════════════════════════════════════════════════════════════
//  模板 CSV 生成
// ═══════════════════════════════════════════════════════════════════════════

/** 各类型的模板列（与实际编辑用的表格布局一致；「图标/区域N」为表格自用，导入时忽略；
    「完成」列填真值时整行跳过，见 isDoneMark） */
const TEMPLATE_COLUMNS = {
  equipment:  ["完成", "名称", "类型", "攻击等级", "防御等级", "速度",
               "抗性", "弱性", "分类", "稀有度", "星芒", "容量", "标签", "效果",
               "价格", "攻击范围"],
  skill:      ["名称", "类型", "分类", "罪孽", "等级", "训练等级", "骰数",
               "攻击容量", "容量扩散", "骰子类型", "无法装备", "无法拼点", "援护防御",
               "无差别攻击", "标签", "效果", "理智消耗", "罪孽资源消耗", "抗性修改"],
  consumable: ["图标", "完成", "名称", "类型", "分类", "稀有度", "可复用", "无限耐久",
               "可堆叠", "数量", "容量", "标签", "效果", "价格",
               "内部数量", "允许类型", "允许分类"],
  container:  ["图标", "完成", "名称", "类型", "分类", "稀有度", "可复用", "无限耐久",
               "可堆叠", "数量", "容量", "标签", "效果", "价格",
               "内部数量", "允许类型", "允许分类"],
  material:   ["图标", "完成", "名称", "类型", "分类", "稀有度", "可复用", "无限耐久",
               "可堆叠", "数量", "容量", "标签", "效果", "价格",
               "内部数量", "允许类型", "允许分类"],
  skillbook:  ["图标", "完成", "名称", "类型", "分类", "标签", "效果", "价格", "容量"],
  recipebook: ["图标", "完成", "名称", "类型", "分类", "标签", "效果", "价格", "容量"],
  panic:      ["图标", "完成", "名称", "类型", "标签", "效果"],
  background: ["图标", "完成", "名称", "类型", "副标题", "分类", "标签", "简介"],
};

/** 模板示例行：给出各类型最典型的一条，照着改即可 */
const TEMPLATE_EXAMPLE = {
  equipment:  { "名称": "中指-怨恨纹身", "类型": "上装", "防御等级": "4", "抗性": "打",
                "弱性": "突", "分类": "西服-纹身", "稀有度": "平装", "星芒": "1", "容量": "2x3",
                "标签": "手指/中指", "价格": "240" },
  skill:      { "名称": "七发魔弹", "类型": "E.G.O", "分类": "突刺", "罪孽": "傲慢",
                "等级": "HE", "骰数": "1D2", "攻击容量": "1", "容量扩散": "", "骰子类型": "不可摧毁",
                "标签": "E.G.O装备/脑叶公司", "理智消耗": "10",
                "罪孽资源消耗": "暴怒2，怠惰2，傲慢4",
                "抗性修改": "暴怒x0.5傲慢x0.5怠惰x2.0嫉妒x2.0" },
  consumable: { "名称": "紧急恢复针剂", "类型": "消耗品", "分类": "医疗", "稀有度": "平装",
                "可复用": "FALSE", "无限耐久": "FALSE", "可堆叠": "TRUE", "数量": "1",
                "容量": "1x1", "价格": "30" },
  container:  { "名称": "小型木箱", "类型": "容器", "分类": "建筑", "稀有度": "平装",
                "可堆叠": "FALSE", "数量": "1", "容量": "3x2", "内部数量": "4x8",
                "允许类型": "", "允许分类": "" },
  material:   { "名称": "绳索", "类型": "材料", "分类": "建材", "稀有度": "平装",
                "可堆叠": "TRUE", "数量": "1", "容量": "1x1" },
  background: { "名称": "中指", "类型": "背景", "副标题": "中指-长兄", "分类": "帮派",
                "标签": "中指/手指", "简介": "永不遗忘。中指的核心理念就是记仇。" },
};

/**
 * 生成某物品类型的模板 CSV 文本（含 BOM，Excel 直接双击不乱码）。
 * @param {string} itemType
 * @returns {string}
 */
export function buildTemplateCSV(itemType) {
  const cols = TEMPLATE_COLUMNS[itemType] ?? ["名称", "类型", "分类", "标签", "效果"];
  const sample = TEMPLATE_EXAMPLE[itemType] ?? { "名称": "示例物品" };
  const esc = (v) => {
    const t = String(v ?? "");
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const example = cols.map(c => esc(sample[c] ?? ""));
  return "﻿" + [cols.join(","), example.join(",")].join("\r\n") + "\r\n";
}

/** 各列的填写说明（对照表用） */
const COLUMN_NOTES = {
  "类型":     "决定物品类型：基础技能/守备技能/E.G.O/上装/下装/武器/饰品/消耗品/材料/容器",
  "分类":     "技能：斩击、打击、突刺；守备可写 反击-打击、可拼点反击-斩击；其余类型为自由文本",
  "等级":     "基础/守备填数字；E.G.O 填 ZAYIN/TET/HE/WAW/ALEPH",
  "骰数":     "形如 1D4、1D4+2；负面骰写成 20-1D8（基础值在前）；留空或 - 表示无",
  "骰类型":   "留空=一般骰子；可填 不可摧毁 / 斩断",
  "骰子类型": "留空=一般骰子；可填 不可摧毁 / 斩断",
  "抗性":     "斩/打/突，记 x0.5，可多写",
  "弱性":     "斩/打/突，记 x2.0，可多写",
  "容量":     "形如 2x3（背包占格）",
  "内部数量": "形如 4x8（容器内部网格）",
  "标签":     "用 / 或 、分隔",
  "罪孽资源消耗": "形如 暴怒2，怠惰2，傲慢4（分隔符可省）",
  "抗性修改": "形如 暴怒x0.5傲慢x0.5怠惰x2.0（分隔符可省）",
  "容量扩散": "攻击容量≥2 时生效，形如 [链式扩散3] / 广域乱射2，数字为范围格数（留空=链式1格）",
  "无法装备": "填 是/否、TRUE/FALSE",
  "援护防御": "填 是/否、TRUE/FALSE；标记为【援护防御】专属技能",
  "训练等级": "填 Ⅲ/Ⅳ/Ⅴ（或 3/4/5、默认/精通/强化）。同名的几行会合并成同一张卡的多阶，留空的格子沿用低一阶。名称/类型/分类/罪孽/等级/标签跨阶共用（取最低阶那行），其余逐阶各一套；E.G.O 不适用",
  "无法拼点": "填 是/否、TRUE/FALSE；被锁定的目标只能【承受】，不能对抗",
  "攻击范围": "仅武器：留空=近战1格；填数字=近战N格（长矛/锁链）；填「远程6」=远程6格",
  "允许类型": "容器存放限制·类型，多个用 / 分隔（消耗品/材料），留空=不限制",
  "允许分类": "容器存放限制·分类，多个用 / 分隔（医疗/食材），与类型同时满足才收",
  "无差别攻击": "填 是/否、TRUE/FALSE；容量扩散时敌我不分，范围内的友方也会被打到（自己除外）",
  "稀有度":   "平装 / 精良 / 史诗 / 艺术 / 神话（也认 白蓝紫金红）；留空=平装",
  "可堆叠":   "填 是/否、TRUE/FALSE；同名物品能否叠成一格",
  "数量":     "整数，留空=1",
  "可复用":   "填 是/否、TRUE/FALSE",
  "无限耐久": "填 是/否、TRUE/FALSE",
  "图标":     "表格自用，导入时忽略",
  "完成":     "填 是/TRUE/√ 等真值时**整行跳过**，用来避免重复导入已完成的条目；留空则正常导入",
  "完成":     "表格自用，导入时忽略",
};

/**
 * 列出某物品类型的模板列与填写说明（供对照表展示）。
 * @param {string} itemType
 * @returns {{ header:string, note:string }[]}
 */
export function listAvailableColumns(itemType) {
  const cols = TEMPLATE_COLUMNS[itemType] ?? ["名称", "类型", "分类", "标签", "效果"];
  return cols.map(header => ({ header, note: COLUMN_NOTES[header] ?? "" }));
}
