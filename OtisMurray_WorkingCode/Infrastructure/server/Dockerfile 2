FROM node:22-alpine

WORKDIR /app

# Python support for the real RSS Mongo importer
# python3-dev    → Python.h headers for building C extensions (confluent-kafka)
# librdkafka-dev → confluent-kafka links against system librdkafka instead of bundling its own
# cyrus-sasl-dev → SASL support for Kafka (optional but expected by the build)
RUN apk add --no-cache python3 python3-dev py3-pip build-base libpq-dev openssl-dev tzdata \
      librdkafka librdkafka-dev cyrus-sasl-dev \
  && python3 -m venv /opt/rssvenv \
  && /opt/rssvenv/bin/pip install --upgrade pip setuptools wheel \
  && /opt/rssvenv/bin/pip install --no-cache-dir pymongo feedparser requests curl_cffi python-dotenv beautifulsoup4 "psycopg[binary]" confluent-kafka redis

# Install backend deps first for better Docker caching
COPY Infrastructure/server/package*.json ./
RUN npm install

# Copy backend app and RSS importer into the same runtime
COPY Infrastructure/server ./
COPY 1_News ./1_News
COPY 2_Screener ./2_Screener
COPY config ./config
# Kafka publish helper (news_publisher.py) + its siblings (producer/config/models)
COPY Infrastructure/kafka ./Infrastructure/kafka

ENV PYTHONUNBUFFERED=1
ENV RSS_COOLDOWN_SECONDS=0
ENV RSS_STATE_FILE=/tmp/feedflash_rss_fetch_state.json

EXPOSE 3001

CMD ["npm", "run", "dev"]
