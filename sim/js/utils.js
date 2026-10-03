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
 * True if the straight line from (x1,z1) to (x2,z2) passes through any solid
 * obstacle (same list resolveObstacles uses) -- so the onboard camera can't
 * "see" a roach standing behind furniture just because it's within range
 * and inside the frustum.
 */
export function segmentBlocked(x1, z1, x2, z2, obstacles) {
  for (const o of obstacles) {
    if (o.type === 'circle') {
      if (segmentCircleHit(x1, z1, x2, z2, o.x, o.z, o.r)) return true;
    } else if (segmentRectHit(x1, z1, x2, z2, o.x1, o.x2, o.z1, o.z2)) {
      return true;
    }
  }
  return false;
}

function segmentCircleHit(x1, z1, x2, z2, cx, cz, r) {
  const dx = x2 - x1, dz = z2 - z1;
  const fx = x1 - cx, fz = z1 - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
  return Math.max(0, Math.min(1, t2)) >= Math.min(1, Math.max(0, t1)) && t2 >= 0 && t1 <= 1;
}

// Liang-Barsky segment/AABB clip -- true if any part of the segment lies
// within the (axis-aligned) rect.
function segmentRectHit(x1, z1, x2, z2, rx1, rx2, rz1, rz2) {
  const dx = x2 - x1, dz = z2 - z1;
  const p = [-dx, dx, -dz, dz];
  const q = [x1 - rx1, rx2 - x1, z1 - rz1, rz2 - z1];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
  }
  return t0 <= t1;
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
