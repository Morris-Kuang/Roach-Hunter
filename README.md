# Roach-Hunter

> 🪳 There's a cockroach. Let the robot hunt it. 🪳

An autonomous robot that detects, tracks, pursues,
and captures cockroaches using computer vision.


## How It Works

Camera → Detection → Tracking → Control → Motors

## System Architecture
```text
roach-hunter/
├── README.md
├── docs/
│   ├── architecture.md
│   ├── movement-algorithm.md
│   ├── hardware.md
│   └── development-log.md
├── src/
│   ├── vision/
│   ├── controller/
│   └── esp32/
├── assets/
│   ├── architecture.png
│   ├── robot-photo.jpg
│   └── demo.gif
└── LICENSE
```

## Core Capabilities

- 👁 Detect cockroaches
- 🎯 Track moving targets
- 🤖 Autonomous pursuit
- 🔎 Recover lost targets
- 🪤 Capture target

## Hardware

ESP32 • ESP32-CAM • L298N • Ultrasonic Sensor

## Development Progress

✅ Robot locomotion
✅ Camera streaming
🟡 Object detection
⬜ Autonomous tracking
⬜ Capture
⬜ Trajectory prediction

## Documentation

→ System Architecture
→ Movement Algorithm
→ Hardware
→ Development Log
