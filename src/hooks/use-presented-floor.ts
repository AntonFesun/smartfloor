"use client";

import { useMemo } from "react";
import { replayAt } from "@/domain/replay";
import { useRealtime } from "@/hooks/use-realtime";
import { useReplayStore } from "@/store/replay-store";
import type { Order, RestaurantTable, WaiterCall } from "@/types";

export function usePresentedFloor(): {
  mode: "LIVE" | "REPLAY";
  readOnly: boolean;
  sequence: number;
  tables: RestaurantTable[];
  orders: Order[];
  waiterCalls: WaiterCall[];
} {
  const { tables, orders, waiterCalls, journal } = useRealtime();
  const mode = useReplayStore((state) => state.mode);
  const sequence = useReplayStore((state) => state.sequence);
  const projected = useMemo(
    () => (mode === "REPLAY" ? replayAt(tables, journal, sequence) : null),
    [mode, tables, journal, sequence],
  );
  if (!projected) {
    return { mode: "LIVE", readOnly: false, sequence, tables, orders, waiterCalls };
  }
  return {
    mode: "REPLAY",
    readOnly: true,
    sequence: projected.sequence,
    tables: projected.tables,
    orders: projected.orders,
    waiterCalls: projected.waiterCalls,
  };
}
