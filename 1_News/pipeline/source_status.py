from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def record_source_status(
    db,
    source: str,
    status: str,
    *,
    detail: str = "",
    count: int = 0,
    source_type: str = "",
    metrics: dict[str, Any] | None = None,
) -> None:
    """Best-effort source health update used by collectors."""
    try:
        now = datetime.now(timezone.utc)
        clean_metrics = {}
        for key, value in (metrics or {}).items():
            if value is None:
                continue
            if isinstance(value, bool):
                clean_metrics[key] = value
            elif isinstance(value, (int, float, str)):
                clean_metrics[key] = value
        fields = {
            "source": source,
            "status": status,
            "detail": detail,
            "last_count": int(count or 0),
            "type": source_type,
            "last_checked_at": now,
            "metrics": clean_metrics,
            "records_received": int(clean_metrics.get("records_received", count or 0) or 0),
            "records_accepted": int(clean_metrics.get("records_accepted", count or 0) or 0),
            "records_duplicates": int(clean_metrics.get("records_duplicates", 0) or 0),
            "records_malformed": int(clean_metrics.get("records_malformed", 0) or 0),
            "records_filtered": int(clean_metrics.get("records_filtered", 0) or 0),
            "records_relevance_rejected": int(clean_metrics.get("records_relevance_rejected", 0) or 0),
            "records_new": int(clean_metrics.get("records_new", 0) or 0),
            "records_updated": int(clean_metrics.get("records_updated", 0) or 0),
        }
        if status in {"working", "working_public", "success"}:
            fields["last_success_at"] = now

        db.source_status.update_one(
            {"source": source},
            {
                "$set": fields,
                "$inc": {"checks": 1},
            },
            upsert=True,
        )
    except Exception:
        pass
