// Swirl: tank renderer. Takes the 96×96 deterministic sim to screen resolution with
// bicubic filtering, flow-advected marbling noise (two-phase flow map), sub-tick motion
// extrapolation, glossy highlights from the ink height field and dark seams where
// rival inks eat each other. Falls back to plain 2D if WebGL2 isn't there.
import { N } from "./fluid.js";

const VS = `#version 300 es
in vec2 p;
out vec2 vUv;
void main() { vUv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uDye;
uniform sampler2D uVel;
uniform sampler2D uNoise;
uniform vec3 uCol[4];
uniform float uT;
uniform float uA;
uniform float uDim;
out vec4 o;

vec4 cubic(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x, y = s.y - 4.0 * s.x, z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4(x, y, z, 6.0 - x - y - z) * (1.0 / 6.0);
}
vec4 bicubic(sampler2D t, vec2 uv) {
  vec2 ts = vec2(textureSize(t, 0)), inv = 1.0 / ts;
  uv = uv * ts - 0.5;
  vec2 f = fract(uv);
  uv -= f;
  vec4 xc = cubic(f.x), yc = cubic(f.y);
  vec4 c = uv.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = (c + vec4(xc.yw, yc.yw) / s) * inv.xxyy;
  vec4 s0 = texture(t, off.xz), s1 = texture(t, off.yz), s2 = texture(t, off.xw), s3 = texture(t, off.yw);
  float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}

void main() {
  vec2 vel = texture(uVel, vUv).xy / ${N}.0;            // tank widths per second
  vec2 uv = vUv - vel * uA * 0.04;                       // glide between ticks
  vec4 d = max(bicubic(uDye, uv), 0.0);

  // marbling: noise carried along by the flow, two staggered phases cross-faded
  float ph0 = fract(uT * 0.3), ph1 = fract(uT * 0.3 + 0.5);
  float w = abs(ph0 * 2.0 - 1.0);
  float n0 = texture(uNoise, uv * 2.6 - vel * ph0 * 3.0).r;
  float n1 = texture(uNoise, uv * 2.6 + 0.43 - vel * ph1 * 3.0).r;
  float det = mix(n0, n1, w);
  float fine = texture(uNoise, uv * 9.0 - vel * ph0 * 1.5).r;
  d *= 0.72 + 0.5 * det + 0.12 * fine;

  float tot = d.x + d.y + d.z + d.w;
  vec3 ink = (uCol[0] * d.x + uCol[1] * d.y + uCol[2] * d.z + uCol[3] * d.w) / max(tot, 1e-4);
  float a = tot / (tot + 0.2);
  float m1 = max(max(d.x, d.y), max(d.z, d.w));
  float seam = smoothstep(0.03, 0.22, min(m1, tot - m1));

  vec3 base = vec3(0.03, 0.04, 0.085) + vec3(0.02, 0.03, 0.06) * det;
  vec3 col = mix(base, ink * (0.78 + 0.32 * det), a);
  col *= 1.0 - seam * 0.6;

  // gloss from the ink "height"
  float e = 1.0 / ${N}.0;
  float hx = dot(texture(uDye, uv + vec2(e, 0.0)) - texture(uDye, uv - vec2(e, 0.0)), vec4(1.0));
  float hy = dot(texture(uDye, uv + vec2(0.0, e)) - texture(uDye, uv - vec2(0.0, e)), vec4(1.0));
  vec3 nrm = normalize(vec3(-hx * 1.6, -hy * 1.6, 1.0));
  vec3 L = normalize(vec3(-0.45, -0.55, 0.9));
  float spec = pow(max(dot(reflect(-L, nrm), vec3(0.0, 0.0, 1.0)), 0.0), 40.0);
  col += vec3(1.0, 0.97, 0.92) * spec * 0.5 * a;
  col += vec3(0.35, 0.5, 1.0) * 0.05 * (1.0 - a) * det;

  // glass: inner shadow toward the walls + a soft top-left reflection
  vec2 q = abs(vUv - 0.5) * 2.0;
  float edge = max(q.x, q.y);
  col *= 1.0 - 0.38 * smoothstep(0.82, 1.0, edge);
  col += vec3(0.6, 0.7, 1.0) * 0.05 * smoothstep(0.5, 0.0, length(vUv - vec2(0.18, 0.12)));
  col *= uDim;
  o = vec4(col, 1.0);
}`;

export class Tank {
  constructor(canvas) {
    this.c = canvas;
    this.ok = false;
    this.dyeBuf = new Float32Array(N * N * 4);
    this.velBuf = new Float32Array(N * N * 2);
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false });
    if (gl) this.initGL(gl);
    if (!this.ok) {
      this.ctx2d = canvas.getContext("2d");
      this.small = document.createElement("canvas");
      this.small.width = this.small.height = N;
      this.sctx = this.small.getContext("2d");
      this.img = this.sctx.createImageData(N, N);
    }
  }

  initGL(gl) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, FS);
    if (!v || !f) return;
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(p)); return; }
    this.gl = gl;
    this.prog = p;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const loc = gl.getAttribLocation(p, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = (unit, internal, format, w, h, data, wrap) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, data instanceof Uint8Array ? gl.UNSIGNED_BYTE : gl.FLOAT, data);
      return t;
    };
    this.tDye = tex(0, gl.RGBA16F, gl.RGBA, N, N, this.dyeBuf, gl.CLAMP_TO_EDGE);
    this.tVel = tex(1, gl.RG16F, gl.RG, N, N, this.velBuf, gl.CLAMP_TO_EDGE);
    this.tNoise = tex(2, gl.R8, gl.RED, 128, 128, makeNoise(128), gl.REPEAT);
    gl.useProgram(p);
    gl.uniform1i(gl.getUniformLocation(p, "uDye"), 0);
    gl.uniform1i(gl.getUniformLocation(p, "uVel"), 1);
    gl.uniform1i(gl.getUniformLocation(p, "uNoise"), 2);
    this.u = {};
    for (const n of ["uCol", "uT", "uA", "uDim"]) this.u[n] = gl.getUniformLocation(p, n);
    this.ok = true;
  }

  resize(px) {
    if (this.c.width !== px || this.c.height !== px) { this.c.width = px; this.c.height = px; }
  }

  setColors(hexes) {
    this.cols = new Float32Array(12);
    hexes.forEach((h, k) => {
      const n = parseInt(h.slice(1), 16);
      this.cols[k * 3] = ((n >> 16) & 255) / 255;
      this.cols[k * 3 + 1] = ((n >> 8) & 255) / 255;
      this.cols[k * 3 + 2] = (n & 255) / 255;
    });
    this.hexes = hexes;
  }

  // copy the sim's interior cells into the GPU buffers
  upload(F) {
    const W = N + 2, dye = this.dyeBuf, vel = this.velBuf;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const c = i + W * j, o = ((j - 1) * N + (i - 1));
        dye[o * 4] = F.d[c * 4];
        dye[o * 4 + 1] = F.d[c * 4 + 1];
        dye[o * 4 + 2] = F.d[c * 4 + 2];
        dye[o * 4 + 3] = F.d[c * 4 + 3];
        vel[o * 2] = F.u[c];
        vel[o * 2 + 1] = F.v[c];
      }
    }
    if (this.ok) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tDye);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, dye);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.tVel);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RG, gl.FLOAT, vel);
    }
  }

  draw(t, alpha, dim = 1) {
    if (this.ok) {
      const gl = this.gl;
      gl.viewport(0, 0, this.c.width, this.c.height);
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      gl.uniform3fv(this.u.uCol, this.cols);
      gl.uniform1f(this.u.uT, t);
      gl.uniform1f(this.u.uA, alpha);
      gl.uniform1f(this.u.uDim, dim);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }
    // 2D fallback: mix colours per cell, let the browser smooth the upscale
    const px = this.img.data, dye = this.dyeBuf, cols = this.cols;
    for (let o = 0; o < N * N; o++) {
      const a = dye[o * 4], b = dye[o * 4 + 1], c = dye[o * 4 + 2], e = dye[o * 4 + 3];
      const tot = a + b + c + e, k = tot / (tot + 0.26), inv = 1 / Math.max(tot, 1e-4);
      for (let ch = 0; ch < 3; ch++) {
        const ink = (cols[ch] * a + cols[3 + ch] * b + cols[6 + ch] * c + cols[9 + ch] * e) * inv;
        const base = [0.03, 0.04, 0.085][ch];
        px[o * 4 + ch] = Math.round((base + (ink - base) * k) * 255 * dim);
      }
      px[o * 4 + 3] = 255;
    }
    this.sctx.putImageData(this.img, 0, 0);
    this.ctx2d.imageSmoothingEnabled = true;
    this.ctx2d.drawImage(this.small, 0, 0, this.c.width, this.c.height);
  }
}

function makeNoise(S) {
  // tileable value noise, a few octaves, packed into bytes
  const out = new Uint8Array(S * S);
  const acc = new Float32Array(S * S);
  let amp = 1, total = 0;
  for (let cell = 32; cell >= 4; cell /= 2) {
    const g = S / cell;
    const grid = new Float32Array(g * g).map(() => Math.random());
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const fx = x / cell, fy = y / cell;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const at = (i, j) => grid[((j + g) % g) * g + ((i + g) % g)];
        const v = (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
        acc[y * S + x] += v * amp;
      }
    }
    total += amp;
    amp *= 0.55;
  }
  for (let i = 0; i < S * S; i++) out[i] = Math.round((acc[i] / total) * 255);
  return out;
}
