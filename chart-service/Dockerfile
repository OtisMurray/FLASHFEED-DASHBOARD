FROM python:3.12-slim

WORKDIR /app

# git is needed to install the tvDatafeed requirement (git+https URL); removed
# from the layer cache to keep the image slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY chart-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# All service modules: the Flask app, the StockTwits walk + resting store, the
# TradingView / Blue Ocean overnight price fetcher, and the self-healing Finviz
# Elite auto-auth (logs in with FINVIZ_LOGIN/FINVIZ_PASSWORD, refreshes on 401).
COPY chart-service/chart_service.py ./chart_service.py
COPY chart-service/social_store.py ./social_store.py
COPY chart-service/tv_overnight.py ./tv_overnight.py
COPY chart-service/finviz_auth.py ./finviz_auth.py

ENV PYTHONUNBUFFERED=1
ENV PORT=5050

EXPOSE 5050

CMD ["python", "chart_service.py"]
