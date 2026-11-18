import type Database from "better-sqlite3";
import { DomainError } from "@/domain/errors";
import type { RestaurantEvent } from "@/domain/journal";
import { assertBookable, type Reservation, type ReservationStatus, type SeatingRequest, type TableGroup } from "@/domain/seating";
import { appendCommandEvent } from "@/lib/journal";
import { nid } from "@/lib/ids";
import type { RestaurantTable } from "@/types";

interface ReservationRow {
  id: string;
  party_size: number;
  start_at: string;
  end_at: string;
  table_id: string | null;
  group_id: string | null;
  status: ReservationStatus;
  created_at: string;
}

interface GroupRow {
  id: string;
  status: "ACTIVE" | "DISSOLVED";
  created_at: string;
  dissolved_at: string | null;
}

export function migrateSeating(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS table_groups (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dissolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS table_group_members (
      group_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      PRIMARY KEY (group_id, table_id)
    );
    CREATE TABLE IF NOT EXISTS reservation_intervals (
      id TEXT PRIMARY KEY,
      party_size INTEGER NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      table_id TEXT,
      group_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reservations_table ON reservation_intervals(table_id, start_at);
    CREATE INDEX IF NOT EXISTS idx_reservations_group ON reservation_intervals(group_id, start_at);
    CREATE INDEX IF NOT EXISTS idx_group_members_table ON table_group_members(table_id);
  `);
}

export function listReservations(db: Database.Database): Reservation[] {
  return (db.prepare("SELECT * FROM reservation_intervals ORDER BY start_at ASC, id ASC").all() as ReservationRow[]).map(mapReservation);
}

export function listTableGroups(db: Database.Database): TableGroup[] {
  const groups = db.prepare("SELECT * FROM table_groups ORDER BY created_at ASC").all() as GroupRow[];
  const members = db.prepare("SELECT group_id, table_id FROM table_group_members ORDER BY table_id ASC").all() as { group_id: string; table_id: string }[];
  return groups.map((group) => ({
    id: group.id,
    status: group.status,
    createdAt: group.created_at,
    dissolvedAt: group.dissolved_at,
    tableIds: members.filter((member) => member.group_id === group.id).map((member) => member.table_id),
  }));
}

export function bookTables(
  db: Database.Database,
  input: { tableIds: string[]; partySize: number; start: string; durationMinutes?: number },
  now = Date.now(),
): { reservation: Reservation; group: TableGroup | null; journal: RestaurantEvent[] } {
  const request: SeatingRequest = { partySize: input.partySize, start: input.start, durationMinutes: input.durationMinutes };
  const run = db.transaction(() => {
    const tables = readTables(db);
    const reservations = listReservations(db);
    const groups = listTableGroups(db);
    assertBookable(tables, reservations, groups, input.tableIds, request, now);
    const journal: RestaurantEvent[] = [];
    const command = { id: nid("cmd"), written: 0 };
    const occurredAt = new Date(now).toISOString();
    const end = new Date(Date.parse(input.start) + (input.durationMinutes ?? 90) * 60_000).toISOString();
    let group: TableGroup | null = null;
    if (input.tableIds.length > 1) {
      group = findExactGroup(groups, input.tableIds) ?? createGroup(db, command, journal, input.tableIds, occurredAt);
    }
    const id = nid("rsv");
    db.prepare(
      `INSERT INTO reservation_intervals (id, party_size, start_at, end_at, table_id, group_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', ?)`,
    ).run(id, input.partySize, input.start, end, group ? null : input.tableIds[0], group?.id ?? null, occurredAt);
    const reservation = mapReservation(db.prepare("SELECT * FROM reservation_intervals WHERE id = ?").get(id) as ReservationRow);
    journal.push(
      appendCommandEvent(db, command, {
        type: "RESERVATION_CREATED",
        occurredAt,
        tableId: reservation.tableId,
        payload: { reservation },
      }),
    );
    return { reservation, group, journal };
  });
  return run.immediate();
}

export function cancelReservation(db: Database.Database, id: string, now = Date.now()): { reservation: Reservation; journal: RestaurantEvent[] } {
  const run = db.transaction(() => {
    const current = db.prepare("SELECT * FROM reservation_intervals WHERE id = ?").get(id) as ReservationRow | undefined;
    if (!current) throw new DomainError("not_found", "Reservation not found", 404);
    if (current.status === "CANCELLED" || current.status === "COMPLETED") {
      throw new DomainError("invalid_transition", `Cannot cancel a ${current.status} reservation`, 409);
    }
    db.prepare("UPDATE reservation_intervals SET status = 'CANCELLED' WHERE id = ?").run(id);
    const reservation = mapReservation(db.prepare("SELECT * FROM reservation_intervals WHERE id = ?").get(id) as ReservationRow);
    const journal: RestaurantEvent[] = [];
    const command = { id: nid("cmd"), written: 0 };
    journal.push(
      appendCommandEvent(db, command, {
        type: "RESERVATION_CANCELLED",
        occurredAt: new Date(now).toISOString(),
        tableId: reservation.tableId,
        payload: { reservation },
      }),
    );
    return { reservation, journal };
  });
  return run.immediate();
}

export function dissolveGroup(db: Database.Database, groupId: string, now = Date.now()): { group: TableGroup; journal: RestaurantEvent[] } {
  const run = db.transaction(() => {
    const groups = listTableGroups(db);
    const group = groups.find((item) => item.id === groupId);
    if (!group || group.status !== "ACTIVE") throw new DomainError("not_found", "Active group not found", 404);
    const openOrder = db
      .prepare(
        `SELECT id FROM orders WHERE table_id IN (${group.tableIds.map(() => "?").join(",")}) AND status NOT IN ('SERVED', 'CANCELLED') LIMIT 1`,
      )
      .get(...group.tableIds) as { id: string } | undefined;
    if (openOrder) throw new DomainError("group_busy", "Finish open orders before dissolving this group", 409);
    const activeCall = db
      .prepare(
        `SELECT id FROM waiter_calls WHERE table_id IN (${group.tableIds.map(() => "?").join(",")}) AND status IN ('ACTIVE', 'ACKNOWLEDGED') LIMIT 1`,
      )
      .get(...group.tableIds) as { id: string } | undefined;
    if (activeCall) throw new DomainError("group_busy", "Resolve waiter calls before dissolving this group", 409);
    const reservation = listReservations(db).find(
      (item) => item.groupId === groupId && (item.status === "CONFIRMED" || item.status === "SEATED") && Date.parse(item.end) > now,
    );
    if (reservation) throw new DomainError("group_busy", "Cancel the reservation before dissolving this group", 409);
    const occurredAt = new Date(now).toISOString();
    db.prepare("UPDATE table_groups SET status = 'DISSOLVED', dissolved_at = ? WHERE id = ?").run(occurredAt, groupId);
    const updated = listTableGroups(db).find((item) => item.id === groupId)!;
    const journal: RestaurantEvent[] = [];
    const command = { id: nid("cmd"), written: 0 };
    journal.push(
      appendCommandEvent(db, command, {
        type: "TABLE_GROUP_DISSOLVED",
        occurredAt,
        payload: { group: updated },
      }),
    );
    return { group: updated, journal };
  });
  return run.immediate();
}

function createGroup(
  db: Database.Database,
  command: { id: string; written: number },
  journal: RestaurantEvent[],
  tableIds: string[],
  occurredAt: string,
): TableGroup {
  const id = nid("grp");
  db.prepare("INSERT INTO table_groups (id, status, created_at, dissolved_at) VALUES (?, 'ACTIVE', ?, NULL)").run(id, occurredAt);
  const insert = db.prepare("INSERT INTO table_group_members (group_id, table_id) VALUES (?, ?)");
  for (const tableId of [...tableIds].sort()) insert.run(id, tableId);
  const group = listTableGroups(db).find((item) => item.id === id)!;
  journal.push(
    appendCommandEvent(db, command, {
      type: "TABLE_GROUP_CREATED",
      occurredAt,
      payload: { group },
    }),
  );
  return group;
}

function findExactGroup(groups: TableGroup[], tableIds: string[]): TableGroup | null {
  const want = [...tableIds].sort().join();
  return (
    groups.find((group) => group.status === "ACTIVE" && [...group.tableIds].sort().join() === want) ?? null
  );
}

function readTables(db: Database.Database): RestaurantTable[] {
  const rows = db.prepare("SELECT * FROM tables ORDER BY number ASC").all() as {
    id: string;
    number: number;
    zone: RestaurantTable["zone"];
    shape: RestaurantTable["shape"];
    x: number;
    y: number;
    rotation: number;
    capacity: RestaurantTable["capacity"];
    occupied_seat_count: number;
    status: RestaurantTable["status"];
  }[];
  return rows.map((row) => ({
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
  }));
}

function mapReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    partySize: row.party_size,
    start: row.start_at,
    end: row.end_at,
    tableId: row.table_id,
    groupId: row.group_id,
    status: row.status,
    createdAt: row.created_at,
  };
}
