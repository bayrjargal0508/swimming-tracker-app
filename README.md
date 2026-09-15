# Stroke Lab

Freestyle swimming technique analysis from a phone video. Pick a clip, the
backend tracks 33 body joints with MediaPipe pose estimation, and the app shows
a skeleton overlay, timestamped faults, and arm / leg / body-line scores — all
derived from measured landmarks, never invented.

## Run the backend

```sh
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
```

First start downloads the MediaPipe pose model (~9 MB). Smoke test:
`.venv/bin/python test_smoke.py`.

## Run the app

```sh
npm install
npx expo start
```

In dev the app assumes the backend runs on the same machine as Metro (port
8000). Point it elsewhere with:

```sh
EXPO_PUBLIC_API_URL=http://192.168.1.20:8000 npx expo start
```

## Filming for good results

- Side of the pool, camera at water level, whole body in frame.
- One swimmer, freestyle, a few strokes or more (first 60 s are analyzed).
- MP4 or MOV, up to 300 MB.

If tracking is unreliable (splash, glare, distance), the app says so and
withholds scores instead of guessing.

## How scoring works

Rules over the joint time series flag faults with timestamps: hips sinking
below the shoulder–ankle line, head lifted, bent-knee kick (< 115°), kick
depth, straight-arm pull, dropped elbow at the catch, uneven stroke rhythm.
Each area starts at 96; a major fault costs 18, a minor one 8; overall is
40% arms + 30% legs + 30% body line.
# swimming-tracker-app
