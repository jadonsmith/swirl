// Swirl: client. Lobby, the lockstep driver (apply inputs → step → render), pointer
// input, HUD and a live bots-only tank behind the menu.
import { Fluid, N, HZ, MATCH_TICKS, VORTEX_CD } from "./fluid.js";
import { Tank } from "./render.js";
import { Sfx } from "./sfx.js";

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const DEMO_COLORS = ["#ff3d9a", "#22d3ee", "#fbbf24", "#a3e635"];

const tank = new Tank($("tank"));
const fxc = $("fx"), fx = fxc.getContext("2d");
const sfx = new Sfx();
const touch = matchMedia("(pointer: coarse)").matches;

const ui = {
  hud: $("hud"), menu: $("menu"), lobby: $("lobby"), results: $("results"), toast: $("toast"),
  online: $("menu-online"), name: $("name"), code: $("code"),
  bar: $("bar"), legend: $("legend"), clock: $("clock"), big: $("big"), inkFill: $("ink-fill"),
  vortex: $("btn-vortex"), ring: $("vortex-ring"), hint: $("hint"), mute: $("btn-mute"),
  lobbyKicker: $("lobby-kicker"), lobbyTitle: $("lobby-title"), codeBox: $("code-box"), lobbyCode: $("lobby-code"),
  people: $("people"), botsRow: $("bots-row"), botsN: $("bots-n"), lobbyNote: $("lobby-note"), start: $("btn-start"),
  resTitle: $("res-title"), resList: $("res-list"), again: $("btn-again"),
};

const S = {
  ws: null, retry: 0, mode: "menu", myId: null, priv: false, code: null, lobby: null, lastJoin: null,
  F: null, slots: [], you: -1, goAt: 0, lastTickAt: 0, ended: false, dirty: true,
  demo: null, demoAcc: 0, rect: { x: 0, y: 0, size: 100 },
  ptr: { x: N * 5, y: N * 5, down: false, inside: false, sx: 0, sy: 0, sentAt: 0, sent: "" },
  effects: [], hudAt: 0,
};

const store = {
  get(k, d = "") { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
ui.name.value = store.get("swirl_name");
function myName() {
  const n = ui.name.value.trim().slice(0, 16);
  store.set("swirl_name", n);
  return n || "Player " + Math.floor(10 + Math.random() * 90);
}

// ───────── socket ─────────
function connect() {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const base = location.pathname.replace(/[^/]*$/, "");
  let ws;
  try { ws = new WebSocket(proto + location.host + base); } catch { reconnect(); return; }
  S.ws = ws;
  ws.onopen = () => {
    S.retry = 0;
    if (S.mode !== "menu" && S.lastJoin) send({ t: "play", ...S.lastJoin });
    else autoJoin();
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onMsg(m);
  };
  ws.onclose = () => {
    S.ws = null;
    ui.online.textContent = "reconnecting…";
    if (S.mode === "match" && !S.ended) {
      toast("Connection lost. That match can't be rejoined, so you're back in the lobby.");
      S.F = null;
    }
    reconnect();
  };
}
function reconnect() {
  const delay = Math.min(8000, 400 * 2 ** S.retry++);
  setTimeout(() => {
    if (!document.hidden) return connect();
    const v = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", v); connect(); } };
    document.addEventListener("visibilitychange", v);
  }, delay);
}
function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }

let autoJoined = false;
function autoJoin() {
  if (autoJoined) return;
  autoJoined = true;
  const room = new URLSearchParams(location.search).get("room");
  if (room) play({ mode: "join", code: room.toUpperCase().slice(0, 4) });
}
function play(opts) {
  sfx.unlock();
  S.lastJoin = { ...opts, name: myName() };
  if (!S.ws || S.ws.readyState !== 1) { toast("Still connecting…"); return; }
  send({ t: "play", ...S.lastJoin });
}

function onMsg(m) {
  switch (m.t) {
    case "hi": ui.online.textContent = `${m.online} online`; break;
    case "online": ui.online.textContent = `${m.n} online`; break;
    case "joined":
      S.myId = m.id;
      S.priv = m.priv;
      S.code = m.code;
      if (m.priv) {
        S.lastJoin = { mode: "join", code: m.code, name: S.lastJoin?.name };
        history.replaceState(null, "", location.pathname + "?room=" + m.code);
      }
      break;
    case "lobby": onLobby(m); break;
    case "start": onStart(m); break;
    case "k": onTick(m); break;
    case "end": onEnd(m); break;
    case "err":
      toast(m.msg);
      if (m.fatal) showMenu();
      break;
  }
}

// ───────── lobby ─────────
let lobbyTimer = 0;
function onLobby(m) {
  S.lobby = m;
  S.lobbyAt = performance.now();
  if (m.state === "lobby" && S.mode !== "match") showLobby();
  else if (m.state === "lobby" && S.mode === "match" && S.ended && ui.results.hidden) showLobby();
  renderLobby();
}
function showLobby() {
  S.mode = "lobby";
  ui.menu.hidden = ui.results.hidden = ui.hud.hidden = true;
  ui.lobby.hidden = false;
  renderLobby();
  clearInterval(lobbyTimer);
  lobbyTimer = setInterval(renderLobby, 250);
}
function renderLobby() {
  const m = S.lobby;
  if (!m || ui.lobby.hidden) { clearInterval(lobbyTimer); return; }
  const host = m.host === S.myId;
  ui.lobbyKicker.textContent = m.priv ? "Private room" : "Quick match";
  ui.codeBox.hidden = !m.priv;
  ui.lobbyCode.textContent = m.code || "····";
  ui.botsRow.hidden = !m.priv || !host;
  ui.botsN.textContent = m.bots;
  const busy = m.state === "play" || m.state === "countdown";
  if (m.priv) {
    ui.lobbyTitle.textContent = busy ? "Match in progress" : "Room ready";
    ui.lobbyNote.textContent = busy ? "You'll be in the next one." : host ? `Up to ${m.maxSlots} inks. ${m.bots ? `${m.bots} bot${m.bots > 1 ? "s" : ""} will join.` : "No bots."}` : "Waiting for the host to start…";
    ui.start.hidden = !host || busy;
    ui.start.textContent = "Start match";
  } else {
    const left = m.startsIn == null ? 0 : Math.max(0, m.startsIn - (performance.now() - S.lobbyAt));
    ui.lobbyTitle.textContent = left > 0 ? `Starting in ${Math.ceil(left / 1000)}…` : "Starting…";
    ui.lobbyNote.textContent = "Bots fill the empty corners. Anyone who hits Play in the next few seconds joins you.";
    ui.start.hidden = false;
    ui.start.textContent = "Start now";
  }
  const rows = m.members.map((p) => `<li><span class="av"></span>${esc(p.id === S.myId ? p.name + " (you)" : p.name)}${p.id === m.host && m.priv ? "<small>host</small>" : ""}</li>`);
  if (m.bots) rows.push(`<li class="bot"><span class="av" style="background:#8b5cf6"></span>+ ${m.bots} bot${m.bots > 1 ? "s" : ""}</li>`);
  const html = rows.join("");
  if (ui.people.dataset.html !== html) { ui.people.innerHTML = html; ui.people.dataset.html = html; }
}

// ───────── the match (lockstep) ─────────
function onStart(m) {
  clearInterval(lobbyTimer);
  S.mode = "match";
  S.ended = false;
  S.slots = m.slots;
  S.you = m.you;
  S.F = new Fluid(m.seed, m.slots);
  S.goAt = performance.now() + m.in;
  S.lastTickAt = S.goAt;
  S.effects = [];
  S.dirty = true;
  tank.setColors(m.slots.map((s) => s.color).concat(DEMO_COLORS).slice(0, 4));
  const me = m.slots[m.you];
  document.documentElement.style.setProperty("--me", me ? me.color : "#ff3d9a");
  ui.menu.hidden = ui.lobby.hidden = ui.results.hidden = true;
  ui.hud.hidden = false;
  ui.hint.style.opacity = "";
  const secs = Math.round(m.in / 1000);
  for (let i = 0; i < secs; i++) setTimeout(() => { if (S.mode === "match") { big(String(secs - i)); sfx.beep(false); } }, i * 1000);
  setTimeout(() => { if (S.mode === "match") { big("Pour!"); sfx.beep(true); } }, m.in);
  // start at your corner so you know which ink is yours
  const pl = S.F.players[S.you];
  if (pl) { S.ptr.x = pl.x; S.ptr.y = pl.y; }
  layout();
}

function onTick(m) {
  const F = S.F;
  if (!F || S.ended) return;
  if (m.b) for (const k of m.b) F.makeBot(k);
  if (m.i) for (const [k, x, y, f] of m.i) F.setInput(k, x, y, f);
  F.step();
  S.lastTickAt = performance.now();
  S.dirty = true;
  for (const pl of F.players) {
    if (pl.vortexAt === F.tick) {
      S.effects.push({ kind: "vortex", x: pl.x / 10, y: pl.y / 10, t: 0, life: 1.1, col: S.slots[pl.k]?.color || "#fff", dir: pl.k % 2 ? -1 : 1 });
      sfx.vortex();
    }
  }
  if (F.tick % 125 === 0) {
    const h = F.hash();
    (S.hashLog ||= {})[F.tick] = h;
    send({ t: "h", n: F.tick, h });
  }
}

function onEnd() {
  if (!S.F || S.ended) return;
  S.ended = true;
  S.F.score();
  sfx.pour(0);
  setTimeout(showResults, 900);
}

function standings() {
  return S.F.players.map((pl) => ({ k: pl.k, area: pl.area, name: S.slots[pl.k]?.name || "?", color: S.slots[pl.k]?.color || "#fff", bot: S.slots[pl.k]?.bot })).sort((a, b) => b.area - a.area);
}

function showResults() {
  if (S.mode !== "match" || !S.F) return;
  const st = standings();
  const top = st[0];
  const mine = top && top.k === S.you;
  const tie = st.length > 1 && Math.abs(st[0].area - st[1].area) < 0.0005;
  ui.resTitle.innerHTML = tie ? "Dead heat" : mine ? `<span style="color:${top.color}">You</span> win` : `<span style="color:${top.color}">${esc(top.name)}</span> wins`;
  if (mine && !tie) sfx.win(); else sfx.lose();
  ui.resList.innerHTML = st.map((p, i) => `<li class="${p.k === S.you ? "me" : ""}"><span class="fillbar" style="width:${Math.max(2, p.area * 100)}%;background:${p.color}"></span><span class="rk">${i + 1}</span><span>${esc(p.k === S.you ? "You" : p.name)}${p.bot ? ' <small style="color:var(--ink-3)">bot</small>' : ""}</span><span class="pc" style="color:${p.color}">${(p.area * 100).toFixed(1)}%</span></li>`).join("");
  ui.again.textContent = S.priv ? (S.lobby && S.lobby.host === S.myId ? "Rematch" : "Back to room") : "Play again";
  ui.results.hidden = false;
}

// ───────── input ─────────
function toTank(cx, cy) {
  const r = S.rect;
  return {
    x: Math.max(0, Math.min(N * 10, Math.round(((cx - r.x) / r.size) * N * 10))),
    y: Math.max(0, Math.min(N * 10, Math.round(((cy - r.y) / r.size) * N * 10))),
  };
}
const playing = () => S.mode === "match" && S.F && !S.ended && performance.now() >= S.goAt - 50;
const tankEl = $("tank");
tankEl.addEventListener("pointerdown", (e) => {
  sfx.unlock();
  if (S.mode !== "match") return;
  const p = toTank(e.clientX, e.clientY);
  S.ptr.x = p.x;
  S.ptr.y = p.y;
  if (e.pointerType === "mouse" && e.button === 2) { fireVortex(); return; }
  if (e.pointerType === "mouse" && e.button !== 0) return;
  S.ptr.down = true;
  S.ptr.id = e.pointerId;
  try { tankEl.setPointerCapture(e.pointerId); } catch {}
  ui.hint.style.opacity = "0";
  pushInput(true);
});
tankEl.addEventListener("pointermove", (e) => {
  if (S.mode !== "match") return;
  if (S.ptr.down && e.pointerId !== S.ptr.id) return;
  const p = toTank(e.clientX, e.clientY);
  S.ptr.x = p.x;
  S.ptr.y = p.y;
  S.ptr.inside = true;
  pushInput(false);
});
const up = (e) => {
  if (!S.ptr.down || e.pointerId !== S.ptr.id) return;
  S.ptr.down = false;
  pushInput(true);
};
tankEl.addEventListener("pointerup", up);
tankEl.addEventListener("pointercancel", up);
tankEl.addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("keydown", (e) => {
  if (e.key === "m" || e.key === "M") { toggleMute(); return; }
  if ((e.key === " " || e.key === "v" || e.key === "V") && S.mode === "match") { e.preventDefault(); fireVortex(); }
});
ui.vortex.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); sfx.unlock(); fireVortex(); });

function pushInput(force) {
  const now = performance.now();
  const key = `${S.ptr.x},${S.ptr.y},${S.ptr.down ? 1 : 0}`;
  if (key === S.ptr.sent) return;
  if (!force && now - S.ptr.sentAt < 30) { S.ptr.pending = true; return; }
  send({ t: "in", x: S.ptr.x, y: S.ptr.y, d: S.ptr.down ? 1 : 0 });
  S.ptr.sent = key;
  S.ptr.sentAt = now;
  S.ptr.pending = false;
}
function fireVortex() {
  if (!playing()) return;
  const pl = S.F.players[S.you];
  if (!pl || pl.cd > 0) return;
  send({ t: "vx", x: S.ptr.x, y: S.ptr.y });
}

// ───────── HUD ─────────
let bigTimer = 0;
function big(txt) {
  ui.big.className = "big";
  void ui.big.offsetWidth;
  ui.big.textContent = txt;
  ui.big.className = "big pop";
  clearTimeout(bigTimer);
  bigTimer = setTimeout(() => { ui.big.textContent = ""; }, 950);
}
let toastTimer = 0;
function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3200);
}
function hud(now) {
  if (S.mode !== "match" || !S.F || now - S.hudAt < 100) return;
  S.hudAt = now;
  const F = S.F;
  const ordered = F.players.map((pl) => ({ k: pl.k, a: pl.area }));
  const bar = ordered.map((p) => `<i style="width:${(p.a * 100).toFixed(2)}%;background:${S.slots[p.k].color}"></i>`).join("");
  if (ui.bar.dataset.h !== bar) { ui.bar.innerHTML = bar; ui.bar.dataset.h = bar; }
  const legend = ordered.map((p) => `<span class="${p.k === S.you ? "me" : ""}"><i style="background:${S.slots[p.k].color}"></i>${esc(p.k === S.you ? "You" : S.slots[p.k].name)} <b>${Math.round(p.a * 100)}%</b></span>`).join("");
  if (ui.legend.dataset.h !== legend) { ui.legend.innerHTML = legend; ui.legend.dataset.h = legend; }
  const left = Math.max(0, (MATCH_TICKS - F.tick) / HZ);
  const secs = Math.ceil(left);
  ui.clock.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  ui.clock.classList.toggle("low", left <= 10);
  const pl = F.players[S.you];
  if (pl) {
    ui.inkFill.style.transform = `scaleX(${pl.ink.toFixed(3)})`;
    const cd = pl.cd / VORTEX_CD;
    ui.ring.style.strokeDashoffset = String(Math.round(cd * 100));
    ui.vortex.classList.toggle("cool", cd > 0);
  }
}

// ───────── buttons ─────────
$("play-form").addEventListener("submit", (e) => { e.preventDefault(); play({ mode: "quick" }); });
$("btn-create").addEventListener("click", () => play({ mode: "create" }));
$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = ui.code.value.toUpperCase().replace(/[^A-Z]/g, "");
  if (code.length !== 4) { toast("Room codes are 4 letters."); return; }
  play({ mode: "join", code });
});
ui.code.addEventListener("input", () => { ui.code.value = ui.code.value.toUpperCase().replace(/[^A-Z]/g, ""); });
ui.start.addEventListener("click", () => { sfx.unlock(); send({ t: "start" }); });
$("btn-lobby-leave").addEventListener("click", () => { send({ t: "leave" }); showMenu(); });
$("btn-leave").addEventListener("click", () => { send({ t: "leave" }); showMenu(); });
$("bots-minus").addEventListener("click", () => send({ t: "bots", n: (S.lobby?.bots || 0) - 1 }));
$("bots-plus").addEventListener("click", () => send({ t: "bots", n: (S.lobby?.bots || 0) + 1 }));
$("btn-copy").addEventListener("click", () => {
  const url = location.origin + location.pathname + "?room=" + S.code;
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => toast("Invite link copied"), () => toast(url));
  else toast(url);
});
$("btn-res-menu").addEventListener("click", () => { send({ t: "leave" }); showMenu(); });
ui.again.addEventListener("click", () => {
  sfx.unlock();
  if (S.priv) {
    if (S.lobby && S.lobby.host === S.myId) send({ t: "start" });
    else showLobby();
  } else play({ mode: "quick" });
});
ui.mute.addEventListener("click", toggleMute);
function toggleMute() {
  sfx.unlock();
  sfx.setMuted(!sfx.muted);
  ui.mute.textContent = sfx.muted ? "🔇" : "🔊";
}
ui.mute.textContent = sfx.muted ? "🔇" : "🔊";

function showMenu() {
  S.mode = "menu";
  S.F = null;
  S.ended = false;
  clearInterval(lobbyTimer);
  sfx.pour(0);
  ui.hud.hidden = ui.lobby.hidden = ui.results.hidden = true;
  ui.menu.hidden = false;
  tank.setColors(DEMO_COLORS);
  history.replaceState(null, "", location.pathname);
  layout();
}

// ───────── layout + loop ─────────
function layout() {
  const W = innerWidth, H = innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let size, x, y;
  if (S.mode === "match") {
    const small = W < 640;
    const top = small ? 92 : 84, bottom = small ? 104 : 96;
    size = Math.floor(Math.min(W - (small ? 16 : 48), H - top - bottom));
    x = Math.round((W - size) / 2);
    y = Math.round(top + (H - top - bottom - size) / 2);
  } else {
    size = Math.floor(Math.min(W, H) * 0.96);
    x = Math.round((W - size) / 2);
    y = Math.round((H - size) / 2);
  }
  size = Math.max(120, size);
  S.rect = { x, y, size };
  for (const c of [tankEl, fxc]) {
    c.style.left = x + "px";
    c.style.top = y + "px";
    c.style.width = size + "px";
    c.style.height = size + "px";
  }
  tank.resize(Math.round(size * Math.min(dpr, 1.5)));
  const fpx = Math.round(size * dpr);
  if (fxc.width !== fpx) { fxc.width = fpx; fxc.height = fpx; }
  S.dirty = true;
}
addEventListener("resize", layout);

function demoTick(dt) {
  if (!S.demo || S.demo.tick > MATCH_TICKS) {
    S.demo = new Fluid((Math.random() * 0xffffffff) >>> 0, [{ bot: true }, { bot: true }, { bot: true }, { bot: true }]);
  }
  S.demoAcc += dt * HZ;
  let n = 0;
  while (S.demoAcc >= 1 && n < 3) {
    S.demoAcc -= 1;
    n++;
    S.demo.step();
    S.dirty = true;
    S.lastTickAt = performance.now();
  }
  if (S.demoAcc > 3) S.demoAcc = 0;
}

function drawOverlay(F, now, dt) {
  const s = fxc.width / (N * 10);
  fx.setTransform(1, 0, 0, 1, 0, 0);
  fx.clearRect(0, 0, fxc.width, fxc.height);
  if (!F) return;
  const dpr = fxc.width / S.rect.size;
  // vortex swirls
  for (const ef of S.effects) {
    ef.t += dt;
    const f = ef.t / ef.life;
    const cx = ef.x * 10 * s, cy = ef.y * 10 * s;
    fx.strokeStyle = ef.col;
    fx.globalAlpha = (1 - f) * 0.9;
    fx.lineWidth = 2.5 * dpr;
    for (let arm = 0; arm < 3; arm++) {
      fx.beginPath();
      for (let k = 0; k <= 30; k++) {
        const u = k / 30;
        const a = ef.dir * (u * 4.2 + f * 6 + (arm * TAU) / 3);
        const r = (6 + u * 60 * (0.4 + f)) * dpr;
        const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
        if (k) fx.lineTo(px, py); else fx.moveTo(px, py);
      }
      fx.stroke();
    }
  }
  fx.globalAlpha = 1;
  S.effects = S.effects.filter((e) => e.t < e.life);
  if (S.mode !== "match") return;
  // everyone's cursor; yours follows your pointer directly
  F.players.forEach((pl) => {
    const mine = pl.k === S.you;
    const x = (mine ? S.ptr.x : pl.x) * s, y = (mine ? S.ptr.y : pl.y) * s;
    const col = S.slots[pl.k]?.color || "#fff";
    const down = mine ? S.ptr.down : pl.down;
    const r = (down ? 13 : 10) * dpr;
    fx.lineWidth = (mine ? 2.5 : 1.6) * dpr;
    fx.strokeStyle = col;
    fx.beginPath();
    fx.arc(x, y, r, 0, TAU);
    fx.stroke();
    if (down) {
      fx.fillStyle = col;
      fx.globalAlpha = 0.35;
      fx.beginPath();
      fx.arc(x, y, r * 0.55, 0, TAU);
      fx.fill();
      fx.globalAlpha = 1;
    }
    fx.font = `600 ${11 * dpr}px "DM Sans", system-ui, sans-serif`;
    fx.textAlign = "center";
    fx.fillStyle = "rgba(0,0,0,.55)";
    const label = mine ? "you" : S.slots[pl.k]?.name || "";
    fx.fillText(label, x + dpr, y - r - 6 * dpr + dpr);
    fx.fillStyle = mine ? "#fff" : col;
    fx.fillText(label, x, y - r - 6 * dpr);
  });
}

let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  let F = null, dim = 1;
  if (S.mode === "match" && S.F) {
    F = S.F;
  } else {
    demoTick(dt);
    F = S.demo;
    dim = 0.8;
  }
  if (S.ptr.pending) pushInput(false);
  if (F && S.dirty) { tank.upload(F); S.dirty = false; }
  const alpha = Math.min(1, (now - S.lastTickAt) / (1000 / HZ));
  tank.draw(now / 1000, alpha, dim);
  drawOverlay(F, now, dt);
  if (S.mode === "match" && S.F && !S.ended) {
    const pl = S.F.players[S.you];
    sfx.pour(S.ptr.down && pl && pl.ink > 0.01 ? 1 : 0);
  }
  hud(now);
}
tank.setColors(DEMO_COLORS);
layout();
requestAnimationFrame(frame);
connect();

window.__swirl = { S, send };
