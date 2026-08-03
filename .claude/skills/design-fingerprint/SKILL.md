---
name: design-md
description: 提取任意网站的设计系统生成 DESIGN.md（模仿），或基于 DESIGN.md 生成风格一致的新页面（创新）。当用户说"模仿这个网站的风格/提取某网站的设计规范/照着这个设计做新页面"时使用。
---

# DESIGN.md 设计系统工作流

> 本 skill 同时发布为仓库 [design-fingerprint](https://github.com/<you>/design-fingerprint)。
> 仓库根 README 有人类可读的介绍；本文档是 Claude 执行时的工作流。

这个 skill 把任何网站变成一份机器可读的 `DESIGN.md`（Stitch 概念，与 VoltAgent/awesome-design-md 同构），然后让编码 agent 能据此生成视觉一致的 UI。**两条路径：**

1. **模仿（提取）**：输入 URL → 截图 + DOM token → DESIGN.md
2. **创新（生成）**：基于 DESIGN.md → 生成风格一致但内容全新的页面

## 关键设计：视觉由 Claude 本体完成，精确值由脚本完成

- **Claude（你）负责**：看截图做**语义判断**——哪个是品牌色（accent）、设计氛围是什么、组件有哪些状态、生成 UI。你是视觉模型，直接读图。
- **DOM 脚本负责**：读 computed styles 拿**精确值**——色值、字号、间距、圆角、阴影。统计聚类无法判断的（如"哪个颜色是品牌色"）会作为候选暴露给你。

## 目录结构

```
.claude/skills/design-md/
├── SKILL.md            ← 本文件（工作流定义）
├── README.md           ← 设计哲学与背景
├── package.json        ← 依赖：playwright（node_modules/ 已安装）
└── scripts/
    ├── extract.mjs     ← DOM token 提取（无 API key，读真实 computed styles）
    ├── preview.mjs     ← 生成 DESIGN.md + preview.html 视觉目录（含暗色）
    └── verify.mjs      ← 调色板回归：spec 是否仍匹配线上站点
```

## 工作流 A：模仿（提取站点 → DESIGN.md）

当用户给出 URL（"模仿这个网站/提取这个网站的风格"）：

### Step 1 — 截图 + DOM 提取

```bash
node .claude/skills/design-md/scripts/extract.mjs <url> [--out dir] [--dark]
```

这一步输出：
- `.screenshots/page.png`、`mobile.png`、`dark.png`（**你要看的图**）
- `spec.json`（DOM 提取的精确 token + `rawTokens` 候选）

### Step 2 — 你看图，做语义修正

用 Read 工具查看截图，然后修正 `spec.json` 中脚本无法判断的部分（对比 `rawTokens` 候选）：

| 项 | 判断方法 |
|----|---------|
| **accent（品牌色）** | 看 logo、主按钮、链接色。脚本的 `rawTokens.accentCandidates` 不一定对（如 linear.app 的黄色只在 logo 上） |
| **atmosphere** | 写 2-3 句氛围描述：布局密度、留白、色彩情绪、字体气质、装饰风格 |
| **Do's / Don'ts** | 列出让生成 UI 与截图一致的约束（如"黄色只用于强调，不能大面积使用"） |
| **暗色模式** | 看 dark.png，修正 `theme.darkMode` |
| **组件状态** | hover/active/focus 若截图可见则记录，否则基于基色合理推导 |

修正原则：**脚本给的精确值（色值、字号、间距）默认可信，语义值（哪个是 accent、氛围、规则）由你判断。** 若两者冲突，以你看到的截图为准，并在 `spec.json` 里更新。

### Step 3 — 生成 DESIGN.md

```bash
node .claude/skills/design-md/scripts/preview.mjs <spec.json路径> --md --out <输出目录>
```

得到 `DESIGN.md`（9 区块）+ `preview.html`/`preview-dark.html`（人类可核验的视觉目录）。

### Step 4 — 验证（可选但推荐）

```bash
node .claude/skills/design-md/scripts/verify.mjs <spec.json路径> [--url <URL>] [--out <目录>]
```

用 spec 渲染参考组件页，截图后与线上站点对比**主导调色板**（coverage + 平均色距），
OVERALL ≥ 0.6 通过（≥ 0.85 GOOD），否则退出码 1。用途：

- **站点改版了** → 分数骤降，提示需要重新提取
- **提取有误** → 分数低，提示 Step 2 修正漏了
- 产物（reference.html、ref/live 截图、report.json）输出到 `output/<domain>/verify-runs/`

注意：`--url` 缺省时取 spec 里的 `sourceUrl`。深色站点（如 linear.app）需要 spec 匹配暗色调色板才能拿高分。

### Step 5 — 交付

把 DESIGN.md 放到项目根（或用户指定位置），告诉用户：
- 已生成 DESIGN.md + preview.html
- 提示可打开 preview.html 核对
- 附上一句话摘要：品牌色、氛围、字阶

## 工作流 B：创新（基于 DESIGN.md 生成新页面）

当用户说"用这个设计做 X"（已有 DESIGN.md，或刚提取完）：

1. **读 DESIGN.md**（或 spec.json）——色板、字阶、组件、Do's/Don'ts 都是约束
2. **生成新内容**：不复制原站点的内容/文案，只继承设计语言。原创文案、结构、信息架构
3. **严格遵守**：
   - 颜色只用 palette 里的角色（`bg-*`、`text-*`、`accent`）
   - 字号只用 typeScale
   - 间距只用 spacingScale
   - 按钮/卡片/输入框用组件规范
   - Do's 要做，Don'ts 绝不碰
4. **HTML 内联实现**（单文件，或按用户技术栈），CSS 变量命名跟随角色：
   ```css
   :root { --bg: #0f1011; --surface: #1c1c1d; --text: #f7f8f8; --accent: #e4f222; }
   ```

## 质量检查（两个流程都做）

交付前对照截图自查：
- [ ] 背景色、文字色、accent 与截图一致
- [ ] 字阶（大小/字重/字体）与截图观感一致
- [ ] 组件样式（圆角、阴影、hover）符合截图
- [ ] Do's/Don'ts 里没有"用脚趾头都能看出截图违背"的规则
- [ ] preview.html 打开后像原站点（一眼扫过去气质一致）

## 输出位置约定

- 提取：`output/<domain>/`（DESIGN.md、preview.html、preview-dark.html、spec.json、.screenshots/、verify-runs/）
- 生成：用户指定，或项目根/`generated/` 下
