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
// 🧩 DEBUG ROUTES
// =======================
app.get("/api/debug/env", (req, res) => {
  res.json({
    hasODDS_API_KEY: !!process.env.ODDS_API_KEY,
    ODDS_REGIONS: process.env.ODDS_REGIONS || "not set",
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? "✅ set" : "❌ missing",
  });
});

app.get("/api/debug/props-raw", async (req, res) => {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds`;
    const params = {
      apiKey: process.env.ODDS_API_KEY,
      regions: "us",
      markets: "h2h,spreads,totals",
      oddsFormat: "american",
      dateFormat: "iso",
    };

    const { data } = await axios.get(url, { params });
    res.json({
      totalGames: data?.length || 0,
      sample: (data || []).slice(0, 3).map((g) => ({
        matchup: `${g.away_team} @ ${g.home_team}`,
        bookmaker: g.bookmakers?.[0]?.title || "none",
        commence_time: g.commence_time,
      })),
    });
  } catch (err) {
    console.error("props-raw failed:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// =======================
// ⚙️ CONFIG
// =======================
const SPORT = "americanfootball_nfl";
const REGIONS = "us";
const MARKETS = "h2h,spreads,totals";
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

/**
 * Fetch odds and keep ONLY pre-game markets.
 * We explicitly drop anything whose commence_time <= now
 * so no in-progress/live lines can influence picks.
 */
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

    // ✅ Only keep games that have NOT started yet
    const pregameOnly = res.data.filter((g) => new Date(g.commence_time) > now);

    // Sort upcoming by start time (soonest first)
    pregameOnly.sort(
      (a, b) => new Date(a.commence_time) - new Date(b.commence_time)
    );

    oddsCache = { data: pregameOnly, ts: Date.now() };
    console.log(`📊 Pulled ${pregameOnly.length} NFL pre-game matchups`);
    return pregameOnly;
  } catch (err) {
    console.error("❌ fetchOdds failed:", err.message);
    return [];
  }
}

function calculateConfidence(homeOdds, awayOdds, lineType) {
  const toProb = (odds) =>
    odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);

  const homeProb = toProb(homeOdds);
  const awayProb = toProb(awayOdds);
  const diff = Math.abs(homeProb - awayProb);

  if (lineType === "moneyline") return Math.round(50 + diff * 100);
  if (lineType === "spread") return Math.round(45 + diff * 80);
  return Math.round(50 + Math.random() * 25);
}

/**
 * ML + ATS logic with alignment:
 * - Choose ML favorite via implied probability.
 * - For spread, prefer the same side when the favorite has a negative line
 *   (or the dog has the positive line). If a book flips presentation,
 *   we still anchor to favorite vs dog based on ML and compare their lines.
 */
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
      const mlPickTeam =
        impliedProb(homeML) > impliedProb(awayML) ? home : away;

      const mlPick = {
        type: "moneyline",
        pick: mlPickTeam,
        confidence: mlConfidence,
        homeML,
        awayML,
      };

      let spreadPick = null;

      const homeSpread = spread?.outcomes?.find((o) => o.name === home);
      const awaySpread = spread?.outcomes?.find((o) => o.name === away);

      if (homeSpread && awaySpread) {
        const homeLine = parseFloat(homeSpread.point);
        const awayLine = parseFloat(awaySpread.point);
        const homePrice = homeSpread.price;
        const awayPrice = awaySpread.price;

        // Define favorite/underdog by ML, then align with ATS direction
        const favorite = mlPickTeam;
        const underdog = favorite === home ? away : home;

        const favoriteLine = favorite === home ? homeLine : awayLine;
        const underdogLine = favorite === home ? awayLine : homeLine;

        // If favorite has a negative spread, that aligns. If not, prefer dog.
        const sameSide =
          (favorite === home && favoriteLine < 0) ||
          (favorite === away && favoriteLine < 0);

        const chosenTeam = sameSide ? favorite : underdog;
        const spreadConfidence = calculateConfidence(
          homePrice,
          awayPrice,
          "spread"
        );

        spreadPick = {
          type: "spread",
          pick: chosenTeam,
          confidence: spreadConfidence,
          homeLine,
          awayLine,
          homePrice,
          awayPrice,
        };
      }

      return {
        matchup: `${away} @ ${home}`,
        bookmaker,
        mlPick,
        spreadPick,
      };
    })
    .filter(Boolean);
}

// =======================
// 🧩 PROP PICKS (Safe Fallback)
// =======================
async function generateAIPropPicks() {
  try {
    console.warn("⚠️ No prop data available on this plan.");
    return [];
  } catch {
    return [];
  }
}

app.get("/api/props", async (req, res) => {
  try {
    const props = await generateAIPropPicks();
    if (!props.length) {
      return res.json({
        message: "No prop data available on your current plan.",
        props: [],
      });
    }
    res.json({ props });
  } catch (err) {
    console.error("❌ /api/props error:", err.message);
    res.status(500).json({
      message: "No prop data available.",
      props: [],
    });
  }
});

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

function saveHistory(entry) {
  history.unshift(entry);
  fs.writeFileSync(HISTORY_LOG, JSON.stringify(history, null, 2));
}

// =======================
// 🏈 LIVE SCORES ENDPOINT
// =======================
app.get("/api/scores", async (req, res) => {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/scores`;
    const params = {
      apiKey: process.env.ODDS_API_KEY,
      daysFrom: 2, // live + recent
    };

    const { data } = await axios.get(url, { params });

    const scores = (data || []).map((g) => ({
      id: g.id,
      sport_key: g.sport_key,
      start_time: g.commence_time,
      home_team: g.home_team,
      away_team: g.away_team,
      completed: g.completed,
      scores: g.scores || [],
      last_update: g.last_update,
    }));

    console.log(`🏈 Returned ${scores.length} NFL games (live + recent)`);

    res.json({
      totalGames: scores.length,
      liveGames: scores.filter((g) => !g.completed).length,
      games: scores,
    });
  } catch (err) {
    console.error("❌ /api/scores error:", err.response?.data || err.message);
    res.status(500).json({
      error: "Failed to fetch scores.",
      details: err.response?.data || err.message,
    });
  }
});

// =======================
// 🚀 ROUTES
// =======================
app.get("/api/picks", async (req, res) => {
  try {
    const data = await fetchOdds();
    const picks = await generateAIGamePicks(data);
    res.json({ picks });
  } catch (err) {
    console.error("❌ /api/picks error:", err.message);
    res.status(500).json({ picks: [] });
  }
});

app.get("/api/featured", async (req, res) => {
  try {
    const games = await fetchOdds();
    const gamePicks = await generateAIGamePicks(games);
    const props = await generateAIPropPicks();

    const moneylineLock =
      gamePicks?.map((g) => g.mlPick)?.filter(Boolean)
        ?.sort((a, b) => b.confidence - a.confidence)[0] || null;

    const spreadLock =
      gamePicks?.map((g) => g.spreadPick)?.filter(Boolean)
        ?.sort((a, b) => b.confidence - a.confidence)[0] || null;

    const propLock =
      props.length > 0
        ? props.sort((a, b) => b.confidence - a.confidence)[0]
        : { player: "No props available", confidence: 0 };

    const featured = {
      moneylineLock,
      spreadLock,
      propLock,
      picks: gamePicks || [],
      generatedAt: new Date().toISOString(),
    };

    saveHistory(featured);
    res.json(featured);
  } catch (err) {
    console.error("❌ /api/featured error:", err.message);
    res.status(500).json({
      moneylineLock: null,
      spreadLock: null,
      propLock: { player: "No props available", confidence: 0 },
    });
  }
});

app.get("/api/record", (req, res) => res.json(record));
app.get("/api/history", (req, res) => res.json(history));
app.get("/", (req, res) => res.send("LockBox AI ✅ Stable v12 (pregame only)"));

// =======================
// 🖥️ START SERVER
// =======================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`✅ LockBox AI v12 running on port ${PORT}`)
);
