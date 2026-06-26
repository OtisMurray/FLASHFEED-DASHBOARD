"""Tests for D7: Finviz CSV Ingestion."""

import os

import mongomock
import pytest

from processing.finviz_ingest import (
    normalize_column_name,
    parse_market_cap,
    parse_percentage,
    normalize_analyst_recom,
    parse_finviz_csv,
    ingest_finviz_data,
)


# ---------------------------------------------------------------------------
# TestParseMarketCap
# ---------------------------------------------------------------------------

class TestParseMarketCap:
    def test_billions(self):
        assert parse_market_cap("3.5B") == 3_500_000_000

    def test_millions(self):
        assert parse_market_cap("800M") == 800_000_000

    def test_thousands(self):
        assert parse_market_cap("5.2K") == 5_200

    def test_dash_returns_none(self):
        assert parse_market_cap("-") is None

    def test_empty_returns_none(self):
        assert parse_market_cap("") is None


# ---------------------------------------------------------------------------
# TestParsePercentage
# ---------------------------------------------------------------------------

class TestParsePercentage:
    def test_positive(self):
        assert parse_percentage("1.25%") == 1.25

    def test_negative(self):
        assert parse_percentage("-2.10%") == -2.10

    def test_dash_returns_none(self):
        assert parse_percentage("-") is None


# ---------------------------------------------------------------------------
# TestNormalizeAnalystRecom
# ---------------------------------------------------------------------------

class TestNormalizeAnalystRecom:
    def test_strong_buy(self):
        assert normalize_analyst_recom(1.0) == 1.0

    def test_hold(self):
        assert normalize_analyst_recom(3.0) == 0.0

    def test_sell(self):
        assert normalize_analyst_recom(5.0) == -1.0

    def test_moderate_buy(self):
        result = normalize_analyst_recom(2.0)
        assert result == pytest.approx(0.5)


# ---------------------------------------------------------------------------
# TestNormalizeColumnName
# ---------------------------------------------------------------------------

class TestNormalizeColumnName:
    def test_market_cap(self):
        assert normalize_column_name("Market Cap") == "market_cap"

    def test_analyst_recom(self):
        assert normalize_column_name("Analyst Recom.") == "analyst_recom"

    def test_pe_ratio(self):
        assert normalize_column_name("P/E") == "p_e"


# ---------------------------------------------------------------------------
# TestParseFinvizCsv
# ---------------------------------------------------------------------------

class TestParseFinvizCsv:
    def test_basic_parse(self, tmp_path):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text(
            "Ticker,Company,Market Cap,Change,Analyst Recom.\n"
            "AAPL,Apple Inc.,3.5B,1.25%,1.8\n"
            "TSLA,Tesla Inc.,800M,-2.10%,3.2\n"
        )
        rows = parse_finviz_csv(csv_file)
        assert len(rows) == 2
        assert rows[0]["ticker"] == "AAPL"
        assert rows[1]["ticker"] == "TSLA"

    def test_missing_ticker_raises(self, tmp_path):
        csv_file = tmp_path / "bad.csv"
        csv_file.write_text("Company,Price\nApple,185\n")
        with pytest.raises(ValueError, match="Ticker"):
            parse_finviz_csv(csv_file)

    def test_all_columns_preserved(self, tmp_path):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text("Ticker,Sector,Industry\nAAPL,Tech,Hardware\n")
        rows = parse_finviz_csv(csv_file)
        assert rows[0]["sector"] == "Tech"
        assert rows[0]["industry"] == "Hardware"

    def test_market_cap_parsed(self, tmp_path):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text("Ticker,Market Cap\nAAPL,3.5B\n")
        rows = parse_finviz_csv(csv_file)
        assert rows[0]["market_cap"] == 3_500_000_000

    def test_analyst_recom_normalized(self, tmp_path):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text("Ticker,Analyst Recom.\nAAPL,1.0\n")
        rows = parse_finviz_csv(csv_file)
        assert rows[0]["analyst_recom"] == 1.0
        assert rows[0]["structured_sentiment"] == 1.0


# ---------------------------------------------------------------------------
# TestIngestFinvizData
# ---------------------------------------------------------------------------

class TestIngestFinvizData:
    @pytest.fixture()
    def collection(self):
        client = mongomock.MongoClient()
        return client["ds440_test"]["finviz_screener"]

    def test_basic_ingest(self, tmp_path, collection):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text(
            "Ticker,Company,Market Cap\n"
            "AAPL,Apple Inc.,3.5B\n"
            "TSLA,Tesla Inc.,800M\n"
        )
        count = ingest_finviz_data(csv_file, collection)
        assert count == 2
        assert collection.count_documents({}) == 2

    def test_upsert_on_re_upload(self, tmp_path, collection):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text("Ticker,Company\nAAPL,Apple Inc.\n")
        ingest_finviz_data(csv_file, collection)

        csv_file.write_text("Ticker,Company\nAAPL,Apple Corporation\n")
        ingest_finviz_data(csv_file, collection)

        assert collection.count_documents({}) == 1
        doc = collection.find_one({"ticker": "AAPL"})
        assert doc["company"] == "Apple Corporation"

    def test_ingested_at_set(self, tmp_path, collection):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text("Ticker,Company\nAAPL,Apple\n")
        ingest_finviz_data(csv_file, collection)

        doc = collection.find_one({"ticker": "AAPL"})
        assert "ingested_at" in doc

    def test_correct_count(self, tmp_path, collection):
        csv_file = tmp_path / "test.csv"
        lines = ["Ticker,Company"] + [f"T{i},Company{i}" for i in range(5)]
        csv_file.write_text("\n".join(lines) + "\n")
        count = ingest_finviz_data(csv_file, collection)
        assert count == 5

    def test_tickers_uppercase(self, tmp_path, collection):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text("Ticker,Company\naapl,Apple\n")
        ingest_finviz_data(csv_file, collection)

        doc = collection.find_one({"ticker": "AAPL"})
        assert doc is not None


# ---------------------------------------------------------------------------
# TestRealWorldExamples
# ---------------------------------------------------------------------------

class TestRealWorldExamples:
    def test_parse_sample_csv(self):
        sample_path = os.path.join(
            os.path.dirname(__file__), "..", "data", "finviz_sample.csv"
        )
        if not os.path.exists(sample_path):
            pytest.skip("Sample CSV not found")

        rows = parse_finviz_csv(sample_path)
        assert len(rows) == 10

        # Check AAPL row
        aapl = next(r for r in rows if r["ticker"] == "AAPL")
        assert aapl["market_cap"] == 3_500_000_000
        assert aapl["structured_sentiment"] is not None
        assert aapl["structured_sentiment"] > 0  # 1.8 → positive sentiment
