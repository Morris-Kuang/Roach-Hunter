# Roach Hunter — 3D Simulation

An independent browser-based 3D demo with a top-down room view, robot camera view, detection boxes, telemetry, and cockroach pursuit. Detection is simulated using scene geometry; the demo does not run YOLO or control the physical robot.

## Run

```bash
cd sim
python3 serve_nocache.py
```

Open [http://localhost:8000](http://localhost:8000). The server disables caching, so a normal refresh picks up JS/CSS changes. You can also use `python3 -m http.server 8000`. Three.js and fonts load from CDNs, so the initial page load requires internet access.

Use START, PAUSE, and RESET to control patrol. The chat box recognizes local keywords for the bed, nightstand, wardrobe, desk, trash can, and window, then sends the simulated robot to investigate. Capture and target-loss events display local messages; target loss also includes a camera snapshot. The heatmap shows target-loss and capture locations. No agent or API key is required.

## File Guide

| File | Purpose |
|---|---|
| `index.html`, `css/style.css` | Page structure and styling |
| `js/main.js` | Initialization, simulation loop, chat, and event handling |
| `js/constants.js` | Scene, speed, threshold, and landmark parameters |
| `js/controller.js` | Search, track, approach, capture, recovery, and stakeout state machine |
| `js/vision.js` | Simulated field of view, occlusion, and detection boxes |
| `js/chat.js` | Local landmark parsing and nearest-landmark lookup |
| `js/hud.js`, `js/telemetry.js` | Overlays, metrics, and event log |
| `js/utils.js` | Math, projection, and collision helpers |
| `js/scene/` | Room, robot, and cockroach models and behavior |
| `serve_nocache.py` | Static web server with caching disabled |

The simulation parameters and state machine are independent of `../main.py`. See the [project README](../README.md) for the physical robot's current operating instructions.
