"use client";

import { useState } from "react";
import { waiterLoadMetrics, type WaiterTaskType } from "@/domain/waiters";
import { AppShell } from "@/components/dashboard/app-shell";
import { Button } from "@/components/ui/button";
import { useRealtime } from "@/hooks/use-realtime";
import { useReplayReadOnly, useReplayStore } from "@/store/replay-store";
import { api } from "@/lib/client-api";
import { formatDuration } from "@/lib/format";
import { ZONES } from "@/types";

export function WaitersScreen() {
  const { waiters, shifts, zoneAssignments, waiterTasks, tables, now, metrics } = useRealtime();
  const readOnly = useReplayReadOnly();
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<WaiterTaskType>("general_assistance");
  const [tableId, setTableId] = useState(tables[0]?.id ?? "T07");
  const load = waiterLoadMetrics(waiterTasks, now, metrics?.thresholds.waiterMs ?? 180000);
  const nowIso = new Date(now).toISOString();
  const recentTasks = waiterTasks.filter((task) => task.status !== "COMPLETED" || (task.completedAt != null && Date.parse(task.completedAt) >= now - 18 * 60 * 60 * 1000));

  async function run(action: () => Promise<unknown>) {
    if (useReplayStore.getState().mode === "REPLAY") return;
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed");
    }
  }

  return (
    <AppShell panel={false}>
      <div className="h-full overflow-auto p-4">
        <div className="mb-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>Active {load.active}</span>
          <span>Completed {load.completed}</span>
          <span>Overdue {load.overdue}</span>
          <span>Avg response {load.avgResponseMs == null ? "No data" : formatDuration(load.avgResponseMs)}</span>
          <span>Avg completion {load.avgCompletionMs == null ? "No data" : formatDuration(load.avgCompletionMs)}</span>
        </div>
        {error && <p className="mb-3 text-sm text-red-300">{error}</p>}
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">On the floor</h2>
            {waiters.map((waiter) => {
              const open = shifts.some((shift) => shift.waiterId === waiter.id && shift.startedAt <= nowIso && (shift.endedAt == null || shift.endedAt > nowIso));
              const zones = zoneAssignments.filter((assignment) => assignment.waiterId === waiter.id).map((assignment) => assignment.zone);
              return (
                <article key={waiter.id} className="rounded-lg border bg-card/50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">{waiter.name}</div>
                      <div className="text-xs text-muted-foreground">{open ? "On duty" : "Off duty"}</div>
                    </div>
                    <Button size="sm" variant="secondary" disabled={readOnly} onClick={() => void run(() => api(`/api/waiters/${waiter.id}/shift`, { method: "POST", body: JSON.stringify({ action: open ? "end" : "start" }) }))}>
                      {open ? "End shift" : "Start shift"}
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {ZONES.map((zone) => {
                      const on = zones.includes(zone);
                      return (
                        <Button
                          key={zone}
                          size="sm"
                          variant={on ? "default" : "outline"}
                          disabled={readOnly}
                          onClick={() =>
                            void run(() =>
                              api(`/api/waiters/${waiter.id}/zones`, {
                                method: "POST",
                                body: JSON.stringify({ zones: on ? zones.filter((item) => item !== zone) : [...zones, zone] }),
                              }),
                            )
                          }
                        >
                          {zone}
                        </Button>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </section>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Tasks</h2>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => api("/api/waiter/tasks", { method: "POST", body: JSON.stringify({ type, tableId }) }));
              }}
            >
              <select value={type} onChange={(event) => setType(event.target.value as WaiterTaskType)} className="h-8 rounded-md border bg-background px-2 text-xs">
                <option value="general_assistance">General assistance</option>
                <option value="clear_table">Clear table</option>
                <option value="seat_guests">Seat guests</option>
              </select>
              <select value={tableId} onChange={(event) => setTableId(event.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
                {tables.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.id}
                  </option>
                ))}
              </select>
              <Button size="sm" type="submit" disabled={readOnly}>Add task</Button>
            </form>
            {recentTasks.length === 0 && <p className="text-sm text-muted-foreground">No tasks yet.</p>}
            {recentTasks.map((task) => (
              <article key={task.id} className={`rounded-lg border p-3 ${task.assignedWaiterId == null && task.status !== "COMPLETED" ? "border-orange-500/50" : "bg-card/40"}`}>
                <div className="flex items-start justify-between gap-2 text-sm">
                  <div>
                    <div className="font-medium">{task.tableId} · {task.type.replaceAll("_", " ")}</div>
                    <div className="text-xs text-muted-foreground">{task.status} · priority {task.priority}</div>
                  </div>
                  {task.assignedWaiterId == null && task.status !== "COMPLETED" && <span className="text-xs text-orange-200">Unassigned</span>}
                </div>
                {task.status !== "COMPLETED" && (
                  <select
                    className="mt-2 h-8 w-full rounded-md border bg-background px-2 text-xs"
                    disabled={readOnly}
                    value={task.assignedWaiterId ?? ""}
                    onChange={(event) =>
                      void run(() =>
                        api(`/api/waiter/tasks/${task.id}/reassign`, {
                          method: "POST",
                          body: JSON.stringify({ waiterId: event.target.value || null }),
                        }),
                      )
                    }
                  >
                    <option value="">Unassigned</option>
                    {waiters.map((waiter) => (
                      <option key={waiter.id} value={waiter.id}>
                        {waiter.name}
                      </option>
                    ))}
                  </select>
                )}
              </article>
            ))}
          </section>
        </div>
      </div>
    </AppShell>
  );
}
