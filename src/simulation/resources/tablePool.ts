import type { LayoutTable } from "../models/types";

export type TableState = "free" | "occupied" | "dirty";

export interface TableRuntime {
  spec: LayoutTable;
  state: TableState;
  partyId: string | null;
  partySize: number;
  stateSince: number;
  occupiedSeconds: number;
  dirtySeconds: number;
  seatings: number;
}

export class DoubleSeatingError extends Error {
  constructor(tableId: string, partyId: string, currentState: TableState, holder: string | null) {
    super(`Cannot seat ${partyId} at ${tableId}: table is ${currentState}${holder ? ` (party ${holder})` : ""}`);
    this.name = "DoubleSeatingError";
  }
}

/** Owns every table's state. The only way to seat a party is `seat`, which refuses non-free tables. */
export class TablePool {
  private readonly byId = new Map<string, TableRuntime>();
  private readonly ordered: TableRuntime[];
  readonly maxCapacity: number;

  constructor(layout: readonly LayoutTable[]) {
    this.ordered = layout.map((spec) => {
      const runtime: TableRuntime = {
        spec,
        state: "free",
        partyId: null,
        partySize: 0,
        stateSince: 0,
        occupiedSeconds: 0,
        dirtySeconds: 0,
        seatings: 0,
      };
      this.byId.set(spec.id, runtime);
      return runtime;
    });
    this.maxCapacity = layout.reduce((m, t) => Math.max(m, t.capacity), 0);
  }

  all(): readonly TableRuntime[] {
    return this.ordered;
  }

  get(id: string): TableRuntime {
    const table = this.byId.get(id);
    if (!table) throw new Error(`Unknown table ${id}`);
    return table;
  }

  count(): number {
    return this.ordered.length;
  }

  occupiedInZone(zoneId: string): number {
    let n = 0;
    for (const t of this.ordered) if (t.spec.zoneId === zoneId && t.state !== "free") n++;
    return n;
  }

  /**
   * Best free table for a party: least wasted seats, then the quietest zone
   * (fewest non-free tables), then the lowest table number. Fully deterministic.
   */
  pickBest(partySize: number): TableRuntime | null {
    let best: TableRuntime | null = null;
    let bestWaste = 0;
    let bestZoneLoad = 0;
    for (const t of this.ordered) {
      if (t.state !== "free" || t.spec.capacity < partySize) continue;
      const waste = t.spec.capacity - partySize;
      const zoneLoad = this.occupiedInZone(t.spec.zoneId);
      if (
        best === null ||
        waste < bestWaste ||
        (waste === bestWaste && (zoneLoad < bestZoneLoad || (zoneLoad === bestZoneLoad && t.spec.number < best.spec.number)))
      ) {
        best = t;
        bestWaste = waste;
        bestZoneLoad = zoneLoad;
      }
    }
    return best;
  }

  seat(tableId: string, partyId: string, partySize: number, now: number): TableRuntime {
    const table = this.get(tableId);
    if (table.state !== "free") throw new DoubleSeatingError(tableId, partyId, table.state, table.partyId);
    if (partySize > table.spec.capacity) throw new Error(`Party ${partyId} of ${partySize} exceeds capacity of ${tableId}`);
    table.state = "occupied";
    table.partyId = partyId;
    table.partySize = partySize;
    table.stateSince = now;
    table.seatings++;
    return table;
  }

  markDirty(tableId: string, now: number): void {
    const table = this.get(tableId);
    if (table.state !== "occupied") throw new Error(`Table ${tableId} is not occupied`);
    table.occupiedSeconds += now - table.stateSince;
    table.state = "dirty";
    table.partyId = null;
    table.partySize = 0;
    table.stateSince = now;
  }

  clean(tableId: string, now: number): void {
    const table = this.get(tableId);
    if (table.state !== "dirty") throw new Error(`Table ${tableId} is not dirty`);
    table.dirtySeconds += now - table.stateSince;
    table.state = "free";
    table.stateSince = now;
  }

  occupiedSecondsAt(now: number): number {
    let total = 0;
    for (const t of this.ordered) total += t.occupiedSeconds + (t.state === "occupied" ? now - t.stateSince : 0);
    return total;
  }

  dirtySecondsAt(now: number): number {
    let total = 0;
    for (const t of this.ordered) total += t.dirtySeconds + (t.state === "dirty" ? now - t.stateSince : 0);
    return total;
  }
}
