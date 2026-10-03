// Generic math / three.js helpers shared across modules.

export function rand(a, b) { return a + Math.random() * (b - a); }
export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
export function norm(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
export function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }
export function fmt(n, d) { return isFinite(n) ? n.toFixed(d === undefined ? 0 : d) : '--'; }

/**
 * Keeps a circular entity of `radius` out of a set of obstacles (axis-aligned
 * rects for furniture bodies, circles for thin posts like table legs).
 * Returns the corrected {x,z} plus, if a collision happened, the outward
 * surface normal so callers can deflect a heading off it.
 */
export function resolveObstacles(x, z, radius, obstacles) {
  let hit = false, nx = 0, nz = 0;
  for (const o of obstacles) {
    if (o.type === 'circle') {
      const dx = x - o.x, dz = z - o.z;
      const d = Math.hypot(dx, dz);
      const minD = o.r + radius;
      if (d < minD) {
        const inv = d > 1e-6 ? 1 / d : 0;
        const ux = d > 1e-6 ? dx * inv : 1, uz = d > 1e-6 ? dz * inv : 0;
        x = o.x + ux * minD; z = o.z + uz * minD;
        hit = true; nx = ux; nz = uz;
      }
    } else { // rect, expanded by radius
      const x1 = o.x1 - radius, x2 = o.x2 + radius, z1 = o.z1 - radius, z2 = o.z2 + radius;
      if (x > x1 && x < x2 && z > z1 && z < z2) {
        const dLeft = x - x1, dRight = x2 - x, dTop = z - z1, dBottom = z2 - z;
        const min = Math.min(dLeft, dRight, dTop, dBottom);
        if (min === dLeft) { x = x1; nx = -1; nz = 0; }
        else if (min === dRight) { x = x2; nx = 1; nz = 0; }
        else if (min === dTop) { z = z1; nx = 0; nz = -1; }
        else { z = z2; nx = 0; nz = 1; }
        hit = true;
      }
    }
  }
  return { x, z, hit, nx, nz };
}

/**
 * Projects a world-space point into a camera's screen space.
 * Returns null if the point is behind the camera or well outside the frame.
 */
export function projectToScreen(camera, worldPos, w, h, margin) {
  margin = margin === undefined ? 1.25 : margin;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const rel = worldPos.clone().sub(camera.position);
  const depth = dir.dot(rel);
  if (depth <= 0.03) return null;
  const v = worldPos.clone().project(camera);
  if (v.x < -margin || v.x > margin || v.y < -margin || v.y > margin) return null;
  return {
    ndcX: v.x, ndcY: v.y, depth,
    x: (v.x * 0.5 + 0.5) * w,
    y: (1 - (v.y * 0.5 + 0.5)) * h
  };
}
