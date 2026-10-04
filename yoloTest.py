import cv2
import time
import threading
import requests

from pathlib import Path
from ultralytics import YOLO


# ============================================================
# ESP32
# ============================================================

ESP32 = "http://192.168.4.1"

# ESP32 motor watchdog = 500 ms.
# Refresh current motor command every 150 ms.
MOTOR_SEND_INTERVAL = 0.15

MOTOR_HTTP_TIMEOUT = 0.3

# /ready and /capture include servo movement on ESP32,
# so give them enough time to finish and respond.
SERVO_HTTP_TIMEOUT = 3


# ============================================================
# CAMERA
# ============================================================

CAMERA_INDEX = 0


# ============================================================
# YOLO
# ============================================================

MODEL_PATH = Path(__file__).resolve().parent / "best-2.pt"

TARGET_CLASS = "cockroach"

CONFIDENCE_THRESHOLD = 0.25


# ============================================================
# STEERING
# ============================================================

# Turn toward the target until its center enters
# the middle 35%-65% of the image.

LEFT_BOUNDARY = 0.35
RIGHT_BOUNDARY = 0.65


# ============================================================
# ATTACK / CAPTURE
# ============================================================

# Once centered and >= 8% of the frame:
# begin final attack.
ATTACK_AREA_THRESHOLD = 0.08

# During attack, once >= 12% of frame:
# trigger capture.
CAPTURE_AREA_THRESHOLD = 0.12

# Temporary YOLO loss tolerance.
MAX_LOST_FRAMES = 15

# If final attack runs this long,
# trigger capture anyway.
MAX_ATTACK_TIME = 2.0

# Keep driving briefly after attack starts, even if the
# low camera makes the target box look large immediately.
MIN_ATTACK_FORWARD_TIME = 0.25

# Give chassis a moment to physically stop
# before triggering SG90.
STOP_BEFORE_CAPTURE = 0.20

FINAL_PUSH_TIME = 0.10


# ============================================================
# SHARED MOTOR STATE
# ============================================================

desired_command = "X"

motor_lock = threading.Lock()

motor_thread_running = False


# ============================================================
# MOTOR COMMUNICATION
# ============================================================

def set_desired_command(command):
    global desired_command

    with motor_lock:
        desired_command = command


def get_desired_command():
    with motor_lock:
        return desired_command


def send_command_once(command):
    try:
        response = requests.get(
            f"{ESP32}/cmd",
            params={"d": command},
            timeout=MOTOR_HTTP_TIMEOUT
        )

        return response.status_code == 200

    except requests.RequestException as error:
        print(
            f"⚠️ ESP32 connection error: {error}"
        )

        return False


def motor_sender():
    global motor_thread_running

    while motor_thread_running:
        command = get_desired_command()

        send_command_once(command)

        time.sleep(
            MOTOR_SEND_INTERVAL
        )


# ============================================================
# MOTOR ACTIONS
# ============================================================

def stop():
    set_desired_command("X")
    return "X"


def forward():
    # Send the first forward command without waiting for
    # the background motor refresh.
    changed = get_desired_command() != "F"
    set_desired_command("F")

    if changed:
        send_command_once("F")

    return "F"


def backward():
    set_desired_command("B")
    return "B"


def left():
    set_desired_command("L")
    return "L"


def right():
    set_desired_command("R")
    return "R"


def stop_now():
    """
    Stop immediately instead of waiting for the
    motor sender thread.
    """

    stop()

    send_command_once("X")


# ============================================================
# SERVO READY
#
# Called exactly once at the beginning.
#
# ESP32 /ready should:
#
#   rotate opposite direction
#   -> 200 ms
#   -> neutral STOP
#
# ============================================================

# def initialize_capture_mechanism():
#
#     print()
#     print("🔼 INITIALIZING CAPTURE MECHANISM")
#
#     try:
#
#         response = requests.get(
#             f"{ESP32}/ready",
#             timeout=SERVO_HTTP_TIMEOUT
#         )
#
#         if response.status_code == 200:
#
#             print(
#                 "✅ Capture mechanism READY"
#             )
#
#             return True
#
#         print(
#             f"❌ Ready returned HTTP "
#             f"{response.status_code}"
#         )
#
#         return False
#
#     except requests.RequestException as error:
#
#         print(
#             f"❌ Ready command failed: {error}"
#         )
#
#         return False


# ============================================================
# CAPTURE
#
# Python only calls /capture.
#
# ESP32 should:
#
#   capture direction
#   -> 200 ms
#   -> neutral STOP
#
# ============================================================

def activate_capture():

    print()
    print(
        "🪳 CAPTURE MECHANISM ACTIVATED"
    )

    try:

        response = requests.get(
            f"{ESP32}/capture",
            timeout=SERVO_HTTP_TIMEOUT
        )

        if response.status_code == 200:

            print(
                "✅ ESP32 capture complete"
            )

            return True

        print(
            f"❌ Capture returned HTTP "
            f"{response.status_code}"
        )

        return False

    except requests.RequestException as error:

        print(
            f"❌ Capture command failed: {error}"
        )

        return False


# ============================================================
# TEST WEBCAM
# ============================================================

def test_webcam():

    print("Testing webcam...")

    cap = cv2.VideoCapture(
        CAMERA_INDEX
    )

    if not cap.isOpened():

        print(
            "❌ Cannot open webcam"
        )

        return None

    # Allow webcam to initialize.
    time.sleep(0.5)

    success, frame = cap.read()

    if not success or frame is None:

        print(
            "❌ Failed to read webcam frame"
        )

        cap.release()

        return None

    height, width = frame.shape[:2]

    print(
        f"✅ Webcam connected "
        f"({width}x{height})"
    )

    return cap


# ============================================================
# TEST ESP32
# ============================================================

def test_esp32():

    print(
        "Testing ESP32 connection..."
    )

    print(
        "Make sure Mac is connected "
        "to ROACH-HUNTER Wi-Fi."
    )

    try:

        response = requests.get(
            ESP32,
            timeout=1.0
        )

        if response.status_code == 200:

            print(
                f"✅ ESP32 connected: "
                f"{ESP32}"
            )

            return True

        print(
            f"❌ ESP32 returned HTTP "
            f"{response.status_code}"
        )

        return False

    except requests.RequestException as error:

        print(
            "❌ CANNOT CONNECT TO ESP32"
        )

        print(
            f"Address: {ESP32}"
        )

        print(error)

        return False


# ============================================================
# LOAD YOLO
# ============================================================

def load_model():

    print("Loading YOLO...")

    if not MODEL_PATH.exists():

        print(
            f"❌ Model not found: "
            f"{MODEL_PATH}"
        )

        return None

    model = YOLO(
        str(MODEL_PATH)
    )

    print(
        "✅ YOLO loaded"
    )

    return model


# ============================================================
# TARGET EXTRACTION
# ============================================================

def get_targets(
    result,
    frame_width,
    frame_height
):

    targets = []

    frame_area = (
        frame_width *
        frame_height
    )

    if result.boxes is None:
        return targets

    for box in result.boxes:

        confidence = float(
            box.conf[0]
        )

        if (
            confidence
            < CONFIDENCE_THRESHOLD
        ):
            continue

        class_id = int(
            box.cls[0]
        )

        class_name = (
            result.names[class_id]
        )

        if (
            class_name.lower()
            != TARGET_CLASS.lower()
        ):
            continue

        x1, y1, x2, y2 = (
            box.xyxy[0].tolist()
        )

        box_width = max(
            0,
            x2 - x1
        )

        box_height = max(
            0,
            y2 - y1
        )

        box_area = (
            box_width *
            box_height
        )

        area_ratio = (
            box_area /
            frame_area
        )

        center_x = (
            x1 + x2
        ) / 2

        center_y = (
            y1 + y2
        ) / 2

        targets.append(
            {
                "confidence": confidence,

                "bbox": (
                    x1,
                    y1,
                    x2,
                    y2
                ),

                "center_x": center_x,

                "center_y": center_y,

                "area_ratio": area_ratio,
            }
        )

    return targets


# ============================================================
# CHOOSE TARGET
# ============================================================

def choose_target(targets):

    if not targets:
        return None

    # Choose largest bounding box.
    # Usually the nearest cockroach.

    return max(
        targets,
        key=lambda target:
        target["area_ratio"]
    )


# ============================================================
# VISUALIZATION
# ============================================================

def draw_target(
    frame,
    target,
    state
):

    height, width = frame.shape[:2]

    # --------------------------------------------------------
    # STEERING BOUNDARIES
    # --------------------------------------------------------

    left_x = int(
        width *
        LEFT_BOUNDARY
    )

    right_x = int(
        width *
        RIGHT_BOUNDARY
    )

    cv2.line(
        frame,
        (left_x, 0),
        (left_x, height),
        (255, 255, 255),
        2
    )

    cv2.line(
        frame,
        (right_x, 0),
        (right_x, height),
        (255, 255, 255),
        2
    )

    # --------------------------------------------------------
    # TARGET BOX
    # --------------------------------------------------------

    if target is not None:

        x1, y1, x2, y2 = (
            target["bbox"]
        )

        x1 = int(x1)
        y1 = int(y1)
        x2 = int(x2)
        y2 = int(y2)

        center_x = int(
            target["center_x"]
        )

        center_y = int(
            target["center_y"]
        )

        cv2.rectangle(
            frame,
            (x1, y1),
            (x2, y2),
            (255, 255, 255),
            2
        )

        cv2.circle(
            frame,
            (
                center_x,
                center_y
            ),
            6,
            (255, 255, 255),
            -1
        )

        text = (
            f"{TARGET_CLASS} "
            f"{target['confidence']:.2f} "
            f"area="
            f"{target['area_ratio']:.3f}"
        )

        cv2.putText(
            frame,
            text,
            (
                x1,
                max(
                    25,
                    y1 - 10
                )
            ),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (255, 255, 255),
            2
        )

    # --------------------------------------------------------
    # STATE
    # --------------------------------------------------------

    cv2.putText(
        frame,
        f"STATE: {state}",
        (20, 40),
        cv2.FONT_HERSHEY_SIMPLEX,
        1,
        (255, 255, 255),
        2
    )

    cv2.putText(
        frame,
        f"CMD: {get_desired_command()}",
        (20, 80),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (255, 255, 255),
        2
    )

    cv2.putText(
        frame,
        "Q = EMERGENCY STOP",
        (
            20,
            height - 20
        ),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (255, 255, 255),
        2
    )


# ============================================================
# MAIN
# ============================================================

def main():

    global motor_thread_running

    thread = None

    # This guarantees /capture is triggered
    # at most once per Python run.
    capture_triggered = False

    # --------------------------------------------------------
    # CAMERA
    # --------------------------------------------------------

    cap = test_webcam()

    if cap is None:
        return

    # --------------------------------------------------------
    # ESP32
    # --------------------------------------------------------

    if not test_esp32():
        cap.release()
        return

    # Everything after ESP32 connection is wrapped
    # in try/finally so the final capture rule applies
    # even if something goes wrong.

    try:

        # ====================================================
        # STARTUP SERVO READY
        # ====================================================

        # print()
        # print("Initializing capture mechanism...")

        # if not initialize_capture_mechanism():
        #
        #     print(
        #         "❌ Cannot initialize "
        #         "capture mechanism"
        #     )
        #
        #     return

        # ====================================================
        # YOLO
        # ====================================================

        model = load_model()

        if model is None:
            return

        # ====================================================
        # MOTOR THREAD
        # ====================================================

        motor_thread_running = True

        thread = threading.Thread(
            target=motor_sender,
            daemon=True
        )

        thread.start()

        print(
            "Motor sender started"
        )

        # ====================================================
        # STATE
        # ====================================================

        state = "SEARCH"

        lost_frames = 0

        attack_start_time = None
        attack_lost_since = None
        capture_range_seen = False
        capture_area_ratio = None

        stop()

        print()
        print(
            "=============================="
        )
        print(
            "ROACH HUNTER"
        )
        print(
            "=============================="
        )

        print(
            f"ESP32: {ESP32}"
        )

        print(
            f"Target class: "
            f"{TARGET_CLASS}"
        )

        print()

        print(
            "Startup servo: /ready"
        )

        print(
            "Final servo: /capture"
        )

        print()

        print(
            "Press Q to EMERGENCY STOP"
        )

        print()

        # ====================================================
        # MAIN LOOP
        # ====================================================

        while True:

            # ==================================================
            # READ CAMERA
            # ==================================================

            success, frame = cap.read()

            if (
                not success
                or
                frame is None
            ):

                print(
                    "❌ Failed to read "
                    "webcam frame"
                )

                break

            height, width = (
                frame.shape[:2]
            )

            # ==================================================
            # YOLO
            # ==================================================

            results = model(
                frame,
                verbose=False
            )

            result = results[0]

            targets = get_targets(
                result,
                width,
                height
            )

            target = choose_target(
                targets
            )

            # ==================================================
            # SEARCH
            # ==================================================

            if state == "SEARCH":

                stop()

                if target is not None:

                    print()

                    print(
                        "🎯 TARGET LOCKED"
                    )

                    print(
                        f"confidence="
                        f"{target['confidence']:.2f}"
                    )

                    print(
                        f"area="
                        f"{target['area_ratio']:.3f}"
                    )

                    state = "CHASE"

                    lost_frames = 0

            # ==================================================
            # CHASE
            # ==================================================

            elif state == "CHASE":

                # ----------------------------------------------
                # TARGET TEMPORARILY LOST
                # ----------------------------------------------

                if target is None:

                    lost_frames += 1

                    # IMPORTANT:
                    # For short YOLO detection loss,
                    # keep the previous motor command.
                    #
                    # Example:
                    # previously F -> keep F
                    # previously L -> keep L
                    # previously R -> keep R

                    if (
                        lost_frames
                        > MAX_LOST_FRAMES
                    ):

                        print()

                        print(
                            "❌ TARGET LOST"
                        )

                        stop()

                        state = "SEARCH"

                        lost_frames = 0

                # ----------------------------------------------
                # TARGET VISIBLE
                # ----------------------------------------------

                else:

                    lost_frames = 0

                    center_ratio = (
                        target["center_x"]
                        /
                        width
                    )

                    area_ratio = (
                        target["area_ratio"]
                    )

                    # ------------------------------------------
                    # TARGET LEFT
                    # ------------------------------------------

                    if (
                        center_ratio
                        < LEFT_BOUNDARY
                    ):

                        left()

                    # ------------------------------------------
                    # TARGET RIGHT
                    # ------------------------------------------

                    elif (
                        center_ratio
                        > RIGHT_BOUNDARY
                    ):

                        right()

                    # ------------------------------------------
                    # TARGET CENTERED
                    # ------------------------------------------

                    else:

                        # Close enough to start final attack.

                        if (
                            area_ratio
                            >= ATTACK_AREA_THRESHOLD
                        ):

                            print()

                            print(
                                "⚔️ ATTACK STARTED"
                            )

                            print(
                                f"area="
                                f"{area_ratio:.3f}"
                            )

                            state = "ATTACK"

                            # The first attack frame may already
                            # exceed the capture area with a low camera.
                            capture_range_seen = (
                                area_ratio >= CAPTURE_AREA_THRESHOLD
                            )
                            capture_area_ratio = (
                                area_ratio if capture_range_seen else None
                            )
                            attack_lost_since = None

                            forward()
                            attack_start_time = time.monotonic()

                        else:

                            forward()

            # ==================================================
            # ATTACK
            # ==================================================

            elif state == "ATTACK":

                # Commit forward while approaching the target.
                forward()

                now = time.monotonic()

                if target is None:
                    if attack_lost_since is None:
                        attack_lost_since = now
                else:
                    attack_lost_since = None
                    area_ratio = target["area_ratio"]

                    if area_ratio >= CAPTURE_AREA_THRESHOLD:
                        capture_range_seen = True
                        capture_area_ratio = area_ratio

                attack_elapsed = (
                    now - attack_start_time
                )

                # A large box can cross the area threshold early.
                # Finish a short forward approach before capture.
                if (
                    capture_range_seen
                    and attack_elapsed >= MIN_ATTACK_FORWARD_TIME
                ):

                    print()
                    print("📍 CAPTURE RANGE REACHED")
                    print(f"area={capture_area_ratio:.3f}")

                    # Send F now so the final push cannot finish
                    # before the background sender refreshes it.
                    send_command_once("F")
                    time.sleep(FINAL_PUSH_TIME)
                    stop_now()

                    state = "CAPTURE"

                elif (
                    attack_lost_since is not None
                    and now - attack_lost_since >= MIN_ATTACK_FORWARD_TIME
                ):

                    print()
                    print("❌ TARGET LOST DURING ATTACK")
                    stop_now()
                    state = "SEARCH"
                    lost_frames = 0

                elif attack_elapsed >= MAX_ATTACK_TIME:

                    print()
                    print("⏱️ ATTACK TIMEOUT")
                    print("Triggering capture.")

                    state = "CAPTURE"
                    stop_now()

            # ==================================================
            # CAPTURE
            # ==================================================

            elif state == "CAPTURE":

                # ----------------------------------------------
                # STOP ROBOT
                # ----------------------------------------------

                # First tell the shared motor state to STOP.
                stop()

                # Stop background motor sender.
                #
                # This prevents /cmd?d=X requests from being
                # sent while ESP32 is busy handling /capture.
                motor_thread_running = False

                # Wait for motor sender thread to finish.
                if (
                    thread is not None
                    and
                    thread.is_alive()
                ):

                    thread.join(
                        timeout=1.0
                    )

                # Send one final STOP command after the
                # background sender has finished.
                send_command_once("X")

                print()

                print(
                    "🛑 ROBOT STOPPED"
                )

                # Let chassis physically settle.
                time.sleep(
                    STOP_BEFORE_CAPTURE
                )

                # ----------------------------------------------
                # IMPORTANT:
                #
                # Mark BEFORE HTTP request.
                #
                # Even if response times out after ESP32
                # already moved the servo, finally will NOT
                # trigger it again.
                # ----------------------------------------------

                capture_triggered = True

                success = activate_capture()

                if success:

                    print()

                    print(
                        "🪳 CAPTURE COMPLETE"
                    )

                    print(
                        "🏁 ROACH HUNTER FINISHED"
                    )

                else:

                    print()

                    print(
                        "❌ CAPTURE REQUEST FAILED"
                    )

                    print(
                        "Not retrying servo "
                        "to avoid double movement."
                    )

                # Capture occurs once.
                # Program ends.
                break

            # ==================================================
            # DISPLAY
            # ==================================================

            draw_target(
                frame,
                target,
                state
            )

            cv2.imshow(
                "ROACH HUNTER",
                frame
            )

            # ==================================================
            # EMERGENCY STOP
            # ==================================================

            key = (
                cv2.waitKey(1)
                &
                0xFF
            )

            if key == ord("q"):

                print()

                print(
                    "🛑 EMERGENCY STOP"
                )

                stop_now()

                break

    except KeyboardInterrupt:

        print()

        print(
            "🛑 CTRL+C"
        )

    finally:

        # ======================================================
        # ALWAYS STOP WHEELS FIRST
        # ======================================================

        print()

        print(
            "Stopping motors..."
        )

        stop_now()

        motor_thread_running = False

        if (
            thread is not None
            and
            thread.is_alive()
        ):

            thread.join(
                timeout=1.0
            )

        # ======================================================
        # GUARANTEE FINAL SERVO MOVEMENT EXACTLY ONCE
        #
        # Case 1:
        # Normal YOLO capture already happened
        # -> capture_triggered == True
        # -> DO NOTHING
        #
        # Case 2:
        # Q / Ctrl+C / camera failure / other exit
        # -> capture_triggered == False
        # -> call /capture ONCE
        # ======================================================

        if not capture_triggered:

            print()

            print(
                "⚠️ Program ending without "
                "previous capture."
            )

            print(
                "Triggering final servo "
                "movement once."
            )

            # Set BEFORE HTTP request.
            # Never retry this movement.
            capture_triggered = True

            activate_capture()

        else:

            print()

            print(
                "✅ Capture servo already triggered."
            )

            print(
                "Skipping final servo movement "
                "to prevent double capture."
            )

        # ======================================================
        # CAMERA CLEANUP
        # ======================================================

        cap.release()

        cv2.destroyAllWindows()

        print()

        print(
            "ROACH HUNTER stopped"
        )


# ============================================================
# RUN
# ============================================================

if __name__ == "__main__":
    main()