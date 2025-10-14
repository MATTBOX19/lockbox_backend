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
const MARKETS = "h2h,spreads,totals";
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_CACHE_MS = 10 * 60 * 1000; // 10 min
const RESULT_LOG = "./results.json";
const HISTORY_LOG = "./ai_history.json";

// =======================
// 🧠 DATA CACHE
// =======================
let oddsCache = { data: null, ts: 0 };

// =======================
// 🧮 HELPERS
// =======================
const impliedProb = (ml) =>
  ml < 0 ? (-ml) / ((-ml) + 100) : 100 / (ml + 100);

async function fetchOdds() {
  const fresh = oddsCache.data && Date.now() - oddsCache.ts < ODDS_CACHE_MS;
  if (fresh) return oddsCache.data;

  try {
    const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`;
    const res = await axios.get(url, {
      params: {
        apiKey: ODDS_API_KEY,
        regions: REGIONS,
        markets: MARKETS,
        oddsFormat: "american",
        dateFormat: "iso",
      },
    });

    if (!Array.isArray(res.data)) throw new Error("Invalid odds response");

    const now = new Date();
    const filtered = res.data.filter((g) => {
      const gameTime = new Date(g.commence_time);
      return gameTime - now > -2 * 60 * 60 * 1000 && gameTime - now < 7 * 24 * 60 * 60 * 1000;
    });

    oddsCache = { data: filtered, ts: Date.now() };
    console.log(`📊 Pulled ${filtered.length} upcoming NFL games`);
    return filtered;
  } catch (err) {
    console.error("❌ fetchOdds failed:", err.message);
    return [];
  }
}

function calculateConfidence(homeOdds, awayOdds, lineType) {
  const toProb = (odds) =>
    odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
  const diff = Math.abs(toProb(homeOdds) - toProb(awayOdds));
  if (lineType === "moneyline") return Math.round(50 + diff * 100);
  if (lineType === "spread") return Math.round(45 + diff * 90);
  if (lineType === "total") return Math.round(40 + diff * 100);
  return 55;
}

// =======================
// 🧠 AI GAME PICKS
// =======================
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
      const total = markets.find((m) => m.key === "totals");

      const homeML = h2h?.outcomes?.find((o) => o.name === home)?.price;
      const awayML = h2h?.outcomes?.find((o) => o.name === away)?.price;
      if (!homeML || !awayML) return null;

      const mlConf = calculateConfidence(homeML, awayML, "moneyline");
      const mlPick = {
        type: "moneyline",
        pick: impliedProb(homeML) > impliedProb(awayML) ? home : away,
        confidence: mlConf,
        homeML,
        awayML,
      };

      let spreadPick = null;
      const homeSpread = spread?.outcomes?.find((o) => o.name === home);
      const awaySpread = spread?.outcomes?.find((o) => o.name === away);
      if (homeSpread && awaySpread) {
        const spreadConf = calculateConfidence(
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
          confidence: spreadConf,
          line:
            Math.abs(homeSpread.point) <= Math.abs(awaySpread.point)
              ? homeSpread.point
              : awaySpread.point,
        };
      }

      let totalPick = null;
      if (total && total.outcomes?.length >= 2) {
        const over = total.outcomes.find((o) =>
          o.name.toLowerCase().includes("over")
        );
        const under = total.outcomes.find((o) =>
          o.name.toLowerCase().includes("under")
        );
        if (over && under) {
          const totConf = calculateConfidence(over.price, under.price, "total");
          totalPick = {
            type: "total",
            pick:
              Math.abs(over.price) < Math.abs(under.price)
                ? "Over"
                : "Under",
            line: over.point || under.point,
            confidence: totConf,
          };
        }
      }

      // determine recommended play
      const allPicks = [mlPick, spreadPick, totalPick].filter(Boolean);
      const recommended =
        allPicks.sort((a, b) => b.confidence - a.confidence)[0] || mlPick;

      return {
        matchup: `${away} @ ${home}`,
        bookmaker,
        mlPick,
        spreadPick,
        totalPick,
        recommendedPlay: recommended,
        commence_time: g.commence_time,
      };
    })
    .filter(Boolean);
}

// =======================
// 🏈 ROUTES
// =======================
app.get("/api/picks", async (req, res) => {
  try {
    const data = await fetchOdds();
    const picks = await generateAIGamePicks(data);
    res.json({ picks, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("❌ /api/picks error:", err.message);
    res.status(500).json({ picks: [] });
  }
});

app.get("/api/scores", async (req, res) => {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/scores`;
    const { data } = await axios.get(url, {
      params: { apiKey: ODDS_API_KEY, daysFrom: 2 },
    });
    const scores = (data || []).map((g) => ({
      id: g.id,
      start_time: g.commence_time,
      home_team: g.home_team,
      away_team: g.away_team,
      completed: g.completed,
      scores: g.scores || [],
      last_update: g.last_update,
    }));
    res.json({
      totalGames: scores.length,
      liveGames: scores.filter((g) => !g.completed).length,
      games: scores,
    });
  } catch (err) {
    console.error("❌ /api/scores error:", err.message);
    res.status(500).json({ error: "Failed to fetch scores" });
  }
});

app.get("/", (req, res) => res.send("LockBox AI v21 ✅ Pro Backend Running"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`✅ LockBox AI Backend v21 running on port ${PORT}`)
);
