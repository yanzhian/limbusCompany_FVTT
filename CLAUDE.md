# CLAUDE.md — 边狱巴士都市规则 FVTT 系统开发指南

## 项目概览

本项目为 **Foundry VTT v13+** 自定义游戏系统，规则灵感源自《边狱公司》（Limbus Company）宇宙。系统名称暂定为 `limbusCompany_FVTT`。

---

## 技术要求

- **Foundry VTT 兼容版本**：v13+
- **系统 ID**：`limbusCompany_FVTT`（system.json 中的 `id` 字段）
- **语言**：中文（zh-CN）优先，代码注释可用英文

---

## 核心数据模型

### Actor 类型

#### `character`（玩家角色）

| 字段 | 类型 | 说明 |
|------|------|------|
| `hp.value / hp.max` | Number | 生命值：`等级d10 + 体质×5` |
| `sanity.value` | Number | 理智值，范围 5–95，默认 50 |
| `sanityMin` | Number | 固定 5，触发【陷入恐慌】 |
| `speed.min / speed.max` | Number | 速度：`1D6 + 敏捷`，显示为范围 |
| `ap.value / ap.max` | Number | 行动点，固定上限 3，回合末重置 |
| `level` | Number | 等级 |
| `xp.value / xp.next` | Number | 经验值（见升级表） |
| `stellarMotes.value / stellarMotes.max` | Number | 星芒：初始30，每升1级+1上限 |
| `atk.base` | Number | 攻击等级：`力量÷3↓ + 等级×3` + 装备修正 |
| `def.base` | Number | 防御等级：`体质÷3↓ + 等级×3` + 装备修正 |
| `attributes.str/agi/con/int/per/cha` | Number | 六属性，范围 2–10，初始 30 点分配 |
| `resistances.slash/blunt/pierce` | String/Enum | 物理抗性（由上装决定），格式 `xN.0` |
| `egoResistances.wrath/lust/sloth/gluttony/gloom/pride/envy` | String | 罪孽抗性，默认全部 `x1.0` |
| `chaosThresholds` | Array | 混乱阈值数组（1–3 条） |
| `sins.wrath/lust/sloth/gluttony/gloom/pride/envy` | Number | 七宗罪资源（公共） |
| `equipment` | Object | 九宫格装备栏（3×3 grid） |
| `skills.basic` | Array | 基础技能槽，最多 6 个 |
| `skills.defense` | Item | 守备技能槽，最多 1 个 |
| `skills.ego` | Array | EGO技能槽（每等级 1 个） |

**混乱阈值规则：**
- 默认 2 条（30% / 60%）
- 体质 > 7：减少 1 条（变为 1 条，50%）
- 敏捷 > 7：增加 1 条（变为 3 条，20% / 50% / 80%）
- 掉血触发阈值时：【陷入混乱】，物理抗性全部变为 ×2.0，该条阈值永久烧断直到长休重置
- 已烧断的阈值不会因为血量回升后再次跌落而重新触发

**混乱阈值数据结构：**
```js
chaosThresholds: [
  { percent: 60, triggered: false },
  { percent: 30, triggered: false },
]
```
触发判断（每次只触发一条，从高到低检查）：
```js
for (threshold of chaosThresholds) {
  if (!threshold.triggered && currentHP <= maxHP * threshold.percent / 100) {
    triggerChaos();
    threshold.triggered = true; // 烧断，永不再触发
    break;
  }
}
```
长休时：`triggered` 全部重置为 `false`，`percent` 恢复默认值。

**震颤引爆对阈值的影响：**
- 震颤引爆触发时，**所有阈值同时前移 N%**（N = 震颤强度）
- 可多次叠加，例如两次强度4 = 所有阈值前移 8%
- 前移为永久修正，直到长休重置
- 已烧断的阈值前移后依然保持烧断状态（不复活）
- 示例：最大HP=100，阈值 60/30，震颤引爆强度4 → 阈值变为 64/34

---


### Item 类型

#### `equipment`（装备）
字段：`name, subtype(上装/下装/武器/饰品), category, quantity, resistanceAdj, atkAdj, defAdj, speedAdj, links(上下左右方向), stellarCost, tags, effect, activateEffect, requiresLink(bool)`

#### `skill`（技能）
字段：`name, type(basic/defense/ego), level, category(slash/blunt/pierce/dodge/...), sinType, egoDiceRating(ZAYIN/TET/HE/WAW/ALEPH), egoResistanceChange, weight, diceType(normal/unbreakable/severing), baseValue, diceCount, diceFormula(e.g. 2d4+3), relatedSkill, stellarCost, weaponRestriction, tags, effectDesc, sinCost(EGO), sanityCost(EGO)`

**相关技能字段说明（relatedSkill）：**

```js
relatedSkill: {
  itemUuid: "Item.xxxxxxxxxxxxxxxx",   // 直接引用已有技能卡的 UUID，PL 可拖拽绑定
  trigger: "命中时" | "暴击命中时" | "拼点成功" | ..., // 触发条件
  erodeUuid: "Item.yyyyyyyyyyyyyyyy",  // 侵蚀形态技能 UUID（仅EGO技能，恐慌时替换）
}
```

**相关技能行为规则：**
- 相关技能**不占用基础技能6个槽位**，不参与 6-bag 抽取
- 触发条件满足后，下回合该相关技能**直接进入激活槽**，替换掉其中一个普通抽取的技能，玩家二选一
- 相关技能**不消耗星芒**
- 玩家可手动选择是否使用（非强制）
- EGO技能的相关技能在【陷入恐慌】时，自动替换为 `erodeUuid` 指向的侵蚀形态，脱离恐慌后恢复


#### `consumable`（消耗品）
字段：`name, category, quantity, effect`

#### `material`（材料）
字段：`name, category, description`

#### `container`（容器）
字段：`name, gridSize, contents(Array of Items)`

---

## 游戏机制实现要点

### 1. 星芒（Stellar Motes）
- 初始上限 30，每升1级 +1 上限
- 装备技能/物品时检查当前星芒是否充足
- 费用：普通技能 Lv1=1 / Lv2=5 / Lv3=10；EGO技能 ZAYIN=1 / TET=3 / HE=5 / WAW=10 / ALEPH=15
- 【相关技能】（token）不消耗星芒

### 2. 升级系统
经验值需求表（数组，索引=等级-1）：
```
[0,10,12,15,20,27,40,59,88,125,168,227,298,381,482,591,728,885,1064,1261,
 1488,1739,2014,2327,2674,3047,3456,3899,4378,4899,5468,6075,6722,7413,
 6075,6722,7413,8156,8953,7413,7413,7143,7413,7413,8156,8156,8156,8156,8156,8953]
```
45级后每5级：需求 × 1.5。每10级获得 1 个属性点。每升1级 +1 星芒上限。

### 3. 战斗系统（Combat）

#### 先攻：投 `1D6 + 敏捷`，取值范围显示

#### 技能抽取（6-bag 机制）：
- 从已装备的 6 个基础技能中，不重复抽取
- 初始：2个【激活】+ 1个【预备】
- 每使用1个技能，预备填入激活，再抽1个新预备
- 一轮抽完后重新开始新的6-bag
- 实现为前端专用 GUI，同步角色卡主界面

#### 攻防对抗流程：
1. 攻击者使用技能 → 视为【发起对抗】
2. 目标选择：**对抗**（双方拼点）或 **承受**（直接受伤）
3. 拼点：双方骰数结果比较，胜者对败者造成自己骰数结果的伤害
4. 攻击等级差值每相差3，+1最终骰数

#### 守备技能类型处理：

| 守备类型 | 逻辑 |
|----------|------|
| 闪避 | 拼点成功→不消耗行动点 |
| 格挡 | 直接受伤，减少格挡骰数结果 |
| 反击 | 直接受伤，对目标造成自己骰数伤害 |
| 可拼点格挡 | 成功→无视伤害；失败→格挡 |
| 可拼点反击 | 成功→反击；失败→受伤 |

### 4. 状态（BUFF/DEBUFF）系统

每个状态有**强度**（intensity）和**层数**（stacks）两个维度：

| 状态 | 机制 |
|------|------|
| 强壮/虚弱 | ±基础/E.G.O技能最终骰数（层数值） |
| 忍耐/破绽 | ±守备技能最终骰数 |
| 迅捷/束缚 | ±速度最大/最小值 |
| 守护/易损 | ±受到伤害 |
| 拼点威力提升/降低 | ±拼点威力 |
| 攻击等级提升/降低 | ±攻击等级 |
| 防御等级提升/降低 | ±防御等级 |
| 烧伤 | 回合结束：受到强度点固定伤害，持续层数回合 |
| 流血 | 下N次攻击时：受到强度点固定伤害 |
| 震颤 | N回合内，受到震颤引爆攻击时，混乱阈值前移强度值 |
| 破裂 | 下N次受伤时，额外受到强度点固定伤害 |
| 沉沦 | 下N次被攻击时，额外受到强度×理智伤害 |
| 呼吸法 | 下N次命中：强度×5% 概率暴击 |
| 充能 | 特殊资源，最大20层，回合末-1 |
| 陷入混乱 | 物理抗性全×2.0，清空行动点，回合末移除 |
| 陷入恐慌 | 清空行动点，EGO技能本回合无需行动点，回合末移除 |

### 5. Activity（效果触发）系统

结构体：
```js
{
  trigger: "攻击时" | "命中时" | "回合结束时" | ...,
  precondition: { target: "self"|"target", hasBuff: String, intensity: Number, stacks: Number } | null,
  cost: { type: "none"|"forced"|"optional", buff: String, intensity: Number, stacks: Number } | null,
  effect: { type: "addBuff"|"hpAdj"|"sanityAdj"|"atkAdj"|"defAdj"|"speed"|"seismicBlast" | ..., target: "self"|"target", intensity: Number, stacks: Number },
  limit: { type: "unlimited"|"perTurn", count: Number }
}
```

触发时机完整列表：`使用时 / 攻击前 / 攻击时 / 攻击后 / 拼点时 / 拼点成功 / 拼点失败 / 命中时 / 暴击命中时 / 回合开始时 / 回合结束时 / 受到伤害时`

效果列表：`添加BUFF/ 移除BUFF / 生命值调整 / 理智值调整 / 攻击等级调整/ 防御等级调整 / 速度调整 / 基础值 / 变动值 /骰 数 / 相关技能转换 /震颤引爆 `


### 6. EGO 技能特殊逻辑

- 等级：ZAYIN < TET < HE < WAW < ALEPH
- 需要满足罪孽资源条件 + 消耗理智值
- 使用后修改角色的罪孽抗性（7种）
- 理智值降至5时进入【陷入恐慌】，EGO相关技能反转为【侵蚀形态】（此类就是相关技能）
- EGO使用后增加对应罪孽资源 1 点

### 7. 装备格（九宫格）系统

- 3×3 网格，自由放置
- 链接方向：↑↓←→（四方向箭头）
- 相邻装备若链接方向对齐 → 触发【相互链接】效果
- 同一时刻：上装1件、下装1件、武器多件但只激活1件、饰品多件可激活多件

---

## 文件结构建议

```
limbusCompany_FVTT/
├── system.json
├── template.json
├── lang/
│   └── zh-CN.json
├── module/
│   ├── limbusCompany_FVTT.mjs          # 主入口
│   ├── documents/
│   │   ├── actor.mjs            # LimbusActor extends Actor
│   │   └── item.mjs             # LimbusItem extends Item
│   ├── sheets/
│   │   ├── actor-sheet.mjs      # 角色卡界面
│   │   ├── item-sheet.mjs       # 物品/技能界面
│   │   └── combat-gui.mjs       # 战斗专用GUI（6-bag抽卡）
│   ├── helpers/
│   │   ├── combat.mjs           # 战斗逻辑（拼点/攻防）
│   │   ├── buff.mjs             # 状态管理
│   │   ├── dice.mjs             # 骰子/鉴定
│   │   └── ego.mjs              # EGO技能逻辑
│   └── config.mjs               # 常量配置
├── templates/
│   ├── actor/
│   │   ├── character-sheet.hbs
│   │   └── parts/
│   ├── item/
│   │   └── *.hbs
│   └── combat/
│       └── combat-hud.hbs
└── styles/
    └── limbusCompany_FVTT.css
```

---

## 常量配置（config.mjs）

```js
// 七宗罪
SINS: ['wrath','lust','sloth','gluttony','gloom','pride','envy']
SIN_LABELS: { wrath:'暴怒', lust:'色欲', sloth:'怠惰', gluttony:'暴食', gloom:'忧郁', pride:'傲慢', envy:'嫉妒' }

// 物理抗性类型
DAMAGE_TYPES: ['slash','blunt','pierce']  // 斩击/打击/突刺

// EGO等级
EGO_GRADES: ['ZAYIN','TET','HE','WAW','ALEPH']
EGO_COSTS:  { ZAYIN:1, TET:3, HE:5, WAW:10, ALEPH:15 }

// 普通技能星芒费用
SKILL_COSTS: [1, 5, 10]  // Lv1/2/3

// 升级经验表（数组）
LEVEL_XP: [0,10,12,15,...] // 见上文完整数组
```

---

## 待实现 DLC 模块

- [ ] **心（Heart）系统**：消耗情感记忆激活金光强化，大幅提升体能
- [ ] **望（Aspiration）系统**：心能量转化为1–5层光环，提升攻/防
- [ ] **恐慌（Panic）系统**：扩展陷入恐慌的交互机制

---

## 开发注意事项

1. **战斗 GUI 独立**：6-bag 抽卡界面不写入角色卡数据，仅为战斗时的前端状态管理。
2. **鉴定投币**：属性鉴定使用"投N枚硬币，计正面数"机制，通过 Foundry 的 `Roll` API 实现（例：`投8枚硬币判断3+正面`）。
3. **遭遇战初始化**：进入战斗时自动将 AP=3、理智=50、混乱阈值重置。
4. **背景字段**：背景信息为纯自由文本，不与规则系统交互，不需要结构化数据。
5. **罪孽资源**：罪孽资源为全局/公共资源，建议挂在 `game.settings` 或 Combat Document 上，而非单个角色。
6. **混乱阈值前移**（震颤引爆）：阈值是动态计算的百分比，不是固定 HP 值，每次需根据当前最大生命值重新计算。
