#!/usr/bin/env bash
# Start the FeedFlash sentiment microservice inside the conda environment.
# Usage: ./sentiment_service/start.sh [PORT]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_NAME="feedflash-sentiment"
PORT="${1:-5001}"

# Resolve conda init
CONDA_BASE="$(conda info --base 2>/dev/null)"
if [ -z "$CONDA_BASE" ]; then
    echo "ERROR: conda not found. Install Miniconda/Anaconda first." >&2
    exit 1
fi

# Create env if missing
if ! conda env list | grep -q "^${ENV_NAME} "; then
    echo "Creating conda environment '${ENV_NAME}'..."
    conda env create -f "${SCRIPT_DIR}/environment.yml"
fi

echo "Starting FeedFlash Sentiment Service on port ${PORT} (env: ${ENV_NAME})"
PORT="${PORT}" conda run --no-capture-output -n "${ENV_NAME}" \
    python "${SCRIPT_DIR}/service.py"