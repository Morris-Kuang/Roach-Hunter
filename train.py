"""
Fine-tune YOLO11n on the combined cockroach dataset (combined_dataset/):
our own 89 webcam-specific photos (mhacks.v1i.yolov8/) merged with the
public ESP3902 dataset (899 general web photos of real cockroaches,
ESP3902.v1i.yolov11/) via symlinks -- see combined_dataset/data.yaml.
The web photos teach general roach appearance/robustness; our own photos
anchor the detector to the actual demo camera/lighting/prop.

Augmentation is still pushed above ultralytics' defaults (this is still
well under 1000 images), though less critical now than with the original
89-image set. close_mosaic disables mosaic for the final epochs so the
model sees "clean" images before convergence.
"""

from ultralytics import YOLO

DATA = "combined_dataset/data.yaml"

model = YOLO("yolo11n.pt")

model.train(
    data=DATA,
    epochs=120,
    patience=30,
    imgsz=640,
    device="mps",
    batch=16,
    project="runs",
    name="roach_combined",

    # --- augmentation (tuned up for an 89-image dataset) ---
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

# Evaluate on the held-out test split (not used during training/validation)
metrics = model.val(data=DATA, split="test")
print(metrics.box.map, metrics.box.map50)
