import cv2
import time
import threading
import requests
from pathlib import Path
from ultralytics import YOLO

# ESP32 access-point address; commands use F/B/L/R/X.
ESP32 = 'http://192.168.4.1'

# Refresh motor commands every 150 ms (firmware watchdog: 1200 ms).
MOTOR_SEND_INTERVAL = 0.15
MOTOR_HTTP_TIMEOUT = 0.3

# Allow the firmware capture movement (2000 ms) to finish.
SERVO_HTTP_TIMEOUT = 3
CAMERA_INDEX = 0

# Resolve the model relative to this file, regardless of the working directory.
MODEL_PATH = Path(__file__).resolve().parent / 'best.pt'
TARGET_CLASS = 'cockroach'
CONFIDENCE_THRESHOLD = 0.25

# Target center below 55%: left; above 85%: right; otherwise centered.
LEFT_BOUNDARY = 0.55
RIGHT_BOUNDARY = 0.85

# Enter attack at 3% frame area; capture at 3.5%.
ATTACK_AREA_THRESHOLD = 0.03
CAPTURE_AREA_THRESHOLD = 0.035

# Keep the previous motor command through up to 15 missing detections.
MAX_LOST_FRAMES = 15

# Attack also triggers capture after two seconds.
MAX_ATTACK_TIME = 2.0
STOP_BEFORE_CAPTURE = 0.2
FINAL_PUSH_TIME = 0.1

# Shared command is guarded by motor_lock and refreshed by the sender thread.
desired_command = 'X'
motor_lock = threading.Lock()
motor_thread_running = False


def set_desired_command(command):
    global desired_command
    with motor_lock:
        desired_command = command


def get_desired_command():
    with motor_lock:
        return desired_command


def send_command_once(command):
    try:
        response = requests.get(f'{ESP32}/cmd', params={'d': command}, timeout=MOTOR_HTTP_TIMEOUT)
        return response.status_code == 200
    except requests.RequestException as error:
        print(f'⚠️ ESP32 connection error: {error}')
        return False


def motor_sender():
    global motor_thread_running
    while motor_thread_running:
        command = get_desired_command()
        send_command_once(command)
        time.sleep(MOTOR_SEND_INTERVAL)


def stop():
    set_desired_command('X')
    return 'X'


def forward():
    changed = get_desired_command() != 'F'
    set_desired_command('F')
    if changed:
        send_command_once('F')
    return 'F'


def backward():
    set_desired_command('B')
    return 'B'


def left():
    set_desired_command('L')
    return 'L'


def right():
    set_desired_command('R')
    return 'R'


def stop_now():
    """
    Stop immediately instead of waiting for the
    motor sender thread.
    """
    stop()
    send_command_once('X')


# Request capture once; a timeout does not prove the servo failed to move.

def activate_capture():
    print()
    print('🪳 CAPTURE MECHANISM ACTIVATED')
    try:
        response = requests.get(f'{ESP32}/capture', timeout=SERVO_HTTP_TIMEOUT)
        if response.status_code == 200:
            print('✅ ESP32 capture complete')
            return True
        print(f'❌ Capture returned HTTP {response.status_code}')
        return False
    except requests.RequestException as error:
        print(f'❌ Capture command failed: {error}')
        return False


def test_webcam():
    print('Testing webcam...')
    cap = cv2.VideoCapture(CAMERA_INDEX)
    if not cap.isOpened():
        print('❌ Cannot open webcam')
        return None
    time.sleep(0.5)
    (success, frame) = cap.read()
    if not success or frame is None:
        print('❌ Failed to read webcam frame')
        cap.release()
        return None
    (height, width) = frame.shape[:2]
    print(f'✅ Webcam connected ({width}x{height})')
    return cap


def test_esp32():
    print('Testing ESP32 connection...')
    print('Make sure Mac is connected to ROACH-HUNTER Wi-Fi.')
    try:
        response = requests.get(ESP32, timeout=1.0)
        if response.status_code == 200:
            print(f'✅ ESP32 connected: {ESP32}')
            return True
        print(f'❌ ESP32 returned HTTP {response.status_code}')
        return False
    except requests.RequestException as error:
        print('❌ CANNOT CONNECT TO ESP32')
        print(f'Address: {ESP32}')
        print(error)
        return False


def load_model():
    print('Loading YOLO...')
    if not MODEL_PATH.exists():
        print(f'❌ Model not found: {MODEL_PATH}')
        return None
    model = YOLO(str(MODEL_PATH))
    print('✅ YOLO loaded')
    return model


def get_targets(result, frame_width, frame_height):
    targets = []
    frame_area = frame_width * frame_height
    if result.boxes is None:
        return targets
    for box in result.boxes:
        confidence = float(box.conf[0])
        if confidence < CONFIDENCE_THRESHOLD:
            continue
        class_id = int(box.cls[0])
        class_name = result.names[class_id]
        if class_name.lower() != TARGET_CLASS.lower():
            continue
        (x1, y1, x2, y2) = box.xyxy[0].tolist()
        box_width = max(0, x2 - x1)
        box_height = max(0, y2 - y1)
        box_area = box_width * box_height
        area_ratio = box_area / frame_area
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        targets.append({'confidence': confidence, 'bbox': (x1, y1, x2, y2), 'center_x': center_x, 'center_y': center_y, 'area_ratio': area_ratio})
    return targets


# Select the largest detection each frame; this is not persistent identity tracking.

def choose_target(targets):
    if not targets:
        return None
    return max(targets, key=lambda target: target['area_ratio'])


def draw_target(frame, target, state):
    (height, width) = frame.shape[:2]
    left_x = int(width * LEFT_BOUNDARY)
    right_x = int(width * RIGHT_BOUNDARY)
    cv2.line(frame, (left_x, 0), (left_x, height), (255, 255, 255), 2)
    cv2.line(frame, (right_x, 0), (right_x, height), (255, 255, 255), 2)
    if target is not None:
        (x1, y1, x2, y2) = target['bbox']
        x1 = int(x1)
        y1 = int(y1)
        x2 = int(x2)
        y2 = int(y2)
        center_x = int(target['center_x'])
        center_y = int(target['center_y'])
        cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 255, 255), 2)
        cv2.circle(frame, (center_x, center_y), 6, (255, 255, 255), -1)
        text = f"{TARGET_CLASS} {target['confidence']:.2f} area={target['area_ratio']:.3f}"
        cv2.putText(frame, text, (x1, max(25, y1 - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    cv2.putText(frame, f'STATE: {state}', (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    cv2.putText(frame, 'Q = EMERGENCY STOP', (20, height - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)


# SEARCH -> CHASE -> ATTACK -> CAPTURE, then exit.

# After ESP32 connects, finally stops the wheels and requests capture if not yet attempted.

# This existing behavior also applies to Q, Ctrl+C, camera failure, and model-load failure.

def main():
    global motor_thread_running
    thread = None
    capture_triggered = False
    cap = test_webcam()
    if cap is None:
        return
    if not test_esp32():
        cap.release()
        return
    try:
        model = load_model()
        if model is None:
            return
        motor_thread_running = True
        thread = threading.Thread(target=motor_sender, daemon=True)
        thread.start()
        print('Motor sender started')
        state = 'SEARCH'
        lost_frames = 0
        attack_start_time = None
        stop()
        print()
        print('==============================')
        print('ROACH HUNTER')
        print('==============================')
        print(f'ESP32: {ESP32}')
        print(f'Target class: {TARGET_CLASS}')
        print()
        print('Final servo: /capture')
        print()
        print('Press Q to EMERGENCY STOP')
        print()
        while True:
            (success, frame) = cap.read()
            if not success or frame is None:
                print('❌ Failed to read webcam frame')
                break
            (height, width) = frame.shape[:2]
            results = model(frame, verbose=False)
            result = results[0]
            targets = get_targets(result, width, height)
            target = choose_target(targets)
            # SEARCH waits in place until a detection appears.
            if state == 'SEARCH':
                stop()
                if target is not None:
                    print()
                    print('🎯 TARGET LOCKED')
                    print(f"confidence={target['confidence']:.2f}")
                    print(f"area={target['area_ratio']:.3f}")
                    state = 'CHASE'
                    lost_frames = 0
            # CHASE steers using the current frame's largest detection.
            elif state == 'CHASE':
                if target is None:
                    lost_frames += 1
                    if lost_frames > MAX_LOST_FRAMES:
                        print()
                        print('❌ TARGET LOST')
                        stop()
                        state = 'SEARCH'
                        lost_frames = 0
                else:
                    lost_frames = 0
                    center_ratio = target['center_x'] / width
                    area_ratio = target['area_ratio']
                    if center_ratio < LEFT_BOUNDARY:
                        left()
                    elif center_ratio > RIGHT_BOUNDARY:
                        right()
                    elif area_ratio >= ATTACK_AREA_THRESHOLD:
                        print()
                        print('⚔️ ATTACK STARTED')
                        print(f'area={area_ratio:.3f}')
                        state = 'ATTACK'
                        attack_start_time = time.time()
                        forward()
                    else:
                        forward()
            # ATTACK keeps moving forward until area or time reaches its limit.
            elif state == 'ATTACK':
                forward()
                if target is not None:
                    area_ratio = target['area_ratio']
                    if area_ratio >= CAPTURE_AREA_THRESHOLD:
                        print()
                        print('📍 CAPTURE RANGE REACHED')
                        print(f'area={area_ratio:.3f}')
                        forward()
                        send_command_once('F')
                        time.sleep(FINAL_PUSH_TIME)
                        stop_now()
                        state = 'CAPTURE'
                if state == 'ATTACK' and attack_start_time is not None and (time.time() - attack_start_time >= MAX_ATTACK_TIME):
                    print()
                    print('⏱️ ATTACK TIMEOUT')
                    print('Triggering capture.')
                    state = 'CAPTURE'
                    stop()
            # Stop the sender before capture so no motor requests overlap the servo cycle.
            elif state == 'CAPTURE':
                stop()
                motor_thread_running = False
                if thread is not None and thread.is_alive():
                    thread.join(timeout=1.0)
                send_command_once('X')
                print()
                print('🛑 ROBOT STOPPED')
                time.sleep(STOP_BEFORE_CAPTURE)
                # Mark before HTTP so cleanup never repeats the capture request.
                capture_triggered = True
                success = activate_capture()
                if success:
                    print()
                    print('🪳 CAPTURE COMPLETE')
                    print('🏁 ROACH HUNTER FINISHED')
                else:
                    print()
                    print('❌ CAPTURE REQUEST FAILED')
                    print('Not retrying servo to avoid double movement.')
                break
            draw_target(frame, target, state)
            cv2.imshow('ROACH HUNTER', frame)
            key = cv2.waitKey(1) & 255
            if key == ord('q'):
                print()
                print('🛑 EMERGENCY STOP')
                stop_now()
                break
    except KeyboardInterrupt:
        print()
        print('🛑 CTRL+C')
    finally:
        # Preserve the existing exit capture rule, including emergency exits.
        print()
        print('Stopping motors...')
        stop_now()
        motor_thread_running = False
        if thread is not None and thread.is_alive():
            thread.join(timeout=1.0)
        if not capture_triggered:
            print()
            print('⚠️ Program ending without previous capture.')
            print('Triggering final servo movement once.')
            capture_triggered = True
            activate_capture()
        else:
            print()
            print('✅ Capture servo already triggered.')
            print('Skipping final servo movement to prevent double capture.')
        cap.release()
        cv2.destroyAllWindows()
        print()
        print('ROACH HUNTER stopped')

if __name__ == '__main__':
    main()
