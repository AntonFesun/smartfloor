import type Database from "better-sqlite3";
import { DomainError } from "@/domain/errors";
import type { RestaurantEvent } from "@/domain/journal";
import { ZONES, type ZoneName } from "@/types";
import {
  chooseWaiter,
  type Waiter,
  type WaiterShift,
  type WaiterTask,
  type WaiterTaskType,
  type WaiterZoneAssignment,
} from "@/domain/waiters";
import type { JournalCommand } from "@/lib/journal";
import { appendCommandEvent } from "@/lib/journal";
import { nid } from "@/lib/ids";

const STAFF: { id: string; name: string; zone: ZoneName }[] = [
  { id: "waiter-marta", name: "Marta Kovacs", zone: "Main Hall" },
  { id: "waiter-sofia", name: "Sofia Kravets", zone: "Main Hall" },
  { id: "waiter-oleh", name: "Oleh Petrenko", zone: "Terrace" },
  { id: "waiter-iryna", name: "Iryna Melnyk", zone: "Bar Lounge" },
];

interface TaskRow {
  id: string;
  type: WaiterTaskType;
  table_id: string;
  order_id: string | null;
  call_id: string | null;
  assigned_waiter_id: string | null;
  status: WaiterTask["status"];
  priority: number;
  created_at: string;
  acknowledged_at: string | null;
  completed_at: string | null;
}

export function migrateWaiters(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS waiters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS waiter_shifts (
      id TEXT PRIMARY KEY,
      waiter_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS waiter_zone_assignments (
      id TEXT PRIMARY KEY,
      waiter_id TEXT NOT NULL,
      zone TEXT NOT NULL,
      UNIQUE (waiter_id, zone)
    );
  `);
  addColumn(db, "waiter_tasks", "call_id", "TEXT");
  addColumn(db, "waiter_tasks", "acknowledged_at", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_active_call_task
      ON waiter_tasks(call_id)
      WHERE type = 'respond_to_call' AND status IN ('OPEN', 'ACKNOWLEDGED') AND call_id IS NOT NULL;
  `);
  if ((db.prepare("SELECT COUNT(*) AS c FROM waiters").get() as { c: number }).c === 0) {
    seedStaff(db, Date.now());
  }
}

export function seedStaff(db: Database.Database, now: number): void {
  const started = new Date(now - 60 * 60 * 1000).toISOString();
  const insertWaiter = db.prepare("INSERT INTO waiters (id, name) VALUES (?, ?)");
  const insertShift = db.prepare("INSERT INTO waiter_shifts (id, waiter_id, started_at, ended_at) VALUES (?, ?, ?, NULL)");
  const insertZone = db.prepare("INSERT INTO waiter_zone_assignments (id, waiter_id, zone) VALUES (?, ?, ?)");
  for (const person of STAFF) {
    insertWaiter.run(person.id, person.name);
    insertShift.run(nid("shift"), person.id, started);
    insertZone.run(nid("wza"), person.id, person.zone);
  }
}

export function listWaiters(db: Database.Database): Waiter[] {
  return db.prepare("SELECT id, name FROM waiters ORDER BY id ASC").all() as Waiter[];
}

export function listShifts(db: Database.Database): WaiterShift[] {
  return (db.prepare("SELECT * FROM waiter_shifts ORDER BY started_at ASC").all() as { id: string; waiter_id: string; started_at: string; ended_at: string | null }[]).map(
    (row) => ({ id: row.id, waiterId: row.waiter_id, startedAt: row.started_at, endedAt: row.ended_at }),
  );
}

export function listZoneAssignments(db: Database.Database): WaiterZoneAssignment[] {
  return (db.prepare("SELECT * FROM waiter_zone_assignments ORDER BY zone, waiter_id").all() as { id: string; waiter_id: string; zone: string }[]).map((row) => ({
    id: row.id,
    waiterId: row.waiter_id,
    zone: row.zone,
  }));
}

export function listWaiterTasks(db: Database.Database): WaiterTask[] {
  return (db.prepare("SELECT * FROM waiter_tasks ORDER BY created_at ASC, id ASC").all() as TaskRow[]).map(mapTask);
}

export function assignForZone(db: Database.Database, zone: string, nowIso: string): string | null {
  return chooseWaiter({
    zone,
    now: nowIso,
    waiters: listWaiters(db),
    shifts: listShifts(db),
    assignments: listZoneAssignments(db),
    tasks: listWaiterTasks(db),
  });
}

export function createAssignedTask(
  db: Database.Database,
  command: JournalCommand,
  journal: RestaurantEvent[],
  input: {
    type: WaiterTaskType;
    tableId: string;
    zone: string;
    orderId?: string | null;
    callId?: string | null;
    priority: number;
    occurredAt: string;
  },
): { task: WaiterTask; unassigned: boolean } {
  if (input.callId) {
    const duplicate = db
      .prepare("SELECT id FROM waiter_tasks WHERE call_id = ? AND type = 'respond_to_call' AND status IN ('OPEN', 'ACKNOWLEDGED')")
      .get(input.callId) as { id: string } | undefined;
    if (duplicate) throw new DomainError("duplicate_task", "This request already has an active task", 409);
  }
  const assignedWaiterId = assignForZone(db, input.zone, input.occurredAt);
  const id = nid("task");
  db.prepare(
    `INSERT INTO waiter_tasks (
      id, type, order_id, table_id, call_id, status, priority, created_at, acknowledged_at, completed_at, assigned_waiter_id
    ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, NULL, NULL, ?)`,
  ).run(id, input.type, input.orderId ?? null, input.tableId, input.callId ?? null, input.priority, input.occurredAt, assignedWaiterId);
  const task = mapTask(db.prepare("SELECT * FROM waiter_tasks WHERE id = ?").get(id) as TaskRow);
  journal.push(
    appendCommandEvent(db, command, {
      type: "WAITER_TASK_CREATED",
      occurredAt: input.occurredAt,
      tableId: input.tableId,
      orderId: input.orderId ?? null,
      waiterId: assignedWaiterId,
      zoneId: input.zone,
      payload: { task, unassigned: assignedWaiterId == null },
    }),
  );
  return { task, unassigned: assignedWaiterId == null };
}

export function acknowledgeCallTask(db: Database.Database, callId: string, occurredAt: string): WaiterTask | null {
  const row = db
    .prepare("SELECT * FROM waiter_tasks WHERE call_id = ? AND type = 'respond_to_call' AND status = 'OPEN'")
    .get(callId) as TaskRow | undefined;
  if (!row) return null;
  db.prepare("UPDATE waiter_tasks SET status = 'ACKNOWLEDGED', acknowledged_at = ? WHERE id = ?").run(occurredAt, row.id);
  return mapTask(db.prepare("SELECT * FROM waiter_tasks WHERE id = ?").get(row.id) as TaskRow);
}

export function completeCallTask(
  db: Database.Database,
  command: JournalCommand,
  journal: RestaurantEvent[],
  callId: string,
  occurredAt: string,
): WaiterTask | null {
  const row = db
    .prepare("SELECT * FROM waiter_tasks WHERE call_id = ? AND type = 'respond_to_call' AND status IN ('OPEN', 'ACKNOWLEDGED')")
    .get(callId) as TaskRow | undefined;
  if (!row) return null;
  db.prepare(
    "UPDATE waiter_tasks SET status = 'COMPLETED', completed_at = ?, acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?",
  ).run(occurredAt, occurredAt, row.id);
  const task = mapTask(db.prepare("SELECT * FROM waiter_tasks WHERE id = ?").get(row.id) as TaskRow);
  journal.push(
    appendCommandEvent(db, command, {
      type: "WAITER_TASK_COMPLETED",
      occurredAt,
      tableId: task.tableId,
      waiterId: task.assignedWaiterId,
      payload: { task },
    }),
  );
  return task;
}

export function createManagerTask(
  db: Database.Database,
  input: { type: WaiterTaskType; tableId: string },
  now = Date.now(),
): { task: WaiterTask; unassigned: boolean; journal: RestaurantEvent[] } {
  if (input.type === "respond_to_call" || input.type === "deliver_order") {
    throw new DomainError("invalid_transition", "Call and delivery tasks are created by service events", 409);
  }
  return db.transaction(() => {
    const table = db.prepare("SELECT zone FROM tables WHERE id = ?").get(input.tableId) as { zone: string } | undefined;
    if (!table) throw new DomainError("not_found", "Table not found", 404);
    const journal: RestaurantEvent[] = [];
    const command = { id: nid("cmd"), written: 0 };
    const created = createAssignedTask(db, command, journal, {
      type: input.type,
      tableId: input.tableId,
      zone: table.zone,
      priority: 1,
      occurredAt: new Date(now).toISOString(),
    });
    return { ...created, journal };
  })();
}

export function reassignTask(db: Database.Database, taskId: string, waiterId: string | null, now = Date.now()): { task: WaiterTask; journal: RestaurantEvent[] } {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM waiter_tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!row) throw new DomainError("not_found", "Task not found", 404);
    if (row.status === "COMPLETED") throw new DomainError("invalid_transition", "A completed task cannot be reassigned", 409);
    if (waiterId && !db.prepare("SELECT id FROM waiters WHERE id = ?").get(waiterId)) {
      throw new DomainError("not_found", "Waiter not found", 404);
    }
    const occurredAt = new Date(now).toISOString();
    db.prepare("UPDATE waiter_tasks SET assigned_waiter_id = ? WHERE id = ?").run(waiterId, taskId);
    const task = mapTask(db.prepare("SELECT * FROM waiter_tasks WHERE id = ?").get(taskId) as TaskRow);
    const journal: RestaurantEvent[] = [];
    const command = { id: nid("cmd"), written: 0 };
    journal.push(
      appendCommandEvent(db, command, {
        type: "WAITER_ASSIGNED",
        occurredAt,
        tableId: task.tableId,
        orderId: task.orderId,
        waiterId,
        payload: { taskId, from: row.assigned_waiter_id, to: waiterId },
      }),
    );
    return { task, journal };
  })();
}

export function setShift(db: Database.Database, waiterId: string, action: "start" | "end", now = Date.now()): WaiterShift {
  if (!db.prepare("SELECT id FROM waiters WHERE id = ?").get(waiterId)) throw new DomainError("not_found", "Waiter not found", 404);
  const occurredAt = new Date(now).toISOString();
  if (action === "end") {
    const open = db.prepare("SELECT id FROM waiter_shifts WHERE waiter_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(waiterId) as
      | { id: string }
      | undefined;
    if (!open) throw new DomainError("invalid_transition", "This waiter is already off duty", 409);
    db.prepare("UPDATE waiter_shifts SET ended_at = ? WHERE id = ?").run(occurredAt, open.id);
  } else {
    const open = db.prepare("SELECT id FROM waiter_shifts WHERE waiter_id = ? AND ended_at IS NULL").get(waiterId);
    if (open) throw new DomainError("invalid_transition", "This waiter is already on duty", 409);
    db.prepare("INSERT INTO waiter_shifts (id, waiter_id, started_at, ended_at) VALUES (?, ?, ?, NULL)").run(nid("shift"), waiterId, occurredAt);
  }
  return listShifts(db).filter((shift) => shift.waiterId === waiterId).at(-1)!;
}

export function setWaiterZones(db: Database.Database, waiterId: string, zones: ZoneName[]): WaiterZoneAssignment[] {
  if (!db.prepare("SELECT id FROM waiters WHERE id = ?").get(waiterId)) throw new DomainError("not_found", "Waiter not found", 404);
  const unique = [...new Set(zones)];
  for (const zone of unique) {
    if (!(ZONES as readonly string[]).includes(zone)) throw new DomainError("bad_zone", "Unknown zone");
  }
  db.prepare("DELETE FROM waiter_zone_assignments WHERE waiter_id = ?").run(waiterId);
  const insert = db.prepare("INSERT INTO waiter_zone_assignments (id, waiter_id, zone) VALUES (?, ?, ?)");
  for (const zone of unique) insert.run(nid("wza"), waiterId, zone);
  return listZoneAssignments(db).filter((assignment) => assignment.waiterId === waiterId);
}

function mapTask(row: TaskRow): WaiterTask {
  return {
    id: row.id,
    type: row.type,
    tableId: row.table_id,
    orderId: row.order_id,
    callId: row.call_id,
    assignedWaiterId: row.assigned_waiter_id,
    status: row.status,
    priority: row.priority,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    completedAt: row.completed_at,
  };
}

function addColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
