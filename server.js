import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

app.use(
  cors({
    origin: [
      "https://lockbox-frontend.onrender.com",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  })
);
app.use(express.json());

// =======================================================
// CONFIG
// =======================================================
const SPORT = "americanfootball_nfl";
const REGIONS = "us";
const MARKETS = "h2h,spreads,totals";
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const CACHE_MS = 5 * 60 * 1000;
const RESULT_LOG = "./results.json";
const HISTORY_LOG = "./ai_history.json";

let oddsCache = { data: null, ts: 0 };
let record = { wins: 0, losses: 0, winRate: 0 };
let history = [];

if (fs.existsSync(RESULT_LOG)) record = JSON.parse(fs.readFileSync(RESULT_LOG));
if (fs.existsSync(HISTORY_LOG)) history = JSON.parse(fs.readFileSync(HISTORY_LOG));

// =======================================================
// HELPERS
// =======================================================
const impliedProb = (ml) =>
  ml < 0 ? (-ml) / ((-ml) + 100) : 100 / (ml + 100);

function calcConfidence(a, b, type) {
  const toProb = (odds) =>
    odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
  const diff = Math.abs(toProb(a) - toProb(b));
  if (type === "moneyline") return Math.round(50 + diff * 100);
  if (type === "spread") return Math.round(45 + diff * 80);
  return Math.round(50 + Math.random() * 25);
}

// =======================================================
// FETCH ODDS — PRE-GAME ONLY
// =======================================================
async function fetchOdds() {
  const fresh = oddsCache.data && Date.now() - oddsCache.ts < CACHE_MS;
  if (fresh) return oddsCache.data;

  try {
    const { data } = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`,
      {
        params: {
          apiKey: ODDS_API_KEY,
          regions: REGIONS,
          markets: MARKETS,
          oddsFormat: "american",
          dateFormat: "iso",
        },
      }
    );

    const now = new Date();
    const soonestStart = new Date(now.getTime() + 15 * 60 * 1000); // 15-min buffer

    const clean = (data || [])
      .filter((g) => {
        const start = new Date(g.commence_time);
        const recentBook = g.bookmakers?.some((b) => {
          const lu = new Date(b.last_update);
          return now - lu < 3 * 60 * 60 * 1000; // within 3 hours → likely live
        });
        return start > soonestStart && !recentBook;
      })
      .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));

    oddsCache = { data: clean, ts: Date.now() };
    console.log(`📊 Loaded ${clean.length} upcoming NFL games (pre-kickoff only)`);
    return clean;
  } catch (err) {
    console.error("❌ fetchOdds failed:", err.message);
    return [];
  }
}

// =======================================================
// PICK LOGIC
// =======================================================
function buildGamePicks(games) {
  return games
    .map((g) => {
      const home = g.home_team;
      const away = g.away_team;
      const book = g.bookmakers?.[0]?.title || "Unknown";
      const markets = g.bookmakers?.[0]?.markets || [];

      const h2h = markets.find((m) => m.key === "h2h");
      const spread = markets.find((m) => m.key === "spreads");
      if (!h2h) return null;

      const homeML = h2h.outcomes?.find((o) => o.name === home)?.price;
      const awayML = h2h.outcomes?.find((o) => o.name === away)?.price;
      if (!homeML || !awayML) return null;

      const mlConf = calcConfidence(homeML, awayML, "moneyline");
      const mlPick = impliedProb(homeML) > impliedProb(awayML) ? home : away;

      let spreadPick = null;
      const hs = spread?.outcomes?.find((o) => o.name === home);
      const as = spread?.outcomes?.find((o) => o.name === away);
      if (hs && as) {
        const homeLine = parseFloat(hs.point);
        const awayLine = parseFloat(as.point);
        const homePrice = hs.price;
        const awayPrice = as.price;

        const favorite = mlPick;
        const underdog = favorite === home ? away : home;
        const favLine = favorite === home ? homeLine : awayLine;
        const sameSide = favLine < 0;
        const chosen = sameSide ? favorite : underdog;

        spreadPick = {
          type: "spread",
          pick: chosen,
          confidence: calcConfidence(homePrice, awayPrice, "spread"),
        };
      }

      return {
        matchup: `${away} @ ${home}`,
        bookmaker: book,
        mlPick: { pick: mlPick, confidence: mlConf },
        spreadPick,
      };
    })
    .filter(Boolean);
}

// =======================================================
// ROUTES
// =======================================================
app.get("/api/picks", async (_, res) => {
  try {
    const data = await fetchOdds();
    res.json({ picks: buildGamePicks(data) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ picks: [] });
  }
});

app.get("/api/featured", async (_, res) => {
  try {
    const games = await fetchOdds();
    const picks = buildGamePicks(games);
    const mlLock = picks
      .map((p) => p.mlPick)
      .sort((a, b) => b.confidence - a.confidence)[0];
    const spLock = picks
      .map((p) => p.spreadPick)
      .filter(Boolean)
      .sort((a, b) => b.confidence - a.confidence)[0];
    const featured = {
      moneylineLock: mlLock,
      spreadLock: spLock,
      propLock: { player: "No props available", confidence: 0 },
    };
    res.json(featured);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (_, res) =>
  res.send("LockBox AI ✅ Stable v13 – Pre-Kickoff Filtered")
);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ LockBox AI v13 running on port ${PORT}`));
