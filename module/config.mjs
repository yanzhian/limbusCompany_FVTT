/**
 * config.mjs — 边狱巴士都市规则常量配置
 * 所有全局常量均挂载到 CONFIG.LIMBUSCOMPANY
 */

export const LIMBUSCOMPANY = {};

// ─── 七宗罪 ───────────────────────────────────────────────────────────────────

LIMBUSCOMPANY.SINS = ["wrath", "lust", "sloth", "gluttony", "gloom", "pride", "envy"];

LIMBUSCOMPANY.SIN_LABELS = {
  wrath:    "LIMBUSCOMPANY.Sin.Wrath",
  lust:     "LIMBUSCOMPANY.Sin.Lust",
  sloth:    "LIMBUSCOMPANY.Sin.Sloth",
  gluttony: "LIMBUSCOMPANY.Sin.Gluttony",
  gloom:    "LIMBUSCOMPANY.Sin.Gloom",
  pride:    "LIMBUSCOMPANY.Sin.Pride",
  envy:     "LIMBUSCOMPANY.Sin.Envy",
};

/** 七宗罪中文名（直接使用，不依赖 i18n 时序） */
LIMBUSCOMPANY.SIN_LABELS_ZH = {
  wrath:    "暴怒",
  lust:     "色欲",
  sloth:    "怠惰",
  gluttony: "暴食",
  gloom:    "忧郁",
  pride:    "傲慢",
  envy:     "嫉妒",
};

/** 七宗罪图标路径 */
LIMBUSCOMPANY.SIN_ICON_PATHS = {
  wrath:    "systems/limbusCompany_FVTT/assets/icons/Base_icon/Wrath_icon.webp",
  lust:     "systems/limbusCompany_FVTT/assets/icons/Base_icon/Lust_icon.webp",
  sloth:    "systems/limbusCompany_FVTT/assets/icons/Base_icon/Sloth_icon.webp",
  gluttony: "systems/limbusCompany_FVTT/assets/icons/Base_icon/Gluttony_icon.webp",
  gloom:    "systems/limbusCompany_FVTT/assets/icons/Base_icon/Gloom_icon.webp",
  pride:    "systems/limbusCompany_FVTT/assets/icons/Base_icon/Pride_icon.webp",
  envy:     "systems/limbusCompany_FVTT/assets/icons/Base_icon/Envy_icon.webp",
};

/** 技能分类图标路径 */
LIMBUSCOMPANY.CATEGORY_ICON_PATHS = {
  slash:        "systems/limbusCompany_FVTT/assets/icons/Base_icon/slash.webp",
  blunt:        "systems/limbusCompany_FVTT/assets/icons/Base_icon/blunt.webp",
  pierce:       "systems/limbusCompany_FVTT/assets/icons/Base_icon/pierce.webp",
  dodge:        "systems/limbusCompany_FVTT/assets/icons/Base_icon/dodge.webp",
  block:        "systems/limbusCompany_FVTT/assets/icons/Base_icon/block.webp",
  counter:      "systems/limbusCompany_FVTT/assets/icons/Base_icon/counter.webp",
  clashBlock:   "systems/limbusCompany_FVTT/assets/icons/Base_icon/clash_block.webp",
  clashCounter: "systems/limbusCompany_FVTT/assets/icons/Base_icon/clash_counter.webp",
};

/** 七宗罪 UI 颜色（CSS hex） */
LIMBUSCOMPANY.SIN_COLORS = {
  wrath:    "#FD0001",
  lust:     "#FA6D07",
  sloth:    "#c9a110",
  gluttony: "#77b808",
  gloom:    "#0a94b3",
  pride:    "#074BD8",
  envy:     "#9503DA",
};

// ─── 物理伤害类型 ─────────────────────────────────────────────────────────────

LIMBUSCOMPANY.DAMAGE_TYPES = ["slash", "blunt", "pierce"];

LIMBUSCOMPANY.DAMAGE_TYPE_LABELS = {
  slash: "LIMBUSCOMPANY.DamageType.Slash",
  blunt: "LIMBUSCOMPANY.DamageType.Blunt",
  pierce: "LIMBUSCOMPANY.DamageType.Pierce",
};

// ─── EGO 等级 ─────────────────────────────────────────────────────────────────

LIMBUSCOMPANY.EGO_GRADES = ["ZAYIN", "TET", "HE", "WAW", "ALEPH"];

/** EGO 使用消耗的星芒 */
LIMBUSCOMPANY.EGO_COSTS = {
  ZAYIN: 1,
  TET:   3,
  HE:    5,
  WAW:   10,
  ALEPH: 15,
};

// ─── 普通技能星芒费用（按等级） ───────────────────────────────────────────────

LIMBUSCOMPANY.SKILL_COSTS = {
  1: 1,
  2: 5,
  3: 10,
};

// ─── 升级经验值需求表（索引 = 等级 - 1） ─────────────────────────────────────
// 共 50 条，覆盖 Lv1–50；Lv45 后每 5 级需求 ×1.5

LIMBUSCOMPANY.LEVEL_XP = [
  0, 10, 12, 15, 20, 27, 40, 59, 88, 125,
  168, 227, 298, 381, 482, 591, 728, 885, 1064, 1261,
  1488, 1739, 2014, 2327, 2674, 3047, 3456, 3899, 4378, 4899,
  5468, 6075, 6722, 7413, 6075, 6722, 7413, 8156, 8953, 7413,
  7413, 7143, 7413, 7413, 8156, 8156, 8156, 8156, 8156, 8953,
];

/**
 * 获取指定等级所需的经验值（支持 50 级以上的 ×1.5 规则）
 * @param {number} level
 * @returns {number}
 */
LIMBUSCOMPANY.getXpForLevel = function(level) {
  if (level <= 0) return 0;
  const table = LIMBUSCOMPANY.LEVEL_XP;
  if (level <= table.length) return table[level - 1];
  // 45 级之后，每 5 级 ×1.5
  const base = table[table.length - 1];
  const extraGroups = Math.floor((level - table.length) / 5) + 1;
  return Math.floor(base * Math.pow(1.5, extraGroups));
};

// ─── 六属性 ───────────────────────────────────────────────────────────────────

LIMBUSCOMPANY.ATTRIBUTES = ["str", "agi", "con", "int", "per", "cha"];

LIMBUSCOMPANY.ATTRIBUTE_LABELS = {
  str: "LIMBUSCOMPANY.Attribute.Str",
  agi: "LIMBUSCOMPANY.Attribute.Agi",
  con: "LIMBUSCOMPANY.Attribute.Con",
  int: "LIMBUSCOMPANY.Attribute.Int",
  per: "LIMBUSCOMPANY.Attribute.Per",
  cha: "LIMBUSCOMPANY.Attribute.Cha",
};

// ─── 抗性倍率选项 ─────────────────────────────────────────────────────────────

LIMBUSCOMPANY.RESISTANCE_VALUES = ["x0.5", "x1.0", "x2.0", "x2.5", "x3.0"];

// ─── BUFF / DEBUFF 类型 ───────────────────────────────────────────────────────

LIMBUSCOMPANY.BUFF_TYPES = {
  // 增益
  strong:          "LIMBUSCOMPANY.Buff.Strong",
  endure:          "LIMBUSCOMPANY.Buff.Endure",
  swift:           "LIMBUSCOMPANY.Buff.Swift",
  guard:           "LIMBUSCOMPANY.Buff.Guard",
  clashPowerUp:    "LIMBUSCOMPANY.Buff.ClashPowerUp",
  atkLevelUp:      "LIMBUSCOMPANY.Buff.AtkLevelUp",
  defLevelUp:      "LIMBUSCOMPANY.Buff.DefLevelUp",
  coverDefense:    "援护防御",
  // 减益
  weak:            "LIMBUSCOMPANY.Buff.Weak",
  breach:          "LIMBUSCOMPANY.Buff.Breach",
  bind:            "LIMBUSCOMPANY.Buff.Bind",
  fragile:         "LIMBUSCOMPANY.Buff.Fragile",
  clashPowerDown:  "LIMBUSCOMPANY.Buff.ClashPowerDown",
  atkLevelDown:    "LIMBUSCOMPANY.Buff.AtkLevelDown",
  defLevelDown:    "LIMBUSCOMPANY.Buff.DefLevelDown",
  // 特殊
  burn:            "LIMBUSCOMPANY.Buff.Burn",
  bleed:           "LIMBUSCOMPANY.Buff.Bleed",
  tremor:          "LIMBUSCOMPANY.Buff.Tremor",
  rupture:         "LIMBUSCOMPANY.Buff.Rupture",
  sinking:         "LIMBUSCOMPANY.Buff.Sinking",
  breathing:       "LIMBUSCOMPANY.Buff.Breathing",
  charge:          "LIMBUSCOMPANY.Buff.Charge",
  chaos:           "LIMBUSCOMPANY.Buff.Chaos",
  panic:           "LIMBUSCOMPANY.Buff.Panic",
  lowMorale:       "士气低落",
  // 自定义
  custom:          "LIMBUSCOMPANY.Buff.Custom",
  // 注册自定义 BUFF（与 custom-buffs.mjs 中的 type 对应）
  defensiveStance: "防御姿态",
  butterfly:       "蝶",
  piercingArrow:   "刺入之矢",
  // 花札三色 + 光札（定事务所）
  craneOnPine:     "松上鹤",
  moonOnSusuki:    "芒上月",
  indigoSakura:    "青染樱",
  lightCard:       "光札",
};

/** 分组，用于 BUFF 下拉菜单 */
LIMBUSCOMPANY.BUFF_GROUPS = {
  positive: ["strong", "endure", "swift", "guard", "clashPowerUp", "atkLevelUp", "defLevelUp", "coverDefense"],
  negative: ["weak", "breach", "bind", "fragile", "clashPowerDown", "atkLevelDown", "defLevelDown"],
  special:  ["burn", "bleed", "tremor", "rupture", "sinking", "breathing", "charge", "chaos", "panic", "lowMorale"],
  other:    ["custom"],
  custom:   ["defensiveStance", "butterfly", "piercingArrow",
             "craneOnPine", "moonOnSusuki", "indigoSakura", "lightCard"],
};

/**
 * 标准 BUFF 的说明文字（供物品描述里的【BUFF】悬停 Title 卡展示）。
 * 自定义注册 BUFF（custom-buffs.mjs）优先使用其自身的 description 字段，
 * 这里只覆盖内置的标准/特殊 BUFF。
 */
LIMBUSCOMPANY.BUFF_DESCRIPTIONS = {
  strong:         "拼点骰数：每层 +1 骰",
  weak:           "拼点骰数：每层 -1 骰",
  endure:         "作为防御方拼点时，骰数：每层 +1 骰",
  breach:         "作为防御方拼点时，骰数：每层 -1 骰",
  swift:          "速度骰结果：每层 +1",
  bind:           "速度骰结果：每层 -1",
  guard:          "拼点落败/直接承受伤害时：每层减少 1 点受到的伤害",
  fragile:        "拼点落败/直接承受伤害时：每层增加 1 点受到的伤害",
  clashPowerUp:   "拼点威力修正值：每层 +1",
  clashPowerDown: "拼点威力修正值：每层 -1",
  atkLevelUp:     "攻击等级：每层 +1",
  atkLevelDown:   "攻击等级：每层 -1",
  defLevelUp:     "防御等级：每层 +1",
  defLevelDown:   "防御等级：每层 -1",
  coverDefense:   "友方被锁定为目标、且该友方行动值为 0 时：可消耗 1 层顶上去替他接下这次对抗\n"
                + "· 使用背包里标有【援护防御】的专属技能（不需装备），瞬移到攻击者身旁的空位\n"
                + "· 强制把攻击者的目标改为自己\n"
                + "· 不会自动消失，可跨回合累积，最多 3 层",
  burn:           "[回合结束时]：减少 1 层【烧伤】层数，受到【烧伤】强度的固定伤害",
  bleed:          "[攻击时]：减少 1 层【流血】层数，受到【流血】强度的固定伤害",
  tremor:         "受到【震颤引爆】攻击时：减少 1 层【震颤】层数，所有混乱阈值永久前移【震颤】强度百分比（直到长休重置）",
  rupture:        "[受到伤害时]：减少 1 层【破裂】层数，附加受到【破裂】强度的固定伤害",
  sinking:        "[受到伤害时]：减少 1 层【沉沦】层数，为目标造成【沉沦】强度等级的理智伤害；\n如果理智因此跌至下限 5，额外受到【沉沦】强度等级的【忧郁】罪孽伤害",
  breathing:      "[回合结束时]：减少 1 层【呼吸法】层数（无其他直接效果，供效果触发条件判定使用）",
  charge:         "[回合结束时]：减少 1 层【充能】层数（最大 20 层，供效果触发条件判定使用）",
  chaos:          "陷入混乱：拼点骰数 ×2.0（数值随触发阈值条数升级为 混乱+/混乱++，倍率相应提升），回合结束自动移除",
  panic:          "陷入恐慌：无法使用基础及守备技能，E.G.O 不消耗理智但罪孽资源消耗 ×1.5，回合结束自动移除",
  lowMorale:      "士气低落：理智 ≤30 时触发（一场遭遇战仅生效一次）",
};

/**
 * 回合结束时自动清除的 BUFF 类型（本回合生效，下回合转为本回合生效）。
 * 包含所有增益/减益（强壮/虚弱/忍耐/破绽/迅捷/束缚/守护/易损/拼点威力/攻防等级）
 * 以及陷入混乱/陷入恐慌三种混乱状态。
 */
LIMBUSCOMPANY.TURN_END_BUFF_TYPES = new Set([
  "strong", "weak",
  "endure", "breach",
  "swift",  "bind",
  "guard",  "fragile",
  "clashPowerUp",  "clashPowerDown",
  "atkLevelUp",    "atkLevelDown",
  "defLevelUp",    "defLevelDown",
  "chaos", "chaos_plus", "chaos_double_plus",
  "panic",
  // 士气低落不再作为 BUFF 添加（不出现在状态栏），此处无需再列入清除名单
]);

// ─── 技能类型 ─────────────────────────────────────────────────────────────────

/**
 * 陷入混乱的三个等级（由低到高）与其显示名。
 */
LIMBUSCOMPANY.CHAOS_TYPES = ["chaos", "chaos_plus", "chaos_double_plus"];
LIMBUSCOMPANY.CHAOS_NAMES = ["陷入混乱", "陷入混乱+", "陷入混乱++"];

/**
 * 陷入混乱持续「本回合 + 下回合」：本轮结束时不移除，而是把 whenAdded 改成
 * 这个标记（各处判定生效与否用的都是 `whenAdded !== "下回合"`，所以仍算生效中），
 * 下一轮结束时再真正移除。
 */
LIMBUSCOMPANY.CHAOS_EXTEND_TAG = "延续回合";

LIMBUSCOMPANY.SKILL_TYPES = {
  basic:   "LIMBUSCOMPANY.SkillType.Basic",
  defense: "LIMBUSCOMPANY.SkillType.Defense",
  ego:     "LIMBUSCOMPANY.SkillType.Ego",
};

/** 攻击分类（基础技能 / EGO 技能） */
LIMBUSCOMPANY.ATTACK_CATEGORIES = {
  slash:  "LIMBUSCOMPANY.Category.Slash",
  blunt:  "LIMBUSCOMPANY.Category.Blunt",
  pierce: "LIMBUSCOMPANY.Category.Pierce",
};

/** 守备分类 */
LIMBUSCOMPANY.DEFENSE_CATEGORIES = {
  dodge:         "LIMBUSCOMPANY.Category.Dodge",
  block:         "LIMBUSCOMPANY.Category.Block",
  counter:       "LIMBUSCOMPANY.Category.Counter",
  clashBlock:    "LIMBUSCOMPANY.Category.ClashBlock",
  clashCounter:  "LIMBUSCOMPANY.Category.ClashCounter",
};

/** 技能分类中文名（直接使用，不依赖 i18n 时序） */
LIMBUSCOMPANY.CATEGORY_LABELS_ZH = {
  slash:        "斩击",
  blunt:        "打击",
  pierce:       "突刺",
  dodge:        "闪避",
  block:        "格挡",
  counter:      "反击",
  clashBlock:   "可拼点格挡",
  clashCounter: "可拼点反击",
};

// ─── 装备子类型 ───────────────────────────────────────────────────────────────

LIMBUSCOMPANY.EQUIPMENT_SUBTYPES = {
  upper:    "LIMBUSCOMPANY.EquipSubtype.Upper",
  lower:    "LIMBUSCOMPANY.EquipSubtype.Lower",
  weapon:   "LIMBUSCOMPANY.EquipSubtype.Weapon",
  accessory:"LIMBUSCOMPANY.EquipSubtype.Accessory",
};

// ─── 效果触发时机 ─────────────────────────────────────────────────────────────

LIMBUSCOMPANY.ACTIVITY_TRIGGERS = [
  "使用时", "攻击前", "攻击时", "攻击后",
  "拼点时", "拼点成功", "拼点失败",
  "命中时", "暴击命中时",
  "回合开始时", "回合结束时", "受到伤害时",
  "反应", "丢弃时", "恐慌触发时", "坚定触发时",
];

// ─── 效果类型 ─────────────────────────────────────────────────────────────────

LIMBUSCOMPANY.ACTIVITY_EFFECTS = [
  "addBuff", "removeBuff",
  "hpAdj", "sanityAdj",
  "atkAdj", "defAdj", "speedAdj",
  "diceAdj", "seismicBlast",
  "relatedSkillConvert", "extraDamage",
  "fieldResource",
];

// ─── 骰子类型 ─────────────────────────────────────────────────────────────────

LIMBUSCOMPANY.DICE_TYPES = {
  normal:      "LIMBUSCOMPANY.DiceType.Normal",
  unbreakable: "LIMBUSCOMPANY.DiceType.Unbreakable",
  severing:    "LIMBUSCOMPANY.DiceType.Severing",
};

