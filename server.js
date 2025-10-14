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
const RESULT_LOG = "./results.json";
const HISTORY_LOG = "./ai_history.json";
const DAILY_FILE = "./today_picks.json";

// =======================
// 🧠 STATE
// =======================
let record = { wins: 0, losses: 0, winRate: 0 };
let history = [];
let todayPicks = null;
let todayDate = null;

if (fs.existsSync(RESULT_LOG))
  record = JSON.parse(fs.readFileSync(RESULT_LOG));
if (fs.existsSync(HISTORY_LOG))
  history = JSON.parse(fs.readFileSync(HISTORY_LOG));
if (fs.existsSync(DAILY_FILE)) {
  const saved = JSON.parse(fs.readFileSync(DAILY_FILE));
  todayPicks = saved.picks;
  todayDate = saved.date;
}

// =======================
// 🧮 HELPERS
// =======================
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

function getEasternDateString() {
  const date = new Date();
  const offset = -5; // EST
  const local = new Date(date.getTime() + offset * 60 * 60 * 1000);
  return local.toISOString().split("T")[0];
}

// =======================
// 🏈 FETCH ODDS (pregame only)
// =======================
async function fetchOdds() {
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
    const soonestStart = new Date(now.getTime() + 10 * 60 * 1000);
    const pregameOnly = (data || [])
      .filter((g) => new Date(g.commence_time) > soonestStart)
      .sort(
        (a, b) => new Date(a.commence_time) - new Date(b.commence_time)
      );

    console.log(`📊 Found ${pregameOnly.length} pregame NFL matchups`);
    return pregameOnly;
  } catch (err) {
    console.error("❌ fetchOdds failed:", err.message);
    return [];
  }
}

// =======================
// 🧠 AI GAME PICKS
// =======================
function generateAIGamePicks(games) {
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
        const sameSide = parseFloat(hs.point) < 0;
        const chosen = sameSide ? home : away;
        const spreadConf = calcConfidence(hs.price, as.price, "spread");
        spreadPick = { type: "spread", pick: chosen, confidence: spreadConf };
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

// =======================
// 💾 LOCK + SAVE DAILY PICKS
// =======================
async function generateAndSaveTodayPicks() {
  const games = await fetchOdds();
  const picks = generateAIGamePicks(games);

  const moneylineLock =
    picks
      ?.map((g) => g.mlPick)
      ?.filter(Boolean)
      ?.sort((a, b) => b.confidence - a.confidence)[0] || null;

  const spreadLock =
    picks
      ?.map((g) => g.spreadPick)
      ?.filter(Boolean)
      ?.sort((a, b) => b.confidence - a.confidence)[0] || null;

  const propLock = { player: "No props available", confidence: 0 };

  const featured = {
    date: getEasternDateString(),
    moneylineLock,
    spreadLock,
    propLock,
    picks,
  };

  todayDate = featured.date;
  todayPicks = featured;
  fs.writeFileSync(DAILY_FILE, JSON.stringify(featured, null, 2));
  history.unshift(featured);
  fs.writeFileSync(HISTORY_LOG, JSON.stringify(history, null, 2));
  console.log(`📆 Locked in today's picks for ${todayDate}`);
}

// =======================
// 🧾 RECORD TRACKER (auto after games end)
// =======================
async function updateRecordIfNeeded() {
  try {
    const { data } = await axios.get(
      "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/scores",
      { params: { apiKey: ODDS_API_KEY, daysFrom: 2 } }
    );

    let wins = record.wins;
    let losses = record.losses;

    (data || []).forEach((game) => {
      if (game.completed && game.scores && todayPicks?.picks) {
        const pick = todayPicks.picks.find(
          (p) =>
            p.matchup === `${game.away_team} @ ${game.home_team}`
        );
        if (pick) {
          const homeScore = parseInt(
            game.scores.find((s) => s.name === game.home_team)?.score || 0
          );
          const awayScore = parseInt(
            game.scores.find((s) => s.name === game.away_team)?.score || 0
          );
          const winner = homeScore > awayScore ? game.home_team : game.away_team;
          if (winner === pick.mlPick.pick) wins++;
          else losses++;
        }
      }
    });

    record.wins = wins;
    record.losses = losses;
    record.winRate = ((wins / (wins + losses || 1)) * 100).toFixed(1);
    fs.writeFileSync(RESULT_LOG, JSON.stringify(record, null, 2));
    console.log(`🏆 Updated record: ${wins}-${losses} (${record.winRate}%)`);
  } catch (err) {
    console.warn("Record update failed:", err.message);
  }
}

// =======================
// 🚀 ROUTES
// =======================
app.get("/api/featured", async (req, res) => {
  const currentDate = getEasternDateString();
  if (todayDate !== currentDate || !todayPicks) {
    await generateAndSaveTodayPicks();
  }
  await updateRecordIfNeeded();
  res.json(todayPicks);
});

app.get("/api/picks", async (req, res) => {
  const currentDate = getEasternDateString();
  if (todayDate !== currentDate || !todayPicks) {
    await generateAndSaveTodayPicks();
  }
  res.json(todayPicks.picks);
});

app.get("/api/record", (req, res) => res.json(record));

app.get("/api/scores", async (req, res) => {
  try {
    const { data } = await axios.get(
      "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/scores",
      { params: { apiKey: ODDS_API_KEY, daysFrom: 2 } }
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/history", (req, res) => res.json(history));
app.get("/", (req, res) =>
  res.send("LockBox AI ✅ Stable v14 — Daily Locks + Real Record Tracking")
);

// =======================
// 🖥️ START SERVER
// =======================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`✅ LockBox AI v14 running on port ${PORT}`)
);
