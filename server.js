import { generateToken, verifyToken } from "./auth/auth.js";
import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors());
app.use(express.json());

// ================================
// 🔐 Config
// ================================
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const RESULT_LOG = "./results.json";
const HISTORY_LOG = "./ai_history.json";
const SPORT = "americanfootball_nfl";
const REGIONS = "us";
const MARKETS = "h2h,spreads,totals";
const ODDS_CACHE_MS = 5 * 60 * 1000;

// ================================
// 🧾 Record & History
// ================================
let record = { wins: 0, losses: 0, winRate: 0 };
if (fs.existsSync(RESULT_LOG))
  record = JSON.parse(fs.readFileSync(RESULT_LOG, "utf-8"));

let history = [];
if (fs.existsSync(HISTORY_LOG))
  history = JSON.parse(fs.readFileSync(HISTORY_LOG, "utf-8"));

// ================================
// 📈 Helpers
// ================================
const impliedProb = (ml) =>
  ml < 0 ? (-ml) / ((-ml) + 100) : 100 / (ml + 100);

let oddsCache = { data: null, ts: 0 };
async function fetchOdds() {
  const fresh = oddsCache.data && Date.now() - oddsCache.ts < ODDS_CACHE_MS;
  if (fresh) return oddsCache.data;

  const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`;
  const params = {
    apiKey: ODDS_API_KEY,
    regions: REGIONS,
    markets: MARKETS,
    oddsFormat: "american",
    dateFormat: "iso",
  };
  const res = await axios.get(url, { params });
  oddsCache = { data: res.data, ts: Date.now() };
  console.log(`📊 Pulled ${res.data.length} NFL games`);
  return res.data;
}

// ================================
// 🧠 AI Picks
// ================================
async function generateAIGamePicks(games) {
  try {
    const [injuriesRes, standingsRes] = await Promise.all([
      axios
        .get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries")
        .catch(() => ({ data: {} })),
      axios
        .get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/standings")
        .catch(() => ({ data: {} })),
    ]);
    const injuriesData = injuriesRes.data?.sports?.[0]?.leagues?.[0]?.teams || [];
    const standings = standingsRes.data?.children?.[0]?.standings?.entries || [];

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
        const homeSpread = spread?.outcomes?.find((o) => o.name === home);
        const awaySpread = spread?.outcomes?.find((o) => o.name === away);

        if (!homeML || !awayML) return null;

        const homeProb = impliedProb(homeML);
        const awayProb = impliedProb(awayML);
        const edge = Math.abs(homeProb - awayProb);

        const homeTeamStats = standings.find((t) =>
          t.team.displayName?.toLowerCase().includes(home.toLowerCase())
        );
        const awayTeamStats = standings.find((t) =>
          t.team.displayName?.toLowerCase().includes(away.toLowerCase())
        );
        const homeWinPct = homeTeamStats?.stats?.find((s) => s.name === "winpercent")?.value || 0.5;
        const awayWinPct = awayTeamStats?.stats?.find((s) => s.name === "winpercent")?.value || 0.5;

        const injuredTeams = injuriesData.filter((t) =>
          [home, away].some((n) =>
            t.team.displayName?.toLowerCase().includes(n.toLowerCase())
          )
        );
        const injuryAdj = Math.max(-0.1, -0.02 * injuredTeams.length);

        const baseConfidence = 55 + edge * 70;
        const formAdj = (homeWinPct - awayWinPct) * 15;
        const confidence = Math.max(
          55,
          Math.min(95, baseConfidence + formAdj + injuryAdj * 100)
        );
        const pick = homeProb > awayProb ? home : away;
        const marketImplied = Math.max(homeProb, awayProb);
        const edgeValue = Math.round((confidence / 100 - marketImplied) * 100);

        let spreadPick = null;
        if (homeSpread && awaySpread) {
          const priceEdge = Math.abs(homeSpread.price - awaySpread.price) / 100;
          const pointEdge = Math.abs(homeSpread.point - awaySpread.point);
          const spreadConf = Math.min(
            95,
            55 + edge * 60 + priceEdge * 8 + pointEdge * 3
          );
          spreadPick = {
            type: "spread",
            pick:
              Math.abs(homeSpread.price) < Math.abs(awaySpread.price)
                ? home
                : away,
            confidence: spreadConf,
            homeSpread,
            awaySpread,
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
            edgeValue,
          },
          spreadPick,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error("❌ AI Model error:", err.message);
    return [];
  }
}

// ================================
// 🧩 Prop Picks
// ================================
async function generateAIPropPicks() {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`;
    const params = {
      apiKey: ODDS_API_KEY,
      regions: REGIONS,
      markets:
        "player_pass_yds,player_rush_yds,player_rec_yds,player_receptions",
      oddsFormat: "american",
      dateFormat: "iso",
    };
    const { data } = await axios.get(url, { params });
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
            bookmaker: game.bookmakers?.[0]?.title || "Unknown",
          });
        });
      });
    });
    return props;
  } catch (err) {
    console.warn("⚠️ No prop data available.");
    return [];
  }
}

// ================================
// 🧾 Record Tracking
// ================================
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

// ================================
// 🚀 API Routes
// ================================

// ✅ Fix: Always return fresh picks
app.get("/api/picks", async (req, res) => {
  try {
    const data = await fetchOdds();
    const picks = await generateAIGamePicks(data);
    if (!picks || picks.length === 0) {
      console.warn("⚠️ No AI game picks available");
      return res.status(200).json({ picks: [] });
    }
    res.json({ picks });
  } catch (err) {
    console.error("❌ /api/picks error:", err.message);
    res.status(500).json({ picks: [] });
  }
});

// ✅ Fix: Return locks + picks combo
app.get("/api/featured", async (req, res) => {
  try {
    const games = await fetchOdds();
    const gamePicks = await generateAIGamePicks(games);
    const props = await generateAIPropPicks();

    if (!gamePicks || gamePicks.length === 0) {
      return res.status(200).json({
        moneylineLock: null,
        spreadLock: null,
        propLock: { player: "No props available", confidence: 0 },
        picks: [],
      });
    }

    const moneylineLock = gamePicks
      .map((g) => g.mlPick)
      .filter(Boolean)
      .sort((a, b) => b.confidence - a.confidence)[0];
    const spreadLock = gamePicks
      .map((g) => g.spreadPick)
      .filter(Boolean)
      .sort((a, b) => b.confidence - a.confidence)[0];
    const propLock =
      props.length > 0
        ? props.sort((a, b) => b.confidence - a.confidence)[0]
        : { player: "No props available", confidence: 0 };

    const featured = {
      moneylineLock,
      spreadLock,
      propLock,
      picks: gamePicks,
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

app.get("/api/history", (req, res) => res.json(history));

app.get("/api/refresh-record", async (req, res) => {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/scores/?daysFrom=2&apiKey=${ODDS_API_KEY}`;
    const { data } = await axios.get(url);
    const completed = data.filter((g) => g.completed);

    let updated = 0;
    history.forEach((h) => {
      if (h.checked) return;
      const game = completed.find((g) =>
        g.home_team.includes(h.moneylineLock?.pick) ||
        g.away_team.includes(h.moneylineLock?.pick)
      );
      if (game) {
        const winner = game.scores.find(
          (s) => s.score === Math.max(...game.scores.map((sc) => sc.score))
        )?.name;
        const won = winner === h.moneylineLock?.pick;
        updateRecord(won);
        h.result = won ? "✅ WIN" : "❌ LOSS";
        h.checked = true;
        updated++;
      }
    });
    fs.writeFileSync(HISTORY_LOG, JSON.stringify(history, null, 2));
    res.json({ updated, record });
  } catch (err) {
    console.error("❌ /api/refresh-record error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/record", (req, res) => res.json(record));

app.get("/", (req, res) => res.send("LockBox AI v4 ✅ Live with Record Tracking"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ LockBox AI v4 running on ${PORT}`));
