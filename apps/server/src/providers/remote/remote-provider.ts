import {
  imageSize,
  parseEditInstruction,
  videoSize,
  type ImageCapability,
  type ImageOperation,
  type ImageParams,
  type VideoCapability,
  type VideoOperation,
  type VideoParams,
} from "@nx/shared";
import type { GpuAgentConfig, GpuEndpointConfig } from "../../config.js";
import type {
  ImageInputs,
  ImageProvider,
  ProviderContext,
  ProviderLimits,
  ProviderOutput,
  VideoInputs,
  VideoProvider,
} from "../types.js";
import { ENGINE_CATALOG, type EngineSpec } from "./catalog.js";
import { GpuClient, type GpuTransport } from "./gpu-client.js";

abstract class RemoteBase<Cap extends string, Op extends string> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly backend: string;
  capabilities: ReadonlySet<Cap>;
  limits: ProviderLimits;
  readonly quality: Partial<Record<Op, number>>;

  constructor(
    protected readonly client: GpuTransport,
    readonly engine: string,
    spec: EngineSpec,
  ) {
    this.id = `${engine}@${client.id}`;
    this.name = spec.name;
    this.description = spec.description;
    this.backend = client.label;
    this.capabilities = new Set(spec.capabilities as Cap[]);
    this.limits = spec.limits;
    this.quality = spec.quality as Partial<Record<Op, number>>;
  }

  async health(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const h = await this.client.health();
      if (!h.ok)
        return { ok: false, reason: `${this.client.id}: GPU not ready` };
      const eng = h.engines?.find((e) => e.id === this.engine);
      if (!eng)
        return {
          ok: false,
          reason: `Engine "${this.engine}" not loaded on ${this.client.id}`,
        };
      if (eng.capabilities)
        this.capabilities = new Set(eng.capabilities as Cap[]);
      if (eng.limits)
        this.limits = { ...this.limits, ...(eng.limits as ProviderLimits) };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }
}

export class RemoteImageProvider
  extends RemoteBase<ImageCapability, ImageOperation>
  implements ImageProvider
{
  readonly module = "image" as const;

  private call(p: ImageParams, i: ImageInputs | null, ctx: ProviderContext) {
    const files: Record<string, string | undefined> = {
      source: i?.source,
      mask: i?.mask,
    };
    i?.references.forEach((r, n) => (files[`reference_${n}`] = r.path));
    const refs =
      i?.references.map((r, n) => ({
        field: `reference_${n}`,
        type: r.type,
        weight: r.weight,
      })) ?? [];
    // target = requested output size; intent = the parsed natural-language edit, so engines need no NLP of their own
    const extra = {
      target: imageSize(p),
      intent:
        p.operation === "edit"
          ? parseEditInstruction(p.instruction || p.prompt)
          : null,
    };
    return this.client.run(
      this.engine,
      p.operation,
      { ...p, references: refs, ...extra },
      files,
      ctx,
    );
  }

  generateTextToImage(p: ImageParams, ctx: ProviderContext) {
    return this.call(p, null, ctx);
  }
  generateImageToImage(p: ImageParams, i: ImageInputs, ctx: ProviderContext) {
    return this.call(p, i, ctx);
  }
  editImage(p: ImageParams, i: ImageInputs, ctx: ProviderContext) {
    return this.call(p, i, ctx);
  }
  inpaint(p: ImageParams, i: ImageInputs, ctx: ProviderContext) {
    return this.call(p, i, ctx);
  }
  outpaint(p: ImageParams, i: ImageInputs, ctx: ProviderContext) {
    return this.call(p, i, ctx);
  }
  upscale(p: ImageParams, i: ImageInputs, ctx: ProviderContext) {
    return this.call(p, i, ctx);
  }
  createVariation(p: ImageParams, i: ImageInputs, ctx: ProviderContext) {
    return this.call(p, i, ctx);
  }
}

export class RemoteVideoProvider
  extends RemoteBase<VideoCapability, VideoOperation>
  implements VideoProvider
{
  readonly module = "video" as const;

  private async call(
    p: VideoParams,
    i: VideoInputs | null,
    ctx: ProviderContext,
    operation: string = p.operation,
  ): Promise<ProviderOutput> {
    const files: Record<string, string | undefined> = {
      image: i?.image,
      end_image: i?.endImage,
      reference: i?.reference,
      video: i?.video,
    };
    i?.keyframes.forEach((k, n) => (files[`keyframe_${n}`] = k.path));
    const keyframes =
      i?.keyframes.map((k, n) => ({
        field: `keyframe_${n}`,
        position: k.position,
      })) ?? [];
    const [out] = await this.client.run(
      this.engine,
      operation,
      { ...p, keyframes, target: videoSize(p) },
      files,
      ctx,
    );
    return out!;
  }

  generateTextToVideo(p: VideoParams, ctx: ProviderContext) {
    return this.call(p, null, ctx);
  }
  generateImageToVideo(p: VideoParams, i: VideoInputs, ctx: ProviderContext) {
    return this.call(p, i, ctx);
  }
  generateVideoToVideo(p: VideoParams, i: VideoInputs, ctx: ProviderContext) {
    return this.call(p, i, ctx);
  }
  generateFirstLastFrame(p: VideoParams, i: VideoInputs, ctx: ProviderContext) {
    return this.call(p, i, ctx);
  }
  /** Continuation = image-to-video from the last frame; the worker appends it to the source. */
  extendVideo(p: VideoParams, i: VideoInputs, ctx: ProviderContext) {
    return this.call(
      { ...p, operation: "image_to_video" },
      { ...i, image: i.extendLastFrame },
      ctx,
      "image_to_video",
    );
  }
}

/** Builds one provider per engine per configured GPU endpoint. */
/** Providers for GPU agents (pull mode): their engines are declared in the config, health comes from heartbeats. */
export function agentProviders(
  agents: GpuAgentConfig[],
  transport: (a: GpuAgentConfig) => GpuTransport,
): (RemoteImageProvider | RemoteVideoProvider)[] {
  const out: (RemoteImageProvider | RemoteVideoProvider)[] = [];
  for (const a of agents) {
    const t = transport(a);
    for (const e of a.engines) {
      const spec = ENGINE_CATALOG[e];
      if (!spec)
        throw new Error(
          `NX_GPU_AGENTS "${a.id}": unknown engine "${e}" (known: ${Object.keys(ENGINE_CATALOG).join(", ")})`,
        );
      out.push(
        spec.module === "image"
          ? new RemoteImageProvider(t, e, spec)
          : new RemoteVideoProvider(t, e, spec),
      );
    }
  }
  return out;
}

export async function discoverRemoteProviders(
  endpoints: GpuEndpointConfig[],
): Promise<(RemoteImageProvider | RemoteVideoProvider)[]> {
  const out: (RemoteImageProvider | RemoteVideoProvider)[] = [];
  for (const ep of endpoints) {
    const client = new GpuClient(ep);
    let engines = ep.engines;
    if (!engines?.length) {
      try {
        engines = (await client.health()).engines?.map((e) => e.id) ?? [];
      } catch {
        engines = []; // offline at boot and no explicit engine list: nothing to expose yet
      }
    }
    for (const e of engines) {
      const spec = ENGINE_CATALOG[e];
      if (!spec) continue;
      out.push(
        spec.module === "image"
          ? new RemoteImageProvider(client, e, spec)
          : new RemoteVideoProvider(client, e, spec),
      );
    }
  }
  return out;
}
