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
const ODDS_CACHE_MS = 5 * 60 * 1000; // 5 min cache

let record = { wins: 0, losses: 0, winRate: 0 };
if (fs.existsSync(RESULT_LOG)) {
  record = JSON.parse(fs.readFileSync(RESULT_LOG, "utf-8"));
}

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
// 🧠 Enhanced LockBox AI Model v2 (Stable)
// ================================
async function generateAIGamePicks(games) {
  try {
    // Safely load context (ESPN only, no breaking external calls)
    let injuriesData = { sports: [] };
    try {
      const injuryRes = await axios.get(
        "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries"
      );
      injuriesData = injuryRes.data || { sports: [] };
    } catch {
      console.warn("⚠️ Injury feed unavailable.");
    }

    return games
      .map((g) => {
        const home = g.home_team;
        const away = g.away_team;
        const bookmaker = g.bookmakers?.[0]?.title || "Unknown";
        const markets = g.bookmakers?.[0]?.markets || [];

        // --- MONEYLINE
        const h2h = markets.find((m) => m.key === "h2h");
        const homeML = h2h?.outcomes?.find((o) => o.name === home)?.price;
        const awayML = h2h?.outcomes?.find((o) => o.name === away)?.price;

        // --- SPREAD
        const spread = markets.find((m) => m.key === "spreads");
        const homeSpread = spread?.outcomes?.find((o) => o.name === home);
        const awaySpread = spread?.outcomes?.find((o) => o.name === away);

        if (!homeML || !awayML) return null;

        // --- Base implied probability
        const homeProb = impliedProb(homeML);
        const awayProb = impliedProb(awayML);
        const edge = Math.abs(homeProb - awayProb);

        // --- Injury adjustment (safe)
        const teamInjuries =
          injuriesData.sports?.[0]?.leagues?.[0]?.teams?.filter((t) =>
            [home, away].some((n) =>
              t.team.displayName?.toLowerCase()?.includes(n.toLowerCase())
            )
          ) || [];
        const injuryAdj = Math.max(-0.05, -0.01 * teamInjuries.length);

        // --- Confidence models
        const mlConfidence = Math.round(
          55 + edge * 80 + injuryAdj * 100
        );
        const pick = homeProb > awayProb ? home : away;

        let spreadConfidence = 60;
        if (homeSpread && awaySpread) {
          const priceEdge =
            Math.abs(homeSpread.price - awaySpread.price) / 100;
          const pointEdge = Math.abs(homeSpread.point - awaySpread.point);
          spreadConfidence = Math.min(
            95,
            55 + edge * 70 + priceEdge * 10 + pointEdge * 3
          );
        }

        return {
          matchup: `${away} @ ${home}`,
          bookmaker,
          mlPick: {
            type: "moneyline",
            pick,
            confidence: Math.max(55, Math.min(mlConfidence, 95)),
            homeML,
            awayML,
          },
          spreadPick:
            homeSpread && awaySpread
              ? {
                  type: "spread",
                  pick:
                    Math.abs(homeSpread.price) < Math.abs(awaySpread.price)
                      ? home
                      : away,
                  confidence: spreadConfidence.toFixed(1),
                  homeSpread,
                  awaySpread,
                }
              : null,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error("❌ Enhanced AI model error:", err.message);
    return [];
  }
}

// ================================
// 🧩 AI Player Prop Picks
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
          const confidence = Math.max(
            50,
            100 - Math.abs(o.price) / 10
          );
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

    console.log(`🎯 Generated ${props.length} prop picks`);
    return props;
  } catch (err) {
    if (err.response?.status === 422) {
      console.warn("⚠️ No prop data available right now.");
      return [];
    }
    console.error("❌ generateAIPropPicks error:", err.message);
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

// ================================
// 🚀 API Endpoints
// ================================
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

app.get("/api/props", async (req, res) => {
  try {
    const props = await generateAIPropPicks();
    res.json({ props });
  } catch (err) {
    console.error("❌ /api/props error:", err.message);
    res.status(500).json({ props: [] });
  }
});

// ✅ Full LockBox Featured — Moneyline, Spread, and Prop Locks
app.get("/api/featured", async (req, res) => {
  try {
    const games = await fetchOdds();
    const gamePicks = await generateAIGamePicks(games);
    const props = await generateAIPropPicks();

    const allML = gamePicks
      .map((g) => g.mlPick)
      .filter(Boolean)
      .sort((a, b) => b.confidence - a.confidence);
    const moneylineLock = allML[0] || null;

    const allSpreads = gamePicks
      .map((g) => g.spreadPick)
      .filter(Boolean)
      .sort((a, b) => b.confidence - a.confidence);
    const spreadLock = allSpreads[0] || null;

    const propLock =
      props.length > 0
        ? props.sort((a, b) => b.confidence - a.confidence)[0]
        : {
            player: "No props available",
            market: "N/A",
            confidence: 0,
            bookmaker: "N/A",
          };

    res.json({
      moneylineLock,
      spreadLock,
      propLock,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ /api/featured error:", err.message);
    res.status(500).json({
      moneylineLock: null,
      spreadLock: null,
      propLock: null,
    });
  }
});

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

app.get("/api/record", (req, res) => res.json(record));

app.post("/api/result", (req, res) => {
  const { won } = req.body;
  updateRecord(won);
  res.json(record);
});

// 💳 Stripe Checkout
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

// 👤 Auth
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
