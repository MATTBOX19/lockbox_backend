import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();
const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

// Load saved files safely
if (fs.existsSync(RESULT_LOG)) {
  try { record = JSON.parse(fs.readFileSync(RESULT_LOG)); } catch {}
}
if (fs.existsSync(HISTORY_LOG)) {
  try { history = JSON.parse(fs.readFileSync(HISTORY_LOG)); } catch {}
}
if (fs.existsSync(DAILY_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DAILY_FILE));
    todayPicks = saved.picks;
    todayDate = saved.date;
  } catch {}
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

function getEasternDateString(date = new Date()) {
  const offset = -5;
  const local = new Date(date.getTime() + offset * 60 * 60 * 1000);
  return local.toISOString().split("T")[0];
}

// =======================
// 🏈 FETCH UPCOMING GAMES
// =======================
async function fetchPreGameNFL() {
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
    const soonGames = (data || []).filter((g) => {
      const kickoff = new Date(g.commence_time);
      return kickoff > now && (kickoff - now) / 1000 / 60 < 60 * 24;
    });

    console.log(`🏈 Found ${soonGames.length} upcoming NFL games`);
    return soonGames;
  } catch (err) {
    console.error("❌ fetchPreGameNFL failed:", err.message);
    return [];
  }
}

// =======================
// 🧠 AI PICKS
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
    if (!todayPicks || !todayPicks.length) return;

    const { data } = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${SPORT}/scores`,
      { params: { apiKey: ODDS_API_KEY, daysFrom: 3 } }
    );

    let wins = 0;
    let losses = 0;

    (data || []).forEach((game) => {
      if (game.completed && game.scores) {
        const pick = todayPicks.find(
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
    console.log(`🏆 Record updated: ${wins}-${losses} (${record.winRate}%)`);
  } catch (err) {
    console.warn("⚠️ Record update failed:", err.message);
  }
}

// =======================
// 📅 LOCK IN DAILY PICKS
// =======================
async function lockInTodayPicks() {
  const currentDate = getEasternDateString();
  if (todayDate === currentDate && todayPicks?.length) return todayPicks;

  const games = await fetchPreGameNFL();
  if (!games.length) {
    console.log("⚠️ No upcoming games found for today.");
    return [];
  }

  const picks = generateAIGamePicks(games);

  const featured = {
    date: currentDate,
    moneylineLock: picks.sort((a, b) => b.mlPick.confidence - a.mlPick.confidence)[0].mlPick,
    spreadLock: picks
      .filter((p) => p.spreadPick)
      .sort((a, b) => b.spreadPick.confidence - a.spreadPick.confidence)[0]
      ?.spreadPick,
    propLock: { player: "No props available", confidence: 0 },
    picks,
  };

  todayDate = currentDate;
  todayPicks = picks;
  fs.writeFileSync(DAILY_FILE, JSON.stringify({ date: currentDate, picks }, null, 2));
  history.unshift(featured);
  fs.writeFileSync(HISTORY_LOG, JSON.stringify(history, null, 2));
  console.log(`✅ Locked in ${picks.length} games for ${currentDate}`);
  return featured;
}

// =======================
// 🚀 ROUTES
// =======================
app.get("/api/featured", async (req, res) => {
  try {
    const data = await lockInTodayPicks();
    await updateRecord();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/record", (req, res) => res.json(record));

app.get("/", (req, res) =>
  res.send("✅ LockBox AI v19 — Stable pre-game locks + live record tracking")
);

// =======================
// 🖥️ START SERVER
// =======================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`✅ LockBox AI v19 running on port ${PORT}`)
);
