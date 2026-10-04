// Movement controller + robot state machine, implemented from
// docs/movement-algorithm.md section 2 ("Proportional Controller / M3") and
// section 4 (state diagram: SEARCH -> TRACK -> APPROACH -> CAPTURE, with a
// RECOVER branch on target loss). The ultrasonic sensor is only ever used as
// a collision-safety override, never as the primary target-distance sensor,
// per section 3.

import { clamp, norm } from './utils.js';
import {
  CENTER_THRESHOLD, REENTER_TRACK_THRESHOLD, KP_TRACK, KP_APPROACH,
  BBOX_MEDIUM_MIN, BBOX_CLOSE_MIN, BBOX_CAPTURE_MIN,
  SPEED_FAR, SPEED_MEDIUM, SPEED_CLOSE,
  SEARCH_SCAN_RATE, RECOVER_TURN_RATE, RECOVER_TIMEOUT, CAPTURE_HOLD_TIME,
  SAFETY_STOP_CM, MAX_SPEED,
  STAKEOUT_SPEED, STAKEOUT_ARRIVAL_RADIUS, STAKEOUT_WAIT_TIME, STAKEOUT_ALIGN_THRESHOLD
} from './constants.js';

export function classifyRange(bboxSize) {
  if (bboxSize >= BBOX_CAPTURE_MIN) return 'CAPTURE';
  if (bboxSize >= BBOX_CLOSE_MIN) return 'CLOSE';
  if (bboxSize >= BBOX_MEDIUM_MIN) return 'MEDIUM';
  return 'FAR';
}

const TIER_SPEED = { FAR: SPEED_FAR, MEDIUM: SPEED_MEDIUM, CLOSE: SPEED_CLOSE };

export class RoachHunterFSM {
  constructor(onLog) {
    this.mode = 'SEARCH';
    this.lockedId = null;
    this.lastSeenSign = 1;
    this.recoverTimer = 0;
    this.captureTimer = 0;
    this.stakeoutTarget = null;
    this.stakeoutWaitTimer = 0;
    this.onLog = onLog || function () {};
  }

  reset() {
    this.mode = 'SEARCH';
    this.lockedId = null;
    this.recoverTimer = 0;
    this.captureTimer = 0;
    this.stakeoutTarget = null;
    this.stakeoutWaitTimer = 0;
  }

  /**
   * Chat tip-line hook: "a roach was seen near X" -> drive there right now.
   * Takes priority over whatever the robot was doing -- SEARCH, RECOVER, an
   * existing STAKEOUT, or even an in-progress TRACK/APPROACH of a different,
   * camera-confirmed target -- and drops that target to go investigate the
   * tip instead. The one exception is CAPTURE: that's a short, physically
   * committed gripper action (declines, returns false), not something that
   * makes sense to abort mid-swing.
   */
  reportSighting(x, z) {
    if (this.mode === 'CAPTURE') return false;
    this.lockedId = null;
    this.stakeoutTarget = { x, z };
    this.stakeoutWaitTimer = STAKEOUT_WAIT_TIME;
    this._setMode('STAKEOUT');
    return true;
  }

  _setMode(next) {
    if (next !== this.mode) this.onLog(this.mode, next, this.lockedId);
    this.mode = next;
  }

  /**
   * @param {number} dt seconds
   * @param {object|null} detection result of vision.detectTarget for this.lockedId
   * @param {number} ultrasonicCm HC-SR04 reading toward heading
   * @param {{x:number,z:number,angle:number}|null} robotPose only needed for STAKEOUT's goal-directed driving
   * @returns {{turn:number, speed:number, captured:boolean, rangeClass:string|null}}
   */
  step(dt, detection, ultrasonicCm, robotPose) {
    let turn = 0, speed = 0, captured = false, rangeClass = null;

    switch (this.mode) {
      case 'SEARCH':
        turn = SEARCH_SCAN_RATE;
        speed = 0;
        if (detection) { this.lockedId = detection.id; this._setMode('TRACK'); }
        break;

      case 'STAKEOUT': {
        // A real, camera-confirmed sighting always wins over a secondhand tip.
        if (detection) { this.lockedId = detection.id; this._setMode('TRACK'); break; }

        const dx = this.stakeoutTarget.x - robotPose.x, dz = this.stakeoutTarget.z - robotPose.z;
        const distRemaining = Math.hypot(dx, dz);
        if (distRemaining <= STAKEOUT_ARRIVAL_RADIUS) {
          // Arrived: hold position, scan slowly, wait to see if the tip pays off.
          turn = SEARCH_SCAN_RATE * 0.6;
          speed = 0;
          this.stakeoutWaitTimer -= dt;
          if (this.stakeoutWaitTimer <= 0) { this.stakeoutTarget = null; this._setMode('SEARCH'); }
        } else {
          // En route: always start (and keep correcting) by turning
          // clockwise -- positive turn, matching TRACK mode's documented
          // "positive turn = swing right" convention -- toward the reported
          // spot's bearing, rather than whichever way is shortest. Mostly
          // rotates in place while badly misaligned, then drives once
          // roughly facing the target.
          const bearingError = norm(Math.atan2(dz, dx) - robotPose.angle); // (-pi, pi]
          const misaligned = Math.abs(bearingError) > STAKEOUT_ALIGN_THRESHOLD;
          turn = misaligned ? KP_TRACK : 0;
          speed = misaligned ? STAKEOUT_SPEED * 0.2 : STAKEOUT_SPEED;
        }
        break;
      }

      case 'TRACK': {
        if (!detection) {
          this.recoverTimer = RECOVER_TIMEOUT;
          this._setMode('RECOVER');
          break;
        }
        const error = detection.ndcX; // normalized_error, section 2
        this.lastSeenSign = error < 0 ? -1 : 1;
        // ndcX>0 means the target is to the right of center, which (given
        // how the onboard camera's basis falls out of robot.angle) needs a
        // *positive* turn to swing the heading toward it. Verified empirically
        // in tools/headless-sim -- see docs/movement-algorithm.md's own note
        // to "verify the sign convention on the physical drivetrain."
        turn = clamp(KP_TRACK * error, -KP_TRACK, KP_TRACK);
        speed = 0;
        if (Math.abs(error) <= CENTER_THRESHOLD) this._setMode('APPROACH');
        break;
      }

      case 'APPROACH': {
        if (!detection) {
          this.recoverTimer = RECOVER_TIMEOUT;
          this._setMode('RECOVER');
          break;
        }
        const error = detection.ndcX;
        this.lastSeenSign = error < 0 ? -1 : 1;
        if (Math.abs(error) > REENTER_TRACK_THRESHOLD) { this._setMode('TRACK'); break; }

        turn = clamp(KP_APPROACH * error, -KP_APPROACH, KP_APPROACH);
        rangeClass = classifyRange(detection.bboxSize);
        if (rangeClass === 'CAPTURE') {
          this.captureTimer = CAPTURE_HOLD_TIME;
          this._setMode('CAPTURE');
          speed = 0; turn = 0;
          break;
        }
        speed = TIER_SPEED[rangeClass];
        break;
      }

      case 'CAPTURE':
        speed = 0; turn = 0;
        this.captureTimer -= dt;
        if (this.captureTimer <= 0) {
          captured = true;
          this.lockedId = null;
          this._setMode('SEARCH');
        }
        break;

      case 'RECOVER':
        turn = RECOVER_TURN_RATE * this.lastSeenSign;
        speed = 0;
        if (detection) { this.lockedId = detection.id; this._setMode('TRACK'); break; }
        this.recoverTimer -= dt;
        if (this.recoverTimer <= 0) { this.lockedId = null; this._setMode('SEARCH'); }
        break;
    }

    // Ultrasonic safety override (section 3): never the primary sensor,
    // always wins regardless of FSM state.
    if (ultrasonicCm < SAFETY_STOP_CM) {
      if (speed > 0) this.onLog(this.mode, this.mode, this.lockedId, 'SAFETY');
      speed = 0;
    }

    speed = clamp(speed, 0, MAX_SPEED);
    return { turn, speed, captured, rangeClass };
  }
}
