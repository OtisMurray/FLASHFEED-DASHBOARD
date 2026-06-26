# ─── Stage 1: Build the C++ feedflash binary ──────────────────────────────────
FROM debian:bookworm-slim AS cpp-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    cmake \
    g++ \
    libcurl4-openssl-dev \
    libsqlite3-dev \
    libpugixml-dev \
    nlohmann-json3-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY CMakeLists.txt .
COPY src/ src/
COPY include/ include/

RUN cmake -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j"$(nproc)"


# ─── Stage 2: Runtime — Bun + C++ binary + Python sentiment service ────────────
FROM python:3.10-slim-bookworm AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV FLASHFEED_ROOT=/app
ENV PORT=3000
ENV BUN_INSTALL=/usr/local/bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

WORKDIR /app

# Install runtime libraries and tools + Node.js (needed for Next.js build)
RUN apt-get update && apt-get install -y \
    libcurl4 \
    libsqlite3-0 \
    libpugixml1v5 \
    ca-certificates \
    curl \
    unzip \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash

# Install Python dependencies separately to optimize caching
# Install Torch CPU-only first
RUN pip3 install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# Install other Python deps
COPY sentiment_service/requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt

# Download NLTK data
RUN python3 -c "import nltk; nltk.download('punkt', quiet=True); nltk.download('stopwords', quiet=True); nltk.download('vader_lexicon', quiet=True)"

# Pre-download FinBERT weights (this is a heavy layer, but cached if requirements don't change)
RUN python3 -c "from transformers import pipeline; pipeline('text-classification', model='ProsusAI/finbert', tokenizer='ProsusAI/finbert'); print('FinBERT cached OK')"

# Copy compiled C++ binary from builder
COPY --from=cpp-builder /src/build/feedflash build/feedflash

# Copy and install Bun dependencies
COPY flashfeed-web/package.json flashfeed-web/bun.lock flashfeed-web/
RUN cd flashfeed-web && bun install

# Copy and install Next.js dashboard dependencies (separate layer for caching)
COPY flashfeed-web/dashboard/package.json flashfeed-web/dashboard/package-lock.json* flashfeed-web/dashboard/
RUN cd flashfeed-web/dashboard && npm ci --legacy-peer-deps 2>/dev/null || npm install --legacy-peer-deps

# Copy application code (ordered from least likely to change to most likely)
COPY sentiment_service/            sentiment_service/
COPY sentiment_analyzer/ sentiment_analyzer/
COPY social_pipeline/      social_pipeline/
COPY pyproject.toml                pyproject.toml
COPY flashfeed-web/                flashfeed-web/
COPY config.json                   config.json

# Build Next.js dashboard (static export → dashboard/out/)
RUN cd flashfeed-web/dashboard && npx next build

# Install the local Python packages natively
RUN pip3 install -e .

# Final setup
RUN mkdir -p /data
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
