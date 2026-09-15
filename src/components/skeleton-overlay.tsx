import { memo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

import type { Area, PoseFrame } from '@/lib/api';

// MediaPipe pose landmark indices, grouped by body area so faults can light up.
const SEGMENTS: { area: Area; pairs: [number, number][] }[] = [
  {
    area: 'arms',
    pairs: [
      [11, 13],
      [13, 15],
      [12, 14],
      [14, 16],
    ],
  },
  {
    area: 'body',
    pairs: [
      [11, 12],
      [23, 24],
      [11, 23],
      [12, 24],
      [7, 0],
      [0, 8],
    ],
  },
  {
    area: 'legs',
    pairs: [
      [23, 25],
      [25, 27],
      [24, 26],
      [26, 28],
      [27, 31],
      [28, 32],
    ],
  },
];

const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const MIN_VISIBILITY = 0.4;
const WATER = 'rgba(59,197,229,0.92)';
const ROPE = '#EF5B4C';

type Props = {
  frames: PoseFrame[];
  sampleFps: number;
  time: number;
  box: { w: number; h: number };
  video: { width: number; height: number };
  hotAreas: ReadonlySet<Area>;
};

function SkeletonOverlayInner({ frames, sampleFps, time, box, video, hotAreas }: Props) {
  // Past the analyzed range (long videos are truncated server-side): draw nothing.
  const last = frames[frames.length - 1];
  if (!last || time > last.t + 1.5 / sampleFps) return null;
  const idx = Math.min(frames.length - 1, Math.max(0, Math.round(time * sampleFps)));
  const lm = frames[idx]?.lm;
  if (!lm || box.w <= 0 || box.h <= 0 || video.width <= 0 || video.height <= 0) {
    return null;
  }

  // Map normalized landmark coords onto the letterboxed (contentFit="contain") video rect.
  const scale = Math.min(box.w / video.width, box.h / video.height);
  const dispW = video.width * scale;
  const dispH = video.height * scale;
  const offX = (box.w - dispW) / 2;
  const offY = (box.h - dispH) / 2;
  const px = (i: number) => offX + lm[i][0] * dispW;
  const py = (i: number) => offY + lm[i][1] * dispH;
  const visible = (i: number) => lm[i] && lm[i][2] >= MIN_VISIBILITY;

  return (
    <View pointerEvents="none" className="absolute inset-0">
      <Svg width={box.w} height={box.h}>
        {SEGMENTS.map(({ area, pairs }) => {
          const color = hotAreas.has(area) ? ROPE : WATER;
          return pairs.map(([a, b]) =>
            visible(a) && visible(b) ? (
              <Line
                key={`${a}-${b}`}
                x1={px(a)}
                y1={py(a)}
                x2={px(b)}
                y2={py(b)}
                stroke={color}
                strokeWidth={2.5}
                strokeLinecap="round"
              />
            ) : null,
          );
        })}
        {JOINTS.map((i) =>
          visible(i) ? (
            <Circle key={i} cx={px(i)} cy={py(i)} r={3.2} fill="#EDF6F9" opacity={0.9} />
          ) : null,
        )}
      </Svg>
    </View>
  );
}

export const SkeletonOverlay = memo(SkeletonOverlayInner);
