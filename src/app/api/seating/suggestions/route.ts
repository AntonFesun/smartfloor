import { z } from "zod";
import { suggestSeating } from "@/domain/seating";
import { ZONES } from "@/types";
import { getDb } from "@/lib/db";
import { listReservations, listTableGroups } from "@/lib/seating";
import { ok, toErrorResponse } from "@/server/http";

const schema = z.object({
  partySize: z.number().int().min(1).max(24),
  start: z.string().min(1),
  durationMinutes: z.number().int().min(30).max(300).optional(),
  zone: z.enum(ZONES).nullable().optional(),
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const db = getDb();
    const tables = db.prepare("SELECT id, number, zone, shape, x, y, rotation, capacity, occupied_seat_count, status FROM tables").all() as {
      id: string;
      number: number;
      zone: "Main Hall" | "Terrace" | "Bar Lounge";
      shape: "circle" | "rect";
      x: number;
      y: number;
      rotation: number;
      capacity: 2 | 4 | 6 | 8;
      occupied_seat_count: number;
      status: "AVAILABLE" | "OCCUPIED" | "RESERVED";
    }[];
    const suggestions = suggestSeating(
      tables.map((row) => ({
        id: row.id,
        number: row.number,
        zone: row.zone,
        shape: row.shape,
        x: row.x,
        y: row.y,
        rotation: row.rotation,
        capacity: row.capacity,
        occupiedSeatCount: row.occupied_seat_count,
        status: row.status,
      })),
      listReservations(db),
      listTableGroups(db),
      body,
      Date.now(),
    );
    return ok({ suggestions });
  } catch (error) {
    return toErrorResponse(error);
  }
}
