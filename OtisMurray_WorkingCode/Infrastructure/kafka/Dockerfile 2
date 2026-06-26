FROM python:3.12-slim

WORKDIR /app

COPY Infrastructure/kafka/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY Infrastructure/kafka ./

ENV PYTHONUNBUFFERED=1

CMD ["python", "consumer.py"]
