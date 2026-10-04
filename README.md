# Roach Hunter 🪳

A robot that detects cockroaches with YOLO and uses an ESP32 to control a two-wheel chassis and servo capture mechanism. The computer handles camera frames, detection, and pursuit decisions; the ESP32 executes motor commands.

## Project Structure

```text
Roach-Hunter/
├── main.py                         Physical robot entry point
├── best.pt                         Cockroach detection model used by main.py
├── firmware/
│   └── robot_controller/
│       └── robot_controller.ino    ESP32 Wi-Fi, motor, and servo firmware
├── model_training/
│   ├── train.py                    YOLO11n fine-tuning script
│   ├── data/                       Train/validation/test images and YOLO labels
│   └── runs/                       Saved training weights, metrics, and predictions
└── sim/                            Independent browser-based 3D demo
```

## Run the Physical Robot

You need Python 3, a working camera, and an ESP32 with the firmware installed.

Install the Python dependencies from the project root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install ultralytics opencv-python requests
```

Open `firmware/robot_controller/robot_controller.ino` in the Arduino IDE. Install ESP32 board support and the `ESP32Servo` library, select your ESP32 board, and upload the sketch. Use the pin constants in the firmware as the wiring reference: L298N control pins are 25, 26, 27, and 33; the servo signal pin is 13.

The ESP32 creates a `ROACH-HUNTER` Wi-Fi access point. Its password is defined by `WIFI_PASSWORD` in the firmware. Connect the computer to that network, then run:

```bash
python3 main.py
```

The default ESP32 address is `http://192.168.4.1`, and the camera index is `0`.

## Current Control Flow

The system divides perception and decision-making from hardware control. `main.py` runs on the computer, detects cockroaches, and decides how the robot should move. `robot_controller.ino` runs on the ESP32 and translates HTTP commands into motor and servo actions.

```text
Camera frames
     ↓
YOLO cockroach detection
     ↓
Filter detections and select the largest bounding box
     ↓
SEARCH → CHASE → ATTACK → CAPTURE → Exit
     ↓
HTTP commands over Wi-Fi
     ↓
ESP32 → L298N wheel control / Capture servo
```

### 1. Startup and Detection

The computer checks that the camera can provide frames and that the ESP32 responds over HTTP. It then loads `best.pt` and starts a background thread to refresh motor commands.

For each camera frame, YOLO detects potential targets. The program accepts only detections labeled `cockroach` with confidence of at least `0.25`.

Each accepted detection provides:

- The bounding box and its center.
- The horizontal center position relative to the frame width.
- The bounding-box area relative to the total frame area.

The largest bounding box is selected as the current target, using apparent size as a rough proximity cue. Selection is repeated every frame; the program does not maintain a persistent target ID.

### 2. Pursuit State Machine

| State | Behavior | Transition |
|---|---|---|
| `SEARCH` | Keep the wheels stopped while processing camera frames. | A valid target appears → `CHASE`. |
| `CHASE` | Turn toward the target or move forward when aligned. | Aligned target reaches 3% frame coverage → `ATTACK`. More than 15 consecutive frames without a target → stop and return to `SEARCH`. |
| `ATTACK` | Continue moving forward without steering corrections. | Target reaches 3.5% frame coverage, or the attack lasts at least two seconds → `CAPTURE`. |
| `CAPTURE` | Stop the wheels and motor-command thread, then activate the capture mechanism once. | Exit after the capture request completes or fails. |

**Steering during `CHASE`:**

- Target center below 55% of the frame width → turn left.
- Target center above 85% → turn right.
- Target center between 55% and 85%, inclusive → move forward, or enter `ATTACK` if the area threshold is met.

These thresholds define the current alignment zone. Bounding-box area is an image-based proximity cue rather than a measured physical distance.

If detection temporarily disappears during `CHASE`, the program keeps refreshing the previous motor command for up to 15 missing frames. During `ATTACK`, it continues forward even if detection disappears; the two-second timeout still provides a capture trigger.

### 3. Capture Sequence

When the target reaches the capture-area threshold, the robot makes a final 100 ms forward push before stopping. The timeout-triggered path stops without this additional push.

In `CAPTURE`, the computer:

1. Sets the desired motor command to stop.
2. Stops the background motor-command thread and waits for it to finish.
3. Sends a final stop command to the ESP32.
4. Waits 200 ms for the chassis to settle.
5. Marks capture as attempted, then requests `/capture`.

The flag is set before the HTTP request so that cleanup does not repeat the servo action if the response times out. Capture is attempted at most once per program run.

A successful response means the ESP32 completed the programmed servo cycle. The program does not visually verify whether a cockroach was caught.

### 4. ESP32 Hardware Controller

`robot_controller.ino` provides the hardware interface. At startup, it configures the motor pins, stops the wheels, initializes the servo at its neutral pulse, creates the `ROACH-HUNTER` Wi-Fi access point, and starts an HTTP server on port 80.

The capture mechanism is placed in its ready position manually before running the Python program.

#### Wheel Commands

The computer sends commands to `/cmd?d=<command>`. The ESP32 sets the L298N direction-control pins accordingly:

| Command | Action |
|---|---|
| `F` | Drive both wheels forward. |
| `B` | Drive both wheels backward. |
| `L` | Drive the wheels in opposite directions to turn left. |
| `R` | Drive the wheels in opposite directions to turn right. |
| `X` or an unrecognized command | Set all motor-control pins low to stop the wheels. |

The current firmware uses digital direction control rather than variable wheel-speed PWM.

The Python sender waits 150 ms between completed motor requests. Each movement command received by the ESP32 refreshes its watchdog timer. If the wheels are moving and no movement command arrives for more than 1200 ms, the firmware stops them.

#### Capture Servo

On `/capture`, the ESP32:

1. Stops the wheels.
2. Sends a `1300 µs` pulse to the servo for 2000 ms.
3. Returns the pulse to the configured neutral value of `1500 µs`.
4. Responds with `CAPTURE COMPLETE`.

This handler blocks while the servo cycle runs, which is why the computer stops its motor-command thread before requesting capture.

The firmware also exposes `/servo?us=<value>` for manual calibration, clamping the pulse to `1200–1800 µs`. A `/ready` endpoint remains available for reverse-direction movement, but `main.py` does not call it.

### 5. Shutdown Behavior

After the ESP32 connection succeeds and the program enters the main flow, cleanup stops the wheels and ends the motor-command thread.

If capture has not yet been attempted, cleanup also calls `/capture`. This applies to Q, Ctrl+C, camera read failure, and other exits from that flow. The camera is then released and the display windows are closed.

This preserves the current operating behavior: ending pursuit can still activate the capture servo.

## Train the Model

The dataset contains 121 training images, 34 validation images, and 16 test images, with one class: `cockroach`.

Run from the project root:

```bash
python3 model_training/train.py
```

The script resolves `data/data.yaml`, which is designed to simulate the scenes the robot would see through its camera during real-world cockroach hunting. The first run may require internet access to download `yolo11n.pt`. Current settings are 50 epochs, a 640-pixel input size, and batch size 16.

Ultralytics determines the output location using its defaults, typically under `runs/detect/` in the working directory, with numbered directories for subsequent runs. To deploy a newly trained model, manually copy the selected run's `weights/best.pt` to `best.pt` in the project root.

## 3D Simulation

The simulation is an independent demo with simulated detection and a robot state machine. It does not run YOLO or control the ESP32.

```bash
cd sim
python3 serve_nocache.py
```

Open [http://localhost:8000](http://localhost:8000). Use START, PAUSE, and RESET to control patrol, and the chat box to report sightings near landmarks such as the bed, wardrobe, or desk.

Three.js and fonts load from CDNs, so the initial page load requires internet access. See [sim/README.md](sim/README.md) for the simulation file guide.
