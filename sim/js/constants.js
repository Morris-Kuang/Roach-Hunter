// All tunable numbers live here so the algorithm and the scene can be
// adjusted without hunting through the rest of the codebase.
//
// Values are deliberately picked to model a real household encounter rather
// than an arcade chase: a small hobby chassis is not faster than a startled
// cockroach, cockroaches spend most of their time hidden and only forage
// occasionally, they bolt for the nearest cover well before a slow robot can
// reach grabbing distance, and even a clean grab isn't guaranteed. See
// README.md "Why the robot mostly loses" for the reasoning.

// ---- room / world (meters) ----
export const HALF_W = 6, HALF_D = 4;   // room is 12 x 8
// Physical bumper/gripper contact radius -- a fallback capture trigger for
// when a roach wanders directly into the chassis outside of camera view
// (see main.js's contact-capture pass), independent of the vision pipeline.
export const CATCH_RADIUS = 0.16;
export const MAX_SPEED = 0.62;         // m/s, robot top speed (small TT-motor 2WD chassis)
export const TURN_RATE = 2.4;          // rad/s, robot max turn rate
export const ROBOT_FOOTPRINT_RADIUS = 0.22; // m, for furniture collision

// ---- onboard camera (ESP32-CAM) ----
export const CAM_FOV_DEG = 64;         // vertical FOV
export const CAM_MAX_RANGE = 6.2;      // detector gives up beyond this range

// ---- vision / detection (docs/movement-algorithm.md, section 1) ----
export const CONF_THRESHOLD = 0.58;    // reject detections below this confidence
// A real cockroach is ~10cm nose-to-tail at most -- small next to the robot.
export const ROACH_HALF_W = 0.055;     // approx. body half-length used for bbox estimate (m)
export const ROACH_HALF_H = 0.02;      // approx. body half-height (m)
export const ROACH_FOOTPRINT_RADIUS = 0.05; // m, for furniture collision
export const MOTION_BLUR_PENALTY = 0.30; // confidence lost at full flee speed (fast + small = hard to classify)

// ---- steering control (section 2, "Proportional Controller / M3") ----
export const CENTER_THRESHOLD = 0.10;      // |normalized_error| below this = "centered"
export const REENTER_TRACK_THRESHOLD = 0.28; // APPROACH -> TRACK when error exceeds this
export const KP_TRACK = TURN_RATE;          // full authority while acquiring
export const KP_APPROACH = TURN_RATE * 0.5; // gentler corrections while driving

// ---- distance-from-bbox-size tiers (section 3) ----
// Thresholds are scaled to ROACH_HALF_W/H so the FAR/MEDIUM/CLOSE/CAPTURE
// transitions happen at the same real distances (~2.9m / 1.2m / 0.5m)
// regardless of how big the roach model is drawn.
export const BBOX_MEDIUM_MIN = 0.0003;
export const BBOX_CLOSE_MIN = 0.001667;
export const BBOX_CAPTURE_MIN = 0.009167;
export const SPEED_FAR = MAX_SPEED * 0.95;
export const SPEED_MEDIUM = MAX_SPEED * 0.62;
export const SPEED_CLOSE = MAX_SPEED * 0.28;

// ---- ultrasonic safety stop (section 3) ----
export const SAFETY_STOP_CM = 10;

// ---- state machine timing (section 4) ----
export const SEARCH_SCAN_RATE = 0.5;    // rad/s while SEARCHing
export const RECOVER_TURN_RATE = TURN_RATE * 0.6;
export const RECOVER_TIMEOUT = 1.6;     // seconds before RECOVER -> SEARCH
export const CAPTURE_HOLD_TIME = 0.32;  // seconds motors stay stopped during a capture attempt

// ---- capture reliability ----
// Even at point-blank range a DIY gripper doesn't grab cleanly every time,
// and it's far worse against a roach that's already mid-sprint. Tuned so a
// clean, unhurried approach usually pays off, but nothing is guaranteed.
export const CAPTURE_SUCCESS_BASE = 0.78;
export const CAPTURE_SUCCESS_FLEEING_FACTOR = 0.35;
export const SQUASH_DURATION = 0.35;    // seconds, flatten-and-vanish animation on a hit
export const SWATTER_REST_ANGLE = -1.1;  // rad, cocked/idle pose
export const SWATTER_STRIKE_ANGLE = 0.35; // rad, swung down in front of the chassis

// ---- roach population & lifecycle ----
// Roaches spend most of the demo hidden; only a couple are ever out foraging
// at once, and each one eventually heads back to cover on its own.
export const ROACH_POOL_SIZE = 4;
export const FORAGE_SPEED_MIN = 0.10, FORAGE_SPEED_MAX = 0.22;  // m/s, cautious foraging
export const FLEE_SPEED_MIN = 1.00, FLEE_SPEED_MAX = 1.40;      // m/s, panic sprint for cover
export const FORAGE_DURATION_MIN = 8, FORAGE_DURATION_MAX = 18; // s, before it heads home on its own
export const HIDDEN_INTERVAL_MIN = 6, HIDDEN_INTERVAL_MAX = 16; // s, spent out of sight before re-emerging
export const HIDEOUT_RADIUS = 0.3;      // m, reaching this near a hideout = gone

// Startle response: probability per second of noticing the robot and
// bolting, scaled by proximity. Not a hard tripwire distance -- a slow,
// careful approach has a real chance of staying unnoticed long enough to
// get close, though it's still the more likely outcome that it gets spotted.
export const ALERT_RADIUS = 0.95;       // m, beyond this the robot is never noticed
export const ALERT_BASE_RATE = 1.1;     // 1/s, notice rate when the robot is right on top of it

// Named hideouts, positioned just outside the furniture footprints below so
// they're always reachable (not swallowed by the obstacle they belong to).
export const HIDEOUTS = [
  { name: 'under the bed', x: -4.6, z: -0.45 },
  { name: 'behind the wardrobe', x: 5.15, z: 1.4 },
  { name: 'under the nightstand', x: -3.15, z: -2.85 },
  { name: 'under the desk', x: 4.2, z: -3.2 }
];

// Solid collision footprints matching the furniture built in scene/room.js --
// roaches (and the robot) are physically blocked by these, they don't just
// clip through the models. Desk *legs* are separate thin posts (you can walk
// between them, under the tabletop) rather than one solid desk-shaped box.
export const OBSTACLES = [
  { type: 'rect', x1: -5.7, x2: -3.5, z1: -3.7, z2: -0.7 },        // bed
  { type: 'rect', x1: -3.425, x2: -2.875, z1: -3.55, z2: -3.05 },  // nightstand
  { type: 'rect', x1: HALF_W - 0.65, x2: HALF_W, z1: 0.55, z2: 2.25 }, // wardrobe
  { type: 'circle', x: 3.3, z: -3.2, r: 0.09 },  // desk leg
  { type: 'circle', x: 5.1, z: -3.2, r: 0.09 }   // desk leg
];
