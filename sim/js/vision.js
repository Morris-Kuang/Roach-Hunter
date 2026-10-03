// Simulated onboard vision pipeline: "ESP32-CAM -> Object detection on laptop"
// (docs/movement-algorithm.md, section 1). In the real system this would be a
// frame classifier; here we derive an equivalent detection from the 3D scene
// so the rest of the pipeline (tracker -> controller) never needs to know the
// difference.
//
// A detection has the shape the controller expects from the spec:
//   { id, confidence, ndcX, ndcY, bboxW, bboxH, bboxSize, distance }
// ndcX/ndcY are the normalized_error terms from section 2 (0 = centered,
// +/-1 = edge of frame).

import { clamp, dist } from './utils.js';
import {
  CAM_FOV_DEG, CAM_MAX_RANGE, CONF_THRESHOLD, ROACH_HALF_W, ROACH_HALF_H,
  MOTION_BLUR_PENALTY, FLEE_SPEED_MAX
} from './constants.js';

function estimateBBox(camera, distance) {
  const fovV = CAM_FOV_DEG * Math.PI / 180;
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
  const d = Math.max(distance, 0.05);
  const w = clamp((2 * Math.atan(ROACH_HALF_W / d)) / fovH, 0, 1);
  const h = clamp((2 * Math.atan(ROACH_HALF_H / d)) / fovV, 0, 1);
  return { w, h, size: w * h };
}

/**
 * Runs "detection" against every live roach and returns the single target the
 * tracker should follow this frame, or null if nothing qualifies.
 *
 * Per the spec: "reject detections below a chosen confidence threshold and
 * select one target consistently when multiple detections appear." We bias
 * toward the currently-locked id (if it's still a valid detection) so the
 * tracker doesn't flicker between two visible roaches frame to frame.
 */
export function detectTarget(camera, robot, roaches, lockedId) {
  const candidates = [];
  for (const r of roaches) {
    if (!r.alive) continue;
    const d = dist(robot.x, robot.z, r.x, r.z);
    if (d > CAM_MAX_RANGE) continue;

    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    const worldPos = new THREE.Vector3(r.x, 0.07, r.z);
    const rel = worldPos.clone().sub(camera.position);
    if (dir.dot(rel) <= 0.03) continue;
    const v = worldPos.clone().project(camera);
    if (v.x < -1.05 || v.x > 1.05 || v.y < -1.05 || v.y > 1.05) continue;

    const bbox = estimateBBox(camera, d);
    const centrality = 1 - Math.min(1, Math.hypot(v.x, v.y) / 1.3);
    const rangeFactor = 1 - clamp(d / CAM_MAX_RANGE, 0, 1);
    const noise = Math.sin(performance.now() * 0.003 + r.id) * 0.04;
    // A fast-moving roach is small, close to the floor, and blurs -- harder
    // to classify confidently than one sitting still.
    const motionPenalty = clamp(r.speed / FLEE_SPEED_MAX, 0, 1) * MOTION_BLUR_PENALTY;
    const confidence = clamp(0.5 + centrality * 0.32 + rangeFactor * 0.22 + noise - motionPenalty, 0, 0.99);

    candidates.push({
      id: r.id, confidence,
      ndcX: v.x, ndcY: v.y,
      bboxW: bbox.w, bboxH: bbox.h, bboxSize: bbox.size,
      distance: d
    });
  }

  const valid = candidates.filter(c => c.confidence >= CONF_THRESHOLD);
  if (!valid.length) return null;

  const lockedStill = valid.find(c => c.id === lockedId);
  if (lockedStill) return lockedStill;

  valid.sort((a, b) => b.confidence - a.confidence);
  return valid[0];
}
