"use client";

import { useState } from "react";
import type { SeatingSuggestion } from "@/domain/seating";
import { AppShell } from "@/components/dashboard/app-shell";
import { FloorCanvas } from "@/components/three/floor-canvas";
import { Button } from "@/components/ui/button";
import { useRealtime } from "@/hooks/use-realtime";
import { useReplayReadOnly, useReplayStore } from "@/store/replay-store";
import { api } from "@/lib/client-api";
import { ZONES, type ZoneName } from "@/types";

export function HostScreen() {
  const { reservations, tableGroups, now } = useRealtime();
  const readOnly = useReplayReadOnly();
  const [partySize, setPartySize] = useState(4);
  const [start, setStart] = useState(() => toLocalInput(new Date(Date.now() + 3 * 60 * 60 * 1000)));
  const [duration, setDuration] = useState(90);
  const [zone, setZone] = useState<ZoneName | "">("");
  const [suggestions, setSuggestions] = useState<SeatingSuggestion[]>([]);
  const [picked, setPicked] = useState<SeatingSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await api<{ suggestions: SeatingSuggestion[] }>("/api/seating/suggestions", {
        method: "POST",
        body: JSON.stringify({
          partySize,
          start: new Date(start).toISOString(),
          durationMinutes: duration,
          zone: zone || null,
        }),
      });
      setSuggestions(result.suggestions);
      setPicked(result.suggestions[0] ?? null);
      if (result.suggestions.length === 0) setError("No table is free for that party and time.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not rank tables");
    } finally {
      setPending(false);
    }
  }

  async function confirm() {
    if (useReplayStore.getState().mode === "REPLAY" || !picked) return;
    setPending(true);
    setError(null);
    try {
      await api("/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          tableIds: picked.tableIds,
          partySize,
          start: new Date(start).toISOString(),
          durationMinutes: duration,
        }),
      });
      setSuggestions([]);
      setPicked(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Booking was rejected");
    } finally {
      setPending(false);
    }
  }

  return (
    <AppShell panel={false}>
      <div className="grid h-full min-h-0 lg:grid-cols-[380px_1fr]">
        <div className="overflow-auto border-r p-4">
          <h1 className="text-lg font-semibold">Host</h1>
          <p className="mt-1 text-xs text-muted-foreground">Suggestions are ranked the same way every time. QR codes stay on the original tables.</p>
          <form className="mt-3 space-y-2" onSubmit={(event) => void search(event)}>
            <label className="block text-xs text-muted-foreground">
              Party size
              <input type="number" min={1} max={24} value={partySize} onChange={(event) => setPartySize(Number(event.target.value))} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" />
            </label>
            <label className="block text-xs text-muted-foreground">
              Time
              <input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" />
            </label>
            <label className="block text-xs text-muted-foreground">
              Duration (minutes)
              <input type="number" min={30} max={300} value={duration} onChange={(event) => setDuration(Number(event.target.value))} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" />
            </label>
            <label className="block text-xs text-muted-foreground">
              Preferred zone
              <select value={zone} onChange={(event) => setZone(event.target.value as ZoneName | "")} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm">
                <option value="">Any</option>
                {ZONES.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={readOnly || pending}>Rank tables</Button>
          </form>
          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
          <ul className="mt-3 space-y-2">
            {suggestions.map((suggestion) => (
              <li key={suggestion.tableIds.join("-")}>
                <button
                  type="button"
                  onClick={() => setPicked(suggestion)}
                  className={`w-full rounded-lg border p-3 text-left ${picked?.tableIds.join() === suggestion.tableIds.join() ? "border-amber-300" : ""}`}
                >
                  <div className="font-medium">{suggestion.tableIds.join(" + ")} · {suggestion.capacity} seats</div>
                  <ul className="mt-1 text-xs text-muted-foreground">
                    {suggestion.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </button>
              </li>
            ))}
          </ul>
          {picked && (
            <div className="mt-3 rounded-lg border border-amber-300/40 p-3 text-sm">
              Preview {picked.tableIds.join(" + ")} · combined {picked.capacity}
              <Button className="mt-2 w-full" disabled={readOnly || pending} onClick={() => void confirm()}>Confirm booking</Button>
            </div>
          )}
          <h2 className="mt-6 text-sm font-semibold">Reservations</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {reservations.filter((item) => item.status === "CONFIRMED" || item.status === "SEATED" || (item.status === "COMPLETED" && Date.parse(item.end) >= now - 18 * 60 * 60 * 1000)).map((reservation) => (
              <li key={reservation.id} className="rounded-md border px-2 py-2">
                {reservation.partySize} · {reservation.tableId ?? tableGroups.find((group) => group.id === reservation.groupId)?.tableIds.join(" + ")} · {reservation.status}
                {reservation.status === "CONFIRMED" && (
                  <Button size="sm" variant="ghost" className="ml-2" disabled={readOnly} onClick={() => { if (!readOnly) void api(`/api/reservations/${reservation.id}/cancel`, { method: "POST" }); }}>Cancel</Button>
                )}
              </li>
            ))}
          </ul>
          <h2 className="mt-4 text-sm font-semibold">Groups</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {tableGroups.filter((group) => group.status === "ACTIVE").map((group) => (
              <li key={group.id} className="rounded-md border px-2 py-2">
                {group.tableIds.join(" + ")}
                <Button size="sm" variant="ghost" className="ml-2" disabled={readOnly} onClick={() => { if (!readOnly) void api(`/api/table-groups/${group.id}/dissolve`, { method: "POST" }); }}>Dissolve</Button>
              </li>
            ))}
          </ul>
        </div>
        <FloorCanvas highlightIds={picked?.tableIds ?? []} />
      </div>
    </AppShell>
  );
}

function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
