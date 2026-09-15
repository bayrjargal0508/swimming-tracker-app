import Constants from 'expo-constants';

/** One pose frame: time in seconds + 33 MediaPipe landmarks as [x, y, visibility], normalized to the video frame. */
export type Landmark = [number, number, number];
export type PoseFrame = { t: number; lm: Landmark[] | null };

export type Area = 'arms' | 'legs' | 'body';

export type Finding = {
  t: number;
  end: number;
  area: Area;
  severity: 'major' | 'minor';
  title: string;
  detail: string;
  tip: string;
};

export type Analysis = {
  video: { duration: number; width: number; height: number };
  sampling: { fps: number };
  confidence: {
    detectedRatio: number;
    meanVisibility: number;
    reliable: boolean;
    note: string | null;
  };
  stats: {
    strokeRateSpm: number | null;
    kicksPerStroke: number | null;
    bodyAngleDeg: number | null;
  };
  frames: PoseFrame[];
  findings: Finding[];
  scores: { arms: number; legs: number; body: number; overall: number } | null;
  summary: string;
};

export class ApiError extends Error {
  aborted: boolean;
  constructor(message: string, aborted = false) {
    super(message);
    this.aborted = aborted;
  }
}

export function apiBase(): string {
  let env = process.env.EXPO_PUBLIC_API_URL;
  if (env) {
    while (env.endsWith('/')) env = env.slice(0, -1);
    return env;
  }
  // In dev, assume the backend runs on the same machine as the Metro server.
  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  const host = hostUri?.split(':')[0];
  return host ? `http://${host}:8000` : 'http://localhost:8000';
}

export type NativeFile = { uri: string; name: string; type: string };

/** Upload a video for analysis. XHR instead of fetch so we get real upload progress. */
export function uploadForAnalysis(
  file: NativeFile | File,
  onProgress: (fraction: number) => void,
): { promise: Promise<Analysis>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Analysis>((resolve, reject) => {
    const form = new FormData();
    if (typeof File !== 'undefined' && file instanceof File) {
      form.append('video', file);
    } else {
      form.append('video', file as unknown as Blob);
    }
    xhr.open('POST', `${apiBase()}/analyze`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON error body; fall through
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        resolve(body as Analysis);
      } else {
        const detail =
          body && typeof body === 'object' && 'detail' in body
            ? String((body as { detail: unknown }).detail)
            : `The analysis server returned an error (${xhr.status}).`;
        reject(new ApiError(detail));
      }
    };
    xhr.onerror = () =>
      reject(
        new ApiError(
          `Can't reach the analysis server at ${apiBase()}. Start the backend there, then try again.`,
        ),
      );
    xhr.ontimeout = () =>
      reject(new ApiError('The analysis took too long and timed out.'));
    xhr.onabort = () => reject(new ApiError('Upload canceled.', true));
    xhr.timeout = 10 * 60 * 1000;
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
