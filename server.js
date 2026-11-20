// Swirl: server entry. A lockstep relay: the server keeps time and forwards inputs,
// and every client runs the identical fluid simulation (public/js/fluid.js).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLockstepServer } from "./lockstep.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

startLockstepServer({
  name: "Swirl",
  port: Number(process.env.PORT) || 3095,
  host: process.env.HOST || "0.0.0.0",
  publicDir: path.join(__dirname, "public"),
  hz: 25,
  maxTicks: 25 * 90,          // 90-second matches (must match MATCH_TICKS in fluid.js)
  maxSlots: 4,
  publicSize: 4,              // quick matches fill with bots to four inks
  defaultBots: 1,
  colors: ["#ff3d9a", "#22d3ee", "#fbbf24", "#a3e635"],
  botNames: ["Indigo", "Sepia", "Umber", "Ochre", "Cobalt", "Vermilion", "Teal", "Saffron", "Cerulean", "Magenta", "Jade", "Amber"],
});
