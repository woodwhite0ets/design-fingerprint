#!/usr/bin/env node
// design-md skill: regression check — does the spec still match the live site?
//
// Usage: node verify.mjs <spec.json> [--url https://site] [--out dir]
//
// Renders the spec's components as a reference page, screenshots it and the
// live site, extracts each page's dominant-color palette, and scores how well
// the spec's palette covers the live site's. Catches site redesigns and bad
// extractions without needing a vision model. Exit code 1 when OVERALL < 0.6.
//
// Note: palette comparison (not pixel comparison) — reference component pages
// never share a layout with the real site. Dark sites (e.g. linear.app) need
// a spec whose colors match the dark palette to score well.

import { chromium } from "playwright";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

const COLOR_MAP = {
  background: "#ffffff",
  "background-elevated": "#ffffff",
  "background-inverse": "#111111",
  "text-primary": "#111111",
  "text-secondary": "#666666",
  "text-on-dark": "#ffffff",
  border: "#e5e5e5",
  accent: "#0066ff",
  "accent-hover": "#0052cc",
  "accent-soft": "#e6f0ff",
  success: "#16a34a",
  warning: "#f59e0b",
  danger: "#dc2626"
};

function color(spec, role) {
  if (!role || role === "none" || role === "transparent") return "transparent";
  if (role.startsWith("#")) return role;
  const hit = spec.colors.find((c) => c.role === role);
  return hit ? hit.hex : COLOR_MAP[role] ?? "transparent";
}

async function renderReference({ spec, dir }) {
  await mkdir(dir, { recursive: true });
  const button = spec.components?.button ?? {};
  const nav = spec.components?.navItem ?? {};
  const card = spec.components?.card ?? {};
  const variants = (button.variants ?? []).filter((v) => v.background && v.text).slice(0, 3);

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { display: grid; grid-template-columns: repeat(2, 1fr); grid-auto-rows: auto; gap: 24px; padding: 32px; background: ${color(spec, "background")}; font-family: ui-sans-serif, system-ui, sans-serif; }
  .cell { background: ${color(spec, "background-elevated")}; border: 1px solid ${color(spec, "border")}; border-radius: 12px; padding: 24px; min-height: 140px; display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; }
  .cell-nav { flex-direction: column; align-items: stretch; justify-content: flex-start; }
  .cell-card .demo { width: 100%; background: ${color(spec, "background-elevated")}; border: 1px solid ${color(spec, "border")}; border-radius: ${card.borderRadius ?? "12px"}; padding: 20px; box-shadow: ${card.shadow ?? "none"}; }
  a { text-decoration: none; }
  @media (prefers-color-scheme: dark) {
    body { background: ${spec.theme?.darkMode?.background ?? "#111"}; }
    .cell { background: ${spec.theme?.darkMode?.surface ?? "#1a1a1a"}; border-color: ${spec.theme?.darkMode?.border ?? "#333"}; }
  }
</style></head>
<body>
  <div class="cell" id="cell-buttons">${variants.map((v) => `<a style="background:${color(spec, v.background)};color:${color(spec, v.text)};border:${v.border && v.border !== "none" ? `1px solid ${color(spec, v.border)}` : "none"};border-radius:${button.borderRadius ?? "6px"};padding:${button.padding ?? "10px 24px"};font-weight:${button.fontWeight ?? 600}">${v.variant}</a>`).join("")}</div>
  <div class="cell cell-nav"><nav style="display:flex;gap:4px">${["Home", "Products", "Pricing", "Docs", "About"].map((label, i) => { const active = i === 0; return `<a style="background:${active ? color(spec, nav.activeBackground) : "transparent"};color:${active ? color(spec, nav.active) : color(spec, nav.inactive)};border-radius:${nav.borderRadius ?? "6px"};padding:6px 12px;font-weight:${active ? 600 : 400}">${label}</a>`; }).join("")}</nav></div>
  <div class="cell cell-card"><div class="demo"><div style="font-weight:700;margin-bottom:8px">Sample card</div><div style="color:${color(spec, "text-secondary")};font-size:0.9rem;line-height:1.5">${(spec.theme?.atmosphere ?? "").slice(0, 120)}</div></div></div>
  <div class="cell"><div style="color:${color(spec, "text-primary")}">Heading sample</div><div style="color:${color(spec, "text-secondary")}">Secondary text sample</div><div style="color:${color(spec, "text-on-dark")};background:${color(spec, "background-inverse")};padding:6px 12px;border-radius:6px;margin-top:8px">On-dark text</div></div>
</body>
</html>`;

  const path = join(dir, "reference.html");
  await writeFile(path, html);
  return path;
}

// Capture the top-N dominant colors of a page as a weighted palette, then
// score how well one palette covers the other.
async function scorePalette(browser, refPath, liveUrl, dir) {
  const ref = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  await ref.goto(`file://${refPath.replaceAll("\\", "/")}`, { waitUntil: "load" });
  await ref.waitForTimeout(500);
  await ref.screenshot({ path: join(dir, "ref-full.png") });
  await ref.close();

  const live = await browser.newPage({ viewport: { width: 1000, height: 760 }, colorScheme: "light" });
  await live.goto(liveUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  await live.waitForTimeout(3500);
  await live.screenshot({ path: join(dir, "live-full.png") });
  await live.close();

  const [refBuf, liveBuf] = await Promise.all([
    readFile(join(dir, "ref-full.png")),
    readFile(join(dir, "live-full.png"))
  ]);
  const refPalette = dominantPalette(decodeImage(refBuf), 8);
  const livePalette = dominantPalette(decodeImage(liveBuf), 8);
  const refRgbs = refPalette.colors.map((c) => c.rgb);

  // Coverage: what fraction of the live page's pixels are within a
  // perceptual distance threshold of some reference color.
  const thresh = 48; // ΔRGB per channel
  let covered = 0;
  for (const lc of livePalette.colors) {
    const best = Math.min(...refRgbs.map((rc) => dist3(lc.rgb, rc)));
    if (best <= thresh) covered += lc.weight;
  }
  const coverage = livePalette.colors.length ? covered : 0;

  const paletteDist = distBetween(refPalette.colors, livePalette.colors);
  const overall = 0.7 * coverage + 0.3 * (1 - paletteDist / 255);
  return { overall, coverage, paletteDist, refPalette, livePalette };
}

function dist3(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function distBetween(a, b) {
  // Greedy: for each color in the smaller palette, take the min distance to
  // any color in the other; average those mins.
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  if (!small.length) return 0;
  let sum = 0;
  for (const sc of small) {
    sum += Math.min(...big.map((bc) => dist3(sc.rgb, bc.rgb)));
  }
  return sum / small.length;
}

// Quantize a decoded image into a weighted list of dominant colors.
function dominantPalette(img, n = 8) {
  if (!img) return { colors: [] };
  const { w, h, data } = img;
  const step = 3; // sample every 3rd pixel; plenty for palette stats
  const buckets = new Map();
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = `${r >> 5},${g >> 5},${b >> 5}`; // 8-level quantization
      const e = buckets.get(key);
      if (e) e.count++;
      else buckets.set(key, { count: 1, r, g, b });
    }
  }
  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, n);
  const total = sorted.reduce((s, c) => s + c.count, 0) || 1;
  return {
    colors: sorted.map((c) => ({
      hex: `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
      rgb: { r: c.r, g: c.g, b: c.b },
      weight: c.count / total
    }))
  };
}

function grade(score) {
  if (score >= 0.85) return "GOOD";
  if (score >= 0.6) return "FAIR";
  return "POOR";
}

// Minimal PNG decoder: parse chunks, find IDAT, inflate with zlib.
// Supports 8-bit RGB/RGBA, all filter types, non-interlaced.
function decodeImage(buf) {
  try {
    let off = 8;
    const chunks = [];
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString("ascii", off + 4, off + 8);
      if (type === "IDAT") chunks.push(buf.subarray(off + 8, off + 8 + len));
      if (type === "IEND") break;
      off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(chunks));
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const bitDepth = buf[24];
    const colorType = buf[25];
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return null;
    const bpp = colorType === 6 ? 4 : 3;
    const stride = width * bpp;
    const out = Buffer.alloc(width * height * 4);
    let p = 0;
    const prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[p++];
      const row = raw.subarray(p, p + stride);
      p += stride;
      const cur = Buffer.from(row);
      if (filter === 1) {
        for (let i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
      } else if (filter === 2) {
        for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
      } else if (filter === 3) {
        for (let i = 0; i < stride; i++) cur[i] = (cur[i] + Math.floor(((i >= bpp ? cur[i - bpp] : 0) + prev[i]) / 2)) & 0xff;
      } else if (filter === 4) {
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          const b = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[i] = (cur[i] + pr) & 0xff;
        }
      }
      for (let x = 0; x < width; x++) {
        const si = x * bpp, di = (y * width + x) * 4;
        if (colorType === 6) {
          const a = cur[si + 3];
          const r = (cur[si] * a) / 255, g = (cur[si + 1] * a) / 255, bl = (cur[si + 2] * a) / 255;
          const bg = 255;
          out[di] = Math.round(r + bg * (1 - a / 255));
          out[di + 1] = Math.round(g + bg * (1 - a / 255));
          out[di + 2] = Math.round(bl + bg * (1 - a / 255));
          out[di + 3] = 255;
        } else {
          out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2]; out[di + 3] = 255;
        }
      }
      prev.set(cur);
    }
    return { w: width, h: height, data: out };
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const specPath = argv.find((a) => !a.startsWith("--"));
  const urlIdx = argv.indexOf("--url");
  const outIdx = argv.indexOf("--out");
  if (!specPath) {
    console.error("Usage: node verify.mjs <spec.json> [--url https://site] [--out dir]");
    process.exit(1);
  }
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  const url = (urlIdx >= 0 ? argv[urlIdx + 1] : spec.sourceUrl) || spec.sourceUrl;
  const domain = new URL(url).hostname.replace(/^www\./, "");
  // Default: put verify artifacts next to the spec (output/<domain>/verify-runs/)
  const outDir = resolve(outIdx >= 0 ? argv[outIdx + 1] : join(dirname(specPath), "verify-runs"));
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log(`Verifying spec for ${domain} (${url})`);

  const browser = await chromium.launch();
  try {
    const refPath = await renderReference({ spec, dir: outDir });
    const { overall, coverage, paletteDist, refPalette, livePalette } = await scorePalette(browser, refPath, url, outDir);

    console.log("\nPalette comparison (spec reference vs live site):");
    console.log(`  coverage      ${(coverage * 100).toFixed(1).padStart(5)}%  (share of live-site pixels matched by spec colors)`);
    console.log(`  palette dist  ${paletteDist.toFixed(1).padStart(5)}/255  (avg RGB distance between palettes)`);
    console.log(`\n  OVERALL       ${(overall * 100).toFixed(1)}%  ${grade(overall)}`);
    console.log(`\nReference palette: ${refPalette.colors.map((c) => `${c.hex}(${(c.weight * 100).toFixed(0)}%)`).join(" ")}`);
    console.log(`Live palette:      ${livePalette.colors.map((c) => `${c.hex}(${(c.weight * 100).toFixed(0)}%)`).join(" ")}`);
    console.log(`\nArtifacts in ${outDir}`);

    await writeFile(
      join(outDir, "report.json"),
      JSON.stringify({ url, domain, generatedAt: new Date().toISOString(), overall, coverage, paletteDist, refPalette: refPalette.colors, livePalette: livePalette.colors }, null, 2)
    );
    process.exit(overall >= 0.6 ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("verify failed:", e.message);
  process.exit(1);
});
