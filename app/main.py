from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from typing import List, Optional
import os
CRON_SECRET = os.getenv("CRON_SECRET","change-me")
app = FastAPI(title="LockBox API", version="0.2.0")
class Pick(BaseModel):
    id: str; league: str; game_id: str; market: str; selection: str
    posted_line: float | None = None; posted_odds: int | None = None
    tier: str = "A"; hit_prob: float = 0.55; play_to: Optional[str] = None
    rationale: List[str] = []
class Game(BaseModel):
    id: str; league: str; home: str; away: str; kickoff_at: str
    market_spread: Optional[str] = None; market_total: Optional[float] = None
    fair_spread: Optional[float] = None; fair_total: Optional[float] = None
    weather: Optional[str] = None; notes: List[str] = []
GAMES: dict[str, Game] = {}
PICKS: dict[str, Pick] = {}
@app.get("/health")
async def health(): return {"ok": True, "picks": len(PICKS), "games": len(GAMES)}
@app.get("/picks/today", response_model=List[Pick])
async def picks_today(): return list(PICKS.values())
@app.get("/games/today", response_model=List[Game])
async def games_today(): return list(GAMES.values())
class UpsertPayload(BaseModel):
    games: List[Game] = []; picks: List[Pick] = []
@app.post("/ingest/upsert")
async def ingest_upsert(payload: UpsertPayload, x_cron_secret: str | None = Header(default=None)):
    if x_cron_secret != CRON_SECRET: raise HTTPException(401, "invalid secret")
    for g in payload.games: GAMES[g.id] = g
    for p in payload.picks: PICKS[p.id] = p
    return {"ok": True, "games": len(GAMES), "picks": len(PICKS)}
