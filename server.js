import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// =======================
// ✅ CORS CONFIG
// =======================
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

// =======================
// ⚙️ CONFIG
// =======================
const SPORT = "americanfootball_nfl";
const REGIONS = "us";
const MARKETS = "h2h,spreads";
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_CACHE_MS = 5 * 60 * 1000;
const RESULT_LOG = "./results.json";
const HISTORY_LOG = "./ai_history.json";

// =======================
// 🧠 DATA CACHES
// =======================
let oddsCache = { data: null, ts: 0 };
let record = { wins: 0, losses: 0, winRate: 0 };
let history = [];

if (fs.existsSync(RESULT_LOG))
  record = JSON.parse(fs.readFileSync(RESULT_LOG));
if (fs.existsSync(HISTORY_LOG))
  history = JSON.parse(fs.readFileSync(HISTORY_LOG));

// =======================
// 🧮 HELPERS
// =======================
const impliedProb = (ml) =>
  ml < 0 ? (-ml) / ((-ml) + 100) : 100 / (ml + 100);

const toProb = (odds) =>
  odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);

async function fetchOdds() {
  const fresh = oddsCache.data && Date.now() - oddsCache.ts < ODDS_CACHE_MS;
  if (fresh) return oddsCache.data;

  try {
    const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`;
    const { data } = await axios.get(url, {
      params: {
        apiKey: ODDS_API_KEY,
        regions: REGIONS,
        markets: MARKETS,
        oddsFormat: "american",
        dateFormat: "iso",
      },
    });

    if (!Array.isArray(data)) throw new Error("Invalid odds response");
    oddsCache = { data, ts: Date.now() };
    console.log(`📊 Pulled ${data.length} NFL games`);
    return data;
  } catch (err) {
    console.error("❌ fetchOdds failed:", err.message);
    return [];
  }
}

// =======================
// 🎯 GAME FILTERING
// =======================
function getUpcomingGames(games) {
  const now = new Date();
  const upcoming = games.filter(
    (g) => new Date(g.commence_time) > now && g.home_team && g.away_team
  );
  console.log(`🏈 Found ${upcoming.length} upcoming NFL games`);
  return upcoming;
}

// =======================
// 🧠 AI GAME PICKS
// =======================
function calculateConfidence(homeOdds, awayOdds, lineType) {
  const homeProb = toProb(homeOdds);
  const awayProb = toProb(awayOdds);
  const diff = Math.abs(homeProb - awayProb);

  if (lineType === "moneyline") return Math.round(50 + diff * 100);
  if (lineType === "spread") return Math.round(40 + diff * 80);
  return Math.round(50 + Math.random() * 25);
}

async function generateAIGamePicks(games) {
  if (!Array.isArray(games)) return [];

  return games
    .map((g) => {
      const home = g.home_team;
      const away = g.away_team;
      const bookmaker = g.bookmakers?.[0]?.title || "Unknown";
      const markets = g.bookmakers?.[0]?.markets || [];

      const h2h = markets.find((m) => m.key === "h2h");
      const spread = markets.find((m) => m.key === "spreads");

      const homeML = h2h?.outcomes?.find((o) => o.name === home)?.price;
      const awayML = h2h?.outcomes?.find((o) => o.name === away)?.price;

      if (!homeML || !awayML) return null;

      const mlConfidence = calculateConfidence(homeML, awayML, "moneyline");
      const mlPick = {
        type: "moneyline",
        pick: impliedProb(homeML) > impliedProb(awayML) ? home : away,
        confidence: mlConfidence,
        homeML,
        awayML,
      };

      const homeSpread = spread?.outcomes?.find((o) => o.name === home);
      const awaySpread = spread?.outcomes?.find((o) => o.name === away);
      let spreadPick = null;

      if (homeSpread && awaySpread) {
        const spreadConfidence = calculateConfidence(
          homeSpread.price,
          awaySpread.price,
          "spread"
        );
        spreadPick = {
          type: "spread",
          pick:
            Math.abs(homeSpread.price) < Math.abs(awaySpread.price)
              ? home
              : away,
          confidence: spreadConfidence,
          homeSpread,
          awaySpread,
        };
      }

      return {
        matchup: `${away} @ ${home}`,
        bookmaker,
        commence_time: g.commence_time,
        mlPick,
        spreadPick,
      };
    })
    .filter(Boolean);
}

// =======================
// 📈 RECORD TRACKING
// =======================
function updateRecord(win) {
  if (win) record.wins++;
  else record.losses++;
  record.winRate = (
    (record.wins / (record.wins + record.losses)) *
    100
  ).toFixed(1);
  fs.writeFileSync(RESULT_LOG, JSON.stringify(record, null, 2));
}

// =======================
// 🏈 LIVE SCORES ENDPOINT
// =======================
app.get("/api/scores", async (req, res) => {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/scores`;
    const { data } = await axios.get(url, {
      params: { apiKey: ODDS_API_KEY, daysFrom: 3 },
    });

    const formatted = (data || []).map((g) => ({
      id: g.id,
      start_time: g.commence_time,
      home_team: g.home_team,
      away_team: g.away_team,
      completed: g.completed,
      scores: g.scores || [],
      last_update: g.last_update,
    }));

    res.json({ total: formatted.length, games: formatted });
  } catch (err) {
    console.error("❌ /api/scores error:", err.message);
    res.status(500).json({ error: "Failed to fetch scores" });
  }
});

// =======================
// 🚀 FEATURED / PICKS
// =======================
app.get("/api/featured", async (req, res) => {
  try {
    const games = getUpcomingGames(await fetchOdds());
    const picks = await generateAIGamePicks(games);

    const moneylineLock =
      picks
        .map((g) => g.mlPick)
        .filter(Boolean)
        .sort((a, b) => b.confidence - a.confidence)[0] || null;

    const spreadLock =
      picks
        .map((g) => g.spreadPick)
        .filter(Boolean)
        .sort((a, b) => b.confidence - a.confidence)[0] || null;

    const featured = {
      date: new Date().toISOString(),
      moneylineLock,
      spreadLock,
      picks,
    };

    fs.writeFileSync(HISTORY_LOG, JSON.stringify(featured, null, 2));
    res.json(featured);
  } catch (err) {
    console.error("❌ /api/featured error:", err.message);
    res.status(500).json({ error: "Failed to fetch featured picks" });
  }
});

app.get("/api/picks", async (req, res) => {
  try {
    const data = getUpcomingGames(await fetchOdds());
    const picks = await generateAIGamePicks(data);
    res.json({ picks });
  } catch (err) {
    console.error("❌ /api/picks error:", err.message);
    res.status(500).json({ picks: [] });
  }
});

// =======================
// 🧾 HISTORY & RECORD
// =======================
app.get("/api/record", (req, res) => res.json(record));
app.get("/api/history", (req, res) => res.json(history));
app.get("/", (req, res) => res.send("LockBox AI ✅ Stable v20 Running"));

// =======================
// 🖥️ START SERVER (Render-safe)
// =======================
const PORT = process.env.PORT;
app.listen(PORT, () => console.log(`✅ LockBox AI v20 running on port ${PORT}`));
