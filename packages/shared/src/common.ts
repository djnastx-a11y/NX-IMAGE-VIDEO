import { z } from "zod";

export const MODULES = ["image", "video"] as const;
export type Module = (typeof MODULES)[number];

export const IMAGE_OPERATIONS = [
  "text_to_image",
  "image_to_image",
  "edit",
  "inpaint",
  "outpaint",
  "upscale",
  "variation",
] as const;
export type ImageOperation = (typeof IMAGE_OPERATIONS)[number];

export const VIDEO_OPERATIONS = ["text_to_video", "image_to_video", "video_to_video", "first_last_frame", "extend"] as const;
export type VideoOperation = (typeof VIDEO_OPERATIONS)[number];

export type Operation = ImageOperation | VideoOperation;

export const JOB_STATUSES = ["queued", "starting", "processing", "encoding", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const ACTIVE_STATUSES: readonly JobStatus[] = ["queued", "starting", "processing", "encoding"];
export const RUNNING_STATUSES: readonly JobStatus[] = ["starting", "processing", "encoding"];
export const TERMINAL_STATUSES: readonly JobStatus[] = ["completed", "failed", "cancelled"];

export const JOB_KINDS = ["generate", "regenerate", "variation", "duplicate", "extend", "animate"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const ROLES = ["admin", "user"] as const;
export type Role = (typeof ROLES)[number];

/** Capabilities a provider can declare. The UI only shows the controls a selected model supports. */
export const IMAGE_CAPABILITIES = [
  "text_to_image",
  "image_to_image",
  "edit",
  "inpaint",
  "outpaint",
  "upscale",
  "variation",
  "negative_prompt",
  "seed",
  "guidance",
  "steps",
  "custom_size",
  "multi_output",
  "reference_image",
  "multi_reference",
  "style_reference",
  "character_reference",
  "face_reference",
] as const;
export type ImageCapability = (typeof IMAGE_CAPABILITIES)[number];

export const VIDEO_CAPABILITIES = [
  "text_to_video",
  "image_to_video",
  "video_to_video",
  "first_last_frame",
  "keyframes",
  "extend",
  "camera_control",
  "negative_prompt",
  "seed",
  "fps",
  "reference_image",
  "subject_motion",
  "face_preservation",
] as const;
export type VideoCapability = (typeof VIDEO_CAPABILITIES)[number];

export const seedSchema = z.number().int().min(0).max(2_147_483_647).nullable().default(null);

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  starting: "Starting",
  processing: "Processing",
  encoding: "Encoding",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const OPERATION_LABEL: Record<Operation, string> = {
  text_to_image: "Text to Image",
  image_to_image: "Image to Image",
  edit: "Édition",
  inpaint: "Inpainting",
  outpaint: "Outpainting",
  upscale: "Upscale",
  variation: "Variation",
  text_to_video: "Text to Video",
  image_to_video: "Image to Video",
  video_to_video: "Video to Video",
  first_last_frame: "First / Last Frame",
  extend: "Extend",
};

export function moduleOf(op: Operation): Module {
  return (IMAGE_OPERATIONS as readonly string[]).includes(op) ? "image" : "video";
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Pixel size for a ratio "w:h" where the given edge (short or long) has `edge` pixels. */
export function sizeForRatio(ratio: string, edge: number, which: "short" | "long"): { width: number; height: number } {
  const [rw, rh] = ratio.split(":").map(Number) as [number, number];
  const landscape = rw >= rh;
  const big = Math.max(rw, rh);
  const small = Math.min(rw, rh);
  const shortPx = which === "short" ? edge : (edge * small) / big;
  const longPx = which === "long" ? edge : (edge * big) / small;
  return landscape ? { width: even(longPx), height: even(shortPx) } : { width: even(shortPx), height: even(longPx) };
}
