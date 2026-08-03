# design-md skill

把任意网站变成 `DESIGN.md` 设计系统（模仿），或基于 DESIGN.md 生成风格一致的新页面（创新）。

本目录是 [design-fingerprint](https://github.com/woodwhite0ets/design-fingerprint) 仓库的内容——仓库根 README 有完整项目介绍。

## 设计哲学

**视觉判断归 Claude，精确值归脚本：**

- **Claude 本体**是视觉模型 —— 看截图判断 accent（品牌色）、氛围、组件状态，生成 UI。不需要 API key。
- **DOM 脚本**（`scripts/extract.mjs`）读真实 computed styles，拿精确 token（色值、字号、间距、圆角、阴影）。统计聚类无法判断的（如"哪个颜色是品牌色"）会作为 `rawTokens` 候选暴露，由 Claude 看截图定夺。

## 用法

```bash
# 1. 提取（模仿）
node .claude/skills/design-md/scripts/extract.mjs https://example.com --out output/example.com

# 2. 渲染 DESIGN.md + preview.html
node .claude/skills/design-md/scripts/preview.mjs output/example.com/spec.json --out output/example.com

# 3. 验证（调色板回归，可选）
node .claude/skills/design-md/scripts/verify.mjs output/example.com/spec.json
```

`extract.mjs` 输出 `spec.json` + 截图（page/mobile/dark.png）。**Claude 应 Read 截图**，修正 spec 中脚本无法判断的语义值（accent、atmosphere、Do's/Don'ts），再渲染。

## 为什么这样设计（背景）

最初版本是全脚本自动提取，但 accent 识别暴露了天花板：linear.app 的品牌黄 `#e4f222` 只出现在 logo 上，任何统计聚类都抓不到（它把 `#08090a` 背景色当成了 accent）。品牌色是**语义判断**——人眼/视觉模型一眼认出"黄色是品牌色"，算法做不到。所以 skill 把判断权交给 Claude 本体，脚本只提供精确值和候选。

类似地，氛围描述、Do's/Don'ts 规则、hover 状态推导都是语义任务，交给人形智能；色值、字号、间距这些**必须精确**的，交给脚本（模型从截图推断字号会出错，DOM 读到的是真实值）。

## 验证

```bash
node .claude/skills/design-md/scripts/extract.mjs https://linear.app --out /tmp/t
# 预期：accent (heuristic): #08090a（错误但记录了候选）
# rawTokens.accentCandidates 会包含视觉候选，由 Claude 修正为 #e4f222
```
