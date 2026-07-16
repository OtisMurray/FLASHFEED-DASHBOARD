#!/usr/bin/env python3
"""Publish Decision Map point snapshots to the existing FlashFeed Kafka topic."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    kafka_dir = root / "Infrastructure" / "kafka"
    sys.path.insert(0, str(kafka_dir))

    if os.getenv("DECISION_MAP_KAFKA_PUBLISH", "true").lower() == "false":
        print(json.dumps({"ok": True, "sent": 0, "skipped": "disabled"}))
        return 0

    raw = sys.stdin.read()
    payload = json.loads(raw or "{}")
    points = payload.get("points") if isinstance(payload, dict) else payload
    if not isinstance(points, list):
        raise ValueError("Expected JSON object with a points array")

    from news_publisher import publish_decision_map_points

    sent = publish_decision_map_points(points)
    print(json.dumps({"ok": True, "sent": sent}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
