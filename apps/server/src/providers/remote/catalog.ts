import type {
  ImageCapability,
  ImageOperation,
  Module,
  VideoCapability,
  VideoOperation,
} from "@nx/shared";
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
    description:
      "Alibaba Qwen-Image 20B (Apache-2.0). Très fidèle au prompt, excellent rendu du texte (affiches).",
    capabilities: [
      "text_to_image",
      "image_to_image",
      "variation",
      "negative_prompt",
      "seed",
      "guidance",
      "steps",
      "custom_size",
      "multi_output",
    ],
    limits: { maxOutputs: 4 },
    quality: { text_to_image: 88, image_to_image: 78, variation: 78 },
  },
  "qwen-image-edit": {
    module: "image",
    name: "Qwen-Image-Edit 2511",
    description:
      "Édition en langage naturel (Apache-2.0) : texte, décor, tenue, objets ; garde le personnage et le reste de l'image.",
    capabilities: [
      "edit",
      "inpaint",
      "outpaint",
      "seed",
      "guidance",
      "steps",
      "reference_image",
      "multi_reference",
      "character_reference",
    ],
    limits: { maxOutputs: 2 },
    quality: { edit: 92, inpaint: 85, outpaint: 80 },
  },
  flux: {
    module: "image",
    name: "FLUX.2 [klein] 4B",
    description:
      "Black Forest Labs FLUX.2 klein (Apache-2.0) : image en moins d'une seconde, édition et multi-références, ~13 Go VRAM.",
    capabilities: [
      "text_to_image",
      "image_to_image",
      "edit",
      "variation",
      "seed",
      "guidance",
      "steps",
      "custom_size",
      "multi_output",
      "reference_image",
      "multi_reference",
      "style_reference",
    ],
    limits: { maxOutputs: 4 },
    quality: { text_to_image: 90, image_to_image: 85, variation: 88, edit: 80 },
  },
  sdxl: {
    module: "image",
    name: "SDXL",
    description:
      "Stable Diffusion XL : léger (8–12 Go VRAM), énorme écosystème LoRA et inpainting.",
    capabilities: [
      "text_to_image",
      "image_to_image",
      "inpaint",
      "outpaint",
      "variation",
      "negative_prompt",
      "seed",
      "guidance",
      "steps",
      "custom_size",
      "multi_output",
    ],
    limits: { maxOutputs: 4 },
    quality: {
      text_to_image: 65,
      image_to_image: 68,
      inpaint: 72,
      outpaint: 68,
      variation: 68,
    },
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
  ltx: {
    module: "video",
    name: "LTX-2.5",
    description:
      "Lightricks LTX-2.5 22B : meilleur image→vidéo open-weights utilisable en Europe, jusqu'à 20 s, vidéo→vidéo, rapide (licence gratuite < 10 M$ de CA).",
    capabilities: [
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
    ],
    limits: {
      maxDuration: 20,
      durations: [5, 10, 15, 20],
      resolutions: ["480p", "720p", "1080p"],
    },
    quality: {
      text_to_video: 90,
      image_to_video: 92,
      video_to_video: 90,
      first_last_frame: 88,
      extend: 88,
    },
  },
  wan: {
    module: "video",
    name: "Wan 2.2 A14B",
    description:
      "Alibaba Wan 2.2 (Apache-2.0) : très fidèle à l'image source, clips de ~5 s (10 s via Extend).",
    capabilities: [
      "text_to_video",
      "image_to_video",
      "first_last_frame",
      "extend",
      "camera_control",
      "negative_prompt",
      "seed",
    ],
    limits: { maxDuration: 5, durations: [5], resolutions: ["480p", "720p"] },
    quality: {
      text_to_video: 85,
      image_to_video: 90,
      first_last_frame: 86,
      extend: 84,
    },
  },
  hunyuan: {
    module: "video",
    name: "HunyuanVideo 1.5",
    description:
      "Tencent HunyuanVideo 1.5 8,3B. Attention : sa licence exclut l'UE, le Royaume-Uni et la Corée du Sud.",
    capabilities: [
      "text_to_video",
      "image_to_video",
      "negative_prompt",
      "seed",
    ],
    limits: { maxDuration: 5, durations: [5], resolutions: ["480p", "720p"] },
    quality: { text_to_video: 84, image_to_video: 82 },
  },
};
