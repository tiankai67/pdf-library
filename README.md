# 书库 · 在线 PDF 书架

一个零依赖的在线 PDF 图书馆：后台上传 PDF，前台自动把首页渲染成封面、以翻页效果阅读。支持书架排序、书籍改名、管理员密码修改。

- 前端：纯 HTML/CSS/JS（PDF.js 渲染 + St.PageFlip 翻页）
- 后端：Node.js 原生 `http` 模块，**无任何第三方依赖**
- 存储：本地文件（`data/` 目录）

---

## ✨ 功能

- 📚 **书架浏览**：网格化书架，封面铺满书格、无白边
- 📖 **翻页阅读**：真实翻书动画，支持缩放、适应屏幕（100% 铺满）
- 🖼️ **自动封面**：上传时自动取 PDF 首页渲染为封面缩略图
- 🔐 **管理后台**：上传 / 删除 / 改名 / 拖拽与一键排序 / 修改管理员密码
- 🌐 **双模式运行**：有后端走 API；无后端（如 GitHub Pages）自动回退到静态文件，开箱即看

---

## 🚀 自托管（完整功能）

需要 Node.js（>= 16）。

```bash
cd pdf-library
node server.js
```

启动后访问：

- 前台书架： `http://localhost:3777/`
- 管理后台： `http://localhost:3777/admin.html`

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 服务端口 | `3777` |
| `ADMIN_PASSWORD` | 首次生成 `data/config.json` 时使用的初始密码 | `yuntian2026` |
| `DATA_DIR` | 数据目录（存放 books.json / pdfs / covers / config.json） | `./data` |
| `RESET_PASSWORD` | 设为 `1` 启动时强制用 `ADMIN_PASSWORD` 重置密码 | 不重置 |

忘记密码时重置：

```bash
RESET_PASSWORD=1 ADMIN_PASSWORD=你的新密码 node server.js
```

> 密码以 `scrypt` 加盐哈希保存在 `data/config.json`，代码与仓库均不含明文。

---

## 📦 部署到 GitHub Pages（只读版）

仓库采用**从 `main` 分支根目录直接发布**的方式，无需构建步骤：

Pages 上的版本是**只读浏览版**：

- ✅ 能看书架、翻书、缩放
- ❌ 不能上传 / 删除 / 改名 / 排序 / 改密码（这些需要后端，请自托管）

部署步骤：

1. 推送 `main` 分支
2. 仓库 **Settings → Pages → Source** 选 `Deploy from a branch` → 分支 `main` → 目录 `/(root)`
3. 稍等片刻，访问 `https://<你的用户名>.github.io/pdf-library/`

> 站点静态文件（前端 + `books.json` + `covers/` + `pdfs/`）全部位于仓库根目录，自托管与 Pages 共用同一份数据，无重复。

> 若希望「推送即自动部署」，可改用 GitHub Actions（需为 Token 添加 `workflow` 权限后补回 `.github/workflows/pages.yml`）。

---

## 📁 目录结构

```
pdf-library/
├── server.js              # 零依赖 Node 后端（API + 静态服务）
├── public/                # 前端（部署到 Pages 的正是此目录）
│   ├── index.html         # 书架
│   ├── reader.html        # 阅读器（翻页）
│   ├── admin.html         # 管理后台（需后端）
│   └── styles.css
├── data/                  # 运行时数据（books.json / pdfs / covers / config.json）
└── .github/workflows/     # Pages 自动部署
```

---

## 🔒 隐私提示

- 上传的 PDF 与封面会保存在 `data/`，自托管时仅你本机可见。
- 推送到公开仓库时，PDF 文件会随仓库公开。若含私人内容，请将仓库设为 **Private**，或在 `.gitignore` 中排除 `data/pdfs/`、`data/covers/`。
- `data/config.json`（密码哈希）已在 `.gitignore` 中排除，不会进入版本库。

## 📄 开源协议

MIT
