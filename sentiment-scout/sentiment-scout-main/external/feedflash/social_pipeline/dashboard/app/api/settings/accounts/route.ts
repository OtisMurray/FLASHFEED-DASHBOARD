import { NextRequest } from "next/server";
import { getSQL } from "@/lib/postgres";

// GET /api/settings/accounts?platform=twitter — list watched accounts
// POST /api/settings/accounts — add account { platform, handle }
// PATCH /api/settings/accounts — toggle enabled { id, enabled }
// DELETE /api/settings/accounts?id=N — delete account

export async function GET(request: NextRequest) {
    const platform = request.nextUrl.searchParams.get("platform");
    const sql = getSQL();

    const rows = platform
        ? await sql`
        SELECT id, platform, handle, enabled, created_at
        FROM watched_accounts
        WHERE platform = ${platform}
        ORDER BY handle
      `
        : await sql`
        SELECT id, platform, handle, enabled, created_at
        FROM watched_accounts
        ORDER BY platform, handle
      `;

    return Response.json({ data: rows });
}

export async function POST(request: NextRequest) {
    const body = await request.json();
    const { platform, handle } = body;

    if (!platform?.trim() || !handle?.trim()) {
        return Response.json({ error: "platform and handle are required" }, { status: 400 });
    }

    const validPlatforms = ["twitter", "bluesky", "reddit"];
    if (!validPlatforms.includes(platform.trim().toLowerCase())) {
        return Response.json(
            { error: `platform must be one of: ${validPlatforms.join(", ")}` },
            { status: 400 }
        );
    }

    const sql = getSQL();

    try {
        const rows = await sql`
      INSERT INTO watched_accounts (platform, handle)
      VALUES (${platform.trim().toLowerCase()}, ${handle.trim()})
      RETURNING id, platform, handle, enabled, created_at
    `;
        return Response.json({ data: rows[0] }, { status: 201 });
    } catch (err: any) {
        if (err?.message?.includes("duplicate") || err?.message?.includes("unique")) {
            return Response.json({ error: "Account already exists" }, { status: 409 });
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
    await sql`UPDATE watched_accounts SET enabled = ${enabled} WHERE id = ${id}`;
    return Response.json({ success: true });
}

export async function DELETE(request: NextRequest) {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
        return Response.json({ error: "id query param required" }, { status: 400 });
    }

    const sql = getSQL();
    await sql`DELETE FROM watched_accounts WHERE id = ${parseInt(id, 10)}`;
    return Response.json({ success: true });
}
