export const LC = {};

// ── 六大属性 ──────────────────────────────────────────────────────────────
LC.attributes = {
  str: "LC.Attribute.str",
  agi: "LC.Attribute.agi",
  con: "LC.Attribute.con",
  int: "LC.Attribute.int",
  per: "LC.Attribute.per",
  cha: "LC.Attribute.cha",
};

// ── 七种罪孽（用于技能/装备/EGO的sin字段标签，以及公共资源池的键名）──────────
LC.sins = {
  wrath:    "LC.Sin.wrath",
  lust:     "LC.Sin.lust",
  sloth:    "LC.Sin.sloth",
  gluttony: "LC.Sin.gluttony",
  gloom:    "LC.Sin.gloom",
  pride:    "LC.Sin.pride",
  envy:     "LC.Sin.envy",
  none:     "LC.Sin.none",
};

// 公共罪孽资源池的默认值（世界级存储，见 limbusCompany.mjs 中的 game.settings）
LC.sinPoolDefault = {
  wrath: 0, lust: 0, sloth: 0, gluttony: 0, gloom: 0, pride: 0, envy: 0,
};

// ── 物理攻击/技能分类 ──────────────────────────────────────────────────────
LC.attackTypes = {
  slash:  "LC.AttackType.slash",
  pierce: "LC.AttackType.pierce",
  blunt:  "LC.AttackType.blunt",
};

// ── 骰类 ──────────────────────────────────────────────────────────────────
LC.diceTypes = {
  normal:      "LC.DiceType.normal",
  unbreakable: "LC.DiceType.unbreakable",
  truncated:   "LC.DiceType.truncated",
};

// ── 物理/罪孽抗性等级 ─────────────────────────────────────────────────────
// multiplier: 实际伤害倍率
LC.resistanceLevels = {
  fatal:   { label: "LC.Resistance.fatal",   multiplier: 2.0  },
  fragile: { label: "LC.Resistance.fragile", multiplier: 1.5  },
  normal:  { label: "LC.Resistance.normal",  multiplier: 1.0  },
  endured: { label: "LC.Resistance.endured", multiplier: 0.75 },
  resist:  { label: "LC.Resistance.resist",  multiplier: 0.5  },
};

// 抗性调整档位（上装/EGO 的 resistance_mod 字段可填 "none" 或具体等级）
// "none" 表示该装备不调整此项抗性
LC.resistanceMods = ["none", "fatal", "fragile", "normal", "endured", "resist"];

// 混乱状态下物理抗性强制下限
LC.chaosMimimumResistance = "fatal"; // ×2.0

// ── EGO 等级 ──────────────────────────────────────────────────────────────
LC.egoTiers = {
  ZAYIN: "LC.EgoTier.zayin",
  TETH:  "LC.EgoTier.teth",
  HE:    "LC.EgoTier.he",
  WAW:   "LC.EgoTier.waw",
  ALEPH: "LC.EgoTier.aleph",
};

// ── 守备技能类型 ──────────────────────────────────────────────────────────
LC.defenseTypes = {
  dodge:                 "LC.DefenseType.dodge",
  block:                 "LC.DefenseType.block",
  counter_slash:         "LC.DefenseType.counter_slash",
  counter_pierce:        "LC.DefenseType.counter_pierce",
  counter_blunt:         "LC.DefenseType.counter_blunt",
  parry:                 "LC.DefenseType.parry",
  parry_counter_slash:   "LC.DefenseType.parry_counter_slash",
  parry_counter_pierce:  "LC.DefenseType.parry_counter_pierce",
  parry_counter_blunt:   "LC.DefenseType.parry_counter_blunt",
};

// ── 技能等级 ──────────────────────────────────────────────────────────────
// 星芒消耗：Lv1=1, Lv2=5, Lv3=10；相关技能(related标签)=0
LC.skillLevels = { 1: 1, 2: 5, 3: 10 };

// ── 混乱阀值：数量 → 各阈值的HP百分比 ───────────────────────────────────
LC.chaosThresholdMap = {
  1: [0.50],
  2: [0.30, 0.60],
  3: [0.20, 0.50, 0.80],
};

// ── 鉴定硬币数对应的描述 ──────────────────────────────────────────────────
// 大纲原文：1币简单 2-4币中等 5-7币困难 8+币极难
LC.checkDifficultyLabel = (n) => {
  if (n <= 1) return "LC.CheckDifficulty.easy";
  if (n <= 4) return "LC.CheckDifficulty.medium";
  if (n <= 7) return "LC.CheckDifficulty.hard";
  return "LC.CheckDifficulty.veryHard";
};

// ── 势力类型 ─────────────────────────────────────────────────────────────
LC.factionTypes = {
  workshop:    "LC.FactionType.workshop",
  bureau:      "LC.FactionType.bureau",
  company:     "LC.FactionType.company",
  association: "LC.FactionType.association",
  gang:        "LC.FactionType.gang",
  outskirts:   "LC.FactionType.outskirts",
};

// ── 心与望选项（90级解锁）────────────────────────────────────────────────
LC.heartChoices = [
  { id: "offense_up",      label: "LC.HeartChoice.offense_up"  },  // 攻击等级+10
  { id: "chaos_reduce",    label: "LC.HeartChoice.chaos_reduce" },  // 混乱阀值-1
  { id: "defense_up",      label: "LC.HeartChoice.defense_up"  },  // 防御等级+10
];
LC.hopeChoices = [
  // 望的选项尚未在大纲中完整定义，预留
];
