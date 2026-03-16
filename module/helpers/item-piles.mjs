/**
 * item-piles.mjs — Item Piles 模块联动
 *
 * 向 Item Piles 注册本系统的配置，启用：
 *   - 战利品堆（Loot Pile）
 *   - 商人（Merchant）：使用"眼"作为货币
 *   - 金库（Vault）：利用 system.capacity.w/h 映射格子尺寸
 *
 * 调用时机：Hooks.once("item-piles-ready", ...)
 */

const ICON_BASE = "systems/limbusCompany_FVTT/assets/icons/Base_icon";

export function registerItemPiles() {
  if (!game.itempiles?.API) return;

  game.itempiles.API.registerSystem({

    // ── API 版本（Item Piles v2.x）─────────────────────────────────────
    VERSION: "1.0.0",

    // ── 创建 Pile Actor 时默认使用的角色类型 ──────────────────────────
    ACTOR_CLASS_TYPE: "character",

    // ── 物品数量字段路径（消耗品、材料、装备均使用此路径）────────────
    ITEM_QUANTITY_ATTRIBUTE: "system.quantity",

    // ── 物品眼价格字段路径（用于商人定价）───────────────────────────
    ITEM_PRICE_ATTRIBUTE: "system.cost",

    // ── 金库格占用：映射到物品容量字段 ───────────────────────────────
    // Item Piles 会据此在 Vault 网格中为物品分配对应格数
    ITEM_COLUMNS_ATTRIBUTE: "system.capacity.w",
    ITEM_ROWS_ATTRIBUTE:    "system.capacity.h",

    // ── 物品过滤：技能不可拾取/出售/存入金库 ─────────────────────────
    ITEM_FILTERS: [
      { path: "type", filters: "skill" },
    ],

    // ── 物品相似性判断（同名同类型视为同一物品，可堆叠）─────────────
    ITEM_SIMILARITIES: ["name", "type"],

    // ── 货币定义（眼，角色属性路径）──────────────────────────────────
    CURRENCIES: [
      {
        type:             "attribute",
        name:             "眼",
        img:              `${ICON_BASE}/眼.webp`,
        abbreviation:     "{#}眼",
        data:             { path: "system.currency" },
        primary:          true,
        transferCurrency: true,
      },
    ],

    // ── 金库外观风格（可在 Item Piles 界面中选择）────────────────────
    VAULT_STYLES: [
      {
        label:   "边狱公司",
        value:   "limbus",
        default: true,
        styles:  {
          "--item-piles-vault-background":   "#0B0707",
          "--item-piles-vault-border-color": "#5F3E22",
          "--item-piles-vault-header-bg":    "#1A130D",
        },
      },
    ],

    // ── 默认战利品堆设置（可选，覆盖 Item Piles 默认值）────────────
    PILE_DEFAULTS: {
      // 初始状态为关闭的容器，需与人物互动才打开
      closed:          true,
      closedImage:     `${ICON_BASE}/bag.webp`,
      openedImage:     `${ICON_BASE}/bag.webp`,
      // 堆文字标签
      tokenName:       "战利品",
    },

  });

  console.log("limbusCompany_FVTT | Item Piles 联动注册完成。");
}
