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

  static _sinLabel(sinType) {
    return CONFIG.LIMBUSCOMPANY?.SIN_LABELS_ZH?.[sinType] ?? sinType ?? "";
  }

  static _sinColor(sinType) {
    return CONFIG.LIMBUSCOMPANY?.SIN_COLORS?.[sinType] ?? "#E8CAA2";
  }

  static _parseResistance(resStr) {
    if (!resStr) return 1.0;
    const m = String(resStr).match(/x?([0-9.]+)/i);
    return m ? parseFloat(m[1]) : 1.0;
  }

  /**
   * 返回角色的实际物理抗性（含上装 resistanceAdj 覆盖），
   * 与 actor-sheet.mjs getData() 中 displayResistances 逻辑完全一致。
   */
  static _getEffectiveResistances(actor) {
    const sys          = actor?.system ?? {};
    const equippedItems = Object.values(sys.equipment ?? {})
      .map(id => (id ? actor.items.get(id) : null))
      .filter(item => item?.type === "equipment");
    const upper = equippedItems.find(eq => eq.system?.subtype === "upper");
    if (upper?.system?.resistanceAdj) {
      const adj = upper.system.resistanceAdj;
      return {
        slash:  adj.slash  ?? sys.resistances?.slash  ?? "x1.0",
        blunt:  adj.blunt  ?? sys.resistances?.blunt  ?? "x1.0",
        pierce: adj.pierce ?? sys.resistances?.pierce ?? "x1.0",
      };
    }
    return {
      slash:  sys.resistances?.slash  ?? "x1.0",
      blunt:  sys.resistances?.blunt  ?? "x1.0",
      pierce: sys.resistances?.pierce ?? "x1.0",
    };
  }

  static _getBuff(actor, type) {
    return (actor?.system?.buffs ?? []).find(b => b.type === type) ?? null;
  }

  static _getBuffVal(actor, type) {
    const b = ClashManager._getBuff(actor, type);
    return { intensity: b?.intensity ?? 0, stacks: b?.stacks ?? 0 };
  }

  /**
   * 减少 BUFF 层数，归零时自动移除。
   * 优先调用 actor.reduceBuffStacks（如已定义），否则直接写 system.buffs。
   */
  static async _reduceBuffStacks(actor, type, amount = 1) {
    if (!actor) return;
    if (typeof actor.reduceBuffStacks === "function") {
      return actor.reduceBuffStacks(type, amount);
    }
    // 兜底：直接操作 buffs 数组
    const buffs = [...(actor.system?.buffs ?? [])];
    const idx   = buffs.findIndex(b => b.type === type);
    if (idx === -1) return;
    const next = Math.max(0, (buffs[idx].stacks ?? 1) - amount);
    if (next <= 0) buffs.splice(idx, 1);
    else           buffs[idx] = { ...buffs[idx], stacks: next };
    return actor.update({ "system.buffs": buffs });
  }

  /**
   * 处理【流血】：持有 bleed 的角色执行攻击动作时，受到强度点固定伤害，层数-1。
   * @param {Actor} actor  持有 bleed 的攻击方/响应方
   * @returns {number} 实际造成的流血伤害（0 = 未触发）
   */
  static async _processBleed(actor) {
    const buff = ClashManager._getBuff(actor, "bleed");
    if (!buff || buff.stacks <= 0) return 0;

    const dmg   = buff.intensity ?? 0;
    const oldHp = actor.system.hp?.value ?? 0;
    const newHp = Math.max(0, oldHp - dmg);

    await actor.update({ "system.hp.value": newHp });
    await ClashManager._reduceBuffStacks(actor, "bleed");
    if (actor.checkAndTriggerChaos) await actor.checkAndTriggerChaos(newHp, oldHp);

    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="limbuscompany chat-clash">
        <strong>${actor.name}</strong>【流血】发作：受到 <strong>${dmg}</strong> 点固定伤害。
        （HP ${oldHp} → ${newHp}）
      </div>`,
    });
    return dmg;
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

    // 流血：发起者执行攻击动作时触发
    await ClashManager._processBleed(actor);

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

    // 发起方自己不能作为防守方响应自己的对抗
    if (defActor.id === initFlags.attackerId) {
      ui.notifications.warn("发起对抗的角色不能对自己的发起进行对抗");
      return;
    }

    // 行动值不足则无法进行对抗
    if ((defActor.system.ap?.value ?? 0) <= 0) {
      ui.notifications.warn(`${defActor.name} 行动值不足，无法进行对抗`);
      return;
    }

    ClashManager._buildPickerDialog(defActor, (chosenItem, slotIdx) => {
      ClashManager.showPerformDialog(defActor, chosenItem, msgId, initFlags, slotIdx);
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
    // slotIdx: 对应 bagState.slots 的下标（-1 = 守备/EGO，不属于 6-bag）
    const octaSlotHtml = (item, extraClass = "", slotIdx = -1) => {
      if (!item) {
        return `<div class="clash-pick-slot clash-pick-empty" style="width:52px;height:52px;"></div>`;
      }
      const sin = ClashManager._sinColor(item.system?.sinType);
      const hasRel = !!(item.system?.relatedSkill?.itemUuid);
      return `
        <div class="clash-pick-slot ${extraClass}" data-item-id="${item.id}" data-slot-index="${slotIdx}" title="${item.name}"
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
            ? `<div class="clash-pick-slot" data-item-id="${item.id}" data-slot-index="-1" title="${item.name}"
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
        ${octaSlotHtml(active0, "clash-pick-active", 0)}
        ${octaSlotHtml(active1, "clash-pick-active", 1)}
        ${octaSlotHtml(defItem, "", -1)}
      </div>`;

    const expandedHtml = `
      <div class="clash-pick-expanded" style="display:none;">
        ${ClashManager._goldDivider()}
        <div style="display:flex;flex-wrap:wrap;gap:16px;justify-content:center;padding:8px 0 16px;">
          ${restItems.map((it, j) => octaSlotHtml(it, "", 2 + j)).join("")}
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

        // 选中技能（携带 slotIdx 供后续推进战斗袋）
        dlgHtml.on("click", ".clash-pick-slot:not(.clash-pick-empty)", (e) => {
          if ($(e.target).hasClass("clash-pick-rel")) return; // 不触发 related toggle
          const itemId  = e.currentTarget.dataset.itemId;
          const slotIdx = parseInt(e.currentTarget.dataset.slotIndex ?? "-1");
          const item    = actor.items.get(itemId);
          if (!item) return;
          dlg.close();
          onPick(item, slotIdx);
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

  static async showPerformDialog(defActor, defItem, initMsgId, initFlags, slotIdx = -1) {
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
                defActor, defItem, roll, full, initMsgId, initFlags, slotIdx
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

  static async _sendResponseAndResolve(defActor, defItem, defRoll, defFormula, initMsgId, initFlags, slotIdx = -1) {
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

    // 流血：防守方进行对抗也是攻击动作，同样触发
    await ClashManager._processBleed(defActor);

    // 扣防守方 AP
    const defAp = defActor.system.ap?.value ?? 0;
    if (defAp > 0) await defActor.update({ "system.ap.value": defAp - 1 });

    // 推进防守方战斗袋（技能消失，后面的技能填充）
    if (slotIdx >= 0) {
      const sheet = defActor.sheet;
      if (sheet?._combatBagState) sheet._animateCombatSkillUse?.(slotIdx);
    }

    // 拼点结算
    const atkActor = game.actors.get(initFlags.attackerId);
    const resolution = ClashManager._computeResolution({
      atkActor,    atkTotal:    initFlags.rollTotal,   atkFormula:  initFlags.formula,
      atkItemName: initFlags.itemName, atkItemImg: initFlags.itemImg,
      atkCategory: initFlags.category ?? "",           atkSinType:  initFlags.sinType ?? "",
      defActor,    defTotal:    defRoll.total,         defFormula,
      defItemName: defItem.name,       defItemImg: defItem.img,
      defCategory: sys.category ?? "",                 defSinType:  sys.sinType ?? "",
    });

    // 呼吸暴击触发：层数-1
    if (resolution.breatheCrit && resolution.winner) {
      await ClashManager._reduceBuffStacks(resolution.winner, "breathing");
    }

    await ClashManager._sendResolveMsg(resolution, initFlags, defActor, defItem, defFormula);
  }

  /* ─── 阶段五b：拼点结算逻辑 ────────────────────────────────────────────── */

  static _computeResolution({ atkActor, atkTotal, atkFormula, atkItemName, atkItemImg, atkCategory, atkSinType,
                               defActor, defTotal, defFormula, defItemName, defItemImg, defCategory, defSinType }) {

    // ── 技能分类分组 ──────────────────────────────────────────────────────
    // 守备技能（全部）→ 使用忍耐/破绽调整骰数
    const ALL_DEF_CATS   = new Set(["dodge","block","counter","clashBlock","clashCounter"]);
    // 使用防御等级（而非攻击等级）进行等级差比较的守备技能（不含反击系列）
    const DEF_LEVEL_CATS = new Set(["dodge","block","clashBlock"]);
    const PHYS_CATS      = new Set(["slash","blunt","pierce"]);
    const SIN_TYPES      = new Set(["wrath","lust","sloth","gluttony","gloom","pride","envy"]);

    // ── BUFF 辅助 ─────────────────────────────────────────────────────────
    // 骰数/等级类 BUFF 均使用 stacks（层数）；守护/易损使用 intensity（强度）
    const gs = (actor, type) => ClashManager._getBuffVal(actor, type).stacks;
    const gi = (actor, type) => ClashManager._getBuffVal(actor, type).intensity;

    // ── 有效攻/防等级（含装备加成 + atk.extra/def.extra + BUFF 层数）────
    const effAtkLv = (a) => {
      const sys = a?.system ?? {};
      const equipAdj = Object.values(sys.equipment ?? {})
        .map(id => id ? a.items.get(id) : null)
        .filter(item => item?.type === "equipment")
        .reduce((s, eq) => s + Number(eq.system?.atkAdj ?? 0), 0);
      return (sys.atk?.base ?? 0) + (sys.atk?.extra ?? 0) + equipAdj
           + gs(a, "atkLevelUp") - gs(a, "atkLevelDown");
    };
    const effDefLv = (a) => {
      const sys = a?.system ?? {};
      const equipAdj = Object.values(sys.equipment ?? {})
        .map(id => id ? a.items.get(id) : null)
        .filter(item => item?.type === "equipment")
        .reduce((s, eq) => s + Number(eq.system?.defAdj ?? 0), 0);
      return (sys.def?.base ?? 0) + (sys.def?.extra ?? 0) + equipAdj
           + gs(a, "defLevelUp") - gs(a, "defLevelDown");
    };

    // ── 各方等级（攻击方始终用 atkLv；防守方：DEF型技能用 defLv，其余用 atkLv）
    const atkSideLv = effAtkLv(atkActor);
    const defSideLv = DEF_LEVEL_CATS.has(defCategory) ? effDefLv(defActor) : effAtkLv(defActor);

    // 等级差加值（仅等级高的一方获得，差值每3级 +1 有效骰数）
    const atkLvBonus = Math.floor(Math.max(0, atkSideLv - defSideLv) / 3);
    const defLvBonus = Math.floor(Math.max(0, defSideLv - atkSideLv) / 3);

    // ── 各方有效骰数（骰子结果 + BUFF 修正 + 等级差加值）────────────────
    // 攻击方（基础/EGO 技能）：强壮/虚弱 + 拼点威力提升/降低 + 等级差
    const atkDiceMod = gs(atkActor, "strong")       - gs(atkActor, "weak")
                     + gs(atkActor, "clashPowerUp")  - gs(atkActor, "clashPowerDown");

    // 防守方：守备技能 → 忍耐/破绽；基础/EGO → 强壮/虚弱；两者都再加拼点威力 + 等级差
    const defIsDefCat = ALL_DEF_CATS.has(defCategory);
    const defDiceMod  = defIsDefCat
      ? (gs(defActor, "endure")  - gs(defActor, "breach"))
      : (gs(defActor, "strong")  - gs(defActor, "weak"));
    const defPwrMod   = gs(defActor, "clashPowerUp") - gs(defActor, "clashPowerDown");

    const atkEffective = atkTotal + atkDiceMod + atkLvBonus;
    const defEffective = defTotal + defDiceMod + defPwrMod + defLvBonus;

    // ── 胜负判定（基于含等级差的有效骰数）───────────────────────────────
    const atkWins  = atkEffective >= defEffective;
    const winner   = atkWins ? atkActor : defActor;
    const loser    = atkWins ? defActor : atkActor;
    const winScore = atkWins ? atkEffective : defEffective;
    const winCat   = atkWins ? atkCategory  : defCategory;
    const winSin   = atkWins ? atkSinType   : defSinType;

    // ── 物理抗性（含上装 resistanceAdj 覆盖）────────────────────────────
    const effRes     = loser ? ClashManager._getEffectiveResistances(loser) : {};
    const physResStr = PHYS_CATS.has(winCat) ? (effRes[winCat] ?? "x1.0") : "x1.0";
    const physMult   = ClashManager._parseResistance(physResStr);

    // ── 罪孽抗性 ─────────────────────────────────────────────────────────
    const sinResStr = (loser && SIN_TYPES.has(winSin))
      ? (loser.system?.egoResistances?.[winSin] ?? "x1.0")
      : "x1.0";
    const sinMult   = ClashManager._parseResistance(sinResStr);

    // ── 守护/易损（使用 intensity，直接加减伤害）─────────────────────────
    const guard   = gi(loser, "guard");
    const fragile = gi(loser, "fragile");

    // ── 最终伤害 ──────────────────────────────────────────────────────────
    // 公式：round(winScore × physMult × sinMult) + 易损强度 - 守护强度
    // 等级差加值已在拼点阶段计入有效骰数，不再单独计入伤害
    const totalMult = physMult * sinMult;
    let   finalDamage = Math.max(0, Math.round(winScore * totalMult) + fragile - guard);

    // ── 呼吸（breathing）：命中方有 breathing BUFF 时，强度×5% 概率暴击 ──
    // 暴击：伤害×1.5；触发时层数-1（由调用方在结算后执行）
    const breatheBuff = ClashManager._getBuff(winner, "breathing");
    let   breatheCrit = false;
    if (breatheBuff && breatheBuff.stacks > 0) {
      const critChance = (breatheBuff.intensity ?? 1) * 0.05;
      breatheCrit = Math.random() < critChance;
      if (breatheCrit) {
        finalDamage = Math.max(0, Math.round(winScore * totalMult * 1.5) + fragile - guard);
      }
    }

    // ── 结算说明 ──────────────────────────────────────────────────────────
    const loserName = loser?.name ?? "?";
    const notes     = [];

    notes.push(`本次对抗：${atkActor?.name ?? "?"} vs ${defActor?.name ?? "?"}`);
    notes.push(`结算结果：`);

    // 攻击方骰数（有 BUFF 或等级差时展示修正过程）
    const atkModTotal = atkDiceMod + atkLvBonus;
    const atkModParts = [];
    if (atkDiceMod !== 0) atkModParts.push(`BUFF(${atkDiceMod >= 0 ? "+" : ""}${atkDiceMod})`);
    if (atkLvBonus  > 0)  atkModParts.push(`等级差(+${atkLvBonus})`);
    const atkBuffStr = atkModParts.length > 0
      ? `+${atkModParts.join("+")}=${atkEffective}` : "";
    notes.push(`　${atkActor?.name ?? "?"}：${atkFormula.toUpperCase()}=${atkTotal} ${atkBuffStr}`.trim());

    // 防守方骰数
    const defModTotal = defDiceMod + defPwrMod + defLvBonus;
    const defModParts = [];
    if ((defDiceMod + defPwrMod) !== 0) defModParts.push(`BUFF(${(defDiceMod + defPwrMod) >= 0 ? "+" : ""}${defDiceMod + defPwrMod})`);
    if (defLvBonus > 0) defModParts.push(`等级差(+${defLvBonus})`);
    const defBuffStr = defModParts.length > 0
      ? `+${defModParts.join("+")}=${defEffective}` : "";
    notes.push(`　${defActor?.name ?? "?"}：${defFormula.toUpperCase()}=${defTotal} ${defBuffStr}`.trim());

    // 等级差说明
    if (atkLvBonus > 0) notes.push(`（攻击方等级 ${atkSideLv} vs 防守方等级 ${defSideLv}，等级差 ${atkSideLv - defSideLv}，拼点+${atkLvBonus}）`);
    if (defLvBonus > 0) notes.push(`（防守方等级 ${defSideLv} vs 攻击方等级 ${atkSideLv}，等级差 ${defSideLv - atkSideLv}，拼点+${defLvBonus}）`);

    notes.push(`${winner?.name ?? "?"} 获胜，${loserName} 败北`);

    // 抗性说明
    const resParts = [];
    if (physMult !== 1.0) resParts.push(`${ClashManager._catLabel(winCat)}${physMult > 1 ? "弱性" : "抗性"}×${physMult}`);
    if (sinMult  !== 1.0) resParts.push(`${ClashManager._sinLabel(winSin)} 抗性×${sinMult}`);
    notes.push(resParts.length > 0
      ? `${loserName} 由于 ${resParts.join(" + ")} 受到 ${finalDamage} 点伤害`
      : `${loserName} 受到 ${finalDamage} 点伤害`);

    if (fragile > 0) notes.push(`（易损 +${fragile} 伤害）`);
    if (guard   > 0) notes.push(`（守护 -${guard} 伤害）`);
    if (breatheCrit) notes.push(`【呼吸】触发暴击！伤害 ×1.5 → ${finalDamage}`);

    return {
      atkWins, winner, loser,
      atkTotal: atkEffective, defTotal: defEffective, winScore,
      atkItemName, atkItemImg, atkFormula, atkActor,
      defItemName, defItemImg, defFormula, defActor,
      finalDamage, notes, breatheCrit,
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
    const selActor =
      game.user.character ??
      canvas.tokens?.controlled?.[0]?.actor ??
      null;

    if (!selActor) {
      ui.notifications.warn("请先选中承受伤害的角色 Token");
      return;
    }

    // 发起方不能承受自己发起的攻击
    if (selActor.id === initFlags.attackerId) {
      ui.notifications.warn("发起对抗的角色不能承受自己的攻击，请由目标玩家操作");
      return;
    }

    // 直接伤害 = 攻击骰结果 × 实际抗性（含上装修正）
    const category   = initFlags.category ?? "";
    const PHYS_CATS  = ["slash", "blunt", "pierce"];
    const effRes     = ClashManager._getEffectiveResistances(selActor);
    const resStr     = PHYS_CATS.includes(category) ? (effRes[category] ?? "x1.0") : "x1.0";
    const resistMult = ClashManager._parseResistance(resStr);
    const damage     = Math.max(0, Math.round(initFlags.rollTotal * resistMult));

    // 优先使用 base actor（确保角色卡与 linked tokens 同步）
    const baseActor = game.actors.get(selActor.id) ?? selActor;
    await ClashManager._applyAndSendTake(baseActor, damage);

    // 若选中的是非 linked token actor，额外同步该 token 的 HP
    if (selActor !== baseActor && selActor.isToken) {
      const th  = selActor.system?.hp?.value ?? 0;
      await selActor.update({ "system.hp.value": Math.max(0, th - damage) });
    }
  }

  /* ─── 阶段七：承受结算（应用伤害 + 发送聊天框） ─────────────────────── */

  static async handleApplyDamage(targetActorId, damage) {
    // 优先使用 flags 记录的 base actor（更新后 linked tokens 自动同步）
    const baseActor = game.actors.get(targetActorId);
    const selToken  = canvas.tokens?.controlled?.[0];
    const selActor  = selToken?.actor;
    const actor     = baseActor ?? selActor;

    if (!actor) {
      ui.notifications.warn("找不到目标角色，请先选中 Token");
      return;
    }

    await ClashManager._applyAndSendTake(actor, damage);

    // 若选中的是非 linked token actor（与 base actor 为不同文档），额外同步该 token 的 HP
    if (selActor && selActor !== actor && selActor.isToken) {
      const th = selActor.system?.hp?.value ?? 0;
      await selActor.update({ "system.hp.value": Math.max(0, th - damage) });
    }
  }

  /**
   * @param {Actor}  actor
   * @param {number} damage      基础伤害（拼点/直接承受计算后的值）
   * @param {object} [opts]
   * @param {boolean} [opts.isSeismic=false]  是否为【震颤引爆】类型攻击
   */
  static async _applyAndSendTake(actor, damage, { isSeismic = false } = {}) {
    const sys   = actor.system;
    const maxHp = sys.hp?.max ?? 1;

    // ── 受到伤害时 BUFF ────────────────────────────────────────────────────

    // 【破裂】：附加强度点固定伤害，层数-1
    const ruptureBuff = ClashManager._getBuff(actor, "rupture");
    let ruptureDmg = 0;
    if (ruptureBuff && ruptureBuff.stacks > 0) {
      ruptureDmg = ruptureBuff.intensity ?? 0;
      await ClashManager._reduceBuffStacks(actor, "rupture");
    }

    // 【沉沦】：增加强度点侵蚀度（降低理智），层数-1
    const sinkingBuff = ClashManager._getBuff(actor, "sinking");
    let sanityDmg = 0;
    if (sinkingBuff && sinkingBuff.stacks > 0) {
      sanityDmg = sinkingBuff.intensity ?? 0;
      await ClashManager._reduceBuffStacks(actor, "sinking");
    }

    // 【震颤】：受到震颤引爆攻击时，混乱阈值前移强度值，层数-1
    let tremorTriggered = false;
    if (isSeismic) {
      const tremorBuff = ClashManager._getBuff(actor, "tremor");
      if (tremorBuff && tremorBuff.stacks > 0) {
        await actor.triggerSeismicBlast?.(tremorBuff.intensity ?? 0);
        await ClashManager._reduceBuffStacks(actor, "tremor");
        tremorTriggered = true;
      }
    }

    // ── HP 结算（基础伤害 + 破裂附加） ────────────────────────────────────
    const totalDmg = damage + ruptureDmg;
    const oldHp    = sys.hp?.value ?? 0;
    const newHp    = Math.max(0, oldHp - totalDmg);

    // 提前判断混乱阈值（用于聊天框显示）
    const thresholds     = sys.chaosThresholds ?? [];
    const chaosTriggered = thresholds.some(
      t => !t.triggered && newHp <= maxHp * t.percent / 100
    );

    // 更新 HP
    await actor.update({ "system.hp.value": newHp });

    // 沉沦：更新理智值（setSanity 内部会检查恐慌状态）
    if (sanityDmg > 0 && typeof actor.setSanity === "function") {
      await actor.setSanity((actor.system.sanity?.value ?? 50) - sanityDmg);
    }

    // 触发混乱效果
    if (chaosTriggered && actor.checkAndTriggerChaos) {
      await actor.checkAndTriggerChaos(newHp, oldHp);
    }

    await ClashManager._sendTakeMsg(actor, damage, oldHp, newHp, maxHp, chaosTriggered,
      { ruptureDmg, sanityDmg, tremorTriggered });
  }

  static async _sendTakeMsg(actor, damage, oldHp, newHp, maxHp, chaosTriggered,
      { ruptureDmg = 0, sanityDmg = 0, tremorTriggered = false } = {}) {
    const hpPct     = Math.max(0, Math.round((newHp / maxHp) * 100));
    const totalDmg  = damage + ruptureDmg;
    const extraLines = [];
    if (ruptureDmg  > 0) extraLines.push(`【破裂】附加 +${ruptureDmg} 点固定伤害`);
    if (sanityDmg   > 0) extraLines.push(`【沉沦】附加 ${sanityDmg} 点侵蚀度（理智-${sanityDmg}）`);
    if (tremorTriggered) extraLines.push(`【震颤】引爆：混乱阈值前移`);

    const content = `
      <div class="limbus-clash-card limbus-take-card"
           style="background:linear-gradient(180deg,#2D0509 0%,#1A0305 100%);"
           data-clash-type="take">
        ${ClashManager._chatHeader(actor, "承受")}
        ${ClashManager._goldDivider()}
        <div style="text-align:center;margin:10px 0;">
          <div style="font-size:16px;font-weight:bold;color:#E8C9A2;margin-bottom:6px;">生命值结算</div>
          <div style="font-size:13px;color:#E8CAA1;margin-bottom:10px;">
            ${actor.name} 受到了 ${totalDmg} 点伤害
            ${ruptureDmg > 0 ? `（基础 ${damage} + 破裂 ${ruptureDmg}）` : ""}
          </div>
          <div style="display:flex;align-items:center;justify-content:center;gap:18px;">
            <span style="font-size:2rem;font-weight:bold;color:#E8C9A2;">${oldHp}</span>
            <span style="font-size:1.5rem;color:#C9A84C;">→</span>
            <span style="font-size:2rem;font-weight:bold;color:#B84444;">${newHp}</span>
          </div>
        </div>
        ${ClashManager._goldDivider()}
        ${extraLines.length > 0
          ? `<div style="font-size:.8rem;color:#9A8462;margin-bottom:4px;">
               ${extraLines.map(l => `<div>${l}</div>`).join("")}
             </div>`
          : ""}
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
