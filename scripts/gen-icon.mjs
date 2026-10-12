/**
 * Draws Ryfe's app icon and writes it as a PNG.
 *
 * The icon is generated rather than designed in a drawing tool, for the same
 * reason the character is: it stays in sync with the app, it diffs, and there is
 * no binary asset in the repo that nobody can edit.
 *
 * Run `npm run icon` — it writes assets/icon-source.png, then hands it to
 * `tauri icon`, which produces every size and the .ico.
 *
 * No image libraries: a PNG is a signature, three chunks and a CRC.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;
/** Samples per pixel per axis. 3x3 is enough to hide the edges at any real size. */
const SS = 3;

// ---------------------------------------------------------------------------
// The drawing
// ---------------------------------------------------------------------------

/** The sweep angle of the beams in the icon, in radians. */
const SWEEP = 0.62;

/**
 * Shades one point, in normalised coordinates where the icon spans [-1, 1].
 * Returns [r, g, b, a] with channels 0-255 and alpha 0-1.
 */
function shade(x, y) {
  // --- rounded square background -------------------------------------------
  const R = 0.42;
  const qx = Math.abs(x) - (1 - R);
  const qy = Math.abs(y) - (1 - R);
  const outside =
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R;
  if (outside > 0) return [0, 0, 0, 0];

  // A subtle vertical wash so the square is not flat.
  const v = (y + 1) / 2;
  let r = 25 + (1 - v) * 10;
  let g = 18 + (1 - v) * 8;
  let b = 38 + (1 - v) * 14;

  const over = (cr, cg, cb, a) => {
    r = cr * a + r * (1 - a);
    g = cg * a + g * (1 - a);
    b = cb * a + b * (1 - a);
  };

  // --- bloom ---------------------------------------------------------------
  const d = Math.hypot(x, y);
  if (d < 1.35) {
    const t = d / 1.35;
    over(96, 165, 250, 0.30 * Math.pow(1 - t, 2.2));
  }

  // --- beams ---------------------------------------------------------------
  for (const dir of [0, Math.PI]) {
    const a = SWEEP + dir;
    const ax = Math.cos(a);
    const ay = Math.sin(a);
    const along = x * ax + y * ay;
    if (along <= 0) continue;
    const across = Math.abs(-x * ay + y * ax);
    // Narrow at the core and opening out, so it reads as a beam of light rather
    // than a wedge.
    const half = 0.045 + along * 0.30;
    if (across >= half) continue;
    const fade = 1 - Math.min(1, along / 1.5);
    const edge = 1 - Math.pow(across / half, 2);
    over(190, 232, 255, 0.6 * fade * edge);
  }

  // --- equatorial ring -----------------------------------------------------
  // Distance to a thin tilted ellipse, normalised so 1 is exactly on it.
  const TILT = -0.25;
  const ct = Math.cos(TILT);
  const st = Math.sin(TILT);
  const rxg = x * ct - y * st;
  const ryg = x * st + y * ct;
  const ring = Math.abs(Math.hypot(rxg / 0.70, ryg / 0.19) - 1);
  if (ring < 0.12) over(198, 234, 255, 0.34 * (1 - ring / 0.12));

  // --- core ----------------------------------------------------------------
  const CORE = 0.285;
  if (d < CORE) {
    const t = d / CORE;
    // White at the centre, easing to a deeper blue at the rim.
    over(255 - t * 118, 255 - t * 76, 255 - t * 6, 1);
    // Specular highlight, up and to the left.
    const hd = Math.hypot(x + 0.08, y + 0.10) / 0.115;
    if (hd < 1) over(255, 255, 255, 0.8 * (1 - hd));
  }

  // --- eyes ----------------------------------------------------------------
  // Round, like the ones the character actually has — an oval here reads as
  // sunglasses at small sizes.
  const eyeR = 0.042;
  for (const s of [-1, 1]) {
    const px = (x - s * 0.098) / (eyeR * 0.88);
    const py = (y - 0.012) / (eyeR * 1.05);
    const e = Math.hypot(px, py);
    if (e < 1) {
      // Soft edge, so the eyes do not alias at 16px.
      over(10, 37, 64, Math.min(1, (1 - e) * 4));
    }
  }

  return [r, g, b, 1];
}

// ---------------------------------------------------------------------------
// Raster
// ---------------------------------------------------------------------------

function renderRGBA(size) {
  const px = Buffer.alloc(size * size * 4);
  const step = 2 / (size * SS);

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Sample at pixel centres across the sub-grid.
          const x =
            -1 + (pxi * SS + sx + 0.5) * step;
          const y =
            -1 + (py * SS + sy + 0.5) * step;
          const [sr, sg, sb, sa] = shade(x, y);
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }

      const n = SS * SS;
      const alpha = a / n;
      const o = (py * size + pxi) * 4;
      // Un-premultiply so the transparent corners keep the square's colour
      // rather than fading to black.
      px[o] = alpha > 0 ? Math.round(r / a) : 0;
      px[o + 1] = alpha > 0 ? Math.round(g / a) : 0;
      px[o + 2] = alpha > 0 ? Math.round(b / a) : 0;
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// PNG container
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter byte; 0 means "none", which
  // compresses fine for a smooth illustration like this.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

const outDir = resolve(here, '..', 'assets');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, 'icon-source.png');
writeFileSync(outFile, encodePNG(SIZE, SIZE, renderRGBA(SIZE)));
console.log(`wrote ${outFile} (${SIZE}x${SIZE})`);
