import type {
  ImageCapability,
  ImageOperation,
  ImageParams,
  Module,
  ProviderInfo,
  VideoCapability,
  VideoOperation,
  VideoParams,
} from "@nx/shared";

export type ProviderStage = "starting" | "processing";

/** Runtime context handed to a provider for one job attempt. */
export interface ProviderContext {
  jobId: string;
  attempt: number;
  /** Scratch directory owned by this attempt (deleted afterwards) */
  workDir: string;
  /** Aborted when the user cancels or the worker shuts down */
  signal: AbortSignal;
  /** progress in [0,1] within the stage */
  report(stage: ProviderStage, progress: number, detail?: string): void;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface ProviderOutput {
  /** Raw file produced by the engine; the worker re-encodes it for delivery */
  path: string;
  seed: number | null;
}

/** Local files a job reads from (the worker resolves media ids into files before calling the provider). */
export interface ImageInputs {
  source?: string;
  mask?: string;
  references: { path: string; type: string; weight: number }[];
}

export interface VideoInputs {
  image?: string;
  endImage?: string;
  keyframes: { path: string; position: number }[];
  reference?: string;
  video?: string;
  /** extend: the video being continued and its last frame */
  extendSource?: string;
  extendLastFrame?: string;
}

export interface ProviderLimits {
  maxDuration?: number;
  durations?: number[];
  resolutions?: string[];
  ratios?: string[];
  maxOutputs?: number;
}

interface BaseProvider<Cap extends string, Op extends string> {
  readonly module: Module;
  /** Unique id, e.g. "mock-image", "wan@runpod-a100" */
  readonly id: string;
  /** Engine family, e.g. "mock", "wan", "flux" (users may pick a family instead of an exact provider) */
  readonly engine: string;
  readonly name: string;
  readonly description: string;
  /** Where it runs: "in-process (CPU)", a GPU endpoint id... */
  readonly backend: string;
  readonly capabilities: ReadonlySet<Cap>;
  readonly limits: ProviderLimits;
  /** Router score per operation; the highest available wins in "auto". Mocks score 1. */
  readonly quality: Partial<Record<Op, number>>;
  health(): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Image engine contract. Each method is optional and must match a declared capability.
 * (getJobStatus / cancelJob are handled by the queue: status lives in the DB and cancellation
 * flows through ctx.signal; remote engines map them onto their own API, see providers/remote.)
 */
export interface ImageProvider extends BaseProvider<ImageCapability, ImageOperation> {
  readonly module: "image";
  generateTextToImage?(p: ImageParams, ctx: ProviderContext): Promise<ProviderOutput[]>;
  generateImageToImage?(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]>;
  editImage?(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]>;
  inpaint?(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]>;
  outpaint?(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]>;
  upscale?(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]>;
  createVariation?(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]>;
}

export interface VideoProvider extends BaseProvider<VideoCapability, VideoOperation> {
  readonly module: "video";
  generateTextToVideo?(p: VideoParams, ctx: ProviderContext): Promise<ProviderOutput>;
  generateImageToVideo?(p: VideoParams, inputs: VideoInputs, ctx: ProviderContext): Promise<ProviderOutput>;
  generateVideoToVideo?(p: VideoParams, inputs: VideoInputs, ctx: ProviderContext): Promise<ProviderOutput>;
  generateFirstLastFrame?(p: VideoParams, inputs: VideoInputs, ctx: ProviderContext): Promise<ProviderOutput>;
  /** Returns only the continuation; the worker concatenates it after the source video. */
  extendVideo?(p: VideoParams, inputs: VideoInputs, ctx: ProviderContext): Promise<ProviderOutput>;
}

export type AnyProvider = ImageProvider | VideoProvider;

const IMAGE_METHOD: Record<ImageOperation, keyof ImageProvider> = {
  text_to_image: "generateTextToImage",
  image_to_image: "generateImageToImage",
  edit: "editImage",
  inpaint: "inpaint",
  outpaint: "outpaint",
  upscale: "upscale",
  variation: "createVariation",
};

const VIDEO_METHOD: Record<VideoOperation, keyof VideoProvider> = {
  text_to_video: "generateTextToVideo",
  image_to_video: "generateImageToVideo",
  video_to_video: "generateVideoToVideo",
  first_last_frame: "generateFirstLastFrame",
  extend: "extendVideo",
};

export function supportsOperation(p: AnyProvider, op: ImageOperation | VideoOperation): boolean {
  if (p.module === "image") {
    const m = IMAGE_METHOD[op as ImageOperation];
    return !!m && typeof p[m] === "function" && (p.capabilities as ReadonlySet<string>).has(op);
  }
  const m = VIDEO_METHOD[op as VideoOperation];
  return !!m && typeof p[m] === "function" && (p.capabilities as ReadonlySet<string>).has(op);
}

export async function runImage(p: ImageProvider, params: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]> {
  switch (params.operation) {
    case "text_to_image":
      return p.generateTextToImage!(params, ctx);
    case "image_to_image":
      return p.generateImageToImage!(params, inputs, ctx);
    case "edit":
      return p.editImage!(params, inputs, ctx);
    case "inpaint":
      return p.inpaint!(params, inputs, ctx);
    case "outpaint":
      return p.outpaint!(params, inputs, ctx);
    case "upscale":
      return p.upscale!(params, inputs, ctx);
    case "variation":
      return p.createVariation!(params, inputs, ctx);
  }
}

export async function runVideo(p: VideoProvider, params: VideoParams, inputs: VideoInputs, ctx: ProviderContext): Promise<ProviderOutput> {
  switch (params.operation) {
    case "text_to_video":
      return p.generateTextToVideo!(params, ctx);
    case "image_to_video":
      return p.generateImageToVideo!(params, inputs, ctx);
    case "video_to_video":
      return p.generateVideoToVideo!(params, inputs, ctx);
    case "first_last_frame":
      return p.generateFirstLastFrame!(params, inputs, ctx);
    case "extend":
      return p.extendVideo!(params, inputs, ctx);
  }
}

export function providerInfo(
  p: AnyProvider,
  health: { ok: boolean; reason?: string },
  settings: { enabled: boolean; isDefault: boolean },
): ProviderInfo {
  return {
    id: p.id,
    module: p.module,
    name: p.name,
    engine: p.engine,
    description: p.description,
    backend: p.backend,
    enabled: settings.enabled,
    isDefault: settings.isDefault,
    available: settings.enabled && health.ok,
    unavailableReason: !settings.enabled ? "Désactivé par l'administrateur" : health.ok ? null : health.reason ?? "Indisponible",
    capabilities: [...p.capabilities] as ProviderInfo["capabilities"],
    limits: p.limits,
  };
}
