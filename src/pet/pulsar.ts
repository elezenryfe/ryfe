/**
 * Pulsar — a small creature, drawn entirely in code.
 *
 * The body is a superellipse: a rectangle whose corners are rounded so far that
 * it reads as a soft blob, wider than it is tall, lit from the upper left. It is
 * the shape Mochi is built from, and it is why the character looks like it has a
 * surface rather than being a circle with a face stuck on it.
 *
 * The eyes are not stickers. Each sits at a longitude on that surface and is
 * projected back to the screen, so turning to follow the cursor foreshortens the
 * far one and hides it behind the body when it goes too far round — which is
 * what makes a turn read as a turn rather than two dots sliding sideways.
 *
 * Four states, each a whole mood rather than a colour swap:
 *   idle       silver, slow blinks, breathing
 *   working    a blue wash up from the bottom, a moving-dots badge
 *   alert      amber, eyes wide, bouncing, an exclamation badge
 *   listening  cyan, head tilted, eyes on whoever is typing
 */

import { clamp, Ease, lerp, TAU } from '../core/anim';

export type PetState = 'idle' | 'working' | 'alert' | 'listening';

type Rgb = readonly [number, number, number];
type EyeShape = 'pill' | 'wide' | 'happy' | 'closed' | 'flat';
type Badge = 'dots' | 'bang';

interface Spec {
  /** The wash up from the bottom, and the badge's colour. */
  color: Rgb;
  /** How strong that wash is, 0–1. */
  tint: number;
  eye: EyeShape;
  badge: Badge | null;
  /** Hops in place — for the one state that is asking for you. */
  bounces: boolean;
  /** Resting head tilt, in radians. */
  tilt: number;
}

const STATES: Record<PetState, Spec> = {
  idle: { color: [0.902, 0.914, 0.933], tint: 0, eye: 'pill', badge: null, bounces: false, tilt: 0 },
  working: { color: [0.231, 0.62, 1], tint: 0.72, eye: 'pill', badge: 'dots', bounces: false, tilt: 0 },
  alert: { color: [0.961, 0.647, 0.141], tint: 0.78, eye: 'wide', badge: 'bang', bounces: true, tilt: 0 },
  listening: { color: [0.133, 0.827, 0.933], tint: 0.75, eye: 'pill', badge: null, bounces: false, tilt: 0.17 },
};

// Face geometry, as fractions of R. These few numbers are the difference
// between the same character and a similar one.
const EYE_W = 0.25;
const EYE_H = 0.27;
/** Eye spacing: a half-angle on the surface, not a distance in pixels. */
const EYE_SP = 0.37;
/** Resting eye height. Negative sits them below the middle of the face. */
const EYE_P = -0.12;
const BASE_TOP: Rgb = [0.929, 0.929, 0.937];
const BASE_BOTTOM: Rgb = [0.769, 0.773, 0.792];
const INK = '#1A1412';

/** Everything a tween is allowed to drive. Kept public so one name is enough. */
type Prop = 'open' | 'sx' | 'sy' | 'oy' | 'hands' | 'badgeS';

/** One keyframe: reach `to` after `ms`, along `ease`. */
type Key = readonly [to: number, ms: number, ease: (t: number) => number];

interface Tween {
  prop: Prop;
  keys: Key[];
  index: number;
  from: number;
  start: number;
}

const now = () => performance.now() / 1000;

const rgba = (c: Rgb, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

function roundedBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = clamp(r, 0, Math.min(w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class PetEngine {
  private state: PetState = 'idle';
  private spec: Spec = STATES.idle;

  /** The badge on screen, which lags the state by one pop-out/pop-in. */
  private badge: Badge | null = null;
  private badgeToken = 0;

  /** Overrides the state's eyes for a moment — the greeting's happy squint. */
  private eyeOverride: EyeShape | null = null;
  private eyeUntil = 0;

  // Pose. Public because the tweens address them by name.
  open = 1;
  sx = 1;
  sy = 1;
  oy = 0;
  hands = 0;
  badgeS = 0;

  private yaw = 0;
  private pitch = 0;
  private tilt = 0;
  private tint = 0;

  private col: Rgb = STATES.idle.color;
  private colT: Rgb = STATES.idle.color;

  private tgYaw = 0;
  private tgPitch = 0;
  private tgTilt = 0;
  private tgSy = 1;
  private tgSx = 1;

  private tweens = new Map<Prop, Tween>();
  private locks = new Set<Prop>();

  private lookX = 0;
  private lookY = 0;

  /** Ambient clock, started at a random phase so two of these never breathe together. */
  private t0 = now() - Math.random() * 5;
  private nextBlink = now() + 1.5 + Math.random() * 2;

  /** The wave: the arm goes up at `waveStart` and comes down at `waveUntil`. */
  private waveStart = 0;
  private waveUntil = 0;
  private greetToken = 0;

  setState(next: PetState) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.spec = STATES[next];
    this.colT = this.spec.color;
    this.setBadge(this.spec.badge);

    if (next === 'alert') {
      // A hop, so arriving here is visible even if you were looking elsewhere.
      this.anim('oy', [
        [-0.2, 150, Ease.out],
        [0, 300, Ease.back],
      ]);
    } else if (prev !== 'idle' || next !== 'idle') {
      this.blink();
    }
  }

  /** Cursor position relative to the canvas centre, in pixels. */
  look(dx: number, dy: number) {
    // tanh rather than a clamp: the eyes ease to a stop at the edge of their
    // range instead of pinning there.
    this.lookX = Math.tanh(dx / 260);
    this.lookY = -Math.tanh(dy / 200);
  }

  /** Waves hello — used once, when the island first appears. */
  greet() {
    const tok = ++this.greetToken;
    const t = now();
    this.waveStart = t + 0.45;
    this.waveUntil = t + 1.55;

    this.eyeOverride = 'happy';
    this.eyeUntil = t + 2.0;
    this.anim('oy', [
      [-0.06, 220, Ease.out],
      [0, 220, Ease.back],
    ]);

    setTimeout(() => {
      if (this.greetToken !== tok) return;
      this.anim('hands', [[1, 280, Ease.out]]);
      this.anim('sy', [
        [0.95, 100, Ease.out],
        [1, 260, Ease.back],
      ]);
    }, 250);
    setTimeout(() => {
      if (this.greetToken !== tok) return;
      this.waveUntil = 0;
      this.anim('hands', [[0, 200, Ease.inOut]]);
    }, 1550);
  }

  /** Blink now rather than whenever the next one was due. */
  blink() {
    if (this.locks.has('open')) return;
    this.anim('open', [
      [0.06, 70, Ease.inOut],
      [1, 130, Ease.out],
    ]);
  }

  update(dt: number) {
    const t = now();
    const ms = performance.now();

    for (const tw of [...this.tweens.values()]) {
      const k = tw.keys[tw.index];
      const p = clamp((ms - tw.start) / k[1], 0, 1);
      this[tw.prop] = tw.from + (k[0] - tw.from) * k[2](p);
      if (p >= 1) {
        tw.from = k[0];
        tw.index += 1;
        tw.start = ms;
        if (tw.index >= tw.keys.length) {
          this.tweens.delete(tw.prop);
          this.locks.delete(tw.prop);
        }
      }
    }

    const phase = t - this.t0;
    this.tgYaw = this.lookX * 0.62;
    this.tgPitch = this.lookY * 0.5;
    this.tgTilt = this.spec.tilt;

    // A slow sway while the arm is up, so the wave has a body behind it.
    if (t > this.waveStart && t < this.waveUntil) {
      this.tgTilt = -0.06 + Math.sin(TAU * 1.2 * (t - this.waveStart)) * 0.07;
    }

    const bounce = this.spec.bounces ? -Math.abs(Math.sin(phase * 5.2)) * 0.07 : 0;
    const kGen = 1 - Math.pow(0.0008, dt);
    if (!this.locks.has('oy')) this.oy += (bounce - this.oy) * kGen;

    // A slow breath. Small enough to be felt rather than seen.
    const breath = Math.sin(phase * 1.8) * 0.035;
    this.tgSy = 1 + breath;
    this.tgSx = 1 - breath * 0.57;

    const kLook = 1 - Math.pow(0.0025, dt);
    this.tilt += (this.tgTilt - this.tilt) * kGen;
    if (!this.locks.has('sy')) this.sy += (this.tgSy - this.sy) * kGen;
    if (!this.locks.has('sx')) this.sx += (this.tgSx - this.sx) * kGen;
    this.yaw += (this.tgYaw - this.yaw) * kLook;
    this.pitch += (this.tgPitch - this.pitch) * kLook;

    this.col = mix(this.col, this.colT, 1 - Math.pow(0.002, dt));
    this.tint += (this.spec.tint - this.tint) * kGen;

    if (this.eyeOverride && t > this.eyeUntil) this.eyeOverride = null;

    if (t > this.nextBlink) {
      this.blink();
      // Sometimes twice in a row — a real blink is not always single.
      if (Math.random() < 0.22) setTimeout(() => this.blink(), 230);
      this.nextBlink = t + 2.2 + Math.random() * 3.2;
    }
  }

  /** Swaps the badge with a pop: the old one shrinks out, the new one bounces in. */
  private setBadge(kind: Badge | null) {
    if (kind === this.badge) return;
    const tok = ++this.badgeToken;
    this.anim('badgeS', [[0, 90, Ease.inOut]]);
    setTimeout(() => {
      if (tok !== this.badgeToken) return;
      this.badge = kind;
      if (kind) this.anim('badgeS', [[1, 280, Ease.back]]);
    }, 100);
  }

  private anim(prop: Prop, keys: Key[]) {
    this.tweens.set(prop, {
      prop,
      keys,
      index: 0,
      from: this[prop],
      start: performance.now(),
    });
    this.locks.add(prop);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /** Draws into a canvas of `w`×`h` CSS pixels, bitmap already matched to it. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Everything below is a fraction of R, which is a fraction of the canvas, so
    // the character fills whatever box it is given at any size.
    const R = w * 0.3;
    const rx = R * 1.14;
    const ry = R * 0.88;
    const cx = w / 2;
    const cy = h / 2 + this.oy * R + R * 0.06;

    this.drawHands(ctx, R, rx, ry, cx, cy);

    ctx.save();
    ctx.translate(cx, cy);
    if (this.tilt !== 0) ctx.rotate(this.tilt);
    ctx.scale(this.sx, this.sy);

    const body = this.bodyPath(rx, ry);
    this.drawBody(ctx, body, R, rx, ry);
    this.drawBlush(ctx, body, rx, ry, R);
    this.drawEyes(ctx, body, R, rx, ry);
    ctx.restore();

    // Outside the body's transform: a badge is a thing in the world, not paint
    // on the face, so it must not squash when the body does.
    if (this.badge && this.badgeS > 0.01) this.drawBadge(ctx, R, cx, cy, this.badge);
  }

  /** Superellipse: |x|^2.7 + |y|^2.7 = 1, sampled and scaled. */
  private bodyPath(rx: number, ry: number): Path2D {
    const n = 72;
    const e = 2 / 2.7;
    const p = new Path2D();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const x = rx * (ca >= 0 ? Math.pow(ca, e) : -Math.pow(-ca, e));
      const y = ry * (sa >= 0 ? Math.pow(sa, e) : -Math.pow(-sa, e));
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
    p.closePath();
    return p;
  }

  private drawBody(
    ctx: CanvasRenderingContext2D,
    body: Path2D,
    R: number,
    rx: number,
    ry: number,
  ) {
    const g = ctx.createLinearGradient(rx * 0.7, -ry * 0.85, -rx * 0.8, ry * 0.9);
    g.addColorStop(0, rgba(BASE_TOP));
    g.addColorStop(1, rgba(BASE_BOTTOM));
    ctx.fillStyle = g;
    ctx.fill(body);

    // The state's colour soaked up from below, fading out before the top edge.
    if (this.tint > 0.01) {
      const tg = ctx.createLinearGradient(0, ry, 0, -ry);
      tg.addColorStop(0, rgba(this.col, 0.72 * this.tint));
      tg.addColorStop(1, rgba(this.col, 0));
      ctx.fillStyle = tg;
      ctx.fill(body);
    }

    // Shadow at the rim, so the edge is a curve rather than an outline.
    const sh = ctx.createRadialGradient(0, 0, R * 0.15, 0, 0, R * 1.25);
    sh.addColorStop(0, 'rgba(0,0,0,0)');
    sh.addColorStop(0.6, 'rgba(0,0,0,0)');
    sh.addColorStop(1, 'rgba(0,0,0,0.2)');
    ctx.fillStyle = sh;
    ctx.fill(body);

    // The light, upper left. Without it the blob reads as flat paper.
    const hl = ctx.createRadialGradient(rx * 0.34, -ry * 0.46, 0, rx * 0.34, -ry * 0.46, R * 0.42);
    hl.addColorStop(0, 'rgba(255,255,255,0.55)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.fill(body);
  }

  private drawBlush(
    ctx: CanvasRenderingContext2D,
    body: Path2D,
    rx: number,
    ry: number,
    R: number,
  ) {
    const amount = this.tint * 0.5;
    if (amount <= 0.01) return;

    ctx.save();
    ctx.clip(body);
    ctx.fillStyle = `rgba(255,120,150,${0.5 * amount})`;
    // The cheeks ride across the face as the head turns, same as the eyes.
    const slide = Math.sin(this.yaw) * rx * 0.8;
    for (const sd of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(sd * rx * 0.55 + slide, ry * 0.2, R * 0.17, R * 0.1, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawEyes(
    ctx: CanvasRenderingContext2D,
    body: Path2D,
    R: number,
    rx: number,
    ry: number,
  ) {
    const shape = this.eyeOverride ?? this.spec.eye;

    ctx.save();
    ctx.clip(body);
    ctx.fillStyle = INK;
    ctx.strokeStyle = INK;

    for (const sd of [-1, 1]) {
      const eyeYaw = sd * EYE_SP + this.yaw;
      const eyePitch = EYE_P + this.pitch;
      const cp = Math.cos(eyePitch);
      // Gone far enough round that it would be behind the silhouette.
      if (Math.cos(eyeYaw) * cp <= 0.04) continue;

      ctx.save();
      ctx.translate(Math.sin(eyeYaw) * cp * rx, -Math.sin(eyePitch) * ry);
      // Squashed by exactly as much as the surface is. This is the whole trick.
      ctx.scale(Math.max(0.18, Math.cos(eyeYaw)), Math.max(0.18, cp));
      this.drawEyeShape(ctx, shape, R * EYE_W, R * EYE_H, sd);
      ctx.restore();
    }
    ctx.restore();
  }

  private drawEyeShape(
    ctx: CanvasRenderingContext2D,
    shape: EyeShape,
    w: number,
    h: number,
    sd: number,
  ) {
    switch (shape) {
      case 'wide':
        this.drawEyeShape(ctx, 'pill', w * 1.16, h * 1.12, sd);
        break;

      case 'pill': {
        // Never fully shut: a blinking pill keeps a sliver, which reads alive.
        const hh = Math.max(h * this.open, w * 0.3);
        roundedBox(ctx, -w / 2, -hh / 2, w, hh, Math.min(w / 2, hh / 2));
        ctx.fill();
        break;
      }

      case 'flat':
        roundedBox(ctx, -w * 0.72, -w * 0.2, w * 1.44, w * 0.4, w * 0.2);
        ctx.fill();
        break;

      case 'happy':
        ctx.lineWidth = w * 0.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, h * 0.18, w * 0.82, Math.PI * 1.12, Math.PI * 1.88);
        ctx.stroke();
        break;

      case 'closed':
        ctx.lineWidth = w * 0.36;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, -h * 0.08, w * 0.78, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
        break;
    }
  }

  /**
   * The arms, behind the body. Drawn before it so they peek out from under the
   * bottom edge rather than sitting on the face.
   */
  private drawHands(
    ctx: CanvasRenderingContext2D,
    R: number,
    rx: number,
    ry: number,
    cx: number,
    cy: number,
  ) {
    if (this.hands <= 0.01) return;
    // Below this an arm is a smudge; the compact island never shows one.
    if (R <= 14) return;

    const t = now();
    const hew = 0.3 * ry * this.hands;
    const heh = 0.26 * ry * this.hands;
    const hwB = rx * this.sx;
    const hhB = ry * this.sy;
    const waving = this.waveStart > 0 && t >= this.waveStart && t < this.waveUntil;

    for (const sd of [-1, 1]) {
      let localX = sd * hwB * 1.08;
      let localY = hhB * 0.7;
      let rot = 0;

      if (waving && sd > 0) {
        // The right arm comes up over 180 ms, then waves.
        const wt = t - this.waveStart;
        const rise = Ease.out(Math.min(1, wt / 0.18));
        const waveX = hwB * 1.1 + Math.cos(13 * wt) * 0.12 * ry;
        const waveY = -hhB * 0.15 - Math.sin(13 * wt) * 0.28 * ry;
        localX = lerp(hwB * 1.08, waveX, rise);
        localY = lerp(hhB * 0.7, waveY, rise);
        rot = (-0.5 + Math.sin(13 * wt) * 0.35) * rise;
      } else if (waving) {
        localY += Math.sin(6 * (t - this.waveStart)) * 0.08 * ry;
      }

      // Through the body's tilt, so an arm belongs to a body that is leaning.
      const cosT = Math.cos(this.tilt);
      const sinT = Math.sin(this.tilt);

      ctx.save();
      ctx.translate(cx + cosT * localX - sinT * localY, cy + sinT * localX + cosT * localY);
      if (rot !== 0) ctx.rotate(rot);
      const g = ctx.createLinearGradient(hew * 0.7, -heh * 0.85, -hew * 0.8, heh * 0.9);
      g.addColorStop(0, rgba(BASE_TOP));
      g.addColorStop(1, rgba(BASE_BOTTOM));
      ctx.beginPath();
      ctx.ellipse(0, 0, hew, heh, 0, 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Top-left of the body: a ring with the state's colour inside it. */
  private drawBadge(
    ctx: CanvasRenderingContext2D,
    R: number,
    cx: number,
    cy: number,
    kind: Badge,
  ) {
    const t = now();
    ctx.save();
    ctx.translate(cx - R * 0.72 * this.sx, cy - R * 0.72 * this.sy);
    ctx.scale(this.badgeS, this.badgeS);
    const col = rgba(this.spec.color);

    if (kind === 'dots') {
      roundedBox(ctx, -R * 0.36, -R * 0.18, R * 0.72, R * 0.36, R * 0.18);
      ctx.fillStyle = col;
      ctx.fill();
      for (let i = 0; i < 3; i++) {
        const phase = (((t * 2.4 - i * 0.22) % 1) + 1) % 1;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(
          (i - 1) * R * 0.18,
          0,
          R * 0.055 * (1 + 0.4 * Math.max(0, Math.sin(phase * TAU))),
          0,
          TAU,
        );
        ctx.fill();
      }
    } else {
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.23, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `900 ${R * 0.32}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', 0, R * 0.02);
    }
    ctx.restore();
  }
}
