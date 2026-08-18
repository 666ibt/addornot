"""The custom classes we fine-tune the detector to recognize.

Ordering IS the class index used in YOLO label files — keep it stable once you
start labeling. Add classes at the END so existing labels stay valid.

These are the objects the activity rules key off; a detector fine-tuned on YOUR
camera should catch them far better than off-the-shelf COCO (esp. phones from an
overhead angle, which COCO barely sees).
"""

CLASSES = [
    "phone",        # 0 — a phone in a worker's hand (the priority target)
    "cup",          # 1 — cup/tumbler being handled
    "food",         # 2 — anything being eaten
    "person",       # 3 — worker (COCO already does this well; here for context)
]

# When pre-labeling with the off-the-shelf detector, map its labels -> our index.
# (Left = COCO / YOLO-World label, right = index in CLASSES above.)
PRELABEL_MAP = {
    "cell phone": 0, "phone": 0, "tablet": 0,
    "cup": 1, "coffee cup": 1, "paper cup": 1, "bottle": 1, "wine glass": 1,
    "sandwich": 2, "cake": 2, "donut": 2, "pizza": 2, "banana": 2, "apple": 2,
    "person": 3,
}
