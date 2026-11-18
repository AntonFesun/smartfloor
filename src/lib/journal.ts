import type Database from "better-sqlite3";
import { DomainError } from "@/domain/errors";
import {
  JOURNAL_SCHEMA_VERSION,
  RESTAURANT_ID,
  RESTAURANT_TIME_ZONE,
  isJournalEventType,
  projectRestaurantState,
  resolveTimeRange,
  type JournalEventType,
  type ProjectedRestaurantState,
  type RestaurantBaseline,
  type RestaurantEvent,
  type TimeRange,
} from "@/domain/journal";
import { nid } from "@/lib/ids";
import type { Order, RestaurantTable, WaiterCall } from "@/types";

export interface JournalDraft {
  type: JournalEventType;
  occurredAt: string;
  tableId?: string | null;
  orderId?: string | null;
  waiterId?: string | null;
  zoneId?: string | null;
  sessionId?: string | null;
  payload?: Record<string, unknown>;
}

export interface JournalCommand {
  id: string;
  idempotencyKey?: string;
  written: number;
}

export interface EventQuery {
  restaurantId?: string;
  tableId?: string;
  waiterId?: string;
  zoneId?: string;
  orderId?: string;
  types?: JournalEventType[];
  from?: string;
  to?: string;
  range?: TimeRange;
  now?: number;
  timeZone?: string;
  afterSequence?: number;
  limit?: number;
}

interface EventRow {
  sequence: number;
  id: string;
  restaurant_id: string;
  table_id: string | null;
  order_id: string | null;
  waiter_id: string | null;
  zone_id: string | null;
  session_id: string | null;
  type: string;
  occurred_at: string;
  payload: string;
  schema_version: number;
  idempotency_key: string | null;
  command_id: string;
}

const TYPE_LIST = [
  "TABLE_OCCUPIED",
  "TABLE_RELEASED",
  "TABLE_MOVED",
  "TABLE_STATUS_CHANGED",
  "GUEST_SEATED",
  "GUEST_LEFT",
  "ORDER_CREATED",
  "ORDER_ACCEPTED",
  "ORDER_PREPARING",
  "ORDER_READY",
  "ORDER_SERVED",
  "ORDER_CANCELLED",
  "KITCHEN_TICKET_CREATED",
  "KITCHEN_TICKET_STARTED",
  "KITCHEN_TICKET_READY",
  "WAITER_CALLED",
  "WAITER_CALL_ACKNOWLEDGED",
  "WAITER_CALL_RESOLVED",
  "WAITER_ASSIGNED",
  "WAITER_TASK_CREATED",
  "WAITER_TASK_COMPLETED",
  "RESERVATION_CREATED",
  "RESERVATION_UPDATED",
  "RESERVATION_CANCELLED",
  "TABLE_GROUP_CREATED",
  "TABLE_GROUP_DISSOLVED",
  "PAYMENT_RECORDED",
].join("', '");

export function migrateJournal(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS restaurant_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      restaurant_id TEXT NOT NULL,
      table_id TEXT,
      order_id TEXT,
      waiter_id TEXT,
      zone_id TEXT,
      session_id TEXT,
      type TEXT NOT NULL CHECK (type IN ('${TYPE_LIST}')),
      occurred_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      idempotency_key TEXT,
      command_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_events_idem
      ON restaurant_events(restaurant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_restaurant_events_sequence ON restaurant_events(sequence);
    CREATE INDEX IF NOT EXISTS idx_restaurant_events_restaurant_time ON restaurant_events(restaurant_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_restaurant_events_table_time ON restaurant_events(table_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_restaurant_events_zone_time ON restaurant_events(zone_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_restaurant_events_order_time ON restaurant_events(order_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_restaurant_events_waiter_time ON restaurant_events(waiter_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_restaurant_events_command ON restaurant_events(command_id);
    CREATE TABLE IF NOT EXISTS restaurant_state_snapshots (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      captured_at TEXT NOT NULL,
      state TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_restaurant_sequence
      ON restaurant_state_snapshots(restaurant_id, sequence);
  `);
}

export function startCommand(db: Database.Database, idempotencyKey?: string): { replay: RestaurantEvent[] | null; command: JournalCommand } {
  const key = normalizeKey(idempotencyKey);
  if (key) {
    const existing = findByKey(db, key);
    if (existing) return { replay: listCommand(db, existing.commandId), command: { id: existing.commandId, idempotencyKey: key, written: 1 } };
  }
  return { replay: null, command: { id: nid("cmd"), idempotencyKey: key, written: 0 } };
}

export function appendCommandEvent(db: Database.Database, command: JournalCommand, draft: JournalDraft): RestaurantEvent {
  const event = insertEvent(db, {
    ...draft,
    commandId: command.id,
    idempotencyKey: command.written === 0 ? command.idempotencyKey ?? null : null,
  });
  command.written += 1;
  return event;
}

export function getEvents(db: Database.Database, query: EventQuery = {}): { events: RestaurantEvent[]; nextCursor: number | null } {
  const restaurantId = query.restaurantId ?? RESTAURANT_ID;
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  let from = query.from;
  let to = query.to;
  if (query.range) {
    const resolved = resolveTimeRange(query.range, query.now ?? Date.now(), query.timeZone ?? RESTAURANT_TIME_ZONE);
    from = resolved.from;
    to = resolved.to;
  }
  if (query.types) {
    for (const type of query.types) {
      if (!isJournalEventType(type)) throw new DomainError("bad_event_type", `Unknown journal event type ${type}`);
    }
  }
  const where = ["restaurant_id = @restaurantId", "sequence > @afterSequence"];
  const params: Record<string, unknown> = {
    restaurantId,
    afterSequence: query.afterSequence ?? 0,
    limit,
  };
  if (query.tableId) {
    where.push("table_id = @tableId");
    params.tableId = query.tableId;
  }
  if (query.waiterId) {
    where.push("waiter_id = @waiterId");
    params.waiterId = query.waiterId;
  }
  if (query.zoneId) {
    where.push("zone_id = @zoneId");
    params.zoneId = query.zoneId;
  }
  if (query.orderId) {
    where.push("order_id = @orderId");
    params.orderId = query.orderId;
  }
  if (from) {
    where.push("occurred_at >= @from");
    params.from = from;
  }
  if (to) {
    where.push("occurred_at < @to");
    params.to = to;
  }
  if (query.types && query.types.length === 0) return { events: [], nextCursor: null };
  if (query.types && query.types.length > 0) {
    const names = query.types.map((type, index) => {
      const key = `type${index}`;
      params[key] = type;
      return `@${key}`;
    });
    where.push(`type IN (${names.join(", ")})`);
  }
  const rows = db.prepare(`SELECT * FROM restaurant_events WHERE ${where.join(" AND ")} ORDER BY sequence ASC LIMIT @limit`).all(params) as EventRow[];
  const events = rows.map(mapEvent);
  const nextCursor = events.length === limit ? events[events.length - 1]?.sequence ?? null : null;
  return { events, nextCursor };
}

export function getEventsForTable(db: Database.Database, tableId: string, query: EventQuery = {}) {
  return getEvents(db, { ...query, tableId });
}

export function getEventsForZone(db: Database.Database, zoneId: string, query: EventQuery = {}) {
  return getEvents(db, { ...query, zoneId });
}

export function getEventsBetween(db: Database.Database, from: string, to: string, query: EventQuery = {}) {
  return getEvents(db, { ...query, from, to, range: undefined });
}

export function listAllEvents(db: Database.Database): RestaurantEvent[] {
  const events: RestaurantEvent[] = [];
  let after = 0;
  for (let page = 0; page < 100; page += 1) {
    const result = getEvents(db, { afterSequence: after, limit: 500 });
    events.push(...result.events);
    if (result.nextCursor == null || result.events.length === 0) break;
    after = result.nextCursor;
  }
  return events;
}

export function captureRestaurantSnapshot(
  db: Database.Database,
  state: { tables: RestaurantTable[]; orders: Order[]; waiterCalls: WaiterCall[] },
  now = Date.now(),
): { id: string; sequence: number } {
  const sequence = maxSequence(db);
  const id = nid("snap");
  db.prepare(
    `INSERT INTO restaurant_state_snapshots (id, restaurant_id, sequence, captured_at, state)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, RESTAURANT_ID, sequence, new Date(now).toISOString(), JSON.stringify(state));
  return { id, sequence };
}

export function getRestaurantStateAt(
  db: Database.Database,
  target: { sequence: number } | { at: string },
): ProjectedRestaurantState {
  const targetSequence = "sequence" in target ? target.sequence : sequenceAt(db, target.at);
  const snapshot = db
    .prepare(
      `SELECT sequence, state FROM restaurant_state_snapshots
       WHERE restaurant_id = ? AND sequence <= ?
       ORDER BY sequence DESC LIMIT 1`,
    )
    .get(RESTAURANT_ID, targetSequence) as { sequence: number; state: string } | undefined;
  const parsed = snapshot ? (JSON.parse(snapshot.state) as { tables?: RestaurantTable[]; orders?: Order[]; waiterCalls?: WaiterCall[] }) : {};
  const baseline: RestaurantBaseline = {
    sequence: snapshot?.sequence ?? 0,
    tables: parsed.tables ?? [],
    orders: parsed.orders ?? [],
    waiterCalls: parsed.waiterCalls ?? [],
  };
  const rows = db
    .prepare(
      `SELECT * FROM restaurant_events
       WHERE restaurant_id = ? AND sequence > ? AND sequence <= ?
       ORDER BY sequence ASC`,
    )
    .all(RESTAURANT_ID, baseline.sequence, targetSequence) as EventRow[];
  return projectRestaurantState(baseline, rows.map(mapEvent), targetSequence);
}

function insertEvent(db: Database.Database, draft: JournalDraft & { commandId: string; idempotencyKey: string | null }): RestaurantEvent {
  if (!isJournalEventType(draft.type)) throw new DomainError("bad_event_type", `Unknown journal event type ${draft.type}`);
  const id = nid("rev");
  const payload = draft.payload ?? {};
  db.prepare(
    `INSERT INTO restaurant_events (
      id, restaurant_id, table_id, order_id, waiter_id, zone_id, session_id,
      type, occurred_at, payload, schema_version, idempotency_key, command_id
    ) VALUES (
      @id, @restaurantId, @tableId, @orderId, @waiterId, @zoneId, @sessionId,
      @type, @occurredAt, @payload, @schemaVersion, @idempotencyKey, @commandId
    )`,
  ).run({
    id,
    restaurantId: RESTAURANT_ID,
    tableId: draft.tableId ?? null,
    orderId: draft.orderId ?? null,
    waiterId: draft.waiterId ?? null,
    zoneId: draft.zoneId ?? null,
    sessionId: draft.sessionId ?? null,
    type: draft.type,
    occurredAt: draft.occurredAt,
    payload: JSON.stringify(payload),
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    idempotencyKey: draft.idempotencyKey,
    commandId: draft.commandId,
  });
  const row = db.prepare("SELECT * FROM restaurant_events WHERE id = ?").get(id) as EventRow;
  return mapEvent(row);
}

function findByKey(db: Database.Database, key: string): RestaurantEvent | null {
  const row = db.prepare("SELECT * FROM restaurant_events WHERE restaurant_id = ? AND idempotency_key = ?").get(RESTAURANT_ID, key) as EventRow | undefined;
  return row ? mapEvent(row) : null;
}

function listCommand(db: Database.Database, commandId: string): RestaurantEvent[] {
  return (db.prepare("SELECT * FROM restaurant_events WHERE command_id = ? ORDER BY sequence ASC").all(commandId) as EventRow[]).map(mapEvent);
}

function maxSequence(db: Database.Database): number {
  const row = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM restaurant_events WHERE restaurant_id = ?").get(RESTAURANT_ID) as { sequence: number };
  return row.sequence;
}

function sequenceAt(db: Database.Database, at: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM restaurant_events WHERE restaurant_id = ? AND occurred_at <= ?")
    .get(RESTAURANT_ID, at) as { sequence: number };
  return row.sequence;
}

function mapEvent(row: EventRow): RestaurantEvent {
  if (!isJournalEventType(row.type)) throw new DomainError("bad_event_type", `Stored journal type ${row.type} is not supported`);
  return {
    id: row.id,
    sequence: row.sequence,
    restaurantId: row.restaurant_id,
    tableId: row.table_id,
    orderId: row.order_id,
    waiterId: row.waiter_id,
    zoneId: row.zone_id,
    sessionId: row.session_id,
    type: row.type,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    schemaVersion: row.schema_version,
    idempotencyKey: row.idempotency_key,
    commandId: row.command_id,
  };
}

function normalizeKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 200) throw new DomainError("bad_idempotency_key", "Idempotency key is too long");
  return trimmed;
}
