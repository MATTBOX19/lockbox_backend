import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors());
app.use(express.json());

// ==================================
// ⚙️ Config
// ==================================
const SPORT = "americanfootball_nfl";
const REGIONS = "us";
const MARKETS = "h2h,spreads,totals";
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_CACHE_MS = 5 * 60 * 1000;
const RESULT_LOG = "./results.json";
const HISTORY_LOG = "./ai_history.json";

// ==================================
// 📊 Data Caches
// ==================================
let oddsCache = { data: null, ts: 0 };
let record = { wins: 0, losses: 0, winRate: 0 };
let history = [];

if (fs.existsSync(RESULT_LOG)) record = JSON.parse(fs.readFileSync(RESULT_LOG));
if (fs.existsSync(HISTORY_LOG)) history = JSON.parse(fs.readFileSync(HISTORY_LOG));

// ==================================
// 🧮 Helpers
// ==================================
const impliedProb = (ml) => (ml < 0 ? (-ml) / ((-ml) + 100) : 100 / (ml + 100));

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
    oddsCache = { data: res.data, ts: Date.now() };
    console.log(`📊 Pulled ${res.data.length} NFL games`);
    return res.data;
  } catch (err) {
    console.error("❌ fetchOdds failed:", err.message);
    return [];
  }
}

// ==================================
// 🧠 AI Game Picks
// ==================================
async function generateAIGamePicks(games) {
  if (!Array.isArray(games)) return [];

  return games.map((g) => {
    const home = g.home_team;
    const away = g.away_team;
    const bookmaker = g.bookmakers?.[0]?.title || "Unknown";
    const markets = g.bookmakers?.[0]?.markets || [];

    const h2h = markets.find((m) => m.key === "h2h");
    const spread = markets.find((m) => m.key === "spreads");

    const homeML = h2h?.outcomes?.find((o) => o.name === home)?.price;
    const awayML = h2h?.outcomes?.find((o) => o.name === away)?.price;

    if (!homeML || !awayML) return null;

    const homeProb = impliedProb(homeML);
    const awayProb = impliedProb(awayML);
    const edge = Math.abs(homeProb - awayProb);

    const baseConfidence = 55 + edge * 70;
    const confidence = Math.min(95, Math.max(55, baseConfidence));

    const pick = homeProb > awayProb ? home : away;

    const homeSpread = spread?.outcomes?.find((o) => o.name === home);
    const awaySpread = spread?.outcomes?.find((o) => o.name === away);

    let spreadPick = null;
    if (homeSpread && awaySpread) {
      const priceEdge = Math.abs(homeSpread.price - awaySpread.price) / 100;
      const pointEdge = Math.abs(homeSpread.point - awaySpread.point);
      const spreadConf = Math.min(95, 55 + edge * 60 + priceEdge * 8 + pointEdge * 3);
      spreadPick = {
        type: "spread",
        pick: Math.abs(homeSpread.price) < Math.abs(awaySpread.price) ? home : away,
        confidence: Math.round(spreadConf),
      };
    }

    return {
      matchup: `${away} @ ${home}`,
      bookmaker,
      mlPick: {
        type: "moneyline",
        pick,
        confidence: Math.round(confidence),
        homeML,
        awayML,
      },
      spreadPick,
    };
  }).filter(Boolean);
}

// ==================================
// 🧩 Prop Picks
// ==================================
async function generateAIPropPicks() {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`;
    const { data } = await axios.get(url, {
      params: {
        apiKey: ODDS_API_KEY,
        regions: REGIONS,
        markets: "player_pass_yds,player_rush_yds,player_rec_yds,player_receptions",
        oddsFormat: "american",
        dateFormat: "iso",
      },
    });

    if (!Array.isArray(data)) return [];

    const props = [];
    data.forEach((game) => {
      const markets = game.bookmakers?.[0]?.markets || [];
      markets.forEach((m) => {
        m.outcomes?.forEach((o) => {
          const confidence = Math.max(50, 100 - Math.abs(o.price) / 10);
          props.push({
            matchup: `${game.away_team} @ ${game.home_team}`,
            player: o.name,
            market: m.key,
            price: o.price,
            point: o.point,
            confidence,
          });
        });
      });
    });

    return props;
  } catch {
    console.warn("⚠️ No prop data available.");
    return [];
  }
}

// ==================================
// 📈 Record Tracking
// ==================================
function updateRecord(win) {
  if (win) record.wins++;
  else record.losses++;
  record.winRate = ((record.wins / (record.wins + record.losses)) * 100).toFixed(1);
  fs.writeFileSync(RESULT_LOG, JSON.stringify(record, null, 2));
}

function saveHistory(entry) {
  history.unshift(entry);
  fs.writeFileSync(HISTORY_LOG, JSON.stringify(history, null, 2));
}

// ==================================
// 🚀 Routes
// ==================================
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

    const moneylineLock = gamePicks?.map((g) => g.mlPick)
      ?.filter(Boolean)
      ?.sort((a, b) => b.confidence - a.confidence)[0] || null;

    const spreadLock = gamePicks?.map((g) => g.spreadPick)
      ?.filter(Boolean)
      ?.sort((a, b) => b.confidence - a.confidence)[0] || null;

    const propLock = props.length > 0
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
app.get("/", (req, res) => res.send("LockBox AI v7 ✅ Stable release"));

// ==================================
// 🖥️ Start Server
// ==================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ LockBox AI v7 running on port ${PORT}`));
