"""Step 4: fine-tune a detector on your labeled frames.

    python -m scripts.train --epochs 50 --imgsz 640
    python -m scripts.train --epochs 3 --imgsz 480 --smoke   # quick machinery test

Trains a small YOLOv8 (`yolov8n` by default) on training/dataset and, on success,
installs the best weights at models/custom.pt + writes models/active.txt. The app
and run_on_video then use those weights automatically (detector.mode == "custom").

Runs on CPU if no GPU; that's slow for many epochs — start with a GPU machine, or
keep the dataset small. `--smoke` just proves the loop works end-to-end.
"""
from __future__ import annotations
import argparse, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
DS = ROOT / "training/dataset"
MODELS = ROOT / "models"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--model", default="yolov8n.pt")
    ap.add_argument("--device", default=None, help="e.g. 0 for GPU, cpu for CPU")
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--smoke", action="store_true", help="tiny run to test the pipeline")
    a = ap.parse_args()

    data_yaml = DS / "data.yaml"
    if not data_yaml.exists():
        print("Missing data.yaml — run scripts.prelabel first."); return
    if not any((DS / "labels/train").glob("*.txt")):
        print("No training labels — run scripts.extract_frames, prelabel, label first."); return

    from ultralytics import YOLO
    epochs = 3 if a.smoke else a.epochs
    imgsz = 480 if a.smoke else a.imgsz
    model = YOLO(a.model)
    results = model.train(
        data=str(data_yaml), epochs=epochs, imgsz=imgsz, batch=a.batch,
        device=a.device, project=str(ROOT / "training/runs"),
        name="finetune", exist_ok=True, verbose=True,
    )
    best = Path(results.save_dir) / "weights" / "best.pt"
    if not best.exists():
        print("Training finished but best.pt not found at", best); return
    MODELS.mkdir(exist_ok=True)
    shutil.copy(best, MODELS / "custom.pt")
    (MODELS / "active.txt").write_text("custom.pt\n")
    print(f"\nInstalled fine-tuned weights -> {MODELS/'custom.pt'}")
    print("The app / run_on_video will now use them (detector.mode == 'custom').")


if __name__ == "__main__":
    main()
