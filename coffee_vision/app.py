"""Coffee Vision MVP — Streamlit UI.

Run:  streamlit run app.py

Pick a source (uploaded video / sample file / webcam), watch the annotated live
view (product boxes + pose + zones + current action), and see the event table
and per-label counters fill up. Events persist to SQLite (events.db).
"""

from __future__ import annotations

import os
import tempfile
import time
import uuid
from pathlib import Path

import cv2
import pandas as pd
import streamlit as st

from src.detector import DEFAULT_PROMPTS, ProductDetector
from src.events import EventStore
from src.pipeline import Pipeline
from src.pose import PoseEstimator
from src.action_recognizer import RuleBasedActionRecognizer
from src.video_source import VideoSource
from src.zones import Zones

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "events.db"
ZONES_PATH = ROOT / "config" / "zones.json"
SAMPLE_PATH = ROOT / "data" / "sample.mp4"           # your own real footage (optional)
MOTION_PATH = ROOT / "data" / "motion_fixture.mp4"   # public-image motion fixture
SYNTH_PATH = ROOT / "data" / "synthetic_test.mp4"    # shapes crash-test

st.set_page_config(page_title="Coffee Vision MVP", layout="wide")


# --- heavy models are cached so we don't reload on every Streamlit rerun ---
@st.cache_resource(show_spinner="Loading YOLO-World detector…")
def get_detector(prompts_key: str):
    return ProductDetector(prompts=prompts_key.split("\n"))


@st.cache_resource(show_spinner="Loading MediaPipe Pose…")
def get_pose():
    return PoseEstimator()


def make_source(choice, uploaded, cam_index):
    if choice == "Sample file (data/sample.mp4)":
        return str(SAMPLE_PATH), False
    if choice == "Motion fixture (public test image)":
        return str(MOTION_PATH), False
    if choice == "Synthetic shapes (crash-test only)":
        return str(SYNTH_PATH), False
    if choice == "Webcam":
        return int(cam_index), True
    if choice == "Upload a video" and uploaded is not None:
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=Path(uploaded.name).suffix)
        tmp.write(uploaded.read())
        tmp.flush()
        return tmp.name, False
    return None, False


# ----------------------------- sidebar -----------------------------
st.sidebar.title("☕ Coffee Vision")
st.sidebar.caption("Open-vocabulary detection + rule-based action recognition")

source_options = []
if SAMPLE_PATH.exists():
    source_options.append("Sample file (data/sample.mp4)")
if MOTION_PATH.exists():
    source_options.append("Motion fixture (public test image)")
source_options += ["Upload a video", "Webcam"]
if SYNTH_PATH.exists():
    source_options.append("Synthetic shapes (crash-test only)")

choice = st.sidebar.radio("Video source", source_options)
uploaded = st.sidebar.file_uploader("Video file", type=["mp4", "mov", "avi", "mkv"]) \
    if choice == "Upload a video" else None
cam_index = st.sidebar.number_input("Webcam index", 0, 8, 0) if choice == "Webcam" else 0

st.sidebar.subheader("Detector prompts (one per line)")
prompts_text = st.sidebar.text_area(
    "prompts", value="\n".join(DEFAULT_PROMPTS), height=180, label_visibility="collapsed"
)
conf = st.sidebar.slider("Detection confidence", 0.01, 0.9, 0.05, 0.01)
max_seconds = st.sidebar.slider("Max seconds to process", 3, 120, 20)

zones_loaded = Zones.maybe_load(ZONES_PATH)
if zones_loaded:
    st.sidebar.success(f"Zones: {', '.join(zones_loaded.polygons)}")
else:
    st.sidebar.info("No zones calibrated — using object+motion rules only. "
                    "Run scripts/calibrate_zones.py to add zones.")

col_a, col_b = st.sidebar.columns(2)
start = col_a.button("▶ Start", type="primary", use_container_width=True)
clear = col_b.button("🗑 Clear events", use_container_width=True)

# ----------------------------- main layout -----------------------------
st.title("Coffee Vision — live demo")
left, right = st.columns([3, 2])
video_slot = left.empty()
status_slot = left.empty()
counters_slot = right.container()
events_slot = right.empty()


def render_sidebar_tables(store: EventStore):
    obj_counts = store.counts("object")
    act_counts = store.counts("action")
    with counters_slot:
        c1, c2 = st.columns(2)
        c1.metric("Objects (unique tracks)", sum(n for _, n in obj_counts))
        c2.metric("Action switches", sum(n for _, n in act_counts))
        if obj_counts:
            st.caption("Products")
            st.dataframe(pd.DataFrame(obj_counts, columns=["product", "count"]),
                         hide_index=True, use_container_width=True)
        if act_counts:
            st.caption("Actions")
            st.dataframe(pd.DataFrame(act_counts, columns=["action", "count"]),
                         hide_index=True, use_container_width=True)
    rows = store.recent(limit=25)
    if rows:
        df = pd.DataFrame([dict(r) for r in rows])[
            ["video_ts", "event_type", "label", "confidence", "zone"]
        ]
        df["video_ts"] = df["video_ts"].round(2)
        df["confidence"] = df["confidence"].round(2)
        events_slot.dataframe(df, hide_index=True, use_container_width=True, height=360)


# persistent store keyed to a session id in st.session_state
if "session_id" not in st.session_state:
    st.session_state.session_id = uuid.uuid4().hex[:8]
store = EventStore(DB_PATH, session_id=st.session_state.session_id)

if clear:
    store.clear_session()
    st.toast("Cleared events for this session")

render_sidebar_tables(store)

if start:
    src, is_cam = make_source(choice, uploaded, cam_index)
    if src is None:
        st.warning("Pick a valid source (upload a file or choose sample/webcam).")
        st.stop()

    detector = get_detector(prompts_text)
    detector.set_prompts([p for p in prompts_text.splitlines() if p.strip()])
    detector.conf = conf
    pose = get_pose()

    try:
        vs = VideoSource(src)
    except RuntimeError as e:
        st.error(str(e))
        st.stop()

    recognizer = RuleBasedActionRecognizer(fps=vs.fps)
    pipe = Pipeline(
        detector=detector, pose=pose, recognizer=recognizer,
        zones=zones_loaded, store=store, fps=vs.fps,
    )

    max_frames = int(max_seconds * vs.fps)
    t0 = time.time()
    processed = 0
    for idx, ts, frame in vs.frames():
        annotated, _ = pipe.process(idx, ts, frame)
        rgb = cv2.cvtColor(annotated, cv2.COLOR_BGR2RGB)
        video_slot.image(rgb, channels="RGB", use_column_width=True)
        processed += 1
        if processed % 5 == 0 or processed == 1:
            render_sidebar_tables(store)
        elapsed = time.time() - t0
        status_slot.caption(
            f"frame {processed} · video t={ts:.1f}s · {processed/max(elapsed,1e-6):.1f} fps processing"
        )
        if processed >= max_frames:
            break
    vs.release()
    render_sidebar_tables(store)
    status_slot.success(f"Done — processed {processed} frames.")
