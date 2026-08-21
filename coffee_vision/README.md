# Coffee Vision — Worker Activity & Product Counting ☕👁️

Watches a coffee-shop camera (webcam, video file, or **Hikvision/Dahua IP camera
over RTSP**) and reports:

* **what each worker is doing** — and flags anyone **on their phone longer than a
  threshold** (default 45 s) while on shift;
* **how many products were handed out** — counted when they cross a virtual
  **dispensing line**, per product type;
* **end-of-shift summaries** — grouped into 3 shifts/day, stored in SQLite and
  optionally pushed to **Telegram**.

Runs as a Streamlit app for live viewing, or as a headless **24/7 service**. No
model training required to start.

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

## IP camera (Hikvision / Dahua) 📹

**1. Test the connection first:**
```bash
python -m scripts.test_camera --host 192.168.0.135 --password SECRET
python -m scripts.test_camera --host 192.168.0.135 --password SECRET --vendor dahua
```
It reports resolution/FPS, measures the real frame rate, and saves a snapshot to
`outputs/camera_test.jpg`. URLs are built for you:

| Vendor | URL |
|---|---|
| Hikvision | `rtsp://user:pass@IP:554/Streaming/Channels/102` |
| Dahua | `rtsp://user:pass@IP:554/cam/realmonitor?channel=1&subtype=1` |

Channel **101 / subtype 0** = main stream (full quality, heavy CPU);
**102 / subtype 1** = **substream — use this for analytics**, same detections at a
fraction of the cost.

**2. Place the dispensing line** (where a finished drink leaves the bar):
```bash
python -m scripts.setup_line --url "rtsp://..."          # click 2 points
python -m scripts.setup_line --source clip.mp4 --coords 0.3,0.62,0.75,0.62   # no GUI
```
Saved to `config/line.json`. It can run **diagonally** along the real pickup edge,
and `--direction positive/negative` counts only the outward direction, so pulling
a cup back doesn't add a sale. You can also set it live with the sliders in the
Streamlit sidebar.

**3. Run the 24/7 service** (headless, auto-reconnects, reports per shift):
```bash
python -m scripts.run_service --url "rtsp://admin:PASS@192.168.0.135:554/Streaming/Channels/102"
python -m scripts.run_service --source clip.mp4 --once      # test on a file
python -m scripts.run_service --report-now                  # print/send current shift report
```
`--target-fps 6` (default) throttles analytics to keep CPU sane — detection is the
expensive part, and 6 fps is plenty for counting cups and watching people.

## Shifts & Telegram reports 📤

Shifts are **00:00–08:00**, **08:00–16:00**, **16:00–24:00**. Every event is
stamped with its day + shift, so reports are a database query and survive a
restart. At each shift change the service sends a summary (products by type,
total, activity counts, phone alerts).

Configure Telegram — **never hard-code the token**:
```bash
setx TELEGRAM_BOT_TOKEN "123456:ABC..."      # Windows
setx TELEGRAM_CHAT_ID   "987654321"
```
or `config/telegram.json`: `{"bot_token": "...", "chat_id": "..."}`.
Get the token from **@BotFather**; get your chat id by messaging your bot once and
opening `https://api.telegram.org/bot<TOKEN>/getUpdates`.
Without it everything still runs — reports are just printed to the console.

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

**Fine-tune a detector on your own camera** to fix the phone-recall wall — see
[`TRAINING.md`](TRAINING.md) for the full loop (extract frames → auto pre-label →
correct labels → train → the app auto-loads `models/custom.pt`). This is the
highest-value improvement for phone/eating detection.

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
├── config/                      # line.json, telegram.json (git-ignored)
├── tests/
│   ├── test_activity.py
│   └── test_line_counter.py     # line crossing + shift logic
├── scripts/
│   ├── run_service.py           # 24/7 headless service + shift reports
│   ├── test_camera.py           # verify an RTSP camera before wiring it in
│   ├── setup_line.py            # place the dispensing line
│   ├── run_on_video.py          # run pipeline on a file -> annotated mp4 + stats
│   ├── extract_frames.py / prelabel.py / label_web.py / train.py   # training loop
│   └── make_synthetic.py / make_motion_fixture.py                  # test fixtures
└── src/
    ├── detector.py              # YOLO-World (+ COCO fallback / custom) + ByteTrack
    ├── activity.py              # per-worker activity rules + phone alert
    ├── line_counter.py          # virtual dispensing line -> product counts
    ├── shifts.py                # 3 shifts/day + change detection
    ├── notifier.py              # Telegram reports (stdlib only)
    ├── events.py                # SQLite event store (day/shift stamped)
    ├── pipeline.py              # per-frame orchestration + overlay
    └── video_source.py          # webcam / file / RTSP with auto-reconnect
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
