// Server-clocked lockstep relay, shared by Swirl and Sand Siege.
//
// The server never simulates. It keeps time: every tick it broadcasts the inputs
// that arrived since the last one ({t:"k", n, i:[[slot, x, y, flags]...]}), and every
// client applies them in the same order to the same deterministic sim. Bots run inside
// that sim, so they cost the server nothing. When a human drops mid-match, a "b" entry
// in the tick stream hands their slot to a bot at an exact tick, so everyone switches
// at the same moment.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export function startLockstepServer(opt) {
  const {
    name, port, host = "0.0.0.0", publicDir,
    hz, maxTicks, maxSlots, minSlots = 2, publicSize, defaultBots = 1,
    lobbyMs = 4500, countdownMs = 3000, colors, botNames, clientEnds = false,
  } = opt;
  const TICK_MS = 1000 / hz;

  // ---------- static ----------
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
    let urlPath;
    try { urlPath = decodeURIComponent(req.url.split("?")[0]); } catch { res.writeHead(400); res.end(); return; }
    if (urlPath.endsWith("/")) urlPath += "index.html";
    const filePath = path.join(publicDir, path.normalize(urlPath));
    if (!filePath.startsWith(publicDir + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
      const mtime = st.mtime.toUTCString();
      if (req.headers["if-modified-since"] === mtime) { res.writeHead(304); res.end(); return; }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
        "Content-Length": st.size, "Last-Modified": mtime, "Cache-Control": "no-cache",
      });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(filePath).pipe(res);
    });
  });
  const wss = new WebSocketServer({ server, maxPayload: 2048 });

  const sendRaw = (ws, data) => { if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1 << 20) ws.send(data); };
  const send = (ws, msg) => sendRaw(ws, JSON.stringify(msg));

  // ---------- rooms ----------
  const rooms = new Set();
  const byCode = new Map();
  let seq = 0;

  class Room {
    constructor(isPrivate) {
      this.isPrivate = isPrivate;
      this.code = null;
      if (isPrivate) {
        do { this.code = ""; for (let i = 0; i < 4; i++) this.code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; } while (byCode.has(this.code));
        byCode.set(this.code, this);
      }
      this.members = new Map();
      this.hostId = null;
      this.state = "lobby";
      this.bots = isPrivate ? defaultBots : 0;
      this.startsAt = isPrivate ? 0 : Date.now() + lobbyMs;
      this.timer = isPrivate ? null : setTimeout(() => this.start(), lobbyMs);
      this.hashes = new Map();
      rooms.add(this);
    }
    get humans() { let n = 0; for (const m of this.members.values()) if (m.ws) n++; return n; }
    bcast(msg) {
      const data = JSON.stringify(msg);
      for (const m of this.members.values()) if (m.ws) sendRaw(m.ws, data);
    }
    lobby() {
      const members = [...this.members.values()].filter((m) => m.ws).map((m) => ({ id: m.id, name: m.name }));
      this.bcast({
        t: "lobby", state: this.state, priv: this.isPrivate, code: this.code, host: this.hostId, members,
        bots: this.isPrivate ? this.bots : Math.max(0, publicSize - this.humans),
        startsIn: this.state === "lobby" && !this.isPrivate ? Math.max(0, this.startsAt - Date.now()) : null,
        maxSlots,
      });
    }
    add(ws, nm) {
      const m = { id: ++seq, name: nm, ws, slot: -1 };
      this.members.set(m.id, m);
      if (this.hostId == null) this.hostId = m.id;
      send(ws, { t: "joined", id: m.id, code: this.code, priv: this.isPrivate });
      this.lobby();
      if (!this.isPrivate && this.state === "lobby" && this.humans >= maxSlots) this.start();
      return m;
    }
    remove(id) {
      const m = this.members.get(id);
      if (!m) return;
      this.members.delete(id);
      if (this.state === "play" || this.state === "countdown") {
        if (m.slot >= 0) this.pendingBots.push(m.slot);
      }
      if (this.hostId === id) {
        this.hostId = null;
        for (const mm of this.members.values()) if (mm.ws) { this.hostId = mm.id; break; }
      }
      if (this.humans === 0) { this.destroy(); return; }
      this.lobby();
    }
    destroy() {
      clearTimeout(this.timer);
      this.state = "dead";
      rooms.delete(this);
      if (this.code) byCode.delete(this.code);
    }
    setBots(by, n) {
      if (!this.isPrivate || by !== this.hostId || this.state === "play" || this.state === "countdown") return;
      this.bots = Math.max(0, Math.min(maxSlots - 1, n | 0));
      this.lobby();
    }
    requestStart(by) {
      if (this.state === "play" || this.state === "countdown") return;
      if (this.isPrivate && by !== this.hostId) return;
      this.start();
    }
    start() {
      if (this.state === "play" || this.state === "countdown" || this.state === "dead") return;
      clearTimeout(this.timer);
      const humans = [...this.members.values()].filter((m) => m.ws).slice(0, maxSlots);
      const nb = this.isPrivate ? Math.min(this.bots, maxSlots - humans.length) : Math.max(0, publicSize - humans.length);
      if (humans.length + nb < minSlots) {
        for (const m of humans) send(m.ws, { t: "err", msg: "Need at least two players. Add a bot or invite a friend." });
        return;
      }
      const used = new Set(humans.map((h) => h.name));
      const entrants = humans.map((m) => ({ name: m.name, bot: false, member: m }));
      for (let i = 0; i < nb; i++) {
        const free = botNames.filter((x) => !used.has(x));
        const nm = free.length ? free[Math.floor(Math.random() * free.length)] : "Bot";
        used.add(nm);
        entrants.push({ name: nm, bot: true, member: null });
      }
      // shuffle seats so the host isn't always the first corner
      for (let i = entrants.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [entrants[i], entrants[j]] = [entrants[j], entrants[i]];
      }
      for (const m of this.members.values()) m.slot = -1;
      this.slots = entrants.map((e, k) => {
        if (e.member) e.member.slot = k;
        return { name: e.name, bot: e.bot, color: colors[k] };
      });
      this.inputs = this.slots.map(() => ({ x: 0, y: 0, f: 0, dirty: false, pulse: 0 }));
      this.pendingBots = [];
      this.seed = (Math.random() * 0xffffffff) >>> 0;
      this.n = 0;
      this.hashes.clear();
      this.state = "countdown";
      for (const m of this.members.values()) {
        if (!m.ws) continue;
        send(m.ws, { t: "start", seed: this.seed, slots: this.slots, you: m.slot, hz, maxTicks, in: countdownMs });
      }
      this.lobby();
      this.t0 = Date.now() + countdownMs;
      this.timer = setTimeout(() => { this.state = "play"; this.loop(); }, countdownMs);
    }
    loop() {
      if (this.state !== "play") return;
      const due = Math.floor((Date.now() - this.t0) / TICK_MS) + 1;
      let sent = 0;
      while (this.n < due && sent < 20 && this.state === "play") {
        this.tick();
        sent++;
      }
      if (this.state !== "play") return;
      const next = this.t0 + this.n * TICK_MS;
      this.timer = setTimeout(() => this.loop(), Math.max(1, next - Date.now()));
    }
    tick() {
      this.n++;
      const list = [];
      this.inputs.forEach((inp, k) => {
        if (!inp.dirty && !inp.pulse) return;
        list.push([k, inp.x, inp.y, inp.f | (inp.pulse ? 2 : 0)]);
        inp.dirty = false;
        inp.pulse = 0;
      });
      const msg = { t: "k", n: this.n };
      if (list.length) msg.i = list;
      if (this.pendingBots.length) { msg.b = this.pendingBots; this.pendingBots = []; }
      this.bcast(msg);
      if (this.n >= maxTicks) this.finish(this.n);
    }
    finish(n) {
      if (this.state !== "play") return;
      clearTimeout(this.timer);
      this.state = "over";
      this.bcast({ t: "end", n });
      if (!this.isPrivate) this.timer = setTimeout(() => this.destroy(), 120000);
      this.lobby();
    }
    input(m, x, y, f) {
      if (this.state !== "play" && this.state !== "countdown") return;
      if (m.slot < 0) return;
      const inp = this.inputs[m.slot];
      x = Math.max(0, Math.min(100000, x | 0));
      y = Math.max(0, Math.min(100000, y | 0));
      f = f & 0xfd;              // bit 1 is the server-side pulse
      if (inp.x !== x || inp.y !== y || inp.f !== f) { inp.x = x; inp.y = y; inp.f = f; inp.dirty = true; }
    }
    pulse(m, x, y) {
      if (this.state !== "play" || m.slot < 0) return;
      const inp = this.inputs[m.slot];
      if (Number.isFinite(x) && Number.isFinite(y)) { inp.x = Math.max(0, Math.min(100000, x | 0)); inp.y = Math.max(0, Math.min(100000, y | 0)); }
      inp.pulse = 1;
    }
    hash(m, n, h) {
      if (m.slot < 0 || this.state !== "play") return;
      let row = this.hashes.get(n);
      if (!row) { row = new Map(); this.hashes.set(n, row); }
      row.set(m.slot, h);
      const vals = new Set(row.values());
      if (vals.size > 1) console.warn(`[${name}] desync room=${this.code || "public"} tick=${n}`, Object.fromEntries(row));
      if (this.hashes.size > 20) this.hashes.delete(this.hashes.keys().next().value);
    }
  }

  // ---------- sockets ----------
  let online = 0, onlineDirty = false;
  const leave = (ws) => {
    const r = ws.room;
    if (!r) return;
    ws.room = null;
    const id = ws.member.id;
    ws.member = null;
    r.remove(id);
  };

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.room = null;
    ws.member = null;
    ws.win = Date.now();
    ws.count = 0;
    ws.on("pong", () => { ws.isAlive = true; });
    online++;
    onlineDirty = true;
    send(ws, { t: "hi", online });
    ws.on("message", (raw) => {
      const now = Date.now();
      if (now - ws.win > 1000) { ws.win = now; ws.count = 0; }
      if (++ws.count > 120) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.t !== "string") return;
      const r = ws.room, me = ws.member;
      switch (msg.t) {
        case "play": {
          const nm = String(msg.name || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 16) || "Player";
          let room;
          if (msg.mode === "create") room = new Room(true);
          else if (msg.mode === "join") {
            const code = String(msg.code || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
            room = byCode.get(code);
            if (!room) { send(ws, { t: "err", msg: "No room with that code. Check it and try again.", fatal: true }); return; }
            if (room.humans >= maxSlots) { send(ws, { t: "err", msg: "That room is full.", fatal: true }); return; }
          } else {
            for (const x of rooms) if (!x.isPrivate && x.state === "lobby" && x.humans < maxSlots && (!room || x.humans > room.humans)) room = x;
            if (!room) room = new Room(false);
          }
          leave(ws);
          ws.room = room;
          ws.member = room.add(ws, nm);
          break;
        }
        case "in": if (r) r.input(me, Number(msg.x), Number(msg.y), msg.f !== undefined ? msg.f | 0 : msg.d ? 1 : 0); break;
        case "vx": if (r) r.pulse(me, Number(msg.x), Number(msg.y)); break;
        case "h": if (r) r.hash(me, msg.n | 0, msg.h >>> 0); break;
        case "over":
          if (r && clientEnds && r.state === "play" && (msg.n | 0) > 0 && (msg.n | 0) <= r.n) r.finish(msg.n | 0);
          break;
        case "start": if (r) r.requestStart(me.id); break;
        case "bots": if (r) r.setBots(me.id, msg.n); break;
        case "leave": leave(ws); send(ws, { t: "left-ok" }); break;
      }
    });
    ws.on("close", () => { leave(ws); online--; onlineDirty = true; });
    ws.on("error", () => {});
  });

  setInterval(() => {
    if (!onlineDirty) return;
    onlineDirty = false;
    const data = JSON.stringify({ t: "online", n: online });
    for (const ws of wss.clients) sendRaw(ws, data);
  }, 1000);
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 25000);
  wss.on("close", () => clearInterval(hb));

  server.listen(port, host, () => console.log(`${name} listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`));
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      for (const ws of wss.clients) { try { ws.close(1001, "server restarting"); } catch {} }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  }
  return { server, wss };
}
