# Swirl

A fluid-dynamics territory game for 2–4 players, part of the
[play.jadon.me](https://play.jadon.me) collection (`play.jadon.me/swirl/`).

One shared tank. Hold to pour your ink (your ink meter drains, and refills while
you rest), drag to push the liquid, and fire a vortex (right-click / Space / the
swirl button, 6 s cooldown). Where rival inks overlap they cancel each other
out, so borders form and can be pushed. A cell counts as yours when your ink
leads there above a visibility threshold. Most of the tank after 90 s wins.

## Netcode: server-clocked lockstep

The server (`lockstep.js`, shared with Sand Siege) never simulates. Every 40 ms
(25 Hz) it broadcasts a tick with whatever inputs arrived since the last one.
Every client applies them and steps the same deterministic sim, so only inputs
cross the network. `public/js/fluid.js` uses only `+ − × ÷`, `floor`, `abs` and
`sqrt` on Float64Arrays, a seeded integer PRNG, and an L1-normalised vorticity
confinement (no transcendental functions), so all engines agree. Bots live
*inside* the sim, which makes them deterministic and free for the server. A
human who drops mid-match is handed to a bot at an exact tick (the `b` field of a
tick).

Clients send a state hash every 125 ticks, and the server logs `desync` if they
disagree. Two browser tabs with real inputs from both sides plus two bots matched
at every checkpoint.

Sim: 96×96 stable fluids (Gauss–Seidel projection, semi-Lagrangian advection),
4 dye channels, about 1.3 ms per tick on desktop.

Renderer (`public/js/render.js`): bicubic upsampling, flow-advected marbling
noise (a two-phase flow map), motion extrapolated between ticks, gloss from the
ink height field, dark seams where inks fight. There's a 2D fallback without WebGL2.

```bash
npm install && npm start     # http://localhost:3095
```
Dev handle: `window.__swirl`.
