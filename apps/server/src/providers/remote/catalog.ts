import type { ImageCapability, ImageOperation, Module, VideoCapability, VideoOperation } from "@nx/shared";
import type { ProviderLimits } from "../types.js";

/**
 * What NX STUDIO knows about each open engine it can drive through a GPU endpoint.
 * A GPU endpoint may override capabilities/limits in its /v1/health answer.
 * Router scores are a starting point; see docs/MODELS.md for the comparison behind them.
 */
export interface EngineSpec {
  module: Module;
  name: string;
  description: string;
  capabilities: (ImageCapability | VideoCapability)[];
  limits: ProviderLimits;
  quality: Partial<Record<ImageOperation | VideoOperation, number>>;
}

export const ENGINE_CATALOG: Record<string, EngineSpec> = {
  // ------------------------------------------------------------------ image
  "qwen-image": {
    module: "image",
    name: "Qwen-Image",
    description: "Alibaba Qwen-Image (Apache-2.0). Excellent rendu du texte et fidélité au prompt.",
    capabilities: ["text_to_image", "image_to_image", "variation", "negative_prompt", "seed", "guidance", "steps", "custom_size", "multi_output"],
    limits: { maxOutputs: 4 },
    quality: { text_to_image: 90, image_to_image: 80, variation: 80 },
  },
  "qwen-image-edit": {
    module: "image",
    name: "Qwen-Image-Edit",
    description: "Édition par instruction en langage naturel (Apache-2.0), garde le reste de l'image.",
    capabilities: ["edit", "inpaint", "outpaint", "seed", "guidance", "steps", "reference_image", "multi_reference", "character_reference"],
    limits: { maxOutputs: 2 },
    quality: { edit: 92, inpaint: 80, outpaint: 75 },
  },
  flux: {
    module: "image",
    name: "FLUX.1",
    description: "Black Forest Labs FLUX.1 [dev] (licence non commerciale) — photoréalisme.",
    capabilities: ["text_to_image", "image_to_image", "inpaint", "outpaint", "variation", "seed", "guidance", "steps", "custom_size", "multi_output"],
    limits: { maxOutputs: 4 },
    quality: { text_to_image: 88, image_to_image: 85, inpaint: 88, outpaint: 85, variation: 85 },
  },
  "flux-kontext": {
    module: "image",
    name: "FLUX.1 Kontext",
    description: "Édition par instruction avec forte consistance de personnage (licence non commerciale).",
    capabilities: ["edit", "seed", "guidance", "steps", "reference_image", "character_reference", "style_reference"],
    limits: { maxOutputs: 2 },
    quality: { edit: 90 },
  },
  sdxl: {
    module: "image",
    name: "SDXL",
    description: "Stable Diffusion XL — léger (8–12 Go VRAM), énorme écosystème LoRA / inpainting.",
    capabilities: ["text_to_image", "image_to_image", "inpaint", "outpaint", "variation", "negative_prompt", "seed", "guidance", "steps", "custom_size", "multi_output"],
    limits: { maxOutputs: 4 },
    quality: { text_to_image: 70, image_to_image: 72, inpaint: 75, outpaint: 70, variation: 72 },
  },
  "real-esrgan": {
    module: "image",
    name: "Real-ESRGAN",
    description: "Upscale x2/x4 rapide (BSD-3).",
    capabilities: ["upscale"],
    limits: {},
    quality: { upscale: 85 },
  },
  // ------------------------------------------------------------------ video
  wan: {
    module: "video",
    name: "Wan 2.2",
    description: "Alibaba Wan 2.2 (Apache-2.0) — meilleure qualité de mouvement, image vers vidéo très fidèle.",
    capabilities: ["text_to_video", "image_to_video", "first_last_frame", "extend", "camera_control", "negative_prompt", "seed"],
    limits: { maxDuration: 10, durations: [5, 10], resolutions: ["480p", "720p"] },
    quality: { text_to_video: 90, image_to_video: 95, first_last_frame: 88, extend: 85 },
  },
  hunyuan: {
    module: "video",
    name: "HunyuanVideo",
    description: "Tencent HunyuanVideo — rendu cinématographique (licence communautaire Tencent).",
    capabilities: ["text_to_video", "image_to_video", "camera_control", "negative_prompt", "seed"],
    limits: { maxDuration: 10, durations: [5, 10], resolutions: ["480p", "720p"] },
    quality: { text_to_video: 88, image_to_video: 85 },
  },
  ltx: {
    module: "video",
    name: "LTX Video",
    description: "Lightricks LTX-Video — le plus rapide, keyframes et vidéo vers vidéo.",
    capabilities: ["text_to_video", "image_to_video", "video_to_video", "first_last_frame", "keyframes", "extend", "camera_control", "negative_prompt", "seed", "fps"],
    limits: { maxDuration: 15, durations: [5, 10, 15], resolutions: ["480p", "720p", "1080p"] },
    quality: { text_to_video: 75, image_to_video: 80, video_to_video: 90, first_last_frame: 90, extend: 88 },
  },
};
