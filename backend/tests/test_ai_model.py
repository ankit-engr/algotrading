"""
Unit tests for the AI feature extraction and model prediction.

Tests cover:
  - Feature vector shape and validity (no NaN/Inf)
  - Feature names consistency
  - Model graceful fallback (no trained model)
  - Prediction output bounds
"""
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from app.ai.features import FEATURE_NAMES, N_FEATURES, extract_features
from app.ai.model import SignalClassifier
from app.models.market_data import CandleData, OptionChainData


# ── Fixtures ──────────────────────────────────────────────────────────────────

def make_candle(price: float, volume: int = 1_000_000, i: int = 0) -> CandleData:
    ts = datetime(2024, 6, 10, 10, 0) - timedelta(minutes=i * 5)
    return CandleData(
        timestamp=ts, timeframe="5m",
        open=price, high=price + 30, low=price - 30, close=price,
        volume=volume,
    )


def make_candles(n: int = 30, trend: str = "flat") -> list[CandleData]:
    """Generate n candles newest-first."""
    candles = []
    for i in range(n):
        if trend == "up":
            price = 46_000 + (n - i) * 50
        elif trend == "down":
            price = 46_000 - (n - i) * 50
        else:
            price = 46_000
        candles.append(make_candle(price, volume=1_000_000, i=i))
    return candles


def make_option_chain(pcr: float = 1.0) -> OptionChainData:
    return OptionChainData(
        timestamp=datetime.now(timezone.utc),
        expiry_date="2024-06-20",
        spot_price=46_000,
        total_call_oi=1_000_000,
        total_put_oi=pcr * 1_000_000,
        pcr=pcr,
        atm_call_oi=120_000,
        atm_put_oi=120_000 * pcr,
        atm_call_iv=18.0,
        atm_put_iv=20.0,
    )


# ── Feature Extraction Tests ──────────────────────────────────────────────────

class TestFeatureExtraction:
    def test_feature_vector_correct_length(self):
        candles = make_candles(30)
        features = extract_features(candles, None, None)
        assert len(features) == N_FEATURES

    def test_feature_names_count_matches(self):
        assert len(FEATURE_NAMES) == N_FEATURES

    def test_no_nan_in_features(self):
        candles = make_candles(30)
        features = extract_features(candles, None, None)
        assert not np.any(np.isnan(features)), f"NaN found in features: {features}"

    def test_no_inf_in_features(self):
        candles = make_candles(30)
        features = extract_features(candles, None, None)
        assert not np.any(np.isinf(features)), f"Inf found in features: {features}"

    def test_features_with_option_chain(self):
        candles = make_candles(30)
        oc = make_option_chain(pcr=1.2)
        features = extract_features(candles, oc, vix=15.0)
        assert len(features) == N_FEATURES
        assert not np.any(np.isnan(features))

    def test_upward_trend_positive_returns(self):
        candles = make_candles(30, trend="up")
        features = extract_features(candles, None, None)
        # ret1 (index 0) should be positive for uptrend
        # (newest candle price > 1 bar ago)
        ret1 = features[0]
        assert ret1 >= 0, f"Expected positive 1-bar return for uptrend, got {ret1}"

    def test_downward_trend_negative_returns(self):
        candles = make_candles(30, trend="down")
        features = extract_features(candles, None, None)
        ret1 = features[0]
        assert ret1 <= 0, f"Expected negative 1-bar return for downtrend, got {ret1}"

    def test_pcr_feature_matches_option_chain(self):
        """PCR feature (index 7) should match the option chain PCR."""
        candles = make_candles(20)
        oc = make_option_chain(pcr=1.5)
        features = extract_features(candles, oc, vix=None)
        pcr_feature = features[7]  # index 7 = pcr
        assert abs(pcr_feature - 1.5) < 0.01, (
            f"PCR feature {pcr_feature} should match option chain PCR 1.5"
        )

    def test_vix_feature_uses_default_when_none(self):
        """VIX feature (index 11) should use default 15.0 when VIX is None."""
        candles = make_candles(20)
        features = extract_features(candles, None, vix=None)
        vix_feature = features[11]  # index 11 = vix
        assert vix_feature == 15.0

    def test_insufficient_candles_no_crash(self):
        """Feature extraction must not crash on very few candles."""
        for n in [1, 2, 5]:
            candles = make_candles(n)
            features = extract_features(candles, None, None)
            assert len(features) == N_FEATURES
            assert not np.any(np.isnan(features))

    def test_zero_volume_candles_no_crash(self):
        candles = [make_candle(46_000, volume=0, i=i) for i in range(20)]
        features = extract_features(candles, None, None)
        assert not np.any(np.isnan(features))


# ── Model Tests ───────────────────────────────────────────────────────────────

class TestSignalClassifier:
    def test_no_model_returns_neutral_prediction(self):
        """Without a trained model, prediction should be neutral (50/50)."""
        classifier = SignalClassifier.__new__(SignalClassifier)
        classifier.model = None
        classifier.scaler = None
        classifier.is_loaded = False

        candles = make_candles(30)
        result = classifier.predict(candles, None, None)

        assert result.model_available is False
        assert result.up_probability == 0.5
        assert result.down_probability == 0.5
        assert result.confidence == 50.0

    def test_prediction_probabilities_sum_approximately_one(self):
        """Up + down probabilities should not exceed 1 (neutral class takes remainder)."""
        classifier = SignalClassifier.__new__(SignalClassifier)
        classifier.model = None
        classifier.scaler = None
        classifier.is_loaded = False

        candles = make_candles(30)
        result = classifier.predict(candles, None, None)

        assert result.up_probability + result.down_probability <= 1.0 + 1e-6

    def test_prediction_confidence_bounded(self):
        classifier = SignalClassifier.__new__(SignalClassifier)
        classifier.model = None
        classifier.scaler = None
        classifier.is_loaded = False

        candles = make_candles(30)
        result = classifier.predict(candles, None, None)
        assert 0.0 <= result.confidence <= 100.0
