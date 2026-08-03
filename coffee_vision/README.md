# Coffee Vision MVP ☕

A **working end-to-end** computer-vision demo for a coffee shop: it detects
products and recognizes the barista's actions from a camera or video file, shows
a live annotated view, logs events to SQLite, and displays running counters —
all in a single Streamlit app.

It is deliberately a **desktop demo, not production**: no Docker/Kafka/Postgres,
no cloud, no model training required to run today.

## What it does

- **Product detection** — open-vocabulary [YOLO-World](https://docs.ultralytics.com/models/yolo-world/)
  (`yolov8s-worldv2`). Classes are set from **text prompts**, so there is *no
  fine-tuning on your own data*. Objects are tracked across frames with the
  built-in **ByteTrack**. (If the CLIP text-encoder can't be downloaded — see
  *Offline / restricted networks* below — the detector transparently falls back
  to a COCO-pretrained YOLOv8 so the demo still runs.)
- **Barista actions** — **no temporal model trained from scratch** (we have no
  labeled data). Instead: **MediaPipe Pose** for wrist/body keypoints + a
  **rule-based state machine** over three signals:
  1. which **zone** of the frame the hand is in (drawn once during calibration),
  2. which **object** the detector sees near the hand,
  3. the **hand motion** over the last ~1 s (variance of the wrist position —
     no neural net).

  Recognized actions: `grinding_tamping`, `espresso_extraction`,
  `milk_steaming`, `milk_pouring`, `idle`.
- **Events** — each new object (per track) and each action change is written to
  **SQLite** (`events.db`): `ts, video_ts, event_type, label, confidence, zone`.
- **UI** — one **Streamlit** app: choose source (upload / sample / webcam), live
  overlay (boxes + pose + zones + current action), event table, per-label
  counters.

## Install

Requires **Python 3.11+**.

```bash
cd coffee_vision
python -m venv .venv && source .venv/bin/activate   # optional but recommended
pip install -r requirements.txt
```

On first run the detector auto-downloads `yolov8s-worldv2.pt` (~25 MB) from the
Ultralytics GitHub release.

## Run

```bash
streamlit run app.py
```

Then in the sidebar: pick a **Video source**, adjust prompts/confidence if you
like, and press **▶ Start**. You'll see the annotated video, the event table
filling up, and the counters updating.

### Test data

I had **no real coffee-shop footage**, and the build environment's network
policy blocked the stock-video sites (Pexels/Pixabay/Wikimedia CDNs all returned
403). So instead of faking real footage, the repo ships **two clearly-labeled
fixtures**, both generated locally and git-ignored:

1. **Motion fixture** (`data/motion_fixture.mp4`) — recommended for the demo. A
   *real public test image of a person* (Ultralytics' `zidane.jpg`, fetched from
   GitHub) animated across the frame so the **real** detector and pose model
   actually fire: you get `person` object events and several action events
   (grinding_tamping / espresso_extraction / milk_steaming / idle) as the wrist
   sweeps through the zones. It is a **fixture, not coffee footage** — the person
   is a generic test image and the "coffee actions" are only inferred by the
   zone/motion rules. The disclaimer is burned into every frame.

   ```bash
   python -m scripts.make_motion_fixture --out data/motion_fixture.mp4
   ```

2. **Synthetic shapes** (`data/synthetic_test.mp4`) — a pure crash-test. Moving
   rectangles/circles that loosely imitate a hand and a cup. Real detectors see
   nothing in it (so it emits no events); it only proves the pipeline runs
   end-to-end without crashing on arbitrary input.

   ```bash
   python -m scripts.make_synthetic --out data/synthetic_test.mp4
   ```

⚠️ Neither clip is a measure of accuracy. For a real evaluation, drop an actual
clip at `data/sample.mp4` (any short video of someone doing manual work at a
table exercises pose + actions; a coffee-bar clip also exercises product
detection) and select it in the sidebar — or just point the app at your webcam.

### Offline / restricted networks (why there's a COCO fallback)

YOLO-World embeds your text prompts with OpenAI's **CLIP ViT-B/32** the first
time `set_classes()` runs, and that checkpoint is hosted on a CDN
(`openaipublic.azureedge.net`) that some locked-down networks block — the build
environment for this MVP was one of them. When those weights can't be fetched,
`ProductDetector` prints a warning and **falls back to a COCO-pretrained
`yolov8s.pt`** (which downloads fine from GitHub), remapping the overlapping COCO
classes to the coffee vocabulary (`cup → "coffee cup"`, `bottle → "milk carton"`,
`person → "person"`, …). COCO has no *espresso machine* / *portafilter* class, so
those aren't detected in fallback mode. Check which path is active with
`detector.mode` (`"yolo-world"` vs `"coco-fallback"`), shown in the console.

**On a machine with normal internet, YOLO-World is used automatically — nothing
to configure**, and the full open-vocabulary prompt list works.

## Standalone smoke-test scripts

Each pipeline stage has its own runnable script (handy for debugging):

```bash
python -m scripts.detect_demo --source data/motion_fixture.mp4 --out out_detect.mp4
python -m scripts.pose_demo   --source data/motion_fixture.mp4 --out out_pose.mp4
```

They print detection/pose counts so you can confirm the stage produces non-empty
results.

There's also a dependency-free unit test that the action state machine can reach
all five labels and that its debounce holds:

```bash
python tests/test_action_recognizer.py     # or: python -m pytest tests/ -q
```

### How this MVP was verified

Every step was actually run, not assumed: detector on a real image (non-empty
boxes), MediaPipe pose (wrists found on real frames), the full `Pipeline` on the
motion fixture (logged `person` + 4 action types to SQLite), and the Streamlit
app driven end-to-end in a real headless browser — it reached the *Done* banner
with no error and populated the events table. In this environment the detector
ran in **COCO-fallback** mode (CLIP CDN blocked, see above).

## Calibrating zones for your camera

Zones tell the action rules *where* the grinder, group head, steam wand and
counter are in the frame. Draw them once on the first frame:

```bash
python -m scripts.calibrate_zones --source data/sample.mp4    # or --source 0 for webcam
```

Click **4 corners** for each of `grinder`, `group_head`, `steam_wand`,
`counter` (keys: `u` undo, `r` restart, `n` skip, `q` quit). The result is saved
to `config/zones.json` and picked up automatically by the app.

**Headless machine (no display)?** Use `--auto` to write evenly-tiled default
zones so the pipeline still runs:

```bash
python -m scripts.calibrate_zones --source data/synthetic_test.mp4 --auto
```

Without any zones the app still works — it falls back to **object + motion**
rules only (see `RuleBasedActionRecognizer._raw_label`).

## Adapting to your menu

Edit the detector prompts — either the **sidebar text box** at runtime, or the
default list in [`src/detector.py`](src/detector.py) (`DEFAULT_PROMPTS`). YOLO-World
re-embeds the words and starts detecting them; no retraining needed. Example:

```python
DEFAULT_PROMPTS = ["matcha tin", "oat milk carton", "to-go cup", "person", ...]
```

## Extension points for future model training

The design keeps a clean seam so you can replace the rule-based parts with
trained models **without touching the pipeline or UI**:

- **Actions → a trained temporal model.** `ActionRecognizer` in
  [`src/action_recognizer.py`](src/action_recognizer.py) is an interface with a
  single contract: `update(FrameContext) -> ActionPrediction`. The rule-based
  class is one implementation. To go ML-based, subclass `ActionRecognizer`
  (e.g. an LSTM/TCN over pose keypoints, or a video classifier like
  SlowFast/MoViNet over cropped clips), keep the same 5 labels, and construct it
  in `Pipeline(...)` instead of `RuleBasedActionRecognizer`. `FrameContext`
  already carries wrist positions, per-wrist zone, nearby objects and
  timestamps, so no extra plumbing is needed. Full recipe is documented at the
  top of that file.
- **Detection → a fine-tuned detector.** `ProductDetector` in
  [`src/detector.py`](src/detector.py) wraps the model behind `detect()` /
  `track()`. Swap in a fine-tuned YOLO (or any detector returning the same
  `Detection` dataclass) and nothing downstream changes.

## Assumptions & notes (decisions made without asking)

- **No real footage available / stock CDNs blocked here** → shipped two labeled
  fixtures (motion + shapes) instead of faking real footage, and made explicit
  that neither is an accuracy test.
- **CLIP CDN blocked here** → added a COCO-YOLOv8 fallback so the demo runs
  offline; YOLO-World stays the default whenever CLIP is reachable.
- **Detection confidence defaults to a low 0.05** — YOLO-World's open-vocabulary
  scores run low, and a coffee-bar scene differs a lot from the model's training
  distribution; a low threshold favors *seeing* objects for the demo over
  precision. Tune it in the sidebar.
- **Streamlit processes a bounded number of seconds per run** (sidebar slider,
  default 20 s) so the demo stays responsive and webcam runs are finite.
- **The app processes as fast as it can and shows every processed frame** rather
  than enforcing real-time playback; on CPU this is slower than real-time, which
  is an accepted MVP trade-off.
- **Events are namespaced by a per-UI-session id** so repeated runs don't mix in
  the counters; the SQLite file persists across runs (use *Clear events*).
- **`data/sample.mp4` and the synthetic clip are git-ignored** to keep the repo
  light — regenerate the synthetic one with the command above.

## Project layout

```
coffee_vision/
├── app.py                     # Streamlit UI (the demo)
├── requirements.txt
├── config/zones.json          # created by calibrate_zones.py
├── data/                      # sample.mp4 / synthetic_test.mp4 (git-ignored)
├── tests/
│   └── test_action_recognizer.py   # deterministic action-rule tests
├── scripts/
│   ├── make_synthetic.py      # shapes crash-test fixture
│   ├── make_motion_fixture.py # public-image motion fixture (real events)
│   ├── calibrate_zones.py     # click 4 corners per zone
│   ├── detect_demo.py         # step-2 detector smoke test
│   └── pose_demo.py           # step-3 pose smoke test
└── src/
    ├── detector.py            # YOLO-World (+ COCO fallback) + ByteTrack wrapper
    ├── pose.py                # MediaPipe Pose wrapper
    ├── zones.py               # polygon zones + point-in-zone
    ├── action_recognizer.py   # ActionRecognizer interface + rule-based impl
    ├── events.py              # SQLite event store
    ├── video_source.py        # webcam / file frame iterator
    └── pipeline.py            # per-frame orchestration + drawing
```
