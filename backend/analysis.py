"""Freestyle technique analysis from a side-view video.

Pipeline: sample frames -> MediaPipe pose landmarks -> per-joint time series ->
threshold rules with timestamps -> deterministic scores. Every number in the
response is derived from measured landmarks; nothing is invented.

Assumes a side-on view of one swimmer. Image coords are normalized, y points down.
"""

import math

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision

# MediaPipe pose landmark indices.
NOSE = 0
L_SH, R_SH = 11, 12
L_EL, R_EL = 13, 14
L_WR, R_WR = 15, 16
L_HIP, R_HIP = 23, 24
L_KNEE, R_KNEE = 25, 26
L_ANK, R_ANK = 27, 28

CORE = [L_SH, R_SH, L_HIP, R_HIP, L_KNEE, R_KNEE, L_ANK, R_ANK, L_WR, R_WR]

SAMPLE_FPS = 8.0
MAX_SECONDS = 60.0


class UnreadableVideo(Exception):
    pass


def mmss(t: float) -> str:
    s = max(0, int(t))
    return f"{s // 60}:{s % 60:02d}"


def _smooth(x: np.ndarray, k: int) -> np.ndarray:
    if k <= 1 or len(x) < k:
        return x
    k |= 1  # odd window; edge-pad so boundaries aren't pulled toward zero
    pad = k // 2
    return np.convolve(np.pad(x, pad, mode="edge"), np.ones(k) / k, mode="valid")


def _runs(mask: np.ndarray, t: np.ndarray, min_dur: float, merge_gap: float = 0.3):
    """Contiguous True segments of at least min_dur seconds, nearby segments merged."""
    segs = []
    start = None
    for i, on in enumerate(mask):
        if on and start is None:
            start = i
        elif not on and start is not None:
            segs.append((start, i - 1))
            start = None
    if start is not None:
        segs.append((start, len(mask) - 1))
    merged = []
    for s, e in segs:
        if merged and t[s] - t[merged[-1][1]] < merge_gap:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return [(t[s], t[e]) for s, e in merged if t[e] - t[s] >= min_dur]


def _angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Angle at b (degrees) for point series a, b, c of shape (n, 2)."""
    v1, v2 = a - b, c - b
    dot = (v1 * v2).sum(axis=1)
    norm = np.linalg.norm(v1, axis=1) * np.linalg.norm(v2, axis=1)
    return np.degrees(np.arccos(np.clip(dot / np.maximum(norm, 1e-9), -1, 1)))


def _peaks(x: np.ndarray, t: np.ndarray, prominence: float, min_gap: float):
    """Local maxima with simple prominence and a minimum time gap. Returns times."""
    times = []
    last = -1e9
    for i in range(1, len(x) - 1):
        if x[i] >= x[i - 1] and x[i] > x[i + 1]:
            lo = max(0, i - 8)
            hi = min(len(x), i + 9)
            if x[i] - min(x[lo:hi].min(), x[i]) >= prominence and t[i] - last >= min_gap:
                times.append(t[i])
                last = t[i]
    return times


def extract_frames(path: str, model_path: str):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise UnreadableVideo("Could not read this video file.")
    try:
        cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
    except cv2.error:
        pass
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or math.isnan(fps) or fps <= 1:
        fps = 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = max(1, round(fps / SAMPLE_FPS))
    eff_fps = fps / step
    max_samples = int(MAX_SECONDS * eff_fps)

    options = vision.PoseLandmarkerOptions(
        base_options=mp_tasks.BaseOptions(model_asset_path=model_path),
        running_mode=vision.RunningMode.VIDEO,
        min_pose_detection_confidence=0.4,
        min_pose_presence_confidence=0.4,
        min_tracking_confidence=0.4,
    )

    frames = []
    truncated = False
    with vision.PoseLandmarker.create_from_options(options) as landmarker:
        i = 0
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            if i % step == 0:
                if len(frames) >= max_samples:
                    truncated = True
                    break
                t = i / fps
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = landmarker.detect_for_video(image, int(t * 1000))
                if result.pose_landmarks:
                    lm = [
                        [round(p.x, 4), round(p.y, 4), round(p.visibility, 3)]
                        for p in result.pose_landmarks[0]
                    ]
                else:
                    lm = None
                frames.append({"t": round(t, 3), "lm": lm})
            i += 1
    cap.release()

    if len(frames) < int(2 * eff_fps):
        raise UnreadableVideo(
            "This video is too short to analyze. Film at least a few seconds of swimming."
        )
    analyzed_duration = frames[-1]["t"]
    full_duration = frame_count / fps if frame_count > 0 else analyzed_duration
    return frames, eff_fps, analyzed_duration, full_duration, width, height, truncated


def analyze_video(path: str, model_path: str) -> dict:
    frames, eff_fps, duration, full_duration, width, height, truncated = extract_frames(
        path, model_path)
    t = np.array([f["t"] for f in frames])
    n = len(frames)

    L = np.full((n, 33, 3), np.nan)
    for i, f in enumerate(frames):
        if f["lm"]:
            L[i] = f["lm"]

    detected = ~np.isnan(L[:, 0, 0])
    detected_ratio = float(detected.mean())
    core_vis = L[detected][:, CORE, 2] if detected.any() else np.zeros((1, len(CORE)))
    mean_vis = float(np.mean(core_vis))

    note_parts = []
    if truncated:
        note_parts.append(f"Analyzed the first {int(MAX_SECONDS)} seconds.")

    def payload(reliable, note, stats, findings, scores, summary):
        return {
            "video": {"duration": round(full_duration, 2), "width": width, "height": height},
            "sampling": {"fps": round(eff_fps, 3)},
            "confidence": {
                "detectedRatio": round(detected_ratio, 3),
                "meanVisibility": round(mean_vis, 3),
                "reliable": reliable,
                "note": note,
            },
            "stats": stats,
            "frames": frames,
            "findings": findings,
            "scores": scores,
            "summary": summary,
        }

    empty_stats = {"strokeRateSpm": None, "kicksPerStroke": None, "bodyAngleDeg": None}

    if detected_ratio < 0.5 or mean_vis < 0.45:
        note = (
            "The swimmer's body could not be tracked reliably — glare, splash or distance "
            "hide too many joints. Film from the side, close enough that the whole body "
            "fills most of the frame."
        )
        return payload(False, note, empty_stats, [], None,
                       "Pose tracking was too uncertain to judge technique on this clip.")

    # Interpolate gaps so the series are continuous, then smooth (~0.25 s window).
    k = max(1, round(0.25 * eff_fps))
    S = np.empty((n, 33, 2))
    for j in range(33):
        for c in range(2):
            good = ~np.isnan(L[:, j, c])
            S[:, j, c] = _smooth(np.interp(t, t[good], L[good, j, c]), k)
    # Landmarks are normalized per axis (x/W, y/H); rescale to pixels so angles
    # and distances are geometrically true regardless of aspect ratio.
    S[:, :, 0] *= width
    S[:, :, 1] *= height
    VIS = np.where(np.isnan(L[:, :, 2]), 0.0, L[:, :, 2])

    mid_sh = (S[:, L_SH] + S[:, R_SH]) / 2
    mid_hip = (S[:, L_HIP] + S[:, R_HIP]) / 2
    mid_ank = (S[:, L_ANK] + S[:, R_ANK]) / 2
    torso = float(np.median(np.linalg.norm(mid_sh - mid_hip, axis=1)))
    if torso < 1e-3:
        return payload(False, "The swimmer is too small in frame to measure.", empty_stats,
                       [], None, "Move the camera closer and film again.")

    d = mid_sh - mid_hip
    body_angle = np.degrees(np.arctan2(np.abs(d[:, 1]), np.maximum(np.abs(d[:, 0]), 1e-9)))
    body_angle_med = float(np.median(body_angle))
    if body_angle_med > 40:
        note = (
            "The body sits nearly vertical in frame, so this does not look like a "
            "side-view freestyle clip. Film from the side of the pool, at water level."
        )
        return payload(False, note, empty_stats, [], None,
                       "Could not read freestyle technique from this camera angle.")

    findings = []

    def add(area, severity, t0, t1, title, detail, tip):
        findings.append({
            "t": round(float(t0), 2), "end": round(float(t1), 2), "area": area,
            "severity": severity, "title": title, "detail": detail, "tip": tip,
        })

    # Body: hips sagging below the shoulder-to-ankle line.
    v = mid_ank - mid_sh
    proj = ((mid_hip - mid_sh) * v).sum(axis=1) / np.maximum((v * v).sum(axis=1), 1e-9)
    line_y = mid_sh[:, 1] + v[:, 1] * proj
    sag = (mid_hip[:, 1] - line_y) / torso
    for t0, t1 in _runs(sag > 0.15, t, min_dur=1.0)[:2]:
        m = sag[(t >= t0) & (t <= t1)].max()
        add("body", "major", t0, t1, "Hips riding low",
            f"From {mmss(t0)} to {mmss(t1)} the hips sink about {int(m * 100)}% of torso "
            "length below the shoulder-to-ankle line, dragging the legs down.",
            "Press the chest down and look at the pool floor — when the head drops, the hips rise.")

    # Body: head lifted while the body is level.
    head_lift = (mid_sh[:, 1] - S[:, NOSE, 1]) / torso
    level = body_angle < 30
    for t0, t1 in _runs((head_lift > 0.5) & level, t, min_dur=0.8)[:1]:
        add("body", "minor", t0, t1, "Head held high",
            f"Around {mmss(t0)} the eyes look forward instead of down, which arches the "
            "back and pushes the hips deeper.",
            "Look at the bottom of the pool and let the water hold your head.")

    # Legs: knee bend, kick depth, kick count.
    kick_times = []
    amps = {}
    for side, hip_i, knee_i, ank_i in (("left", L_HIP, L_KNEE, L_ANK),
                                       ("right", R_HIP, R_KNEE, R_ANK)):
        knee_ang = _angle(S[:, hip_i], S[:, knee_i], S[:, ank_i])
        leg_vis = VIS[:, [knee_i, ank_i]].min(axis=1) >= 0.4
        for t0, t1 in _runs((knee_ang < 115) & leg_vis, t, min_dur=0.4)[:1]:
            lo = knee_ang[(t >= t0) & (t <= t1)].min()
            add("legs", "major", t0, t1, "Kicking from the knee",
                f"The {side} knee bends to {int(lo)}° near {mmss(t0)} — a bent-knee "
                "'bicycle' kick pushes water down instead of back.",
                "Kick from the hip with a long leg and pointed toes; small, fast beats.")

        rel = S[:, ank_i, 1] - mid_hip[:, 1]
        amp = float(np.percentile(rel, 95) - np.percentile(rel, 5)) / torso
        amps[side] = amp
        # Downbeats only — counting both extremes would double the kick count.
        kick_times += _peaks(rel, t, prominence=0.06 * torso, min_gap=0.25)

    amp_mean = (amps["left"] + amps["right"]) / 2
    t_mid = t[n // 2]
    if amp_mean > 0.7:
        add("legs", "minor", t_mid, t_mid, "Kick too deep",
            f"Feet travel about {int(amp_mean * 100)}% of torso length top to bottom — a "
            "wide kick adds drag.",
            "Keep the kick narrow, inside the shadow of your body.")
    elif amp_mean < 0.12:
        add("legs", "minor", t_mid, t_mid, "Legs trailing",
            f"Ankle movement is only about {int(amp_mean * 100)}% of torso length, so the "
            "legs add drag instead of drive.",
            "Add a steady kick with relaxed ankles, even a light 2-beat.")
    if max(amps.values()) > 0 and abs(amps["left"] - amps["right"]) / max(amps.values()) > 0.45:
        weak = "left" if amps["left"] < amps["right"] else "right"
        add("legs", "minor", t_mid, t_mid, "Uneven kick",
            f"The {weak} leg kicks much smaller than the other "
            f"({int(amps[weak] * 100)}% vs {int(max(amps.values()) * 100)}% of torso length).",
            "Try single-leg kick drills with a board to balance the legs.")

    # Arms: stroke cycles from wrist-above-shoulder (recovery) events.
    stroke_events = {}
    for side, sh_i, el_i, wr_i in (("left", L_SH, L_EL, L_WR), ("right", R_SH, R_EL, R_WR)):
        rel_y = (S[:, wr_i, 1] - S[:, sh_i, 1]) / torso
        recovery = rel_y < -0.1
        events = []
        for i in range(1, n):
            if recovery[i] and not recovery[i - 1] and (not events or t[i] - events[-1] >= 0.8):
                events.append(float(t[i]))
        stroke_events[side] = events

        elbow_ang = _angle(S[:, sh_i], S[:, el_i], S[:, wr_i])
        arm_vis = VIS[:, [sh_i, el_i, wr_i]].min(axis=1) >= 0.4
        pull = (rel_y > 0.15) & arm_vis

        # Straight-arm pull: elbow never bends while the hand is under the body.
        if pull.sum() >= 3 * eff_fps and float(np.percentile(elbow_ang[pull], 20)) > 155:
            t_worst = float(t[pull][int(np.argmax(elbow_ang[pull]))])
            add("arms", "minor", t_worst, t_worst, "Straight-arm pull",
                f"The {side} arm stays near {int(np.median(elbow_ang[pull]))}° through the "
                "pull — pressing down on the water instead of back.",
                "Bend the elbow early in the pull and push water toward your feet.")

        # Dropped elbow at the catch: elbow sits lower than the wrist as the pull starts.
        catch = (rel_y > 0.05) & (rel_y < 0.4) & arm_vis
        dropped = catch & (S[:, el_i, 1] > S[:, wr_i, 1] + 0.03)
        for t0, t1 in _runs(dropped, t, min_dur=0.3)[:1]:
            add("arms", "major", t0, t1, "Elbow drops at the catch",
                f"Near {mmss(t0)} the {side} elbow slips below the wrist as the pull "
                "begins, letting the arm slide through the water.",
                "Reach long, then tip the fingertips down and keep the elbow high.")

    all_strokes = sorted(stroke_events["left"] + stroke_events["right"])
    stroke_rate = None
    if len(all_strokes) >= 3 and duration > 5:
        stroke_rate = 60.0 * len(all_strokes) / duration

    cyc = {s: float(np.median(np.diff(e))) if len(e) >= 3 else None
           for s, e in stroke_events.items()}
    if cyc["left"] and cyc["right"]:
        diff = abs(cyc["left"] - cyc["right"]) / ((cyc["left"] + cyc["right"]) / 2)
        if diff > 0.25:
            slow = "left" if cyc["left"] > cyc["right"] else "right"
            add("arms", "minor", stroke_events[slow][0], stroke_events[slow][0],
                "Uneven stroke rhythm",
                f"Left and right stroke cycles differ by {int(diff * 100)}% — often a sign "
                "of a pause on the breathing side.",
                "Count a steady rhythm, or breathe to both sides to even out the pull.")

    kicks_per_stroke = None
    if len(kick_times) >= 4 and len(all_strokes) >= 2:
        kicks_per_stroke = len(kick_times) / len(all_strokes)

    findings.sort(key=lambda f: (0 if f["severity"] == "major" else 1, f["t"]))
    findings = findings[:8]
    findings.sort(key=lambda f: f["t"])

    # Scores: start from 96 per area, subtract fixed weights per finding. Deterministic.
    deduction = {"arms": 0, "legs": 0, "body": 0}
    for f in findings:
        deduction[f["area"]] += 18 if f["severity"] == "major" else 8
    scores = {a: int(np.clip(96 - d, 30, 96)) for a, d in deduction.items()}
    scores["overall"] = round(0.4 * scores["arms"] + 0.3 * scores["legs"] + 0.3 * scores["body"])

    stats = {
        "strokeRateSpm": round(stroke_rate, 1) if stroke_rate else None,
        "kicksPerStroke": round(kicks_per_stroke, 1) if kicks_per_stroke else None,
        "bodyAngleDeg": round(body_angle_med, 1),
    }

    if findings:
        top = sorted(findings, key=lambda f: 0 if f["severity"] == "major" else 1)
        first = top[0]
        summary = f"Biggest gain: {first['title'].lower()} — {first['tip']}"
        if len(top) > 1:
            summary += f" Next, work on {top[1]['title'].lower()} at {mmss(top[1]['t'])}."
        if stroke_rate:
            summary += f" You held about {round(stroke_rate)} strokes per minute."
    else:
        summary = (
            f"Clean freestyle on this clip: body line about {round(body_angle_med)}° off "
            "level and no faults crossed our thresholds."
        )
        if stroke_rate:
            summary += f" Stroke rate was about {round(stroke_rate)} per minute."

    note = " ".join(note_parts) if note_parts else None
    return payload(True, note, stats, findings, scores, summary)
