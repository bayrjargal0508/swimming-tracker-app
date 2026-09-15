import { useEvent, useEventListener } from "expo";
import * as ImagePicker from "expo-image-picker";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SkeletonOverlay } from "@/components/skeleton-overlay";
import {
  Analysis,
  ApiError,
  Area,
  Finding,
  formatTime,
  NativeFile,
  uploadForAnalysis,
} from "@/lib/api";

type Stage = "empty" | "picked" | "uploading" | "analyzing" | "done";

type PickedVideo = {
  uri: string;
  name: string;
  type: string;
  width: number;
  height: number;
  durationS: number | null;
  webFile?: File;
};

const VIDEO_TYPES = ["video/mp4", "video/quicktime"];

function isSupported(name: string, mime: string | null | undefined): boolean {
  if (mime && VIDEO_TYPES.includes(mime)) return true;
  return /\.(mp4|mov)$/i.test(name);
}

// ── Lane rope: a row of beads, red at the ends like the 5 m marks ──

function LaneRope({ tight }: { tight?: boolean }) {
  const beads = tight ? 10 : 16;
  return (
    <View className="flex-row items-center justify-between px-1">
      {Array.from({ length: beads }, (_, i) => {
        const end = i < 2 || i >= beads - 2;
        return (
          <View
            key={i}
            className={`h-2.5 w-4 rounded-full ${end ? "bg-rope" : i % 2 ? "bg-tile/80" : "bg-water/70"}`}
          />
        );
      })}
    </View>
  );
}

function UploadHero({
  onPick,
  webDropReady,
}: {
  onPick: () => void;
  webDropReady: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Choose a swimming video from your gallery"
      onPress={onPick}
      className="overflow-hidden rounded-3xl bg-[#0C4A62] active:bg-[#0E5471]"
    >
      <View className="gap-7 px-6 py-9">
        <LaneRope />
        <View className="items-center gap-3">
          <View className="rounded-full bg-water px-7 py-3.5">
            <Text className="font-dispsemi text-lg text-deepend">
              Choose a video
            </Text>
          </View>
          <Text className="text-center font-body text-sm leading-5 text-tile/80">
            MP4 or MOV, filmed from the side of the pool{"\n"}with the whole
            body in frame
            {webDropReady ? "\nor drop a file anywhere on this page" : ""}
          </Text>
        </View>
        <LaneRope />
      </View>
    </Pressable>
  );
}

// ── Analysis progress rendered as a swimmer crossing the lane ──

function LaneProgress({
  stage,
  progress,
}: {
  stage: "uploading" | "analyzing";
  progress: number;
}) {
  const [reduceMotion, setReduceMotion] = useState(false);
  const shuttle = useRef(new Animated.Value(0)).current;
  const [trackW, setTrackW] = useState(0);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
  }, []);

  useEffect(() => {
    if (stage !== "analyzing" || reduceMotion || trackW === 0) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shuttle, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(shuttle, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [stage, reduceMotion, trackW, shuttle]);

  const label =
    stage === "uploading"
      ? `Sending video ${Math.round(progress * 100)}%`
      : "Tracking stroke, kick and body line";

  return (
    <View className="gap-3 rounded-2xl bg-wall px-5 py-5">
      <Text className="font-bodymed text-base text-tile">{label}</Text>
      <LaneRope tight />
      <View
        className="h-3 justify-center rounded-full bg-deepend"
        onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
      >
        {stage === "uploading" ? (
          <View
            className="h-3 rounded-full bg-water"
            style={{ width: `${Math.max(4, progress * 100)}%` }}
          />
        ) : reduceMotion || trackW === 0 ? (
          <View className="h-3 w-full rounded-full bg-water/40" />
        ) : (
          <Animated.View
            className="h-3 w-16 rounded-full bg-water"
            style={{
              transform: [
                {
                  translateX: shuttle.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, Math.max(0, trackW - 64)],
                  }),
                },
              ],
            }}
          />
        )}
      </View>
      <LaneRope tight />
    </View>
  );
}

function scoreColor(v: number) {
  return v >= 80 ? "text-water" : v >= 60 ? "text-buoy" : "text-rope";
}

function ScoreTiles({ scores }: { scores: NonNullable<Analysis["scores"]> }) {
  const side = [
    { label: "Arms", value: scores.arms },
    { label: "Legs", value: scores.legs },
    { label: "Body line", value: scores.body },
  ];
  return (
    <View className="gap-3">
      <View className="items-center rounded-2xl bg-wall py-5">
        <Text className={`font-disp text-6xl ${scoreColor(scores.overall)}`}>
          {scores.overall}
        </Text>
        <Text className="font-body text-sm text-mist">Overall technique</Text>
      </View>
      <View className="flex-row gap-3">
        {side.map((s) => (
          <View
            key={s.label}
            className="flex-1 items-center rounded-2xl bg-wall py-4"
          >
            <Text className={`font-disp text-3xl ${scoreColor(s.value)}`}>
              {s.value}
            </Text>
            <Text className="font-body text-xs text-mist">{s.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function FindingRow({
  finding,
  active,
  onSeek,
}: {
  finding: Finding;
  active: boolean;
  onSeek: (t: number) => void;
}) {
  return (
    <View
      className={`rounded-2xl px-4 py-4 ${active ? "bg-shallows" : "bg-wall"}`}
    >
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Jump to ${formatTime(finding.t)}`}
          onPress={() => onSeek(finding.t)}
          className="rounded-lg bg-deepend px-2.5 py-1.5 active:bg-water/20"
        >
          <Text className="font-dispsemi text-base text-water">
            {formatTime(finding.t)}
          </Text>
        </Pressable>
        <View
          className={`h-2.5 w-2.5 rounded-full ${finding.severity === "major" ? "bg-rope" : "bg-buoy"}`}
        />
        <Text className="flex-1 font-bodysemi text-base text-tile">
          {finding.title}
        </Text>
      </View>
      <Text className="mt-2 font-body text-sm leading-5 text-mist">
        {finding.detail}
      </Text>
      <Text className="mt-1.5 font-bodymed text-sm leading-5 text-water">
        {finding.tip}
      </Text>
    </View>
  );
}

export default function StrokeLab() {
  const { width: winW } = useWindowDimensions();
  const [stage, setStage] = useState<Stage>("empty");
  const [video, setVideo] = useState<PickedVideo | null>(null);
  const [progress, setProgress] = useState(0);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const player = useVideoPlayer(null, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.15;
  });
  const { isPlaying } = useEvent(player, "playingChange", {
    isPlaying: player.playing,
  });
  useEventListener(player, "timeUpdate", (e) => setTime(e.currentTime));

  useEffect(() => {
    player.replaceAsync(video ? { uri: video.uri } : null);
  }, [video?.uri]); // eslint-disable-line react-hooks/exhaustive-deps

  const setPicked = (v: PickedVideo) => {
    setVideo((prev) => {
      if (Platform.OS === "web" && prev?.webFile) URL.revokeObjectURL(prev.uri);
      return v;
    });
    setAnalysis(null);
    setError(null);
    setTime(0);
    setStage("picked");
  };

  const pick = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
    });
    if (res.canceled) return;
    const a = res.assets[0];
    const name = a.fileName ?? a.uri.split("/").pop() ?? "video.mp4";
    if (!isSupported(name, a.mimeType)) {
      setError("That file type is not supported. Choose an MP4 or MOV video.");
      return;
    }
    setPicked({
      uri: a.uri,
      name,
      type:
        a.mimeType ?? (/\.mov$/i.test(name) ? "video/quicktime" : "video/mp4"),
      width: a.width,
      height: a.height,
      durationS: a.duration != null ? a.duration / 1000 : null,
      webFile: a.file ?? undefined, // web-only: the real File, required for upload
    });
  };

  const stageRef = useRef(stage);
  stageRef.current = stage;

  // Drag-and-drop on web: drop a file anywhere on the page.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      if (stageRef.current === "uploading" || stageRef.current === "analyzing")
        return;
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!isSupported(file.name, file.type)) {
        setError(
          "That file type is not supported. Choose an MP4 or MOV video.",
        );
        return;
      }
      setPicked({
        uri: URL.createObjectURL(file),
        name: file.name,
        type: file.type || "video/mp4",
        width: 0,
        height: 0,
        durationS: null,
        webFile: file,
      });
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    document.addEventListener("drop", onDrop);
    document.addEventListener("dragover", onDragOver);
    return () => {
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("dragover", onDragOver);
    };
  }, []);

  const remove = () => {
    if (Platform.OS === "web" && video?.webFile) URL.revokeObjectURL(video.uri);
    setVideo(null);
    setAnalysis(null);
    setError(null);
    setStage("empty");
  };

  const analyze = async () => {
    if (!video) return;
    player.pause();
    setError(null);
    setProgress(0);
    setStage("uploading");
    const payload: NativeFile | File = video.webFile ?? {
      uri: video.uri,
      name: video.name,
      type: video.type,
    };
    const { promise, abort } = uploadForAnalysis(payload, (f) => {
      setProgress(f);
      if (f >= 1) setStage("analyzing");
    });
    abortRef.current = abort;
    try {
      const result = await promise;
      setAnalysis(result);
      setStage("done");
      player.currentTime = 0;
      setTime(0);
    } catch (e) {
      if (e instanceof ApiError && e.aborted) {
        setStage("picked");
      } else {
        setError(
          e instanceof Error
            ? e.message
            : "Something went wrong during analysis.",
        );
        setStage("picked");
      }
    } finally {
      abortRef.current = null;
    }
  };

  const cancel = () => abortRef.current?.();

  const seekTo = (t: number) => {
    player.currentTime = t;
    setTime(t);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  // Video box: fit width, letterbox inside a bounded height.
  const boxW = Math.min(winW - 32, 560);
  const videoDims =
    analysis && analysis.video.width > 0
      ? { width: analysis.video.width, height: analysis.video.height }
      : video && video.width > 0
        ? { width: video.width, height: video.height }
        : { width: 16, height: 9 };
  const boxH = Math.min(
    440,
    Math.max(200, (boxW * videoDims.height) / videoDims.width),
  );

  const durationS =
    analysis?.video.duration ?? video?.durationS ?? player.duration ?? 0;

  const hotAreas = useMemo(() => {
    const set = new Set<Area>();
    if (analysis && stage === "done") {
      for (const f of analysis.findings) {
        if (time >= f.t - 0.15 && time <= f.end + 0.15) set.add(f.area);
      }
    }
    return set;
  }, [analysis, stage, time]);

  const reliable = analysis?.confidence.reliable ?? false;
  const busy = stage === "uploading" || stage === "analyzing";

  return (
    <SafeAreaView className="flex-1 bg-deepend" edges={["top", "bottom"]}>
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerClassName="px-4 pb-12 pt-4"
      >
        <View className="w-full max-w-[560px] gap-4 self-center">
          <View className="gap-1 pb-2 pt-2">
            <Text className="font-disp text-4xl text-tile">AquaMotion</Text>
            <Text className="font-body text-base text-mist">
              Freestyle technique, checked from your own video
            </Text>
          </View>

          {error && (
            <View className="rounded-2xl border border-rope/40 bg-rope/15 px-4 py-3">
              <Text className="font-bodymed text-sm leading-5 text-tile">
                {error}
              </Text>
            </View>
          )}

          {stage === "empty" && (
            <UploadHero onPick={pick} webDropReady={Platform.OS === "web"} />
          )}

          {video && (
            <View className="overflow-hidden rounded-3xl bg-black">
              <View
                style={{ width: boxW, height: boxH }}
                className="self-center"
              >
                <VideoView
                  player={player}
                  style={{ width: boxW, height: boxH }}
                  contentFit="contain"
                  nativeControls={false}
                />
                {analysis && stage === "done" && (
                  <SkeletonOverlay
                    frames={analysis.frames}
                    sampleFps={analysis.sampling.fps}
                    time={time}
                    box={{ w: boxW, h: boxH }}
                    video={analysis.video}
                    hotAreas={hotAreas}
                  />
                )}
              </View>
              <View className="flex-row items-center gap-3 bg-wall px-4 py-3">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={isPlaying ? "Pause" : "Play"}
                  onPress={() => (isPlaying ? player.pause() : player.play())}
                  disabled={busy}
                  className="rounded-full bg-water px-5 py-2 active:opacity-80"
                >
                  <Text className="font-dispsemi text-base text-deepend">
                    {isPlaying ? "Pause" : "Play"}
                  </Text>
                </Pressable>
                <Text className="flex-1 font-bodymed text-sm text-mist">
                  {formatTime(time)} / {formatTime(durationS)}
                </Text>
                {!busy && (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      onPress={pick}
                      className="px-2 py-2"
                    >
                      <Text className="font-bodymed text-sm text-water">
                        Replace
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={remove}
                      className="px-2 py-2"
                    >
                      <Text className="font-bodymed text-sm text-rope">
                        Remove
                      </Text>
                    </Pressable>
                  </>
                )}
              </View>
            </View>
          )}

          {stage === "picked" && (
            <Pressable
              accessibilityRole="button"
              onPress={analyze}
              className="items-center rounded-2xl bg-water py-4 active:opacity-85"
            >
              <Text className="font-disp text-xl text-deepend">
                Analyze Video
              </Text>
            </Pressable>
          )}

          {busy && (
            <>
              <LaneProgress
                stage={stage as "uploading" | "analyzing"}
                progress={progress}
              />
              <Pressable
                accessibilityRole="button"
                onPress={cancel}
                className="items-center py-1"
              >
                <Text className="font-bodymed text-sm text-mist">Cancel</Text>
              </Pressable>
            </>
          )}

          {analysis && stage === "done" && (
            <View className="gap-4 pt-1">
              {!reliable && (
                <View className="rounded-2xl border border-buoy/40 bg-buoy/10 px-4 py-3">
                  <Text className="font-bodymed text-sm leading-5 text-tile">
                    {analysis.confidence.note ??
                      "Pose tracking was unreliable in this clip, so scores are withheld. Film from the side, above water, with the whole body in frame."}
                  </Text>
                </View>
              )}

              {reliable && analysis.confidence.note && (
                <Text className="font-body text-xs text-mist">
                  {analysis.confidence.note}
                </Text>
              )}

              {analysis.scores && <ScoreTiles scores={analysis.scores} />}

              <View className="rounded-2xl bg-wall px-4 py-4">
                <Text className="font-body text-sm leading-6 text-tile">
                  {analysis.summary}
                </Text>
              </View>

              {(analysis.stats.strokeRateSpm != null ||
                analysis.stats.kicksPerStroke != null ||
                analysis.stats.bodyAngleDeg != null) && (
                <View className="flex-row flex-wrap gap-2">
                  {analysis.stats.strokeRateSpm != null && (
                    <View className="rounded-full bg-wall px-4 py-2">
                      <Text className="font-bodymed text-xs text-mist">
                        Stroke rate{" "}
                        <Text className="font-dispsemi text-sm text-tile">
                          {Math.round(analysis.stats.strokeRateSpm)}
                        </Text>{" "}
                        per min
                      </Text>
                    </View>
                  )}
                  {analysis.stats.kicksPerStroke != null && (
                    <View className="rounded-full bg-wall px-4 py-2">
                      <Text className="font-bodymed text-xs text-mist">
                        Kicks per stroke{" "}
                        <Text className="font-dispsemi text-sm text-tile">
                          {analysis.stats.kicksPerStroke.toFixed(1)}
                        </Text>
                      </Text>
                    </View>
                  )}
                  {analysis.stats.bodyAngleDeg != null && (
                    <View className="rounded-full bg-wall px-4 py-2">
                      <Text className="font-bodymed text-xs text-mist">
                        Body line{" "}
                        <Text className="font-dispsemi text-sm text-tile">
                          {Math.round(analysis.stats.bodyAngleDeg)}°
                        </Text>{" "}
                        off level
                      </Text>
                    </View>
                  )}
                </View>
              )}

              {analysis.findings.length > 0 ? (
                <View className="gap-3">
                  <Text className="pt-1 font-dispsemi text-xl text-tile">
                    What to work on
                  </Text>
                  {analysis.findings.map((f, i) => (
                    <FindingRow
                      key={i}
                      finding={f}
                      active={time >= f.t - 0.15 && time <= f.end + 0.15}
                      onSeek={seekTo}
                    />
                  ))}
                </View>
              ) : (
                reliable && (
                  <View className="rounded-2xl bg-wall px-4 py-4">
                    <Text className="font-body text-sm leading-5 text-mist">
                      No faults flagged in this clip. Keep filming as your
                      stroke evolves — longer clips catch more.
                    </Text>
                  </View>
                )
              )}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
