// Builds the static bedroom set: floor, walls, lights, and furniture.

import { HALF_W, HALF_D } from '../constants.js';

function makeWoodTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#b98a56'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(120,80,45,.16)' : 'rgba(200,150,95,.10)';
    ctx.fillRect(0, i * 16, 256, 16);
    ctx.fillStyle = 'rgba(90,58,30,.18)';
    ctx.fillRect(0, i * 16, 256, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 3);
  return tex;
}

function box(w, h, d, color, opts) {
  opts = opts || {};
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness !== undefined ? opts.roughness : 0.85,
    metalness: opts.metalness || 0, transparent: !!opts.transparent,
    opacity: opts.opacity !== undefined ? opts.opacity : 1,
    emissive: opts.emissive || 0x000000, emissiveIntensity: opts.emissiveIntensity || 0
  });
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

/** Adds lights + the bedroom set to `scene` and returns a `room` group all meshes live under. */
export function buildRoom(scene) {
  const hemi = new THREE.HemisphereLight(0xdce9ff, 0x2a2018, 0.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.05);
  sun.position.set(4, 6, -2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -HALF_W - 1; sun.shadow.camera.right = HALF_W + 1;
  sun.shadow.camera.top = HALF_D + 1; sun.shadow.camera.bottom = -HALF_D - 1;
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 16;
  sun.shadow.bias = -0.0025;
  sun.shadow.radius = 2.5;
  scene.add(sun);
  const lamp = new THREE.PointLight(0xffb454, 0.9, 6.5, 2);
  lamp.position.set(-4.6, 1.5, -3.0);
  scene.add(lamp);

  const room = new THREE.Group();
  scene.add(room);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF_W * 2, HALF_D * 2),
    new THREE.MeshStandardMaterial({ map: makeWoodTexture(), roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  room.add(floor);


  const wallMat = new THREE.MeshStandardMaterial({ color: 0xece4d6, roughness: 1 });
  const WALL_H = 2.3;
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, WALL_H), wallMat);
  backWall.position.set(0, WALL_H / 2, -HALF_D);
  room.add(backWall);
  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(HALF_D * 2, WALL_H), wallMat);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-HALF_W, WALL_H / 2, 0);
  room.add(leftWall);
  const rightWall = new THREE.Mesh(new THREE.PlaneGeometry(HALF_D * 2, WALL_H), wallMat.clone());
  rightWall.rotation.y = -Math.PI / 2;
  rightWall.position.set(HALF_W, WALL_H / 2, 0);
  room.add(rightWall);
  const frontWall = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, WALL_H), wallMat.clone());
  frontWall.rotation.y = Math.PI;
  frontWall.position.set(0, WALL_H / 2, HALF_D);
  room.add(frontWall);

  const window1 = box(1.6, 1.0, 0.05, 0x9fd6e8, { emissive: 0x9fd6e8, emissiveIntensity: 0.35 });
  window1.position.set(-2.6, 1.5, -HALF_D + 0.03);
  room.add(window1);

  // bed (back-left corner)
  const bed = new THREE.Group();
  const bedFrame = box(2.2, 0.32, 3.0, 0x6b4a34); bedFrame.position.set(0, 0.16, 0);
  const mattress = box(2.05, 0.22, 2.85, 0xf3ede1); mattress.position.set(0, 0.42, 0);
  const blanket = box(2.05, 0.10, 1.6, 0x3f6f9e); blanket.position.set(0, 0.56, 0.5);
  const pillow1 = box(0.7, 0.16, 0.45, 0xffffff); pillow1.position.set(-0.55, 0.58, -1.15); pillow1.rotation.y = 0.05;
  const pillow2 = box(0.7, 0.16, 0.45, 0xffffff); pillow2.position.set(0.55, 0.58, -1.15); pillow2.rotation.y = -0.05;
  const headboard = box(2.2, 0.9, 0.12, 0x6b4a34); headboard.position.set(0, 0.75, -1.44);
  bed.add(bedFrame, mattress, blanket, pillow1, pillow2, headboard);
  bed.position.set(-4.6, 0, -2.2);
  room.add(bed);

  const nightstand = box(0.55, 0.55, 0.5, 0x5a3f2b);
  nightstand.position.set(-3.15, 0.275, -3.3);
  room.add(nightstand);
  const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.07, 0.32, 10), new THREE.MeshStandardMaterial({ color: 0xd8c9a3 }));
  lampBase.position.set(-3.15, 0.71, -3.3);
  room.add(lampBase);
  const lampShade = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.22, 10, 1, true), new THREE.MeshStandardMaterial({ color: 0xffdca0, emissive: 0xffb454, emissiveIntensity: 0.5, side: THREE.DoubleSide }));
  lampShade.position.set(-3.15, 0.98, -3.3);
  room.add(lampShade);

  // desk with monitor (back-right)
  const desk = box(2.1, 0.06, 0.85, 0x4a3a2a);
  desk.position.set(4.2, 0.72, -3.55);
  room.add(desk);
  for (let lx = -0.9; lx <= 0.9; lx += 1.8) {
    const leg = box(0.06, 0.72, 0.06, 0x2c2116);
    leg.position.set(4.2 + lx, 0.36, -3.55 + 0.35);
    room.add(leg);
  }
  const monitor = box(0.9, 0.55, 0.04, 0x11151a, { emissive: 0x2ee6a0, emissiveIntensity: 0.25 });
  monitor.position.set(3.9, 1.28, -3.75);
  room.add(monitor);
  const monitorStand = box(0.08, 0.22, 0.08, 0x2a2a2a);
  monitorStand.position.set(3.9, 0.98, -3.7);
  room.add(monitorStand);
  const laptop = box(0.5, 0.03, 0.36, 0xdadde0);
  laptop.position.set(4.75, 0.755, -3.55);
  room.add(laptop);
  const deskChair = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 16), new THREE.MeshStandardMaterial({ color: 0x2b2b2b }));
  deskChair.position.set(4.2, 0.46, -2.9);
  room.add(deskChair);
  const chairPole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.42, 8), new THREE.MeshStandardMaterial({ color: 0x555555 }));
  chairPole.position.set(4.2, 0.24, -2.9);
  room.add(chairPole);

  // wardrobe (right wall)
  const wardrobe = box(0.65, 2.0, 1.7, 0x5a4330);
  wardrobe.position.set(HALF_W - 0.35, 1.0, 1.4);
  room.add(wardrobe);

  // trash can (open floor, front-right corner -- away from all other furniture)
  const trashCan = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.17, 0.42, 16),
    new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.6, metalness: 0.15 })
  );
  trashCan.position.set(5.0, 0.21, 3.3);
  room.add(trashCan);
  const trashCanRim = new THREE.Mesh(
    new THREE.TorusGeometry(0.22, 0.015, 8, 20),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6, metalness: 0.2 })
  );
  trashCanRim.rotation.x = Math.PI / 2;
  trashCanRim.position.set(5.0, 0.42, 3.3);
  room.add(trashCanRim);

  // sofa (front-left corner, against the left wall -- was bare open floor)
  const sofa = new THREE.Group();
  const sofaBase = box(0.75, 0.38, 1.6, 0x3b5a73); sofaBase.position.set(0, 0.19, 0);
  const sofaBack = box(0.18, 0.5, 1.6, 0x33506a); sofaBack.position.set(-0.285, 0.44, 0);
  const sofaArmA = box(0.75, 0.22, 0.16, 0x33506a); sofaArmA.position.set(0, 0.5, -0.72);
  const sofaArmB = box(0.75, 0.22, 0.16, 0x33506a); sofaArmB.position.set(0, 0.5, 0.72);
  const cushionA = box(0.66, 0.14, 0.6, 0x4a6f8c); cushionA.position.set(0.02, 0.45, -0.42);
  const cushionB = box(0.66, 0.14, 0.6, 0x4a6f8c); cushionB.position.set(0.02, 0.45, 0.42);
  sofa.add(sofaBase, sofaBack, sofaArmA, sofaArmB, cushionA, cushionB);
  sofa.position.set(-HALF_W + 0.42, 0, 2.3);
  room.add(sofa);

  room.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  floor.castShadow = false;
  backWall.castShadow = false; leftWall.castShadow = false; rightWall.castShadow = false; frontWall.castShadow = false;
  window1.castShadow = false;

  return { room, floor };
}
