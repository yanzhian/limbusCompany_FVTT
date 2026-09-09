# 技能效果 JSON 清单

给效果编辑器用的粘贴稿。每小节一张卡的一个阶段，整段 JSON 直接粘进
「④ 效果」的 JSON 导入框即可。

写法口径见 `效果JSON批量制作规范.md`，这里只重复两条最容易翻车的：

- **`perN` 的 `intensity` 恒为 0**——「每 10 级」也写 `stacks: 10` + `perNDim: "intensity"`。
- **一条 Activity 只有一个倍数**（取所有「每」的最小值），所以同一时机里带不同
  「最大值」的加成必须拆成多条，且**按本文顺序排**（先加资源，再按资源判倍数）。

卡面上的【无法拼点】【无法装备】【广域乱射N】是勾选项/骰子设定，不写进 JSON。

---

## 闪弓（守备）

### 阶段 A

```json
[
  {
    "name": "[攻击后] 目标 1层2级【流血】＋1层【刺入之矢】",
    "trigger": "攻击后",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "bleed", "buffCustom": "", "intensity": 2, "stacks": 1 },
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "piercingArrow", "buffCustom": "", "intensity": 0, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 阶段 B

```json
[
  {
    "name": "[命中时] 下回合自身 1层10级【呼吸法】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "下回合", "buff": "breathing", "buffCustom": "", "intensity": 10, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 目标 1层10级【流血】＋1层【刺入之矢】",
    "trigger": "攻击后",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "bleed", "buffCustom": "", "intensity": 10, "stacks": 1 },
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "piercingArrow", "buffCustom": "", "intensity": 0, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 阶段 C

```json
[
  {
    "name": "[攻击前] 每 1 层【瞄准目标】自身 5 级【呼吸法】",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "aimTarget", "buffCustom": "", "intensity": 0, "stacks": 1, "perNDim": "stacks", "maxTimes": 0, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "breathing", "buffCustom": "", "intensity": 5, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 下回合自身 1 层 10 级【呼吸法】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "下回合", "buff": "breathing", "buffCustom": "", "intensity": 10, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[暴击命中时] 下回合自身【绝命】＋2 层【呼吸法】",
    "trigger": "暴击命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "下回合", "buff": "custom", "buffCustom": "绝命", "intensity": 0, "stacks": 1 },
      { "type": "addBuff", "target": "self", "round": "下回合", "buff": "breathing", "buffCustom": "", "intensity": 0, "stacks": 2 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 目标【流血】【刺入之矢】／自身回 3 行动值并清姿势",
    "trigger": "攻击后",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "bleed", "buffCustom": "", "intensity": 10, "stacks": 1 },
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "piercingArrow", "buffCustom": "", "intensity": 0, "stacks": 1 },
      { "type": "apAdj", "target": "self", "value": "+3" },
      { "type": "removeBuff", "target": "self", "buff": "aimTarget", "buffCustom": "" },
      { "type": "removeBuff", "target": "self", "buff": "snipeStance", "buffCustom": "" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

> 第一条的「每」倍数会放大强度：2 层【瞄准目标】= 10 级【呼吸法】（层数不变）。
> 要「加 2 层各 5 级」就把 `stacks` 改成 1。

---

## 四协会-闪避（守备）

### 阶段 A

```json
[
  {
    "name": "[回合结束时] 有【箭矢-死】则永久转化为「弓刀展开」",
    "trigger": "回合结束时",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "custom", "buffCustom": "箭矢-死", "intensity": 0, "stacks": 1, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "relatedSkillConvert", "relMode": "byName", "relSkillName": "弓刀展开", "relDuration": "permanent" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 阶段 B

```json
[
  {
    "name": "[拼点胜利] 下回合自身 1 层 3 级【呼吸法】",
    "trigger": "拼点胜利",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "下回合", "buff": "breathing", "buffCustom": "", "intensity": 3, "stacks": 1 }
    ],
    "limit": { "type": "perTurn", "count": 3 }
  },
  {
    "name": "[回合结束时] 有【箭矢-死】则永久转化为「弓刀展开」",
    "trigger": "回合结束时",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "custom", "buffCustom": "箭矢-死", "intensity": 0, "stacks": 1, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "relatedSkillConvert", "relMode": "byName", "relSkillName": "弓刀展开", "relDuration": "permanent" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

---

## 次元斩

### 阶段 A

```json
[
  {
    "name": "[攻击前] 自身 5 层【充能】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 5 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 1 层 2 级【破裂】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 2, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 阶段 B

```json
[
  {
    "name": "[攻击前] 自身 7 层【充能】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 7 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击时] 每 1 行动值 基础值 +1（最大 5）",
    "trigger": "攻击时",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "ap", "attrValue": "1", "perEach": true, "maxTimes": 5 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 1 层 4 级【破裂】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 4, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 每 2 层【载荷】回 1 行动值（最大 2）",
    "trigger": "攻击后",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "payload", "buffCustom": "", "intensity": 0, "stacks": 2, "perNDim": "stacks", "maxTimes": 2, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "apAdj", "target": "self", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 阶段 C

```json
[
  {
    "name": "[攻击前] 自身 7 层【充能】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 7 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 每 6 层【充能】基础值 +1（最大 3）",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 6, "perNDim": "stacks", "maxTimes": 3, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 每 1 级【充能】面数 +2（最大 4）",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 1, "perNDim": "intensity", "maxTimes": 2, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "diceFacesAdj", "value": "+2" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击时] 每 1 行动值 基础值 +1（最大 5）",
    "trigger": "攻击时",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "ap", "attrValue": "1", "perEach": true, "maxTimes": 5 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 1 层 4 级【破裂】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 4, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 每 2 层【载荷】回 1 行动值（最大 2）",
    "trigger": "攻击后",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "payload", "buffCustom": "", "intensity": 0, "stacks": 2, "perNDim": "stacks", "maxTimes": 2, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "apAdj", "target": "self", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

> 面数那条按【充能】**强度**判；充能若只有层数没有强度，把 `perNDim` 改成 `stacks`。

---

## 连续次元斩

### 阶段 A

```json
[
  {
    "name": "[攻击前] 自身 7 层【充能】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 7 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 1 层 3 级【破裂】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 3, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 阶段 B

```json
[
  {
    "name": "[攻击前] 自身 9 层【充能】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 9 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击时] 每 1 行动值 基础值 +1（最大 5）",
    "trigger": "攻击时",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "ap", "attrValue": "1", "perEach": true, "maxTimes": 5 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 1 层 4 级【破裂】＋下回合 2 层【易损】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 4, "stacks": 1 },
      { "type": "addBuff", "target": "target", "round": "下回合", "buff": "fragile", "buffCustom": "", "intensity": 0, "stacks": 2 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 每 2 层【载荷】回 1 行动值（最大 3）",
    "trigger": "攻击后",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "payload", "buffCustom": "", "intensity": 0, "stacks": 2, "perNDim": "stacks", "maxTimes": 3, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "apAdj", "target": "self", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 阶段 C

```json
[
  {
    "name": "[攻击前] 自身 9 层【充能】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 9 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 每 6 层【充能】基础值 +1（最大 3）",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 6, "perNDim": "stacks", "maxTimes": 3, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 每 1 级【充能】面数 +2（最大 4）",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 1, "perNDim": "intensity", "maxTimes": 2, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "diceFacesAdj", "value": "+2" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击时] 每 1 行动值 基础值 +1（最大 5）",
    "trigger": "攻击时",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "ap", "attrValue": "1", "perEach": true, "maxTimes": 5 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 2 层 4 级【破裂】＋下回合 2 层【易损】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 4, "stacks": 2 },
      { "type": "addBuff", "target": "target", "round": "下回合", "buff": "fragile", "buffCustom": "", "intensity": 0, "stacks": 2 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 每 2 层【载荷】回 1 行动值（最大 3）",
    "trigger": "攻击后",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "payload", "buffCustom": "", "intensity": 0, "stacks": 2, "perNDim": "stacks", "maxTimes": 3, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "apAdj", "target": "self", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

---

## 次元撕裂

### 阶段 A

```json
[
  {
    "name": "[攻击前] 消耗 15 层【充能】骰数 +1",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [
      { "type": "forced", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 15, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "effects": [ { "type": "diceAdj", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 2 层 2 级【破裂】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 2, "stacks": 2 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 阶段 B

```json
[
  {
    "name": "[攻击前] 消耗 15 层【充能】骰数 +1",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [
      { "type": "forced", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 15, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "effects": [ { "type": "diceAdj", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击时] 每 1 行动值 基础值 +1（最大 5）",
    "trigger": "攻击时",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "ap", "attrValue": "1", "perEach": true, "maxTimes": 5 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 3 层 4 级【破裂】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 4, "stacks": 3 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 每 1 层【载荷】回 1 行动值（最大 3）",
    "trigger": "攻击后",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "payload", "buffCustom": "", "intensity": 0, "stacks": 1, "perNDim": "stacks", "maxTimes": 3, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "apAdj", "target": "self", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 阶段 C

```json
[
  {
    "name": "[攻击前] 消耗 15 层【充能】骰数 +1、面数 +2",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [
      { "type": "forced", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 15, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "effects": [
      { "type": "diceAdj", "value": "+1" },
      { "type": "diceFacesAdj", "value": "+2" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 有 3 级【充能】→ 不可摧毁 ＋回 3 行动值",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 3, "stacks": 0, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "diceTypeChg", "diceTypeVal": "unbreakable" },
      { "type": "apAdj", "target": "self", "value": "+3" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击时] 每 1 行动值 基础值 +1（最大 5）",
    "trigger": "攻击时",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "ap", "attrValue": "1", "perEach": true, "maxTimes": 5 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 3 层 4 级【破裂】并触发 1 次",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 4, "stacks": 3 },
      { "type": "triggerBuff", "target": "target", "trigBuff": "rupture", "trigBuffCustom": "", "trigStacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 每 1 层【载荷】回 1 行动值（最大 3）",
    "trigger": "攻击后",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "payload", "buffCustom": "", "intensity": 0, "stacks": 1, "perNDim": "stacks", "maxTimes": 3, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "apAdj", "target": "self", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

> 「不可摧毁 + 回 3 行动值」拆成独立一条：并进消耗那条的话，3 级充能会在**扣掉 15 层之后**才判。

---

## 充能系守备 / 装备（按拼点与激活）

### 拼点型 A

```json
[
  {
    "name": "[拼点时] 每 5 层【充能】基础值 +2（最大 4）",
    "trigger": "拼点时",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 5, "perNDim": "stacks", "maxTimes": 2, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+2" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[拼点胜利] 自身 8 层【充能】",
    "trigger": "拼点胜利",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 8 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 拼点型 B（带 [使用时] 充能力场）

```json
[
  {
    "name": "[使用时] 消耗 10 层【充能】→ 1 级【充能】＋下回合 1 层【充能力场】",
    "trigger": "使用时",
    "preconditions": [],
    "costs": [
      { "type": "forced", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 10, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "charge", "buffCustom": "", "intensity": 1, "stacks": 0 },
      { "type": "addBuff", "target": "self", "round": "下回合", "buff": "chargeField", "buffCustom": "", "intensity": 0, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[拼点时] 每 5 层【充能】基础值 +2（最大 4）",
    "trigger": "拼点时",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 5, "perNDim": "stacks", "maxTimes": 2, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+2" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[拼点胜利] 自身 8 层【充能】",
    "trigger": "拼点胜利",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 8 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 激活型（W公司 · 载荷分发）

```json
[
  {
    "name": "[激活] 有 10 层【充能】→ 1 级【充能】",
    "trigger": "激活",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 10, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "charge", "buffCustom": "", "intensity": 1, "stacks": 0 }
    ],
    "limit": { "type": "perTurn", "count": 1 }
  },
  {
    "name": "[激活] 每 1 级【充能】→ 自身 1 层【载荷】",
    "trigger": "激活",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 1, "perNDim": "intensity", "maxTimes": 0, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "payload", "buffCustom": "", "intensity": 0, "stacks": 1 }
    ],
    "limit": { "type": "perTurn", "count": 1 }
  },
  {
    "name": "[激活] 「W公司」友方各 1 层【载荷】",
    "trigger": "激活",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "bgTagOther", "targetTag": "W公司", "targetTagCount": 1, "targetTagMax": 0, "round": "本回合", "buff": "payload", "buffCustom": "", "intensity": 0, "stacks": 1 }
    ],
    "limit": { "type": "perTurn", "count": 1 }
  },
  {
    "name": "[命中时] 自身 3 层【充能】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 3 }
    ],
    "limit": { "type": "perTurn", "count": 2 }
  }
]
```

---

## 弓系装备 / 姿势

### 狙击姿势装备

```json
[
  {
    "name": "[激活] 消耗 1 层【箭矢-死】＋3 行动值 → 【狙击姿势】＋【瞄准目标】",
    "trigger": "激活",
    "preconditions": [],
    "costs": [
      { "type": "forced", "target": "self", "buff": "custom", "buffCustom": "箭矢-死", "intensity": 0, "stacks": 1, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 },
      { "type": "attribute", "target": "self", "attrType": "ap", "value": "3" }
    ],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "snipeStance", "buffCustom": "", "intensity": 0, "stacks": 1 },
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "aimTarget", "buffCustom": "", "intensity": 0, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 消耗目标 1 层【刺入之矢】→【箭矢-死】＋1D8 突刺",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [
      { "type": "forced", "target": "target", "buff": "piercingArrow", "buffCustom": "", "intensity": 0, "stacks": 1, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "custom", "buffCustom": "箭矢-死", "intensity": 0, "stacks": 1 },
      { "type": "extraDamage", "target": "target", "value": "1D8", "dmgCategory": "thrust", "dmgSinType": "" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[反应] 有 4 层【瞄准目标】→ 使用「闪弓」",
    "trigger": "反应",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "aimTarget", "buffCustom": "", "intensity": 0, "stacks": 4, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "useSkill", "target": "self", "skillRef": "name", "skillName": "闪弓", "skillTag": "", "skillLevel": 0, "reactTarget": "none" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

> 「7 格内选一个目标」JSON 里没有对应字段——射程写卡面范围栏，`reactTarget: "none"` 表示由使用者选。

### 绝命 / 狙击姿势 回合钩子

```json
[
  {
    "name": "[回合开始时] 有【绝命】→ 自身 3 层【攻击等级提升】",
    "trigger": "回合开始时",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "custom", "buffCustom": "绝命", "intensity": 0, "stacks": 1, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "atkLevelUp", "buffCustom": "", "intensity": 0, "stacks": 3 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[回合结束时] 消耗 1 层【绝命】→ 下回合 3 层【攻击等级提升】",
    "trigger": "回合结束时",
    "preconditions": [],
    "costs": [
      { "type": "forced", "target": "self", "buff": "custom", "buffCustom": "绝命", "intensity": 0, "stacks": 1, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "下回合", "buff": "atkLevelUp", "buffCustom": "", "intensity": 0, "stacks": 3 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[回合结束时] 有【狙击姿势】→ 自身 5 级【呼吸法】",
    "trigger": "回合结束时",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "snipeStance", "buffCustom": "", "intensity": 0, "stacks": 1, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "breathing", "buffCustom": "", "intensity": 5, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 行动值 / 充能转化的回合开始钩子

```json
[
  {
    "name": "[回合开始时] 每 3 行动值 → 1 层【攻击等级提升】＋1 层【迅捷】",
    "trigger": "回合开始时",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "ap", "attrValue": "3", "perEach": true, "maxTimes": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "atkLevelUp", "buffCustom": "", "intensity": 0, "stacks": 1 },
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "swift", "buffCustom": "", "intensity": 0, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

```json
[
  {
    "name": "[回合开始时] 每 1 层【充能】→ 3 层【护盾】（最大 15）",
    "trigger": "回合开始时",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 1, "perNDim": "stacks", "maxTimes": 5, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "shield", "buffCustom": "", "intensity": 0, "stacks": 3 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[回合开始时] 每 1 级【充能】→ 1 层【防御等级提升】（最大 5）",
    "trigger": "回合开始时",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "charge", "buffCustom": "", "intensity": 0, "stacks": 1, "perNDim": "intensity", "maxTimes": 5, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "defLevelUp", "buffCustom": "", "intensity": 0, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

---

## 喙啄

### 阶段 A

```json
[
  {
    "name": "[命中时] 目标 2 级【破裂】＋2 级【烧伤】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 2, "stacks": 0 },
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 2, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 阶段 B

```json
[
  {
    "name": "[攻击前] 生命值 <50% → 基础值 +2",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "hp", "comparison": "lt", "attrValue": "50%", "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+2" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[拼点时] 双方各 1 层 1 级【烧伤】",
    "trigger": "拼点时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 1, "stacks": 1 },
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 1, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 2 级【破裂】＋2 级【烧伤】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 2, "stacks": 0 },
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 2, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 阶段 C

```json
[
  {
    "name": "[攻击前] 目标【破裂】+【烧伤】强度和 ≥6 → 骰数 +1",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "buffCompare", "target": "target", "buffs": ["rupture", "burn"], "buff": "rupture", "buffCustom": "", "compareDim": "intensity", "comparison": "gte", "intensity": 6, "stacks": 0, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "diceAdj", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 生命值 <50% → 基础值 +2",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "hp", "comparison": "lt", "attrValue": "50%", "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+2" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 自身每 10 级【烧伤】基础值 +1（最大 2）",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 10, "perNDim": "intensity", "maxTimes": 2, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[拼点时] 双方各 1 层 1 级【烧伤】",
    "trigger": "拼点时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 1, "stacks": 1 },
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 1, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 2 级【破裂】＋2 级【烧伤】／自身 1 层 2 级【烧伤】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 2, "stacks": 0 },
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 2, "stacks": 0 },
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 2, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

---

## 喙啄（强化线：4 级 / 6 级 / 广域乱射）

### 4 级破裂烧伤版

```json
[
  {
    "name": "[拼点时] 双方各 1 层 1 级【烧伤】",
    "trigger": "拼点时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 1, "stacks": 1 },
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 1, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 4 级【破裂】＋4 级【烧伤】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 4, "stacks": 0 },
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 4, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 6 级 + 血炎版

```json
[
  {
    "name": "[攻击前] 生命值 <50% → 基础值 +2",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "hp", "comparison": "lt", "attrValue": "50%", "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+2" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[拼点时] 双方各 1 层 1 级【烧伤】",
    "trigger": "拼点时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 1, "stacks": 1 },
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 1, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 6 级【破裂】＋6 级【烧伤】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 6, "stacks": 0 },
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 6, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 有【血炎】→ 1D8 暴怒伤害",
    "trigger": "命中时",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "bloodFlame", "buffCustom": "", "intensity": 0, "stacks": 1, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "extraDamage", "target": "target", "value": "1D8", "dmgCategory": "", "dmgSinType": "wrath" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 6 级 + 血炎 · 满配版

```json
[
  {
    "name": "[攻击前] 目标【破裂】+【烧伤】强度和 ≥6 → 骰数 +1",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "buffCompare", "target": "target", "buffs": ["rupture", "burn"], "buff": "rupture", "buffCustom": "", "compareDim": "intensity", "comparison": "gte", "intensity": 6, "stacks": 0, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "diceAdj", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 生命值 <50% → 基础值 +2",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "hp", "comparison": "lt", "attrValue": "50%", "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+2" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 自身每 10 级【烧伤】基础值 +1（最大 4）",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 10, "perNDim": "intensity", "maxTimes": 4, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[拼点时] 双方各 1 层 1 级【烧伤】",
    "trigger": "拼点时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 1, "stacks": 1 },
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 1, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 6 级【破裂】＋6 级【烧伤】／自身 1 层 5 级【烧伤】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "rupture", "buffCustom": "", "intensity": 6, "stacks": 0 },
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 6, "stacks": 0 },
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 5, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 有【血炎】→ 1D8 暴怒伤害",
    "trigger": "命中时",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "bloodFlame", "buffCustom": "", "intensity": 0, "stacks": 1, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "extraDamage", "target": "target", "value": "1D8", "dmgCategory": "", "dmgSinType": "wrath" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 【广域乱射3】A

```json
[
  {
    "name": "[攻击前] 自身 3 层【血炎】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "bloodFlame", "buffCustom": "", "intensity": 0, "stacks": 3 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 6 级【烧伤】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 6, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 【广域乱射3】B

```json
[
  {
    "name": "[攻击前] 自身 3 层【血炎】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "bloodFlame", "buffCustom": "", "intensity": 0, "stacks": 3 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 生命值 <50% → 基础值 +2",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "hp", "comparison": "lt", "attrValue": "50%", "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+2" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 自身 10 级【烧伤】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 10, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 6 级【烧伤】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 6, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 自身 2 层【烧伤】",
    "trigger": "攻击后",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 2 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 自身每 10 级【烧伤】→ 目标 1D8 暴怒伤害",
    "trigger": "攻击后",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 10, "perNDim": "intensity", "maxTimes": 0, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "extraDamage", "target": "target", "value": "1D8", "dmgCategory": "", "dmgSinType": "wrath" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

### 【广域乱射3】C（带转化）

```json
[
  {
    "name": "[回合开始时] 有 20 层【血斗本能】→ 转换为「血天下鸡舞乱刀」",
    "trigger": "回合开始时",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "bloodDuelInstinct", "buffCustom": "", "intensity": 0, "stacks": 20, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "relatedSkillConvert", "relMode": "byName", "relSkillName": "血天下鸡舞乱刀", "relDuration": "afterUse" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 自身 3 层【血炎】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "bloodFlame", "buffCustom": "", "intensity": 0, "stacks": 3 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 自身 10 级【烧伤】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 10, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 自身每 10 级【烧伤】基础值 +1（最大 4）",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 10, "perNDim": "intensity", "maxTimes": 4, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 目标【破裂】+【烧伤】强度和 ≥6 → 骰数 +1",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "buffCompare", "target": "target", "buffs": ["rupture", "burn"], "buff": "rupture", "buffCustom": "", "compareDim": "intensity", "comparison": "gte", "intensity": 6, "stacks": 0, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "diceAdj", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 生命值 <50% → 基础值 +2",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "hp", "comparison": "lt", "attrValue": "50%", "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+2" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 6 级【烧伤】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 6, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 自身每 10 级【烧伤】→ 目标 1D8 暴怒伤害",
    "trigger": "命中时",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 10, "perNDim": "intensity", "maxTimes": 0, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "extraDamage", "target": "target", "value": "1D8", "dmgCategory": "", "dmgSinType": "wrath" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 自身 2 层【烧伤】",
    "trigger": "攻击后",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 2 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

---

## 血天下鸡舞乱刀（【广域乱射7】）

```json
[
  {
    "name": "[攻击前] 自身 3 层【血炎】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "bloodFlame", "buffCustom": "", "intensity": 0, "stacks": 3 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 自身 10 级【烧伤】",
    "trigger": "攻击前",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 10, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 自身每 10 级【烧伤】攻击容量 +1（最大 2）",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 10, "perNDim": "intensity", "maxTimes": 2, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "weightAdj", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 自身每 10 级【烧伤】基础值 +1（最大 4）",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 10, "perNDim": "intensity", "maxTimes": 4, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "baseValue", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 目标【破裂】+【烧伤】强度和 ≥6 → 骰数 +1",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "buffCompare", "target": "target", "buffs": ["rupture", "burn"], "buff": "rupture", "buffCustom": "", "compareDim": "intensity", "comparison": "gte", "intensity": 6, "stacks": 0, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "diceAdj", "value": "+1" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击前] 生命值 <50% → 面数 +2",
    "trigger": "攻击前",
    "preconditions": [
      { "type": "baseAttr", "target": "self", "attrType": "hp", "comparison": "lt", "attrValue": "50%", "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [ { "type": "diceFacesAdj", "value": "+2" } ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 目标 6 级【烧伤】",
    "trigger": "命中时",
    "preconditions": [],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "target", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 6, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[命中时] 自身每 10 级【烧伤】→ 目标 1D8 暴怒伤害",
    "trigger": "命中时",
    "preconditions": [
      { "type": "perN", "target": "self", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 10, "perNDim": "intensity", "maxTimes": 0, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "extraDamage", "target": "target", "value": "1D8", "dmgCategory": "", "dmgSinType": "wrath" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[攻击后] 每消耗 5 级【烧伤】回 1D10 生命，并清空【血斗本能】",
    "trigger": "攻击后",
    "preconditions": [],
    "costs": [
      { "type": "perN", "target": "self", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 5, "perNDim": "intensity", "maxTimes": 0, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "effects": [
      { "type": "hpAdj", "target": "self", "value": "+1D10" },
      { "type": "removeBuff", "target": "self", "buff": "bloodDuelInstinct", "buffCustom": "" }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

> `removeBuff` 不吃倍数：烧伤不足 5 级时它照样清空【血斗本能】。想让「清除」只在真消耗
> 成功时发生，就把它拆成单独一条并加 `hasBuff burn intensity 5` 前置。

---

## 血斗本能 · 回合开始钩子

```json
[
  {
    "name": "[回合开始时] 有 10 层【血斗本能】→ 2 层【烧伤】＋1 层【强壮】",
    "trigger": "回合开始时",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "bloodDuelInstinct", "buffCustom": "", "intensity": 0, "stacks": 10, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 0, "stacks": 2 },
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "strong", "buffCustom": "", "intensity": 0, "stacks": 1 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  },
  {
    "name": "[回合开始时] 有 20 层【血斗本能】→ 额外 5 级【烧伤】",
    "trigger": "回合开始时",
    "preconditions": [
      { "type": "hasBuff", "target": "self", "buff": "bloodDuelInstinct", "buffCustom": "", "intensity": 0, "stacks": 20, "targetTag": "", "targetTagCount": 1, "targetTagMax": 0 }
    ],
    "costs": [],
    "effects": [
      { "type": "addBuff", "target": "self", "round": "本回合", "buff": "burn", "buffCustom": "", "intensity": 5, "stacks": 0 }
    ],
    "limit": { "type": "unlimited", "count": 0 }
  }
]
```

---

## 尚未注册的 BUFF

下面两个在 `custom-buffs.mjs` 里还没有注册键，本文一律写成
`"buff": "custom"` + `"buffCustom": "<中文名>"`。哪天注册了，把这两项换成注册键即可
（`buffCustom` 留空）：

- 【绝命】
- 【箭矢-死】

已注册、本文用到的键：`burn` `bleed` `rupture` `charge` `breathing` `swift` `strong`
`fragile` `shield` `atkLevelUp` `defLevelUp` `payload` `chargeField` `aimTarget`
`snipeStance` `piercingArrow` `bloodFlame` `bloodDuelInstinct`。
