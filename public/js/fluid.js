// Swirl: the deterministic fluid simulation, bots included.
//
// Every client runs this same code on the same inputs (server-clocked lockstep), so it
// must produce bit-identical results everywhere. It uses only + − × ÷, Math.floor,
// Math.abs and Math.sqrt on doubles (Float64Array, so there's no float32 rounding to
// argue about). There's no Math.random, trig or exp anywhere, and the bots draw from a
// seeded integer PRNG.
//
// Stable-fluids style: splat forces + dye, vorticity confinement, pressure projection
// (fixed-order Gauss–Seidel), semi-Lagrangian advection. Each player owns one dye. Where
// two dyes meet they cancel each other out, so territory has borders you can push.

export const N = 96;                     // interior cells per side
export const HZ = 25;
export const DT = 1 / HZ;
export const MATCH_TICKS = HZ * 90;      // 90 seconds
export const VORTEX_CD = HZ * 6;
export const MAX_SLOTS = 4;

const W = N + 2;
const SIZE = W * W;
const IX = (i, j) => i + W * j;

const P = Object.freeze({
  ITER: 18,
  FORCE: 0.9,        // pointer motion -> velocity
  VMAX: 70,          // cells/s cap on injected velocity
  RF: 6,             // force splat radius (cells)
  RD: 4.2,           // dye splat radius
  DYE: 0.55,         // dye added per tick at the centre of the brush
  DECAY: 0.9988,     // dye kept per tick
  FIGHT: 1.6,        // how hard rival dyes cancel
  VORT: 9,           // vorticity confinement strength
  DAMP: 0.996,       // velocity kept per tick
  INK_DRAIN: 0.013,
  INK_REGEN: 0.0045,
  VR: 13,            // vortex radius
  VS: 38,            // vortex strength
  OWN: 0.09,         // dye needed to claim a cell (about where the colour becomes clearly visible)
});

// mulberry32: 32-bit integer ops only, identical everywhere
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Fluid {
  constructor(seed, slots) {
    this.u = new Float64Array(SIZE);
    this.v = new Float64Array(SIZE);
    this.u0 = new Float64Array(SIZE);
    this.v0 = new Float64Array(SIZE);
    this.p = new Float64Array(SIZE);
    this.div = new Float64Array(SIZE);
    this.curl = new Float64Array(SIZE);
    this.d = new Float64Array(SIZE * 4);     // dyes interleaved: cell*4 + slot
    this.d0 = new Float64Array(SIZE * 4);
    this.tick = 0;
    this.rand = prng(seed);
    this.nSlots = slots.length;
    this.players = slots.map((s, k) => ({
      k,
      bot: s.bot ? newBot(this.rand, k) : null,
      x: 0, y: 0, px: 0, py: 0, down: false, vortex: false,
      ink: 1, cd: 0, area: 0,
    }));
    // each player starts in a corner with a small pool of their colour
    const corners = [[0.22, 0.22], [0.78, 0.78], [0.78, 0.22], [0.22, 0.78]];
    this.players.forEach((pl, k) => {
      const c = corners[k];
      pl.x = pl.px = Math.floor(c[0] * N * 10);
      pl.y = pl.py = Math.floor(c[1] * N * 10);
      this.splatDye(c[0] * N + 1, c[1] * N + 1, k, 7, 1.4);
    });
  }

  // input from the network for a human slot: x, y in tenths of a cell, flags bit0 = down, bit1 = vortex
  setInput(k, x, y, flags) {
    const pl = this.players[k];
    if (!pl) return;
    pl.x = Math.max(0, Math.min(N * 10, x | 0));
    pl.y = Math.max(0, Math.min(N * 10, y | 0));
    pl.down = (flags & 1) === 1;
    if (flags & 2) pl.vortex = true;
  }

  makeBot(k) {
    const pl = this.players[k];
    if (pl && !pl.bot) pl.bot = newBot(this.rand, k);
  }

  // ---------- one tick ----------
  step() {
    this.tick++;
    const { u, v } = this;
    if (this.tick % 25 === 1) this.blocks = this.blockSums();
    for (const pl of this.players) {
      if (pl.bot) botThink(this, pl);
      this.applyPlayer(pl);
    }
    this.vorticity();
    this.project();
    this.u0.set(u);
    this.v0.set(v);
    this.advectVel();
    this.setBnd(1, u);
    this.setBnd(2, v);
    this.advectDye();
    this.react();
    if (this.tick % 5 === 0) this.score();
  }

  applyPlayer(pl) {
    const cx = pl.x / 10 + 0.5, cy = pl.y / 10 + 0.5;    // grid coords incl. the boundary ring
    if (pl.down) {
      let fx = ((pl.x - pl.px) / 10) * HZ * P.FORCE, fy = ((pl.y - pl.py) / 10) * HZ * P.FORCE;
      const m = Math.sqrt(fx * fx + fy * fy);
      if (m > P.VMAX) { fx *= P.VMAX / m; fy *= P.VMAX / m; }
      if (m > 0.01) this.splatVel(cx, cy, fx, fy, P.RF);
      if (pl.ink > 0.002) {
        const amt = pl.ink < P.INK_DRAIN ? pl.ink / P.INK_DRAIN : 1;
        this.splatDye(cx, cy, pl.k, P.RD, P.DYE * amt);
        pl.ink -= P.INK_DRAIN;
        if (pl.ink < 0) pl.ink = 0;
      }
    }
    pl.ink += P.INK_REGEN;
    if (pl.ink > 1) pl.ink = 1;
    if (pl.cd > 0) pl.cd--;
    if (pl.vortex) {
      pl.vortex = false;
      if (pl.cd === 0) {
        this.splatVortex(cx, cy, P.VR, pl.k % 2 ? -P.VS : P.VS);
        pl.cd = VORTEX_CD;
        pl.vortexAt = this.tick;
      }
    }
    pl.px = pl.x;
    pl.py = pl.y;
  }

  splatVel(cx, cy, fx, fy, R) {
    const R2 = R * R;
    const i0 = Math.max(1, Math.floor(cx - R)), i1 = Math.min(N, Math.floor(cx + R) + 1);
    const j0 = Math.max(1, Math.floor(cy - R)), j1 = Math.min(N, Math.floor(cy + R) + 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i - cx, dy = j - cy, r2 = dx * dx + dy * dy;
        if (r2 >= R2) continue;
        const w = 1 - r2 / R2;
        const k = w * w;
        this.u[IX(i, j)] += fx * k;
        this.v[IX(i, j)] += fy * k;
      }
    }
  }

  splatDye(cx, cy, slot, R, amt) {
    const R2 = R * R;
    const i0 = Math.max(1, Math.floor(cx - R)), i1 = Math.min(N, Math.floor(cx + R) + 1);
    const j0 = Math.max(1, Math.floor(cy - R)), j1 = Math.min(N, Math.floor(cy + R) + 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i - cx, dy = j - cy, r2 = dx * dx + dy * dy;
        if (r2 >= R2) continue;
        const w = 1 - r2 / R2;
        const c = IX(i, j) * 4 + slot;
        this.d[c] += amt * w * w;
        if (this.d[c] > 3) this.d[c] = 3;
      }
    }
  }

  splatVortex(cx, cy, R, S) {
    const R2 = R * R;
    const i0 = Math.max(1, Math.floor(cx - R)), i1 = Math.min(N, Math.floor(cx + R) + 1);
    const j0 = Math.max(1, Math.floor(cy - R)), j1 = Math.min(N, Math.floor(cy + R) + 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i - cx, dy = j - cy, r2 = dx * dx + dy * dy;
        if (r2 >= R2) continue;
        const w = 1 - r2 / R2;
        const k = (w * w * S) / R;
        this.u[IX(i, j)] += -dy * k;
        this.v[IX(i, j)] += dx * k;
      }
    }
  }

  setBnd(b, x) {
    for (let i = 1; i <= N; i++) {
      x[IX(0, i)] = b === 1 ? -x[IX(1, i)] : x[IX(1, i)];
      x[IX(N + 1, i)] = b === 1 ? -x[IX(N, i)] : x[IX(N, i)];
      x[IX(i, 0)] = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
      x[IX(i, N + 1)] = b === 2 ? -x[IX(i, N)] : x[IX(i, N)];
    }
    x[IX(0, 0)] = 0.5 * (x[IX(1, 0)] + x[IX(0, 1)]);
    x[IX(0, N + 1)] = 0.5 * (x[IX(1, N + 1)] + x[IX(0, N)]);
    x[IX(N + 1, 0)] = 0.5 * (x[IX(N, 0)] + x[IX(N + 1, 1)]);
    x[IX(N + 1, N + 1)] = 0.5 * (x[IX(N, N + 1)] + x[IX(N + 1, N)]);
  }

  vorticity() {
    const { u, v, curl } = this;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        curl[IX(i, j)] = 0.5 * (v[IX(i + 1, j)] - v[IX(i - 1, j)] - (u[IX(i, j + 1)] - u[IX(i, j - 1)]));
      }
    }
    const e = P.VORT * DT;
    for (let j = 2; j < N; j++) {
      for (let i = 2; i < N; i++) {
        let gx = Math.abs(curl[IX(i + 1, j)]) - Math.abs(curl[IX(i - 1, j)]);
        let gy = Math.abs(curl[IX(i, j + 1)]) - Math.abs(curl[IX(i, j - 1)]);
        const l = Math.abs(gx) + Math.abs(gy) + 1e-5;   // L1 norm: no sqrt needed
        gx /= l;
        gy /= l;
        const c = curl[IX(i, j)];
        u[IX(i, j)] += e * gy * c;
        v[IX(i, j)] -= e * gx * c;
      }
    }
  }

  project() {
    const { u, v, p, div } = this;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        div[IX(i, j)] = -0.5 * (u[IX(i + 1, j)] - u[IX(i - 1, j)] + v[IX(i, j + 1)] - v[IX(i, j - 1)]);
        p[IX(i, j)] *= 0.6;   // warm start from last tick
      }
    }
    this.setBnd(0, div);
    this.setBnd(0, p);
    for (let k = 0; k < P.ITER; k++) {
      for (let j = 1; j <= N; j++) {
        for (let i = 1; i <= N; i++) {
          p[IX(i, j)] = (div[IX(i, j)] + p[IX(i - 1, j)] + p[IX(i + 1, j)] + p[IX(i, j - 1)] + p[IX(i, j + 1)]) * 0.25;
        }
      }
      this.setBnd(0, p);
    }
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        u[IX(i, j)] -= 0.5 * (p[IX(i + 1, j)] - p[IX(i - 1, j)]);
        v[IX(i, j)] -= 0.5 * (p[IX(i, j + 1)] - p[IX(i, j - 1)]);
      }
    }
    this.setBnd(1, u);
    this.setBnd(2, v);
  }

  advectVel() {
    const { u, v, u0, v0 } = this;
    const lo = 0.5, hi = N + 0.5;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const c = IX(i, j);
        let x = i - DT * u0[c], y = j - DT * v0[c];
        if (x < lo) x = lo; else if (x > hi) x = hi;
        if (y < lo) y = lo; else if (y > hi) y = hi;
        const i0 = Math.floor(x), j0 = Math.floor(y);
        const s1 = x - i0, s0 = 1 - s1, t1 = y - j0, t0 = 1 - t1;
        const a = IX(i0, j0), b = a + 1, cc = a + W, dd = a + W + 1;
        u[c] = (s0 * (t0 * u0[a] + t1 * u0[cc]) + s1 * (t0 * u0[b] + t1 * u0[dd])) * P.DAMP;
        v[c] = (s0 * (t0 * v0[a] + t1 * v0[cc]) + s1 * (t0 * v0[b] + t1 * v0[dd])) * P.DAMP;
      }
    }
  }

  advectDye() {
    const { u, v, d, d0 } = this;
    d0.set(d);
    const lo = 0.5, hi = N + 0.5;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const c = IX(i, j);
        let x = i - DT * u[c], y = j - DT * v[c];
        if (x < lo) x = lo; else if (x > hi) x = hi;
        if (y < lo) y = lo; else if (y > hi) y = hi;
        const i0 = Math.floor(x), j0 = Math.floor(y);
        const s1 = x - i0, s0 = 1 - s1, t1 = y - j0, t0 = 1 - t1;
        const a = IX(i0, j0) * 4, b = a + 4, cc = a + W * 4, dd = cc + 4;
        const w0 = s0 * t0, w1 = s1 * t0, w2 = s0 * t1, w3 = s1 * t1;
        const o = c * 4;
        for (let k = 0; k < 4; k++) d[o + k] = w0 * d0[a + k] + w1 * d0[b + k] + w2 * d0[cc + k] + w3 * d0[dd + k];
      }
    }
  }

  // rival dyes cancel each other, everything slowly fades
  react() {
    const d = this.d, f = P.FIGHT * DT, dec = P.DECAY;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const o = IX(i, j) * 4;
        const a = d[o], b = d[o + 1], c = d[o + 2], e = d[o + 3];
        const tot = a + b + c + e;
        let na = a - f * a * (tot - a), nb = b - f * b * (tot - b), nc = c - f * c * (tot - c), ne = e - f * e * (tot - e);
        d[o] = (na > 0 ? na : 0) * dec;
        d[o + 1] = (nb > 0 ? nb : 0) * dec;
        d[o + 2] = (nc > 0 ? nc : 0) * dec;
        d[o + 3] = (ne > 0 ? ne : 0) * dec;
      }
    }
  }

  // who owns how much of the tank (fractions)
  score() {
    const cnt = [0, 0, 0, 0];
    const d = this.d;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const o = IX(i, j) * 4;
        let best = -1, bv = P.OWN;
        for (let k = 0; k < 4; k++) if (d[o + k] > bv) { bv = d[o + k]; best = k; }
        if (best >= 0) cnt[best]++;
      }
    }
    for (const pl of this.players) pl.area = cnt[pl.k] / (N * N);
  }

  // 8×8 coarse view of the tank for the bots: per block, how much of each dye
  blockSums() {
    const B = 8, cell = N / B, out = new Float64Array(B * B * 4);
    for (let j = 1; j <= N; j++) {
      const bj = Math.floor((j - 1) / cell);
      for (let i = 1; i <= N; i++) {
        const bi = Math.floor((i - 1) / cell);
        const o = IX(i, j) * 4, q = (bj * B + bi) * 4;
        out[q] += this.d[o];
        out[q + 1] += this.d[o + 1];
        out[q + 2] += this.d[o + 2];
        out[q + 3] += this.d[o + 3];
      }
    }
    return out;
  }

  // a cheap fingerprint for desync checks
  hash() {
    let h = 0;
    for (let c = 0; c < this.d.length; c += 37) h = (Math.imul(h, 31) + Math.floor(this.d[c] * 1e6)) | 0;
    return h >>> 0;
  }
}

// ---------- bots: they live inside the deterministic sim ----------
function newBot(rand, k) {
  return {
    style: rand() < 0.5 ? "raid" : "spread",
    tx: 0, ty: 0, next: 0, wob: Math.floor(rand() * 40),
    speed: 26 + Math.floor(rand() * 14),   // cells per second
    resting: false,
  };
}

function botThink(F, pl) {
  const b = pl.bot, B = 8, cell = N / B;
  if (F.tick >= b.next || !F.blocks) {
    const sums = F.blocks || F.blockSums();
    let best = -1, bs = -1e9;
    const myBi = Math.floor(pl.x / 10 / cell), myBj = Math.floor(pl.y / 10 / cell);
    for (let q = 0; q < B * B; q++) {
      const bi = q % B, bj = (q - bi) / B;
      const own = sums[q * 4 + pl.k];
      let enemy = 0;
      for (let k = 0; k < 4; k++) if (k !== pl.k) enemy += sums[q * 4 + k];
      const empty = cell * cell * 0.6 - (own + enemy);
      const dist = Math.abs(bi - myBi) + Math.abs(bj - myBj);
      let s = b.style === "raid" ? enemy * 1.3 + empty * 0.6 - own * 0.9 : empty * 1.2 + enemy * 0.5 - own * 1.1;
      s -= dist * 6;
      s += F.rand() * 25;
      if (s > bs) { bs = s; best = q; }
    }
    const bi = best % B, bj = (best - bi) / B;
    b.tx = Math.floor((bi + 0.2 + F.rand() * 0.6) * cell * 10);
    b.ty = Math.floor((bj + 0.2 + F.rand() * 0.6) * cell * 10);
    b.next = F.tick + 30 + Math.floor(F.rand() * 40);
    b.wantVortex = pl.cd === 0 && F.rand() < 0.35;
  }
  // glide toward the target with a lazy wobble (triangle wave, no trig)
  let dx = b.tx - pl.x, dy = b.ty - pl.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const stepLen = (b.speed * 10) / HZ;
  const ph = ((F.tick + b.wob) % 40) / 40;
  const tri = ph < 0.5 ? ph * 4 - 1 : 3 - ph * 4;
  let nx = pl.x, ny = pl.y;
  if (dist > stepLen) {
    const ux = dx / dist, uy = dy / dist;
    nx = pl.x + ux * stepLen - uy * tri * stepLen * 0.8;
    ny = pl.y + uy * stepLen + ux * tri * stepLen * 0.8;
  } else if (b.wantVortex && pl.cd === 0) {
    pl.vortex = true;
    b.wantVortex = false;
  }
  pl.x = Math.max(0, Math.min(N * 10, Math.floor(nx)));
  pl.y = Math.max(0, Math.min(N * 10, Math.floor(ny)));
  if (b.resting) { if (pl.ink > 0.6) b.resting = false; }
  else if (pl.ink < 0.08) b.resting = true;
  pl.down = !b.resting;
}
