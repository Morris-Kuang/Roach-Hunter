"""
Standalone webcam cockroach detector. No ESP32 required -- this is just the
perception layer (see yoloTest.py for the full robot control loop).

We bypass YOLO.predict()/.track() on purpose: those deep-copy and *fuse*
the model (merge each Conv+BatchNorm into one layer) for inference speed,
which would delete the separate BatchNorm affine parameters that the TENT/
EATA-style test-time adaptation in tta.py needs to update live. So this
script preprocesses, forwards, and NMS-postprocesses by hand on the raw
(unfused) model, and runs TTA.step() on the same weights before drawing
each frame.

Controls:
  q - quit
  t - toggle test-time adaptation on/off
  r - reset adapted weights back to the trained checkpoint
  a - toggle test-time augmentation (flip/multi-scale merge) at inference
"""

import argparse
import glob
import os
import time

import cv2
import numpy as np
import torch

from ultralytics import YOLO
from ultralytics.data.augment import LetterBox
from ultralytics.utils.nms import non_max_suppression
from ultralytics.utils.ops import scale_boxes

from tta import EntropyTTA


def find_latest_weights() -> str:
    candidates = glob.glob("runs/**/weights/best.pt", recursive=True)
    if not candidates:
        raise FileNotFoundError("No trained weights found under runs/. Run train.py first.")
    return max(candidates, key=os.path.getmtime)


def preprocess(frame_bgr: np.ndarray, imgsz: int, stride: int, device: str):
    # Measured worse live with a stretch-resize matching Roboflow's export
    # preprocessing (see git history) -- letterbox (aspect-preserving + pad)
    # detects more reliably in practice, so that's what we use.
    letterbox = LetterBox(new_shape=imgsz, auto=False, stride=stride)
    padded = letterbox(image=frame_bgr)                 # HWC, BGR, padded
    img = padded[:, :, ::-1].transpose(2, 0, 1)          # BGR->RGB, HWC->CHW
    img = np.ascontiguousarray(img, dtype=np.float32) / 255.0
    tensor = torch.from_numpy(img).unsqueeze(0).to(device)
    return tensor, padded.shape[:2]


def run(weights: str, camera_index: int, conf_thres: float, iou_thres: float, use_tta: bool):
    device = "mps" if torch.backends.mps.is_available() else "cpu"

    yolo = YOLO(weights)
    net = yolo.model.to(device)
    stride = int(net.stride.max())
    names = yolo.names
    imgsz = 640

    print("Estimating Fisher importance for the anti-forgetting regularizer from labeled validation images...")
    adapter = EntropyTTA(net, data_yaml="combined_dataset/data.yaml", fisher_split="val", fisher_images=40)
    print("Fisher estimate ready.")
    tta_enabled = True
    aug_enabled = False

    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open camera {camera_index}")

    print("Press 'q' quit | 't' toggle TTA | 'r' reset adapted weights | 'a' toggle test-time augmentation")

    prev_time = time.time()
    fps = 0.0

    while True:
        ret, frame = cap.read()
        if not ret:
            print("Failed to read camera frame")
            break

        orig_shape = frame.shape[:2]
        img_tensor, resized_shape = preprocess(frame, imgsz, stride, device)

        # The adaptation forward pass below always runs (even if gated off by
        # EATA's reliability/redundancy checks) and its output is reused for
        # drawing, so the display loop never pays for two forward passes.
        # Note: y_detached reflects weights *before* this step's gradient
        # update (if any) -- same one-frame lag as the online-TTT paper.
        if tta_enabled:
            adapted, conf, y_main = adapter.step(img_tensor)
        else:
            with torch.no_grad():
                y_main, _ = net(img_tensor)
            adapted, conf = False, None

        with torch.no_grad():
            if aug_enabled:
                y_flip, _ = net(torch.flip(img_tensor, dims=[3]))
                y_flip = y_flip.clone()
                img_w = img_tensor.shape[3]
                y_flip[:, 0, :] = img_w - y_flip[:, 0, :]
                pred = torch.cat([y_main, y_flip], dim=2)
            else:
                pred = y_main

        detections = non_max_suppression(pred, conf_thres=conf_thres, iou_thres=iou_thres, nc=len(names))[0]

        if len(detections):
            detections[:, :4] = scale_boxes(resized_shape, detections[:, :4], orig_shape)

        for *box, score, cls_id in detections.tolist():
            x1, y1b, x2, y2 = map(int, box)
            label = f"{names[int(cls_id)]} {score:.2f}"
            cv2.rectangle(frame, (x1, y1b), (x2, y2), (0, 255, 0), 2)
            cv2.putText(frame, label, (x1, max(20, y1b - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

        now = time.time()
        fps = 0.9 * fps + 0.1 * (1.0 / max(now - prev_time, 1e-6))
        prev_time = now

        status = (
            f"FPS {fps:4.1f} | TTA {'ON' if tta_enabled else 'OFF'} "
            f"(steps={adapter.steps} skip_unc={adapter.skipped_uncertain} skip_red={adapter.skipped_redundant}) "
            f"| TTA-aug {'ON' if aug_enabled else 'OFF'}"
        )
        cv2.putText(frame, status, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 200, 255), 2)
        if conf is not None:
            cv2.putText(frame, f"adapt top-k conf: {conf:.3f}", (10, 50),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 200, 255), 2)

        cv2.imshow("ROACH HUNTER - webcam (no robot)", frame)

        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        elif key == ord("t"):
            tta_enabled = not tta_enabled
        elif key == ord("r"):
            adapter.reset()
        elif key == ord("a"):
            aug_enabled = not aug_enabled

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", default=None, help="path to best.pt (default: latest under runs/)")
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--iou", type=float, default=0.45)
    parser.add_argument("--no-tta", action="store_true", help="disable test-time adaptation at startup")
    args = parser.parse_args()

    weights_path = args.weights or find_latest_weights()
    print(f"Using weights: {weights_path}")
    run(weights_path, args.camera, args.conf, args.iou, use_tta=not args.no_tta)
