# Training a detector on YOUR camera 🎓

This is the "learning from your videos" path. Off-the-shelf detection barely
sees phones from a high overhead angle (in the test clip: **6 of 3,483 frames**).
Fine-tuning a small detector on frames from *your* cameras is what fixes that.

There's no shortcut around the one manual part: **someone has to label examples.**
Everything else is automated. Plan for a first pass of **~150–400 labeled frames**
with plenty of phone examples.

## The loop

```
extract_frames  ─►  prelabel  ─►  label (you)  ─►  train  ─►  app uses new weights
```

### 1. Extract frames from your videos
```bash
python -m scripts.extract_frames --source incoming/           --every 2.0
python -m scripts.extract_frames --source incoming/clip.mp4   --every 1.0 --start 20 --end 40
```
Get variety, and extract **densely around moments where workers are on their
phones / eating** so those classes aren't starved. Frames land in
`training/dataset/images/{train,val}`.

### 2. Pre-label automatically (so you correct, not draw from scratch)
```bash
python -m scripts.prelabel
```
Writes YOLO labels + `training/dataset/data.yaml`. The auto-labeler is good at
`person`/`cup`, weak at `phone` — you'll **add most phone boxes yourself**.

Classes live in `training/classes.py` (`phone, cup, food, person`). The names
match the activity rules, so a trained model plugs straight in. Add classes at
the **end** to keep existing label indices valid.

### 3. Correct the labels

**Browser labeler (recommended)** — no extra dependencies, any browser:
```bash
python -m scripts.label_web      # then open http://localhost:8000
```
Left-drag to draw a box, drag inside to move, drag the corner to resize, digits
`0..3` set/reassign class, `d` deletes, `n`/`p` navigate (auto-saves), `f` jumps
to the next unlabeled image. The left panel tracks labeled/total and shows a
green dot per finished image. Labels are written straight to
`training/dataset/labels/`. **Box every phone in a hand** — tight; that's the
whole point.

Prefer a desktop app? There's also a minimal OpenCV labeler,
`python -m scripts.label` (needs a local display), and because the dataset is
standard YOLO format, LabelImg / Label Studio / Roboflow work on
`training/dataset` too.

### 4. Fine-tune
```bash
python -m scripts.train --epochs 50 --imgsz 640          # real run (GPU recommended)
python -m scripts.train --smoke --device cpu             # 3-epoch machinery test
```
On success it installs the best weights at `models/custom.pt` and writes
`models/active.txt`. CPU training is slow — use a GPU box for real runs, or keep
the set small.

### 5. Use it — automatically
`ProductDetector` prefers `models/custom.pt` when present, so
`streamlit run app.py` and `scripts.run_on_video` pick it up with no changes
(`detector.mode == "custom"`). Delete `models/custom.pt` to go back to
YOLO-World / COCO.

## How much labeling is "enough"?
- **First useful phone detector:** ~150–300 frames, most containing a phone,
  from the same camera(s) you'll run on.
- **Solid:** 500+ frames across different times of day / shifts / staff.
- Balance matters more than raw count — don't let `phone`/`food` be <10% of boxes.

## What this does and doesn't do
- **Does:** adapt *object* detection (phone/cup/food/person) to your camera —
  the direct fix for the phone-recall wall, which feeds the existing activity
  rules and the 45 s phone alert.
- **Doesn't (yet):** learn *temporal* activities directly. The rule-based
  `ActivityRecognizer` still turns detections into activities. If you later want
  a learned activity classifier, label activity spans and implement a new
  `ActivityRecognizer` subclass (see the header of `src/activity.py`); the
  pipeline/UI stay unchanged.

## Verified
The extract → prelabel → label → train → auto-load loop was run end-to-end on the
sample footage: frames extracted, pseudo-labeled, the **browser labeler** driven
in a real browser (draw box → save → written to disk with correct YOLO coords), a
3-epoch CPU smoke train produced `models/custom.pt`, and the detector switched to
`custom` mode. The smoke run trains on *pseudo-labels*, so it validates the
machinery, not accuracy — real gains come from **your corrected labels** in
step 3.
```
