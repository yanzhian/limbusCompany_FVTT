/**
 * dice.mjs — 鉴定（属性检定）系统
 *
 * 提供交互式鉴定弹窗和聊天框结果卡片。
 * 由 actor-sheet.mjs 的 _onAttributeCheck 动态导入。
 */

const COIN_FACE = "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_正面.webp";
const COIN_TAIL = "systems/limbusCompany_FVTT/assets/icons/Base_icon/硬币_反面.webp";

const MAX_DIFFICULTY = 8; // 难度硬币总数

export class AttributeCheckDialog {

  /**
   * 显示鉴定弹窗
   * @param {LimbusActor} actor     - 执行鉴定的角色
   * @param {string}      attr      - 属性键名（str/agi/con/int/per/cha）
   * @param {number}      attrVal   - 当前属性值（决定投掷硬币数）
   * @param {string}      label     - 属性中文名（显示用）
   */
  static async show(actor, attr, attrVal, label) {
    const defaultDifficulty = Math.min(Math.max(attrVal, 1), MAX_DIFFICULTY);

    // 当前难度（被硬币点击更新）
    let currentDifficulty = defaultDifficulty;

    /**
     * 生成 8 枚难度硬币的 HTML
     * 前 N 枚为正面（亮），后几枚为反面（暗）
     */
    const buildDifficultyCoins = (difficulty) => {
      return Array.from({ length: MAX_DIFFICULTY }, (_, i) => {
        const isHeads = i < difficulty;
        const src    = isHeads ? COIN_FACE : COIN_TAIL;
        const cls    = isHeads ? "heads" : "tails";
        return `<img class="limbus-difficulty-coin ${cls}"
                     data-index="${i + 1}"
                     src="${src}"
                     width="34" height="34"
                     alt="难度${i + 1}"
                     title="设置难度为 ${i + 1}">`;
      }).join("");
    };

    const content = `
      <div class="limbus-check-dialog">
        <div class="check-section">
          <div class="check-section-label">难度等级</div>
          <div class="limbus-difficulty-coins-row" id="limbus-difficulty-coins">
            ${buildDifficultyCoins(defaultDifficulty)}
          </div>
        </div>
        <div class="check-section">
          <input type="text"
                 class="limbus-check-bonus-input"
                 name="bonus"
                 placeholder="加值修正？"
                 autocomplete="off" />
        </div>
      </div>`;

    return new Promise((resolve) => {
      const dialog = new Dialog(
        {
          title: `${label}鉴定`,
          content,
          buttons: {
            roll: {
              label: "鉴定",
              callback: async (html) => {
                const bonusRaw = html.find("[name='bonus']").val()?.trim() ?? "0";
                const bonus    = parseInt(bonusRaw) || 0;
                await AttributeCheckDialog._executeRoll(actor, label, attrVal, currentDifficulty, bonus);
                resolve();
              },
            },
          },
          default: "roll",

          /* 渲染后挂载硬币点击事件 */
          render: (html) => {
            html.on("click", ".limbus-difficulty-coin", function () {
              currentDifficulty = parseInt(this.dataset.index);

              html.find(".limbus-difficulty-coin").each(function (i) {
                const isHeads = i < currentDifficulty;
                $(this)
                  .attr("src", isHeads ? COIN_FACE : COIN_TAIL)
                  .removeClass("heads tails")
                  .addClass(isHeads ? "heads" : "tails");
              });
            });
          },
        },
        {
          classes: ["dialog", "limbuscompany", "limbus-check-dialog-window"],
          width: 400,
        }
      );

      dialog.render(true);
    });
  }

  /* ─── 执行投掷并生成聊天消息 ─────────────────────────────── */

  static async _executeRoll(actor, label, attrVal, difficulty, bonus) {
    const totalCoins = Math.max(2, attrVal + bonus);

    // 每枚硬币：Roll 1d2，结果 >= 2 = 正面（成功）
    const formula = Array.from({ length: totalCoins }, () => "1d2").join("+");
    const roll    = new Roll(formula);
    await roll.evaluate();

    // DiceSoNice：播放所有硬币的 3D 翻转动画，等待完成后再显示聊天结果
    if (game.dice3d) {
      await game.dice3d.showForRoll(roll, game.user, true, null, false);
    }

    // 统计每枚硬币结果
    let headCount   = 0;
    const coinResults = [];
    for (const term of roll.terms) {
      if (!term.results) continue;
      for (const r of term.results) {
        const isHeads = r.result >= 2;
        if (isHeads) headCount++;
        coinResults.push(isHeads);
      }
    }

    // 判断结果类型
    let resultText, resultClass;
    if (headCount < difficulty) {
      resultText  = "失败";
      resultClass = "result-fail";
    } else if (headCount === difficulty) {
      resultText  = "完美成功";
      resultClass = "result-perfect";
    } else {
      resultText  = "成功";
      resultClass = "result-success";
    }

    // 构建结果硬币行 HTML
    const coinRowHtml = coinResults
      .map(isHeads => {
        const src = isHeads ? COIN_FACE : COIN_TAIL;
        return `<img src="${src}" width="28" height="28" alt="${isHeads ? "正面" : "反面"}" class="${isHeads ? "coin-heads" : "coin-tails"}">`;
      })
      .join("");

    // 查找关联玩家姓名
    const ownerUser  = game.users?.find(u => !u.isGM && u.character?.id === actor.id);
    const playerName = ownerUser?.name ?? actor.name ?? game.user?.name ?? "未知玩家";
    const actorImg   = actor.img || "icons/svg/mystery-man.svg";

    const chatContent = `
      <div class="limbus-check-card ${resultClass}">
        <div class="check-card-header">
          <img class="check-actor-avatar" src="${actorImg}" alt="${actor.name}">
          <div class="check-actor-info">
            <div class="check-title">${label}鉴定结果</div>
            <div class="check-player">${playerName}</div>
          </div>
        </div>
        <div class="check-gold-divider"></div>
        <div class="check-difficulty-text">
          难度等级 <span class="check-difficulty-num">${difficulty}</span>
        </div>
        <div class="check-result-text">${resultText}</div>
        <div class="check-coins-label">骰掷结果</div>
        <div class="check-coin-row">${coinRowHtml}</div>
        <div class="check-gold-divider"></div>
      </div>`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: chatContent,
      // 兼容 v13 (CHAT_MESSAGE_STYLES) 和旧版 (CHAT_MESSAGE_TYPES)
      type: CONST.CHAT_MESSAGE_STYLES?.OTHER
         ?? CONST.CHAT_MESSAGE_TYPES?.OTHER
         ?? 0,
    });
  }
}
