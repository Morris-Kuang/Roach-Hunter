"""
Fine-tune YOLO11n on the combined cockroach dataset (combined_dataset/):
our own 171 webcam-specific photos (mhacks.v2i.yolov11/) merged with the
public ESP3902 dataset (899 general web photos of real cockroaches,
ESP3902.v1i.yolov11/) via symlinks -- see build_combined_dataset.sh.
The web photos teach general roach appearance/robustness; our own photos
anchor the detector to the actual demo camera/lighting/prop, so each of
our train images is repeated (OURS_REPEAT, default 2x) to give ESP3902
samples a smaller per-image weight.

Augmentation is still pushed above ultralytics' defaults (this is still
only ~1000 images). close_mosaic disables mosaic for the final epochs so
the model sees "clean" images before convergence.
"""

import torch
from ultralytics import YOLO

DATA = "combined_dataset/data.yaml"

# CUDA on the GPU box, MPS on the Mac, CPU as a last resort
DEVICE = 0 if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"

model = YOLO("yolo11n.pt")

model.train(
    data=DATA,
    epochs=120,
    patience=30,
    imgsz=640,
    device=DEVICE,
    batch=16,
    project="runs",
    name="roach_v2_weighted",

    # --- augmentation (tuned up for a small, ~1000-image dataset) ---
    hsv_h=0.02,
    hsv_s=0.8,
    hsv_v=0.5,
    degrees=20.0,       # roach orientation is arbitrary on a floor/wall
    translate=0.2,
    scale=0.9,          # strong zoom jitter: near vs far target
    shear=5.0,
    perspective=0.0005,
    flipud=0.5,         # top-down camera -> no inherent "up"
    fliplr=0.5,
    mosaic=1.0,
    mixup=0.15,
    close_mosaic=20,
)

# Evaluate on the held-out test split (not used during training/validation),
# overall and per source -- "ours" is what matters for the demo camera
for name, data in [("all", DATA),
                   ("ours", "combined_dataset/test_ours.yaml"),
                   ("esp", "combined_dataset/test_esp.yaml")]:
    metrics = model.val(data=data, split="test", device=DEVICE)
    print(f"test[{name}] mAP50-95={metrics.box.map:.3f} mAP50={metrics.box.map50:.3f}")
