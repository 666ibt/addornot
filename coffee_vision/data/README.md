# data/

Video files here are **git-ignored** (see `../.gitignore`) to keep the repo
light. Generate the fixtures or drop your own clip:

```bash
# recommended demo fixture — real events (person image, animated):
python -m scripts.make_motion_fixture --out data/motion_fixture.mp4

# pipeline crash-test only (shapes, no events):
python -m scripts.make_synthetic --out data/synthetic_test.mp4

# your own real footage — the app lists it as "Sample file":
cp /path/to/your_clip.mp4 data/sample.mp4
```

See the top-level `README.md` for what each fixture is and why there's no real
coffee-shop footage in this repo.
