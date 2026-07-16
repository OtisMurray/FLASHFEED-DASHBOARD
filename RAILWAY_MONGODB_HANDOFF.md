# Railway MongoDB Handoff

This project is now wired so a separate hosted MongoDB can be used without code edits.

## What Ryan Needs To Paste Into Railway

Set these variables on the Railway backend service:

```bash
MONGODB_URI=<your-hosted-mongodb-uri>
MONGO_DB=feedflash
MONGODB_DB=feedflash
REDIS_URL=<Railway Redis private URL if using Railway Redis>
KAFKA_BOOTSTRAP_SERVERS=<Kafka broker if Railway/VPS Kafka is used>
KAFKA_TOPIC=flashfeed-events
KAFKA_PUBLISH_NEWS=true
DECISION_MAP_KAFKA_PUBLISH=true
DECISION_MAP_REDIS_TTL=300
DECISION_MAP_PATH_TTL=21600
DECISION_MAP_PATH_MAX=180
DECISION_MAP_POINT_INTERVAL_SECONDS=60
```

Keep `MONGODB_URI` private. It should not be committed.

## Recommended Setup

1. Create a separate MongoDB database named `feedflash`.
2. Use a user with read/write access only to that database.
3. In Railway, set `MONGODB_URI` to the private/internal Mongo connection string.
4. Set the same `MONGODB_URI` on backend workers that write data: backend, Kafka consumer, RSS worker, sentiment worker, auto-refresh worker if used.
5. Keep Redis/Kafka close to the backend. The 3D Decision Map now uses Redis for hot graph/path data and Mongo for durable history.

## Decision Map Hot Data

Redis keys:

```text
decision_map:latest
decision_map:latest:{querySignature}
decision_map:meta
decision_map:active
decision_map:path:{TICKER}
decision_map:point:{TICKER}:{snapshotSec}
decision_map:ticker:{TICKER}:latest
```

Mongo durable collection:

```text
decision_map_points
```

Kafka event type:

```text
decision_map_point
```

Health checks:

```bash
curl "$BACKEND_URL/api/health"
curl "$BACKEND_URL/api/decision-map/ram/status"
curl -D - "$BACKEND_URL/api/decision-map?limit=20&path_points=10"
```

Expected hot-read header after the first warm request:

```text
X-Decision-Map-Store: redis-hot
```

## Moving Local Data To Hosted Mongo

From the local project root:

```bash
docker exec feedflash-mongo mongodump --db feedflash --archive=/tmp/feedflash.archive --gzip
docker cp feedflash-mongo:/tmp/feedflash.archive ./feedflash.archive
mongorestore --uri "$MONGODB_URI" --archive=./feedflash.archive --gzip --nsInclude='feedflash.*'
```

If `mongorestore` is not installed locally, run it from any machine with MongoDB Database Tools installed.

## Notes

Local Docker still works with no hosted database because `docker-compose.yml` defaults to `mongodb://mongo:27017/feedflash`.

For production, do not expose MongoDB publicly unless IP allowlisting and strong credentials are configured.
