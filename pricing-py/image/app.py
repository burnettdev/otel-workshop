import json
import logging
import os
import sys
from datetime import datetime, timezone

import pymysql
from fastapi import FastAPI, HTTPException
from opentelemetry import trace


class JsonFormatter(logging.Formatter):
    """One JSON object per line, with the active trace context so logs correlate with traces."""

    def format(self, record):
        entry = {
            "time": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "service": "pricing-py",
            "logger": record.name,
            "message": record.getMessage(),
        }
        ctx = trace.get_current_span().get_span_context()
        if ctx.is_valid:
            entry["trace_id"] = format(ctx.trace_id, "032x")
            entry["span_id"] = format(ctx.span_id, "016x")
        entry.update(getattr(record, "fields", {}))
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry)


handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(JsonFormatter())
logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
log = logging.getLogger("pricing")

app = FastAPI(title="pricing-py")


def connect():
    return pymysql.connect(
        host=os.environ["DB_HOST"],
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        database=os.environ["DB_NAME"],
        connect_timeout=3,
    )


@app.get("/price/{product_id}")
def price(product_id: int):
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, name, price_cents, weight_g FROM products WHERE id = %s", (product_id,))
            row = cur.fetchone()
    finally:
        conn.close()

    if row is None:
        log.warning("unknown product", extra={"fields": {"product.id": product_id}})
        raise HTTPException(status_code=404, detail="unknown product")

    _, name, price_cents, weight_g = row
    log.info("priced product", extra={"fields": {"product.id": product_id, "price_cents": price_cents}})
    return {"id": product_id, "name": name, "price_cents": price_cents, "weight_g": weight_g, "currency": "EUR"}
