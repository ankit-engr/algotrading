# Bank Nifty AI Signal App 🏦📈

A production-ready Python application that analyzes Bank Nifty market data in real time and generates exactly **one** of three outputs:

| Signal | Meaning |
|--------|---------|
| 🟢 **BUY CE** | Bullish — buy Call option |
| 🔴 **BUY PE** | Bearish — buy Put option |
| ⛔ **NO TRADE** | Insufficient confidence or conflicting signals |

> **Capital protection is the highest priority.** The system NEVER forces a trade. Any ambiguity, low confidence, or system error defaults to NO TRADE.

---

## Architecture

```
app/
├── main.py                    # FastAPI entrypoint
├── api/
│   ├── routes.py              # REST + WebSocket endpoints
│   └── schemas.py             # Pydantic API models
├── services/
│   ├── trend_engine.py        # Trend: Bullish | Bearish | Sideways
│   ├── signal_engine.py       # Core decision engine (BUY CE / BUY PE / NO TRADE)
│   ├── confidence_engine.py   # Weighted confidence score 0–100
│   ├── carry_forward.py       # 3:15 PM carry recommendation
│   └── alerts.py              # WebSocket alert broadcaster
├── ai/
│   ├── features.py            # Feature engineering (13 features)
│   ├── model.py               # RandomForest classifier wrapper
│   └── trainer.py             # Training pipeline
├── db/
│   ├── database.py            # SQLAlchemy async engine
│   ├── models.py              # ORM tables
│   └── repository.py         # DB access layer
├── models/
│   └── market_data.py         # Internal Pydantic models
└── utils/
    ├── config.py              # Pydantic Settings
    ├── logger.py              # Structured JSON logging
    ├── mock_data.py           # Simulated market data (replace for production)
    └── scheduler.py           # APScheduler background jobs
```

---

## Quick Start

### 1. Local Development

```bash
# Clone / navigate to project
cd /path/to/stock

# Create virtual environment (one-time setup)
python3 -m venv venv

# Install dependencies inside the virtual environment
venv/bin/pip install -r requirements.txt

# Copy environment config
cp .env.example .env

# Start the server directly (no manual activation required!)
python3 serve.py
```

Open **http://localhost:8000/docs** for the interactive Swagger UI.

### 2. Docker

```bash
# Build and start
docker-compose up --build

# View logs
docker-compose logs -f app

# Stop
docker-compose down
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check (version, model status, WS connections) |
| `GET` | `/signal` | Latest signal (lightweight) |
| `GET` | `/dashboard` | Full dashboard with AI details |
| `GET` | `/history` | Paginated signal history |
| `GET` | `/carry-forward` | End-of-day carry recommendation |
| `POST` | `/market-data` | Ingest real broker data |
| `POST` | `/train` | Trigger AI model retraining |
| `WS` | `/ws/live` | Real-time signal + alert stream |

### Dashboard Response Format

```json
{
  "bank_nifty": 46500.00,
  "trend": "Bullish",
  "signal": "BUY CE",
  "confidence": 82.5,
  "risk_level": "Low",
  "stop_loss": 46268.75,
  "targets": [46731.25, 46847.00, 46962.50],
  "market_status": "Open",
  "last_updated": "2024-06-10T11:30:00+05:30",
  "vix": 13.5,
  "pcr": 1.35,
  "confidence_breakdown": {
    "trend_score": 80.0,
    "volume_score": 75.0,
    "oi_score": 85.0,
    "option_chain_score": 70.0,
    "momentum_score": 65.0,
    "pcr_score": 90.0,
    "total": 78.5
  }
}
```

---

## Modules

### Trend Engine
Determines market direction using:
- Price vs. session open
- Price vs. VWAP (cumulative volume-weighted average price)
- Higher highs / lower lows structure
- Volume behavior (increasing confirms, decreasing questions)

### Signal Engine — Decision Gates
```
1. Market closed?              → NO TRADE
2. Fewer than 5 candles?       → NO TRADE
3. Trend = Sideways?           → NO TRADE
4. Confidence < 70?            → NO TRADE
5. Any exception?              → NO TRADE  (capital protection)
6. ──────────────────────────────────────
   Bullish + all gates pass    → BUY CE
   Bearish + all gates pass    → BUY PE
```

### Confidence Engine Weights
| Component | Weight |
|-----------|--------|
| Trend Strength | 25% |
| Open Interest | 20% |
| Option Chain (IV skew) | 20% |
| Volume | 15% |
| Momentum (RSI) | 10% |
| PCR | 10% |

### AI Layer
- **Model**: `RandomForestClassifier` (scikit-learn)
- **Classes**: UP / DOWN / NEUTRAL (based on 5-bar forward return)
- **Blend**: 70% rules-based + 30% AI confidence
- **Fallback**: If no model trained → 100% rules-based (safe default)
- **Auto-retrain**: Every Sunday 6:00 AM IST

### Carry Forward Engine (3:15 PM IST)
| Output | Condition |
|--------|-----------|
| `CARRY CE` | Strong bullish, confidence ≥ 80, VIX ≤ 18 |
| `CARRY PE` | Strong bearish, confidence ≥ 80, VIX ≤ 18 |
| `PARTIAL CARRY` | Moderate confidence (55–80) |
| `EXIT ALL` | Sideways, low confidence, or VIX > 18 |

---

## WebSocket Usage

```javascript
const ws = new WebSocket('ws://localhost:8000/ws/live');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'LIVE_UPDATE') {
    console.log('Signal:', msg.signal, 'Confidence:', msg.confidence);
  }
  
  if (msg.type === 'ALERT') {
    console.log('Alert:', msg.alert_type, msg.message);
  }
};
```

Message types:
- `LIVE_UPDATE` — price + signal every 30s
- `ALERT` — BUY CE / BUY PE / TREND CHANGE / CARRY FORWARD

---

## Plugging in Real Data

Replace `app/utils/mock_data.py → get_current_market_data()` with your broker API, or use the `POST /market-data` endpoint:

```bash
curl -X POST http://localhost:8000/market-data \
  -H 'Content-Type: application/json' \
  -d '{
    "spot_price": 46500,
    "vix": 14.5,
    "candles_5m": [...],
    "candles_15m": [...],
    "strikes": [...]
  }'
```

Supported integrations (bring your own credentials):
- **Zerodha Kite Connect**: `kiteconnect` Python library
- **Angel Broking**: `smartapi-python`
- **Upstox**: `upstox-python-sdk`

---

## Running Tests

```bash
venv/bin/pytest tests/ -v --cov=app --cov-report=term-missing
```

Test coverage by module:
- `test_trend_engine.py` — VWAP, HH/LL, volume, edge cases
- `test_signal_engine.py` — All NO TRADE gates, stop-loss directionality, risk levels
- `test_confidence_engine.py` — Weight sums, score bounds, PCR logic
- `test_ai_model.py` — Feature extraction, no-NaN guarantee, fallback behavior

---

## Configuration

All config via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `mysql://root:Ankit@1234Secure@localhost:3306/stock` | Database connection |
| `CONFIDENCE_THRESHOLD` | `70` | Min score to issue a trade |
| `SIGNAL_REFRESH_SECONDS` | `30` | Signal recalculation interval |
| `CARRY_FORWARD_TIME` | `15:15` | Carry forward trigger time |
| `MODEL_PATH` | `./models/signal_model.joblib` | AI model file path |
| `LOG_LEVEL` | `INFO` | Logging level |

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Web Framework | FastAPI 0.111 |
| WebSockets | Built-in FastAPI WS |
| ORM | SQLAlchemy 2.0 (async) |
| Database | MySQL |
| AI / ML | scikit-learn RandomForest |
| Data Processing | Pandas, NumPy |
| Scheduling | APScheduler 3.10 |
| Logging | python-json-logger |
| Runtime | Python 3.11+ |
| Container | Docker + Docker Compose |

---

## ⚠️ Disclaimer

This application is for **educational and research purposes only**. It does not constitute financial advice. All trading involves risk. Always consult a qualified financial advisor before making investment decisions.
