import path from "node:path";
import {
  imageSize,
  OPERATION_LABEL,
  parseEditInstruction,
  VARIATION_STRENGTH,
  type ImageCapability,
  type ImageParams,
} from "@nx/shared";
import { ffmpeg, probe } from "../../media/ffmpeg.js";
import type { ImageInputs, ImageProvider, ProviderContext, ProviderOutput } from "../types.js";
import { hashString, labelFilter, mulberry32, paced, palette, testHooks, throwHook, wrap } from "./common.js";

const MAX_EDGE = 8192;

/**
 * MockImageProvider: produces real PNG files with ffmpeg for every NX IMAGE operation, honouring
 * size, ratio, seed, strength, masks, outpaint margins, upscale factor... so the whole product
 * (queue, progress, history, library, downloads) can be tested without any GPU.
 * Outputs are clearly labelled "MOCK".
 */
export class MockImageProvider implements ImageProvider {
  readonly module = "image" as const;
  readonly id = "mock-image";
  readonly engine = "mock";
  readonly name = "NX Mock Image";
  readonly description = "Moteur de test sans GPU : vraies images PNG générées par ffmpeg, tous réglages respectés.";
  readonly backend = "in-process (CPU)";
  readonly capabilities: ReadonlySet<ImageCapability> = new Set<ImageCapability>([
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
  ]);
  readonly limits = { maxOutputs: 4, ratios: ["1:1", "9:16", "16:9", "4:5", "3:2", "2:3", "4:3", "3:4", "21:9"] };
  readonly quality = { text_to_image: 1, image_to_image: 1, edit: 1, inpaint: 1, outpaint: 1, upscale: 1, variation: 1 };

  constructor(private readonly minSeconds = 3) {}

  async health() {
    return { ok: true };
  }

  private steps(p: ImageParams) {
    return p.steps ?? { draft: 12, standard: 28, high: 40 }[p.quality];
  }

  /** Runs one ffmpeg graph per output, paced, with test hooks. */
  private async render(
    p: ImageParams,
    ctx: ProviderContext,
    build: (seed: number, out: string, index: number) => Promise<string[]>,
    count = p.numOutputs,
  ): Promise<ProviderOutput[]> {
    const hooks = testHooks(`${p.prompt} ${p.instruction}`, ctx.attempt);
    ctx.report("starting", 0.5, "Loading mock image engine");
    const minMs = this.minSeconds * 1000 * (hooks.slow ? 3 : 1);
    const seed0 = p.seed ?? 0;
    return paced(
      ctx,
      minMs,
      this.steps(p),
      async (onProgress) => {
        const outs: ProviderOutput[] = [];
        for (let i = 0; i < count; i++) {
          const seed = (seed0 + i) % 2_147_483_647;
          const out = path.join(ctx.workDir, `mock_${i}.png`);
          const args = await build(seed, out, i);
          await ffmpeg([...args, "-frames:v", "1", "-update", "1", "-pix_fmt", "rgb24", out], { signal: ctx.signal });
          outs.push({ path: out, seed });
          onProgress((i + 1) / count);
        }
        return outs;
      },
      hooks.failPermanent || hooks.failOnce ? () => throwHook(hooks) : undefined,
    );
  }

  private lines(p: ImageParams, seed: number, extra: string[] = []) {
    const lines = [`${OPERATION_LABEL[p.operation]} · seed ${seed} · cfg ${p.guidance} · ${this.steps(p)} steps`, ...extra];
    if (p.prompt) lines.push(...wrap(p.prompt, 56, 3));
    if (p.negativePrompt) lines.push(...wrap(`− ${p.negativePrompt}`, 56, 1));
    return lines;
  }

  private async withLabel(chain: string, W: number, H: number, ctx: ProviderContext, lines: string[]) {
    const label = await labelFilter(ctx.workDir, W, H, "NX STUDIO  ·  MOCK", lines);
    return label ? `${chain},${label}` : chain;
  }

  private gradient(W: number, H: number, seed: number, creativity: number) {
    const c = palette(seed, creativity);
    const types = ["linear", "radial", "circular", "spiral"];
    return `gradients=s=${W}x${H}:r=1:d=1:nb_colors=4:c0=${c[0]}:c1=${c[1]}:c2=${c[2]}:c3=${c[3]}:seed=${seed}:type=${types[seed % 4]}`;
  }

  /** Inputs for reference images (each rendered as a small swatch in a corner, weight = opacity). */
  private refOverlays(inputs: ImageInputs, W: number, firstIndex: number, base: string): { args: string[]; chains: string[]; out: string } {
    const args: string[] = [];
    const chains: string[] = [];
    let cur = base;
    inputs.references.slice(0, 4).forEach((r, i) => {
      args.push("-i", r.path);
      const w = Math.round(W / 6 / 2) * 2;
      chains.push(`[${firstIndex + i}:v]scale=${w}:-2,format=rgba,colorchannelmixer=aa=${(0.35 + r.weight * 0.65).toFixed(2)}[ref${i}]`);
      chains.push(`[${cur}][ref${i}]overlay=x=W-w-${Math.round(W * 0.03)}:y=${Math.round(W * 0.03) + i * (w + 8)}[r${i}]`);
      cur = `r${i}`;
    });
    return { args, chains, out: cur };
  }

  async generateTextToImage(p: ImageParams, ctx: ProviderContext): Promise<ProviderOutput[]> {
    const { width: W, height: H } = imageSize(p);
    return this.render(p, ctx, async (seed, _out) => {
      const chain = await this.withLabel(`format=rgb24,vignette=PI/5`, W, H, ctx, this.lines(p, seed, [`${W}×${H}`]));
      return ["-f", "lavfi", "-i", this.gradient(W, H, seed, 0.5), "-vf", chain];
    });
  }

  async generateImageToImage(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]> {
    const { width: W, height: H } = imageSize(p);
    return this.render(p, ctx, async (seed) => this.stylize(p, inputs, ctx, seed, W, H, p.strength, [`strength ${p.strength.toFixed(2)}`]));
  }

  async createVariation(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]> {
    const info = await probe(inputs.source!);
    const W = info.width!;
    const H = info.height!;
    const strength = VARIATION_STRENGTH[p.variationLevel];
    return this.render(p, ctx, async (seed) => this.stylize(p, inputs, ctx, seed, W, H, strength, [`variation ${p.variationLevel}`]));
  }

  /** Source image blended with a seeded colour field; `strength` = how far from the source. */
  private async stylize(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext, seed: number, W: number, H: number, strength: number, extra: string[]) {
    const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=rgb24`;
    const chains = [
      `[0:v]${cover},split[src][src2]`,
      `[1:v]format=rgb24[grad]`,
      `[src][grad]blend=all_mode=softlight:all_opacity=${(0.2 + strength * 0.8).toFixed(2)}[mix]`,
    ];
    let cur = "mix";
    if (p.preserveComposition) {
      chains.push(`[src2]edgedetect=mode=colormix:high=0.25:low=0.08,format=rgb24[edges]`, `[${cur}][edges]blend=all_mode=lighten:all_opacity=0.25[comp]`);
      cur = "comp";
    } else chains.push(`[src2]nullsink`);
    chains.push(`[${cur}]hue=h=${Math.round((mulberry32(seed)() - 0.5) * 120 * strength)}[hued]`);
    cur = "hued";
    const refs = this.refOverlays(inputs, W, 2, cur);
    chains.push(...refs.chains);
    const label = await labelFilter(ctx.workDir, W, H, "NX STUDIO  ·  MOCK", this.lines(p, seed, extra));
    chains.push(`[${refs.out}]${label ?? "null"}[out]`);
    return ["-i", inputs.source!, "-f", "lavfi", "-i", this.gradient(W, H, seed, 0.6), ...refs.args, "-filter_complex", chains.join(";"), "-map", "[out]"];
  }

  async editImage(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]> {
    const intent = parseEditInstruction(p.instruction || p.prompt);
    ctx.log("edit intent", { intent });
    if (intent.type === "reframe" && intent.targetRatio) {
      return this.outpaint({ ...p, outpaint: { top: 0, bottom: 0, left: 0, right: 0, targetRatio: intent.targetRatio } }, inputs, ctx);
    }
    const info = await probe(inputs.source!);
    const W = info.width!;
    const H = info.height!;
    const target = (intent.target ?? "").toLowerCase();
    return this.render(p, ctx, async (seed) => {
      const c = palette(hashString(target || intent.type) + seed, 0.6);
      const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
        `color=black:s=${W}x${H}:d=1,format=gray,geq=lum='if(lte(pow((X-${Math.round(W * cx)})/${Math.round(W * rx)},2)+pow((Y-${Math.round(H * cy)})/${Math.round(H * ry)},2),1),255,0)',gblur=sigma=${Math.round(Math.min(W, H) / 60)}`;
      const box = (x: number, y: number, w: number, h: number) =>
        `color=black:s=${W}x${H}:d=1,format=gray,drawbox=x=${Math.round(W * x)}:y=${Math.round(H * y)}:w=${Math.round(W * w)}:h=${Math.round(H * h)}:color=white:t=fill,gblur=sigma=${Math.round(Math.min(W, H) / 40)}`;
      let edited: string; // filter producing [ed] from [src] (and maybe lavfi inputs)
      let mask: string | null = null; // lavfi source for the region mask (white = edited)
      switch (intent.type) {
        case "replace_background":
          // New backdrop everywhere except the (assumed centred) subject, which is kept from the source.
          mask = ellipse(0.5, 0.56, 0.3, 0.44);
          return this.maskedEdit(inputs.source!, W, H, `[1:v]format=rgb24[ed]`, this.gradient(W, H, seed, 0.8), mask, true, await this.lbl(p, ctx, seed, W, H, intent.label));
        case "change_outfit":
          mask = box(0.28, 0.5, 0.44, 0.5);
          edited = `[0:v]hue=h=${Math.round(hashString(target) % 360)}:s=1.6,eq=contrast=1.1[ed]`;
          break;
        case "change_lighting": {
          const warm = /(golden|sunset|coucher|chaud|warm|soleil|sun)/.test(target + p.instruction.toLowerCase());
          const night = /(nuit|night|sombre|dark|bleu|blue|lune|moon)/.test(target + p.instruction.toLowerCase());
          const neon = /(neon|néon|club|cyber)/.test(target + p.instruction.toLowerCase());
          const grade = night
            ? "eq=brightness=-0.18:saturation=0.8,colorbalance=bs=0.35:ms=0.15:rs=-0.2"
            : neon
              ? "eq=contrast=1.25:saturation=1.5,colorbalance=rs=0.3:bs=0.35:gs=-0.2"
              : warm
                ? "eq=brightness=0.04:saturation=1.2,colorbalance=rs=0.3:gs=0.1:bs=-0.25"
                : "eq=brightness=0.08:contrast=1.15:gamma=1.1";
          edited = `[0:v]${grade},vignette=PI/4[ed]`;
          break;
        }
        case "remove_text":
          edited = `[0:v]smartblur=lr=5:ls=1:lt=-10,median=radius=3[ed]`;
          break;
        case "remove_object":
          mask = ellipse(0.5, 0.5, 0.18, 0.22);
          edited = `[0:v]gblur=sigma=${Math.round(Math.min(W, H) / 25)}[ed]`;
          break;
        case "add_object":
          mask = ellipse(0.5 + (mulberry32(seed)() - 0.5) * 0.3, 0.55, 0.12, 0.14);
          edited = `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=${c[0]}@1:t=fill[ed]`;
          break;
        case "replace_object":
          mask = ellipse(0.5, 0.5, 0.2, 0.24);
          edited = `[0:v]hue=h=${hashString(target) % 360}:s=1.8[ed]`;
          break;
        case "style":
          edited = `[0:v]edgedetect=mode=colormix:high=0.2:low=0.05,eq=saturation=1.6[ed]`;
          break;
        default:
          edited = `[0:v]hue=h=${Math.round((mulberry32(seed)() - 0.5) * 60)}:s=1.2[ed]`;
      }
      return this.maskedEdit(inputs.source!, W, H, edited, null, mask, false, await this.lbl(p, ctx, seed, W, H, intent.label));
    }, Math.min(p.numOutputs, 4));
  }

  private async lbl(p: ImageParams, ctx: ProviderContext, seed: number, W: number, H: number, intentLabel: string) {
    const lines = [`Édition · ${intentLabel} · seed ${seed}`, ...wrap(p.instruction || p.prompt, 56, 3)];
    return labelFilter(ctx.workDir, W, H, "NX STUDIO  ·  MOCK EDIT", lines);
  }

  /**
   * Composites an edited version of the source through a soft mask.
   * invert=false: mask white → edited.  invert=true: mask white → source (subject kept, rest edited).
   */
  private maskedEdit(src: string, W: number, H: number, editedChain: string, extraLavfi: string | null, maskLavfi: string | null, invert: boolean, label: string | null): string[] {
    const args = ["-i", src];
    const chains = [`[0:v]scale=${W}:${H},setsar=1,format=rgb24,split=2[s0][s1]`];
    let idx = 1;
    if (extraLavfi) {
      args.push("-f", "lavfi", "-i", extraLavfi);
      idx++;
    }
    // In editedChain, [0:v] means "a copy of the source" and [1:v] the extra lavfi input.
    if (editedChain.includes("[0:v]")) chains.push(editedChain.replace("[0:v]", "[s1]"));
    else chains.push(editedChain, "[s1]nullsink");
    let cur = "ed";
    if (maskLavfi) {
      args.push("-f", "lavfi", "-i", maskLavfi);
      // maskedmerge needs identical pixel formats on all three inputs
      chains.push(`[${idx}:v]scale=${W}:${H},format=rgb24[m]`, `[ed]format=rgb24[edf]`);
      chains.push(invert ? `[edf][s0][m]maskedmerge[mm]` : `[s0][edf][m]maskedmerge[mm]`);
      cur = "mm";
    } else chains.push("[s0]nullsink");
    chains.push(`[${cur}]${label ?? "null"}[out]`);
    return [...args, "-filter_complex", chains.join(";"), "-map", "[out]"];
  }

  async inpaint(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]> {
    const info = await probe(inputs.source!);
    const W = info.width!;
    const H = info.height!;
    return this.render(p, ctx, async (seed) => {
      const c = palette(seed + hashString(p.prompt), 0.5);
      const blur = Math.round(Math.min(W, H) / 18);
      const label = await labelFilter(ctx.workDir, W, H, "NX STUDIO  ·  MOCK INPAINT", this.lines(p, seed, [`strength ${p.strength.toFixed(2)}`]));
      const chains = [
        `[0:v]scale=${W}:${H},setsar=1,format=rgb24,split[base][fillsrc]`,
        `[fillsrc]gblur=sigma=${blur},drawbox=x=0:y=0:w=iw:h=ih:color=${c[0]}@${(0.25 + p.strength * 0.6).toFixed(2)}:t=fill,noise=alls=${Math.round(8 + p.strength * 20)}:allf=t[fill]`,
        `[1:v]scale=${W}:${H},format=gray,gblur=sigma=${Math.max(2, Math.round(Math.min(W, H) / 200))},format=rgb24[mask]`,
        `[fill]format=rgb24[fillf]`,
        `[base][fillf][mask]maskedmerge[mm]`,
        `[mm]${label ?? "null"}[out]`,
      ];
      return ["-i", inputs.source!, "-i", inputs.mask!, "-filter_complex", chains.join(";"), "-map", "[out]"];
    });
  }

  async outpaint(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]> {
    const info = await probe(inputs.source!);
    const w = info.width!;
    const h = info.height!;
    let { top, bottom, left, right } = p.outpaint;
    if (p.outpaint.targetRatio) {
      // Grow the canvas (never crop) until it matches the target ratio, centred.
      const [rw, rh] = p.outpaint.targetRatio.split(":").map(Number) as [number, number];
      const target = rw / rh;
      if (w / h < target) {
        const add = Math.round(h * target) - w;
        left = Math.floor(add / 2);
        right = add - left;
        top = bottom = 0;
      } else {
        const add = Math.round(w / target) - h;
        top = Math.floor(add / 2);
        bottom = add - top;
        left = right = 0;
      }
    }
    const W = Math.min(MAX_EDGE, Math.round((w + left + right) / 2) * 2);
    const H = Math.min(MAX_EDGE, Math.round((h + top + bottom) / 2) * 2);
    return this.render(p, ctx, async (seed) => {
      const label = await labelFilter(ctx.workDir, W, H, "NX STUDIO  ·  MOCK OUTPAINT", this.lines(p, seed, [`${w}×${h} → ${W}×${H}`]));
      const chains = [
        `[0:v]setsar=1,format=rgb24,split[a][b]`,
        `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=${Math.round(Math.max(W, H) / 30)},eq=saturation=1.1,hue=h=${(seed % 40) - 20}[bg]`,
        `[bg][b]overlay=x=${left}:y=${top}[ov]`,
        `[ov]${label ?? "null"}[out]`,
      ];
      return ["-i", inputs.source!, "-filter_complex", chains.join(";"), "-map", "[out]"];
    }, Math.min(p.numOutputs, 4));
  }

  async upscale(p: ImageParams, inputs: ImageInputs, ctx: ProviderContext): Promise<ProviderOutput[]> {
    const info = await probe(inputs.source!);
    const w = info.width!;
    const h = info.height!;
    let W = p.upscale.targetWidth ?? w * p.upscale.factor;
    let H = Math.round((W * h) / w);
    const k = Math.min(1, MAX_EDGE / Math.max(W, H));
    W = Math.round((W * k) / 2) * 2;
    H = Math.round((H * k) / 2) * 2;
    return this.render(
      p,
      ctx,
      async () => {
        const sharpen = p.upscale.enhanceDetails ? ",unsharp=5:5:0.9:5:5:0.0,cas=0.5" : "";
        return ["-i", inputs.source!, "-vf", `scale=${W}:${H}:flags=lanczos${sharpen},format=rgb24`];
      },
      1,
    );
  }
}
