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

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const RESULT_LOG = "./results.json";
let record = { wins: 0, losses: 0, winRate: 0 };

// ✅ Load record from file if available
if (fs.existsSync(RESULT_LOG)) {
  record = JSON.parse(fs.readFileSync(RESULT_LOG, "utf-8"));
}

// ✅ Utility: implied probability
const impliedProb = (ml) =>
  ml < 0 ? (-ml) / ((-ml) + 100) : 100 / (ml + 100);

// ✅ Cache to avoid API overuse
const CACHE = { data: null, lastFetch: 0 };

async function getOdds() {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  if (CACHE.data && Date.now() - CACHE.lastFetch < FOUR_HOURS)
    return CACHE.data;

  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?regions=us&markets=h2h&oddsFormat=american&apiKey=${ODDS_API_KEY}`;
  const res = await axios.get(url);
  CACHE.data = res.data;
  CACHE.lastFetch = Date.now();
  console.log(`📊 Pulled ${res.data.length} live NFL games`);
  return res.data;
}

function generateAIPicks(games) {
  return games.map((g) => {
    const home = g.home_team;
    const away = g.away_team;
    const outcomes = g.bookmakers?.[0]?.markets?.[0]?.outcomes || [];
    if (outcomes.length < 2) return null;

    const homeML = outcomes.find((o) => o.name === home)?.price;
    const awayML = outcomes.find((o) => o.name === away)?.price;
    const homeProb = impliedProb(homeML);
    const awayProb = impliedProb(awayML);
    const edge = Math.abs(homeProb - awayProb);

    const pick = homeProb > awayProb ? home : away;
    const confidence = Math.round(50 + edge * 100);
    const valueEdge = Math.round(edge * 100 * 1.5);

    return {
      matchup: `${away} @ ${home}`,
      pick,
      homeML,
      awayML,
      confidence,
      edge: `${valueEdge}%`,
      aiModel: confidence > 60 ? "LockBox Alpha" : "LockBox Lite",
    };
  }).filter(Boolean);
}

// ✅ Record tracker
function updateRecord(win) {
  if (win) record.wins++;
  else record.losses++;
  record.winRate = ((record.wins / (record.wins + record.losses)) * 100).toFixed(1);
  fs.writeFileSync(RESULT_LOG, JSON.stringify(record, null, 2));
}

// ✅ API endpoints
app.get("/api/picks", async (req, res) => {
  try {
    const data = await getOdds();
    const picks = generateAIPicks(data);
    res.json({ picks });
  } catch (err) {
    console.error("❌ /api/picks error:", err.message);
    res.status(500).json({ picks: [] });
  }
});

app.get("/api/record", (req, res) => res.json(record));

// ✅ Add results manually for now (admin only)
app.post("/api/result", (req, res) => {
  const { won } = req.body;
  updateRecord(won);
  res.json(record);
});

// ✅ Create Stripe Checkout Session
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
    res.status(500).json({ error: err.message });
  }
});

// ✅ Health check
app.get("/", (req, res) => res.send("LockBox Profit Engine ✅ Ready"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ LockBox backend running on ${PORT}`));

// ✅ Simple user list (in-memory for now)
let users = [{ id: 1, email: "admin@lockbox.ai", password: "masterkey", role: "admin" }];

// ✅ Register route
app.post("/api/signup", (req, res) => {
  const { email, password } = req.body;
  if (users.find(u => u.email === email)) return res.status(400).json({ error: "Email already registered" });
  const newUser = { id: Date.now(), email, password, role: "member" };
  users.push(newUser);
  const token = generateToken(newUser);
  res.json({ token, user: newUser });
});

// ✅ Login route
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const token = generateToken(user);
  res.json({ token, user });
});

// ✅ Protect picks behind login (for paid users)
app.get("/api/picks/protected", verifyToken, async (req, res) => {
  const data = await getOdds();
  const picks = generateAIPicks(data);
  res.json({ picks });
});

