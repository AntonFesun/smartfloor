"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BufferAttribute, BufferGeometry, Color, InstancedMesh, Material, Matrix4, Mesh, Object3D, SpotLight, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { chairSlots, tableFootprint } from "@/domain/layout";
import type { RestaurantTable } from "@/types";

export const FURNITURE_MODELS = {
  table: "/models/table.glb",
  chair: "/models/chair.glb",
  bar: "/models/bar.glb",
  plant: "/models/plant.glb",
  pendant: "/models/pendant.glb",
} as const;

const TABLE_TOP = 0.78;
const CHAIR_WIDTH = 0.48;
const PLANT_HEIGHT = 1.05;
const PENDANT_HEIGHT = 0.62;
const EMPTY_CHAIR = new Color("#5c564f");
const OCCUPIED_CHAIR = new Color("#ffffff");

const scratch = new Object3D();
const upAxis = new Vector3();
const forwardAxis = new Vector3();
const rightAxis = new Vector3();
const orientMatrix = new Matrix4();

type AxisFix = {
  /** File-space direction that should stand up as +Y. */
  up: [number, number, number];
  /** File-space direction that should face +Z after the mesh is upright. */
  forward?: [number, number, number];
  /** Fraction up from the lowest vertex to treat as the floor, ignoring a dangling spike. */
  floor?: number;
  /** Center the footprint on the top of the mesh so a lamp hangs from its canopy. */
  hang?: boolean;
};

// Measured from the mesh itself: these ComfyUI files are not authored on Y-up.
const AXIS_FIX: Record<string, AxisFix> = {
  [FURNITURE_MODELS.table]: { up: [-0.0006, 0.9257, 0.3782] },
  [FURNITURE_MODELS.chair]: { up: [0.0032, 0.9763, 0.2163], forward: [0.3956, -0.1999, 0.8964] },
  [FURNITURE_MODELS.bar]: { up: [-0.0013, 0.9954, 0.0959], forward: [0.6941, 0.0699, -0.7165] },
  [FURNITURE_MODELS.plant]: { up: [0.0109, 0.9995, -0.0312] },
  [FURNITURE_MODELS.pendant]: { up: [-0.0244, 0.9499, -0.3115], hang: true },
};

interface PreparedModel {
  geometry: BufferGeometry;
  material: Material;
  size: Vector3;
}

function findMesh(root: Object3D): Mesh {
  let found: Mesh | null = null;
  root.traverse((object) => {
    if (!found && (object as Mesh).isMesh) found = object as Mesh;
  });
  if (!found) throw new Error("Furniture GLB has no mesh");
  return found;
}

function levelGeometry(geometry: BufferGeometry, fix: AxisFix) {
  upAxis.set(fix.up[0], fix.up[1], fix.up[2]).normalize();
  if (fix.forward) forwardAxis.set(fix.forward[0], fix.forward[1], fix.forward[2]);
  else forwardAxis.set(0, 0, 1);
  forwardAxis.addScaledVector(upAxis, -forwardAxis.dot(upAxis));
  if (forwardAxis.lengthSq() < 1e-8) forwardAxis.set(1, 0, 0).cross(upAxis);
  forwardAxis.normalize();
  rightAxis.crossVectors(upAxis, forwardAxis).normalize();
  forwardAxis.crossVectors(rightAxis, upAxis).normalize();
  orientMatrix.makeBasis(rightAxis, upAxis, forwardAxis).invert();
  geometry.applyMatrix4(orientMatrix);
}

function sampleYs(position: BufferAttribute, stride: number) {
  const ys: number[] = [];
  for (let index = 0; index < position.count; index += stride) ys.push(position.getY(index));
  ys.sort((a, b) => a - b);
  return ys;
}

function seatGeometry(geometry: BufferGeometry, fix: AxisFix) {
  const position = geometry.getAttribute("position") as BufferAttribute;
  const stride = Math.max(1, Math.floor(position.count / 20000));
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) return new Vector3(1, 1, 1);
  const heights = sampleYs(position, stride);
  const floor = fix.floor
    ? (heights[Math.min(heights.length - 1, Math.floor(heights.length * fix.floor))] ?? bounds.min.y)
    : bounds.min.y;
  let centerX = (bounds.min.x + bounds.max.x) / 2;
  let centerZ = (bounds.min.z + bounds.max.z) / 2;
  if (fix.hang) {
    const canopy = bounds.min.y + (bounds.max.y - bounds.min.y) * 0.85;
    let sumX = 0;
    let sumZ = 0;
    let count = 0;
    for (let index = 0; index < position.count; index += stride) {
      if (position.getY(index) < canopy) continue;
      sumX += position.getX(index);
      sumZ += position.getZ(index);
      count += 1;
    }
    if (count > 0) {
      centerX = sumX / count;
      centerZ = sumZ / count;
    }
  }
  geometry.translate(-centerX, -floor, -centerZ);
  geometry.computeBoundingBox();
  const seated = geometry.boundingBox;
  if (!seated) return new Vector3(1, 1, 1);
  const ground = Math.max(seated.min.y, 0);
  return new Vector3(seated.max.x - seated.min.x, Math.max(seated.max.y - ground, 0.001), seated.max.z - seated.min.z);
}

function prepareModel(root: Object3D, url: string): PreparedModel {
  const mesh = findMesh(root);
  const geometry = mesh.geometry.clone();
  mesh.updateWorldMatrix(true, false);
  geometry.applyMatrix4(mesh.matrixWorld);
  const fix = AXIS_FIX[url] ?? { up: [0, 1, 0] as [number, number, number] };
  levelGeometry(geometry, fix);
  if (url === FURNITURE_MODELS.table) geometry.rotateX(0.0089);
  const fitted = seatGeometry(geometry, fix);
  const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return { geometry, material: source.clone(), size: fitted };
}

const preparedCache = new Map<string, Promise<PreparedModel>>();
const readyModels = new Map<string, PreparedModel>();

export function furnitureModelsReady(): boolean {
  return readyModels.has(FURNITURE_MODELS.table) && readyModels.has(FURNITURE_MODELS.chair);
}

function loadPrepared(url: string): Promise<PreparedModel> {
  const existing = preparedCache.get(url);
  if (existing) return existing;
  const pending = new Promise<PreparedModel>((resolve, reject) => {
    new GLTFLoader().load(
      url,
      (gltf) => {
        try {
          const prepared = prepareModel(gltf.scene, url);
          readyModels.set(url, prepared);
          resolve(prepared);
        } catch (error) {
          preparedCache.delete(url);
          reject(error);
        }
      },
      undefined,
      (error) => {
        preparedCache.delete(url);
        reject(error);
      },
    );
  });
  preparedCache.set(url, pending);
  return pending;
}

function usePrepared(url: string): PreparedModel | null {
  const [model, setModel] = useState<PreparedModel | null>(() => readyModels.get(url) ?? null);
  useEffect(() => {
    const cached = readyModels.get(url);
    if (cached) {
      setModel(cached);
      return;
    }
    let alive = true;
    loadPrepared(url)
      .then((prepared) => {
        if (alive) setModel(prepared);
      })
      .catch((error: unknown) => {
        console.error(`Failed to load furniture model ${url}`, error);
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return model;
}

function TableInstances({ tables, model }: { tables: RestaurantTable[]; model: PreparedModel }) {
  const ref = useRef<InstancedMesh>(null);
  const count = tables.length;

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh || count === 0) return;
    tables.forEach((table, index) => {
      const footprint = tableFootprint(table);
      scratch.position.set(table.x, 0, table.y);
      scratch.rotation.set(0, -((table.rotation * Math.PI) / 180), 0);
      scratch.scale.set(footprint.w / model.size.x, TABLE_TOP / model.size.y, footprint.h / model.size.z);
      scratch.updateMatrix();
      mesh.setMatrixAt(index, scratch.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [tables, count, model.size.x, model.size.y, model.size.z]);

  if (count === 0) return null;
  return (
      <instancedMesh
      key={count}
      ref={ref}
      args={[model.geometry, model.material, count]}
      castShadow
      receiveShadow
      frustumCulled={false}
      raycast={() => null}
      dispose={null}
    />
  );
}

function ChairInstances({ tables, model }: { tables: RestaurantTable[]; model: PreparedModel }) {
  const ref = useRef<InstancedMesh>(null);
  const entries = useMemo(
    () =>
      tables.flatMap((table) => {
        const yaw = -((table.rotation * Math.PI) / 180);
        const cos = Math.cos(yaw);
        const sin = Math.sin(yaw);
        return chairSlots(table).map((slot, index) => ({
          x: table.x + slot.x * cos + slot.y * sin,
          z: table.y - slot.x * sin + slot.y * cos,
          yaw: yaw + Math.atan2(slot.x, slot.y) + Math.PI,
          occupied: index < table.occupiedSeatCount,
        }));
      }),
    [tables],
  );

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh || entries.length === 0) return;
    const scale = CHAIR_WIDTH / model.size.x;
    entries.forEach((entry, index) => {
      scratch.position.set(entry.x, 0, entry.z);
      scratch.rotation.set(0, entry.yaw, 0);
      scratch.scale.setScalar(scale);
      scratch.updateMatrix();
      mesh.setMatrixAt(index, scratch.matrix);
      mesh.setColorAt(index, entry.occupied ? OCCUPIED_CHAIR : EMPTY_CHAIR);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [entries, model.size.x]);

  if (entries.length === 0) return null;
  return (
    <instancedMesh
      key={entries.length}
      ref={ref}
      args={[model.geometry, model.material, entries.length]}
      castShadow
      frustumCulled={false}
      raycast={() => null}
      dispose={null}
    />
  );
}

export function FurnitureModels({ tables, onReady }: { tables: RestaurantTable[]; onReady: () => void }) {
  const tableModel = usePrepared(FURNITURE_MODELS.table);
  const chairModel = usePrepared(FURNITURE_MODELS.chair);

  useEffect(() => {
    if (tableModel && chairModel) onReady();
  }, [tableModel, chairModel, onReady]);

  if (!tableModel || !chairModel) return null;
  return (
    <group>
      <TableInstances tables={tables} model={tableModel} />
      <ChairInstances tables={tables} model={chairModel} />
    </group>
  );
}

export function PlantModels({ positions, fallback = null }: { positions: [number, number, number][]; fallback?: ReactNode }) {
  const model = usePrepared(FURNITURE_MODELS.plant);
  if (!model) return fallback;
  const scale = PLANT_HEIGHT / model.size.y;
  return (
    <group>
      {positions.map((position) => (
        <mesh
          key={position.join(",")}
          geometry={model.geometry}
          material={model.material}
          position={position}
          scale={scale}
          castShadow
          raycast={() => null}
          dispose={null}
        />
      ))}
    </group>
  );
}

function PendantLamp({ position, geometry, material, scale }: { position: [number, number, number]; geometry: BufferGeometry; material: Material; scale: number }) {
  const light = useRef<SpotLight>(null);
  const target = useRef<Object3D>(null);
  const shadeY = PENDANT_HEIGHT * 0.4;
  useLayoutEffect(() => {
    if (light.current && target.current) light.current.target = target.current;
  });
  return (
    <group position={[position[0], position[1] - PENDANT_HEIGHT, position[2]]}>
      <mesh geometry={geometry} material={material} scale={scale} castShadow raycast={() => null} dispose={null} />
      <spotLight
        ref={light}
        position={[0, shadeY, 0]}
        angle={0.66}
        penumbra={0.78}
        intensity={24}
        distance={7.2}
        decay={2}
        color="#ffb066"
        castShadow
        shadow-mapSize-width={512}
        shadow-mapSize-height={512}
        shadow-bias={-0.0008}
        shadow-radius={4}
      />
      <object3D ref={target} position={[0, 0.02, 0]} />
    </group>
  );
}

export function PendantModels({ positions, fallback = null }: { positions: [number, number, number][]; fallback?: ReactNode }) {
  const model = usePrepared(FURNITURE_MODELS.pendant);
  if (!model) return fallback;
  const scale = PENDANT_HEIGHT / model.size.y;
  return (
    <group>
      {positions.map((position) => (
        <PendantLamp key={position.join(",")} position={position} geometry={model.geometry} material={model.material} scale={scale} />
      ))}
    </group>
  );
}

export function BarModel({ fallback = null }: { fallback?: ReactNode }) {
  const model = usePrepared(FURNITURE_MODELS.bar);
  if (!model) return fallback;
  const target = { x: 0.55, y: 1.15, z: 2.5 };
  return (
    <mesh
      geometry={model.geometry}
      material={model.material}
      position={[8.55, 0, 3.6]}
      rotation={[0, 0, 0]}
      scale={[target.x / model.size.x, target.y / model.size.y, target.z / model.size.z]}
      castShadow
      receiveShadow
      raycast={() => null}
      dispose={null}
    />
  );
}
