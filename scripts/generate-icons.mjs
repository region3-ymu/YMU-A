// Generates the PWA icon set from YMU's real branding (ymu.org/branding).
//
//   node scripts/generate-icons.mjs
//
// Sources live in public/brand/ and are the official files, unmodified:
//   ymu-emblem.png   the square lockup — mark plus "YOUNG MUSICIANS UNITE"
//   ymu-symbol.svg   the Y M U letterforms alone, brand blue
//   ymu-symbol-neutral.svg  the same letterforms in brand cream
//
// TWO ICONS, NOT ONE, and that is the whole point of this script.
//
// `any` is drawn as authored: square, corners intact. The emblem is right for
// it — it is the lockup YMU designed for exactly that frame.
//
// `maskable` is cropped by the launcher to whatever shape the platform likes,
// most often a circle, and only the middle 80% is guaranteed to survive. The
// emblem cannot be used there: the corners of a square lockup are the first
// thing a circle mask cuts, and its "YOUNG MUSICIANS UNITE" line is unreadable
// at 192px anyway. So maskable uses the letterforms alone, cream on brand
// blue, sized to sit inside the safe circle with room to spare.
//
// The manifest previously pointed BOTH purposes at the same file, which is how
// this went unnoticed — Android was cropping the corners off a square logo.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const brand = join(root, "public", "brand");
const out = join(root, "public", "icons");

const BLUE = "#3a65eb";
const CREAM = "#faf6eb";

/**
 * The largest width a 2.63:1 mark can take inside the maskable safe circle.
 *
 * The safe zone is a circle of diameter 0.8 × size. Inscribing a rectangle of
 * aspect r in a circle of diameter d gives w = d / sqrt(1 + 1/r²) — about
 * 0.75 × size here. Backed off to 0.62 so the mark is not visually jammed
 * against the crop on the rounder masks.
 */
const MASKABLE_MARK_RATIO = 0.62;

async function anyIcon(size) {
  // Trimmed first: the source PNG carries ~250px of transparent margin, which
  // would otherwise eat a quarter of the icon before the mark starts.
  const mark = await sharp(join(brand, "ymu-emblem.png"))
    .trim({ threshold: 10 })
    .resize(Math.round(size * 0.82), Math.round(size * 0.82), {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  return sharp({
    create: { width: size, height: size, channels: 4, background: CREAM },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toBuffer();
}

async function maskableIcon(size) {
  const markWidth = Math.round(size * MASKABLE_MARK_RATIO);
  const mark = await sharp(join(brand, "ymu-symbol-neutral.svg"), { density: 600 })
    .resize({ width: markWidth })
    .toBuffer();

  return sharp({
    create: { width: size, height: size, channels: 4, background: BLUE },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toBuffer();
}

mkdirSync(out, { recursive: true });

for (const size of [192, 512]) {
  writeFileSync(join(out, `icon-${size}.png`), await anyIcon(size));
  writeFileSync(join(out, `maskable-${size}.png`), await maskableIcon(size));
  console.log(`  icon-${size}.png + maskable-${size}.png`);
}

// iOS never masks; it rounds the corners itself and shows the rest as given.
writeFileSync(join(out, "apple-touch-icon.png"), await anyIcon(180));
console.log("  apple-touch-icon.png");

// The favicon browsers fall back to. 32px is far too small for the emblem's
// wordmark, so it gets the letterforms, same as maskable.
writeFileSync(join(out, "icon-32.png"), await maskableIcon(32));
console.log("  icon-32.png");

console.log("\nDone.");
