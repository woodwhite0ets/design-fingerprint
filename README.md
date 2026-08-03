# design-fingerprint

> [English](README.en.md) · 中文

一个 Claude Code skill：把任意网站变成一份机器可读的 `DESIGN.md` 设计指纹（模仿），或基于它生成风格一致但内容全新的页面（创新）。

```
网站 URL ──▶ DESIGN.md（设计指纹）──▶ 风格一致的新页面
  模仿路径                          创新路径
```

## 它解决什么问题

让 AI 生成 UI 时能真正模仿一个设计系统。常见做法是拿截图或描述当提示词——AI 能模仿"氛围"，但色值、字号、间距全靠猜。`design-fingerprint` 把两者分开：

| 任务 | 谁来做 | 为什么 |
|------|--------|--------|
| 色值、字号、间距、圆角、阴影（**必须精确**） | DOM 脚本 | 读真实 computed styles，零误差 |
| 品牌色是哪个、设计氛围、Do's/Don'ts 规则（**语义判断**） | Claude（视觉模型） | 算法猜不出的部分，看图一眼能定 |

**不需要 API key**——Claude 本体直接读截图做视觉判断，脚本只负责在页面内收集精确值。统计聚类无法判断的（如"哪个颜色是品牌色"）会作为候选暴露出来，由视觉模型定夺。

## 安装

```bash
# 1. 把 skill 放进项目的 .claude/skills/
git clone https://github.com/woodwhite0ets/design-fingerprint.git .claude/skills/design-fingerprint
# 2. 装依赖（只需一次）
cd .claude/skills/design-fingerprint && npm install
```

## 用法

在你的 Claude Code 会话里说：

- **模仿**：`模仿这个网站的风格 https://example.com` 或 `提取 example.com 的设计规范`
- **创新**：`用刚才的苹果设计做一页博客` 或 `照着 DESIGN.md 生成一个产品落地页`

skill 的工作流（详见 [SKILL.md](.claude/skills/design-fingerprint/SKILL.md)）：

```bash
# 1. 提取：截图 + DOM token → spec.json + rawTokens 候选
node scripts/extract.mjs https://example.com --out output/example.com

# 2. Claude 看图做语义修正（accent、氛围、规则），更新 spec.json

# 3. 渲染 DESIGN.md（9 区块）+ preview.html 视觉目录
node scripts/preview.mjs output/example.com/spec.json --out output/example.com

# 4. 验证：调色板回归，确认 spec 与线上站点匹配
node scripts/verify.mjs output/example.com/spec.json
```

## 为什么这样设计

最初版本是全脚本自动提取，但 accent 识别暴露了天花板：linear.app 的品牌黄 `#e4f222` 只出现在 logo 上，任何统计聚类都抓不到——它把深色背景当成了 accent。品牌色是**语义判断**：人眼/视觉模型一眼认出"黄色是品牌色"，算法做不到。于是 skill 把判断权交给 Claude 本体，脚本只提供精确值和候选。色值、字号、间距这些**必须精确**的交给脚本——模型从截图推断字号会出错，DOM 读到的是真实值。

## 目录结构

```
.claude/skills/design-fingerprint/
├── SKILL.md            ← 工作流定义（skill 的入口）
├── README.md           ← 设计哲学与背景
├── package.json        ← 依赖：playwright
├── scripts/
│   ├── extract.mjs     ← DOM token 提取（截图 + computed styles + 聚类候选）
│   ├── preview.mjs     ← 渲染 DESIGN.md + preview.html/preview-dark.html
│   └── verify.mjs      ← 调色板回归：spec 是否仍匹配线上站点
└── output/             ← 每个站点一个子目录（<domain>/）
    └── <domain>/
        ├── spec.json           ← 设计指纹（机器可读，验证用）
        ├── DESIGN.md           ← 9 区块设计文档（人类可读）
        ├── preview.html        ← 视觉目录，浏览器打开核对
        ├── .screenshots/       ← 提取时的截图（page/mobile/dark）
        └── verify-runs/        ← 验证产物（参考页、截图、report.json）
```

## 示例

[在线预览](https://woodwhite0ets.github.io/design-fingerprint/) — 苹果设计指纹的视觉目录、暗色模式、生成的博客页面。

`output/` 目录里有一个完整示例：从 [apple.com](https://www.apple.com) 提取设计指纹（白底、SF Pro、`#0071e3` 品牌蓝、pill 按钮、全平表面），并用它生成了一页原创博客（`blog-apple-style.html`）。

## 许可证

MIT
