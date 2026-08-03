# design-fingerprint

> English · [中文](README.md)

A Claude Code skill that turns any website into a machine-readable `DESIGN.md` design fingerprint (mimic), or generates new pages in a consistent style from one (innovate).

```
website URL ──▶ DESIGN.md (design fingerprint) ──▶ new page in the same style
   mimic path                                   innovate path
```

## What problem does it solve

Getting an AI to truly imitate a design system when generating UI. The common approach is to feed a screenshot or a description into the prompt — the AI gets the "vibe" right, but guesses at hex values, font sizes, and spacing. `design-fingerprint` separates the two:

| Task | Done by | Why |
|------|---------|-----|
| Hex values, font sizes, spacing, radii, shadows (**must be exact**) | DOM script | Reads real computed styles — zero error |
| Which color is the brand accent, design atmosphere, Do's/Don'ts (**semantic judgement**) | Claude (vision model) | The things an algorithm can't guess, settled at a glance |

**No API key required** — Claude reads screenshots directly for visual judgement; the script only collects exact values inside the page. Candidates that statistical clustering can't resolve (like "which color is the brand accent") are surfaced for the vision model to decide.

## Installation

```bash
# 1. Drop the skill into your project's .claude/skills/
git clone https://github.com/woodwhite0ets/design-fingerprint.git .claude/skills/design-fingerprint
# 2. Install dependencies (once)
cd .claude/skills/design-fingerprint && npm install
# 3. (optional) dotnet SDK to verify C#/WPF generation
```

## Usage

In your Claude Code session, say:

- **Mimic**: `mimic the style of https://example.com` or `extract the design system of example.com`
- **Innovate**: `make a blog page using the Apple design from earlier` or `generate a product landing page following the DESIGN.md`

The skill workflow (details in [SKILL.md](.claude/skills/design-fingerprint/SKILL.md)):

```bash
# 1. Extract: screenshots + DOM tokens → spec.json + rawTokens candidates
node scripts/extract.mjs https://example.com --out output/example.com

# 2. Claude looks at the screenshots and fixes semantic values (accent, atmosphere, rules) in spec.json

# 3. Render DESIGN.md (9 sections) + preview.html visual catalog
node scripts/preview.mjs output/example.com/spec.json --out output/example.com

# 4. Verify: palette regression to confirm the spec still matches the live site
node scripts/verify.mjs output/example.com/spec.json
```

## Why it's designed this way

The first version was fully automated extraction — until accent detection hit its ceiling. linear.app's brand yellow `#e4f222` appears only in the logo, so every statistical clustering missed it (the dark background was picked as the accent instead). A brand accent is a **semantic judgement**: a human or vision model recognizes "that yellow is the brand color" at a glance; an algorithm can't. So the skill hands the judgement to Claude itself and lets scripts provide exact values and candidates. Values that **must be exact** — hex, font size, spacing — go to the script: a model inferring font sizes from a screenshot gets it wrong, while the DOM reads the true value.

## Repository structure

```
.claude/skills/design-fingerprint/
├── SKILL.md            ← workflow definition (the skill's entry point)
├── README.md           ← design philosophy and background
├── package.json        ← dependency: playwright
├── scripts/
│   ├── extract.mjs     ← DOM token extraction (screenshots + computed styles + clustering candidates)
│   ├── preview.mjs     ← renders DESIGN.md + preview.html/preview-dark.html
│   └── verify.mjs      ← palette regression: does the spec still match the live site?
└── output/             ← one subdirectory per site (<domain>/)
    └── <domain>/
        ├── spec.json           ← the design fingerprint (machine-readable, used by verify)
        ├── DESIGN.md           ← 9-section design document (human-readable)
        ├── preview.html        ← visual catalog, open in a browser to check
        ├── .screenshots/       ← extraction screenshots (page/mobile/dark)
        └── verify-runs/        ← verification artifacts (reference page, screenshots, report.json)
```

## Example

[Live preview](https://woodwhite0ets.github.io/design-fingerprint/) — the Apple design fingerprint's visual catalog, dark-mode preview, and the generated blog page.

`output/` contains complete examples:

- **Web**: a design fingerprint extracted from [apple.com](https://www.apple.com) (white background, SF Pro, `#0071e3` brand blue, pill buttons, flat surfaces), used to generate an original blog page (`blog-apple-style.html`)
- **Desktop (C#/WPF)**: the same Apple fingerprint generated as an industrial HMI dashboard (`industrial-hmi-csharp/`) — Apple design language on .NET 8 WPF: pill buttons, flat cards, dark section, live chart, alarm dialog, confirm-before-act on emergency controls. Build-verified with `dotnet build`

## License

MIT
