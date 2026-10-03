// Builds the robot mesh: a simplified model of the physical 2WD chassis
// (clear acrylic deck, yellow-hub wheels, caster, battery pack, breadboard,
// HC-SR04 twin-eye ultrasonic sensor) plus a translucent floor decal showing
// the onboard camera's field of view.

import { CAM_FOV_DEG, CAM_MAX_RANGE, SWATTER_REST_ANGLE } from '../constants.js';

export function buildRobot(room) {
  const robotMesh = new THREE.Group();

  const chassisMat = new THREE.MeshStandardMaterial({ color: 0xcfe9de, transparent: true, opacity: 0.32, roughness: 0.2, metalness: 0.1 });
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.34), chassisMat);
  chassis.position.set(0.03, 0.1, 0);
  robotMesh.add(chassis);

  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xe6b400, roughness: 0.6 });
  [-1, 1].forEach((s) => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.078, 0.045, 18), wheelMat);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(-0.06, 0.078, s * 0.195);
    robotMesh.add(wheel);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 12), hubMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(-0.06, 0.078, s * 0.195);
    robotMesh.add(hub);
  });
  const caster = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
  caster.position.set(0.27, 0.032, 0);
  robotMesh.add(caster);

  function box(w, h, d, color) {
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
  }
  const battery = box(0.17, 0.06, 0.13, 0x161616);
  battery.position.set(-0.03, 0.145, 0);
  robotMesh.add(battery);
  const board = box(0.13, 0.02, 0.22, 0xe8e4d6);
  board.position.set(0.14, 0.115, 0);
  robotMesh.add(board);
  const redMod = box(0.05, 0.03, 0.06, 0xb02020);
  redMod.position.set(0.12, 0.14, 0.08);
  robotMesh.add(redMod);
  [-0.025, 0.025].forEach((zo) => {
    const us = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 10), new THREE.MeshStandardMaterial({ color: 0xb9c2c2, metalness: 0.6, roughness: 0.3 }));
    us.rotation.z = Math.PI / 2;
    us.position.set(0.315, 0.11, zo);
    robotMesh.add(us);
  });
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), new THREE.MeshStandardMaterial({ color: 0x4ee6a0, emissive: 0x4ee6a0, emissiveIntensity: 1.4 }));
  eye.position.set(0.33, 0.13, 0);
  robotMesh.add(eye);

  // Swatter: a pivoting arm + paddle that stays cocked up out of the camera's
  // way, then swings down to strike whatever's in front during CAPTURE (see
  // main.js, which drives swatterPivot.rotation.z between SWATTER_REST_ANGLE
  // and SWATTER_STRIKE_ANGLE).
  const swatterPivot = new THREE.Group();
  swatterPivot.position.set(0.20, 0.22, 0);
  const armMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.4 });
  const armLen = 0.20;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, armLen, 8), armMat);
  arm.position.set(0, -armLen / 2, 0);
  swatterPivot.add(arm);
  const paddle = new THREE.Mesh(
    new THREE.BoxGeometry(0.11, 0.012, 0.09),
    new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.55, metalness: 0.15 })
  );
  paddle.position.set(0, -armLen, 0);
  swatterPivot.add(paddle);
  swatterPivot.rotation.z = SWATTER_REST_ANGLE; // cocked/resting pose
  robotMesh.add(swatterPivot);

  // Camera FOV decal on the floor (local +X = forward)
  (function () {
    const halfFov = (CAM_FOV_DEG * Math.PI / 180) / 2;
    const N = 14, pts = [new THREE.Vector3(0, 0.004, 0)];
    for (let i = 0; i <= N; i++) {
      const a = -halfFov + (i / N) * halfFov * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * CAM_MAX_RANGE * 0.6, 0.004, Math.sin(a) * CAM_MAX_RANGE * 0.6));
    }
    const positions = [];
    for (let i = 1; i < pts.length - 1; i++) {
      positions.push(pts[0].x, pts[0].y, pts[0].z, pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const wedge = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x4ee6a0, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false }));
    wedge.userData.noShadow = true;
    robotMesh.add(wedge);
  })();

  room.add(robotMesh);
  const robotLight = new THREE.PointLight(0x4ee6a0, 0.35, 1.6);
  robotLight.position.set(0.2, 0.2, 0);
  robotMesh.add(robotLight);

  robotMesh.traverse((o) => { if (o.isMesh) { o.castShadow = !o.userData.noShadow; o.receiveShadow = false; } });
  chassis.castShadow = false;

  return { robotMesh, swatterPivot };
}
