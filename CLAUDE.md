# Limbus Company TRPG — FVTT 系统开发标准文档

> 本文件是 AI 助手的长期记忆和开发标准。所有设计以本文件为准，
> 规则若有更新需同步修改本文件。

---

## 一、项目基本信息

| 字段 | 值 |
|------|----|
| 系统 ID | `limbusCompany` |
| FVTT 版本 | v12（minimum: 12, verified: 12）|
| 主语言 | 中文（简体）`zh-cn` |
| 系统路径 | `d:\Users\A\AppData\Local\FoundryVTT\Data\systems\limbusCompany\` |
| 当前版本 | `0.1.0` |
| 规则来源 | `大纲.txt`（以此为权威，优先参考）|

---

## 二、文件结构

```
limbusCompany/
├── CLAUDE.md                           # 本文件（AI 记忆 & 开发标准）
├── system.json                         # 系统清单
├── template.json                       # Actor/Item 数据结构定义
├── limbusCompany.mjs                   # 主入口（Hook、Settings、Handlebars）
├── 大纲.txt                            # 规则设计原始文档（权威来源）
│
├── module/
│   ├── helpers/
│   │   └── config.mjs                  # 系统枚举常量（LC 对象）
│   └── documents/
│       ├── actor.mjs                   # LimbusActor：派生计算 + 骰子方法
│       └── item.mjs                    # LimbusItem：物品规则 + 判断方法
│
├── assets/icons/
│   ├── Base_icon/                      # 生命/理智/星芒/速度/攻防等级/7罪孽/货币
│   ├── Buff_icon/                      # 状态效果图标（流血/震颤等）
│   └── Skill/                          # 技能图标（7罪孽×3等级 + EGO + 无罪孽）
│
├── lang/
│   ├── zh-cn.json                      # 中文本地化（主语言）
│   └── en.json                         # 英文本地化
│
└── css/
    └── limbusCompany.css               # 样式（暗金色主题，暂不修改）

── 尚未创建（等规则稳定后再做）──────────────────────────────────────────
module/sheets/actor-sheet.mjs           # 角色卡 Sheet（待定）
module/sheets/item-sheet.mjs            # 物品 Sheet（待定）
templates/actor/                        # 角色卡 HBS 模板（待定）
templates/item/                         # 物品 HBS 模板（待定）
templates/chat/                         # 聊天卡片 HBS 模板（待定）
```

---

## 三、核心规则

### 3.1 Actor 类型

| 类型 | 说明 |
|------|------|
| `character` | 玩家角色（PL）：更换装备/技能/鉴定 |
| `npc` | NPC（无心与望、无背景势力系统）|

### 3.2 六大属性

属性范围：**最低 2，最高 10**。1级初始分配 **30点**，每 **10级** 获得 **1点** 额外属性。

| 键名 | 中文 | 主要作用 |
|------|------|---------|
| `str` | 力量 | 攻击等级基础值 |
| `agi` | 敏捷 | 先攻速度、混乱阀值数量 |
| `con` | 体质 | 防御等级基础值、混乱阀值数量 |
| `int` | 智力 | 罪孽相关、EGO 使用条件（待完善）|
| `per` | 感知 | 罪孽相关、EGO 使用条件（待完善）|
| `cha` | 魅力 | 罪孽相关、EGO 使用条件（待完善）|

**鉴定方式**：投出等于属性值的硬币数（1d2），正面（=2）算成功。
- 成功数 **≥** 难度 → 成功
- 成功数 **=** 难度 → 完美成功
- 难度参考：1枚=简单，2-4枚=中等，5-7枚=困难，8枚+=极难
- 装备或RP可以修正硬币数

### 3.3 派生数值

| 数值 | 公式 / 说明 |
|------|------------|
| **生命（HP）** | 等级 × d10 + 体质 × 5（长休恢复满值）|
| **理智（Sanity）** | 5-95，默认50；使用EGO或目睹不可名状之物变化；降至5→恐慌 |
| **星芒（Starling）** | 默认30；每升1级+1；解锁技能/装备消耗 |
| **货币（眼）** | 无固定上限 |
| **攻击等级** | 基础=力量 + 装备bonus + 心与望bonus |
| **防御等级** | 基础=体质 + 装备bonus + 心与望bonus |
| **速度** | 1d6 + 敏捷（每场战斗开始时骰，决定先攻）|

### 3.4 混乱阀值（chaos_thresholds）

- 默认 **2条**；体质>7 **减少1条**；敏捷>7 **增加1条**；范围 [1, 3]
- HP 跌至阀值时陷入混乱，清除该条，直到下次长休重置
- **混乱时物理抗性强制降至 [致命] ×2.0**
- 震颤引爆会临时增加混乱阀值条数

| 条数 | 阈值位置 |
|------|---------|
| 1条 | 50% |
| 2条 | 30% / 60% |
| 3条 | 20% / 50% / 80% |

### 3.5 罪孽资源（公共资源池）

**七种罪孽是世界级公共资源，不属于任何角色个人。**

- 任何人使用含罪孽的技能 → 对应罪孽 **+1** 进入公共池
- EGO 激活需从公共池扣除指定数量
- 存储方式：`game.settings`，键名 `"limbusCompany"."sinPool"`
- 操作方法（挂载于 `game.limbusCompany`）：
  - `getSinPool()` → 读取当前罪孽池对象
  - `adjustSin(sinKey, delta)` → 调整某罪孽数量
  - `resetSinPool()` → 长休时重置
  - `canActivateEgo(sinCost)` → 检查是否满足 EGO 激活条件

| 罪孽 | 键名 |
|------|------|
| 暴怒 | `wrath` |
| 色欲 | `lust` |
| 怠惰 | `sloth` |
| 暴食 | `gluttony` |
| 忧郁 | `gloom` |
| 傲慢 | `pride` |
| 嫉妒 | `envy` |

### 3.6 物理/罪孽抗性

| 等级 | 键名 | 倍率 |
|------|------|------|
| 致命 | `fatal` | ×2.0 |
| 脆弱 | `fragile` | ×1.5 |
| 一般 | `normal` | ×1.0 |
| 耐性 | `endured` | ×0.75 |
| 抵抗 | `resist` | ×0.5 |

- **物理抗性**（斩击/突刺/打击）：由**上装**装备决定；未装备上装时默认全部 `normal`
- **罪孽抗性**（7种罪孽）：由 **E.G.O** 装备决定
- `resistance_mod / sin_resistance_mod` 字段值 `"none"` 表示该项不调整

### 3.7 心与望（heart_and_hope）

- 解锁条件：等级达 **90级** 且突破信念
- 每满足一次条件可添加 **1层**，从以下选项选一个
- **心的选项**（已定义）：
  1. `offense_up` — 攻击等级 +10
  2. `chaos_reduce` — 减少一条混乱阀值
  3. `defense_up` — 防御等级 +10
- **望的选项**：尚未在大纲中定义，预留

---

## 四、物品系统

### 4.1 装备（9格，可自由放置）

| 类型 | 键名 | 限制 | 主要字段 |
|------|------|------|---------|
| 武器 | `weapon` | 无（可多持，战斗只用一个）| attack_type, offense_level_mod, defense_level_mod, links |
| 饰品 | `accessory` | 无 | offense_level_mod, defense_level_mod, links |
| 上装 | `upper_body` | **限1件** | defense_level_mod, resistance_mod（斩/突/打）|
| 下装 | `lower_body` | **限1件** | offense_level_mod, defense_level_mod |
| E.G.O | `ego` | **同等级限1件** | ego_tier, attack_type, dice配置, sin_cost, sin_resistance_mod |

**链接（links）**：装备可手动激活/关闭链接，链接处相邻装备满足条件时触发词条效果。
链接方向存储为数组，元素为 `"←"/"→"/"↑"/"↓"` 字符串。

**星芒（starling）**：装备和技能解锁消耗的点数（初始默认30）。

### 4.2 技能

技能分为**攻击技能**和**守备技能**，角色最多持有6个攻击技能槽+1个守备技能槽。

每回合抽取机制（尚未实现）：
- 从池中抽取2个 → 白框（可用）
- 再抽1个 → 紫框（备用）
- 使用白框后，备用变白框，再抽1个紫框

#### 攻击技能（skill_attack）

| 字段 | 说明 |
|------|------|
| `attack_type` | 斩击(slash) / 突刺(pierce) / 打击(blunt) |
| `skill_level` | 1/2/3（对应星芒消耗 1/5/10）|
| `sin` | 罪孽归属（使用时公共池+1）|
| `dice_type` | 一般/不可破坏/截断 |
| `base_value` | 骰子基础值 |
| `variable_dice` | 变动骰（d4/d6/d8）|
| `dice_count` | 骰数 |
| `weight` | 加重值（每个骰子+此值）|
| `weapon_requirement` | 空=无限制；填 attack_type = 需要对应类型武器 |
| `tags` | 含 "related" = 相关技能，不消耗星芒 |

**星芒消耗**：通常技能 Lv1=1, Lv2=5, Lv3=10；相关技能（related）=0

#### 守备技能（skill_defense）

| 字段 | 说明 |
|------|------|
| `defense_type` | 见下方守备类型表 |
| `sin` | 罪孽归属 |
| 骰子字段 | 同攻击技能 |

守备类型：

| 键名 | 中文 |
|------|------|
| `dodge` | 闪避 |
| `block` | 格挡 |
| `counter_slash` | 反击-斩击 |
| `counter_pierce` | 反击-突刺 |
| `counter_blunt` | 反击-打击 |
| `parry` | 可拼点格挡 |
| `parry_counter_slash` | 可拼点反击-斩击 |
| `parry_counter_pierce` | 可拼点反击-突刺 |
| `parry_counter_blunt` | 可拼点反击-打击 |

#### E.G.O（ego）

E.G.O 同时具有**装备属性**和**技能属性**（激活后使用骰子进行战斗）：

| 字段 | 说明 |
|------|------|
| `ego_tier` | ZAYIN / TETH / HE / WAW / ALEPH |
| `attack_type` | 激活时的攻击类型（斩/突/打）|
| `sin` | 罪孽归属 |
| 骰子字段 | 同攻击技能 |
| `sin_cost` | `{ wrath: n, ... }` 激活消耗（从公共池扣除）|
| `sin_resistance_mod` | `{ wrath: "normal", ... }` 罪孽抗性调整（"none"=不调整）|
| `offense_level_mod` | 装备提供的攻击等级加成 |
| `defense_level_mod` | 装备提供的防御等级加成 |

---

## 五、战斗机制（规则已定义，代码待实现）

### 5.1 拼点流程

- **双方攻击**：各自骰技能，取最高骰子结果比较
- **攻守对决**：攻击方骰攻击技能，守备方骰守备技能，取最高比较

### 5.2 攻防等级差修正

- **双方攻击**：攻击等级每相差 3，较高方 **骰数+1**
- **攻守对决**：攻击等级与防御等级每相差 3，较高方 **骰数+1**
- 不存在双方都守备的情况

### 5.3 骰子规则

每个骰子结果 = `base_value + variableDice结果 + weight`

| 骰类 | 效果 |
|------|------|
| 一般（normal）| 正常取值 |
| 不可破坏（unbreakable）| 结果不低于 base_value |
| 截断（truncated）| 结果不高于 base_value + weight |

---

## 六、图标资源路径

```
Base_icon/ 文件名:
  Health.webp, Sanity.webp, Starlight.webp（星芒）, Speed.webp
  Offense_Level.webp, Defense_Level.webp
  Wrath_icon.webp, Lust_icon.webp, Sloth_icon.webp
  Gluttony_icon.webp, Gloom_icon.webp, Pride_icon.webp, Envy_icon.webp
  Slash.webp, Pierce.webp, Blunt.webp
  镜牢经费.webp（货币）

Skill/ 文件名规律: {Sin}_{lv}.webp（首字母大写）
  例：Wrath_lv1.webp, Gloom_lv3.webp
  特殊：Normalsin.webp（无罪孽）, E.G.O.webp

Buff_icon/ 常用文件名（中文）:
  流血, 烧伤, 震颤, 震颤-叠加, 震颤引爆, 破裂, 沉沦
  充能, 弹药, 呼吸法, 护卫, 守护, 强壮, 虚弱
  束缚, 麻痹, 迅捷, 易损, 破绽, 忍耐
  拼点威力提升, 拼点威力降低, 振幅转换, 广域乱射, 挑衅（挑衅.webp）
```

---

## 七、代码关键路径

### template.json 数据访问路径

```js
// Actor（character/npc）
actor.system.attributes.str.value        // 力量
actor.system.health.value / .max         // 生命
actor.system.sanity.value                // 理智（5-95）
actor.system.starling.value              // 星芒
actor.system.currency.value              // 眼（货币）
actor.system.level.value                 // 等级
actor.system.offense_level.total         // 攻击等级（派生）
actor.system.defense_level.total         // 防御等级（派生）
actor.system.speed.value                 // 速度（派生，含敏捷）
actor.system.chaos_thresholds.count      // 混乱阀值条数
actor.system.chaos_thresholds.thresholds // 阀值 HP 数组
actor.system.chaos_thresholds.triggered  // 已触发的索引数组
actor.system.resistances.physical.slash  // 物理抗性（"normal" 等）
actor.system.resistances.sin.wrath       // 罪孽抗性
actor.system.panic                       // 恐慌状态 bool
actor.system.chaos                       // 混乱状态 bool
actor.system.heart_and_hope.choices      // 心与望选项数组

// Item（所有类型共有）
item.system.sin                          // 罪孽归属
item.system.starling                     // 星芒消耗
item.system.tags                         // 标签数组
item.system.links                        // 链接方向数组
item.system.description                  // 效果描述
item.system.offense_level_mod            // 攻击等级调整
item.system.defense_level_mod            // 防御等级调整

// skill_attack 独有
item.system.attack_type                  // 攻击类型
item.system.skill_level                  // 技能等级 1/2/3
item.system.weapon_requirement           // 武器限制
item.system.dice_type                    // 骰类
item.system.base_value                   // 基础值
item.system.variable_dice                // 变动骰 "d4"/"d6"/"d8"
item.system.dice_count                   // 骰数
item.system.weight                       // 加重值

// ego 独有
item.system.ego_tier                     // "ZAYIN"/"TETH"/"HE"/"WAW"/"ALEPH"
item.system.sin_cost                     // { wrath: n, ... }
item.system.sin_resistance_mod           // { wrath: "none"/"normal"/..., ... }

// upper_body 独有
item.system.resistance_mod               // { slash: "none"/"fatal"/..., ... }
```

### config.mjs 常量（CONFIG.LC）

```js
LC.attributes          // str/agi/con/int/per/cha → 本地化键
LC.sins                // wrath/.../envy/none → 本地化键
LC.sinPoolDefault      // 公共池默认值 { wrath: 0, ... }
LC.attackTypes         // slash/pierce/blunt
LC.diceTypes           // normal/unbreakable/truncated
LC.resistanceLevels    // { fatal: { label, multiplier }, ... }
LC.resistanceMods      // ["none","fatal","fragile","normal","endured","resist"]
LC.egoTiers            // ZAYIN/TETH/HE/WAW/ALEPH
LC.defenseTypes        // dodge/block/counter_*/parry/parry_counter_*
LC.skillLevels         // { 1:1, 2:5, 3:10 }（星芒消耗）
LC.chaosThresholdMap   // { 1:[0.50], 2:[0.30,0.60], 3:[0.20,0.50,0.80] }
LC.heartChoices        // [{ id, label }, ...]
LC.factionTypes        // workshop/bureau/company/association/gang/outskirts
```

### actor.mjs 公开方法

```js
actor.rollAttributeCheck(attrKey, difficulty, modifier?)  // 属性鉴定
actor.rollSpeed()                                          // 骰先攻速度
actor.rollSkillDice(skillItem)                             // 骰技能（会+罪孽池）
actor.activateEgo(egoItem)                                 // 激活EGO（扣罪孽+骰点）
actor.checkChaosThreshold()                                // 检查混乱阀值
actor.longRest()                                           // 长休恢复
```

### item.mjs 公开方法

```js
item.requiresWeapon(actor)   // 检查武器限制
item.getLinkDirections()     // 获取链接方向数组
item.getStarlingCost()       // 获取星芒消耗
item.getSinCost()            // 获取EGO罪孽消耗
item.displayInChat()         // 发送物品信息到聊天
```

---

## 八、Handlebars 辅助函数

在 `limbusCompany.mjs` 中注册：

| 函数名 | 用法 |
|--------|------|
| `lc_eq a b` | 相等判断 |
| `lc_neq a b` | 不等判断 |
| `lc_gt a b` | a > b |
| `lc_lt a b` | a < b |
| `lc_gte a b` | a >= b |
| `lc_localize key` | 本地化字符串 |
| `lc_resistance_label key` | 抗性等级本地化 |
| `lc_resistance_multiplier key` | 抗性倍率数值 |
| `lc_includes arr val` | 数组包含检查 |
| `times n block` | 范围循环 |

---

## 九、实现进度

### 已完成
- [x] system.json（系统清单）
- [x] template.json（Actor/Item 数据结构）
- [x] module/helpers/config.mjs（系统枚举常量）
- [x] limbusCompany.mjs（主入口、公共罪孽池 Settings、Handlebars helpers）
- [x] module/documents/actor.mjs（派生计算、鉴定/速度/技能/EGO骰子、长休）
- [x] module/documents/item.mjs（物品规则判断、星芒计算、聊天展示）
- [x] lang/zh-cn.json + lang/en.json

### 待完成（规则确认后进行）
- [ ] 角色卡 Sheet UI（actor-sheet.mjs + HBS 模板）
- [ ] 物品 Sheet UI（item-sheet.mjs + HBS 模板）
- [ ] 战斗拼点系统（骰数修正、双方比较）
- [ ] BUFF 状态系统（流血/烧伤/震颤/破裂/沉沦等）
- [ ] 技能抽卡机制（白框/紫框管理）
- [ ] 装备链接激活/关闭 UI 逻辑
- [ ] 混乱状态自动检测（HP 变化时触发）
- [ ] 心与望 UI 选择界面
- [ ] 望的选项（大纲尚未定义）
- [ ] 智力/感知/魅力对罪孽/EGO 的具体影响（大纲尚未完整定义）

---

## 十、开发注意事项

1. **规则变更先更新大纲.txt，再更新本文件，最后改代码**
2. `大纲.txt` 中的「星光」已更名为「星芒」，代码中对应字段为 `starling`
3. 罪孽资源是**公共池**，不存在每个 Actor 上，存在 `game.settings` 中
4. 角色卡 Sheet 和物品 Sheet **尚未创建**，limbusCompany.mjs 中 Sheet 注册代码已注释掉
5. E.G.O 同时是装备（提供抗性/等级加成）和可激活技能（消耗罪孽+骰点）
6. FVTT v12 用 `this.system` 而非 `this.data.data` 访问数据
7. 图标文件名区分大小写（Base_icon 开头大写，Buff_icon 文件名为中文）
