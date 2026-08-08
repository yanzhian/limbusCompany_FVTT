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

### Buff/status extension point (`module/helpers/custom-buffs.mjs`)

`CustomBuffRegistry` (a `Map`) + `registerCustomBuff(type, handler)` lets buff types opt into extra hook callbacks (`onRoundEnd`, `modifySpeedRoll`, `onClashWin`, `beforeChaos`, `modifyResistances`) beyond the generic intensity/stacks model that `ClashManager` applies by default. `resolveBuffHandler(buff)` looks up by `buff.type` first, falling back to fuzzy match on `buff.name` vs. registered `label`. All hooks are optional; `ClashManager` checks `typeof handler?.hookName === "function"` before calling.

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
- **Level-up** (`LimbusActor.getLevelUpPreview()` / `.levelUpByXp()`, dialog in `module/sheets/level-up-dialog.mjs`): preview is a pure read (no mutation) so the dialog can show before/after values before the player confirms; `levelUpByXp()` applies the level, and grants any `BackgroundData.levelRewards` entries matching the new level.
