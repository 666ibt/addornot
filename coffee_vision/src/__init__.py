"""Coffee Vision — worker-activity monitor for a coffee shop.

Modules:
    detector      — object detection (YOLO-World open-vocab, COCO fallback) + ByteTrack.
    activity      — per-worker activity rules + phone-on-workplace alert.
    events        — SQLite event store.
    pipeline      — glues detector + activity into per-frame overlay + events.
    video_source  — webcam / file frame iterator.
"""
