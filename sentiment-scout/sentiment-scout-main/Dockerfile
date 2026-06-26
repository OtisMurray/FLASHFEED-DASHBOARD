# Sentiment Scout backend — Flask API + background schedulers (multicap screener,
# FeedFlash FinBERT/VADER pipeline, Yosef Stocktwits scraper). Same entry as local
# dev: `python3 dashboard.py`, serving on 0.0.0.0:5050. The vendored teammate
# codebases under external/ are copied in and run as-is.
#
# FinBERT (ProsusAI/finbert) needs ~2GB RAM and downloads its model on first
# scoring run — cached under the mounted /app/var volume (HF_HOME) so a restart
# doesn't re-download.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
# Hugging Face model cache under the runtime volume so it persists across restarts.
ENV HF_HOME=/app/var/hf-cache

WORKDIR /app

# Install deps first for layer caching. torch is pulled from the CPU wheel index —
# the default index ships the multi-GB CUDA build, which is dead weight on a
# CPU-only host. The second install then sees torch already satisfied.
COPY requirements.txt .
RUN pip install torch==2.12.0 --index-url https://download.pytorch.org/whl/cpu \
 && pip install -r requirements.txt

# Application code + vendored external/ components. Runtime data (var/), the
# frontend node_modules/dist, .env, caches, and screenshots are excluded by
# .dockerignore so the image carries code only.
COPY . .

# Runtime/writable data lives here (VAR_ROOT defaults to /app/var). Mount a
# persistent volume at this path on the host for the SQLite + FeedFlash DBs,
# credentials store, and the FinBERT model cache.
VOLUME ["/app/var"]

EXPOSE 5050

# Starts the background schedulers and the Flask app (host 0.0.0.0:5050).
CMD ["python3", "dashboard.py"]
