// Movement controller + robot state machine, implemented from
// docs/movement-algorithm.md section 2 ("Proportional Controller / M3") and
// section 4 (state diagram: SEARCH -> TRACK -> APPROACH -> CAPTURE, with a
// RECOVER branch on target loss). The ultrasonic sensor is only ever used as
// a collision-safety override, never as the primary target-distance sensor,
// per section 3.

import { clamp } from './utils.js';
import {
  CENTER_THRESHOLD, REENTER_TRACK_THRESHOLD, KP_TRACK, KP_APPROACH,
  BBOX_MEDIUM_MIN, BBOX_CLOSE_MIN, BBOX_CAPTURE_MIN,
  SPEED_FAR, SPEED_MEDIUM, SPEED_CLOSE,
  SEARCH_SCAN_RATE, RECOVER_TURN_RATE, RECOVER_TIMEOUT, CAPTURE_HOLD_TIME,
  SAFETY_STOP_CM, MAX_SPEED
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
    this.onLog = onLog || function () {};
  }

  reset() {
    this.mode = 'SEARCH';
    this.lockedId = null;
    this.recoverTimer = 0;
    this.captureTimer = 0;
  }

  _setMode(next) {
    if (next !== this.mode) this.onLog(this.mode, next, this.lockedId);
    this.mode = next;
  }

  /**
   * @param {number} dt seconds
   * @param {object|null} detection result of vision.detectTarget for this.lockedId
   * @param {number} ultrasonicCm HC-SR04 reading toward heading
   * @returns {{turn:number, speed:number, captured:boolean, rangeClass:string|null}}
   */
  step(dt, detection, ultrasonicCm) {
    let turn = 0, speed = 0, captured = false, rangeClass = null;

    switch (this.mode) {
      case 'SEARCH':
        turn = SEARCH_SCAN_RATE;
        speed = 0;
        if (detection) { this.lockedId = detection.id; this._setMode('TRACK'); }
        break;

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
