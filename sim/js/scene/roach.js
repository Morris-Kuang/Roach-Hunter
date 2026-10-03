// Cockroach mesh + lifecycle. Modeled on how roaches actually behave around
// a household robot: they spend most of their time hidden, forage
// cautiously in short bouts, and bolt for the nearest cover well before
// anything can reach them -- the robot's own algorithm (controller.js) never
// touches this file, it only ever sees the world through vision.js, exactly
// like the real ESP32-CAM pipeline would.

import { rand, dist, norm, clamp, resolveObstacles } from '../utils.js';
import {
  HALF_W, HALF_D, HIDEOUTS, OBSTACLES, ROACH_FOOTPRINT_RADIUS,
  ALERT_RADIUS, ALERT_BASE_RATE,
  FORAGE_SPEED_MIN, FORAGE_SPEED_MAX, FLEE_SPEED_MIN, FLEE_SPEED_MAX,
  FORAGE_DURATION_MIN, FORAGE_DURATION_MAX,
  HIDDEN_INTERVAL_MIN, HIDDEN_INTERVAL_MAX, HIDEOUT_RADIUS, SQUASH_DURATION,
  DUCK_DURATION
} from '../constants.js';

// A real cockroach is small: roughly 10cm nose-to-tail, 4cm wide, 2cm tall --
// clearly smaller than the robot chassis (see scene/robot.js), not a
// dinner-plate-sized bug. Local +X is "forward" (see update()'s
// rotation.y = -angle mapping), so the body is elongated along X, not Z.
function makeRoachMesh() {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b1810, roughness: 0.5, metalness: 0.15 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), bodyMat);
  body.scale.set(0.055, 0.02, 0.033);
  body.position.y = 0.022;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), bodyMat);
  head.position.set(0.062, 0.022, 0);
  g.add(head);

  const legMat = new THREE.MeshStandardMaterial({ color: 0x1a0f0a, roughness: 0.6 });
  const legGroup = new THREE.Group();
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.05, 4), legMat);
      leg.position.set(-0.035 + i * 0.035, 0.011, s * 0.032);
      leg.rotation.x = s * 0.9;
      leg.rotation.z = 0.15;
      legGroup.add(leg);
    }
  }
  g.add(legGroup);

  for (let a = -1; a <= 1; a += 2) {
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.045, 4), legMat);
    ant.position.set(0.068, 0.035, a * 0.01);
    ant.rotation.z = a * 0.5;
    ant.rotation.x = -0.5;
    g.add(ant);
  }

  g.userData.legGroup = legGroup;
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  return g;
}

function nearestHideout(x, z) {
  let best = HIDEOUTS[0], bestD = Infinity;
  for (const h of HIDEOUTS) {
    const d = dist(x, z, h.x, h.z);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

export class Roach {
  constructor(id, room) {
    this.id = id;
    this.mesh = makeRoachMesh();
    this.mesh.visible = false;
    room.add(this.mesh);
    this.home = HIDEOUTS[id % HIDEOUTS.length];
    this.state = 'hidden';
    this.alive = false;
    this.x = this.home.x; this.z = this.home.z; this.angle = 0;
    this.speed = 0;
    // Stagger initial emergence so the room doesn't feel populated on frame 1.
    this.timer = rand(1, HIDDEN_INTERVAL_MAX);
  }

  _hide(delay) {
    this.state = 'hidden';
    this.alive = false;
    this.mesh.visible = false;
    this.timer = delay !== undefined ? delay : rand(HIDDEN_INTERVAL_MIN, HIDDEN_INTERVAL_MAX);
  }

  _emerge() {
    this.state = 'foraging';
    this.alive = true;
    this.x = this.home.x; this.z = this.home.z;
    // Head out into the room rather than straight back into the wall.
    this.angle = Math.atan2(0 - this.z, 0 - this.x) + rand(-0.7, 0.7);
    this.speed = rand(FORAGE_SPEED_MIN, FORAGE_SPEED_MAX);
    this.wanderT = rand(0.5, 1.8);
    this.forageTimer = rand(FORAGE_DURATION_MIN, FORAGE_DURATION_MAX);
  }

  /** Called by main.js on a successful capture: flatten in place, then vanish. */
  markCaught() {
    this.state = 'squashed';
    this.alive = false; // no longer a valid target the instant it's hit
    this.speed = 0;
    this.squashTimer = SQUASH_DURATION;
  }

  /** Starts the shrink-into-cover animation once it reaches a hideout spot. */
  _startDuck() {
    this.state = 'ducking';
    this.alive = false; // no longer a valid target the instant it reaches cover
    this.speed = 0;
    this.duckTimer = DUCK_DURATION;
  }

  /** Startles this roach into fleeing toward the nearest hideout, right now. */
  startle() {
    this.state = 'fleeing';
    this.fleeTarget = nearestHideout(this.x, this.z);
    this.speed = rand(FLEE_SPEED_MIN, FLEE_SPEED_MAX);
  }

  /**
   * Advances this roach by dt seconds. Returns 'startled' | 'escaped' |
   * 'retreated' | null so main.js can log the transitions that matter for
   * whichever roach the robot currently has locked.
   */
  update(dt, simTime, robot) {
    if (this.state === 'hidden') {
      this.timer -= dt;
      if (this.timer <= 0) this._emerge();
      return null;
    }

    if (this.state === 'squashed') {
      this.squashTimer -= dt;
      const p = 1 - clamp(this.squashTimer / SQUASH_DURATION, 0, 1);
      this.mesh.scale.set(1 + p * 0.7, Math.max(0.06, 1 - p * 0.92), 1 + p * 0.7);
      if (this.squashTimer <= 0) {
        this.mesh.scale.set(1, 1, 1);
        this._hide();
      }
      return null;
    }

    if (this.state === 'ducking') {
      // Shrinks and sinks in place -- reads as "squeezing into a gap",
      // not a teleport-style pop. Position/rotation stay put; only scale
      // and height change, so it's still visible mid-shrink if you're
      // looking right at it.
      this.duckTimer -= dt;
      const p = 1 - clamp(this.duckTimer / DUCK_DURATION, 0, 1);
      const s = Math.max(0.02, 1 - p);
      this.mesh.scale.set(s, s, s);
      this.mesh.position.y = -p * 0.02;
      if (this.duckTimer <= 0) {
        this.mesh.scale.set(1, 1, 1);
        this.mesh.position.y = 0;
        this._hide();
      }
      return null;
    }

    // Shared startle check for both foraging and retreating roaches.
    const checkStartle = () => {
      const d = dist(robot.x, robot.z, this.x, this.z);
      if (d >= ALERT_RADIUS) return false;
      const rate = ALERT_BASE_RATE * clamp(1 - d / ALERT_RADIUS, 0, 1);
      return Math.random() < rate * dt;
    };

    let event = null;

    if (this.state === 'foraging') {
      if (checkStartle()) {
        this.startle();
        event = 'startled';
      } else {
        this.wanderT -= dt;
        if (this.wanderT <= 0) { this.angle += rand(-1.1, 1.1); this.wanderT = rand(0.6, 1.8); }
        this.forageTimer -= dt;
        if (this.forageTimer <= 0) this.state = 'retreating';
      }
    } else if (this.state === 'retreating') {
      if (checkStartle()) {
        this.startle();
        event = 'startled';
      } else {
        this.angle = norm(Math.atan2(this.home.z - this.z, this.home.x - this.x));
        if (dist(this.x, this.z, this.home.x, this.home.z) < HIDEOUT_RADIUS) {
          this._startDuck();
          return 'retreated';
        }
      }
    } else if (this.state === 'fleeing') {
      this.angle = norm(Math.atan2(this.fleeTarget.z - this.z, this.fleeTarget.x - this.x));
      if (dist(this.x, this.z, this.fleeTarget.x, this.fleeTarget.z) < HIDEOUT_RADIUS) {
        this._startDuck();
        return 'escaped';
      }
    }

    this.x += Math.cos(this.angle) * this.speed * dt;
    this.z += Math.sin(this.angle) * this.speed * dt;
    const m = 0.35;
    if (this.x < -HALF_W + m) { this.x = -HALF_W + m; this.angle = Math.PI - this.angle; }
    if (this.x > HALF_W - m) { this.x = HALF_W - m; this.angle = Math.PI - this.angle; }
    if (this.z < -HALF_D + m) { this.z = -HALF_D + m; this.angle = -this.angle; }
    if (this.z > HALF_D - m) { this.z = HALF_D - m; this.angle = -this.angle; }

    // Furniture is solid -- deflect off it the same way a wall would.
    const resolved = resolveObstacles(this.x, this.z, ROACH_FOOTPRINT_RADIUS, OBSTACLES);
    if (resolved.hit) {
      this.x = resolved.x; this.z = resolved.z;
      const d = Math.cos(this.angle) * resolved.nx + Math.sin(this.angle) * resolved.nz;
      this.angle = Math.atan2(Math.sin(this.angle) - 2 * d * resolved.nz, Math.cos(this.angle) - 2 * d * resolved.nx);
    }

    this.mesh.visible = true;
    this.mesh.position.set(this.x, 0, this.z);
    this.mesh.rotation.y = -this.angle;
    const wigRate = this.state === 'fleeing' ? 26 : 14;
    const wig = Math.sin(simTime * wigRate + this.id) * 0.35;
    this.mesh.userData.legGroup.rotation.z = wig * 0.3;
    this.mesh.position.y = Math.abs(Math.sin(simTime * wigRate + this.id)) * 0.006;

    return event;
  }
}
