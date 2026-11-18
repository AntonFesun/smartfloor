"use client";

import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/dashboard/app-shell";
import { FloorPlan, type FloorMarker, type FloorPath } from "@/components/floor/floor-plan";
import { FloorCanvas } from "@/components/three/floor-canvas";
import { Button } from "@/components/ui/button";
import { layoutFromRestaurant, menuFromRestaurant, visualTables } from "@/domain/simulation-layout";
import { api } from "@/lib/client-api";
import { formatUAH } from "@/lib/format";
import {
  SIMULATION_DISCLAIMER,
  SIMULATION_SPEEDS,
  createSimulation,
  createSimulationScenario,
  getSimulationMetrics,
  pauseSimulation,
  resetSimulation,
  resumeSimulation,
  runABComparison,
  setSimulationSpeed,
  simulationStateToVisualState,
  stepSimulation,
  tickSimulation,
  withOverrides,
  type ABComparison,
  type Simulation,
  type SimulationMetrics,
  type SimulationScenario,
  type SimulationVisualState,
} from "@/simulation";
import type { MenuItem, RestaurantTable } from "@/types";

type Speed = (typeof SIMULATION_SPEEDS)[number];

export function SimulatorScreen() {
  const simRef = useRef<Simulation | null>(null);
  const scenarioRef = useRef<SimulationScenario | null>(null);
  const layoutRef = useRef<ReturnType<typeof layoutFromRestaurant>>([]);
  const menuRef = useRef<ReturnType<typeof menuFromRestaurant>>([]);
  const rotationRef = useRef(new Map<string, number>());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("Dinner service");
  const [seed, setSeed] = useState("42");
  const [arrivals, setArrivals] = useState(18);
  const [waiters, setWaiters] = useState(3);
  const [kitchen, setKitchen] = useState(4);
  const [compareWaiters, setCompareWaiters] = useState(5);
  const [duration, setDuration] = useState<"1h" | "4h" | "shift">("1h");
  const [speed, setSpeed] = useState<Speed>(1);
  const [running, setRunning] = useState(false);
  const [visual, setVisual] = useState<SimulationVisualState | null>(null);
  const [metrics, setMetrics] = useState<SimulationMetrics | null>(null);
  const [comparison, setComparison] = useState<ABComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [saved, setSaved] = useState<{ id: string; name: string; updatedAt: string }[]>([]);

  function publish(sim: Simulation) {
    const frame = simulationStateToVisualState(sim.getFrame(), { startEpochMs: Date.now() - sim.now * 1000 });
    setVisual(frame);
    setMetrics(getSimulationMetrics(sim));
  }

  function mount(scenario: SimulationScenario) {
    scenarioRef.current = scenario;
    const sim = createSimulation(scenario);
    setSimulationSpeed(sim, speed);
    simRef.current = sim;
    setRunning(false);
    setComparison(null);
    publish(sim);
  }

  function buildFromControls() {
    const scenario = createSimulationScenario({
      name,
      seed,
      layout: layoutRef.current,
      menu: menuRef.current,
      waiterCount: waiters,
      kitchenCapacity: { hot: kitchen, cold: 2 },
      barCapacity: 2,
      arrivalsPerHour: arrivals,
      duration,
      layoutUnitsPerMeter: 1,
      servicePoint: { x: 2.4, y: 0 },
    });
    mount(scenario);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await api<{ tables: RestaurantTable[]; menu: MenuItem[] }>("/api/snapshot");
        if (cancelled) return;
        layoutRef.current = layoutFromRestaurant(snapshot.tables);
        menuRef.current = menuFromRestaurant(snapshot.menu);
        rotationRef.current = new Map(snapshot.tables.map((table) => [table.id, table.rotation]));
        const scenario = createSimulationScenario({
          name: "Dinner service",
          seed: "42",
          layout: layoutRef.current,
          menu: menuRef.current,
          waiterCount: 3,
          kitchenCapacity: { hot: 4, cold: 2 },
          barCapacity: 2,
          arrivalsPerHour: 18,
          duration: "1h",
          layoutUnitsPerMeter: 1,
          servicePoint: { x: 2.4, y: 0 },
        });
        if (cancelled) return;
        mount(scenario);
        setReady(true);
        const list = await api<{ scenarios: { id: string; name: string; updatedAt: string }[] }>("/api/simulation/scenarios");
        if (!cancelled) setSaved(list.scenarios);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load the floor");
      }
    })();
    return () => {
      cancelled = true;
    };
    // The first scenario uses the live layout once. Later changes go through Apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    let frameId = 0;
    const loop = (now: number) => {
      const sim = simRef.current;
      if (!sim) return;
      const result = tickSimulation(sim, now - last);
      last = now;
      setVisual(simulationStateToVisualState(result.frame, { startEpochMs: Date.now() - sim.now * 1000 }));
      setMetrics(getSimulationMetrics(sim));
      if (result.done) {
        pauseSimulation(sim);
        setRunning(false);
        return;
      }
      frameId = window.requestAnimationFrame(loop);
    };
    frameId = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frameId);
  }, [running]);

  const tables = visual ? visualTables(visual, rotationRef.current) : [];
  const markers: FloorMarker[] = (visual?.waiters ?? []).map((waiter, index) => ({
    id: waiter.id,
    x: waiter.x,
    y: waiter.y,
    label: String(index + 1),
  }));
  const paths: FloorPath[] = (visual?.navigationPaths ?? []).map((path) => ({ id: path.waiterId, points: path.points }));

  async function save() {
    const scenario = scenarioRef.current;
    if (!scenario) return;
    setError(null);
    try {
      await api("/api/simulation/scenarios", { method: "POST", body: JSON.stringify({ scenario: { ...scenario, name } }) });
      const list = await api<{ scenarios: { id: string; name: string; updatedAt: string }[] }>("/api/simulation/scenarios");
      setSaved(list.scenarios);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the scenario");
    }
  }

  async function load(id: string) {
    setError(null);
    try {
      const result = await api<{ scenario: SimulationScenario }>(`/api/simulation/scenarios/${id}`);
      const scenario = result.scenario;
      setName(scenario.name);
      setSeed(scenario.seed);
      setArrivals(scenario.arrivalsPerHour);
      setWaiters(scenario.waiters.length);
      setKitchen(scenario.stationCapacity.hot);
      const hours = scenario.durationSeconds / 3600;
      setDuration(hours >= 8 ? "shift" : hours >= 4 ? "4h" : "1h");
      mount(scenario);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the scenario");
    }
  }

  function compare() {
    const scenario = scenarioRef.current;
    if (!scenario) return;
    setComparing(true);
    setError(null);
    window.setTimeout(() => {
      try {
        const other = withOverrides(scenario, { waiterCount: compareWaiters });
        const result = runABComparison(scenario, other);
        setComparison(result.comparison);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Comparison failed");
      } finally {
        setComparing(false);
      }
    }, 0);
  }

  return (
    <AppShell panel={false}>
      <div className="grid h-full min-h-0 lg:grid-cols-[390px_1fr]">
        <div className="space-y-3 overflow-auto border-r p-3">
          <div>
            <h1 className="text-lg font-semibold">Simulator</h1>
            <p className="mt-1 text-xs text-muted-foreground">{SIMULATION_DISCLAIMER}</p>
          </div>
          {error && <p className="text-xs text-red-300">{error}</p>}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Field label="Seed" value={seed} onChange={setSeed} />
            <Field label="Arrivals / hour" value={String(arrivals)} onChange={(value) => setArrivals(Number(value) || 0)} />
            <Field label="Waiters" value={String(waiters)} onChange={(value) => setWaiters(Math.max(1, Number(value) || 1))} />
            <Field label="Hot kitchen slots" value={String(kitchen)} onChange={(value) => setKitchen(Math.max(1, Number(value) || 1))} />
          </div>
          <div className="flex flex-wrap gap-1">
            {(["1h", "4h", "shift"] as const).map((item) => (
              <Button key={item} size="sm" variant={duration === item ? "default" : "secondary"} onClick={() => setDuration(item)}>{item}</Button>
            ))}
            <Button size="sm" variant="outline" disabled={!ready} onClick={buildFromControls}>Apply</Button>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" disabled={!ready || running} onClick={() => { const sim = simRef.current; if (!sim) return; resumeSimulation(sim); setRunning(true); }}>Play</Button>
            <Button size="sm" variant="secondary" disabled={!running} onClick={() => { const sim = simRef.current; if (!sim) return; pauseSimulation(sim); setRunning(false); }}>Pause</Button>
            <Button size="sm" variant="secondary" disabled={!ready || running} onClick={() => { const sim = simRef.current; if (!sim) return; publishFromStep(sim); }}>Step</Button>
            <Button size="sm" variant="outline" disabled={!ready} onClick={() => { const sim = simRef.current; if (!sim) return; resetSimulation(sim); setRunning(false); publish(sim); }}>Reset</Button>
          </div>
          <div className="flex gap-1">
            {SIMULATION_SPEEDS.map((value) => (
              <Button key={value} size="sm" variant={speed === value ? "default" : "ghost"} onClick={() => { setSpeed(value); if (simRef.current) setSimulationSpeed(simRef.current, value); }}>{value}x</Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Virtual {visual ? clock(visual.simulatedSeconds) : "0:00:00"}
            {metrics ? ` · served ${metrics.guests.served} · rejected ${metrics.guests.rejected} · estimated ${formatUAH(metrics.orders.estimatedOrderValue)}` : ""}
          </p>
          {metrics && (
            <p className="text-[11px] text-muted-foreground">
              Waiter response {metrics.waits.waiterResponse.mean == null ? "n/a" : clock(metrics.waits.waiterResponse.mean)} · SLA {metrics.sla.total}
              {metrics.bottleneck.primary ? ` · bottleneck ${metrics.bottleneck.primary}` : ""}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Scenario name" value={name} onChange={(event) => setName(event.target.value)} className="h-8 flex-1 rounded-md border bg-background px-2 text-xs" />
            <Button size="sm" variant="secondary" disabled={!ready} onClick={() => void save()}>Save</Button>
          </div>
          <ul className="space-y-1 text-xs">
            {saved.length === 0 && <li className="text-muted-foreground">No saved scenarios yet.</li>}
            {saved.map((item) => (
              <li key={item.id}>
                <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => void load(item.id)}>{item.name}</button>
              </li>
            ))}
          </ul>
          <div className="rounded-md border p-2">
            <div className="text-xs font-medium">A/B waiters</div>
            <div className="mt-2 flex items-center gap-2">
              <Field label="B waiters" value={String(compareWaiters)} onChange={(value) => setCompareWaiters(Math.max(1, Number(value) || 1))} />
              <Button size="sm" disabled={!ready || comparing} onClick={compare}>{comparing ? "Running" : "Compare"}</Button>
            </div>
            {comparison && (
              <div className="mt-2 space-y-1 text-[11px]">
                {comparison.warnings.map((warning) => <p key={warning} className="text-amber-200">{warning}</p>)}
                {comparison.rows.map((row) => (
                  <div key={row.key} className="grid grid-cols-[1.4fr_repeat(4,0.7fr)] gap-1">
                    <span>{row.label}</span>
                    <span>{formatCell(row.a, row.unit)}</span>
                    <span>{formatCell(row.b, row.unit)}</span>
                    <span>{row.percentDiff == null ? "n/a" : `${row.percentDiff.toFixed(1)}%`}</span>
                    <span>{row.verdict}</span>
                  </div>
                ))}
                {comparison.insights.map((insight) => <p key={insight.id}>{insight.text}</p>)}
              </div>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">Amber tables need cleaning. Blue dots are simulated waiters. Nothing here is written to the live journal, kitchen, or waiter alerts.</p>
        </div>
        <div className="grid min-h-0 grid-cols-1 lg:grid-cols-2">
          <FloorPlan editable={false} tables={tables} markers={markers} paths={paths} />
          <FloorCanvas tables={tables} markers={markers} />
        </div>
      </div>
    </AppShell>
  );

  function publishFromStep(sim: Simulation) {
    const result = stepSimulation(sim, { events: 1 });
    setVisual(simulationStateToVisualState(result.frame, { startEpochMs: Date.now() - sim.now * 1000 }));
    setMetrics(getSimulationMetrics(sim));
  }
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-[11px] text-muted-foreground">
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs text-foreground" />
    </label>
  );
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatCell(value: number | null, unit: "seconds" | "count" | "ratio" | "currency"): string {
  if (value == null) return "n/a";
  if (unit === "currency") return formatUAH(value);
  if (unit === "ratio") return `${Math.round(value * 100)}%`;
  if (unit === "seconds") return clock(value);
  return String(Math.round(value));
}
