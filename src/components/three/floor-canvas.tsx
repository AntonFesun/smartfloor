"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { HeatmapLegend } from "@/components/dashboard/heatmap-legend";
import { Button } from "@/components/ui/button";
import { usePresentedFloor } from "@/hooks/use-presented-floor";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/lib/client-api";
import { useReplayStore } from "@/store/replay-store";
import { useUiStore } from "@/store/ui-store";
import type { FloorMarker } from "@/components/floor/floor-plan";
import type { RestaurantTable, WaiterCall } from "@/types";
import type { Waiter, WaiterShift, WaiterTask, WaiterZoneAssignment } from "@/domain/waiters";
import { isActiveTask } from "@/domain/waiters";
import type { ZoneOverlayZone } from "@/components/three/zone-overlay";

const ZONE_BOXES = [
  { name: "Main Hall", x: -3.25, z: 0, width: 10.9, depth: 11.2 },
  { name: "Terrace", x: 5.85, z: -3.05, width: 5.5, depth: 5.1 },
  { name: "Bar Lounge", x: 5.85, z: 3.55, width: 5.5, depth: 4.1 },
];

function zoneLabels(
  tables: { id: string; zone: string }[],
  waiters: Waiter[],
  shifts: WaiterShift[],
  assignments: WaiterZoneAssignment[],
  tasks: WaiterTask[],
  calls: WaiterCall[],
  now: number,
): ZoneOverlayZone[] {
  const nowIso = new Date(now).toISOString();
  const onDuty = new Set(
    shifts.filter((shift) => shift.startedAt <= nowIso && (shift.endedAt == null || shift.endedAt > nowIso)).map((shift) => shift.waiterId),
  );
  return ZONE_BOXES.map((zone) => {
    const names = assignments
      .filter((assignment) => assignment.zone === zone.name && onDuty.has(assignment.waiterId))
      .map((assignment) => waiters.find((waiter) => waiter.id === assignment.waiterId)?.name ?? assignment.waiterId);
    const tableIds = new Set(tables.filter((table) => table.zone === zone.name).map((table) => table.id));
    const needsHelp =
      calls.some((call) => call.status !== "RESOLVED" && tableIds.has(call.tableId)) ||
      tasks.some((task) => isActiveTask(task.status) && task.assignedWaiterId == null && tableIds.has(task.tableId));
    return { ...zone, waiters: names, needsHelp };
  });
}

const Scene = dynamic(() => import("@/components/three/restaurant-scene"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-muted-foreground">Loading the dining room…</div>,
});

export function FloorCanvas({ highlightIds = [], tables: tablesOverride, markers = [] }: { highlightIds?: string[]; tables?: RestaurantTable[]; markers?: FloorMarker[] }) {
  const live = usePresentedFloor();
  const tables = tablesOverride ?? live.tables;
  const orders = tablesOverride ? [] : live.orders;
  const waiterCalls = tablesOverride ? [] : live.waiterCalls;
  const readOnly = tablesOverride ? true : live.readOnly;
  const { waiters, shifts, zoneAssignments, waiterTasks, now } = useRealtime();
  const selectedId = useUiStore((state) => state.selectedTableId);
  const selectTable = useUiStore((state) => state.selectTable);
  const preset = useUiStore((state) => state.cameraPreset);
  const nonce = useUiStore((state) => state.cameraNonce);
  const bumpCamera = useUiStore((state) => state.bumpCamera);
  const [error, setError] = useState<string | null>(null);
  const selected = tables.find((table) => table.id === selectedId) ?? null;

  async function act(path: string) {
    if (useReplayStore.getState().mode === "REPLAY") return;
    setError(null);
    try {
      await api(path, { method: "POST" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed");
    }
  }

  return (
    <div className="relative h-full min-h-[420px] bg-[#101218]">
      <Scene
        tables={tables}
        orders={orders}
        calls={waiterCalls}
        zones={tablesOverride ? [] : zoneLabels(tables, waiters, shifts, zoneAssignments, readOnly ? [] : waiterTasks, waiterCalls, now)}
        highlightIds={highlightIds}
        selectedId={selectedId}
        preset={preset}
        nonce={nonce}
        focus={selected ? [selected.x, 0, selected.y] : null}
        onSelect={selectTable}
        onAcknowledge={(id) => act(`/api/waiter/${id}/acknowledge`)}
        onResolve={(id) => act(`/api/waiter/${id}/resolve`)}
        readOnly={readOnly}
        markers={markers}
      />
      <div className="absolute right-3 top-3 flex gap-1">
        <Button size="sm" variant="secondary" onClick={() => bumpCamera("iso")}>
          Iso
        </Button>
        <Button size="sm" variant="secondary" onClick={() => bumpCamera("top")}>
          Top
        </Button>
        <Button size="sm" variant="secondary" disabled={!selected} onClick={() => bumpCamera("focus")}>
          Focus
        </Button>
      </div>
      {tablesOverride ? null : <HeatmapLegend />}
      {error && <div className="absolute bottom-3 right-3 rounded-md bg-red-950/85 px-3 py-2 text-xs text-red-100">{error}</div>}
    </div>
  );
}
