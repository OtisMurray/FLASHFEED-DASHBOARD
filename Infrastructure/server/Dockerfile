FROM node:22-alpine

WORKDIR /app

# Python support for the real RSS Mongo importer + optional Kafka hot-feed publish
RUN apk add --no-cache python3 python3-dev py3-pip build-base libpq-dev openssl-dev tzdata \
    librdkafka-dev cyrus-sasl-dev lz4-dev zstd-dev \
  && python3 -m venv /opt/rssvenv \
  && /opt/rssvenv/bin/pip install --upgrade pip setuptools wheel \
  && /opt/rssvenv/bin/pip install --no-cache-dir pymongo feedparser requests curl_cffi python-dotenv beautifulsoup4 "psycopg[binary]" confluent-kafka redis

# Install backend deps
COPY Infrastructure/server/package*.json ./
RUN npm ci --omit=dev

# Copy backend app and data pipeline files
COPY Infrastructure/server ./
COPY Infrastructure/pipeline ./Infrastructure/pipeline
COPY Infrastructure/kafka ./Infrastructure/kafka
COPY 1_News ./1_News
COPY 2_Screener ./2_Screener
COPY config ./config

ENV PYTHONUNBUFFERED=1
ENV RSS_COOLDOWN_SECONDS=0
ENV RSS_STATE_FILE=/tmp/feedflash_rss_fetch_state.json
ENV NODE_ENV=production

EXPOSE 3001

# Railway provides PORT env var; use start (node) not dev (nodemon)
CMD ["npm", "run", "start"]
