/** Easing curves, and the two ways the island is allowed to move. */

export const Ease = {
  linear: (t: number) => t,
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  inOut: (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  /** Overshoots slightly, then settles. Good for something arriving. */
  back: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const TAU = Math.PI * 2;

/** cubic-bezier(x1,y1,x2,y2) — the curve the island closes on. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = (t: number) =>
    (1 - t) ** 2 * 3 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3;
  const cy = (t: number) =>
    (1 - t) ** 2 * 3 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3;
  return (x: number) => {
    // Bisection on x. Twelve steps is far below one frame at 60 Hz.
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 12; i++) {
      if (cx(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return cy(t);
  };
}

export const closeCurve = cubicBezier(0.45, 0, 0.2, 1);

/**
 * A damped spring, integrated per frame so a dropped frame cannot destabilise
 * it. `response` is the time to get most of the way there; `damping` below 1
 * overshoots.
 */
class Spring {
  value: number;
  target: number;
  velocity = 0;
  private omega: number;
  private zeta: number;

  constructor(value: number, response = 0.5, damping = 0.72) {
    this.value = value;
    this.target = value;
    this.omega = TAU / response;
    this.zeta = damping;
  }

  configure(response: number, damping: number) {
    this.omega = TAU / response;
    this.zeta = damping;
  }

  set(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  get settled() {
    return Math.abs(this.target - this.value) < 0.01 && Math.abs(this.velocity) < 0.05;
  }

  step(dt: number) {
    // Sub-stepped, so a long frame is integrated rather than skipped.
    const steps = Math.max(1, Math.ceil(dt * 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const acc =
        this.omega * this.omega * (this.target - this.value) -
        2 * this.zeta * this.omega * this.velocity;
      this.velocity += acc * h;
      this.value += this.velocity * h;
    }
  }
}

/**
 * A value that grows on a spring and shrinks on a timed curve.
 *
 * That asymmetry is the difference between the island feeling like it opens and
 * like it is being put away: overshoot on the way out reads as enthusiasm,
 * overshoot on the way in reads as a bounce off the table.
 */
export class Tracked {
  private spring: Spring;
  private mode: 'idle' | 'spring' | 'curve' = 'idle';
  private from = 0;
  private to = 0;
  private start = 0;
  private duration = 0;

  constructor(value: number) {
    this.spring = new Spring(value);
  }

  get value() {
    return this.spring.value;
  }

  get animating() {
    return this.mode !== 'idle';
  }

  jump(v: number) {
    this.spring.set(v);
    this.mode = 'idle';
  }

  springTo(v: number, response = 0.5, damping = 0.72) {
    this.spring.configure(response, damping);
    this.spring.target = v;
    this.mode = 'spring';
  }

  curveTo(v: number, duration = 340, at = performance.now()) {
    this.from = this.spring.value;
    this.to = v;
    this.start = at;
    this.duration = duration;
    this.spring.target = v;
    this.spring.velocity = 0;
    this.mode = 'curve';
  }

  step(dt: number, at = performance.now()) {
    if (this.mode === 'spring') {
      this.spring.step(dt);
      if (this.spring.settled) {
        this.spring.value = this.spring.target;
        this.spring.velocity = 0;
        this.mode = 'idle';
      }
    } else if (this.mode === 'curve') {
      const p = clamp((at - this.start) / this.duration, 0, 1);
      this.spring.value = lerp(this.from, this.to, closeCurve(p));
      if (p >= 1) {
        this.spring.velocity = 0;
        this.mode = 'idle';
      }
    }
  }
}
