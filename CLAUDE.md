# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A **Foundry VTT v13+** custom game system (system ID `limbusCompany_FVTT`), implementing a tabletop ruleset inspired by the *Limbus Company* universe. Pure ESM JavaScript + Handlebars, no build step, no bundler, no `package.json` — Foundry loads `module/limbusCompany_FVTT.mjs` and `styles/limbusCompany_FVTT.css` directly as declared in `system.json`.

Chinese (zh-CN) is the primary language for UI strings, chat output, and design docs; code comments are also predominantly Chinese. Match that when editing.

## Commands

There is no npm/build/lint/test tooling in this repo. Workflow instead is:

- **Syntax-check a changed file**: `node --check module/path/to/file.mjs` (catches typos/syntax errors before touching a running Foundry instance; run this on every `.mjs` file you edit).
- **Validate JSON**: `python3 -c "import json; json.load(open('system.json'))"` (or `template.json`) after editing either.
- **Run the system**: there is no local dev server in this repo — it only runs inside an actual Foundry VTT v13+ install with this repo linked/copied into `Data/systems/limbusCompany_FVTT`. There is no automated way to boot Foundry from this repo alone.
- **Schema changes require a world restart**: `TypeDataModel` schema edits (new fields on `CharacterData`, `ItemData` subclasses, etc.) are **not hot-reloadable** — Foundry must fully restart the world for `defineSchema()` changes to take effect. Template/CSS/JS logic changes reload fine; schema changes do not.
- **New template files must be preloaded**: any new `.hbs` partial or app template must be added to the `_preloadTemplates()` array in `module/limbusCompany_FVTT.mjs`, or Foundry will fail to find it at render time.
- **Check a prototype HTML's script**: the tuning labs (`scratchpad-*.html`) have no build step either — `node -e "const h=require('fs').readFileSync('FILE','utf8'); new Function('document','addEventListener','getComputedStyle','window', h.match(/<script>([\s\S]*)<\/script>/)[1]); console.log('OK')"` parses the inline script without a browser. Also worth a static id sweep: every `slider("x")` / `$("x")` must have a matching `id="x"` in the HTML — a missing one throws while binding and **silently kills every binding after it** (symptom: "only the first two sliders work").
- **New Item/Actor types must be registered in 3+ places** to work: `system.json` → `documentTypes`, `CONFIG.Actor.dataModels` / `CONFIG.Item.dataModels` in `module/limbusCompany_FVTT.mjs`, and the sheet template type-map in the relevant `*-sheet.mjs` (e.g. `LimbusItemSheet`'s template lookup in `module/sheets/item-sheet.mjs`). `template.json` is a legacy/compat placeholder — the real schema source of truth is the `TypeDataModel` classes in `module/documents/`, but keep `template.json`'s type lists roughly in sync since some Foundry tooling reads it.

## Architecture

### Document/data layer (`module/documents/`)

- `actor.mjs` — `LimbusActor extends Actor` (game logic: combat resolution helpers, level-up, long rest, chaos threshold triggers, buff application) plus `TypeDataModel` subclasses per Actor type: `CharacterData` (PCs — the core one, most fields), `MerchantData`, `CampData`, `LootData`.
- `item.mjs` — `LimbusItem extends Item` (mostly `sendToChat()` / title-card rendering) plus `TypeDataModel` subclasses per Item type: `EquipmentData`, `SkillData`, `ConsumableData`, `MaterialData`, `ContainerData`, `SkillBookData`, `PanicData`, `BackgroundData`.
- Every field lives under `system.*` via the `TypeDataModel` schema (`defineSchema()` using `foundry.data.fields.*`) — there is no legacy `template.json`-driven data, `template.json` is vestigial.

### Sheets (`module/sheets/`)

One `*Sheet` class per document type (`LimbusActorSheet`, `LimbusItemSheet`, `LimbusMerchantSheet`, `LimbusCampSheet`, `LimbusLootSheet`), plus standalone dialog/wizard `Application` subclasses that are not registered as a document's default sheet (`BackgroundWizard`, `LevelUpDialog`, `GMConsole`, `SquadHUD`, `QuickActionHUD`). Dialog/wizard classes are imported lazily (`await import(...)`) from the click handler that opens them, not eagerly at module load, to avoid bloating the main entry's import graph.

Recurring conventions across sheets — follow these when adding new ones:

- **Editable-lock pattern**: item sheets track `isLocked` (getter/setter) and gate all editable inputs on `(isEditable && !isLocked)` in the template; a `.sheet-lock-icon` toggles it via `_onToggleLock`. Actor sheet uses an analogous `_editUnlocked` flag toggled by `.sheet-lock-toggle`, applied via `_applyEditLockState(html)`.
- **Title Card hover preview**: `buildItemTitleCard(item)` (exported from `module/sheets/item-sheet.mjs`) builds a jQuery-wrapped preview card DOM node reused across every sheet that needs hover-preview of an item reference (background wizard, level-up rewards, camp/loot/merchant grids, equipment slots). Bind `mouseenter`/`mouseleave` to call it and `.remove()` it; position with `card.css({ position: "fixed", left, top, zIndex })`.
- **Item-reference schema shape**: `{ id, uuid, itemData }` (see `makeItemRefSchema()` in `item.mjs`) is the standard way a document schema references *another* item without embedding it — `uuid` for live resolution via `fromUuid()`, `itemData` as a `toObject()` snapshot fallback if the source item is later deleted/unavailable. Used by `BackgroundData.startingItems`/`levelRewards[].items`. Contrast with actually **embedding** a copy into `actor.items` (used for panic cards in `system.panicSlots`, because panic cards have `activities` that must execute via `_applyActivities` — a plain UUID reference can't run those).
- **Right-click context menus**: use the shared `_renderContextMenu(event, menuItems)` helper on `LimbusActorSheet` (`{ name, icon, callback }[]`) rather than building ad-hoc menus — see `_onEquipSlotContextMenu`, `_onSkillSlotContextMenu`, `_onBackgroundContextMenu` for the pattern, including confirm-before-destructive-action via `Dialog.confirm(...)`.
- **Search-input re-render pitfall**: any `Application`/`ItemSheet` that filters a list via a live search `<input>` and calls `this.render()` on every keystroke will destroy/recreate that `<input>` DOM node mid-keystroke, breaking IME composition (Chinese input) and occasionally duplicating characters. See `BackgroundWizard._bindSearchInput()` for the fix: skip re-render during `compositionstart`~`compositionend`, debounce re-render (~120ms) otherwise, and restore focus/caret position after render via saved `{ target, start, end }` state.
- **Multi-step wizard state**: `BackgroundWizard` and `LevelUpDialog` hold a `this.step` counter and branch the whole template on it (`{{#if (eq step N)}}`) rather than being separate Application instances per step — state (selections, search terms) persists on `this` across steps within one instance.

### Combat/game-logic engine (`module/helpers/clash.mjs`)

`ClashManager` is a large static-method class (no instances) that resolves attack/defense contests ("拼点"), damage application, buff effects, and Activity-trigger dispatch. Key pattern: **`ClashManager._safeDocUpdate(doc, data)`** — always use this (not `doc.update()` directly) when a client-side action needs to mutate an Actor/Item it may not own (e.g. the attacking player's client needs to update the defending player's Actor HP). It checks `doc.canUserModify(game.user, "update")`; if the current user lacks permission, it emits a `"system.limbusCompany_FVTT"` socket message (`type: "gmDocUpdate"`) that a GM client picks up and applies on the sender's behalf. This same socket channel is shared/dispatched to multiple handlers in the single `game.socket.on(...)` listener registered in `Hooks.once("init")` in `module/limbusCompany_FVTT.mjs` (`SinResourceHUD`, `ClashManager`, `LimbusMerchantSheet`, `LimbusCampSheet`, `LimbusLootSheet` each get a look via their own `handleSocketMsg`) — when adding a new cross-client mutation flow, add a case to that shared dispatch rather than registering a second `game.socket.on`.

#### Deferred settlement — everything lands on 【结算结果】

The single most load-bearing convention in `clash.mjs`. A clash **resolves** (rolls, activities, buffs) immediately, but nothing that changes HP or starts a new action happens until the player presses **【结算结果】** on the resulting card. Anything that fires mid-resolution must therefore be *queued*, not applied.

Each queue follows the same three-part shape — open at the start of `resolveClash`/`handleDirectTake`, let the card builder take it into `flags`, flush right after the card if no button exists to take it:

| Queue | Opens with | Card flag | Applied at settle by |
|---|---|---|---|
| 承受聚合 | `_beginTakeAgg()` | — (`_flushTakeAgg` after card) | `_recordTake` merges every take into one card per actor |
| 【流血】 | `_beginBleedBuf()` | `bleedMsgs` | `settleBleed()` |
| [追加伤害] | `_beginExtraDmgQueue()` | `extraDmg` | `runExtraDamage()` |
| 效果发起的新对抗 (`useSkill`) | `_beginSkillLaunchQueue()` | `skillLaunches` | `runSkillLaunches()` |
| 反应检查 | `_armReactionCheck()` | `reactionCheck` | `runReactionCheck()` |
| 【恐慌鉴定】 | `_beginPanicAgg()` | — (flushed after card) | `recordPanic` rows + two folds |

Settle order is chronological so the HP bar's 先前→现在 reads correctly: **流血 → 主伤害 → 不可摧毁反击 → 追加伤害 → `_flushTakeAgg` → 恐慌鉴定 → 发起对抗 → 反应检查**. The three settle handlers live in `renderChatMessage` in `module/limbusCompany_FVTT.mjs` (`clash-resolve` / `clash-counter` / `clash-block`).

Two rules that follow from this:

- **Never call `_applyAndSendTake` / `showInitiateDialog` / `ChatMessage.create` directly from an effect or hook that can run during a clash.** Try the queue first (`queueExtraDamage`, `queueSkillLaunch`, `pushAmbient`, `pushPanicActMsgs`) and only fall back to immediate when it returns `false` — that's the non-clash path ([使用时]、[回合开始时]、反应效果).
- **Branches without a 【结算结果】 button** (闪避成功 / 完全格挡 / 0 伤害格挡) must publish on the spot instead — `settleBleedNow()`, `_flushExtraDmg()`, `_flushReactionCheck()`. Conversely, if a rider (不可摧毁反击 or 追加伤害) has damage, `noTake` must become false so a button gets rendered at all.

#### Chat cards & message buckets

Cards share one look, built from `_chatHeader(actor, title)` + `_goldDivider()`: 拼点对抗 / 反击 / 格挡 / 单方面攻击 / 承受结算 / 容量扩散 / 装备激活 / 反应触发 / 援护防御 / 恐慌鉴定 / 先攻骰掷. Reusable pieces: `_buildScoreTable(r)`, `_buildDetailsFold(actMsgs, {label, color})`, `_hpBlock({...})`, `_preStr(pre)` / `_actAllStr(act)` (precondition & effect text), `_hlDamage(text)`.

Activity messages are **collected, never sent individually**. `ctx._actMsgs` is the per-resolution bucket that becomes the card's 「▼ 详细信息」 fold; `_ambientActMsgs` (via `pushAmbient`) is the fallback bucket for triggers with no fixed home ([陷入混乱时] can happen during a take *or* during round-end burn). When adding a trigger, decide which bucket it belongs to — a bare `ChatMessage.create` inside the clash flow is a bug, it jumps the queue and lands mid-card.

#### Temporary skill conversion (`relatedSkillConvert`)

`relDuration` (`permanent` / `afterUse` / `afterClash` / `endOfTurn`) makes a conversion revert itself. Revert is accounted **by slot, never by item id**: `replaceSkillSlot()` returns the array of slots it changed, and one revert record is pushed per slot. Two different slots can hold the same enhanced form (基础槽 + 守备槽 both → 黎明将至); reverting by id would rewrite both. Same rule downstream: `_replaceCombatBagSkill(old, new, limit)` takes a limit (1 when reverting) so the 6-bag and the quick HUD don't get over-written either.

### Buff/status extension point (`module/helpers/custom-buffs.mjs`)

`CustomBuffRegistry` (a `Map`) + `registerCustomBuff(type, handler)` lets buff types opt into extra hook callbacks (`onRoundEnd`, `modifySpeedRoll`, `onClashWin`, `beforeChaos`, `modifyResistances`) beyond the generic intensity/stacks model that `ClashManager` applies by default. `resolveBuffHandler(buff)` looks up by `buff.type` first, falling back to fuzzy match on `buff.name` vs. registered `label`. All hooks are optional; `ClashManager` checks `typeof handler?.hookName === "function"` before calling.

**Handlers must never call `ChatMessage.create` themselves.** Every message-producing hook reports by **returning a string**; the dispatcher decides where it goes (the current card's 详细信息 fold / 承受结算's 效果 rows / 先攻骰掷's round folds). Self-sent messages jump the deferred-settlement queue and land in the middle of the card sequence. This holds for `onAttack`, `onHit`, `onTakeDamage`, `onRoundStart`, `onRoundEnd`, `onSeismicBlast`, `onClashWin`/`onClashLose`, `onBuffGained`/`onBuffLost`, `onAllyHpDamage`. `ctx.dealDamage` inside `onHit` must go through `queueExtraDamage` too.

Special tremors (`specialTremor: true`) follow 【震颤】's rules wholesale: 0 层即消失 (`_pruneZeroTremors`), and `_addBuff` treats a passed-in 0 as 1 for the whole tremor family, not just base `tremor`.

### Canvas overlays (`module/helpers/token-ring-hud.mjs`, `ready-sparkle.mjs`)

`TokenRingHUD` draws the under-token 生命环 + 生命值 / 理智圆 / BUFF 图标行. Two things about it are easy to get wrong:

- **Which PIXI group.** Token artwork lives in `canvas.primary`; `Token` placeables (borders, bars) live in the interface group, which always paints **above every token's art**. An overlay added as a child of the token therefore covers neighbouring tokens no matter what `zIndex` says. `TokenRingHUD` adds its container to `canvas.primary` with `elevation`/`sort`/`sortLayer` instead, so it can be occluded by the token below it, and raises `sort` to `1e6` only while controlled/hovered. Coordinates are then **world** coordinates (`token.center`), and the container must be removed from `primary` by hand on destroy.
- **Sizes are authored at a 100px grid** and multiplied by `canvas.grid.size / 100` at draw time, so nothing needs re-tuning when the scene grid changes.

Visual parameters are tuned in a standalone HTML lab (`scratchpad-hp-ring.html`) whose panel exports JSON matching `TokenRingHUD.CFG` field-for-field — tune there, paste into `CFG`. The lab renders **top-down with no CSS 3D**, exactly like the Foundry canvas; the ring's "lying on the ground" look comes from a real perspective projection (regular polygon in a ground plane → `rotateX(tilt)` → divide by `persp`), and the band is a **filled polygon, not a stroke**, because a stroke's width is screen-space and would lose the near-thick/far-thin half of the perspective.

### Config constants (`module/config.mjs`)

All cross-cutting constants (sin types/labels/icon paths, damage types, EGO grades/costs, skill costs, level-up XP table) are mounted onto `CONFIG.LIMBUSCOMPANY` in `Hooks.once("init")`, not exported/imported piecemeal — reference via `CONFIG.LIMBUSCOMPANY.X` from anywhere at runtime (module-load-time imports of `config.mjs` are only used by the init hook itself and a few helpers that need the raw constant before `CONFIG` is populated).

### Design docs (authoritative for game rules)

`开发总览.md` is the project's own index/table-of-contents for design docs — read it first when you need the *rules rationale* behind a mechanic, not just its data shape. `策划文件/` holds the detailed rule specs (character sheet layout, clash/contest flow, item card specs per type) that this codebase implements; when a game-mechanic question isn't answerable from code alone, check the matching file there before guessing. `assets/icons/GUI/` has UI mockup screenshots used as pixel-reference during sheet/dialog implementation.

## Core data model quick-reference

Full formulas and constants: `module/config.mjs` (`LIMBUSCOMPANY.*`) and `CharacterData.defineSchema()` in `module/documents/actor.mjs` are the source of truth; below are the load-bearing ones worth knowing without opening those files.

- **HP**: `等级d10 + 体质×5`. **Sanity**: 5–95, default 50, ≤5 triggers 陷入恐慌 (panic). **AP**: fixed max 3, resets each turn end. **Speed**: `1D6 + 敏捷` (displayed as a range). **Stellar Motes**: cap 30 + 1 per level.
- **Attributes** (`str/agi/con/int/per/cha`): schema range 2–10 (character creation wizard currently constrains allocation to 2–8 — see `ATTR_MIN`/`ATTR_MAX` in `background-wizard.mjs`, a wizard-only clamp, not a schema change).
- **Chaos thresholds** (`system.chaosThresholds`, `[{ percent, triggered }]`): default 2 tiers (60%/30%); con>7 → 1 tier (50%); agi>7 → 3 tiers (20/50/80%). Each tier fires once (`triggered` latches permanently until long rest resets it), checked high-to-low, one tier per HP-drop event. 震颤引爆 (seismic burst) shifts all tier percentages forward permanently (stacking) until long rest.
- **Skill draw ("6-bag")**: combat UI concept only, not persisted to the actor — 2 active + 1 prepared drawn without replacement from the 6 equipped basic skills; reshuffle when exhausted.
- **Background system** (`BackgroundData` item type + `system.background.uuid` on `CharacterData`): a Background item is a *template*, referenced by plain UUID (not embedded) since it has no `activities` to run. `BackgroundWizard` (`module/sheets/background-wizard.mjs`) drives character creation: pick background (compendium/world browser, folder-name-based category filter) → allocate attribute points → pick panic cards (which *are* embedded into `system.panicSlots`, unlike the background reference itself, because panic cards need `activities` execution) → review/grant starting items.
- **Panic cards** (`PanicData`): `panicType` splits them into 士气低落 (`lowMorale`) and 陷入恐慌 (`panic`), one per slot in `system.panicSlots`; `""` means unset (legacy data) and is accepted by both slots. 士气低落 fires once per encounter when sanity first drops ≤30 (latched by the `lowMoraleFiredEncounter` flag, cleared on `combatStart`/`deleteCombat`); 陷入恐慌 runs the 1d10 vs 智力 坚定/恐慌 rolls at round end once sanity ≤10. The ④ effect `panicCardSwap` swaps a card in by name (searched across world items **and every compendium**, since panic cards aren't carried by the actor).
- **No 平局**: a dodge that ties counts as a successful dodge. There is no tie-break path — don't reintroduce one.
- **Level-up** (`LimbusActor.getLevelUpPreview()` / `.levelUpByXp()`, dialog in `module/sheets/level-up-dialog.mjs`): preview is a pure read (no mutation) so the dialog can show before/after values before the player confirms; `levelUpByXp()` applies the level, and grants any `BackgroundData.levelRewards` entries matching the new level.
