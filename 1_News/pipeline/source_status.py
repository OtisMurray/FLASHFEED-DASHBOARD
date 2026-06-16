from __future__ import annotations

from datetime import datetime, timezone


def record_source_status(db, source: str, status: str, *, detail: str = "", count: int = 0, source_type: str = "") -> None:
    """Best-effort source health update used by collectors."""
    try:
        now = datetime.now(timezone.utc)
        fields = {
            "source": source,
            "status": status,
            "detail": detail,
            "last_count": int(count or 0),
            "type": source_type,
            "last_checked_at": now,
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
