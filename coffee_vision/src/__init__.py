"""Coffee Vision MVP — computer-vision pipeline for a coffee shop.

Modules:
    detector          — open-vocabulary product detection (YOLO-World) + ByteTrack.
    pose              — MediaPipe Pose wrapper (hand/body keypoints).
    zones             — polygon zones loaded from config/zones.json.
    action_recognizer — ActionRecognizer interface + rule-based implementation.
    events            — SQLite event store.
    pipeline          — glues detector + pose + actions into per-frame results/events.
    video_source      — webcam / file frame iterator.
"""
