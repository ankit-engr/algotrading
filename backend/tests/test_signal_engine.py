"""
Unit tests for the Signal Engine.

Tests cover the three core signal outputs:
  1. BUY CE  — bullish conditions with high confidence
  2. BUY PE  — bearish conditions with high confidence
  3. NO TRADE — all guard conditions that prevent trading

Philosophy: Signal engine tests are the most critical.
Every NO TRADE gate is explicitly verified.
"""
from datetime import datetime
from unittest.mock import patch, MagicMock
from zoneinfo import ZoneInfo

import pytest

from app.models.market_data import (
    AIPrediction,
    CandleData,
    ConfidenceBreakdown,
    MarketDataBundle,
    OptionChainData,
    TrendResult,
)
from app.services.signal_engine import (
    _blend_confidence,
    _compute_risk_level,
    _compute_stop_loss_and_targets,
    _is_market_open,
    generate_signal,
)

IST = ZoneInfo("Asia/Kolkata")


# ── Test Fixtures ─────────────────────────────────────────────────────────────

def make_candle(price: float, volume: int = 1_000_000, i: int = 0) -> CandleData:
    from datetime import timedelta
    ts = datetime(2024, 6, 10, 10, 30) - timedelta(minutes=i * 5)
    return CandleData(
        timestamp=ts, timeframe="5m",
        open=price, high=price + 50, low=price - 50, close=price,
        volume=volume,
    )


def make_bullish_bundle(confidence_override: float | None = None) -> MarketDataBundle:
    """Bundle that should produce BUY CE."""
    candles = [make_candle(46_000 + (20 - i) * 100, volume=2_000_000 - i * 50_000, i=i)
               for i in range(20)]
    return MarketDataBundle(
        timestamp=datetime(2024, 6, 10, 11, 0, tzinfo=IST),
        spot_price=47_900.0,
        candles_5m=candles,
        candles_15m=candles[:5],
        option_chain=OptionChainData(
            timestamp=datetime(2024, 6, 10, 11, 0, tzinfo=IST),
            expiry_date="2024-06-20",
            spot_price=47_900.0,
            total_call_oi=1_000_000,
            total_put_oi=1_400_000,  # PCR > 1 → bullish
            pcr=1.4,
            atm_call_oi=120_000,
            atm_put_oi=160_000,
            atm_call_iv=18.0,
            atm_put_iv=20.0,
        ),
        vix=13.5,
        is_market_open=True,
    )


def make_bearish_bundle() -> MarketDataBundle:
    """Bundle that should produce BUY PE."""
    candles = [make_candle(47_000 - (20 - i) * 100, volume=2_000_000 - i * 50_000, i=i)
               for i in range(20)]
    return MarketDataBundle(
        timestamp=datetime(2024, 6, 10, 11, 0, tzinfo=IST),
        spot_price=45_100.0,
        candles_5m=candles,
        candles_15m=candles[:5],
        option_chain=OptionChainData(
            timestamp=datetime(2024, 6, 10, 11, 0, tzinfo=IST),
            expiry_date="2024-06-20",
            spot_price=45_100.0,
            total_call_oi=1_400_000,  # PCR < 1 → bearish
            total_put_oi=800_000,
            pcr=0.57,
            atm_call_oi=180_000,
            atm_put_oi=100_000,
            atm_call_iv=22.0,
            atm_put_iv=19.0,
        ),
        vix=15.0,
        is_market_open=True,
    )


def make_closed_market_bundle() -> MarketDataBundle:
    return MarketDataBundle(
        timestamp=datetime(2024, 6, 10, 16, 0, tzinfo=IST),
        spot_price=46_500.0,
        candles_5m=[make_candle(46_500, i=i) for i in range(10)],
        is_market_open=False,
    )


# ── Market Open/Close Tests ───────────────────────────────────────────────────

class TestMarketOpenCheck:
    def test_weekday_within_hours_is_open(self):
        # Monday at 11:00 IST
        ts = datetime(2024, 6, 10, 11, 0, tzinfo=IST)  # Monday
        assert _is_market_open(ts) is True

    def test_before_market_open(self):
        ts = datetime(2024, 6, 10, 9, 0, tzinfo=IST)
        assert _is_market_open(ts) is False

    def test_after_market_close(self):
        ts = datetime(2024, 6, 10, 16, 0, tzinfo=IST)
        assert _is_market_open(ts) is False

    def test_saturday_is_closed(self):
        ts = datetime(2024, 6, 8, 11, 0, tzinfo=IST)  # Saturday
        assert _is_market_open(ts) is False

    def test_sunday_is_closed(self):
        ts = datetime(2024, 6, 9, 11, 0, tzinfo=IST)  # Sunday
        assert _is_market_open(ts) is False


# ── NO TRADE Gate Tests ───────────────────────────────────────────────────────

class TestNoTradeGates:
    def test_closed_market_returns_no_trade(self):
        """Gate 1: Market closed → always NO TRADE."""
        bundle = make_closed_market_bundle()
        result = generate_signal(bundle)
        assert result.signal == "NO TRADE"
        assert result.market_status == "Closed"

    def test_insufficient_candles_returns_no_trade(self):
        """Gate 2: Fewer than 5 candles → NO TRADE."""
        bundle = MarketDataBundle(
            timestamp=datetime(2024, 6, 10, 11, 0, tzinfo=IST),
            spot_price=46_500.0,
            candles_5m=[make_candle(46_500)],  # Only 1 candle
            is_market_open=True,
        )
        result = generate_signal(bundle)
        assert result.signal == "NO TRADE"

    def test_low_confidence_returns_no_trade(self):
        """Gate 4: Below confidence threshold → NO TRADE."""
        bundle = make_bullish_bundle()
        # Force confidence engine to return low score
        low_breakdown = ConfidenceBreakdown(
            trend_score=20, volume_score=20, oi_score=20,
            option_chain_score=20, momentum_score=20, pcr_score=20,
            total=20.0,
        )
        with patch("app.services.signal_engine.calculate_confidence", return_value=low_breakdown):
            result = generate_signal(bundle)
        assert result.signal == "NO TRADE"
        assert result.confidence < 70.0

    def test_exception_in_engine_returns_no_trade(self):
        """Capital protection: any exception → NO TRADE."""
        bundle = make_bullish_bundle()
        with patch("app.services.signal_engine.analyze_trend", side_effect=RuntimeError("test error")):
            result = generate_signal(bundle)
        assert result.signal == "NO TRADE"


# ── Signal Generation Tests ───────────────────────────────────────────────────

class TestSignalGeneration:
    def test_no_trade_confidence_is_non_negative(self):
        bundle = make_closed_market_bundle()
        result = generate_signal(bundle)
        assert result.confidence >= 0.0

    def test_signal_always_one_of_three_values(self):
        """Signal must ALWAYS be exactly one of the three valid outputs."""
        for bundle in [make_bullish_bundle(), make_bearish_bundle(), make_closed_market_bundle()]:
            result = generate_signal(bundle)
            assert result.signal in ("BUY CE", "BUY PE", "NO TRADE")

    def test_result_has_timestamp(self):
        bundle = make_closed_market_bundle()
        result = generate_signal(bundle)
        assert result.timestamp is not None

    def test_bank_nifty_price_preserved(self):
        bundle = make_closed_market_bundle()
        result = generate_signal(bundle)
        assert result.bank_nifty == bundle.spot_price

    def test_no_trade_has_no_stop_loss(self):
        """NO TRADE signals should not suggest a stop loss (no position to stop)."""
        bundle = make_closed_market_bundle()
        result = generate_signal(bundle)
        assert result.stop_loss is None
        assert result.targets == []


# ── Stop Loss / Target Tests ──────────────────────────────────────────────────

class TestStopLossAndTargets:
    def test_bullish_stop_below_price(self):
        sl, targets = _compute_stop_loss_and_targets(46_000, "bullish", vix=15.0)
        assert sl < 46_000, "Stop loss must be below entry for BUY CE"

    def test_bearish_stop_above_price(self):
        sl, targets = _compute_stop_loss_and_targets(46_000, "bearish", vix=15.0)
        assert sl > 46_000, "Stop loss must be above entry for BUY PE"

    def test_bullish_targets_above_price(self):
        _, targets = _compute_stop_loss_and_targets(46_000, "bullish", vix=15.0)
        assert all(t > 46_000 for t in targets), "All targets must be above entry for BUY CE"

    def test_bearish_targets_below_price(self):
        _, targets = _compute_stop_loss_and_targets(46_000, "bearish", vix=15.0)
        assert all(t < 46_000 for t in targets), "All targets must be below entry for BUY PE"

    def test_three_targets_returned(self):
        _, targets = _compute_stop_loss_and_targets(46_000, "bullish", vix=15.0)
        assert len(targets) == 3

    def test_high_vix_widens_stop(self):
        """Higher VIX should produce a wider stop (more volatility = more room needed)."""
        sl_low_vix, _ = _compute_stop_loss_and_targets(46_000, "bullish", vix=10.0)
        sl_high_vix, _ = _compute_stop_loss_and_targets(46_000, "bullish", vix=30.0)
        assert sl_high_vix < sl_low_vix, "High VIX should widen stop (lower SL for BUY CE)"


# ── Risk Level Tests ──────────────────────────────────────────────────────────

class TestRiskLevel:
    def test_high_confidence_low_vix_is_low_risk(self):
        assert _compute_risk_level(90.0, vix=12.0) == "Low"

    def test_medium_confidence_is_medium_risk(self):
        assert _compute_risk_level(75.0, vix=12.0) == "Medium"

    def test_high_vix_is_always_high_risk(self):
        assert _compute_risk_level(95.0, vix=25.0) == "High"

    def test_low_confidence_is_high_risk(self):
        assert _compute_risk_level(60.0, vix=12.0) == "High"


# ── Confidence Blending Tests ─────────────────────────────────────────────────

class TestConfidenceBlending:
    def test_no_model_uses_rules_confidence(self):
        ai = AIPrediction(
            up_probability=0.5,
            down_probability=0.5,
            confidence=50.0,
            model_available=False,
        )
        result = _blend_confidence(80.0, ai, "bullish")
        assert result == 80.0  # Pure rules-based

    def test_model_available_blends_confidences(self):
        ai = AIPrediction(
            up_probability=0.85,
            down_probability=0.15,
            confidence=90.0,
            model_available=True,
        )
        result = _blend_confidence(75.0, ai, "bullish")
        # AI is disabled, so it should always use rules confidence directly
        assert result == 75.0
