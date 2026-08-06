"use client";

import { useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import RoomBox from "./RoomBox";
import type { Room, RoomStatus } from "@/types";

const FLOOR_GAP = 3.2;
const FLOOR_LABELS = ["GROUND FLOOR", "1ST FLOOR", "2ND FLOOR"];
const LT_SIZE: [number, number, number] = [2.2, 2, 2];
const CR_SIZE: [number, number, number] = [2.2, 0.95, 2];
const X_STEP = 3;

// The short arm (LT1/LT4/LT7 + the CR wing) now extends toward the
// camera (+Z, "front") instead of behind the building, so it's always
// clearly visible instead of hiding behind the long arm.
const SHORT_ARM_LT_Z = 3.2; // LT1 / LT4 / LT7 sit here
const SHORT_ARM_CR_Z = 6.4; // CR1/CR2 continue further forward, past LT1
const SHORT_ARM_FAR_EDGE = SHORT_ARM_CR_Z + 1.6;

const INITIAL_CAMERA_POSITION: [number, number, number] = [10, 5.5, 14];
const INITIAL_TARGET: [number, number, number] = [0, FLOOR_GAP, 0];

interface Building3DProps {
  rooms: Room[];
  getStatus: (room: Room) => RoomStatus;
  onRoomClick: (room: Room) => void;
}

function roomPosition(room: Room): [number, number, number] {
  const floorY = room.floor * FLOOR_GAP;

  if (room.type === "CR") {
    // CR1 on top, CR2 below, further out along the short arm than LT1.
    const isTop = room.name === "CR1";
    const y = isTop ? floorY + 1.475 : floorY + 0.475;
    return [0, y, SHORT_ARM_CR_Z];
  }

  if (room.pos_x === 0) {
    // LT1 / LT4 / LT7 - the corner room, now on the short arm itself.
    return [0, floorY + 1, SHORT_ARM_LT_Z];
  }

  // Long arm: LT2 (pos_x 1), LT3 (pos_x 2) - and same pattern on
  // floors 1 and 2 (LT5/LT6, LT8/LT9).
  const x = room.pos_x * X_STEP;
  return [x, floorY + 1, 0];
}

function FloorPlatform({
  floorIndex,
  width,
}: {
  floorIndex: number;
  width: number;
}) {
  const y = floorIndex * FLOOR_GAP - 0.15;
  const mainArmSize: [number, number, number] = [width + 1.8, 0.12, 3.2];
  const mainArmPos: [number, number, number] = [width / 2 - X_STEP / 2, y, 0];
  const shortArmSize: [number, number, number] = [3.2, 0.12, SHORT_ARM_FAR_EDGE - 1.6];
  const shortArmPos: [number, number, number] = [0, y, (1.6 + SHORT_ARM_FAR_EDGE) / 2];

  return (
    <group>
      <mesh position={mainArmPos}>
        <boxGeometry args={mainArmSize} />
        <meshStandardMaterial color="#DCD7C8" roughness={0.85} transparent opacity={0.75} />
      </mesh>
      <lineSegments position={mainArmPos}>
        <edgesGeometry args={[new THREE.BoxGeometry(...mainArmSize)]} />
        <lineBasicMaterial color="#1F2937" transparent opacity={0.35} />
      </lineSegments>

      <mesh position={shortArmPos}>
        <boxGeometry args={shortArmSize} />
        <meshStandardMaterial color="#DCD7C8" roughness={0.85} transparent opacity={0.75} />
      </mesh>
      <lineSegments position={shortArmPos}>
        <edgesGeometry args={[new THREE.BoxGeometry(...shortArmSize)]} />
        <lineBasicMaterial color="#1F2937" transparent opacity={0.35} />
      </lineSegments>

      <Text
        position={[-5.5, y + 0.6, 0]}
        fontSize={0.28}
        color="#2C5F8A"
        anchorX="left"
        anchorY="middle"
      >
        {FLOOR_LABELS[floorIndex]}
      </Text>
    </group>
  );
}

function SupportColumns({ width }: { width: number }) {
  const topY = 2 * FLOOR_GAP + 1.6;
  const bottomY = -0.55;
  const height = topY - bottomY;
  const midY = (topY + bottomY) / 2;

  const xMin = -1.9;
  const xMax = width + 0.9;
  const zBack = -1.6;
  const zFrontLongArm = 1.6;
  const zFrontShortArm = SHORT_ARM_FAR_EDGE + 0.4;

  const corners: [number, number][] = [
    [xMin, zBack],
    [xMax, zBack],
    [xMax, zFrontLongArm],
    [-1.6, zFrontShortArm],
  ];

  return (
    <>
      {corners.map(([x, z], i) => (
        <mesh key={i} position={[x, midY, z]}>
          <boxGeometry args={[0.14, height, 0.14]} />
          <meshStandardMaterial color="#1F2937" roughness={0.5} />
        </mesh>
      ))}
    </>
  );
}

export default function Building3D({
  rooms,
  getStatus,
  onRoomClick,
}: Building3DProps) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const maxX = Math.max(...rooms.map((r) => r.pos_x), 0) * X_STEP;

  function resetView() {
    // Drive the camera/target back to the exact literals used for the
    // page-load framing, instead of relying on OrbitControls' built-in
    // reset()/saveState(), which captures its snapshot before the
    // `target` prop below is even applied (so it doesn't match load view).
    const controls = controlsRef.current;
    if (!controls) return;
    controls.object.position.set(...INITIAL_CAMERA_POSITION);
    controls.target.set(...INITIAL_TARGET);
    controls.update();
  }

  return (
    <div className="w-full h-[560px] blueprint-card overflow-hidden relative">
      <Canvas camera={{ position: INITIAL_CAMERA_POSITION, fov: 42 }}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[6, 10, 6]} intensity={0.9} />
        <directionalLight position={[-6, 4, -4]} intensity={0.3} />

        <SupportColumns width={maxX} />

        {[0, 1, 2].map((floorIndex) => (
          <FloorPlatform key={floorIndex} floorIndex={floorIndex} width={maxX} />
        ))}

        {rooms.map((room) => (
          <RoomBox
            key={room.id}
            room={room}
            status={getStatus(room)}
            position={roomPosition(room)}
            size={room.type === "CR" ? CR_SIZE : LT_SIZE}
            onClick={onRoomClick}
          />
        ))}

        <OrbitControls
          target={INITIAL_TARGET}
          ref={controlsRef}
          enablePan={false}
          minDistance={6}
          maxDistance={22}
          maxPolarAngle={Math.PI / 2.1}
          autoRotate={autoRotate}
          autoRotateSpeed={0.7}
        />
      </Canvas>

      <div className="absolute bottom-3 left-3 flex gap-4 font-mono text-xs bg-paper/90 px-3 py-1.5 border border-ink">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 inline-block" style={{ background: "#5A8F4B" }} />
          Available
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 inline-block" style={{ background: "#C1483F" }} />
          Booked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 inline-block" style={{ background: "#B96A2C" }} />
          Upcoming
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 inline-block" style={{ background: "#D4A72C" }} />
          Selected
        </span>
      </div>

      <div className="absolute top-3 right-3 flex gap-2">
        <button
          onClick={() => setAutoRotate((v) => !v)}
          className="font-mono text-xs bg-paper/90 border border-ink px-3 py-1.5 hover:bg-ink hover:text-paper transition-colors"
        >
          {autoRotate ? "Stop rotate" : "Auto-rotate"}
        </button>
        <button
          onClick={resetView}
          className="font-mono text-xs bg-paper/90 border border-ink px-3 py-1.5 hover:bg-ink hover:text-paper transition-colors"
        >
          Reset view
        </button>
      </div>
    </div>
  );
}