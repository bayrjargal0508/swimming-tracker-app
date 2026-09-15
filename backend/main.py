"""AquaMotion analysis server.

Run:
    python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000

Downloads the MediaPipe pose model (~9 MB) on first start.
"""

import asyncio
import os
import tempfile
import urllib.request
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from analysis import UnreadableVideo, analyze_video

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_full/float16/latest/pose_landmarker_full.task"
)
MODEL_PATH = os.path.join(os.path.dirname(__file__), "pose_landmarker_full.task")
MAX_UPLOAD_BYTES = 300 * 1024 * 1024
ALLOWED_TYPES = {"video/mp4", "video/quicktime"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not os.path.exists(MODEL_PATH):
        # Download to a temp name then rename, so an interrupted download
        # doesn't leave a partial file that gets treated as a valid model.
        tmp = MODEL_PATH + ".download"
        urllib.request.urlretrieve(MODEL_URL, tmp)
        os.replace(tmp, MODEL_PATH)
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/analyze")
async def analyze(video: UploadFile):
    name = (video.filename or "").lower()
    if video.content_type not in ALLOWED_TYPES and not name.endswith((".mp4", ".mov")):
        raise HTTPException(415, "Only MP4 or MOV videos are supported.")

    suffix = ".mov" if name.endswith(".mov") else ".mp4"
    fd, path = tempfile.mkstemp(suffix=suffix)
    size = 0
    try:
        with os.fdopen(fd, "wb") as f:
            while chunk := await video.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "Video is larger than 300 MB. Trim it and try again.")
                f.write(chunk)
        if size == 0:
            raise HTTPException(400, "The uploaded file is empty.")
        try:
            # Off the event loop: pose estimation is CPU-bound for tens of seconds.
            return await asyncio.to_thread(analyze_video, path, MODEL_PATH)
        except UnreadableVideo as e:
            raise HTTPException(415, str(e)) from e
    finally:
        os.unlink(path)
