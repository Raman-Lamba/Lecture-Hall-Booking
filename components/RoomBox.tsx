"use client";

import { useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Text, RoundedBox, Billboard } from "@react-three/drei";
import * as THREE from "three";
import type { Room, RoomStatus } from "@/types";

const STATUS_COLOR: Record<RoomStatus, string> = {
  available: "#5A8F4B",
  booked: "#C1483F",
  selected: "#D4A72C",
};

const STATUS_EMISSIVE: Record<RoomStatus, string> = {
  available: "#1E3318",
  booked: "#3A1210",
  selected: "#3A2A08",
};

interface RoomBoxProps {
  room: Room;
  status: RoomStatus;
  position: [number, number, number];
  size: [number, number, number];
  onClick: (room: Room) => void;
}

export default function RoomBox({
  room,
  status,
  position,
  size,
  onClick,
}: RoomBoxProps) {
  const groupRef = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);

  useFrame(() => {
    if (!groupRef.current) return;
    const targetScale = hovered ? 1.07 : 1;
    const targetY = hovered ? position[1] + 0.08 : position[1];
    groupRef.current.scale.lerp(
      new THREE.Vector3(targetScale, targetScale, targetScale),
      0.18
    );
    groupRef.current.position.y = THREE.MathUtils.lerp(
      groupRef.current.position.y,
      targetY,
      0.18
    );
  });

  return (
    <group ref={groupRef} position={position}>
      <RoundedBox
        args={size}
        radius={0.06}
        smoothness={4}
        castShadow
        receiveShadow
        onClick={(e) => {
          e.stopPropagation();
          onClick(room);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "default";
        }}
      >
        <meshStandardMaterial
          color={STATUS_COLOR[status]}
          emissive={STATUS_EMISSIVE[status]}
          emissiveIntensity={hovered ? 0.6 : 0.3}
          roughness={0.4}
          metalness={0.12}
        />
      </RoundedBox>

      {/* thin ink outline, ties back to the blueprint linework theme */}
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(...size)]} />
        <lineBasicMaterial color="#1F2937" linewidth={1} transparent opacity={0.5} />
      </lineSegments>

      {/* Billboarded label: always faces the camera, so it stays crisp
          and readable no matter which side of the building you're
          viewing from - instead of being locked to one face.
          The Text is pushed outward by the box's bounding radius
          BEFORE billboard rotation, so it always clears the box's
          surface and points toward the camera - otherwise it sits
          inside the solid mesh and is invisible. */}
      <Billboard position={[0, 0, 0]} follow>
        <Text
          position={[
            0,
            0,
            Math.sqrt((size[0] / 2) ** 2 + (size[1] / 2) ** 2 + (size[2] / 2) ** 2) + 0.15,
          ]}
          fontSize={size[1] * 0.34}
          color="#F7F5F0"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.012}
          outlineColor="#1F2937"
        >
          {room.name}
        </Text>
      </Billboard>
    </group>
  );
}