/**
 * clash.mjs — 对抗流程管理器
 * 全流程：发起对抗 → 聊天框 → 进行对抗确认 → 进行对抗 → 拼点结算 → 承受
 */

const OCTA_CLIP = "polygon(25% 0%,75% 0%,100% 25%,100% 75%,75% 100%,25% 100%,0% 75%,0% 25%)";
const OCTA_STYLE = `clip-path:${OCTA_CLIP};object-fit:cover;`;

export class ClashManager {

  /* ─── 工具函数 ─────────────────────────────────────────────────────────── */

  static _catIcon(cat) {
    return CONFIG.LIMBUSCOMPANY?.CATEGORY_ICON_PATHS?.[cat] ?? "";
  }

  static _catLabel(cat) {
    return CONFIG.LIMBUSCOMPANY?.CATEGORY_LABELS_ZH?.[cat] ?? cat ?? "";
  }

  static _sinColor(sinType) {
    return CONFIG.LIMBUSCOMPANY?.SIN_COLORS?.[sinType] ?? "#E8CAA2";
  }

  static _parseResistance(resStr) {
    if (!resStr) return 1.0;
    const m = String(resStr).match(/x?([0-9.]+)/i);
    return m ? parseFloat(m[1]) : 1.0;
  }

  static _getBuff(actor, type) {
    return (actor?.system?.buffs ?? []).find(b => b.type === type) ?? null;
  }

  static _getBuffVal(actor, type) {
    const b = ClashManager._getBuff(actor, type);
    return { intensity: b?.intensity ?? 0, stacks: b?.stacks ?? 0 };
  }

  static _effectDesc(item) {
    const sys = item?.system ?? {};
    const parts = [];
    if (sys.effectDesc) parts.push(sys.effectDesc);
    if (Array.isArray(sys.activities)) {
      for (const act of sys.activities) {
        if (!act.trigger) continue;
        const effStr = ClashManager._actStr(act);
        if (effStr) parts.push(`[${act.trigger}] ${effStr}`);
      }
    }
    return parts.join(" | ");
  }

  static _actStr(act) {
    const t = act.effect?.type ?? "";
    const tgt = act.effect?.target === "self" ? "自己" : "目标";
    if (t === "addBuff") return `为${tgt}添加 ${act.effect.stacks ?? 1} 层 ${act.effect.buff ?? ""}`;
    if (t === "hpAdj")   return `${tgt}生命值 ${(act.effect.intensity ?? 0) >= 0 ? "+" : ""}${act.effect.intensity}`;
    return "";
  }

  static _goldDivider() {
    return `<div style="height:1px;margin:8px 0;background:linear-gradient(90deg,transparent 0%,#C9A84C 30%,#C9A84C 70%,transparent 100%);"></div>`;
  }

  static _chatHeader(actor, title) {
    const img  = actor?.img ?? "icons/svg/mystery-man.svg";
    const name = actor?.name ?? "未知";
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <img src="${img}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;border:2px solid #C9A84C;flex-shrink:0;" alt="">
        <div>
          <div style="font-size:20px;font-weight:bold;color:#E8C9A2;">${title}</div>
          <div style="font-size:13px;color:#E8CAA1;">${name}</div>
        </div>
      </div>`;
  }

  static _skillRow(item) {
    const sys      = item?.system ?? {};
    const catIcon  = ClashManager._catIcon(sys.category);
    const catLabel = ClashManager._catLabel(sys.category);
    const sinColor = ClashManager._sinColor(sys.sinType);
    const formula  = sys.diceFormula ?? "1d4";
    return `
      <div style="display:flex;align-items:center;gap:12px;margin:8px 0;">
        <img src="${item.img}" style="width:50px;height:50px;${OCTA_STYLE}border:2px solid ${sinColor};flex-shrink:0;" alt="${item.name}">
        <div>
          <div style="font-size:24px;font-weight:bold;color:#E8C9A2;">${item.name}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:3px;">
            ${catIcon ? `<img src="${catIcon}" style="width:24px;height:24px;" alt="${catLabel}">` : ""}
            <span style="font-size:24px;color:#EBBD68;">${formula.toUpperCase()}</span>
          </div>
        </div>
      </div>`;
  }

  /* ─── 阶段一：发起对抗弹窗 ────────────────────────────────────────────── */

  static async showInitiateDialog(actor, item, slotIndex = -1) {
    const sys      = item.system ?? {};
    const formula  = sys.diceFormula ?? "1d4";
    const catIcon  = ClashManager._catIcon(sys.category);
    const catLabel = ClashManager._catLabel(sys.category);

    const content = `
      <div class="limbuscompany clash-dialog-v2">
        <div style="font-size:24px;font-weight:bold;color:#E8C9A2;margin-bottom:8px;">${item.name}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
          ${catIcon ? `<img src="${catIcon}" style="width:24px;height:24px;" alt="${catLabel}">` : ""}
          <span style="font-size:24px;color:#EBBD68;">${formula.toUpperCase()}</span>
        </div>
        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:.75rem;color:#9A8462;margin-bottom:4px;">加值修正</label>
          <input type="text" name="bonus" placeholder="±N 或 1d4+2"
                 style="width:100%;box-sizing:border-box;background:#1A1208;border:1px solid #C9A84C;
                        color:#E8C9A2;font-size:.85rem;padding:6px 8px;border-radius:3px;outline:none;">
        </div>
      </div>`;

    return new Promise(resolve => {
      new Dialog({
        title: "发起对抗",
        content,
        buttons: {
          clash: {
            label: "发起对抗",
            callback: async (dlg) => {
              const bonusStr = dlg.find("[name='bonus']").val()?.trim() || "";
              const bonus    = parseInt(bonusStr) || 0;
              const full     = bonus !== 0 ? `${formula}${bonus >= 0 ? "+" : ""}${bonus}` : formula;
              const roll     = new Roll(full);
              await roll.evaluate();
              await ClashManager._sendInitiateMsg(actor, item, roll, full, slotIndex);
              resolve(true);
            },
          },
          cancel: { label: "取消", callback: () => resolve(false) },
        },
        default: "clash",
        render: (dlg) => {
          dlg.closest(".dialog").find(".dialog-button.clash").css({
            background: "#5F3E22", color: "#E8C9A2", border: "none",
            "font-size": "1rem", "font-weight": "bold",
            padding: "8px 0", width: "100%", cursor: "pointer",
          });
        },
      }).render(true);
    });
  }

  /* ─── 阶段二：发起对抗聊天框 ──────────────────────────────────────────── */

  static async _sendInitiateMsg(actor, item, roll, formula, slotIndex) {
    const sys        = item.system ?? {};
    const effectDesc = ClashManager._effectDesc(item);

    const content = `
      <div class="limbus-clash-card" data-clash-type="initiate">
        ${ClashManager._chatHeader(actor, "发起对抗")}
        ${ClashManager._goldDivider()}
        ${ClashManager._skillRow(item)}
        <div class="clash-action-row" style="display:flex;gap:8px;margin-top:8px;margin-bottom:4px;">
          <button class="clash-btn-clash"
                  style="width:48px;height:30px;background:#5F3E22;color:#E8C9A2;
                         border:1px solid #C9A84C;cursor:pointer;font-size:.85rem;border-radius:2px;">对抗</button>
          <button class="clash-btn-take"
                  style="width:48px;height:30px;background:#B84444;color:#fff;
                         border:none;cursor:pointer;font-size:.85rem;border-radius:2px;">承受</button>
        </div>
        ${ClashManager._goldDivider()}
        ${effectDesc ? `<div style="font-size:.8rem;color:#9A8462;line-height:1.5;">${effectDesc}</div>` : ""}
      </div>`;

    const msg = await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content,
      flags: {
        limbusCompany_FVTT: {
          type:        "clash-initiate",
          attackerId:  actor.id,
          itemId:      item.id,
          rollTotal:   roll.total,
          formula,
          itemName:    item.name,
          itemImg:     item.img,
          category:    sys.category ?? "",
          sinType:     sys.sinType  ?? "",
          effectDesc,
          slotIndex,
        },
      },
    });

    // 推进战斗槽 + 扣 AP（若从战斗槽触发）
    if (slotIndex >= 0) {
      const sheet = actor.sheet;
      if (sheet?._combatBagState) {
        sheet._animateCombatSkillUse?.(slotIndex);
        setTimeout(async () => {
          const ap = actor.system.ap?.value ?? 0;
          if (ap > 0) await actor.update({ "system.ap.value": ap - 1 });
        }, 700);
      }
    }
  }

  /* ─── 阶段三：进行对抗技能选择弹窗（玩家B） ─────────────────────────── */

  static showRespondDialog(msgId, initFlags) {
    // 防守方：当前用户控制的角色
    const defActor =
      game.user.character ??
      canvas.tokens?.controlled?.[0]?.actor ??
      null;

    if (!defActor) {
      ui.notifications.warn("请先选中你的角色 Token 或在用户设置中指定角色");
      return;
    }

    ClashManager._buildPickerDialog(defActor, (chosenItem) => {
      ClashManager.showPerformDialog(defActor, chosenItem, msgId, initFlags);
    });
  }

  static _buildPickerDialog(actor, onPick) {
    const sheet    = actor.sheet;
    const bagState = sheet?._combatBagState;
    const sys      = actor.system;
    const basicIds = sys.skills?.basic ?? [];
    const cfg      = CONFIG.LIMBUSCOMPANY ?? {};

    // 顶部3格：激活1 / 激活2 / 守备
    const slot0Id   = bagState?.slots?.[0] ?? basicIds[0] ?? null;
    const slot1Id   = bagState?.slots?.[1] ?? basicIds[1] ?? null;
    const defenseId = sys.skills?.defense ?? null;

    const getItem = (id) => id ? actor.items.get(id) : null;

    const active0  = getItem(slot0Id);
    const active1  = getItem(slot1Id);
    const defItem  = getItem(defenseId);

    // 剩余基础技能格（bag槽 2-5，或直接取 equip 数组）
    const restIds = bagState
      ? bagState.slots.slice(2).filter(Boolean)
      : basicIds.slice(2).filter(Boolean);
    const restItems = restIds.map(id => getItem(id)).filter(Boolean);

    // EGO 技能
    const egoEntries = (cfg.EGO_GRADES ?? []).map(grade => ({
      grade,
      item: getItem(sys.skills?.ego?.[grade] ?? null),
    }));

    // ─── slot HTML 工厂 ───
    const octaSlotHtml = (item, extraClass = "") => {
      if (!item) {
        return `<div class="clash-pick-slot clash-pick-empty" style="width:52px;height:52px;"></div>`;
      }
      const sin = ClashManager._sinColor(item.system?.sinType);
      const hasRel = !!(item.system?.relatedSkill?.itemUuid);
      return `
        <div class="clash-pick-slot ${extraClass}" data-item-id="${item.id}" title="${item.name}"
             style="position:relative;width:52px;height:52px;cursor:pointer;flex-shrink:0;">
          <img src="${item.img}"
               style="width:52px;height:52px;${OCTA_STYLE}border:2px solid ${sin};"
               alt="${item.name}">
          ${hasRel ? `<button class="clash-pick-rel" data-base-id="${item.id}"
                               title="切换相关技能"
                               style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;
                                      border-radius:50%;border:1px solid #C9A84C;background:none;
                                      color:#9A8462;font-size:9px;cursor:pointer;padding:0;
                                      line-height:16px;text-align:center;">↺</button>` : ""}
        </div>`;
    };

    const circleSlotHtml = (item, grade = "") => {
      const sin = item ? ClashManager._sinColor(item.system?.sinType) : "#3A2A18";
      const opacity = item ? "1" : "0.3";
      return `
        <div style="display:flex;flex-direction:column;align-items:center;gap:3px;">
          ${item
            ? `<div class="clash-pick-slot" data-item-id="${item.id}" title="${item.name}"
                    style="width:52px;height:52px;border-radius:50%;overflow:hidden;
                           border:2px solid ${sin};cursor:pointer;flex-shrink:0;">
                 <img src="${item.img}" style="width:100%;height:100%;object-fit:cover;" alt="${item.name}">
               </div>`
            : `<div style="width:52px;height:52px;border-radius:50%;border:2px solid #3A2A18;opacity:.3;"></div>`
          }
          ${grade ? `<span style="font-size:9px;color:${item ? "#9A8462" : "#4A3A28"};">${grade}</span>` : ""}
        </div>`;
    };

    const topRow = `
      <div style="display:flex;gap:16px;justify-content:center;padding:10px 0 28px;">
        ${octaSlotHtml(active0, "clash-pick-active")}
        ${octaSlotHtml(active1, "clash-pick-active")}
        ${octaSlotHtml(defItem)}
      </div>`;

    const expandedHtml = `
      <div class="clash-pick-expanded" style="display:none;">
        ${ClashManager._goldDivider()}
        <div style="display:flex;flex-wrap:wrap;gap:16px;justify-content:center;padding:8px 0 16px;">
          ${restItems.map(it => octaSlotHtml(it)).join("")}
        </div>
        ${egoEntries.some(e => e.item) ? `
          <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;padding:4px 0 8px;">
            ${egoEntries.map(e => circleSlotHtml(e.item, e.grade)).join("")}
          </div>` : ""}
      </div>`;

    const content = `
      <div class="limbuscompany clash-pick-dialog" style="min-width:260px;">
        ${topRow}
        <div style="text-align:center;margin-bottom:6px;">
          <button class="clash-pick-expand-btn"
                  style="background:none;border:none;color:#C9A84C;font-size:1.3rem;cursor:pointer;">▼</button>
        </div>
        ${expandedHtml}
      </div>`;

    const dlg = new Dialog({
      title: "拼点对抗",
      content,
      buttons: {},
      render: (dlgHtml) => {
        // 展开/折叠
        dlgHtml.find(".clash-pick-expand-btn").on("click", (e) => {
          const $exp = dlgHtml.find(".clash-pick-expanded");
          const open = $exp.is(":visible");
          $exp.toggle(!open);
          $(e.currentTarget).text(open ? "▼" : "▲");
        });

        // 选中技能
        dlgHtml.on("click", ".clash-pick-slot:not(.clash-pick-empty)", (e) => {
          if ($(e.target).hasClass("clash-pick-rel")) return; // 不触发 related toggle
          const itemId = e.currentTarget.dataset.itemId;
          const item   = actor.items.get(itemId);
          if (!item) return;
          dlg.close();
          onPick(item);
        });

        // 切换相关技能
        dlgHtml.on("click", ".clash-pick-rel", (e) => {
          e.stopPropagation();
          const $btn   = $(e.currentTarget);
          const baseId = $btn.data("base-id");
          const base   = actor.items.get(baseId);
          if (!base) return;
          const relUuid = base.system?.relatedSkill?.itemUuid;
          if (!relUuid) return;

          $btn.toggleClass("rel-active");
          const $slot = $btn.closest(".clash-pick-slot");

          if ($btn.hasClass("rel-active")) {
            const relItem = typeof fromUuidSync !== "undefined" ? fromUuidSync(relUuid) : null;
            if (relItem) {
              $slot.data("item-id", relItem.id).attr("data-item-id", relItem.id);
              $slot.find("img").attr("src", relItem.img);
              $btn.css("color", "#6EE06E").css("border-color", "#6EE06E");
            }
          } else {
            $slot.data("item-id", baseId).attr("data-item-id", baseId);
            $slot.find("img").attr("src", base.img);
            $btn.css("color", "#9A8462").css("border-color", "#C9A84C");
          }
        });
      },
    }, { width: 320 });

    dlg.render(true);
  }

  /* ─── 阶段四：进行对抗弹窗（与发起对抗一致，标题/按钮不同） ─────────── */

  static async showPerformDialog(defActor, defItem, initMsgId, initFlags) {
    const sys     = defItem.system ?? {};
    const formula = sys.diceFormula ?? "1d4";
    const catIcon = ClashManager._catIcon(sys.category);
    const catLabel = ClashManager._catLabel(sys.category);

    const content = `
      <div class="limbuscompany clash-dialog-v2">
        <div style="font-size:24px;font-weight:bold;color:#E8C9A2;margin-bottom:8px;">${defItem.name}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
          ${catIcon ? `<img src="${catIcon}" style="width:24px;height:24px;" alt="${catLabel}">` : ""}
          <span style="font-size:24px;color:#EBBD68;">${formula.toUpperCase()}</span>
        </div>
        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:.75rem;color:#9A8462;margin-bottom:4px;">加值修正</label>
          <input type="text" name="bonus" placeholder="±N 或 1d4+2"
                 style="width:100%;box-sizing:border-box;background:#1A1208;border:1px solid #C9A84C;
                        color:#E8C9A2;font-size:.85rem;padding:6px 8px;border-radius:3px;outline:none;">
        </div>
      </div>`;

    return new Promise(resolve => {
      new Dialog({
        title: "进行对抗",
        content,
        buttons: {
          perform: {
            label: "进行对抗",
            callback: async (dlg) => {
              const bonusStr = dlg.find("[name='bonus']").val()?.trim() || "";
              const bonus    = parseInt(bonusStr) || 0;
              const full     = bonus !== 0 ? `${formula}${bonus >= 0 ? "+" : ""}${bonus}` : formula;
              const roll     = new Roll(full);
              await roll.evaluate();
              await ClashManager._sendResponseAndResolve(
                defActor, defItem, roll, full, initMsgId, initFlags
              );
              resolve(true);
            },
          },
          cancel: { label: "取消", callback: () => resolve(false) },
        },
        default: "perform",
        render: (dlg) => {
          dlg.closest(".dialog").find(".dialog-button.perform").css({
            background: "#5F3E22", color: "#E8C9A2", border: "none",
            "font-size": "1rem", "font-weight": "bold",
            padding: "8px 0", width: "100%", cursor: "pointer",
          });
        },
      }).render(true);
    });
  }

  /* ─── 阶段五：进行对抗聊天框 + 自动拼点结算 ─────────────────────────── */

  static async _sendResponseAndResolve(defActor, defItem, defRoll, defFormula, initMsgId, initFlags) {
    const sys        = defItem.system ?? {};
    const effectDesc = ClashManager._effectDesc(defItem);

    // 进行对抗聊天框（对抗按钮置灰，无承受按钮）
    const responseContent = `
      <div class="limbus-clash-card" data-clash-type="response">
        ${ClashManager._chatHeader(defActor, "进行对抗")}
        ${ClashManager._goldDivider()}
        ${ClashManager._skillRow(defItem)}
        <div style="display:flex;gap:8px;margin-top:8px;margin-bottom:4px;">
          <button disabled style="width:48px;height:30px;background:#3A3028;color:#6A5A48;
                                  border:1px solid #4A3820;font-size:.85rem;cursor:not-allowed;
                                  border-radius:2px;">对抗</button>
        </div>
        ${ClashManager._goldDivider()}
        ${effectDesc ? `<div style="font-size:.8rem;color:#9A8462;line-height:1.5;">${effectDesc}</div>` : ""}
      </div>`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: defActor }),
      content: responseContent,
      flags: {
        limbusCompany_FVTT: {
          type:       "clash-response",
          defenderId: defActor.id,
          itemId:     defItem.id,
          rollTotal:  defRoll.total,
          formula:    defFormula,
          itemName:   defItem.name,
          itemImg:    defItem.img,
          category:   sys.category ?? "",
          sinType:    sys.sinType  ?? "",
        },
      },
    });

    // 扣防守方 AP
    const defAp = defActor.system.ap?.value ?? 0;
    if (defAp > 0) await defActor.update({ "system.ap.value": defAp - 1 });

    // 拼点结算
    const atkActor = game.actors.get(initFlags.attackerId);
    const resolution = ClashManager._computeResolution({
      atkActor,    atkTotal:    initFlags.rollTotal,   atkFormula:  initFlags.formula,
      atkItemName: initFlags.itemName, atkItemImg: initFlags.itemImg, atkCategory: initFlags.category,
      defActor,    defTotal:    defRoll.total,         defFormula,
      defItemName: defItem.name,       defItemImg: defItem.img,       defCategory: sys.category ?? "",
    });

    await ClashManager._sendResolveMsg(resolution, initFlags, defActor, defItem, defFormula);
  }

  /* ─── 阶段五b：拼点结算逻辑 ────────────────────────────────────────────── */

  static _computeResolution({ atkActor, atkTotal, atkFormula, atkItemName, atkItemImg, atkCategory,
                               defActor, defTotal, defFormula, defItemName, defItemImg, defCategory }) {
    const atkWins    = atkTotal >= defTotal;
    const winner     = atkWins ? atkActor : defActor;
    const loser      = atkWins ? defActor : atkActor;
    const winScore   = atkWins ? atkTotal : defTotal;
    const loseScore  = atkWins ? defTotal : atkTotal;
    const winCat     = atkWins ? atkCategory : defCategory;

    // 攻防等级差
    const atkLv  = (atkWins ? atkActor : defActor)?.system?.atk?.base ?? 0;
    const defLv  = (atkWins ? defActor : atkActor)?.system?.def?.base ?? 0;
    const lvDiff = Math.abs(atkLv - defLv);
    const lvBonus = Math.floor(lvDiff / 3);

    // BUFF 修正（胜者）
    const pwrUp   = ClashManager._getBuffVal(winner, "clashPowerUp").intensity;
    const pwrDown = ClashManager._getBuffVal(loser,  "clashPowerDown").intensity;
    const guard   = ClashManager._getBuffVal(loser,  "guard").intensity;
    const fragile = ClashManager._getBuffVal(loser,  "fragile").intensity;

    // 基础伤害
    let base = winScore + pwrUp - pwrDown + lvBonus;

    // 抗性
    let resistMult = 1.0;
    if (loser) {
      const resSys = loser.system?.resistances ?? {};
      const resStr = resSys[winCat] ?? "x1.0";
      resistMult = ClashManager._parseResistance(resStr);
    }

    let finalDamage = Math.max(0, Math.round(base * resistMult) + fragile - guard);

    // 结算说明
    const notes = [];
    notes.push(`本次对抗：${atkActor?.name ?? "?"} vs ${defActor?.name ?? "?"}`);
    notes.push(`${winner?.name ?? "?"} 获胜，${loser?.name ?? "?"} 败北`);
    if (resistMult !== 1.0) {
      const catLbl = ClashManager._catLabel(winCat);
      notes.push(`由于 ${loser?.name ?? "?"} ${catLbl}${resistMult > 1 ? "弱性" : "抗性"} 伤害×${resistMult}`);
    }
    if (lvBonus > 0) notes.push(`攻防等级差 ${lvDiff} 级，额外 +${lvBonus} 伤害`);
    if (pwrUp)   notes.push(`拼点威力提升 +${pwrUp}`);
    if (pwrDown) notes.push(`拼点威力降低 -${pwrDown}`);
    notes.push(`${loser?.name ?? "?"} 受到 ${finalDamage} 点伤害`);

    return {
      atkWins, winner, loser,
      atkTotal, defTotal, winScore, loseScore,
      atkItemName, atkItemImg, atkFormula, atkActor,
      defItemName, defItemImg, defFormula, defActor,
      finalDamage, notes,
    };
  }

  /* ─── 阶段五c：拼点结算聊天框 ──────────────────────────────────────────── */

  static async _sendResolveMsg(res, initFlags, defActor, defItem, defFormula) {
    const {
      atkWins, atkTotal, defTotal, winScore, loseScore,
      atkItemName, atkItemImg, atkFormula, atkActor,
      defItemName, defItemImg,
      loser, finalDamage, notes,
    } = res;

    const atkTotalStyle = atkWins
      ? "font-size:2rem;font-weight:bold;color:#E8C9A2;"
      : "font-size:2rem;font-weight:bold;color:#B84444;";
    const defTotalStyle = !atkWins
      ? "font-size:2rem;font-weight:bold;color:#E8C9A2;"
      : "font-size:2rem;font-weight:bold;color:#B84444;";
    const cmp = atkTotal >= defTotal ? ">" : "<";

    const content = `
      <div class="limbus-clash-card" data-clash-type="resolve">
        ${ClashManager._chatHeader(atkActor ?? { img: "", name: "?" }, "拼点对抗")}
        ${ClashManager._goldDivider()}
        <div style="display:flex;align-items:flex-start;gap:12px;margin:8px 0;">
          <div style="flex:1;text-align:center;">
            <div style="font-size:12px;color:#9A8462;margin-bottom:4px;">${atkActor?.name ?? "?"}</div>
            <img src="${atkItemImg ?? ""}" style="width:50px;height:50px;${OCTA_STYLE}" alt="">
            <div style="font-size:12px;color:#E8C9A2;margin-top:4px;">${atkItemName ?? ""}</div>
            <div style="font-size:11px;color:#EBBD68;">${atkFormula ?? ""}</div>
          </div>
          <div style="align-self:center;font-size:1.6rem;font-weight:bold;color:#C9A84C;padding:0 4px;">VS</div>
          <div style="flex:1;text-align:center;">
            <div style="font-size:12px;color:#9A8462;margin-bottom:4px;">${defActor?.name ?? "?"}</div>
            <img src="${defItemImg ?? ""}" style="width:50px;height:50px;${OCTA_STYLE}" alt="">
            <div style="font-size:12px;color:#E8C9A2;margin-top:4px;">${defItemName ?? ""}</div>
            <div style="font-size:11px;color:#EBBD68;">${defFormula ?? ""}</div>
          </div>
        </div>
        ${ClashManager._goldDivider()}
        <div style="text-align:center;margin:8px 0;">
          <div style="font-size:14px;color:#C9A84C;margin-bottom:6px;">拼点结算</div>
          <div style="display:flex;align-items:center;justify-content:center;gap:14px;">
            <span style="${atkTotalStyle}">${atkTotal}</span>
            <span style="font-size:1.5rem;color:#C9A84C;">${cmp}</span>
            <span style="${defTotalStyle}">${defTotal}</span>
          </div>
        </div>
        ${ClashManager._goldDivider()}
        <div style="font-size:.8rem;color:#9A8462;line-height:1.7;margin:4px 0 8px;">
          ${notes.map(n => `<div>${n}</div>`).join("")}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <button class="clash-btn-apply-damage"
                  data-target-actor-id="${loser?.id ?? ""}"
                  data-damage="${finalDamage}"
                  style="width:48px;height:30px;background:#B84444;color:#fff;
                         border:none;cursor:pointer;font-size:.85rem;border-radius:2px;flex-shrink:0;">承受</button>
          <span style="font-size:.7rem;color:#6A5A48;">先选中 Token，再点击按钮扣除 ${finalDamage} 点生命值</span>
        </div>
      </div>`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: atkActor }),
      content,
      flags: {
        limbusCompany_FVTT: {
          type:          "clash-resolve",
          targetActorId: loser?.id ?? "",
          damage:        finalDamage,
        },
      },
    });
  }

  /* ─── 阶段六：直接承受（跳过对抗，玩家B点聊天框承受） ────────────────── */

  static async handleDirectTake(initFlags) {
    const defActor =
      game.user.character ??
      canvas.tokens?.controlled?.[0]?.actor ??
      null;

    if (!defActor) {
      ui.notifications.warn("请先选中承受伤害的角色 Token");
      return;
    }

    // 直接伤害 = 攻击骰结果 × 抗性
    const category   = initFlags.category ?? "";
    const resSys     = defActor.system?.resistances ?? {};
    const resistMult = ClashManager._parseResistance(resSys[category] ?? "x1.0");
    const damage     = Math.max(0, Math.round(initFlags.rollTotal * resistMult));

    await ClashManager._applyAndSendTake(defActor, damage);
  }

  /* ─── 阶段七：承受结算（应用伤害 + 发送聊天框） ─────────────────────── */

  static async handleApplyDamage(targetActorId, damage) {
    // 优先用点击时选中的 token，否则用 flags 中的 targetActorId
    const selected = canvas.tokens?.controlled?.[0]?.actor;
    const byId     = game.actors.get(targetActorId);
    const actor    = selected ?? byId;

    if (!actor) {
      ui.notifications.warn("找不到目标角色，请先选中 Token");
      return;
    }

    await ClashManager._applyAndSendTake(actor, damage);
  }

  static async _applyAndSendTake(actor, damage) {
    const sys   = actor.system;
    const oldHp = sys.hp?.value ?? 0;
    const maxHp = sys.hp?.max   ?? 1;
    const newHp = Math.max(0, oldHp - damage);

    // 检查混乱阈值
    const thresholds = [...(sys.chaosThresholds ?? [])];
    let chaosTriggered = false;
    for (let i = 0; i < thresholds.length; i++) {
      const t = thresholds[i];
      if (!t.triggered && newHp <= maxHp * t.percent / 100) {
        thresholds[i] = { ...t, triggered: true };
        chaosTriggered = true;
        break; // 每次只触发一条
      }
    }

    // 更新 HP（混乱由 triggerChaos 处理）
    const updateData = { "system.hp.value": newHp };
    if (chaosTriggered) updateData["system.chaosThresholds"] = thresholds;
    await actor.update(updateData);

    if (chaosTriggered && actor.triggerChaos) await actor.triggerChaos();

    await ClashManager._sendTakeMsg(actor, damage, oldHp, newHp, maxHp, chaosTriggered);
  }

  static async _sendTakeMsg(actor, damage, oldHp, newHp, maxHp, chaosTriggered) {
    const hpPct = Math.max(0, Math.round((newHp / maxHp) * 100));

    const content = `
      <div class="limbus-clash-card limbus-take-card"
           style="background:linear-gradient(180deg,#2D0509 0%,#1A0305 100%);"
           data-clash-type="take">
        ${ClashManager._chatHeader(actor, "承受")}
        ${ClashManager._goldDivider()}
        <div style="text-align:center;margin:10px 0;">
          <div style="font-size:16px;font-weight:bold;color:#E8C9A2;margin-bottom:6px;">生命值结算</div>
          <div style="font-size:13px;color:#E8CAA1;margin-bottom:10px;">${actor.name} 受到了 ${damage} 点伤害</div>
          <div style="display:flex;align-items:center;justify-content:center;gap:18px;">
            <span style="font-size:2rem;font-weight:bold;color:#E8C9A2;">${oldHp}</span>
            <span style="font-size:1.5rem;color:#C9A84C;">→</span>
            <span style="font-size:2rem;font-weight:bold;color:#B84444;">${newHp}</span>
          </div>
        </div>
        ${ClashManager._goldDivider()}
        ${chaosTriggered
          ? `<div style="text-align:center;font-size:.85rem;color:#E84444;font-weight:bold;margin-bottom:6px;">
               伤害超过混乱阈值 陷入混乱
             </div>`
          : ""}
        <div style="background:#1A0305;border-radius:3px;overflow:hidden;height:10px;margin:4px 0;">
          <div style="height:100%;background:${chaosTriggered ? "#B84444" : "#C9A84C"};width:${hpPct}%;transition:width .3s;"></div>
        </div>
        <div style="text-align:center;font-size:.75rem;color:#9A8462;margin-top:3px;">
          ${newHp} / ${maxHp}
        </div>
      </div>`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content,
      flags: { limbusCompany_FVTT: { type: "clash-take" } },
    });
  }
}
