import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();
const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
// 🧠 HELPERS
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

function getEasternDateString(date = new Date()) {
  const offset = -5;
  const local = new Date(date.getTime() + offset * 60 * 60 * 1000);
  return local.toISOString().split("T")[0];
}

// =======================
// 🏈 FETCH ACTIVE GAMES
// =======================
async function fetchActiveNFLGames() {
  try {
    const { data: scores } = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${SPORT}/scores`,
      {
        params: { apiKey: ODDS_API_KEY, daysFrom: 1 },
      }
    );

    const now = new Date();
    const todayEST = getEasternDateString(now);

    const activeGames = scores.filter((g) => {
      const gameDate = getEasternDateString(new Date(g.commence_time));
      return gameDate === todayEST && (!g.completed || !g.scores);
    });

    console.log(`🏈 Found ${activeGames.length} active NFL games`);

    if (!activeGames.length) return [];

    // Get odds only for these active games
    const { data: odds } = await axios.get(
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

    const filteredOdds = odds.filter((o) =>
      activeGames.some(
        (a) =>
          a.home_team === o.home_team &&
          a.away_team === o.away_team
      )
    );

    console.log(`📊 Pulled odds for ${filteredOdds.length} active games`);
    return filteredOdds;
  } catch (err) {
    console.error("❌ fetchActiveNFLGames failed:", err.message);
    return [];
  }
}

// =======================
// 🤖 AI PICK LOGIC
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
        const spreadConf = calcConfidence(hs.price, as.price, "spread");
        const chosen =
          Math.abs(hs.point) <= Math.abs(as.point) ? home : away;
        spreadPick = { pick: chosen, confidence: spreadConf };
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
// 🧮 RECORD TRACKER
// =======================
async function updateRecord() {
  try {
    const { data } = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${SPORT}/scores`,
      { params: { apiKey: ODDS_API_KEY, daysFrom: 3 } }
    );

    let wins = record.wins;
    let losses = record.losses;

    (data || []).forEach((game) => {
      if (game.completed && game.scores && todayPicks?.picks) {
        const pick = todayPicks.picks.find(
          (p) => p.matchup === `${game.away_team} @ ${game.home_team}`
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
    console.warn("⚠️ Record update failed:", err.message);
  }
}

// =======================
// 🎯 FEATURED PICKS (LOCKBOX)
// =======================
async function generateAndSaveTodayPicks() {
  const games = await fetchActiveNFLGames();
  if (!games.length) {
    console.log("⚠️ No active games — skipping lock-in.");
    return null;
  }

  const picks = generateAIGamePicks(games);
  const moneylineLock = picks.sort(
    (a, b) => b.mlPick.confidence - a.mlPick.confidence
  )[0].mlPick;
  const spreadLock = picks
    .filter((p) => p.spreadPick)
    .sort((a, b) => b.spreadPick.confidence - a.spreadPick.confidence)[0]
    .spreadPick;

  const featured = {
    date: getEasternDateString(),
    moneylineLock,
    spreadLock,
    propLock: { player: "No props available", confidence: 0 },
    picks,
  };

  todayDate = featured.date;
  todayPicks = featured;
  fs.writeFileSync(DAILY_FILE, JSON.stringify(featured, null, 2));
  history.unshift(featured);
  fs.writeFileSync(HISTORY_LOG, JSON.stringify(history, null, 2));
  console.log(`📆 Locked in picks for ${todayDate}`);
  return featured;
}

// =======================
// 🚀 ROUTES
// =======================
app.get("/api/featured", async (req, res) => {
  const currentDate = getEasternDateString();
  if (todayDate !== currentDate || !todayPicks) {
    await generateAndSaveTodayPicks();
  }
  await updateRecord();
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

app.get("/", (req, res) =>
  res.send("✅ LockBox AI v17 — Active Games + Live Record Tracker")
);

// =======================
// 🖥️ START SERVER
// =======================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`✅ LockBox AI v17 running on port ${PORT}`)
);
