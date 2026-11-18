"use client";

import { useEffect, useState } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { RESTAURANT_TIME_ZONE } from "@/domain/journal";
import { Button } from "@/components/ui/button";
import { useRealtime } from "@/hooks/use-realtime";
import { REPLAY_SPEEDS, useReplayStore, type ReplaySpeed } from "@/store/replay-store";

export function ReplayBar() {
  const { journal, refresh } = useRealtime();
  const mode = useReplayStore((state) => state.mode);
  const sequence = useReplayStore((state) => state.sequence);
  const playing = useReplayStore((state) => state.playing);
  const speed = useReplayStore((state) => state.speed);
  const enter = useReplayStore((state) => state.enter);
  const scrub = useReplayStore((state) => state.scrub);
  const step = useReplayStore((state) => state.step);
  const setPlaying = useReplayStore((state) => state.setPlaying);
  const setSpeed = useReplayStore((state) => state.setSpeed);
  const tick = useReplayStore((state) => state.tick);
  const exit = useReplayStore((state) => state.exit);
  const [error, setError] = useState<string | null>(null);
  const max = journal.reduce((highest, event) => Math.max(highest, event.sequence), 0);
  const at = journal.reduce<(typeof journal)[number] | null>((best, event) => {
    if (event.sequence > sequence) return best;
    if (!best || event.sequence > best.sequence) return event;
    return best;
  }, null);

  useEffect(() => {
    if (mode === "REPLAY" && sequence > max) scrub(max);
  }, [mode, sequence, max, scrub]);

  useEffect(() => {
    if (mode !== "REPLAY" || !playing) return;
    const timer = window.setInterval(() => tick(max), Math.round(1000 / speed));
    return () => window.clearInterval(timer);
  }, [mode, playing, speed, max, tick]);

  async function returnToLive() {
    setError(null);
    try {
      await refresh();
      exit();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load a fresh snapshot");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <span className={`rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide ${mode === "REPLAY" ? "bg-amber-500/20 text-amber-100" : "bg-emerald-500/15 text-emerald-200"}`}>
        {mode}
      </span>
      {mode === "LIVE" ? (
        <>
          <span className="text-xs text-muted-foreground">
            {journal.length === 0 ? "Journal is empty. Service from before the journal is not reconstructed." : `${journal.length} journal events`}
          </span>
          <Button size="sm" variant="secondary" onClick={() => enter(max)}>
            Replay
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-[9rem] text-xs text-muted-foreground" title={at?.occurredAt}>
            {at ? formatWhen(at.occurredAt) : "Before the journal"}
          </span>
          <Button size="sm" variant="secondary" aria-label="Step back" onClick={() => step(-1, max)}>
            <SkipBack className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="secondary" aria-label={playing ? "Pause" : "Play"} disabled={max === 0} onClick={() => setPlaying(!playing, max)}>
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button size="sm" variant="secondary" aria-label="Step forward" onClick={() => step(1, max)}>
            <SkipForward className="h-3.5 w-3.5" />
          </Button>
          <input
            aria-label="Journal sequence"
            type="range"
            min={0}
            max={max}
            value={Math.min(sequence, max)}
            onChange={(event) => scrub(Number(event.target.value))}
            className="w-40 accent-amber-300"
          />
          <span className="text-xs tabular-nums text-muted-foreground">
            {Math.min(sequence, max)} / {max}
          </span>
          {REPLAY_SPEEDS.map((value) => (
            <Button key={value} size="sm" variant={speed === value ? "default" : "ghost"} onClick={() => setSpeed(value as ReplaySpeed)}>
              {value}x
            </Button>
          ))}
          <Button size="sm" onClick={() => void returnToLive()}>
            Return to Live
          </Button>
          {journal.length === 0 && <span className="text-xs text-muted-foreground">No journal history to replay.</span>}
        </>
      )}
      {error && <span className="text-xs text-red-300">{error}</span>}
    </div>
  );
}

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: RESTAURANT_TIME_ZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}
