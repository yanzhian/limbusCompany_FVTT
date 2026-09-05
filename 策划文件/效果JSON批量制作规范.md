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
拼点时  拼点胜利  拼点失败
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

**多条 BUFF 求和**：把 `buffs` 写成数组，倍数按它们的和算（见 §4.5）。

```json
{ "type": "perN", "target": "target", "buffs": ["bleed", "burn"], "buff": "bleed",
  "perNDim": "intensity", "stacks": 4, "maxTimes": 4 }
```
> 「[攻击时]：目标每拥有【流血】和【烧伤】强度之和 4 级，则本骰基础值 +1（最大值 4）」

### 4.3 比较值

```json
{ "type": "buffCompare", "target": "self", "buff": "charge", "buffCustom": "",
  "compareDim": "stacks", "comparison": "gte", "stacks": 10,
  "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
```
`comparison`：`gt` / `gte` / `lt` / `lte` / `eq`。

**多条 BUFF 求和**：把 `buffs` 写成数组，比较的是它们的和（见 §4.5）。

```json
{ "type": "buffCompare", "target": "target", "buffs": ["burn", "bleed"], "buff": "burn",
  "compareDim": "intensity", "comparison": "gte", "stacks": 6 }
```
> 「若目标的【烧伤】强度与【流血】强度之和不低于 6 级，则使本骰基础值 +2」

> #### ⚠ **没有这条 BUFF ≠ 这条 BUFF 为 0 层**
>
> 【比较值】只在**身上确实有这条 BUFF** 时才判定；根本没有的一律不成立
>（引擎两处判定 `_applyActivities` / `_evalReactionPrecond` 都是这个规矩）。
>
> 所以写「拥有 0 层【光札】」这种条件时，**再加一条【拥有】前置**把存在性钉死：
>
> ```json
> "preconditions": [
>   { "type": "hasBuff",     "target": "self", "buff": "lightCard", "intensity": 0, "stacks": 0 },
>   { "type": "buffCompare", "target": "self", "buff": "lightCard",
>     "compareDim": "stacks", "comparison": "eq", "stacks": 0 }
> ]
> ```
>
> 【拥有】填 `intensity: 0, stacks: 0` 就是纯粹的「身上有这条」，不带任何阈值。
> 少了它的话，从没拿过这条 BUFF 的人也会被判成「0 层」，[反应] 之类会无限触发。
> 真要表达「没有」，用【未拥有】(`noBuff`)，别用【比较值】= 0。

### 4.5 多条 BUFF 求和（`buffs`）

【每】(`perN`) 与【比较值】(`buffCompare`) 支持把**几条 BUFF 加起来**再判定，
用来写「【烧伤】与【流血】强度之和」这类条件。编辑器里在 BUFF 栏用 `/` 分隔
（`烧伤 / 流血`），JSON 里写 `buffs` 数组：

```json
{ "type": "buffCompare", "target": "target",
  "buffs": ["burn", "bleed"],     // ← 求和的几条，注册键
  "buff": "burn",                 // ← 仍写第一条，老代码路径与文案兜底要用
  "compareDim": "intensity", "comparison": "gte", "stacks": 6 }
```

- `buffs` 只有一项时行为与单条完全一致；**没有 `buffs` 的老数据读 `buff`**，不受影响
- `compareDim` / `perNDim` 决定加的是**层数**还是**强度**，两条 BUFF 用同一个维度
- 【拥有】/【未拥有】**不支持** `buffs`——那两条是单条阈值语义，求和讲不通

> #### ⚠ 一条都没挂 ≠ 和为 0
>
> 与单条同一个规矩（§4.3 那条 ⚠ 的推广）：列出的 BUFF **一条都没有**时本条不成立。
> 否则「和 ≤ 3」会对全场从没沾过这些 BUFF 的人恒真，[反应] 会无限触发。
>
> 但**挂了其中一条**时，缺的那条按 **0** 计入求和——那是真的 0。
> 所以「6 级【烧伤】+ 没有【流血】」满足「和 ≥ 6」。

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

#### 「消耗所有 X」→ 用 `consumeAll`

```json
{ "type": "forced", "target": "self", "buff": "custom", "buffCustom": "炎蝶之棺",
  "consumeAll": true }
```

- 编辑器里对应 BUFF 消耗行的 **【扣光】** 勾选框。
- 语义是「有多少扣多少」：整条 BUFF 直接移除，**一层都没有也不算付不起**，不会让整条 Activity 失败。
- 勾上后 `intensity` / `stacks` 被忽略。
- ⚠️ **不要用 `"stacks": 99` 之类的大数**。那走的是普通强制消耗，预检查要求你**真的**有 99 层，永远付不起 → 整条 Activity 被静默跳过（曾导致整段 [攻击后] 一句都不执行）。

### 5.2 每（消耗式倍数）

```json
{ "type": "perStack", "target": "self", "buff": "burn", "buffCustom": "",
  "intensity": 0, "stacks": 3, "perNDim": "intensity", "maxTimes": 0,
  "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
```
每 N 扣一次、算一倍，只扣 `倍数 × N`。`maxTimes` 同上。
群体目标时**逐个扣**，倍数取所有目标里最小的那个。

**不足 1 倍（倍数 = 0）时不再跳过整条 Activity**：什么都不扣，只有「随倍数缩放的效果」失效，
其余效果照常执行。例：

> [攻击后]：消耗所有【炎蝶之棺】，恢复 20 生命值，每消耗 3 级【烧伤】恢复 1D6，将本骰转换成"烙印"

目标没有烧伤时，少回那 1D6，但 20 点固定回血与骰子转换照常发生。

随倍数缩放（0 倍时跳过）的效果类型见 `ClashManager.PER_SCALED_EFFECTS`：
`addBuff` `randomBuff` `hpAdj` `sanityAdj` `apAdj` `atkAdj` `defAdj` `weightAdj`
`diceAdj` `diceFacesAdj` `baseValue` `fieldResource` `seismicBlast` `extraDamage`。
其余（`diceTypeChg` `removeBuff` `rangeChg` `triggerBuff`…）与倍数无关，0 倍时照常跑。

> 注意：**倍数是整条 Activity 共用的**（取所有「每」条件与「每」消耗的最小值）。
> 想让固定部分和「每 N」部分互不影响地各自缩放，仍然要**拆成两条 Activity**。

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

> #### ⚠ `round` 一律照抄需求原文，不许自作主张
>
> 需求怎么写就怎么填，**不要"帮忙"改成自己觉得更合理的那个**：
>
> | 需求原文 | `round` |
> |---|---|
> | 没提回合（「为自己添加 2 层【强壮】」） | `本回合` |
> | 写了「下回合」 | `下回合` |
> | 写了「本回合和下回合」 | `本回合和下回合` |
>
> **没提 = `本回合`**，这是默认值，不是"可以按资源是否需要跨回合来推断"。
> 觉得按字面写会导致 BUFF 提前掉光、资源攒不起来，那是**规则本身要改**，
> 先问，别在 JSON 里偷偷延长成 `本回合和下回合`。
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
// 近战：拼点前瞬移贴身；远程：不移动、隔空开拼，胜则推人、败不被推
{ "type": "rangeChg", "rangeMode": "ranged", "rangeValue": 8 }

// 骰子类型（本次攻击内有效）
{ "type": "diceTypeChg", "diceTypeVal": "unbreakable" }   // normal / unbreakable / severing

// 替换恐慌卡（BOSS 特殊能力：给目标换一张【陷入恐慌】或【士气低落】）
// panicSlot: "panic"（陷入恐慌，默认）/ "lowMorale"（士气低落）
// panicCardName: 按名字在**世界物品与全部合集包**里检索——恐慌卡不像技能那样
//                角色本来就带着，所以检索范围不是背包。找到后复制给目标并占住
//                该槽位，被顶掉的旧卡若没有别的槽还在用就删除。
// 卡上标了另一种 panicType 时不会放入（与角色卡拖放同一套校验）。
{ "type": "panicCardSwap", "target": "target",
  "panicSlot": "panic", "panicCardName": "深渊的低语" }

// 相关技能转换（换卡，形态切换用）
// relDuration: "permanent"（默认）/ "afterUse"（换上来的形态被投出去一次后还原）/
//              "afterClash"（本次结算后还原）/ "endOfTurn"（本回合结束时还原）
{ "type": "relatedSkillConvert", "relMode": "byName", "relSkillName": "守护者",
  "relDuration": "permanent" }

/* ⚠️ 还原不要写在目标技能上。
 * 「强化形态自己写一条 [攻击后] 转换回原形态」看似可行，但那条转换挂在**强化形态**上，
 * 它分不清自己是被哪条路径换上来的。永久转换和临时转换共用同一个强化形态时，
 * 任意一次使用都会把两边一起还原（守备技能触发一次，永久那条也跟着掉回去）。
 *
 * 正确写法：还原挂在**转换这一侧**，用 relDuration 声明时长，
 * 强化形态上**不写**任何转换回去的效果。
 *
 * 典型场景：基础技能 Lv.3 与守备技能都能转成同一张「强化Lv.3」，且强化形态整体
 * 只能用 1 次（任一边用掉，另一边也消失）——两条转换都写：
 *   { "type": "relatedSkillConvert", "relMode": "byName",
 *     "relSkillName": "强化Lv.3", "relDuration": "afterUse" }
 *
 * 时长语义：
 *   - "afterUse"    换上来的形态被**真正投出去一次**（作为攻方或守方的骰参与结算）后还原。
 *                   转换本身发生在哪个时机（[回合开始时]/[激活]/[反应]/[攻击前]/[攻击后]）
 *                   都不影响——那次结算投的是原技能，不算"用掉强化形态"。
 *   - "afterClash"  转换所在的这次结算一结束就还原。**注意**：若转换是在 [攻击后] 触发的，
 *                   强化形态还没来得及被使用就会被收回，多数换卡流程不该用这个。
 *   - "endOfTurn"   本回合结束时还原。
 *
 * 引擎细节：
 *   - 只在**真的发生了替换**时登记还原。槽位里本来就是强化形态（已被另一条换上去了）
 *     时是空操作、不登记，到点也就不会把别人的状态误还原。
 *   - 还原**按槽位记账**，不是按 id：基础槽与守备槽同时换成同一张强化技能时，
 *     两个槽各自回到各自原来的技能，不会互相误伤。
 *   - "afterUse" 时，指向同一张形态的**所有**记录一起还原 —— 这就是"另一个也会消失"。
 *   - 多层临时转换按后进先出剥回。
 *   - 兜底：**长休时还原全部临时转换**。始终没被投出去的 "afterUse" 形态不会跨休息残留。
 */

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
| 【比较值】= 0 当成「没有」 | 没有该 BUFF 时本条不成立；要「有且为 0」就再加一条【拥有】 |
| 「和 ≥ N」写成两条前置 | 前置是 AND，变成**各自**都要 ≥ N；求和要用一条 `buffs`（§4.5） |
| 带「最大值」的求和用【比较值】 | 比较值只是开关，给不出倍数；带倍数上限的一律用【每】+ `maxTimes` |
| **自己改 `round`** | 需求没提回合就是 `本回合`；写了「下回合」就填 `下回合`，不许推断 |
| **数值不带正负号** | `"1"` 是**赋值**不是加值，且不吃「每」的倍数——一律写 `"+1"` |
| 给 `value` 填数字而非字符串 | 建议统一写字符串，公式（`"1D6"`）才不会出错 |
