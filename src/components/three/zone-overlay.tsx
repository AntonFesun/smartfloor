"use client";

import { Html } from "@react-three/drei";

export interface ZoneOverlayZone {
  name: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  waiters: string[];
  needsHelp: boolean;
}

const NO_RAYCAST = () => null;

export function ZoneOverlay({ zones }: { zones: ZoneOverlayZone[] }) {
  return (
    <group>
      {zones.map((zone) => (
        <group key={zone.name}>
          <mesh position={[zone.x, 0.02, zone.z]} rotation={[-Math.PI / 2, 0, 0]} raycast={NO_RAYCAST}>
            <planeGeometry args={[zone.width, zone.depth]} />
            <meshBasicMaterial color={zone.needsHelp ? "#7a4a32" : "#243044"} transparent opacity={0.18} depthWrite={false} />
          </mesh>
          <Html position={[zone.x, 0.35, zone.z - zone.depth / 2 + 0.35]} center zIndexRange={[8, 0]} style={{ pointerEvents: "none" }}>
            <div className="select-none rounded bg-black/45 px-2 py-1 text-[10px] leading-tight text-zinc-300">
              <div>{zone.name}</div>
              <div>{zone.waiters.length > 0 ? zone.waiters.join(", ") : "No waiter on duty"}</div>
              {zone.needsHelp && <div className="text-orange-200">Needs help</div>}
            </div>
          </Html>
        </group>
      ))}
    </group>
  );
}
