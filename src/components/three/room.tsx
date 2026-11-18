"use client";

import { BarModel, PendantModels, PlantModels } from "@/components/three/furniture";

const PLANT_POSITIONS: [number, number, number][] = [
  [-8.3, 0, -5.2],
  [-8.3, 0, 5.2],
  [2.4, 0, -5.2],
  [2.4, 0, 5.3],
];

const PENDANT_POSITIONS: [number, number, number][] = [
  [-5, 2.15, -2],
  [-2.5, 2.15, 2.2],
  [5, 2.15, -2.6],
  [5.4, 2.15, 3.4],
];

function Wall({ position, size }: { position: [number, number, number]; size: [number, number, number] }) {
  return (
    <mesh position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color="#2a303a" roughness={0.86} />
    </mesh>
  );
}

function Plant({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.22, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.12, 0.44, 10]} />
        <meshStandardMaterial color="#3a2a22" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.62, 0]} castShadow>
        <sphereGeometry args={[0.28, 14, 14]} />
        <meshStandardMaterial color="#1f6a45" roughness={0.7} />
      </mesh>
    </group>
  );
}

function Pendant({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.35, 0]}>
        <cylinderGeometry args={[0.012, 0.012, 0.7, 6]} />
        <meshStandardMaterial color="#1a1c22" />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.09, 14, 14]} />
        <meshStandardMaterial color="#ffe0c2" emissive="#ffb36b" emissiveIntensity={2.2} />
      </mesh>
      <pointLight intensity={0.45} distance={6.5} color="#ffc89a" decay={2} />
    </group>
  );
}

export function Room() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[18.8, 12.6]} />
        <meshStandardMaterial color="#16120f" roughness={0.94} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-3.2, 0.012, 0]} receiveShadow>
        <planeGeometry args={[10.8, 11]} />
        <meshStandardMaterial color="#2a211b" roughness={0.9} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[5.8, 0.014, -3]} receiveShadow>
        <planeGeometry args={[5.4, 5]} />
        <meshStandardMaterial color="#24302c" roughness={0.92} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[5.8, 0.014, 3.4]} receiveShadow>
        <planeGeometry args={[5.4, 4]} />
        <meshStandardMaterial color="#231812" roughness={0.88} />
      </mesh>

      <Wall position={[0, 1.35, -6.25]} size={[18.6, 2.7, 0.16]} />
      <Wall position={[0, 1.35, 6.25]} size={[18.6, 2.7, 0.16]} />
      <Wall position={[-9.3, 1.35, -2.2]} size={[0.16, 2.7, 7.6]} />
      <Wall position={[-9.3, 1.35, 4.3]} size={[0.16, 2.7, 3.6]} />
      <Wall position={[9.3, 1.35, 0]} size={[0.16, 2.7, 12.3]} />

      {[-4.2, -1.4, 1.6, 4.2].map((z) => (
        <mesh key={z} position={[9.12, 1.55, z]}>
          <boxGeometry args={[0.04, 1.15, 1.5]} />
          <meshStandardMaterial color="#9fd4ff" emissive="#7eb6e6" emissiveIntensity={0.35} transparent opacity={0.45} roughness={0.05} />
        </mesh>
      ))}

      <BarModel fallback={<ProceduralBar />} />
      <PlantModels positions={PLANT_POSITIONS} fallback={<ProceduralPlants />} />
      <PendantModels positions={PENDANT_POSITIONS} fallback={<ProceduralPendants />} />
    </group>
  );
}

function ProceduralPlants() {
  return (
    <>
      {PLANT_POSITIONS.map((position) => (
        <Plant key={position.join(",")} position={position} />
      ))}
    </>
  );
}

function ProceduralPendants() {
  return (
    <>
      {PENDANT_POSITIONS.map((position) => (
        <Pendant key={position.join(",")} position={position} />
      ))}
    </>
  );
}

function ProceduralBar() {
  return (
    <group>
      <mesh position={[8.55, 0.55, 3.6]} castShadow receiveShadow>
        <boxGeometry args={[0.55, 1.1, 2.5]} />
        <meshStandardMaterial color="#1a120e" roughness={0.55} metalness={0.08} />
      </mesh>
      <mesh position={[8.55, 1.12, 3.6]} castShadow>
        <boxGeometry args={[0.62, 0.08, 2.6]} />
        <meshStandardMaterial color="#5a3a28" roughness={0.4} />
      </mesh>
      {Array.from({ length: 5 }, (_, index) => (
        <mesh key={index} position={[8.55, 1.32, 2.76 + index * 0.42]} castShadow>
          <cylinderGeometry args={[0.055, 0.055, 0.26 + (index % 3) * 0.05, 8]} />
          <meshStandardMaterial color={index % 2 === 0 ? "#7a2433" : "#1e4d3a"} roughness={0.35} metalness={0.15} />
        </mesh>
      ))}
    </group>
  );
}
