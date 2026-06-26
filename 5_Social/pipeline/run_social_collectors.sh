#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "Running Finviz-top-mover-only social collectors..."
export SOCIAL_STRICT_FINVIZ_TOP_MOVERS="${SOCIAL_STRICT_FINVIZ_TOP_MOVERS:-1}"
export SOCIAL_TOP_GAINERS_LIMIT="${SOCIAL_TOP_GAINERS_LIMIT:-8}"
export SOCIAL_MOMENTUM_LIMIT="${SOCIAL_MOMENTUM_LIMIT:-8}"
export SOCIAL_MAX_TICKERS="${SOCIAL_MAX_TICKERS:-8}"
export SOCIAL_MAX_WORKERS="${SOCIAL_MAX_WORKERS:-2}"
export STOCKTWITS_MAX_WORKERS="${STOCKTWITS_MAX_WORKERS:-2}"
export STOCKTWITS_TIMEOUT="${STOCKTWITS_TIMEOUT:-5}"
export SOCIAL_INCLUDE_X="${SOCIAL_INCLUDE_X:-false}"
export SOCIAL_INCLUDE_PRIVATE_TICKERS="${SOCIAL_INCLUDE_PRIVATE_TICKERS:-false}"
export SOCIAL_PRIVATE_TICKERS=""

python3 5_Social/pipeline/run_finviz_top_gainer_socials.py
