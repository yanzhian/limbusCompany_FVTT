/**
 * recipe-editor.mjs —— 配方编辑对话框（营地 & 配方表共用）
 *
 * 营地（CampData.recipes）和配方表物品（RecipeBookData.recipes）用的是同一套配方
 * 结构，编辑界面也完全一样，所以抽出来一处维护：
 *   { id, name, hidden, ingredients:[{name,img,quantity}],
 *     outputName, outputImg, outputQuantity, outputItemData }
 *
 * 调用方只负责"存到哪儿"——把改好的配方对象交回 onSave 即可。
 */

const DEFAULT_IMG = "icons/svg/item-bag.svg";

/** 新建一条空配方 */
export function makeBlankRecipe() {
  return {
    id: foundry.utils.randomID(), name: "新配方", hidden: false,
    ingredients: [], outputName: "", outputImg: DEFAULT_IMG,
    outputQuantity: 1, outputItemData: null,
  };
}

function _dragData(event) {
  try { return JSON.parse(event.dataTransfer?.getData("text/plain") ?? "{}"); }
  catch { return null; }
}

/**
 * 打开配方编辑对话框。
 * @param {object}   recipe  当前配方（不会被就地修改）
 * @param {Function} onSave  async (newRecipe) => void
 * @param {string}  [title]  对话框标题
 */
export function openRecipeEditor(recipe, onSave, title = null) {
  const esc = foundry.utils.escapeHTML;

  const buildIngRow = (ing, idx) => `
    <div class="camp-recipe-ing-row" data-idx="${idx}">
      <img src="${ing.img || DEFAULT_IMG}" width="22" height="22"
           class="camp-ing-drag-target" title="拖拽物品到此处自动填入">
      <input type="text"   class="camp-ing-name" value="${esc(ing.name)}" placeholder="原料名称" style="width:130px"/>
      <span>×</span>
      <input type="number" class="camp-ing-qty"  value="${ing.quantity}" min="1" style="width:50px"/>
      <button type="button" class="camp-ing-remove" title="移除">×</button>
    </div>`;

  let pendingOutputItemData = recipe.outputItemData ? foundry.utils.deepClone(recipe.outputItemData) : null;
  let pendingOutputImg      = recipe.outputImg || DEFAULT_IMG;

  new Dialog({
    title: title ?? `编辑配方：${recipe.name}`,
    content: `
      <form class="limbuscompany camp-recipe-editor" autocomplete="off">
        <div class="camp-editor-row">
          <label>配方名称</label>
          <input type="text" id="re-name" value="${esc(recipe.name)}" style="flex:1"/>
        </div>
        <div class="camp-editor-section-title">原料</div>
        <div id="re-ing-list" class="camp-editor-ing-list">
          ${(recipe.ingredients ?? []).map((ing, i) => buildIngRow(ing, i)).join("")}
        </div>
        <button type="button" id="re-add-ing" class="camp-editor-add-btn">+ 添加原料</button>
        <div class="camp-editor-section-title">产出</div>
        <div class="camp-editor-row camp-editor-output-row">
          <img id="re-output-img" src="${pendingOutputImg}" width="32" height="32"
               class="camp-output-drag-target" title="拖拽物品到此处自动填入">
          <input type="text"   id="re-output-name" value="${esc(recipe.outputName || "")}" placeholder="产出物品名称" style="width:140px"/>
          <span>×</span>
          <input type="number" id="re-output-qty"  value="${recipe.outputQuantity || 1}" min="1" style="width:50px"/>
        </div>
        ${pendingOutputItemData
          ? `<div class="camp-editor-hint" style="color:#7CFC00" id="re-output-status">✓ 已绑定产出物品</div>`
          : `<div class="camp-editor-hint" style="color:orange" id="re-output-status">⚠ 尚未绑定产出物品</div>`}
        <div class="camp-editor-hint">将物品图标拖到产出区域或原料图标处，自动填入名称与图片</div>
      </form>`,
    buttons: {
      save: {
        label: "保存",
        callback: async (html) => {
          const name    = html.find("#re-name").val()?.trim() || recipe.name;
          const outName = html.find("#re-output-name").val()?.trim() || "";
          const outQty  = Math.max(1, parseInt(html.find("#re-output-qty").val()) || 1);

          const ingredients = [];
          html.find(".camp-recipe-ing-row").each((_, row) => {
            const $row    = $(row);
            const ingName = $row.find(".camp-ing-name").val()?.trim();
            const ingQty  = Math.max(1, parseInt($row.find(".camp-ing-qty").val()) || 1);
            const ingImg  = $row.find("img").attr("src") || DEFAULT_IMG;
            if (ingName) ingredients.push({ name: ingName, img: ingImg, quantity: ingQty });
          });

          await onSave({
            ...recipe, name, ingredients,
            outputName: outName, outputImg: pendingOutputImg,
            outputQuantity: outQty, outputItemData: pendingOutputItemData,
          });
        },
      },
      cancel: { label: "取消" },
    },
    default: "save",
    render: (html) => {
      const bindRow = ($row) => {
        $row.find(".camp-ing-remove").on("click", () => $row.remove());
        const imgEl = $row.find("img.camp-ing-drag-target")[0];
        imgEl.addEventListener("dragover", e => e.preventDefault());
        imgEl.addEventListener("drop", async e => {
          e.preventDefault();
          const data = _dragData(e);
          if (!data || data.type !== "Item") return;
          const itm = await fromUuid(data.uuid);
          if (!itm) return;
          $(imgEl).attr("src", itm.img);
          $row.find(".camp-ing-name").val(itm.name);
        });
      };

      html.find("#re-add-ing").on("click", () => {
        const idx    = html.find(".camp-recipe-ing-row").length;
        const newRow = $(buildIngRow({ name: "", img: DEFAULT_IMG, quantity: 1 }, idx));
        html.find("#re-ing-list").append(newRow);
        bindRow(newRow);
      });
      html.find(".camp-recipe-ing-row").each((_, row) => bindRow($(row)));

      const outImgEl = html.find("#re-output-img")[0];
      outImgEl.addEventListener("dragover", e => e.preventDefault());
      outImgEl.addEventListener("drop", async e => {
        e.preventDefault();
        const data = _dragData(e);
        if (!data || data.type !== "Item") return;
        const itm = await fromUuid(data.uuid);
        if (!itm) return;
        pendingOutputItemData = itm.toObject();
        pendingOutputImg      = itm.img;
        $(outImgEl).attr("src", itm.img);
        html.find("#re-output-name").val(itm.name);
        html.find("#re-output-status").text("✓ 已绑定产出物品：" + itm.name).css("color", "#7CFC00");
      });
    },
  }).render(true);
}
