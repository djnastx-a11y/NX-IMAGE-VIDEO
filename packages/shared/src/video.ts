import { z } from "zod";
import { seedSchema, sizeForRatio, VIDEO_OPERATIONS } from "./common.js";

export const VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export type VideoRatio = (typeof VIDEO_RATIOS)[number];

export const VIDEO_RESOLUTIONS = { "480p": 480, "720p": 720, "1080p": 1080 } as const;
export type VideoResolution = keyof typeof VIDEO_RESOLUTIONS;

export const VIDEO_DURATIONS = [5, 10, 15] as const;
export const VIDEO_QUALITIES = ["fast", "standard", "high"] as const;

export const CAMERA_MOVES = [
  "static",
  "zoom_in",
  "zoom_out",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "dolly_in",
  "dolly_out",
  "orbit_left",
  "orbit_right",
  "tracking",
  "drone",
  "crane",
  "handheld",
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export const CAMERA_LABEL: Record<CameraMove, string> = {
  static: "Static",
  zoom_in: "Zoom In",
  zoom_out: "Zoom Out",
  pan_left: "Pan Left",
  pan_right: "Pan Right",
  tilt_up: "Tilt Up",
  tilt_down: "Tilt Down",
  dolly_in: "Dolly In",
  dolly_out: "Dolly Out",
  orbit_left: "Orbit Left",
  orbit_right: "Orbit Right",
  tracking: "Tracking Shot",
  drone: "Drone",
  crane: "Crane",
  handheld: "Handheld",
};

export const keyframeSchema = z.object({
  mediaId: z.string().uuid(),
  /** 0..1 position in the clip. first/last frame = 0 and 1. More keyframes later. */
  position: z.number().min(0).max(1),
});

export const videoParamsSchema = z.object({
  operation: z.enum(VIDEO_OPERATIONS),
  prompt: z.string().trim().max(4000).default(""),
  negativePrompt: z.string().trim().max(2000).default(""),
  model: z.string().min(1).default("auto"),
  duration: z.number().int().min(1).max(60).default(5),
  fps: z.number().int().min(8).max(60).default(24),
  aspectRatio: z.enum(VIDEO_RATIOS).default("16:9"),
  resolution: z.enum(Object.keys(VIDEO_RESOLUTIONS) as [VideoResolution, ...VideoResolution[]]).default("720p"),
  seed: seedSchema,
  quality: z.enum(VIDEO_QUALITIES).default("standard"),
  /** 0..1 global amount of motion */
  motionStrength: z.number().min(0).max(1).default(0.5),
  /** 0..1 motion of the subject itself (vs camera) */
  subjectMotion: z.number().min(0).max(1).default(0.5),
  /** 0..1 freedom taken from the prompt/source */
  creativity: z.number().min(0).max(1).default(0.5),
  /** guidance scale */
  promptAdherence: z.number().min(1).max(20).default(7),
  camera: z
    .object({ move: z.enum(CAMERA_MOVES).default("static"), intensity: z.number().min(0).max(10).default(5) })
    .default({ move: "static", intensity: 5 }),

  /** image_to_video: source image. first_last_frame: keyframes */
  sourceImageId: z.string().uuid().nullable().default(null),
  /** 0..1 how strictly the source image must be preserved */
  sourceFidelity: z.number().min(0).max(1).default(0.7),
  keyframes: z.array(keyframeSchema).max(8).default([]),
  referenceImageId: z.string().uuid().nullable().default(null),

  /** video_to_video */
  sourceVideoId: z.string().uuid().nullable().default(null),
  videoStrength: z.number().min(0).max(1).default(0.6),
  preserve: z
    .object({
      motion: z.boolean().default(true),
      composition: z.boolean().default(true),
      structure: z.boolean().default(true),
      character: z.boolean().default(false),
      face: z.boolean().default(false),
    })
    .default({ motion: true, composition: true, structure: true, character: false, face: false }),

  /** extend: the generated video (media id) being continued; duration = seconds added */
  extendMediaId: z.string().uuid().nullable().default(null),
});
export type VideoParams = z.infer<typeof videoParamsSchema>;
export type VideoParamsInput = z.input<typeof videoParamsSchema>;

export function videoSize(p: Pick<VideoParams, "aspectRatio" | "resolution">) {
  return sizeForRatio(p.aspectRatio, VIDEO_RESOLUTIONS[p.resolution], "short");
}

export function firstLastFrames(p: VideoParams): { first?: string; last?: string } {
  const sorted = [...p.keyframes].sort((a, b) => a.position - b.position);
  return { first: sorted[0]?.mediaId, last: sorted.length > 1 ? sorted[sorted.length - 1]!.mediaId : undefined };
}

export function missingVideoInputs(p: VideoParams): string[] {
  const m: string[] = [];
  if (p.operation === "text_to_video" && !p.prompt) m.push("prompt");
  if (p.operation === "image_to_video" && !p.sourceImageId) m.push("image source");
  if (p.operation === "first_last_frame") {
    const { first, last } = firstLastFrames(p);
    if (!first) m.push("première image");
    if (!last) m.push("dernière image");
  }
  if (p.operation === "video_to_video" && !p.sourceVideoId) m.push("vidéo source");
  if (p.operation === "extend" && !p.extendMediaId) m.push("vidéo à prolonger");
  return m;
}
