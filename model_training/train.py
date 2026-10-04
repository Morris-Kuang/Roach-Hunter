from pathlib import Path

from ultralytics import YOLO


# Load pretrained YOLOv11 Nano
model = YOLO("yolo11n.pt")

# Fine-tune
model.train(
    data=str(Path(__file__).resolve().parent / "data" / "data.yaml"),
    epochs=50,
    imgsz=640,
    batch=16,
)
