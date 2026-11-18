"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import type { Mesh, MeshBasicMaterial } from "three";
import { STATUS_COLOR } from "@/domain/labels";
import { useHeatmapStore } from "@/store/heatmap-store";
import { chairSlots, tableFootprint } from "@/domain/layout";
import type { Order, RestaurantTable, WaiterCall } from "@/types";

export function TableMesh({
  table,
  selected,
  hovered,
  orders,
  call,
  preview = false,
  modeled = false,
  onSelect,
  onHover,
  onAcknowledge,
  onResolve,
  readOnly = false,
}: {
  table: RestaurantTable;
  selected: boolean;
  hovered: boolean;
  orders: Order[];
  call: WaiterCall | null;
  preview?: boolean;
  modeled?: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onAcknowledge: (id: string) => void;
  onResolve: (id: string) => void;
  readOnly?: boolean;
}) {
  const pulse = useRef<Mesh>(null);
  const ringRef = useRef<MeshBasicMaterial>(null);
  const discRef = useRef<MeshBasicMaterial>(null);
  const footprint = tableFootprint(table);
  const hasNew = orders.some((order) => order.status === "NEW");
  const hasReady = orders.some((order) => order.status === "READY");
  const color = STATUS_COLOR[table.status];
  const radius = Math.max(footprint.w, footprint.h) / 2;
  const ringArgs = useMemo(() => [radius + 0.08, radius + 0.16, 32] as [number, number, number], [radius]);
  const discArgs = useMemo(() => [radius + 0.34, 28] as [number, number], [radius]);

  const applyHeat = () => {
    const { mode, colors } = useHeatmapStore.getState();
    const heat = mode === "heatmap" || mode === "revenue" ? colors[table.id] : null;
    if (ringRef.current) ringRef.current.color.set(heat ?? color);
    if (discRef.current) {
      discRef.current.color.set(heat ?? color);
      discRef.current.opacity = heat ? 0.42 : 0;
    }
  };
  useLayoutEffect(() => {
    applyHeat();
  });
  useEffect(() => useHeatmapStore.subscribe(applyHeat), [table.id, color]);

  useFrame(({ clock }) => {
    if (!pulse.current || !call) return;
    const cycle = (clock.elapsedTime % 1.3) / 1.3;
    const scale = 1 + cycle * 0.85;
    pulse.current.scale.setScalar(scale);
    const material = pulse.current.material as MeshBasicMaterial;
    material.opacity = 0.75 * (1 - cycle);
  });

  return (
    <group position={[table.x, 0, table.y]} rotation={[0, -((table.rotation * Math.PI) / 180), 0]}>
      {modeled &&
        chairSlots(table).map((slot, index) =>
          index < table.occupiedSeatCount ? (
            <mesh key={index} position={[slot.x, 0.86, slot.y]} raycast={() => null}>
              <sphereGeometry args={[0.09, 10, 10]} />
              <meshStandardMaterial color="#d9c2ae" roughness={0.6} />
            </mesh>
          ) : null,
        )}

      {!modeled &&
        chairSlots(table).map((slot, index) => (
          <group key={index} position={[slot.x, 0, slot.y]} rotation={[0, Math.atan2(slot.x, slot.y), 0]}>
            <mesh position={[0, 0.42, 0]} castShadow>
              <boxGeometry args={[0.36, 0.06, 0.36]} />
              <meshStandardMaterial color={index < table.occupiedSeatCount ? "#e4c7a2" : "#2c313b"} roughness={0.7} />
            </mesh>
            <mesh position={[0, 0.66, -0.16]} castShadow>
              <boxGeometry args={[0.36, 0.38, 0.05]} />
              <meshStandardMaterial color={index < table.occupiedSeatCount ? "#8d6846" : "#232830"} roughness={0.75} />
            </mesh>
            {index < table.occupiedSeatCount && (
              <mesh position={[0, 0.78, 0.02]}>
                <sphereGeometry args={[0.09, 10, 10]} />
                <meshStandardMaterial color="#d9c2ae" roughness={0.6} />
              </mesh>
            )}
          </group>
        ))}

      {!modeled && (
        <mesh position={[0, 0.36, 0]} castShadow>
          <cylinderGeometry args={[0.12, 0.16, 0.7, 12]} />
          <meshStandardMaterial color="#2a211c" roughness={0.6} />
        </mesh>
      )}
      {table.shape === "circle" ? (
        <mesh position={[0, 0.74, 0]} castShadow={!modeled} receiveShadow={!modeled} onClick={(event) => { event.stopPropagation(); onSelect(table.id); }} onPointerOver={(event) => { event.stopPropagation(); onHover(table.id); }} onPointerOut={() => onHover(null)}>
          <cylinderGeometry args={[footprint.w / 2, footprint.w / 2, modeled ? 0.2 : 0.08, 28]} />
          {modeled ? (
            <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
          ) : (
            <meshStandardMaterial color="#6a4632" roughness={0.45} metalness={0.04} />
          )}
        </mesh>
      ) : (
        <mesh position={[0, 0.74, 0]} castShadow={!modeled} receiveShadow={!modeled} onClick={(event) => { event.stopPropagation(); onSelect(table.id); }} onPointerOver={(event) => { event.stopPropagation(); onHover(table.id); }} onPointerOut={() => onHover(null)}>
          <boxGeometry args={[footprint.w, modeled ? 0.2 : 0.08, footprint.h]} />
          {modeled ? (
            <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
          ) : (
            <meshStandardMaterial color="#6a4632" roughness={0.45} metalness={0.04} />
          )}
        </mesh>
      )}

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} raycast={() => null}>
        <circleGeometry args={discArgs} />
        <meshBasicMaterial ref={discRef} transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={ringArgs} />
        <meshBasicMaterial ref={ringRef} color={color} transparent opacity={selected || hovered ? 1 : 0.85} />
      </mesh>
      {(selected || hovered) && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
          <ringGeometry args={[Math.max(footprint.w, footprint.h) / 2 + 0.2, Math.max(footprint.w, footprint.h) / 2 + 0.26, 32]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.8} />
        </mesh>
      )}
      {preview && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
          <ringGeometry args={[Math.max(footprint.w, footprint.h) / 2 + 0.32, Math.max(footprint.w, footprint.h) / 2 + 0.42, 32]} />
          <meshBasicMaterial color="#f5d27a" transparent opacity={0.9} />
        </mesh>
      )}
      {call && (
        <mesh ref={pulse} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
          <ringGeometry args={[0.55, 0.62, 32]} />
          <meshBasicMaterial color={call.status === "ACTIVE" ? "#ef4444" : "#f97316"} transparent opacity={0.8} />
        </mesh>
      )}

      <Html position={[0, 1.25, 0]} center distanceFactor={11} zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <div className="select-none rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-semibold text-white">
          {table.id}
          <span className="ml-1 font-normal text-zinc-300">
            {table.occupiedSeatCount}/{table.capacity}
          </span>
        </div>
      </Html>
      {(hasNew || hasReady || call) && (
        <Html position={[0, 1.7, 0]} center zIndexRange={[30, 0]}>
          <div className="flex flex-col items-center gap-1" onPointerDown={(event) => event.stopPropagation()}>
            {hasNew && <span className="rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-semibold text-black">New order</span>}
            {hasReady && <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-semibold text-black">Ready</span>}
            {call && (
              <div className="rounded-md bg-red-600 px-2 py-1 text-[11px] font-semibold text-white shadow-lg">
                Waiter
                {!readOnly && (
                  <div className="mt-1 flex gap-1">
                    {call.status === "ACTIVE" && (
                      <button type="button" className="rounded bg-white/15 px-1.5 py-0.5" onClick={() => onAcknowledge(call.id)}>
                        Ack
                      </button>
                    )}
                    <button type="button" className="rounded bg-black/30 px-1.5 py-0.5" onClick={() => onResolve(call.id)}>
                      Resolve
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}
