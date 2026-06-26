# FlashFeed Sentiment Service
# Deploy to Railway / Render / fly.io for the FinBERT + DS440 ensemble.
#
# Build context must be the repo root:
#   docker build -t flashfeed-sentiment .
#   docker run -p 5001:5001 flashfeed-sentiment

FROM python:3.11-slim

WORKDIR /app

# Copy just the three directories the service needs
COPY sentiment_service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download NLTK VADER data (small, avoids runtime download)
RUN python -c "import nltk; nltk.download('vader_lexicon', quiet=True)"

COPY sentiment_service/ ./sentiment_service/
COPY sentiment_analyzer/ ./sentiment_analyzer/
COPY social_pipeline/ ./social_pipeline/

WORKDIR /app/sentiment_service

ENV PORT=5001
EXPOSE 5001

# FinBERT model downloads on first request (cached by transformers in /root/.cache)
CMD ["python", "service.py"]
