# 效果触发（Activity）JSON 批量制作规范

给已有物品补效果时，不必在编辑器里一格一格点：写好 JSON，打开物品卡 →
**效果触发列表 → 【粘贴 JSON】** 贴进去即可（**追加**，不覆盖已有效果）。

本文是写这份 JSON 的唯一依据。字段名、可选值都以 `module/sheets/item-sheet.mjs`
的 `_readActivityForm()`（写表）与 `module/helpers/clash.mjs` 的 `_applyActivities()`
（执行）为准，改代码时请一并更新本文。

---

## 1. 整体结构

粘贴框接受三种写法，推荐第二种：

```jsonc
{ ... }                       // 单条效果
[ { ... }, { ... } ]          // 效果数组 ← 推荐
{ "activities": [ ... ] }     // 整包（可直接贴导出的内容）
```

一条效果（Activity）长这样：

```json
{
  "name": "[攻击前] 目标每4级烧伤 → 骰数+1",
  "trigger": "攻击前",
  "preconditions": [],
  "costs": [],
  "effects": [],
  "limit": { "type": "unlimited", "count": 0 }
}
```

| 字段 | 说明 |
|---|---|
| `name` | 列表里显示的名字，随便起。建议写成 `[时机] 条件 → 结果`，方便回头找 |
| `trigger` | 触发时机，见 §2 |
| `preconditions` | ②前置条件，全部满足才继续（AND） |
| `costs` | ③消耗，付不起就整条跳过 |
| `effects` | ④效果，按数组顺序执行 |
| `limit` | 次数限制，见 §6 |

`id` 不用写——粘贴时会自动发号。

### 一条 = 一组条件

前置是**整条**共用的。所以「若 A 则 X，若 B 则 Y」必须拆成两条 Activity，
不能写在同一条里。本文所有示例都遵循这个拆法。

---

## 2. 触发时机 `trigger`

```
使用时  攻击前  攻击时  攻击后
拼点时  拼点成功  拼点失败
命中时  暴击命中时
回合开始时  回合结束时  受到伤害时
反应  丢弃时  恐慌触发时  坚定触发时  陷入混乱时
```

- **装备卡上的【激活】按钮** 触发的是 `使用时`
- **守备技能的【激活】** 同样是 `使用时`
- `命中时` 在容量扩散的每一发扩散上都会各触发一次
- `陷入混乱时` 在混乱阈值被击穿时触发（含混乱→混乱+ 的升级），
  已装备技能与装备格物品都参与

---

## 3. 目标 `target`

前置、消耗、效果都用同一套：

| 值 | 含义 |
|---|---|
| `self` | 自己 |
| `target` | 目标（拼点对手） |
| `covered` | 被援护的队友（本次对抗走了【援护防御】时，替自己顶上来之前的原目标；没走援护流程则无目标） |
| `allTeam` | 本队全部 |
| `allTeamOther` | 本队其他全部（排除自己） |
| `allEnemy` | 敌对全部 |
| `allEnemyOther` | 敌对其他全部 |
| `bgTag` / `bgTagOther` | 背景标签（配合 `targetTag`） |

群体目标可加 **至多人数**：`"targetTagMax": 2`（0 = 不限）。超出人数时**随机**抽取。
`bgTag` 另需 `"targetTag": "标签名"`、`"targetTagCount": 至少在场人数`。

> 消耗里还有两个特殊 target：`field`（公用场地）、`sin`（罪孽资源），见 §5。

---

## 4. 前置条件 `preconditions`

### 4.1 拥有 / 未拥有

```json
{ "type": "hasBuff", "target": "self", "buff": "burn", "buffCustom": "",
  "intensity": 15, "stacks": 0,
  "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
```

- `intensity` = 强度（级）门槛，`stacks` = 层数门槛，**填 0 表示不检查该维度**
- 「拥有【烧伤】」这种不带数值的写法 → `intensity: 0, stacks: 1`
- `noBuff` 是它的反面，字段完全相同：目标满足"拥有"时本条**不**成立

### 4.2 每（倍数来源）

```json
{ "type": "perN", "target": "target", "buff": "burn", "buffCustom": "",
  "intensity": 0, "stacks": 5, "perNDim": "intensity", "maxTimes": 4,
  "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
```

- `stacks` 是「每 N」里的 **N**；`perNDim` 决定 N 数的是 `stacks`（层）还是 `intensity`（级）
- `maxTimes` 是**倍数**上限，0 = 无限
- 倍数会放大后续效果的**层数、强度和数值**（见 §7）

**「最大值」怎么换算成 `maxTimes`**：卡面写的最大值指**效果总量**，
所以 `maxTimes = 最大值 ÷ 单次效果值`。

| 卡面写法 | 填法 |
|---|---|
| 每 4 级烧伤，骰数 +1（最大值 2） | `stacks:4, perNDim:"intensity", maxTimes:2` |
| 每 5 级烧伤，面数 +2（最大值 6） | `stacks:5, perNDim:"intensity", maxTimes:3` |
| 每 10 层炎蝶之棺，基础值 +1（无上限） | `stacks:10, perNDim:"stacks", maxTimes:0` |

### 4.3 比较值

```json
{ "type": "buffCompare", "target": "self", "buff": "charge", "buffCustom": "",
  "compareDim": "stacks", "comparison": "gte", "stacks": 10,
  "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
```
`comparison`：`gt` / `gte` / `lt` / `lte` / `eq`。未拥有视为 0。

### 4.4 基础属性

```json
{ "type": "baseAttr", "target": "self", "attrType": "ap",
  "comparison": "eq", "attrValue": "0",
  "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
```
`attrType`：`hp` / `sanity` / `ap`。`attrValue` 是字符串，支持百分比等写法。

### 4.5 其余类型

| type | 字段 | 用途 |
|---|---|---|
| `useSkill` | `skillNameOrTag`、`skillLevel` | 使用了某名字/标签、某等级的技能（两者可只填一个） |
| `category` | `categories: ["slash", ...]` | 使用了某分类的骰 |
| `background` | `bgName` | 背景名或背景标签 |
| `equipped` | `equipName`/`equipTag`/`equipCategory`、`count`、`perEach`、`maxTimes` | 装备格里符合条件的件数；`perEach: true` 时也提供倍数 |
| `equipSlotCategory` | `equipSlot`（`weapon`/`upper`/`lower`/`accessory`，留空=不限部位）、`equipCategory`（分类，多个用 `/` 分隔） | 【装备分类】：某部位装备的分类是否命中（「若你武器的分类为弓刀」） |
| `allyTag` | `target`（`bgTag`/`bgTagOther`/`allTeamOther`…）、`targetTag`、`targetTagCount`、`perEach`、`maxTimes` | 场上有没有符合条件的友方（「若有其他背景带有X的友方」）；`perEach: true` 时人数也当倍数 |
| `fieldResource` | `fieldName`、`comparison`、`stacks` | 公用场地层数 |
| `sinResource` | `sinType`、`comparison`、`value` | 全局罪孽池点数 |

---

## 5. 消耗 `costs`

### 5.1 强制消耗（付不起则整条跳过）

```json
{ "type": "forced", "target": "self", "buff": "burn", "buffCustom": "",
  "intensity": 5, "stacks": 0,
  "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
```

- **层数与强度分别扣**：填了哪个扣哪个，两个都填就都扣，都留 0 时按"扣 1 层"
- 「消耗所有 X」没有专门写法，用 `"stacks": 99` 之类的大数扣光即可

### 5.2 每（消耗式倍数）

```json
{ "type": "perStack", "target": "self", "buff": "burn", "buffCustom": "",
  "intensity": 0, "stacks": 3, "perNDim": "intensity", "maxTimes": 0,
  "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
```
每 N 扣一次、算一倍，只扣 `倍数 × N`。`maxTimes` 同上。
群体目标时**逐个扣**，倍数取所有目标里最小的那个。

### 5.3 其他

| type / target | 字段 |
|---|---|
| `attribute` | `attrType`（hp/sanity/ap）、`value` |
| `discard` | `discardMode`（`level`/`another`/`reserve`）、`discardLevel`（数字，或写 `[2,3]` / `"2/3"` 表示「Lv.2 或 Lv.3」，任一命中即丢） |
| `random` | `randomPool: [{ buff, dim: "stacks"\|"intensity", amount }]`；从**付得起**的候选里随机抽一条来扣。与强制消耗同级：一条都付不起则整条 Activity 跳过 |
| target `field` | `fieldName`、`stacks` |
| target `sin` | `sinType`、`value` |

---

## 6. 次数限制 `limit`

```json
{ "type": "unlimited",    "count": 0 }
{ "type": "perTurn",      "count": 2 }
{ "type": "perEncounter", "count": 1 }
```

对应卡面「（每回合最多 2 次）」「（一场对战使用 1 次）」。
注意这限制的是**触发次数**，不是效果总量——带「每」倍数的效果一次触发也可能加好几层。

---

## 7. 效果 `effects`

### 7.1 添加 BUFF（最常用）

```json
{ "type": "addBuff", "target": "target", "round": "本回合",
  "buff": "burn", "buffCustom": "", "intensity": 3, "stacks": 1, "ampTremor": "",
  "value": "", "trigBuff": "", "trigBuffCustom": "", "trigStacks": 0,
  "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
```

- `intensity` = 级，`stacks` = 层；「1 层 3 级【烧伤】」就是 `intensity:3, stacks:1`
- 只加级不加层 → `stacks: 0`；只加层不加级 → `intensity: 0`
- `round`：`本回合` / `下回合` / `本回合和下回合`
- **【振幅转换】/【振幅纠缠】** 用 `ampTremor` 指定随行的特殊震颤，
  例：`"buff":"amplitudeConvert", "stacks":1, "ampTremor":"tremorHeat"`

### 7.2 数值型

> ### ⚠ 最容易踩的坑：**数值必须带正负号**
>
> `value` 是字符串，**有没有符号决定的是"加值"还是"赋值"**（`_evalSignedValue`）：
>
> | 写法 | 含义 | 结果 |
> |---|---|---|
> | `"+1"` | 加值（relative） | 骰数 +1 ✅ |
> | `"-2"` | 减值（relative） | 骰数 -2 ✅ |
> | `"1"` | **赋值**（absolute） | 骰数直接变成 1 ❌ 多半不是你要的 |
> | `"1D6"` | 公式，一律按加值 | 恢复 1D6 点 ✅ |
>
> 更要命的是：**赋值模式不吃「每」的倍数**——写成 `"1"` 的话，
> 「每 5 级烧伤 → 基础值 +1」既不会加值也不会翻倍，直接把基础值按成 1。
>
> **规矩：凡是 `diceAdj` / `diceFacesAdj` / `baseValue` / `weightAdj` /
> `hpAdj` / `sanityAdj` / `apAdj`，数值一律写成 `"+N"` 或 `"-N"`。**
> 只有真的要"设成某个固定值"时才写裸数字。

`value` 是**字符串**，支持骰子公式（`"1D6"`）。

| type | 含义 | 数值写法 |
|---|---|---|
| `hpAdj` / `sanityAdj` / `apAdj` | 生命 / 理智 / 行动值 | `"+20"` / `"1D6"` |
| `diceAdj` | 骰数 | `"+1"` |
| `diceFacesAdj` | 面数 | `"+2"` |
| `baseValue` | 基础值 | `"+1"` |
| `weightAdj` | 攻击容量 | `"+1"` |
| `atkAdj` / `defAdj` | 攻击 / 防御等级 | 纯数字，直接按加值 |
| `seismicBlast` | 震颤引爆 | `"1"`＝次数，不走正负号规则；次数吃「每」的倍数 |
| `extraDamage` | 追加伤害，另有 `dmgCategory`、`dmgSinType` | 一律按加值 |

> **骰数 / 面数 / 基础值 / 攻击容量 / 骰子类型** 的改动一律**只在本次攻击内有效**，
> `[攻击后]` 结束后自动还原，不需要再写"改回去"的条目。

### 7.3 特殊型

```jsonc
// 触发一次目标的某个 BUFF（跳伤害）
{ "type": "triggerBuff", "target": "target",
  "trigBuff": "burn", "trigBuffCustom": "", "trigStacks": 1, ... }

// 范围修改：只作用于**已装备的武器**（其他部位一律忽略），持久生效不自动还原
{ "type": "rangeChg", "rangeMode": "ranged", "rangeValue": 8 }

// 骰子类型（本次攻击内有效）
{ "type": "diceTypeChg", "diceTypeVal": "unbreakable" }   // normal / unbreakable / severing

// 相关技能转换（永久换卡，形态切换用）
{ "type": "relatedSkillConvert", "relMode": "byName", "relSkillName": "守护者" }

// 使用技能（[反应] 常用，其余触发时机同样可用）
{ "type": "useSkill", "target": "self", "skillRef": "name",
  "skillName": "联合", "skillTag": "", "skillLevel": 0,
  "reactTarget": "defender", ... }

// 移除 BUFF / 随机 BUFF / 公用场地
{ "type": "removeBuff", ... }
{ "type": "randomBuff", "round": "本回合", "count": 1, "buffPool": [ ... ], ... }
{ "type": "fieldResource", "fieldName": "血宴", "value": "1" }
```

`useSkill` 的 `target` 是**由谁来使用这个技能**（不是打谁），一般填 `self`。
打谁由 `reactTarget` 决定，**所有触发时机都生效**：`defender`（本次结算的防守方 / 触发者的目标）、
`attacker`（本次结算的攻击方 / 触发者本人，如 [拼点失败] 反打赢了自己的那个人）、`none`（不指定，谁都能响应）。
省略该字段时按 `none` 处理，但编辑器保存时默认写入 `defender`。

---

## 8. BUFF 的 `buff` 该填什么

填**注册键**（英文）。基础 BUFF 与已注册的自定义 BUFF：

| 键 | 名称 | 键 | 名称 |
|---|---|---|---|
| `strong` | 强壮 | `weak` | 虚弱 |
| `endure` | 忍耐 | `breach` | 破绽 |
| `swift` | 迅捷 | `bind` | 束缚 |
| `guard` | 守护 | `fragile` | 易损 |
| `clashPowerUp` | 拼点威力提升 | `clashPowerDown` | 拼点威力降低 |
| `slashPowerUp` | 斩击威力提升 | `slashPowerDown` | 斩击威力降低 |
| `bluntPowerUp` | 打击威力提升 | `bluntPowerDown` | 打击威力降低 |
| `piercePowerUp` | 突刺威力提升 | `piercePowerDown` | 突刺威力降低 |
| `wrathPowerUp` | 暴怒威力提升 | `wrathPowerDown` | 暴怒威力降低 |
| `lustPowerUp` | 色欲威力提升 | `lustPowerDown` | 色欲威力降低 |
| `slothPowerUp` | 怠惰威力提升 | `slothPowerDown` | 怠惰威力降低 |
| `gluttonyPowerUp` | 暴食威力提升 | `gluttonyPowerDown` | 暴食威力降低 |
| `pridePowerUp` | 傲慢威力提升 | `pridePowerDown` | 傲慢威力降低 |
| `gloomPowerUp` | 忧郁威力提升 | `gloomPowerDown` | 忧郁威力降低 |
| `envyPowerUp` | 嫉妒威力提升 | `envyPowerDown` | 嫉妒威力降低 |
| `atkLevelUp` | 攻击等级提升 | `atkLevelDown` | 攻击等级降低 |
| `defLevelUp` | 防御等级提升 | `defLevelDown` | 防御等级降低 |
| `burn` | 烧伤 | `bleed` | 流血 |
| `tremor` | 震颤 | `rupture` | 破裂 |
| `sinking` | 沉沦 | `breathing` | 呼吸法 |
| `charge` | 充能 | `bullet` | 子弹 |
| `shield` | 护盾 | `coverDefense` | 援护防御 |
| `tremorHeat` | 震颤-灼热 | `tremorEcho` | 震颤-回响 |
| `tremorCollapse` | 震颤-崩坏 | `amplitudeConvert` | 振幅转换 |
| `amplitudeEntangle` | 振幅纠缠 | `defensiveStance` | 防御姿态 |
| `butterfly` | 蝶 | `piercingArrow` | 刺入之矢 |
| `indomitable` | 百折不挠 | `nativeSwordArt` | 本国剑术 |
| `bloodFlame` | 血炎 | `resentmentTattoo` | 怨恨纹身 |
| `vengeanceLedger` | 复仇账簿 | `flameButterflyCoffin` | 炎蝶之棺 |
| `dawnFire` | 黎明之火 | `greetTheDawn` | 迎接黎明 |
| `memorialWine` | 追悼酒 | | |

**没注册过的自定义计数**（如【过热的棺】）这样写：

```json
"buff": "custom", "buffCustom": "过热的棺"
```

> **条件威力那 20 条**（`*PowerUp` / `*PowerDown`）与【强壮/虚弱】同为"每层 ±1 有效骰数"，
> 但只有**本骰对得上**才计入：物理三条看本骰分类（守备骰看反击类型，闪避/格挡没有物理
> 类型故吃不到），罪孽七条看本骰罪孽。攻击骰与守备骰都吃，含反击与可拼点反击。
> 与强壮/虚弱一样回合结束自动清除。
>
> 注册过的 BUFF 才有最大层数、回合钩子等特性；纯计数用 `custom` 即可。
> 新的注册键以 `module/helpers/custom-buffs.mjs` 里的 `registerCustomBuff("键", ...)` 为准。

---

## 9. 不在 JSON 里的东西

这些是物品卡上的字段，粘贴 JSON 改不到，要手动设置：

- 【不可摧毁】→ 技能卡的**骰子类型**下拉
- 【无法装备】【援护防御】→ 技能卡的复选框
- 【广域乱射】【链式扩散】→ **攻击容量**旁边的扩散设置（容量 ≥2 时出现）
- 骰数公式、罪孽、等级、攻击容量、理智消耗、罪孽消耗、罪孽抗性
- 卡面描述文字（CSV 导入时会按 `[时机]` 自动断行）

---

## 10. 常见错法

| 错法 | 后果 |
|---|---|
| 把两个不同条件塞进同一条 | 变成 AND，两个都满足才触发 |
| `intensity` 与 `stacks` 混填 | 「3 级」写成 `stacks:3` 会变成 3 层 1 级 |
| 「最大值」直接填进 `maxTimes` | 单次效果值 >1 时上限翻倍（+2 × 6 = +12） |
| 用中文名当 `buff` | 除非配 `custom`，否则匹配不到注册表，上限等特性失效 |
| 写 `[攻击后]` 把骰数改回去 | 多余，系统已自动还原 |
| **数值不带正负号** | `"1"` 是**赋值**不是加值，且不吃「每」的倍数——一律写 `"+1"` |
| 给 `value` 填数字而非字符串 | 建议统一写字符串，公式（`"1D6"`）才不会出错 |
