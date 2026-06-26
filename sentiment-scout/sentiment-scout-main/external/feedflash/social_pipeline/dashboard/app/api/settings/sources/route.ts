import { NextRequest } from "next/server";
import { getSQL } from "@/lib/postgres";

// GET /api/settings/sources — list all RSS sources
// POST /api/settings/sources — add source { name, url, category }
// PATCH /api/settings/sources — toggle enabled { id, enabled }
// DELETE /api/settings/sources?id=N — delete source

export async function GET() {
    const sql = getSQL();
    const rows = await sql`
    SELECT id, name, url, category, enabled, created_at
    FROM rss_sources
    ORDER BY category, name
  `;
    return Response.json({ data: rows });
}

export async function POST(request: NextRequest) {
    const body = await request.json();
    const { name, url, category } = body;

    if (!name?.trim() || !url?.trim()) {
        return Response.json({ error: "name and url are required" }, { status: 400 });
    }

    const sql = getSQL();

    try {
        const rows = await sql`
      INSERT INTO rss_sources (name, url, category)
      VALUES (${name.trim()}, ${url.trim()}, ${category || "markets"})
      RETURNING id, name, url, category, enabled, created_at
    `;
        return Response.json({ data: rows[0] }, { status: 201 });
    } catch (err: any) {
        if (err?.message?.includes("duplicate") || err?.message?.includes("unique")) {
            return Response.json({ error: "Source URL already exists" }, { status: 409 });
        }
        throw err;
    }
}

export async function PATCH(request: NextRequest) {
    const body = await request.json();
    const { id, enabled } = body;

    if (id == null || enabled == null) {
        return Response.json({ error: "id and enabled are required" }, { status: 400 });
    }

    const sql = getSQL();
    await sql`UPDATE rss_sources SET enabled = ${enabled} WHERE id = ${id}`;
    return Response.json({ success: true });
}

export async function DELETE(request: NextRequest) {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
        return Response.json({ error: "id query param required" }, { status: 400 });
    }

    const sql = getSQL();
    await sql`DELETE FROM rss_sources WHERE id = ${parseInt(id, 10)}`;
    return Response.json({ success: true });
}
