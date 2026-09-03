# docs/ —— 规则书（同时用作 GitHub Pages 站点根目录）

- `index.html` —— 郊区幸存者规则书的单页版本，内容与 `策划文件/规则书.md` 同源。
  自带全部样式，除 Google Fonts 外无外部依赖；取不到字体时回退系统字体栈，离线可读。
- `.nojekyll` —— 关掉 GitHub Pages 的 Jekyll 处理，静态文件原样发布。

两个入口指向的是同一个文件：

| 入口 | 地址 |
|---|---|
| Foundry 内（设置侧边栏 / F1） | `systems/limbusCompany_FVTT/docs/index.html` |
| 公开网页 | https://yanzhian.github.io/limbusCompany_FVTT/ |

改规则时先改 `策划文件/规则书.md`，再同步这里，别只改一边。
