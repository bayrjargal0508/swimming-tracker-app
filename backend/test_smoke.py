"""Smallest check that fails if the pipeline breaks: run `.venv/bin/python test_smoke.py`.

Feeds a synthetic video (no swimmer) through the full analyze path and expects
the low-confidence branch, plus the too-short guard. Downloads the pose model
on first run.
"""

import os
import tempfile
import urllib.request

import cv2
import numpy as np

from analysis import UnreadableVideo, analyze_video
from main import MODEL_PATH, MODEL_URL


def make_video(path: str, seconds: float, fps: int = 24):
    w, h = 320, 240
    out = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for i in range(int(seconds * fps)):
        frame = np.zeros((h, w, 3), np.uint8)
        frame[:] = (60, 40, 8)
        x = int((i * 3) % (w - 40))
        cv2.rectangle(frame, (x, 100), (x + 40, 140), (200, 200, 200), -1)
        out.write(frame)
    out.release()


def main():
    if not os.path.exists(MODEL_PATH):
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)

    with tempfile.TemporaryDirectory() as d:
        # No human in frame -> full pipeline runs, low-confidence branch taken.
        p = os.path.join(d, "empty.mp4")
        make_video(p, seconds=5)
        r = analyze_video(p, MODEL_PATH)
        assert r["confidence"]["reliable"] is False, r["confidence"]
        assert r["scores"] is None
        assert r["video"]["width"] == 320
        assert len(r["frames"]) > 20

        # Too short -> explicit error.
        p2 = os.path.join(d, "short.mp4")
        make_video(p2, seconds=0.2)
        try:
            analyze_video(p2, MODEL_PATH)
            raise AssertionError("expected UnreadableVideo for a 0.2 s clip")
        except UnreadableVideo:
            pass

    print("smoke ok")


if __name__ == "__main__":
    main()
