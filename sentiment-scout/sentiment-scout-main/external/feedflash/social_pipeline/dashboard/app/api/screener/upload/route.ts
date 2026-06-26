import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongodb";

// ── Column name normalization (mirrors finviz_ingest.py) ───────────────────

function normalizeColumnName(name: string): string {
    let s = name.trim().toLowerCase();
    s = s.replace(/[./]/g, "_");
    s = s.replace(/[^a-z0-9_]/g, "_");
    s = s.replace(/_+/g, "_");
    return s.replace(/^_|_$/g, "");
}

// ── Value parsers ──────────────────────────────────────────────────────────

function parseMarketCap(value: string): number | null {
    if (!value || value.trim() === "-" || value.trim() === "") return null;
    const v = value.trim();
    const multipliers: Record<string, number> = {
        B: 1_000_000_000,
        M: 1_000_000,
        K: 1_000,
    };
    const suffix = v.slice(-1).toUpperCase();
    if (suffix in multipliers) {
        const num = parseFloat(v.slice(0, -1));
        return isNaN(num) ? null : num * multipliers[suffix];
    }
    const num = parseFloat(v);
    return isNaN(num) ? null : num;
}

function parsePercentage(value: string): number | null {
    if (!value || value.trim() === "-" || value.trim() === "") return null;
    const num = parseFloat(value.trim().replace(/%$/, ""));
    return isNaN(num) ? null : num;
}

function normalizeAnalystRecom(value: string): number | null {
    if (!value || value.trim() === "-" || value.trim() === "") return null;
    const v = parseFloat(value);
    if (isNaN(v)) return null;
    return (3.0 - v) / 2.0;
}

const PCT_COLUMNS = new Set([
    "change", "dividend_yield", "short_float", "short_ratio",
    "perf_week", "perf_month", "perf_quarter", "perf_half_y",
    "perf_year", "perf_ytd", "volatility_w", "volatility_m",
    "sma20", "sma50", "sma200", "52w_high", "52w_low",
    "from_open", "gap", "recom", "insider_own", "inst_own",
    "insider_trans", "inst_trans", "roa", "roe", "roi",
    "gross_margin", "oper_margin", "profit_margin", "payout",
]);

// ── CSV parsing ────────────────────────────────────────────────────────────

function parseCSV(text: string): Array<Record<string, string>> {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];

    // Split header, handling quoted values
    const headers = splitCSVLine(lines[0]);
    const rows: Array<Record<string, string>> = [];

    for (let i = 1; i < lines.length; i++) {
        const values = splitCSVLine(lines[i]);
        const row: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j].trim()] = (values[j] || "").trim();
        }
        rows.push(row);
    }
    return rows;
}

function splitCSVLine(line: string): string[] {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === "," && !inQuotes) {
            values.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    values.push(current);
    return values;
}

// ── POST handler ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get("file") as File | null;

        if (!file) {
            return Response.json({ error: "No file provided" }, { status: 400 });
        }

        const text = await file.text();
        const rawRows = parseCSV(text);

        if (rawRows.length === 0) {
            return Response.json({ error: "Empty CSV file" }, { status: 400 });
        }

        // Check for Ticker column
        const firstRow = rawRows[0];
        const tickerKey = Object.keys(firstRow).find(
            (k) => k.trim().toLowerCase() === "ticker"
        );
        if (!tickerKey) {
            return Response.json(
                { error: "CSV must contain a 'Ticker' column" },
                { status: 400 }
            );
        }

        // Build header mapping
        const rawHeaders = Object.keys(firstRow);
        const headerMap: Record<string, string> = {};
        for (const h of rawHeaders) {
            headerMap[h] = normalizeColumnName(h);
        }

        // Parse and normalize rows
        const db = await getDb();
        const collection = db.collection("finviz_screener");
        const now = new Date();
        let count = 0;

        for (const rawRow of rawRows) {
            const row: Record<string, unknown> = {};

            for (const [rawKey, normKey] of Object.entries(headerMap)) {
                const val = (rawRow[rawKey] || "").trim();

                if (normKey === "market_cap") {
                    row[normKey] = parseMarketCap(val);
                } else if (normKey === "analyst_recom") {
                    row[normKey] = normalizeAnalystRecom(val);
                    row["structured_sentiment"] = row[normKey];
                } else if (PCT_COLUMNS.has(normKey)) {
                    row[normKey] = parsePercentage(val);
                } else {
                    row[normKey] = val;
                }
            }

            // Ensure ticker is uppercase
            const ticker = String(row["ticker"] || "").toUpperCase();
            if (!ticker) continue;
            row["ticker"] = ticker;
            row["ingested_at"] = now;

            await collection.updateOne(
                { ticker },
                { $set: row },
                { upsert: true }
            );
            count++;
        }

        return Response.json({
            success: true,
            tickersUpserted: count,
            message: `Upserted ${count} ticker(s) from CSV`,
        });
    } catch (error) {
        console.error("CSV upload error:", error);
        return Response.json(
            { error: "Failed to process CSV" },
            { status: 500 }
        );
    }
}
