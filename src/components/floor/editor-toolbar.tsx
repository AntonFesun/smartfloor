"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/lib/client-api";
import { useReplayReadOnly, useReplayStore } from "@/store/replay-store";
import { useUiStore } from "@/store/ui-store";
import { CAPACITIES, ZONES, type Capacity, type TableShape, type ZoneName } from "@/types";

export function EditorToolbar() {
  const { tables } = useRealtime();
  const readOnly = useReplayReadOnly();
  const editMode = useUiStore((state) => state.editMode);
  const setEditMode = useUiStore((state) => state.setEditMode);
  const selectedId = useUiStore((state) => state.selectedTableId);
  const [zone, setZone] = useState<ZoneName>("Main Hall");
  const [shape, setShape] = useState<TableShape>("circle");
  const [capacity, setCapacity] = useState<Capacity>(4);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selected = tables.find((table) => table.id === selectedId) ?? null;

  async function run(action: () => Promise<unknown>) {
    if (useReplayStore.getState().mode === "REPLAY") return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update the layout");
    } finally {
      setPending(false);
    }
  }

  async function saveSelected(patch: Partial<{ x: number; y: number; rotation: number; shape: TableShape; capacity: Capacity; zone: ZoneName }>) {
    if (!selected) return;
    await api("/api/layout", {
      method: "PUT",
      body: JSON.stringify({
        tables: tables.map((table) => ({
          id: table.id,
          x: table.x,
          y: table.y,
          rotation: table.rotation,
          shape: table.shape,
          capacity: table.capacity,
          zone: table.zone,
          ...(table.id === selected.id ? patch : {}),
        })),
      }),
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <Button size="sm" variant={editMode ? "default" : "outline"} disabled={readOnly} onClick={() => setEditMode(!editMode)}>
        {editMode ? "Editing layout" : "Edit layout"}
      </Button>
      <span className="text-xs text-muted-foreground">{editMode ? "Drag a table. Service actions stay in the side panel." : "Turn on edit mode to move the floor."}</span>
      {editMode && !readOnly && (
        <>
          <Select value={zone} onChange={(value) => setZone(value as ZoneName)} options={ZONES} />
          <Select value={shape} onChange={(value) => setShape(value as TableShape)} options={["circle", "rect"]} />
          <Select value={String(capacity)} onChange={(value) => setCapacity(Number(value) as Capacity)} options={CAPACITIES.map(String)} />
          <Button size="sm" variant="secondary" disabled={readOnly || pending} onClick={() => run(() => api("/api/tables", { method: "POST", body: JSON.stringify({ zone, shape, capacity }) }))}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
          {selected && (
            <>
              <Button size="sm" variant="outline" disabled={readOnly || pending} onClick={() => run(() => saveSelected({ rotation: selected.rotation - 15 }))}>
                −15°
              </Button>
              <Button size="sm" variant="outline" disabled={readOnly || pending} onClick={() => run(() => saveSelected({ rotation: selected.rotation + 15 }))}>
                +15°
              </Button>
              <Select
                value={selected.shape}
                onChange={(value) => run(() => saveSelected({ shape: value as TableShape }))}
                options={["circle", "rect"]}
              />
              <Select
                value={String(selected.capacity)}
                onChange={(value) => run(() => saveSelected({ capacity: Number(value) as Capacity }))}
                options={CAPACITIES.map(String)}
              />
              <Select value={selected.zone} onChange={(value) => run(() => saveSelected({ zone: value as ZoneName }))} options={ZONES} />
              <Button size="sm" variant="destructive" disabled={readOnly || pending} onClick={() => run(() => api(`/api/tables/${selected.id}`, { method: "DELETE" }))}>
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            </>
          )}
        </>
      )}
      {error && <span className="text-xs text-red-300">{error}</span>}
    </div>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: readonly string[] }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
