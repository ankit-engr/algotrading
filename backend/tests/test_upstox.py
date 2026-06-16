"""
Unit tests for Upstox API v2 integration.
"""
import pytest
from datetime import datetime
from unittest.mock import MagicMock, patch
import pandas as pd

from app.services.upstox import UpstoxService, get_active_market_data
from app.utils.config import settings
from app.models.market_data import MarketDataBundle

MOCK_LTP_RESPONSE = {
    "status": "success",
    "data": {
        "NSE_INDEX|Nifty Bank": {
            "last_price": 46500.0
        },
        "NSE_INDEX|India VIX": {
            "last_price": 14.5
        }
    }
}

MOCK_CANDLES_RESPONSE = {
    "status": "success",
    "data": {
        "candles": [
            ["2026-06-11T15:15:00+05:30", 46500.0, 46550.0, 46480.0, 46510.0, 50000, 0],
            ["2026-06-11T15:10:00+05:30", 46490.0, 46520.0, 46470.0, 46500.0, 40000, 0],
            ["2026-06-11T15:05:00+05:30", 46480.0, 46500.0, 46450.0, 46490.0, 30000, 0],
            ["2026-06-11T15:00:00+05:30", 46470.0, 46490.0, 46440.0, 46480.0, 25000, 0],
            ["2026-06-11T14:55:00+05:30", 46460.0, 46480.0, 46430.0, 46470.0, 20000, 0]
        ]
    }
}

MOCK_OPTION_CHAIN_RESPONSE = {
    "status": "success",
    "data": [
        {
            "expiry": "2026-06-18",
            "strike_price": 46400.0,
            "call_options": {
                "market_data": {"ltp": 120.0, "volume": 1000, "oi": 5000},
                "option_greeks": {"iv": 14.5}
            },
            "put_options": {
                "market_data": {"ltp": 80.0, "volume": 800, "oi": 4000},
                "option_greeks": {"iv": 14.2}
            }
        },
        {
            "expiry": "2026-06-18",
            "strike_price": 46500.0,
            "call_options": {
                "market_data": {"ltp": 70.0, "volume": 1500, "oi": 6000},
                "option_greeks": {"iv": 14.8}
            },
            "put_options": {
                "market_data": {"ltp": 110.0, "volume": 1200, "oi": 5500},
                "option_greeks": {"iv": 14.6}
            }
        }
    ]
}

@pytest.fixture
def clean_upstox_service():
    """Reset the singleton instance of UpstoxService for testing."""
    UpstoxService._instance = None
    service = UpstoxService()
    yield service
    UpstoxService._instance = None


class TestUpstoxConfigAndFetch:
    def test_is_configured_empty(self, clean_upstox_service):
        """Should return False if access token is not configured."""
        with patch.object(settings, "upstox_access_token", ""):
            assert clean_upstox_service.is_configured() is False

    def test_is_configured_filled(self, clean_upstox_service):
        """Should return True if access token is configured."""
        with patch.object(settings, "upstox_access_token", "token"):
            assert clean_upstox_service.is_configured() is True

    @patch("app.services.upstox.httpx.get")
    def test_fetch_market_data_success(self, mock_get, clean_upstox_service):
        """Should successfully fetch and parse market quote, candle, and option chain data."""
        # Setup mocks for Quote, 5m, 15m, and Option Chain endpoints
        mock_response_ltp = MagicMock()
        mock_response_ltp.status_code = 200
        mock_response_ltp.json.return_value = MOCK_LTP_RESPONSE

        mock_response_candles = MagicMock()
        mock_response_candles.status_code = 200
        mock_response_candles.json.return_value = MOCK_CANDLES_RESPONSE

        mock_response_chain = MagicMock()
        mock_response_chain.status_code = 200
        mock_response_chain.json.return_value = MOCK_OPTION_CHAIN_RESPONSE

        mock_get.side_effect = [mock_response_ltp, mock_response_candles, mock_response_candles, mock_response_chain]

        with patch.object(settings, "upstox_access_token", "test-token"):
            bundle = clean_upstox_service.fetch_market_data()
            
            assert bundle is not None
            assert bundle.spot_price == 46500.0
            assert bundle.vix == 14.5
            assert len(bundle.candles_5m) == 5
            assert len(bundle.candles_15m) == 5
            
            assert bundle.option_chain is not None
            assert bundle.option_chain.expiry_date == "2026-06-18"
            assert len(bundle.option_chain.strikes) == 2
            
            # Verify strike data
            strike = bundle.option_chain.strikes[1]
            assert strike.strike == 46500.0
            assert strike.call_oi == 6000.0
            assert strike.put_oi == 5500.0
            assert strike.call_ltp == 70.0
            assert strike.put_ltp == 110.0


class TestUpstoxActiveMarketData:
    @patch("app.services.upstox.upstox_service")
    def test_get_active_market_data_fallback_when_disabled(self, mock_service):
        """Should fall back to mock data if use_real_data is false."""
        with patch.object(settings, "use_real_data", False):
            bundle = get_active_market_data(is_market_open=True)
            assert isinstance(bundle, MarketDataBundle)
            mock_service.fetch_market_data.assert_not_called()

    @patch("app.services.upstox.upstox_service")
    def test_get_active_market_data_fallback_on_fetch_failure(self, mock_service):
        """Should fall back to mock data if fetch_market_data returns None."""
        mock_service.is_configured.return_value = True
        mock_service.fetch_market_data.return_value = None
        with patch.object(settings, "use_real_data", True):
            bundle = get_active_market_data(is_market_open=True)
            assert isinstance(bundle, MarketDataBundle)
            mock_service.fetch_market_data.assert_called_once()
