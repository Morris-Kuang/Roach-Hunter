import cv2
import time
import threading
import requests

from ultralytics import YOLO


# ============================================================
# CONFIG
# ============================================================

# ------------------------------------------------------------
# ESP32
# ------------------------------------------------------------

ESP32 = "http://172.20.10.3"

# ESP32 has a 500 ms safety timeout.
# We send the current motor command every 150 ms.
MOTOR_SEND_INTERVAL = 0.15


# ------------------------------------------------------------
# YOLO target
# ------------------------------------------------------------

# Fake cockroaches are currently detected as "bird"
TARGET_CLASS = "bird"


# ------------------------------------------------------------
# Steering zones
# ------------------------------------------------------------

LEFT_BOUNDARY = 0.40
RIGHT_BOUNDARY = 0.60


# ------------------------------------------------------------
# Distance proxy
#
# bbox area / whole frame area
#
# These values are TEMPORARY.
# Recalibrate after mounting the final camera on the robot.
# ------------------------------------------------------------

ATTACK_AREA_THRESHOLD = 0.08
CAPTURE_AREA_THRESHOLD = 0.18


# During normal CHASE:
# how many consecutive frames can we lose the target
# before giving up and searching again?

MAX_LOST_FRAMES = 15


# Once ATTACK begins, we commit forward.
# This prevents the robot from attacking forever if vision fails.

MAX_ATTACK_TIME = 2.0


# How long to wait for physical capture mechanism to finish

CAPTURE_WAIT_TIME = 2.0


# During VERIFY:
# target must be missing for this many frames
# before we consider capture successful.

VERIFY_LOST_FRAMES = 10


# ============================================================
# MOTOR COMMUNICATION STATE
# ============================================================

# X = stop
# F = forward
# L = left
# R = right
# B = backward

desired_command = "X"

motor_sender_running = True

# Prevent simultaneous modification while sender reads command
motor_lock = threading.Lock()


# ============================================================
# ESP32 COMMUNICATION
# ============================================================

def set_motor_command(command):
    """
    Update the command that should continuously be sent
    to the ESP32.

    This does NOT perform HTTP itself.
    The motor_sender thread handles networking.
    """

    global desired_command

    with motor_lock:
        desired_command = command


def send_command_once(command):
    """
    Send one HTTP motor command immediately.
    Used mainly for emergency STOP.
    """

    try:

        response = requests.get(
            f"{ESP32}/cmd",
            params={"d": command},
            timeout=0.2
        )

        return response.status_code == 200

    except requests.RequestException:

        return False


def motor_sender():
    """
    Runs independently from YOLO.

    Sends the latest desired motor command every 150 ms.

    This is important because ESP32 automatically stops
    the motors if it receives no command for 500 ms.
    """

    global motor_sender_running

    last_printed_error = 0

    while motor_sender_running:

        with motor_lock:
            command = desired_command

        try:

            requests.get(
                f"{ESP32}/cmd",
                params={"d": command},
                timeout=0.2
            )

        except requests.RequestException as error:

            # Avoid flooding terminal with errors
            current_time = time.time()

            if current_time - last_printed_error > 2:

                print(
                    f"⚠️ ESP32 connection error: {error}"
                )

                last_printed_error = current_time

        time.sleep(MOTOR_SEND_INTERVAL)


# ============================================================
# ROBOT ACTIONS
# ============================================================

def move_left():

    set_motor_command("L")

    return "LEFT"


def move_right():

    set_motor_command("R")

    return "RIGHT"


def move_forward():

    set_motor_command("F")

    return "FORWARD"


def move_backward():

    set_motor_command("B")

    return "REVERSE"


def stop():

    set_motor_command("X")

    return "STOP"


def activate_capture():
    """
    Physical capture mechanism is not connected yet.

    Later:
        Python
          ↓
        ESP32
          ↓
        Servo
          ↓
        Trap closes
    """

    print("🪳 CAPTURE MECHANISM ACTIVATED")

    return "CAPTURE"


# ============================================================
# TEST ESP32 CONNECTION BEFORE STARTING
# ============================================================

print()
print("Testing ESP32 connection...")

try:

    response = requests.get(
        f"{ESP32}/cmd",
        params={"d": "X"},
        timeout=1.0
    )

    if response.status_code == 200:

        print(
            f"ESP32 connected: {ESP32}"
        )

    else:

        print(
            f"⚠️ ESP32 returned HTTP {response.status_code}"
        )

except requests.RequestException as error:

    print()
    print("❌ CANNOT CONNECT TO ESP32")
    print(f"Address: {ESP32}")
    print(error)
    print()
    print(
        "Make sure Mac and ESP32 are connected "
        "to the same iPhone hotspot."
    )

    raise SystemExit


# ============================================================
# LOAD YOLO
# ============================================================

print()
print("Loading YOLO...")

model = YOLO("yolo11n.pt")

print("YOLO loaded")


# ============================================================
# OPEN CAMERA
# ============================================================

print()
print("Opening camera...")

# Change to 1 if iPhone Continuity Camera is camera 1.
# Use whichever index successfully opens your iPhone.

CAMERA_INDEX = 0

cap = cv2.VideoCapture(CAMERA_INDEX)


if not cap.isOpened():

    raise RuntimeError(
        f"Could not open camera {CAMERA_INDEX}"
    )


print(
    f"Camera {CAMERA_INDEX} opened"
)

# Give Continuity Camera / webcam time to connect
time.sleep(3)


# ============================================================
# START MOTOR THREAD
# ============================================================

motor_thread = threading.Thread(
    target=motor_sender,
    daemon=True
)

motor_thread.start()

print("Motor sender started")


# ============================================================
# STATE VARIABLES
# ============================================================

# State machine:
#
# SEARCH
#   ↓
# CHASE
#   ↓
# ATTACK
#   ↓
# CAPTURE
#   ↓
# VERIFY
#
# VERIFY success -> SEARCH
# VERIFY failure -> CHASE

state = "SEARCH"

locked_target_id = None

lost_frames = 0

verify_lost_frames = 0

attack_start_time = None

capture_start_time = None


# ============================================================
# START
# ============================================================

print()
print("==============================")
print("      ROACH HUNTER")
print("==============================")
print()
print("ESP32:", ESP32)
print("Target class:", TARGET_CLASS)
print()
print("Press Q to EMERGENCY STOP")
print()


# Start safely stopped
stop()


# ============================================================
# MAIN LOOP
# ============================================================

try:

    while True:

        # --------------------------------------------------------
        # READ CAMERA
        # --------------------------------------------------------

        ret, frame = cap.read()

        if not ret:

            print("❌ Failed to read camera frame")

            stop()

            break


        frame_height, frame_width = frame.shape[:2]

        frame_area = (
            frame_width * frame_height
        )


        left_boundary = (
            frame_width * LEFT_BOUNDARY
        )

        right_boundary = (
            frame_width * RIGHT_BOUNDARY
        )


        # Default display command
        command = "SEARCH"


        # ========================================================
        # 1. YOLO + OBJECT TRACKING
        # ========================================================

        results = model.track(
            frame,
            persist=True,
            verbose=False
        )

        result = results[0]

        targets = []


        # ========================================================
        # 2. COLLECT ALL DETECTED TARGETS
        # ========================================================

        if result.boxes is not None:

            for box in result.boxes:

                # Tracker has not assigned ID yet
                if box.id is None:
                    continue


                class_id = int(
                    box.cls[0]
                )

                class_name = (
                    model.names[class_id]
                )


                # Fake cockroach currently appears as bird
                if class_name != TARGET_CLASS:
                    continue


                track_id = int(
                    box.id[0]
                )


                x1, y1, x2, y2 = (
                    box.xyxy[0].tolist()
                )


                width = x2 - x1

                height = y2 - y1


                area = width * height


                # Relative size of target
                area_ratio = (
                    area / frame_area
                )


                targets.append({

                    "id": track_id,

                    "box": (
                        x1,
                        y1,
                        x2,
                        y2
                    ),

                    "area": area,

                    "area_ratio": area_ratio

                })


        # ========================================================
        # 3. SEARCH
        # ========================================================

        if state == "SEARCH":

            command = "SEARCH"

            # IMPORTANT:
            # Do not retain previous movement while searching.
            stop()


            if targets:

                # Largest bbox ≈ nearest target

                nearest = max(
                    targets,
                    key=lambda target:
                        target["area"]
                )


                locked_target_id = (
                    nearest["id"]
                )


                lost_frames = 0

                verify_lost_frames = 0


                state = "CHASE"


                print(
                    f"🎯 TARGET LOCKED: "
                    f"ID {locked_target_id}"
                )


        # ========================================================
        # FIND LOCKED TARGET
        # ========================================================

        locked_target = None


        if locked_target_id is not None:

            for target in targets:

                if (
                    target["id"]
                    == locked_target_id
                ):

                    locked_target = target

                    break


        # ========================================================
        # 4. CHASE
        # ========================================================

        if state == "CHASE":

            # ----------------------------------------------------
            # TARGET VISIBLE
            # ----------------------------------------------------

            if locked_target is not None:

                lost_frames = 0


                x1, y1, x2, y2 = (
                    locked_target["box"]
                )


                target_x = (
                    (x1 + x2) / 2
                )

                target_y = (
                    (y1 + y2) / 2
                )


                area_ratio = (
                    locked_target[
                        "area_ratio"
                    ]
                )


                centered = (

                    left_boundary
                    <= target_x
                    <= right_boundary

                )


                # =================================================
                # ATTACK CONDITION
                # =================================================

                if (
                    centered
                    and
                    area_ratio
                    >= ATTACK_AREA_THRESHOLD
                ):

                    state = "ATTACK"

                    attack_start_time = (
                        time.time()
                    )

                    command = (
                        move_forward()
                    )


                    print(
                        f"⚔️ ATTACK STARTED "
                        f"| ID {locked_target_id} "
                        f"| area={area_ratio:.3f}"
                    )


                # =================================================
                # NORMAL STEERING
                # =================================================

                elif (
                    target_x
                    < left_boundary
                ):

                    command = (
                        move_left()
                    )


                elif (
                    target_x
                    > right_boundary
                ):

                    command = (
                        move_right()
                    )


                else:

                    command = (
                        move_forward()
                    )


            # ----------------------------------------------------
            # TARGET LOST DURING CHASE
            # ----------------------------------------------------

            else:

                lost_frames += 1

                command = "TARGET LOST"

                # IMPORTANT SAFETY CHANGE:
                # Stop immediately while vision is uncertain.

                stop()


                if (
                    lost_frames
                    > MAX_LOST_FRAMES
                ):

                    print(
                        f"❌ TARGET "
                        f"{locked_target_id} "
                        f"LOST"
                    )


                    locked_target_id = None

                    lost_frames = 0

                    state = "SEARCH"


        # ========================================================
        # 5. ATTACK
        #
        # Once ATTACK begins:
        #
        # - commit forward
        # - ignore other cockroaches
        # - do NOT reacquire
        # ========================================================

        elif state == "ATTACK":

            command = (
                move_forward()
            )


            # ----------------------------------------------------
            # TARGET STILL VISIBLE
            # ----------------------------------------------------

            if locked_target is not None:

                area_ratio = (
                    locked_target[
                        "area_ratio"
                    ]
                )


                # =================================================
                # CAPTURE RANGE
                # =================================================

                if (
                    area_ratio
                    >= CAPTURE_AREA_THRESHOLD
                ):

                    state = "CAPTURE"

                    command = stop()


                    print(
                        f"🪳 CAPTURE RANGE "
                        f"| ID {locked_target_id} "
                        f"| area={area_ratio:.3f}"
                    )


            # ----------------------------------------------------
            # ATTACK TIMEOUT
            #
            # Target may disappear when extremely close.
            # ----------------------------------------------------

            if (
                attack_start_time
                is not None

                and

                time.time()
                - attack_start_time
                >= MAX_ATTACK_TIME
            ):

                state = "CAPTURE"

                command = stop()


                print(
                    "🪳 ATTACK COMMIT COMPLETE"
                )


        # ========================================================
        # 6. CAPTURE
        # ========================================================

        elif state == "CAPTURE":

            command = stop()


            activate_capture()


            capture_start_time = (
                time.time()
            )


            verify_lost_frames = 0


            state = "VERIFY"


        # ========================================================
        # 7. VERIFY
        # ========================================================

        elif state == "VERIFY":

            command = stop()


            if (
                capture_start_time
                is not None

                and

                time.time()
                - capture_start_time
                >= CAPTURE_WAIT_TIME
            ):


                # =================================================
                # CASE A:
                #
                # Original target still visible.
                # Capture probably failed.
                # =================================================

                if locked_target is not None:

                    print(
                        f"⚠️ TARGET "
                        f"{locked_target_id} "
                        f"STILL VISIBLE"
                    )


                    print(
                        "🔁 CAPTURE FAILED — "
                        "REATTACK"
                    )


                    state = "CHASE"

                    attack_start_time = None

                    capture_start_time = None

                    lost_frames = 0

                    verify_lost_frames = 0


                # =================================================
                # CASE B:
                #
                # Original target not visible.
                # Require several missing frames.
                # =================================================

                else:

                    verify_lost_frames += 1

                    command = "VERIFYING"


                    if (
                        verify_lost_frames
                        >= VERIFY_LOST_FRAMES
                    ):

                        print(
                            f"✅ TARGET "
                            f"{locked_target_id} "
                            f"CAPTURED"
                        )


                        print(
                            "🔎 SEARCHING FOR "
                            "NEXT TARGET"
                        )


                        locked_target_id = None

                        lost_frames = 0

                        verify_lost_frames = 0

                        attack_start_time = None

                        capture_start_time = None


                        state = "SEARCH"

                        command = "SEARCH"

                        stop()


        # ========================================================
        # 8. VISUALIZATION
        # ========================================================


        # --------------------------------------------------------
        # Steering zone boundaries
        # --------------------------------------------------------

        cv2.line(
            frame,
            (
                int(left_boundary),
                0
            ),
            (
                int(left_boundary),
                frame_height
            ),
            (255, 0, 0),
            2
        )


        cv2.line(
            frame,
            (
                int(right_boundary),
                0
            ),
            (
                int(right_boundary),
                frame_height
            ),
            (255, 0, 0),
            2
        )


        # --------------------------------------------------------
        # Draw every detected cockroach
        # --------------------------------------------------------

        for target in targets:

            x1, y1, x2, y2 = (
                target["box"]
            )

            target_id = (
                target["id"]
            )

            area_ratio = (
                target["area_ratio"]
            )


            if (
                target_id
                == locked_target_id
            ):

                color = (
                    0,
                    255,
                    0
                )

                thickness = 4

            else:

                color = (
                    150,
                    150,
                    150
                )

                thickness = 2


            cv2.rectangle(
                frame,
                (
                    int(x1),
                    int(y1)
                ),
                (
                    int(x2),
                    int(y2)
                ),
                color,
                thickness
            )


            cv2.putText(
                frame,
                f"ID {target_id} "
                f"area={area_ratio:.3f}",
                (
                    int(x1),
                    max(
                        25,
                        int(y1) - 10
                    )
                ),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                color,
                2
            )


            # Draw center of locked target

            if (
                target_id
                == locked_target_id
            ):

                target_x = (
                    (x1 + x2) / 2
                )

                target_y = (
                    (y1 + y2) / 2
                )


                cv2.circle(
                    frame,
                    (
                        int(target_x),
                        int(target_y)
                    ),
                    8,
                    (0, 0, 255),
                    -1
                )


        # ========================================================
        # STATE DISPLAY
        # ========================================================

        cv2.putText(
            frame,
            f"STATE: {state}",
            (40, 60),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.2,
            (0, 0, 255),
            3
        )


        # ========================================================
        # COMMAND DISPLAY
        # ========================================================

        cv2.putText(
            frame,
            f"CMD: {command}",
            (40, 110),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.0,
            (0, 0, 255),
            2
        )


        # ========================================================
        # LOCKED TARGET DISPLAY
        # ========================================================

        if locked_target_id is not None:

            cv2.putText(
                frame,
                f"TARGET: {locked_target_id}",
                (40, 155),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (0, 255, 0),
                2
            )


        # ========================================================
        # ACTUAL MOTOR COMMAND DISPLAY
        # ========================================================

        with motor_lock:

            actual_motor_command = (
                desired_command
            )


        cv2.putText(
            frame,
            f"MOTOR: {actual_motor_command}",
            (40, 200),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (0, 255, 255),
            2
        )


        # ========================================================
        # SHOW WINDOW
        # ========================================================

        cv2.imshow(
            "ROACH HUNTER",
            frame
        )


        # ========================================================
        # EMERGENCY STOP
        # ========================================================

        if (
            cv2.waitKey(1)
            & 0xFF
            == ord("q")
        ):

            print()
            print("🛑 EMERGENCY STOP")

            stop()

            send_command_once("X")

            break


# ============================================================
# HANDLE CTRL+C
# ============================================================

except KeyboardInterrupt:

    print()
    print("🛑 CTRL+C — EMERGENCY STOP")

    stop()

    send_command_once("X")


# ============================================================
# CLEANUP
# ============================================================

finally:

    print()
    print("Stopping motors...")


    # Tell sender thread to send STOP

    stop()


    # Send STOP immediately as extra safety

    send_command_once("X")


    # Stop background motor sender

    motor_sender_running = False


    # Give thread a moment to exit

    time.sleep(0.2)


    # Send STOP once more

    send_command_once("X")


    # Release camera

    cap.release()

    cv2.destroyAllWindows()


    print("ROACH HUNTER stopped")