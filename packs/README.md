# packs/ — 系统自带的合集包（Compendium）

这些合集包在 `system.json` 的 `packs` 里声明，随系统一起分发：别人装上
`limbusCompany_FVTT` 就自带全套内容，不需要另外导入世界。

| 目录 | 内容 | 文档类型 |
|---|---|---|
| `equipment/`   | 装备（武器 / 上装 / 下装 / 饰品） | Item |
| `skills/`      | 基础技能 / 守备技能 / E.G.O       | Item |
| `consumables/` | 消耗品、材料                      | Item |
| `containers/`  | 容器                              | Item |
| `skillbooks/`  | 技能书                            | Item |
| `panics/`      | 恐慌卡                            | Item |
| `backgrounds/` | 背景                              | Item |
| `npcs/`        | 预设角色、商人、营地、战利品      | Actor |
| `adventures/`  | 冒险整合包（一键导入整套内容）    | Adventure |

## 怎么往里放东西

1. 启动世界，侧边栏「合集包」里会看到上面这些包（首次启动时 Foundry 会
   自动在本目录下建好对应的 LevelDB 数据库）。
2. 包默认是**锁定**的，右键 → 「切换锁定」解锁后才能拖入内容。
3. 把世界里做好的物品/角色拖进去；改完记得**重新锁上**，免得误改。
4. 关闭世界（重要，见下），然后 `git add packs/ && git commit`。

批量做卡建议先用系统自带的 **CSV 导入**（物品目录右上角），做完再拖进合集包。

## 提交前务必关闭世界

v11 以后合集包是 **LevelDB 目录**（`*.ldb` / `MANIFEST-*` / `CURRENT` / `LOG` / `LOCK`），
世界运行时数据库处于打开状态，此时提交可能拿到写了一半的文件。
**先关世界，再提交**。`LOCK` 与 `LOG*` 属于运行期产物，已在 `.gitignore` 里排除。

## 关于冲突

LevelDB 是二进制的，git 无法合并。多人同时改同一个包会冲突且**无法手工解决**，
只能二选一。所以：同一时间只让一个人改合集包，或者改之前先说一声。

## Adventure（冒险整合包）

`adventures/` 用来放 Adventure 文档——把一批 Actor / Item / Scene / Journal /
Macro / RollTable / Playlist 打包成**一个**文档，玩家点一下即可整套导入，
还能选择性覆盖已有内容。发布成品剧本用它最省事。
