"use client";

import { useCallback, useRef, useState } from "react";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import { FurnitureModels, furnitureModelsReady } from "@/components/three/furniture";
import { Room } from "@/components/three/room";
import { TableMesh } from "@/components/three/table-mesh";
import { ZoneOverlay, type ZoneOverlayZone } from "@/components/three/zone-overlay";
import type { CameraPreset } from "@/store/ui-store";
import type { Order, RestaurantTable, WaiterCall } from "@/types";

interface Controls {
  target: Vector3;
  update: () => void;
  enabled: boolean;
}

function CameraRig({ preset, nonce, focus }: { preset: CameraPreset; nonce: number; focus: [number, number, number] | null }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as Controls | null;
  const seen = useRef(0);
  const anim = useRef<{ fromP: Vector3; toP: Vector3; fromT: Vector3; toT: Vector3; t: number } | null>(null);

  useFrame((_, delta) => {
    if (!controls) return;
    if (nonce !== seen.current) {
      seen.current = nonce;
      const target = preset === "focus" && focus ? new Vector3(focus[0], 0.4, focus[2]) : new Vector3(0, 0, 0);
      const position =
        preset === "top"
          ? new Vector3(0, 18, 0.02)
          : preset === "focus" && focus
            ? new Vector3(focus[0] + 3.4, 4.4, focus[2] + 3.4)
            : new Vector3(11.5, 10.5, 11.5);
      anim.current = {
        fromP: camera.position.clone(),
        toP: position,
        fromT: controls.target.clone(),
        toT: target,
        t: 0,
      };
      controls.enabled = false;
    }
    const current = anim.current;
    if (!current) return;
    current.t = Math.min(1, current.t + delta * 1.5);
    const eased = 1 - (1 - current.t) ** 3;
    camera.position.lerpVectors(current.fromP, current.toP, eased);
    controls.target.lerpVectors(current.fromT, current.toT, eased);
    controls.update();
    if (current.t >= 1) {
      anim.current = null;
      controls.enabled = true;
    }
  });
  return null;
}

export default function RestaurantScene({
  tables,
  orders,
  calls,
  zones = [],
  highlightIds = [],
  selectedId,
  preset,
  nonce,
  focus,
  onSelect,
  onAcknowledge,
  onResolve,
  readOnly = false,
  markers = [],
}: {
  tables: RestaurantTable[];
  orders: Order[];
  calls: WaiterCall[];
  zones?: ZoneOverlayZone[];
  highlightIds?: string[];
  selectedId: string | null;
  preset: CameraPreset;
  nonce: number;
  focus: [number, number, number] | null;
  onSelect: (id: string | null) => void;
  onAcknowledge: (id: string) => void;
  onResolve: (id: string) => void;
  readOnly?: boolean;
  markers?: { id: string; x: number; y: number }[];
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [modelsReady, setModelsReady] = useState(furnitureModelsReady);
  const onModelsReady = useCallback(() => setModelsReady(true), []);
  return (
    <Canvas
      shadows="soft"
      dpr={[1, 1.6]}
      camera={{ position: [11.5, 10.5, 11.5], fov: 34, near: 0.1, far: 90 }}
      onPointerMissed={() => onSelect(null)}
    >
      <color attach="background" args={["#12141a"]} />
      <fog attach="fog" args={["#12141a", 26, 52]} />
      <ambientLight intensity={0.38} />
      <hemisphereLight args={["#ffe7d0", "#141820", 0.45]} />
      <directionalLight
        position={[7, 14, 6]}
        intensity={1.45}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={40}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
      />
      <Room />
      <FurnitureModels tables={tables} onReady={onModelsReady} />
      <ZoneOverlay zones={zones} />
      {tables.map((table) => (
        <TableMesh
          key={table.id}
          table={table}
          modeled={modelsReady}
          selected={table.id === selectedId}
          hovered={table.id === hovered}
          orders={orders.filter((order) => order.tableId === table.id)}
          call={calls.find((call) => call.tableId === table.id && call.status !== "RESOLVED") ?? null}
          preview={highlightIds.includes(table.id)}
          onSelect={(id) => onSelect(id)}
          onHover={setHovered}
          onAcknowledge={onAcknowledge}
          onResolve={onResolve}
          readOnly={readOnly}
        />
      ))}
      {markers.map((marker) => (
        <mesh key={marker.id} position={[marker.x, 0.95, marker.y]} raycast={() => null}>
          <sphereGeometry args={[0.16, 12, 12]} />
          <meshStandardMaterial color="#60a5fa" roughness={0.4} />
        </mesh>
      ))}
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI / 2.08} minDistance={4} maxDistance={30} />
      <CameraRig preset={preset} nonce={nonce} focus={focus} />
    </Canvas>
  );
}
