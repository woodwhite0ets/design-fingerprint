#!/usr/bin/env node
// design-md skill: DOM design-token extraction.
//
// Usage: node extract.mjs <url> [--out dir] [--dark]
//
// Reads computed styles straight from the live page (no API key) and emits:
//   <out>/spec.json          structured tokens (+ rawTokens candidates)
//   <out>/.screenshots/      page.png / mobile.png / dark.png (for the vision model)
//
// The accent/brand color is genuinely a visual judgement (which color reads
// as "brand"?). This script exposes candidates in rawTokens and makes a
// best-effort pick; the skill's vision model corrects it from screenshots.

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const COLLECT_SCRIPT = `() => {
  const cache = new Map();
  function toHex(str) {
    if (!str || str === "transparent" || str === "rgba(0, 0, 0, 0)") return null;
    if (cache.has(str)) return cache.get(str);
    try {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = str; ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      const hex = "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      cache.set(str, hex);
      return hex;
    } catch { return null; }
  }
  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity) <= 0.1) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }
  const S = { bg: [], text: [], border: [], shadow: [], radius: [], spacing: [], fontFamily: [], interactive: [] };
  const ffCount = new Map();
  let budget = 500;
  for (const el of document.querySelectorAll("body *")) {
    if (budget-- <= 0) break;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const leaf = el.childElementCount === 0;
    const text = leaf ? (el.textContent || "").trim().slice(0, 40) : "";
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    const bg = toHex(cs.backgroundColor);
    const fg = toHex(cs.color);
    const bc = toHex(cs.borderTopColor);
    const bw = parseFloat(cs.borderTopWidth);
    const radius = parseFloat(cs.borderRadius);
    if (bg) S.bg.push({ hex: bg, area, tag });
    if (fg && text) S.text.push({ hex: fg, size: parseFloat(cs.fontSize) || 0, weight: Number(cs.fontWeight) || 400, lh: parseFloat(cs.lineHeight) || 0, ls: parseFloat(cs.letterSpacing) || 0, area, tag });
    if (bc && bw > 0) S.border.push({ hex: bc, area });
    if (cs.boxShadow && cs.boxShadow !== "none") S.shadow.push({ value: cs.boxShadow, area, tag });
    if (radius > 0) S.radius.push({ value: radius, area, tag });
    if (S.spacing.length < 80) {
      for (const prop of ["paddingTop", "paddingLeft", "paddingRight", "paddingBottom", "marginTop", "marginLeft", "marginBottom", "marginRight", "gap"]) {
        const v = parseFloat(cs[prop]);
        if (v > 0) S.spacing.push(v);
      }
    }
    const ff = cs.fontFamily;
    if (ff) ffCount.set(ff, (ffCount.get(ff) || 0) + 1);
    if (["button", "a", "input", "select", "textarea"].includes(tag) || el.getAttribute("role") === "button") {
      S.interactive.push({
        tag, bg, fg, border: bc && bw > 0 ? bc : null, radius,
        padding: [parseFloat(cs.paddingTop), parseFloat(cs.paddingLeft), parseFloat(cs.paddingBottom), parseFloat(cs.paddingRight)],
        weight: Number(cs.fontWeight) || 400, text, inHeader: !!el.closest("header, nav")
      });
    }
  }
  const body = document.body;
  const main = document.querySelector("main, article, #main, .container");
  return {
    samples: S,
    fontFamilies: [...ffCount.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 4),
    bodyBg: toHex(getComputedStyle(body).backgroundColor),
    bodyFont: parseFloat(getComputedStyle(body).fontSize) || 16,
    mainWidth: main ? Math.round(main.getBoundingClientRect().width) : 0,
    darkPref: matchMedia("(prefers-color-scheme: dark)").matches
  };
}`;

function hexToRgb(hex) {
  const clean = hex.replace(/^#/, "");
  const n = parseInt(clean, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}
function dist(a, b) { return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b); }
function sat(c) { const m = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b); return m === 0 ? 0 : (m - mn) / m; }
function lum(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }
function mix(hexA, hexB, tA) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex({ r: a.r * tA + b.r * (1 - tA), g: a.g * tA + b.g * (1 - tA), b: a.b * tA + b.b * (1 - tA) });
}
function darken(hex, pct) { const c = hexToRgb(hex); return rgbToHex({ r: c.r * (1 - pct), g: c.g * (1 - pct), b: c.b * (1 - pct) }); }
function mode(vals) {
  if (!vals.length) return null;
  const m = new Map();
  for (const v of vals) m.set(v, (m.get(v) || 0) + 1);
  let best = null;
  for (const [v, n] of m) if (!best || n > best[1]) best = [v, n];
  return best[0];
}
function clusterSamples(samples, tol) {
  const list = [];
  for (const s of samples) {
    const rgb = hexToRgb(s.hex);
    let best = null, bestD = Infinity;
    for (const c of list) { const d = dist(c.rgb, rgb); if (d < bestD) { bestD = d; best = c; } }
    if (best && bestD <= tol) {
      const n = best.count;
      best.rgb = { r: (best.rgb.r * n + rgb.r) / (n + 1), g: (best.rgb.g * n + rgb.g) / (n + 1), b: (best.rgb.b * n + rgb.b) / (n + 1) };
      best.hex = rgbToHex(best.rgb); best.count++; best.weight += s.area;
    } else {
      list.push({ rgb, hex: s.hex, count: 1, weight: s.area });
    }
  }
  return list.sort((a, b) => b.weight - a.weight);
}
const TYPE_NAMES = [["Display", 2.5], ["H1", 1.75], ["H2", 1.375], ["H3", 1.125], ["Body", 0.9375], ["Small", 0.8125], ["Caption", 0]];
function typeName(rem) { for (const [name, min] of TYPE_NAMES) if (rem >= min) return name; return "Caption"; }

async function main() {
  const argv = process.argv.slice(2);
  const urlArg = argv.find((a) => !a.startsWith("--"));
  const outArg = argv.indexOf("--out") >= 0 ? argv[argv.indexOf("--out") + 1] : null;
  if (!urlArg) { console.error("Usage: node extract.mjs <url> [--out dir] [--dark]"); process.exit(1); }
  const url = urlArg.includes("://") ? urlArg : `https://${urlArg}`;
  const host = new URL(url).hostname.replace(/^www\./, "");
  const outDir = outArg ?? join(process.cwd(), "output", host);
  await mkdir(join(outDir, ".screenshots"), { recursive: true });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US", colorScheme: "light" });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const raw = await page.evaluate(new Function(`return (${COLLECT_SCRIPT})()`));
    const spec = buildSpec({ raw, url, host });

    await page.screenshot({ path: join(outDir, ".screenshots", "page.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, ".screenshots", "mobile.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, ".screenshots", "dark.png") });

    await writeFile(join(outDir, "spec.json"), JSON.stringify(spec, null, 2));
    console.log(`wrote ${join(outDir, "spec.json")}`);
    console.log(`screenshots in ${join(outDir, ".screenshots")}`);
    console.log(`\naccent (heuristic): ${spec.colors.find((c) => c.role === "accent").hex}`);
    console.log(`accent candidates for the vision pass: ${(spec.rawTokens?.accentCandidates ?? []).join(", ")}`);
  } finally {
    await browser.close();
  }
}

function buildSpec({ raw, url, host }) {
  const S = raw.samples;
  if (!S.bg.length && !S.text.length) {
    throw new Error("extraction found no visible content — the page may be a login wall or failed to render");
  }

  const bgClusters = clusterSamples(S.bg, 36);
  const textClusters = clusterSamples(S.text, 30);
  const borderClusters = clusterSamples(S.border, 24);

  const background = `#${(raw.bodyBg && bgClusters.some((c) => c.hex === raw.bodyBg) ? raw.bodyBg : bgClusters[0]?.hex ?? "ffffff").replace(/^#/, "")}`;
  const backgroundRgb = hexToRgb(background);
  const darkSite = lum(backgroundRgb) < 0.25;

  const textPrimary = textClusters[0]?.hex ?? (darkSite ? "#f5f5f5" : "#111111");
  const textSecondary = textClusters.find((c) => dist(hexToRgb(c.hex), hexToRgb(textPrimary)) > 60)?.hex ?? mix(textPrimary, darkSite ? "#000000" : "#ffffff", darkSite ? 0.5 : 0.55);
  const border = borderClusters[0]?.hex ?? mix(textPrimary, background, 0.75);
  const textOnDark = darkSite ? background : mix(textPrimary, "#ffffff", 0.75);

  const interBgs = S.interactive.filter((i) => i.bg).map((i) => ({ hex: i.bg, area: i.tag === "button" ? 3 : 1 }));
  const interClusters = clusterSamples(interBgs, 30);
  const interFgs = S.interactive.map((i) => ({ hex: i.fg, area: i.tag === "button" ? 2 : 1 })).filter((i) => i.hex && sat(hexToRgb(i.hex)) > 0.15);
  const interFgClusters = clusterSamples(interFgs, 40);
  const accent = interFgClusters[0]?.hex ?? interClusters.find((c) => sat(c.rgb) > 0.2)?.hex ?? bgClusters.find((c) => sat(c.rgb) > 0.2)?.hex ?? textClusters.find((c) => sat(c.rgb) > 0.15)?.hex ?? textPrimary;
  const accentHover = darken(accent, 0.15);
  const accentSoft = mix(accent, background, 0.85);

  const elevatedTarget = darkSite ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  const backgroundElevated = bgClusters.filter((c) => dist(c.rgb, backgroundRgb) > 30).sort((a, b) => dist(a.rgb, elevatedTarget) - dist(b.rgb, elevatedTarget))[0]?.hex ?? mix(background, darkSite ? "#000000" : "#ffffff", 0.25);
  const inverseCluster = darkSite ? bgClusters.find((c) => lum(c.rgb) > 0.75) : bgClusters.find((c) => lum(c.rgb) < 0.25 && sat(c.rgb) < 0.4);

  const colors = [
    { role: "background", hex: background, description: darkSite ? "Page background (dark theme)" : "Page background" },
    { role: "background-elevated", hex: backgroundElevated, description: "Cards and elevated surfaces" }
  ];
  if (inverseCluster) colors.push({ role: "background-inverse", hex: inverseCluster.hex, description: "Inverse header/footer surface" });
  colors.push(
    { role: "text-primary", hex: textPrimary, description: "Headings and primary text" },
    { role: "text-secondary", hex: textSecondary, description: "Supporting text" },
    { role: "text-on-dark", hex: textOnDark, description: "Text on inverse/dark surfaces" },
    { role: "border", hex: border, description: "Hairline dividers and input borders" },
    { role: "accent", hex: accent, description: "Brand accent" },
    { role: "accent-hover", hex: accentHover, description: "Accent hover state" },
    { role: "accent-soft", hex: accentSoft, description: "Accent tint backgrounds" }
  );

  // typography
  const sizeClusters = [];
  for (const t of S.text) {
    if (!t.size) continue;
    let c = sizeClusters.find((c) => Math.abs(c.size - t.size) <= 2);
    if (!c) { c = { size: t.size, weight: 0, weights: [], lh: [], ls: [] }; sizeClusters.push(c); }
    c.weight += t.area; c.weights.push(t.weight); c.lh.push(t.lh); c.ls.push(t.ls);
  }
  sizeClusters.sort((a, b) => b.weight - a.weight);
  const usedNames = new Set();
  const typeScale = sizeClusters.slice(0, 7).sort((a, b) => b.size - a.size).map((c) => {
    const rem = Math.round((c.size / 16) * 100) / 100;
    const name = typeName(rem);
    if (usedNames.has(name)) return null;
    usedNames.add(name);
    const lh = c.lh.find((v) => v > 0);
    const ls = c.ls.find((v) => v > 0);
    return { name, size: `${rem}rem`, weight: mode(c.weights) ?? 400, lineHeight: lh ? Math.round((lh / c.size) * 100) / 100 : 1.5, letterSpacing: ls ? `${Math.round((ls / c.size) * 1000) / 1000}em` : "", font: "sans" };
  }).filter(Boolean);

  const allFf = raw.fontFamilies.join(" ");
  const fontFamilies = { sans: raw.fontFamilies[0] ?? "ui-sans-serif, system-ui, sans-serif" };
  if (/serif/i.test(allFf)) fontFamilies.serif = raw.fontFamilies.find((f) => /serif/i.test(f)) ?? "Georgia, serif";
  if (/mono/i.test(allFf)) fontFamilies.mono = raw.fontFamilies.find((f) => /mono/i.test(f)) ?? "ui-monospace, monospace";

  // components
  const isAccent = (h) => h && dist(hexToRgb(h), hexToRgb(accent)) < 60;
  const groups = new Map();
  for (const i of S.interactive) {
    const key = i.bg ?? "none";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const variants = [];
  for (const [key, items] of sortedGroups) {
    if (variants.length >= 3) break;
    const fg = mode(items.map((i) => i.fg).filter(Boolean));
    const borderColor = mode(items.map((i) => i.border).filter(Boolean));
    const radii = items.map((i) => i.radius).filter((v) => v > 0);
    const pads = items.map((i) => i.padding.filter((v) => v > 0));
    const padFlat = pads.flat().map((v) => Math.round(v));
    const borderRadius = radii.length ? `${Math.round(mode(radii))}px` : "6px";
    const padding = padFlat.length ? (() => { const [pt, pl, pb, pr] = [0, 1, 2, 3].map((i) => mode(padFlat.filter((_, j) => j % 4 === i)) ?? 12); return pt === pb && pl === pr ? `${pt}px ${pl}px` : `${pt}px ${pl}px ${pb}px ${pr}px`; })() : "10px 16px";
    let variant;
    if (isAccent(key)) variant = "primary";
    else if (key === "none") variant = borderColor ? "secondary" : "ghost";
    else if (isAccent(fg) && key === "none") variant = "ghost";
    else if (isAccent(fg)) variant = "primary";
    else variant = variants.some((v) => v.variant === "secondary") ? "tertiary" : "secondary";
    variants.push({ variant, background: key === "none" ? "transparent" : key, text: fg ?? "text-primary", border: borderColor ?? "none", hover: isAccent(key) ? "accent-hover" : "accent-soft" });
  }
  if (!variants.length) variants.push({ variant: "primary", background: "accent", text: "text-on-dark", border: "none", hover: "accent-hover" });
  variants.sort((a, b) => (a.variant === "primary" ? -1 : b.variant === "primary" ? 1 : 0));

  const cardCluster = bgClusters.filter((c) => dist(c.rgb, backgroundRgb) > 30 && dist(c.rgb, hexToRgb(accent)) > 60)[0];
  const cardRadius = Math.round(mode(S.radius.filter((r) => r.tag === "div").map((r) => r.value)) ?? 12);
  const divShadows = S.shadow.filter((s) => s.tag === "div" || s.tag === "article");
  const cardShadow = divShadows.length ? divShadows.sort((a, b) => b.area - a.area)[0].value : "none";

  const inputItems = S.interactive.filter((i) => ["input", "select", "textarea"].includes(i.tag));
  const input = {
    background: mode(inputItems.map((i) => i.bg).filter(Boolean)) ?? "background-elevated",
    border: mode(inputItems.map((i) => i.border).filter(Boolean)) ?? "border",
    borderRadius: inputItems.some((i) => i.radius > 0) ? `${Math.round(mode(inputItems.map((i) => i.radius).filter((v) => v > 0)))}px` : "6px",
    focusBorder: "accent",
    padding: "10px 12px"
  };

  const navItems = S.interactive.filter((i) => i.inHeader && i.tag === "a");
  const nav = {
    inactive: mode(navItems.map((i) => i.fg).filter(Boolean)) ?? "text-secondary",
    active: "accent",
    activeBackground: "accent-soft",
    borderRadius: navItems.some((i) => i.radius > 0) ? `${Math.round(mode(navItems.map((i) => i.radius).filter((v) => v > 0)))}px` : "6px"
  };

  const button = {
    borderRadius: (() => { const radii = S.interactive.map((i) => i.radius).filter((v) => v > 0); return radii.length ? `${Math.round(mode(radii))}px` : "6px"; })(),
    padding: variants[0]?.padding ?? "10px 16px",
    fontWeight: mode(S.interactive.map((i) => i.weight).filter(Boolean)) ?? 600,
    variants
  };
  const components = { button, card: { background: cardCluster?.hex ?? "background-elevated", border: "border", borderRadius: `${cardRadius}px`, shadow: cardShadow }, input, navItem: nav };

  // layout
  const spacing = S.spacing.map((v) => Math.round(v / 4) * 4).filter((v) => v >= 4).sort((a, b) => a - b);
  const spacingScale = [...new Set(spacing)].slice(0, 9);
  const density = mode(spacing.map((v) => (v <= 8 ? "compact" : v <= 24 ? "standard" : "relaxed"))) ?? "standard";

  // depth
  const shadowLevels = S.shadow.slice(0, 3);
  const depth = [{ name: "rest", shadow: "none", description: "Flat surfaces" }];
  if (shadowLevels.length) depth.push({ name: "raised", shadow: shadowLevels.sort((a, b) => b.area - a.area)[0].value, description: "Cards and dropdowns" });
  const maxBlur = S.shadow.sort((a, b) => blurPx(b.value) - blurPx(a.value))[0];
  if (maxBlur && blurPx(maxBlur.value) > 8) depth.push({ name: "overlay", shadow: maxBlur.value, description: "Modals and popovers" });

  // atmosphere & rules — templated; the vision model rewrites these
  const bgTone = (() => { const r = backgroundRgb.r, g = backgroundRgb.g, b = backgroundRgb.b; if (r - b > 25) return "warm"; if (b - r > 25) return "cool"; return "neutral"; })();
  const fontLabel = fontFamilies.serif ? "serif headings with sans-serif body" : "clean sans-serif type";
  const atmosphere = `${density[0].toUpperCase()}${density.slice(1)} ${darkSite ? "dark" : "light"} ${bgTone} design system. ${fontLabel}, accent ${accent}, background ${background}.`;
  const rules = {
    do: [
      "Use the color roles below instead of raw hex values",
      `Use the ${fontLabel.includes("serif") ? "serif family for headings and sans for body" : "sans-serif family for all text"}`,
      "Follow the type scale for all text styles",
      "Keep spacing consistent with the spacing scale",
      "Use the component styles for buttons, cards, inputs, and navigation"
    ],
    dont: [
      "Don't introduce colors outside this palette",
      "Don't add font families or weights outside the extracted set",
      "Don't create new elevation levels beyond the depth scale",
      `Don't use pure ${darkSite ? "white" : "black"} (#fff/#000) where the palette defines a softer neutral`
    ]
  };
  if (sat(hexToRgb(accent)) > 0.35) rules.do.push("Use the accent color sparingly for primary actions and emphasis");
  if (darkSite) rules.dont.push("Don't use light backgrounds for large surfaces — this is a dark site");

  const promptGuide = {
    quickReference: `bg ${background} · text ${textPrimary} / ${textSecondary} · accent ${accent} · ${fontLabel}`,
    starterPrompts: [
      `Build a ${density} ${darkSite ? "dark" : "light"} landing page with background ${background}, accent ${accent}, ${fontLabel}.`,
      "Build a pricing card grid using the extracted card, button, and input styles."
    ]
  };

  const rem = (px) => `${Math.round((px / 16) * 100) / 100}rem`;
  return {
    sourceUrl: url,
    sourceDomain: host,
    capturedAt: new Date().toISOString(),
    generatedBy: "design-md-generator (dom-extraction)",
    rawTokens: {
      accentCandidates: interFgClusters.map((c) => c.hex).slice(0, 5),
      interactiveBgClusters: interClusters.map((c) => c.hex).slice(0, 5),
      bgClusters: bgClusters.map((c) => c.hex).slice(0, 5),
      textClusters: textClusters.map((c) => c.hex).slice(0, 5)
    },
    typography: { fontFamilies, typeScale },
    colors,
    components,
    layout: {
      spacingScale: spacingScale.length ? spacingScale : [4, 8, 12, 16, 24, 32, 48, 64, 96],
      gridColumns: 12,
      containerMaxWidth: raw.mainWidth ? `${raw.mainWidth}px` : "1200px",
      contentPadding: rem(spacing.find((v) => v >= 16) ?? 16),
      sectionGap: rem(spacing.find((v) => v >= 48) ?? 64),
      density
    },
    depth,
    theme: {
      atmosphere,
      density,
      darkMode: darkSite
        ? { background, surface: backgroundElevated, text: textPrimary, textSecondary, border }
        : {
            background: mix(background, "#000000", 0.85),
            surface: mix(backgroundElevated, "#000000", 0.82),
            text: mix(textPrimary, "#ffffff", 0.6),
            textSecondary: mix(textSecondary, "#ffffff", 0.35),
            border: mix(border, "#555555", 0.55)
          }
    },
    responsive: {
      breakpoints: [
        { name: "mobile", width: 0, layout: "Single column, stacked cards" },
        { name: "tablet", width: 768, layout: "Two-column grids" },
        { name: "desktop", width: 1024, layout: "Full multi-column layout" }
      ],
      touchTargets: "Minimum 44px tap targets on touch devices.",
      collapseStrategy: "Nav collapses into a menu below 768px; multi-column grids collapse to single column."
    },
    rules,
    promptGuide
  };
}

function blurPx(shadow) {
  const m = shadow.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/);
  if (!m) return 0;
  return Math.abs(parseFloat(m[3])) || 0;
}

main().catch((e) => { console.error("extract failed:", e.message); process.exit(1); });
