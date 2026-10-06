import { z } from "zod";
import { IMAGE_OPERATIONS, seedSchema, sizeForRatio } from "./common.js";

export const IMAGE_RATIOS = ["1:1", "9:16", "16:9", "4:5", "3:2", "2:3", "4:3", "3:4", "21:9"] as const;
export type ImageRatio = (typeof IMAGE_RATIOS)[number];

/** Long-edge size presets */
export const IMAGE_RESOLUTIONS = { "1K": 1024, "1.5K": 1536, "2K": 2048 } as const;
export type ImageResolution = keyof typeof IMAGE_RESOLUTIONS;

export const IMAGE_FORMATS = ["png", "jpeg", "webp"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export const IMAGE_QUALITIES = ["draft", "standard", "high"] as const;

export const REFERENCE_TYPES = ["general", "style", "character", "face"] as const;

export const VARIATION_LEVELS = ["subtle", "medium", "strong"] as const;
export type VariationLevel = (typeof VARIATION_LEVELS)[number];
export const VARIATION_STRENGTH: Record<VariationLevel, number> = { subtle: 0.25, medium: 0.5, strong: 0.8 };

export const referenceSchema = z.object({
  mediaId: z.string().uuid(),
  type: z.enum(REFERENCE_TYPES).default("general"),
  weight: z.number().min(0).max(1).default(0.6),
});

export const imageParamsSchema = z.object({
  operation: z.enum(IMAGE_OPERATIONS),
  prompt: z.string().trim().max(4000).default(""),
  negativePrompt: z.string().trim().max(2000).default(""),
  /** "auto", an engine family ("flux") or an exact provider id */
  model: z.string().min(1).default("auto"),
  aspectRatio: z.enum(IMAGE_RATIOS).default("1:1"),
  resolution: z.enum(Object.keys(IMAGE_RESOLUTIONS) as [ImageResolution, ...ImageResolution[]]).default("1K"),
  /** Custom size (only when the engine supports custom_size); overrides ratio/resolution */
  width: z.number().int().min(256).max(4096).nullable().default(null),
  height: z.number().int().min(256).max(4096).nullable().default(null),
  seed: seedSchema,
  numOutputs: z.number().int().min(1).max(4).default(1),
  /** Guidance scale (CFG) = prompt adherence */
  guidance: z.number().min(1).max(20).default(5),
  steps: z.number().int().min(1).max(100).nullable().default(null),
  quality: z.enum(IMAGE_QUALITIES).default("standard"),
  outputFormat: z.enum(IMAGE_FORMATS).default("png"),

  /** image_to_image, edit, inpaint, outpaint, upscale, variation */
  sourceMediaId: z.string().uuid().nullable().default(null),
  /** 0 = keep the source, 1 = ignore it */
  strength: z.number().min(0).max(1).default(0.55),
  preserveComposition: z.boolean().default(true),
  /** edit: natural language instruction */
  instruction: z.string().trim().max(2000).default(""),
  /** inpaint: PNG mask, white = area to regenerate */
  maskMediaId: z.string().uuid().nullable().default(null),
  /** outpaint: pixels to add on each side, or a target ratio */
  outpaint: z
    .object({
      top: z.number().int().min(0).max(4096).default(0),
      bottom: z.number().int().min(0).max(4096).default(0),
      left: z.number().int().min(0).max(4096).default(0),
      right: z.number().int().min(0).max(4096).default(0),
      targetRatio: z.enum(IMAGE_RATIOS).nullable().default(null),
    })
    .default({ top: 0, bottom: 0, left: 0, right: 0, targetRatio: null }),
  upscale: z
    .object({
      factor: z.union([z.literal(2), z.literal(4)]).default(2),
      targetWidth: z.number().int().min(256).max(8192).nullable().default(null),
      enhanceDetails: z.boolean().default(true),
    })
    .default({ factor: 2, targetWidth: null, enhanceDetails: true }),
  variationLevel: z.enum(VARIATION_LEVELS).default("medium"),
  references: z.array(referenceSchema).max(4).default([]),
});
export type ImageParams = z.infer<typeof imageParamsSchema>;
export type ImageParamsInput = z.input<typeof imageParamsSchema>;

export function imageSize(p: Pick<ImageParams, "aspectRatio" | "resolution" | "width" | "height">) {
  if (p.width && p.height) return { width: p.width, height: p.height };
  return sizeForRatio(p.aspectRatio, IMAGE_RESOLUTIONS[p.resolution], "long");
}

export function missingImageInputs(p: ImageParams): string[] {
  const m: string[] = [];
  const needsSource = p.operation !== "text_to_image";
  if (needsSource && !p.sourceMediaId) m.push("image source");
  if (p.operation === "text_to_image" && !p.prompt) m.push("prompt");
  if (p.operation === "edit" && !p.instruction && !p.prompt) m.push("instruction");
  if (p.operation === "inpaint" && !p.maskMediaId) m.push("masque");
  if (p.operation === "outpaint") {
    const o = p.outpaint;
    if (!o.targetRatio && o.top + o.bottom + o.left + o.right === 0) m.push("zone à étendre");
  }
  return m;
}
