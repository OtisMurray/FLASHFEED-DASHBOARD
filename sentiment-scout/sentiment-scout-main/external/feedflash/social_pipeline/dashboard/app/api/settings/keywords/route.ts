import { NextRequest } from "next/server";
import { getSQL } from "@/lib/postgres";

// GET /api/settings/keywords — list all keywords
// POST /api/settings/keywords — add keyword { keyword, category }
// PATCH /api/settings/keywords — toggle enabled { id, enabled }
// DELETE /api/settings/keywords?id=N — delete keyword

export async function GET() {
    const sql = getSQL();
    const rows = await sql`
    SELECT id, keyword, category, enabled, created_at
    FROM filter_keywords
    ORDER BY category, keyword
  `;
    return Response.json({ data: rows });
}

export async function POST(request: NextRequest) {
    const body = await request.json();
    const { keyword, category } = body;

    if (!keyword?.trim()) {
        return Response.json({ error: "keyword is required" }, { status: 400 });
    }

    const sql = getSQL();
    const now = Math.floor(Date.now() / 1000);

    try {
        const rows = await sql`
      INSERT INTO filter_keywords (keyword, category, created_at)
      VALUES (${keyword.trim().toLowerCase()}, ${category || "general"}, ${now})
      RETURNING id, keyword, category, enabled, created_at
    `;
        return Response.json({ data: rows[0] }, { status: 201 });
    } catch (err: any) {
        if (err?.message?.includes("duplicate") || err?.message?.includes("unique")) {
            return Response.json({ error: "Keyword already exists" }, { status: 409 });
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
    await sql`UPDATE filter_keywords SET enabled = ${enabled} WHERE id = ${id}`;
    return Response.json({ success: true });
}

export async function DELETE(request: NextRequest) {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
        return Response.json({ error: "id query param required" }, { status: 400 });
    }

    const sql = getSQL();
    await sql`DELETE FROM filter_keywords WHERE id = ${parseInt(id, 10)}`;
    return Response.json({ success: true });
}
