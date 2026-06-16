FROM node:22-alpine

WORKDIR /app

# Python support for the real RSS Mongo importer
RUN apk add --no-cache python3 py3-pip build-base libpq-dev openssl-dev tzdata \
  && python3 -m venv /opt/rssvenv \
  && /opt/rssvenv/bin/pip install --upgrade pip setuptools wheel \
  && /opt/rssvenv/bin/pip install --no-cache-dir pymongo feedparser requests curl_cffi python-dotenv beautifulsoup4 "psycopg[binary]"

# Install backend deps first for better Docker caching
COPY Infrastructure/server/package*.json ./
RUN npm install

# Copy backend app and RSS importer into the same runtime
COPY Infrastructure/server ./
COPY 1_News ./1_News
COPY 2_Screener ./2_Screener
COPY config ./config

ENV PYTHONUNBUFFERED=1
ENV RSS_COOLDOWN_SECONDS=0
ENV RSS_STATE_FILE=/tmp/feedflash_rss_fetch_state.json

EXPOSE 3001

CMD ["npm", "run", "dev"]
