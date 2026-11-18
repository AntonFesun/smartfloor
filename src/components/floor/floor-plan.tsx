"use client";

import { useEffect, useRef, useState } from "react";
import { HeatmapLegend } from "@/components/dashboard/heatmap-legend";
import { STATUS_COLOR } from "@/domain/labels";
import { chairSlots, FLOOR, layoutErrorMessage, layoutIssues, rotatePoint, tableFootprint } from "@/domain/layout";
import { isActiveWaiter } from "@/domain/waiter";
import { usePresentedFloor } from "@/hooks/use-presented-floor";
import { api } from "@/lib/client-api";
import { useHeatmapStore } from "@/store/heatmap-store";
import { useReplayStore } from "@/store/replay-store";
import { useUiStore } from "@/store/ui-store";
import type { RestaurantTable } from "@/types";

export interface FloorMarker {
  id: string;
  x: number;
  y: number;
  label: string;
}

export interface FloorPath {
  id: string;
  points: { x: number; y: number }[];
}

function layoutOf(table: RestaurantTable) {
  return {
    id: table.id,
    x: table.x,
    y: table.y,
    rotation: table.rotation,
    shape: table.shape,
    capacity: table.capacity,
    zone: table.zone,
  };
}

export function FloorPlan({ editable, tables: tablesOverride, markers = [], paths = [] }: { editable: boolean; tables?: RestaurantTable[]; markers?: FloorMarker[]; paths?: FloorPath[] }) {
  const live = usePresentedFloor();
  const tables = tablesOverride ?? live.tables;
  const orders = tablesOverride ? [] : live.orders;
  const waiterCalls = tablesOverride ? [] : live.waiterCalls;
  const heatMode = useHeatmapStore((state) => state.mode);
  const heatColors = useHeatmapStore((state) => state.colors);
  const selectedId = useUiStore((state) => state.selectedTableId);
  const selectTable = useUiStore((state) => state.selectTable);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draft, setDraft] = useState(tables);
  const [dragId, setDragId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const draftRef = useRef(draft);
  const tablesRef = useRef(tables);
  draftRef.current = draft;
  tablesRef.current = tables;

  useEffect(() => {
    if (!dragId) setDraft(tables);
  }, [tables, dragId]);

  const pad = 0.85;
  const viewBox = `${FLOOR.minX - pad} ${-(FLOOR.maxY + pad)} ${FLOOR.maxX - FLOOR.minX + pad * 2} ${FLOOR.maxY - FLOOR.minY + pad * 2}`;
  const issues = layoutIssues(draft);
  const bad = new Set(issues.flatMap((issue) => [issue.id, issue.with ?? ""]));

  function toWorld(event: { clientX: number; clientY: number }) {
    const svg = svgRef.current;
    if (!svg) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: -local.y };
  }

  function moveDraft(id: string, x: number, y: number) {
    setDraft((current) => {
      const next = current.map((table) => (table.id === id ? { ...table, x, y } : table));
      draftRef.current = next;
      return next;
    });
  }

  async function finishDrag(id: string) {
    if (useReplayStore.getState().mode === "REPLAY") return;
    const next = draftRef.current;
    const source = tablesRef.current;
    const original = source.find((table) => table.id === id);
    const moved = next.find((table) => table.id === id);
    setDragId(null);
    if (!original || !moved || (original.x === moved.x && original.y === moved.y)) return;
    const problems = layoutIssues(next).filter((issue) => issue.id === id || issue.with === id);
    if (problems.length > 0) {
      setDraft(source);
      draftRef.current = source;
      setMessage(layoutErrorMessage(problems));
      return;
    }
    try {
      await api("/api/layout", { method: "PUT", body: JSON.stringify({ tables: next.map(layoutOf) }) });
      setMessage(null);
    } catch (error) {
      setDraft(source);
      draftRef.current = source;
      setMessage(error instanceof Error ? error.message : "Could not save the layout");
    }
  }

  return (
    <div className="relative h-full min-h-[420px] bg-[#101218]">
      <svg
        ref={svgRef}
        viewBox={viewBox}
        className="h-full w-full touch-none"
        role="img"
        aria-label="Restaurant floor plan"
      >
        <rect x={FLOOR.minX} y={-FLOOR.maxY} width={FLOOR.maxX - FLOOR.minX} height={FLOOR.maxY - FLOOR.minY} fill="#17130f" />
        <Zone x={-8.7} y={-5.6} w={10.9} h={11.2} fill="#241c16" label="Main Hall" />
        <Zone x={3.1} y={-5.6} w={5.5} h={5.1} fill="#1d2422" label="Terrace" />
        <Zone x={3.1} y={1.5} w={5.5} h={4.1} fill="#1a1412" label="Bar Lounge" />
        <rect x={7.95} y={-5.15} width={0.55} height={3.2} rx={0.08} fill="#3a261c" />
        {paths.map((path) => (
          <polyline key={path.id} points={path.points.map((point) => `${point.x},${-point.y}`).join(" ")} fill="none" stroke="#93c5fd" strokeWidth={0.05} pointerEvents="none" />
        ))}
        {draft.map((table) => {
          const footprint = tableFootprint(table);
          const call = waiterCalls.find((item) => item.tableId === table.id && isActiveWaiter(item.status));
          const hasNew = orders.some((order) => order.tableId === table.id && order.status === "NEW");
          const hasReady = orders.some((order) => order.tableId === table.id && order.status === "READY");
          const selected = table.id === selectedId;
          const radius = Math.max(footprint.w, footprint.h) / 2;
          const heat = tablesOverride ? null : heatMode === "heatmap" || heatMode === "revenue" ? heatColors[table.id] : null;
          return (
            <g key={table.id}>
              {chairSlots(table).map((slot, index) => {
                const world = rotatePoint(slot.x, slot.y, table.rotation);
                const occupied = index < table.occupiedSeatCount;
                return (
                  <circle
                    key={index}
                    cx={table.x + world.x}
                    cy={-(table.y + world.y)}
                    r={0.16}
                    fill={occupied ? "#e0c09a" : "#2a303a"}
                    pointerEvents="none"
                  />
                );
              })}
              {heat && <circle cx={table.x} cy={-table.y} r={radius + 0.36} fill={heat} opacity={0.45} pointerEvents="none" />}
              {call && (
                <circle cx={table.x} cy={-table.y} r={radius + 0.2} fill="none" stroke={call.status === "ACTIVE" ? "#ef4444" : "#f97316"} strokeWidth={0.06}>
                  <animate attributeName="r" values={`${radius + 0.15};${radius + 0.62}`} dur="1.3s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.9;0" dur="1.3s" repeatCount="indefinite" />
                </circle>
              )}
              {table.shape === "circle" ? (
                <ellipse
                  cx={table.x}
                  cy={-table.y}
                  rx={footprint.w / 2}
                  ry={footprint.h / 2}
                  fill="#3a2a22"
                  stroke={bad.has(table.id) ? "#ef4444" : selected ? "#ffffff" : STATUS_COLOR[table.status]}
                  strokeWidth={selected ? 0.08 : 0.05}
                  onPointerDown={(event) => startDrag(event, table)}
                />
              ) : (
                <rect
                  x={-footprint.w / 2}
                  y={-footprint.h / 2}
                  width={footprint.w}
                  height={footprint.h}
                  rx={0.08}
                  fill="#3a2a22"
                  stroke={bad.has(table.id) ? "#ef4444" : selected ? "#ffffff" : STATUS_COLOR[table.status]}
                  strokeWidth={selected ? 0.08 : 0.05}
                  transform={`translate(${table.x} ${-table.y}) rotate(${table.rotation})`}
                  onPointerDown={(event) => startDrag(event, table)}
                />
              )}
              <text x={table.x} y={-table.y + 0.05} textAnchor="middle" fontSize="0.34" fill="#f8f4ef" pointerEvents="none">
                {table.id}
              </text>
              <text x={table.x} y={-table.y + 0.38} textAnchor="middle" fontSize="0.2" fill="#d6d0c8" pointerEvents="none">
                {table.occupiedSeatCount}/{table.capacity}
              </text>
              {hasNew && <circle cx={table.x + radius * 0.7} cy={-table.y - radius * 0.7} r={0.16} fill="#f97316" pointerEvents="none" />}
              {hasReady && <circle cx={table.x + radius * 0.7} cy={-table.y + radius * 0.15} r={0.16} fill="#22c55e" pointerEvents="none" />}
            </g>
          );
        })}
        {markers.map((marker) => (
          <g key={marker.id} pointerEvents="none">
            <circle cx={marker.x} cy={-marker.y} r={0.22} fill="#60a5fa" />
            <text x={marker.x} y={-marker.y + 0.06} textAnchor="middle" fontSize="0.18" fill="#0f172a">{marker.label}</text>
          </g>
        ))}
      </svg>
      {tablesOverride || heatMode === "operations" ? (
        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-2 rounded-md bg-black/55 px-3 py-2 text-[11px] text-zinc-100">
          <Swatch color="#22c55e" label="Available" />
          <Swatch color="#3b82f6" label="Occupied" />
          <Swatch color="#f59e0b" label="Reserved" />
          <Swatch color="#f97316" label="Waiter / new" />
          <Swatch color="#22c55e" label="Ready" />
        </div>
      ) : (
        <HeatmapLegend />
      )}
      {message && <div className="absolute left-3 top-3 rounded-md border border-red-500/40 bg-red-950/80 px-3 py-2 text-xs text-red-100">{message}</div>}
    </div>
  );

  function startDrag(event: React.PointerEvent, table: RestaurantTable) {
    event.stopPropagation();
    selectTable(table.id);
    if (!editable) return;
    const world = toWorld(event);
    if (!world) return;
    dragOffset.current = { x: world.x - table.x, y: world.y - table.y };
    setDragId(table.id);
    const move = (pointer: PointerEvent) => {
      const point = toWorld(pointer);
      if (!point) return;
      moveDraft(
        table.id,
        Math.round((point.x - dragOffset.current.x) * 100) / 100,
        Math.round((point.y - dragOffset.current.y) * 100) / 100,
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      void finishDrag(table.id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
}

function Zone({ x, y, w, h, fill, label }: { x: number; y: number; w: number; h: number; fill: string; label: string }) {
  return (
    <g>
      <rect x={x} y={-(y + h)} width={w} height={h} fill={fill} />
      <text x={x + 0.25} y={-(y + h) + 0.45} fontSize="0.32" fill="#8d867d">
        {label}
      </text>
    </g>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
