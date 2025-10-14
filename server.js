import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();

// =======================
// ⚙️ MIDDLEWARE
// =======================
app.use(
  cors({
    origin: ["https://lockbox-frontend.onrender.com", "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true,
  })
);
app.use(express.json());

// =======================
// ⚙️ CONFIG
// =======================
const SPORTS = {
  nfl: "americanfootball_nfl",
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
  ncaaf: "americanfootball_ncaaf",
};

const REGIONS = "us";
const MARKETS = "h2h,spreads,totals";
const ODDS_API_KEY = process.env.ODDS_API_KEY;

// =======================
// 🧮 HELPERS
// =======================
const impliedProb = (ml) =>
  ml < 0 ? (-ml) / ((-ml) + 100) : 100 / (ml + 100);

function calculateConfidence(homeOdds, awayOdds) {
  const toProb = (odds) =>
    odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);

  const homeProb = toProb(homeOdds);
  const awayProb = toProb(awayOdds);
  const diff = Math.abs(homeProb - awayProb);
  return Math.round(50 + diff * 100);
}

function selectBestPick(moneyline, spread) {
  const mlConf = moneyline?.confidence || 0;
  const spConf = spread?.confidence || 0;
  const margin = 3; // spread must beat ML by 3 pts minimum

  if (spConf > mlConf + margin) {
    return { type: "Spread", pick: spread.pick, confidence: spConf };
  }
  return { type: "Moneyline", pick: moneyline.pick, confidence: mlConf };
}

// =======================
// 🧠 AI PICK GENERATOR
// =======================
async function fetchOdds(sportKey) {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`;
    const res = await axios.get(url, {
      params: {
        apiKey: ODDS_API_KEY,
        regions: REGIONS,
        markets: MARKETS,
        oddsFormat: "american",
        dateFormat: "iso",
      },
    });

    const games = Array.isArray(res.data) ? res.data : [];
    console.log(`📊 Pulled ${games.length} games for ${sportKey}`);
    return games;
  } catch (err) {
    console.error(`❌ fetchOdds failed for ${sportKey}:`, err.message);
    return [];
  }
}

function generateAIPicks(games) {
  return games
    .map((g) => {
      const home = g.home_team;
      const away = g.away_team;
      const bookmaker = g.bookmakers?.[0]?.title || "Unknown";
      const markets = g.bookmakers?.[0]?.markets || [];
      const h2h = markets.find((m) => m.key === "h2h");
      const spread = markets.find((m) => m.key === "spreads");

      // skip invalid games
      if (!h2h || !h2h.outcomes) return null;

      // MONEYLINE logic
      const homeML = h2h.outcomes.find((o) => o.name === home)?.price;
      const awayML = h2h.outcomes.find((o) => o.name === away)?.price;
      if (!homeML || !awayML) return null;

      const mlConfidence = calculateConfidence(homeML, awayML);
      const mlPick =
        impliedProb(homeML) > impliedProb(awayML) ? home : away;

      // SPREAD logic with discount (so it's not always higher)
      let spreadPick = null;
      let spreadConfidence = 0;

      if (spread && spread.outcomes) {
        const homeSpread = spread.outcomes.find((o) => o.name === home);
        const awaySpread = spread.outcomes.find((o) => o.name === away);

        if (homeSpread && awaySpread) {
          spreadConfidence =
            Math.max(
              calculateConfidence(homeSpread.price, awaySpread.price) - 10,
              40
            ); // reduce spread confidence realism
          spreadPick =
            Math.abs(homeSpread.price) < Math.abs(awaySpread.price)
              ? home
              : away;
        }
      }

      const moneyline = { pick: mlPick, confidence: mlConfidence };
      const spreadObj = {
        pick: spreadPick || "N/A",
        confidence: spreadConfidence,
      };

      const best = selectBestPick(moneyline, spreadObj);

      return {
        matchup: `${away} @ ${home}`,
        bookmaker,
        moneyline,
        spread: spreadObj,
        bestPick: best,
      };
    })
    .filter(Boolean);
}

// =======================
// 🏈 API ROUTES
// =======================
app.get("/api/picks/:sport", async (req, res) => {
  const sportParam = req.params.sport.toLowerCase();
  const sportKey = SPORTS[sportParam];
  if (!sportKey)
    return res.status(400).json({ error: "Invalid sport key provided." });

  try {
    const games = await fetchOdds(sportKey);
    const picks = generateAIPicks(games);
    res.json({ sport: sportParam.toUpperCase(), picks });
  } catch (err) {
    console.error("❌ /api/picks error:", err.message);
    res.status(500).json({ error: "Failed to fetch AI picks." });
  }
});

// SCORES
app.get("/api/scores", async (req, res) => {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/scores`;
    const { data } = await axios.get(url, {
      params: { apiKey: ODDS_API_KEY, daysFrom: 2 },
    });
    const scores = (data || []).map((g) => ({
      id: g.id,
      home_team: g.home_team,
      away_team: g.away_team,
      completed: g.completed,
      scores: g.scores || [],
    }));
    res.json({ totalGames: scores.length, games: scores });
  } catch (err) {
    console.error("❌ /api/scores error:", err.message);
    res.status(500).json({ error: "Failed to fetch scores." });
  }
});

// HEALTH CHECK
app.get("/", (req, res) =>
  res.send("🏈 LockBox AI v23 — Multi-Sport Backend with Balanced Confidence Active")
);

// =======================
// 🚀 START SERVER
// =======================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`✅ LockBox AI v23 running on port ${PORT}`)
);
