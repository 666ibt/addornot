# Coffee Vision — Worker Activity Monitor ☕👁️

A desktop CV demo that watches a coffee-shop camera and reports **what each
worker is doing** — and flags anyone **on their phone longer than a threshold**
(default 45 s) while on shift. Single Streamlit app, SQLite event log, no
training required to run today.

## What it detects

For every tracked **worker** (person), each frame:

| Activity | Fired when… |
|---|---|
| `using_phone` | a phone is detected near the worker |
| `eating` | a food item (sandwich/cake/donut/…) is near the worker |
| `making_drink` | a cup/bottle is near the worker **and they're moving** |
| `working` | moving, no specific object |
| `idle` | present, still, nothing in hand |

Plus a derived **alert**:

- **`phone_on_workplace`** — fired **once** when a worker's *continuous* phone
  use crosses the threshold (default 45 s). Each worker has an independent timer.

Everything is object-driven (phone / food / cup near each worker) — **no pose
skeleton, no manual zone calibration**. Workers are tracked with ByteTrack so
each keeps a stable id and its own timers.

## How it works

```
frame ─► detector (YOLO-World / COCO) ─► split person vs objects
      ─► ActivityRecognizer (per-worker state machine) ─► overlay + SQLite events
```

- **Detection** — open-vocabulary **YOLO-World** (`yolov8s-worldv2`), classes from
  text prompts, + built-in **ByteTrack**. Falls back to **COCO YOLOv8** when the
  CLIP text-encoder can't be downloaded (see *Offline* below); the objects that
  matter — `person`, `cell phone`, `cup`, `bottle`, food items, `laptop` — are
  native COCO classes, so activity detection still works offline.
- **Activity** — `src/activity.py`: associates each object with the nearest
  worker, applies the rules above with debouncing, and runs per-worker phone
  timers. Transparent and swappable (see *Extending*).

## Install & run

Python 3.11+.

```bash
cd coffee_vision
python -m venv .venv && source .venv/bin/activate     # optional
pip install -r requirements.txt
streamlit run app.py
```

Sidebar: pick a source (upload / webcam / sample), set confidence + the phone
alert threshold, press **▶ Start**. You get the live annotated view, a
**per-worker activity table**, a **phone-alert panel**, counters, and an event
log. On first run the detector auto-downloads its weights from GitHub.

### Process a file from the command line

```bash
python -m scripts.run_on_video --source incoming/clip.mp4 --max-seconds 60
# writes outputs/<name>_activity.mp4 + prints object / activity / alert summaries
# useful flags: --start-seconds N  --conf 0.2  --phone-alert-seconds 45
```

## ⚠️ Honest limits — read this before trusting the numbers

This was tuned against a **real overhead coffee-bar clip** (`IMG_6936`, 230 s).
What that footage taught us:

- **Workers detect and track well** (≈2–3 people/frame). Counting and
  presence/idle-vs-active are reliable.
- **Phones barely register from a high overhead angle** — a `cell phone` was
  detected in only **6 of 3,483 frames**. So the 45 s phone rule is *implemented
  correctly* but **won't reliably fire on overhead footage** — the wall is
  detection recall, not the logic. Reliable phone-on-shift detection needs one
  of: a lower/side camera angle, higher resolution, YOLO-World with a tuned
  prompt, or a **fine-tuned model** (see *Extending*).
- **Cups are everywhere** (10k+ detections, mostly static on the counter), so
  `making_drink` requires the worker to be *moving* to avoid firing on someone
  merely standing near cups. `bowl` is treated as drinkware, not food, because
  detectors read cafe containers as "bowl" constantly (would false-trigger
  eating).
- **ByteTrack ids can switch** under the heavy occlusion of a cramped overhead
  view, so "unique workers" over-counts.

Bottom line: the pipeline is correct and the overlay is clean, but **off-the-shelf
detection on this camera angle limits the fine activities (phone/eating).** The
fix is better input or a trained model — not more rules.

## Offline / restricted networks (COCO fallback)

YOLO-World embeds prompts with CLIP ViT-B/32 the first time `set_classes()` runs,
from a CDN some networks block (the build environment for this MVP was one).
When unreachable, `ProductDetector` prints a warning and uses COCO `yolov8s.pt`,
keeping the activity-relevant COCO classes. `detector.mode` is `"yolo-world"` or
`"coco-fallback"`. On a normal-internet machine YOLO-World is used automatically.

## Adapting to your shop

- **Detector vocabulary** — edit the sidebar prompts, or `ACTIVITY_PROMPTS` in
  `src/detector.py`.
- **Activity rules / categories** — `src/activity.py`: the `_PHONE/_FOOD/_DRINK`
  label sets and `_raw_activity()`. Tune `phone_alert_seconds`, `commit_seconds`,
  `motion_threshold`, `assoc_expand` in `RuleBasedActivityRecognizer`.

## Extending — the real "learning" step

`ActivityRecognizer` is an interface: `update(frame_index, ts, persons, objects)
-> ActivityFrameResult`. The rule-based class is one implementation. To go
ML-based (the accurate path for phone/eating): label spans of your footage per
worker, train a per-track temporal classifier, and drop in a new subclass with
the same signature and the same activity labels — **nothing in the pipeline or UI
changes**. Recipe is at the top of `src/activity.py`. The detector is likewise
swappable behind `ProductDetector.detect()/track()`.

## Tests

```bash
python tests/test_activity.py        # or: python -m pytest tests/ -q
```

Covers: activities reachable, the 45 s phone alert timing, no-alert under
threshold, and independent per-worker timers.

## Project layout

```
coffee_vision/
├── app.py                       # Streamlit worker-activity monitor
├── requirements.txt
├── data/                        # fixtures / your sample.mp4 (git-ignored)
├── tests/test_activity.py
├── scripts/
│   ├── run_on_video.py          # run pipeline on a file -> annotated mp4 + stats
│   ├── detect_demo.py           # bare detector smoke test
│   ├── make_synthetic.py        # shapes crash-test fixture
│   └── make_motion_fixture.py   # public-image motion fixture
└── src/
    ├── detector.py              # YOLO-World (+ COCO fallback) + ByteTrack
    ├── activity.py              # per-worker activity rules + phone alert
    ├── events.py                # SQLite event store
    ├── pipeline.py              # per-frame orchestration + overlay
    └── video_source.py          # webcam / file frame iterator
```

## Notes / assumptions

- Processes a bounded number of seconds per run (sidebar slider) so webcam runs
  are finite and the demo stays responsive; CPU inference is slower than
  real-time (~5–7 fps here), an accepted MVP trade-off.
- Events persist in `events.db` (git-ignored), namespaced per UI session; the app
  auto-migrates an older `events.db` to the current schema.
- No real coffee footage ships in the repo; point the app at your own clip or
  webcam. Fixtures are generated locally (see `data/README.md`).
```
