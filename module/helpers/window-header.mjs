/**
 * window-header.mjs —— 窗口标题栏整合（方案 B）
 *
 * Foundry 给每个 Sheet 的标题栏塞了标题 + 一排按钮，模块（卡模板 / 指示物 …）
 * 还会往里加自己的。这里把它收成：标题隐藏，除关闭外的按钮全部搬进右上角一个
 * 「⋮」下拉里。
 *
 * 关键点：**搬的是原来的 DOM 节点本身**，不是重新造一个同名按钮 —— 模块的点击
 * 监听绑在那个元素上，重建的话功能就没了。
 */

const MENU_CLASS = "lc-hd-menu";

/** 这个按钮该不该留在标题栏上（关闭永远留） */
function _isClose(el) {
  return el.classList.contains("close")
    || el.dataset?.action === "close"
    || !!el.querySelector?.(".fa-times, .fa-xmark");
}

/**
 * 把一个已渲染 Application 的标题栏收成「⋮ + 关闭」。
 * 幂等：重复调用不会重复搬运（已搬过的会带 data-lc-collapsed）。
 * @param {Application} app
 */
export function collapseWindowHeader(app) {
  const root = app?.element?.[0] ?? app?.element;
  if (!root?.querySelector) return;
  const header = root.querySelector(".window-header");
  if (!header) return;

  root.classList.add("lc-hd-collapsed");

  // 模块的按钮可能比我们晚一点才插进来：搬完之后再看一眼有没有新的
  const run = () => {
    const buttons = [...header.querySelectorAll("a.header-button, .header-control")]
      .filter(el => !el.dataset.lcCollapsed && !_isClose(el) && !el.classList.contains("lc-hd-dots"));
    if (!buttons.length) return;

    let menu = root.querySelector(`.${MENU_CLASS}`);
    let dots = header.querySelector(".lc-hd-dots");
    if (!dots) {
      dots = document.createElement("a");
      dots.className = "header-button lc-hd-dots";
      dots.innerHTML = `<i class="fas fa-ellipsis-vertical"></i>`;
      dots.title = "更多";
      // 放在关闭按钮之前
      const close = [...header.children].find(el => _isClose(el));
      header.insertBefore(dots, close ?? null);

      menu = document.createElement("ul");
      menu.className = MENU_CLASS;
      menu.hidden = true;
      root.appendChild(menu);

      dots.addEventListener("click", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        menu.hidden = !menu.hidden;
        if (!menu.hidden) {
          const close = (e) => {
            if (menu.contains(e.target) || e.target === dots) return;
            menu.hidden = true;
            document.removeEventListener("click", close);
          };
          setTimeout(() => document.addEventListener("click", close), 0);
        }
      });
      // 点菜单里的项之后自动收起
      menu.addEventListener("click", () => { menu.hidden = true; });
    }

    for (const btn of buttons) {
      btn.dataset.lcCollapsed = "1";
      const li = document.createElement("li");
      li.appendChild(btn);          // 搬原节点，保留模块自己的监听
      menu.appendChild(li);
    }
  };

  run();
  // 晚插进来的模块按钮（同一帧稍后 / 下一帧）
  setTimeout(run, 0);
  setTimeout(run, 200);
}

/**
 * 给一批 Sheet 类名注册 render 钩子。
 * v1 Application 只会触发与自身类名同名的 render 钩子，所以要按名字登记。
 * @param {string[]} classNames
 */
export function registerHeaderCollapse(classNames) {
  for (const name of classNames) {
    Hooks.on(`render${name}`, (app) => {
      try { collapseWindowHeader(app); }
      catch (err) { console.warn("[limbus] 标题栏整合失败:", name, err); }
    });
  }
}
