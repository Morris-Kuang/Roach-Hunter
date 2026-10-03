# Roach Hunter — 3D Simulation

A browser-based 3D simulation of the Roach Hunter robot patrolling a bedroom,
used as a hackathon demo when the physical robot isn't available. Left panel
is a top-down tactical view; right panel is the robot's onboard camera feed
with a live AIOT-style detection/telemetry HUD.

The movement algorithm follows
[`../Roach-Hunter/docs/movement-algorithm.md`](../Roach-Hunter/docs/movement-algorithm.md)
(detect → track → steer → approach → capture, with lost-target recovery),
so the simulated robot's behavior matches the real robot's intended design,
not just a generic "chase the target" script.

## Running it

The project uses ES modules, so it must be served over HTTP (opening
`index.html` directly with `file://` will be blocked by the browser).

```bash
cd sim
python3 -m http.server 8000
```

Then open `http://localhost:8000`. An internet connection is required — the
page loads Three.js and a Google Font from a CDN.

The simulation starts automatically. Use **PAUSE** / **RESET** in the top bar
to control it.

## Project structure

```text
sim/
├── index.html            page shell + all DOM (panels, stat tiles, log)
├── css/style.css          AIOT/HUD visual theme
└── js/
    ├── main.js             entry point: builds the scene, runs the loop,
    │                       wires vision -> controller -> motors -> render
    ├── constants.js        every tunable number (world size, algorithm
    │                       thresholds, hardware limits) in one place
    ├── utils.js             math + camera-projection helpers
    ├── vision.js            simulated ESP32-CAM detector (section 1 of the
    │                       algorithm doc): bbox, confidence, normalized error
    ├── controller.js        RoachHunterFSM: the SEARCH/TRACK/APPROACH/
    │                       CAPTURE/RECOVER state machine + proportional
    │                       steering (sections 2-4)
    ├── telemetry.js         DOM bindings for the stat tiles + event log
    ├── hud.js                canvas overlays (bounding boxes, crosshair,
    │                       scanline sweep) drawn on top of each 3D panel
    └── scene/
        ├── room.js           bedroom set: floor, walls, lights, furniture
        ├── robot.js          robot mesh + camera-FOV floor decal
        └── roach.js          roach mesh + wander/flee behavior
```

## How the algorithm maps to the code

| Doc section | Code |
|---|---|
| 1. Object Detection | `vision.js` — `detectTarget()` projects each roach into the onboard camera and returns confidence + bbox, same shape a real detector would emit |
| 2. Steering Control (M2/M3) | `controller.js` — proportional turn from `normalized_error` (`KP_TRACK` / `KP_APPROACH`) |
| 3. Distance & Obstacle Handling | `controller.js` `classifyRange()` uses **bbox size**, not ultrasonic, to pick FAR/MEDIUM/CLOSE/CAPTURE speed; `SAFETY_STOP_CM` is the only place the ultrasonic reading affects motion |
| 4. Robot State Machine | `controller.js` `RoachHunterFSM` — SEARCH → TRACK → APPROACH → CAPTURE, with RECOVER on target loss |

Everything the FSM decides each frame (mode, PWM per wheel, confidence, bbox
size, HC-SR04 reading) is surfaced live in the stat tiles and the onboard-cam
HUD, so the state machine's behavior is visible while it runs.

## Why the robot mostly loses

This isn't a "swarm of roaches, robot vacuums them all up instantly" demo —
it's tuned to feel like actually trying to catch a roach at home:

- **Roaches are mostly hidden.** Only 1–2 are ever out foraging at once
  (`ROACH_POOL_SIZE` in `constants.js`); each one emerges from a named
  hideout, forages for a while, then heads back on its own. Long empty
  `SEARCH` stretches are expected, not a bug.
- **The robot is not faster than a startled roach.** `MAX_SPEED` (a small
  TT-motor 2WD chassis, ~0.6 m/s) is well below a fleeing roach's sprint
  (`FLEE_SPEED_MIN/MAX`, ~1.0–1.4 m/s). Once a roach bolts, the robot
  essentially cannot catch up — it only wins by getting close *before* that
  happens.
- **Noticing the robot is a probability, not a tripwire.** `scene/roach.js`
  rolls an alert chance every frame, scaled by distance (`ALERT_RADIUS`,
  `ALERT_BASE_RATE`) — so a slow approach has a real chance of staying
  unnoticed a little longer, but most approaches still get spotted with
  plenty of room to spare.
- **Roaches flee toward cover, not just "away."** `startle()` picks the
  nearest of the named `HIDEOUTS` (under the bed, behind the wardrobe, …)
  and beelines for it; reaching it ends the chase (`'escaped'`).
- **A clean grab isn't guaranteed.** Even at capture range,
  `CAPTURE_SUCCESS_BASE` caps the odds, and `CAPTURE_SUCCESS_FLEEING_FACTOR`
  crushes them further if the target was already mid-sprint. A missed grab
  on a still-foraging roach also startles it (`victim.startle()`), so a near
  miss turns into a chase like it would in real life.

The stat panel's **Missed / Escaped** tile and the event log ("STARTLED",
"ESCAPED", "CAPTURE ATTEMPT MISSED") make these failures visible instead of
hiding them — the point of the demo is showing the algorithm working
*honestly*, including the parts where it doesn't win.

## Hardware this maps to

Per `../robot_config.md`: ESP32, ESP32-CAM (Freenove), L298N motor driver,
2WD smart chassis with encoders. The telemetry panel's fields correspond
directly to these parts (HC-SR04 ultrasonic, L298N PWM duty per wheel,
encoder RPM, ESP32 WiFi RSSI) rather than generic made-up sensors.
