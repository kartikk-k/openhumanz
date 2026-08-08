/* eslint-disable no-console */
/**
 * Generate every app-icon asset from a single square source image.
 *
 * The source artwork is a hard-cornered square. macOS (and modern Windows /
 * Linux launchers) expect the icon to sit inside a rounded "squircle" with a
 * little breathing room around the artwork, so this script:
 *
 *   1. Trims the source to a square and insets it into the standard macOS
 *      icon safe-area (artwork fills ~80% of the canvas, matching Apple's grid).
 *   2. Masks it with a superellipse (the iOS/macOS "squircle") so the corners
 *      are rounded automatically — no hand-editing of the source needed.
 *   3. Emits assets/icon.png (1024), the full .iconset -> assets/icon.icns,
 *      and assets/icon.ico.
 *
 * Run with:  bun run generate:icons
 *
 * Re-run any time assets/icon-source.png changes.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const SOURCE = path.join(ASSETS, 'icon-source.png');

// Master render size. Everything is downscaled from this for crisp edges.
const MASTER = 1024;

// Fraction of the canvas the artwork occupies. macOS icons leave a margin;
// ~0.82 keeps the face well inside the squircle without looking shrunken.
const CONTENT_SCALE = 0.82;

// Superellipse exponent. Apple's continuous-corner squircle is ~5; higher =
// squarer, lower = rounder. 5 matches the macOS Big Sur+ app-icon silhouette.
const SQUIRCLE_N = 5;

/**
 * SVG path for a centred superellipse |x|^n + |y|^n = 1, sampled as a polygon.
 * Used as an alpha mask so the corners round off smoothly.
 */
function squircleMaskSvg(size) {
  const r = size / 2;
  const steps = 720;
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * 2 * Math.PI;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = Math.sign(c) * Math.abs(c) ** (2 / SQUIRCLE_N) * r;
    const y = Math.sign(s) * Math.abs(s) ** (2 / SQUIRCLE_N) * r;
    pts.push(`${(r + x).toFixed(3)},${(r + y).toFixed(3)}`);
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<polygon points="${pts.join(' ')}" fill="#fff"/></svg>`,
  );
}

/** Render the masked, inset master icon at MASTER x MASTER. */
async function renderMaster() {
  const contentSize = Math.round(MASTER * CONTENT_SCALE);
  const pad = Math.round((MASTER - contentSize) / 2);

  // Resize the source artwork (cover-crop to square) to the content size.
  const artwork = await sharp(SOURCE)
    .resize(contentSize, contentSize, { fit: 'cover', position: 'centre' })
    .toBuffer();

  // Composite onto a transparent MASTER canvas, then apply the squircle mask.
  const inset = await sharp({
    create: {
      width: MASTER,
      height: MASTER,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: artwork, top: pad, left: pad }])
    .png()
    .toBuffer();

  const mask = squircleMaskSvg(MASTER);
  return sharp(inset)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function main() {
  console.log('› rendering master icon (squircle mask + safe-area inset)…');
  const master = await renderMaster();

  // 1) assets/icon.png (1024) — BrowserWindow + electron-builder source.
  await sharp(master).png().toFile(path.join(ASSETS, 'icon.png'));
  console.log('  ✔ assets/icon.png');

  // 2) assets/icon.icns via a temporary .iconset + iconutil.
  const iconset = mkdtempSync(path.join(tmpdir(), 'iconset-')) + '.iconset';
  rmSync(iconset, { recursive: true, force: true });
  const { mkdirSync } = await import('fs');
  mkdirSync(iconset, { recursive: true });

  // Apple's required iconset members: base size + @2x retina variant.
  const specs = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  await Promise.all(
    specs.map(([size, name]) =>
      sharp(master)
        .resize(size, size)
        .png()
        .toFile(path.join(iconset, name)),
    ),
  );
  execFileSync('iconutil', [
    '-c',
    'icns',
    iconset,
    '-o',
    path.join(ASSETS, 'icon.icns'),
  ]);
  rmSync(iconset, { recursive: true, force: true });
  console.log('  ✔ assets/icon.icns');

  // 3) assets/icon.ico — a few standard sizes packed into one .ico.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoPngs = await Promise.all(
    icoSizes.map((s) => sharp(master).resize(s, s).png().toBuffer()),
  );
  const ico = await pngToIco(icoPngs);
  writeFileSync(path.join(ASSETS, 'icon.ico'), ico);
  console.log('  ✔ assets/icon.ico');

  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
