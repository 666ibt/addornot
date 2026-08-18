"""Step 3: correct the pre-labels (run this on a machine WITH a display).

    python -m scripts.label                 # label everything
    python -m scripts.label --split train    # just the train split

Controls
--------
  draw box .......... left-drag
  set current class .. keys 0..9   (0=phone 1=cup 2=food 3=person)
  reclassify box ..... click inside it, then press its digit
  delete box ......... click inside it, then 'd'  (or 'u' = undo last drawn)
  next / prev image .. 'n' / 'p'   (saves automatically)
  save now ........... 's'
  quit ............... 'q'         (saves current image first)

Labels are written back to training/dataset/labels/<split>/<img>.txt in YOLO
format. Focus on PHONES — add a tight box every time a worker holds one; that's
the signal COCO misses and the reason we're fine-tuning.
"""
from __future__ import annotations
import argparse, sys
from pathlib import Path
import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from training.classes import CLASSES  # noqa: E402

DS = ROOT / "training/dataset"
COLORS = [(60, 60, 235), (80, 200, 80), (0, 165, 255), (220, 160, 60),
          (200, 80, 200), (0, 220, 220)]


def load_labels(txt: Path, w: int, h: int):
    boxes = []
    if txt.exists():
        for line in txt.read_text().splitlines():
            p = line.split()
            if len(p) != 5:
                continue
            c, cx, cy, bw, bh = int(p[0]), *map(float, p[1:])
            x1 = int((cx - bw / 2) * w); y1 = int((cy - bh / 2) * h)
            x2 = int((cx + bw / 2) * w); y2 = int((cy + bh / 2) * h)
            boxes.append([c, x1, y1, x2, y2])
    return boxes


def save_labels(txt: Path, boxes, w: int, h: int):
    lines = []
    for c, x1, y1, x2, y2 in boxes:
        cx = ((x1 + x2) / 2) / w; cy = ((y1 + y2) / 2) / h
        bw = abs(x2 - x1) / w; bh = abs(y2 - y1) / h
        lines.append(f"{c} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
    txt.parent.mkdir(parents=True, exist_ok=True)
    txt.write_text("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", choices=["train", "val", "all"], default="all")
    args = ap.parse_args()
    splits = ["train", "val"] if args.split == "all" else [args.split]
    images = []
    for s in splits:
        images += [(s, p) for p in sorted((DS / "images" / s).glob("*.jpg"))]
    if not images:
        print("No images. Run scripts.extract_frames first."); return

    state = {"cls": 0, "drag": None, "boxes": [], "sel": -1}

    def on_mouse(ev, x, y, flags, param):
        if ev == cv2.EVENT_LBUTTONDOWN:
            state["drag"] = (x, y)
            state["sel"] = -1
            for i, (c, x1, y1, x2, y2) in enumerate(state["boxes"]):
                if min(x1, x2) <= x <= max(x1, x2) and min(y1, y2) <= y <= max(y1, y2):
                    state["sel"] = i
        elif ev == cv2.EVENT_LBUTTONUP and state["drag"]:
            x0, y0 = state["drag"]; state["drag"] = None
            if abs(x - x0) > 5 and abs(y - y0) > 5:
                state["boxes"].append([state["cls"], x0, y0, x, y])

    try:
        cv2.namedWindow("label")
        cv2.setMouseCallback("label", on_mouse)
    except cv2.error:
        print("No display available — run scripts.label on a machine with a GUI.")
        return

    i = 0
    while 0 <= i < len(images):
        split, img_path = images[i]
        frame = cv2.imread(str(img_path)); h, w = frame.shape[:2]
        txt = DS / "labels" / split / f"{img_path.stem}.txt"
        state["boxes"] = load_labels(txt, w, h)
        while True:
            disp = frame.copy()
            for j, (c, x1, y1, x2, y2) in enumerate(state["boxes"]):
                col = COLORS[c % len(COLORS)]
                cv2.rectangle(disp, (x1, y1), (x2, y2), col, 2 if j != state["sel"] else 3)
                cv2.putText(disp, CLASSES[c], (x1, max(y1 - 4, 10)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1)
            hud = f"[{i+1}/{len(images)}] class={state['cls']}:{CLASSES[state['cls']]}  n/p nav  d del  u undo  q quit"
            cv2.rectangle(disp, (0, 0), (disp.shape[1], 24), (0, 0, 0), -1)
            cv2.putText(disp, hud, (6, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
            cv2.imshow("label", disp)
            k = cv2.waitKey(20) & 0xFF
            if k == 255:
                continue
            if ord("0") <= k <= ord("9"):
                d = k - ord("0")
                if d < len(CLASSES):
                    if state["sel"] >= 0:
                        state["boxes"][state["sel"]][0] = d
                    else:
                        state["cls"] = d
            elif k == ord("u") and state["boxes"]:
                state["boxes"].pop(); state["sel"] = -1
            elif k == ord("d") and state["sel"] >= 0:
                state["boxes"].pop(state["sel"]); state["sel"] = -1
            elif k in (ord("n"), ord("s"), ord("p"), ord("q")):
                save_labels(txt, state["boxes"], w, h)
                if k == ord("n"):
                    i += 1; break
                if k == ord("p"):
                    i = max(0, i - 1); break
                if k == ord("q"):
                    cv2.destroyAllWindows(); print("saved & quit"); return
    cv2.destroyAllWindows()
    print("done — reached end of images")


if __name__ == "__main__":
    main()
