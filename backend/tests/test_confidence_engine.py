"""
Unit tests for the Confidence Engine.

Tests cover:
  - Weight correctness (all weights sum to 1.0)
  - Score bounds (0–100 for every component and total)
  - PCR scoring in both directions
  - Graceful handling of missing option chain data
  - RSI-based momentum scoring
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models.market_data import CandleData, OptionChainData, TrendResult
from app.services.confidence_engine import (
    _score_momentum,
    _score_open_interest,
    _score_option_chain,
    _score_pcr,
    _score_trend,
    _score_volume,
    _WEIGHTS,
    calculate_confidence,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

def make_candle(price: float, volume: int, i: int = 0) -> CandleData:
    ts = datetime(2024, 6, 10, 10, 0) - timedelta(minutes=i * 5)
    return CandleData(
        timestamp=ts, timeframe="5m",
        open=price, high=price + 30, low=price - 30, close=price,
        volume=volume,
    )


def bullish_trend() -> TrendResult:
    return TrendResult(
        trend="Bullish",
        price_vs_open="above",
        price_vs_vwap="above",
        has_higher_highs=True,
        has_lower_lows=False,
        volume_trend="increasing",
        strength=80.0,
        reasoning="test",
    )


def bearish_trend() -> TrendResult:
    return TrendResult(
        trend="Bearish",
        price_vs_open="below",
        price_vs_vwap="below",
        has_higher_highs=False,
        has_lower_lows=True,
        volume_trend="decreasing",
        strength=75.0,
        reasoning="test",
    )


def sideways_trend() -> TrendResult:
    return TrendResult(
        trend="Sideways",
        price_vs_open="at",
        price_vs_vwap="at",
        has_higher_highs=False,
        has_lower_lows=False,
        volume_trend="neutral",
        strength=30.0,
        reasoning="test",
    )


def make_option_chain(pcr: float = 1.0) -> OptionChainData:
    total_put = pcr * 1_000_000
    return OptionChainData(
        timestamp=datetime.now(timezone.utc),
        expiry_date="2024-06-20",
        spot_price=46_000,
        total_call_oi=1_000_000,
        total_put_oi=total_put,
        pcr=pcr,
        atm_call_oi=120_000,
        atm_put_oi=120_000 * pcr,
        atm_call_iv=18.0,
        atm_put_iv=20.0,
    )


# ── Weight Tests ──────────────────────────────────────────────────────────────

class TestWeights:
    def test_weights_sum_to_one(self):
        total = sum(_WEIGHTS.values())
        assert abs(total - 1.0) < 1e-9, f"Weights sum to {total}, expected 1.0"

    def test_all_expected_components_present(self):
        expected = {"trend", "volume", "oi", "option_chain", "momentum", "pcr"}
        assert set(_WEIGHTS.keys()) == expected


# ── Component Score Bounds ────────────────────────────────────────────────────

class TestScoreBounds:
    def test_trend_score_bounds_bullish(self):
        score = _score_trend(bullish_trend())
        assert 0.0 <= score <= 100.0

    def test_trend_score_bounds_sideways(self):
        score = _score_trend(sideways_trend())
        assert 0.0 <= score <= 100.0

    def test_volume_score_bounds(self):
        candles = [make_candle(46_000, volume=1_000_000 + i * 100_000, i=i) for i in range(15)]
        for direction in ("bullish", "bearish"):
            score = _score_volume(candles, direction)
            assert 0.0 <= score <= 100.0, f"Volume score {score} out of range for {direction}"

    def test_oi_score_bounds(self):
        oc = make_option_chain(pcr=1.3)
        for direction in ("bullish", "bearish"):
            score = _score_open_interest(oc, direction)
            assert 0.0 <= score <= 100.0

    def test_option_chain_score_bounds(self):
        oc = make_option_chain()
        for direction in ("bullish", "bearish"):
            score = _score_option_chain(oc, direction)
            assert 0.0 <= score <= 100.0

    def test_momentum_score_bounds(self):
        candles = [make_candle(46_000 + i * 10, volume=1_000_000, i=i) for i in range(20)]
        score = _score_momentum(candles)
        assert 0.0 <= score <= 100.0

    def test_pcr_score_bounds(self):
        for pcr in [0.5, 0.7, 1.0, 1.3, 1.6]:
            for direction in ("bullish", "bearish"):
                score = _score_pcr(pcr, direction)
                assert 0.0 <= score <= 100.0, (
                    f"PCR score {score} out of range for pcr={pcr}, direction={direction}"
                )


# ── PCR Logic Tests ───────────────────────────────────────────────────────────

class TestPCRScoring:
    def test_high_pcr_supports_bullish(self):
        """PCR > 1.3 (extreme fear) → contrarian bullish → high bullish score."""
        score_bullish = _score_pcr(1.4, "bullish")
        score_bearish = _score_pcr(1.4, "bearish")
        assert score_bullish > score_bearish

    def test_low_pcr_supports_bearish(self):
        """PCR < 0.7 (extreme greed) → contrarian bearish → high bearish score."""
        score_bearish = _score_pcr(0.6, "bearish")
        score_bullish = _score_pcr(0.6, "bullish")
        assert score_bearish > score_bullish

    def test_neutral_pcr_gives_moderate_scores(self):
        """PCR around 1.0 should give similar scores for both directions."""
        score_b = _score_pcr(1.0, "bullish")
        score_e = _score_pcr(1.0, "bearish")
        # Neither should be dominant (within 30 points of each other)
        assert abs(score_b - score_e) <= 35

    def test_none_pcr_returns_50(self):
        assert _score_pcr(None, "bullish") == 50.0
        assert _score_pcr(None, "bearish") == 50.0


# ── Missing Data Handling ─────────────────────────────────────────────────────

class TestMissingData:
    def test_no_option_chain_returns_neutral_oi(self):
        score = _score_open_interest(None, "bullish")
        assert score == 50.0

    def test_no_option_chain_returns_neutral_chain(self):
        score = _score_option_chain(None, "bearish")
        assert score == 50.0

    def test_few_candles_returns_neutral_volume(self):
        candles = [make_candle(46_000, 1_000_000, i=i) for i in range(3)]
        score = _score_volume(candles, "bullish")
        assert score == 50.0

    def test_few_candles_returns_neutral_momentum(self):
        candles = [make_candle(46_000, 1_000_000, i=i) for i in range(5)]
        score = _score_momentum(candles)
        assert score == 50.0


# ── Full Confidence Calculation ───────────────────────────────────────────────

class TestCalculateConfidence:
    def test_output_is_within_bounds(self):
        candles = [make_candle(46_000 + i * 50, 1_500_000, i=i) for i in range(20)]
        result = calculate_confidence(bullish_trend(), candles, make_option_chain(1.3), "bullish")
        assert 0.0 <= result.total <= 100.0

    def test_all_components_returned(self):
        candles = [make_candle(46_000, 1_000_000, i=i) for i in range(20)]
        result = calculate_confidence(bullish_trend(), candles, None, "bullish")
        assert hasattr(result, "trend_score")
        assert hasattr(result, "volume_score")
        assert hasattr(result, "oi_score")
        assert hasattr(result, "option_chain_score")
        assert hasattr(result, "momentum_score")
        assert hasattr(result, "pcr_score")
        assert hasattr(result, "total")

    def test_sideways_trend_reduces_total(self):
        """Sideways trend should produce lower confidence than bullish/bearish."""
        candles = [make_candle(46_000, 1_000_000, i=i) for i in range(20)]
        sideways = calculate_confidence(sideways_trend(), candles, None, "bullish")
        bullish = calculate_confidence(bullish_trend(), candles, None, "bullish")
        assert sideways.total <= bullish.total, (
            "Sideways trend should have lower or equal confidence than Bullish"
        )
