"""Coffee Vision — worker activity monitor (Streamlit UI).

Run:  streamlit run app.py

Detects workers and what each is doing (using_phone / eating / making_drink /
working / idle) from a camera or video, flags anyone on their phone longer than
the threshold (default 45 s), shows a live per-worker table + alerts + counters,
and logs everything to SQLite.
"""

from __future__ import annotations

import tempfile
import time
import uuid
from pathlib import Path

import cv2
import pandas as pd
import streamlit as st

from src.detector import ACTIVITY_PROMPTS, ProductDetector
from src.activity import RuleBasedActivityRecognizer
from src.events import EventStore
from src.line_counter import LineCounter
from src.notifier import TelegramNotifier, format_shift_report
from src.pipeline import Pipeline
from src.shifts import shift_key, shift_name
from src.video_source import VideoSource, mask_url, rtsp_url

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "events.db"
LINE_PATH = ROOT / "config" / "line.json"
SAMPLE_PATH = ROOT / "data" / "sample.mp4"
MOTION_PATH = ROOT / "data" / "motion_fixture.mp4"

st.set_page_config(page_title="Coffee Vision — Worker Activity", layout="wide")


@st.cache_resource(show_spinner="Loading detector…")
def get_detector(prompts_key: str, conf: float):
    return ProductDetector(prompts=[p for p in prompts_key.splitlines() if p.strip()], conf=conf)


def make_source(choice, uploaded, cam_index, rtsp=None):
    if choice == "Sample file (data/sample.mp4)":
        return str(SAMPLE_PATH)
    if choice == "Motion fixture":
        return str(MOTION_PATH)
    if choice == "Webcam":
        return int(cam_index)
    if choice == "IP camera (RTSP)":
        return rtsp or None
    if choice == "Upload a video" and uploaded is not None:
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=Path(uploaded.name).suffix)
        tmp.write(uploaded.read()); tmp.flush()
        return tmp.name
    return None


# --------------------------- sidebar ---------------------------
st.sidebar.title("☕ Worker Activity Monitor")
st.sidebar.caption("Detects workers & their activities; flags phone use on the job")

opts = []
if SAMPLE_PATH.exists():
    opts.append("Sample file (data/sample.mp4)")
if MOTION_PATH.exists():
    opts.append("Motion fixture")
opts += ["Upload a video", "Webcam", "IP camera (RTSP)"]
choice = st.sidebar.radio("Video source", opts)
uploaded = st.sidebar.file_uploader("Video file", type=["mp4", "mov", "avi", "mkv"]) \
    if choice == "Upload a video" else None
cam_index = st.sidebar.number_input("Webcam index", 0, 8, 0) if choice == "Webcam" else 0

rtsp = None
if choice == "IP camera (RTSP)":
    with st.sidebar.expander("Camera connection", expanded=True):
        mode = st.radio("Enter as", ["Build from IP", "Full RTSP URL"], key="rtspmode")
        if mode == "Full RTSP URL":
            rtsp = st.text_input("RTSP URL", type="password",
                                 placeholder="rtsp://admin:pass@192.168.0.135:554/...")
        else:
            host = st.text_input("Camera IP", placeholder="192.168.0.135")
            user = st.text_input("User", value="admin")
            pwd = st.text_input("Password", type="password")
            vendor = st.selectbox("Vendor", ["hikvision", "dahua"])
            sub = st.checkbox("Use substream (lighter CPU)", value=True)
            if host and pwd:
                rtsp = rtsp_url(host, pwd, user, 554, vendor, substream=sub)
                st.caption(f"→ {mask_url(rtsp)}")

conf = st.sidebar.slider("Detection confidence", 0.05, 0.9, 0.20, 0.05)
phone_alert = st.sidebar.slider("Phone-on-workplace alert (seconds)", 10, 180, 45, 5)
max_seconds = st.sidebar.slider("Max seconds to process", 5, 240, 40)

_saved_line = LineCounter.load(LINE_PATH)
with st.sidebar.expander("Dispensing line (product counting)",
                         expanded=_saved_line is None):
    count_products = st.checkbox("Count products crossing a line", value=True)
    st.caption("Position the line on the pickup edge. 0 = left/top, 1 = right/bottom.")
    d = _saved_line or LineCounter()
    lx1 = st.slider("x1", 0.0, 1.0, float(d.p1[0]), 0.01)
    ly1 = st.slider("y1", 0.0, 1.0, float(d.p1[1]), 0.01)
    lx2 = st.slider("x2", 0.0, 1.0, float(d.p2[0]), 0.01)
    ly2 = st.slider("y2", 0.0, 1.0, float(d.p2[1]), 0.01)
    ldir = st.selectbox("Count direction", ["both", "positive", "negative"],
                        index=["both", "positive", "negative"].index(d.direction))
    if st.button("💾 Save line", use_container_width=True):
        LineCounter(p1=(lx1, ly1), p2=(lx2, ly2), direction=ldir).save(LINE_PATH)
        st.success("Saved to config/line.json")

with st.sidebar.expander("Detector vocabulary (YOLO-World prompts)"):
    prompts_text = st.text_area("prompts", value="\n".join(ACTIVITY_PROMPTS),
                                height=160, label_visibility="collapsed")

with st.sidebar.expander("Shift report (Telegram)"):
    _notifier = TelegramNotifier()
    _day, _shift = shift_key()
    st.caption(f"Current shift: **{shift_name(_shift)}**, {_day}")
    if _notifier.enabled:
        st.success("Telegram configured")
    else:
        st.info("Set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars "
                "(or config/telegram.json) to enable reports.")
    send_now = st.button("📤 Send shift report now", use_container_width=True)

c1, c2 = st.sidebar.columns(2)
start = c1.button("▶ Start", type="primary", use_container_width=True)
clear = c2.button("🗑 Clear", use_container_width=True)

# --------------------------- layout ---------------------------
st.title("Worker Activity Monitor")
left, right = st.columns([3, 2])
video_slot = left.empty()
status_slot = left.empty()
alert_slot = right.empty()
workers_slot = right.empty()
counters_slot = right.container()
events_slot = right.empty()

if "session_id" not in st.session_state:
    st.session_state.session_id = uuid.uuid4().hex[:8]
store = EventStore(DB_PATH, session_id=st.session_state.session_id)

if clear:
    store.clear_session()
    st.toast("Cleared events for this session")


def render_workers(persons):
    if persons:
        df = pd.DataFrame([{
            "worker": f"#{p.track_id}", "activity": p.activity,
            "in activity (s)": round(p.duration, 1),
            "phone (s)": round(p.phone_seconds, 1),
            "flag": "📵 PHONE >limit" if p.phone_alert else "",
        } for p in sorted(persons, key=lambda x: x.track_id)])
        workers_slot.dataframe(df, hide_index=True, use_container_width=True)


def render_tables(store: EventStore, line: LineCounter | None = None):
    alerts = store.recent(20, event_types=["alert"])
    if alerts:
        lines = "\n".join(
            f"- **t={r['video_ts']:.0f}s** {r['detail']} ({r['duration']:.0f}s)"
            for r in alerts)
        alert_slot.error("📵 **Phone-on-workplace alerts**\n" + lines)
    act = store.counts("activity")
    obj = store.counts("object")
    with counters_slot:
        m1, m2, m3 = st.columns(3)
        m1.metric("🥤 Products dispensed", line.total if line else 0)
        m2.metric("Activity switches", sum(n for _, n in act))
        m3.metric("Phone alerts", len(alerts))
        if line and line.counts:
            st.caption("Dispensed by type (crossed the line)")
            st.dataframe(pd.DataFrame(sorted(line.counts.items(), key=lambda x: -x[1]),
                                      columns=["product", "sold"]),
                         hide_index=True, use_container_width=True)
        if obj:
            st.caption("Objects seen (unique tracks)")
            st.dataframe(pd.DataFrame(obj, columns=["object", "count"]),
                         hide_index=True, use_container_width=True)
    rows = store.recent(25, event_types=["sale", "activity", "alert"])
    if rows:
        df = pd.DataFrame([dict(r) for r in rows])[
            ["video_ts", "event_type", "track_id", "label", "duration", "detail"]]
        df["video_ts"] = df["video_ts"].round(1)
        df["duration"] = df["duration"].round(1)
        events_slot.dataframe(df, hide_index=True, use_container_width=True, height=300)


render_tables(store)

if send_now:
    _sales = dict(store.counts_for_shift(_day, _shift, "sale"))
    _acts = dict(store.counts_for_shift(_day, _shift, "activity"))
    _alr = dict(store.counts_for_shift(_day, _shift, "alert"))
    _text = format_shift_report(_day, shift_name(_shift), _sales, _acts,
                                _alr.get("phone_on_workplace", 0))
    if _notifier.enabled and _notifier.send(_text):
        st.sidebar.success("Report sent to Telegram")
    else:
        st.sidebar.warning("Telegram not configured — report below")
    st.code(_text, language=None)

if start:
    src = make_source(choice, uploaded, cam_index, rtsp)
    if src is None:
        st.warning("Pick a valid source (upload a file, or choose sample/webcam).")
        st.stop()
    detector = get_detector(prompts_text, conf)
    detector.conf = conf
    try:
        vs = VideoSource(src)
    except RuntimeError as e:
        st.error(str(e)); st.stop()

    if detector.mode == "coco-fallback":
        st.info("Detector in COCO-fallback mode (YOLO-World CLIP weights unreachable). "
                "Phones/food/cups are still detected as native COCO classes; small "
                "objects from a high angle may have low recall.")

    rec = RuleBasedActivityRecognizer(fps=vs.fps, phone_alert_seconds=phone_alert)
    live_line = (LineCounter(p1=(lx1, ly1), p2=(lx2, ly2), direction=ldir)
                 if count_products else None)
    pipe = Pipeline(detector=detector, recognizer=rec, store=store, fps=vs.fps,
                    phone_alert_seconds=phone_alert, line_counter=live_line)
    max_frames = int(max_seconds * vs.fps)
    t0 = time.time(); n = 0
    for idx, ts, frame in vs.frames():
        annotated, res = pipe.process(idx, ts, frame)
        video_slot.image(cv2.cvtColor(annotated, cv2.COLOR_BGR2RGB),
                         channels="RGB", use_column_width=True)
        n += 1
        if n % 5 == 0 or n == 1:
            render_workers(res.activity.persons)
            render_tables(store, live_line)
        sold = f" · sold {live_line.total}" if live_line else ""
        status_slot.caption(
            f"frame {n} · t={ts:.1f}s · {n/max(time.time()-t0,1e-6):.1f} fps"
            f" · mode={detector.mode}{sold}")
        if n >= max_frames:
            break
    vs.release()
    render_workers(res.activity.persons)
    render_tables(store, live_line)
    status_slot.success(f"Done — processed {n} frames.")
