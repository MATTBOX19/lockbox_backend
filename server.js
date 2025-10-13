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
const SPORT = "americanfootball_nfl";
const REGIONS = "us";
const MARKETS = "h2h,spreads,totals";
const ODDS_CACHE_MS = 5 * 60 * 1000; // 5 minutes cache

let record = { wins: 0, losses: 0, winRate: 0 };
if (fs.existsSync(RESULT_LOG)) {
  record = JSON.parse(fs.readFileSync(RESULT_LOG, "utf-8"));
}

// ================================
// 📈 Utility helpers
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
  console.log(`📊 Pulled ${res.data.length} live NFL games`);
  return res.data;
}

// ================================
// 🧠 AI Pick Generator
// ================================
function generateAIPicks(games) {
  return games
    .map((g) => {
      const home = g.home_team;
      const away = g.away_team;
      const markets = g.bookmakers?.[0]?.markets || [];
      const h2h = markets.find((m) => m.key === "h2h");
      if (!h2h || !h2h.outcomes) return null;

      const homeML = h2h.outcomes.find((o) => o.name === home)?.price;
      const awayML = h2h.outcomes.find((o) => o.name === away)?.price;
      if (!homeML || !awayML) return null;

      const homeProb = impliedProb(homeML);
      const awayProb = impliedProb(awayML);
      const edge = Math.abs(homeProb - awayProb);

      const pick = homeProb > awayProb ? home : away;
      const confidence = Math.round(50 + edge * 100);
      const bookmaker = g.bookmakers?.[0]?.title || "Unknown";

      return {
        matchup: `${away} @ ${home}`,
        pick,
        confidence,
        homeML,
        awayML,
        bookmaker,
        model: confidence > 60 ? "LockBox Alpha" : "LockBox Lite",
      };
    })
    .filter(Boolean);
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

// ================================
// 🚀 API Endpoints
// ================================
app.get("/api/picks", async (req, res) => {
  try {
    const data = await fetchOdds();
    const picks = generateAIPicks(data);
    res.json({ picks });
  } catch (err) {
    console.error("❌ /api/picks error:", err.message);
    res.status(500).json({ picks: [] });
  }
});

// ✅ Simplified /api/scores
app.get("/api/scores", async (req, res) => {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/scores/?daysFrom=1&apiKey=${ODDS_API_KEY}`;
    const scores = await axios.get(url);
    res.json(scores.data);
  } catch (err) {
    console.error("❌ /api/scores error:", err.message);
    res.status(500).json([]);
  }
});

// ✅ NEW: /api/props (player props)
app.get("/api/props", async (req, res) => {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`;
    const params = {
      apiKey: ODDS_API_KEY,
      regions: REGIONS,
      markets: "player_pass_tds,player_pass_yds,player_receptions,player_rush_yds,player_rec_yds",
      oddsFormat: "american",
      dateFormat: "iso",
    };
    const { data } = await axios.get(url, { params });

    const props = [];
    data.forEach((game) => {
      const markets = game.bookmakers?.[0]?.markets || [];
      markets.forEach((m) => {
        m.outcomes?.forEach((o) => {
          props.push({
            matchup: `${game.away_team} @ ${game.home_team}`,
            player: o.name,
            market: m.key,
            price: o.price,
            point: o.point,
            bookmaker: game.bookmakers?.[0]?.title || "Unknown",
          });
        });
      });
    });

    res.json({ props });
  } catch (err) {
    console.error("❌ /api/props error:", err.message);
    res.status(500).json({ props: [] });
  }
});

// ✅ NEW: /api/featured — Pick & Prop of the Day
app.get("/api/featured", async (req, res) => {
  try {
    // Get picks
    const oddsData = await fetchOdds();
    const picks = generateAIPicks(oddsData);
    const topPick = picks.sort((a, b) => b.confidence - a.confidence)[0];

    // Get props
    const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`;
    const params = {
      apiKey: ODDS_API_KEY,
      regions: REGIONS,
      markets: "player_pass_yds,player_receptions,player_rush_yds,player_rec_yds",
      oddsFormat: "american",
      dateFormat: "iso",
    };
    const { data: propsData } = await axios.get(url, { params });
    let topProp = null;

    propsData.forEach((game) => {
      const markets = game.bookmakers?.[0]?.markets || [];
      markets.forEach((m) => {
        m.outcomes?.forEach((o) => {
          if (!topProp || Math.abs(o.price) < Math.abs(topProp.price)) {
            topProp = {
              player: o.name,
              market: m.key,
              price: o.price,
              point: o.point,
              matchup: `${game.away_team} @ ${game.home_team}`,
              bookmaker: game.bookmakers?.[0]?.title || "Unknown",
            };
          }
        });
      });
    });

    res.json({
      gamePick: topPick || {},
      propPick: topProp || {},
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ /api/featured error:", err.message);
    res.status(500).json({ gamePick: {}, propPick: {} });
  }
});

app.get("/api/record", (req, res) => res.json(record));

app.post("/api/result", (req, res) => {
  const { won } = req.body;
  updateRecord(won);
  res.json(record);
});

// 💳 Stripe Subscriptions
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: 1 },
      success_url: `${process.env.FRONTEND_URL}?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe session error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 👤 Authentication
let users = [
  { id: 1, email: "admin@lockbox.ai", password: "masterkey", role: "admin" },
];

app.post("/api/signup", (req, res) => {
  const { email, password } = req.body;
  if (users.find((u) => u.email === email))
    return res.status(400).json({ error: "Email already registered" });

  const newUser = { id: Date.now(), email, password, role: "member" };
  users.push(newUser);
  const token = generateToken(newUser);
  res.json({ token, user: newUser });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  const user = users.find((u) => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const token = generateToken(user);
  res.json({ token, user });
});

app.get("/", (req, res) => res.send("LockBox AI Backend ✅ Live"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ LockBox backend running on ${PORT}`));
