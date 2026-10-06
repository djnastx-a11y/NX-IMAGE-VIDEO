import path from "node:path";
import { CAMERA_LABEL, OPERATION_LABEL, videoSize, type CameraMove, type VideoCapability, type VideoParams } from "@nx/shared";
import { ffmpeg } from "../../media/ffmpeg.js";
import type { ProviderContext, ProviderOutput, VideoInputs, VideoProvider } from "../types.js";
import { hashString, labelFilter, mulberry32, paced, palette, testHooks, throwHook, wrap } from "./common.js";

/** zoompan expressions (evaluated per output frame, d=1) for each camera preset. */
export function cameraExpressions(move: CameraMove, intensity: number, motion: number, frames: number) {
  const k = (0.04 + 0.5 * (intensity / 10)) * (0.6 + 0.8 * motion);
  const p = `(on/${Math.max(1, frames - 1)})`;
  const cx = "(iw-iw/zoom)/2";
  const cy = "(ih-ih/zoom)/2";
  const shake = (0.25 + intensity / 20).toFixed(3);
  const e: Record<CameraMove, { z: string; x: string; y: string }> = {
    static: { z: "1", x: cx, y: cy },
    zoom_in: { z: `1+${k}*${p}`, x: cx, y: cy },
    zoom_out: { z: `1+${k}*(1-${p})`, x: cx, y: cy },
    dolly_in: { z: `1+${(k * 1.6).toFixed(4)}*pow(${p},1.6)`, x: cx, y: `(ih-ih/zoom)*0.45` },
    dolly_out: { z: `1+${(k * 1.6).toFixed(4)}*pow(1-${p},1.6)`, x: cx, y: `(ih-ih/zoom)*0.45` },
    pan_left: { z: `1+${k}`, x: `(iw-iw/zoom)*(1-${p})`, y: cy },
    pan_right: { z: `1+${k}`, x: `(iw-iw/zoom)*${p}`, y: cy },
    tilt_up: { z: `1+${k}`, x: cx, y: `(ih-ih/zoom)*(1-${p})` },
    tilt_down: { z: `1+${k}`, x: cx, y: `(ih-ih/zoom)*${p}` },
    orbit_left: { z: `1+${k}*(0.5+0.5*sin(PI*${p}))`, x: `(iw-iw/zoom)*(1-${p})`, y: cy },
    orbit_right: { z: `1+${k}*(0.5+0.5*sin(PI*${p}))`, x: `(iw-iw/zoom)*${p}`, y: cy },
    tracking: { z: `1+${k}*0.8`, x: `(iw-iw/zoom)*${p}`, y: `${cy}*(1+0.08*sin(on*0.5))` },
    drone: { z: `1+${k}*(1-0.6*${p})`, x: `(iw-iw/zoom)*(0.3+0.4*${p})`, y: `(ih-ih/zoom)*(1-${p})` },
    crane: { z: `1+${k}*(0.3+0.7*${p})`, x: cx, y: `(ih-ih/zoom)*(1-${p})` },
    handheld: {
      z: `1+${(0.06 + k * 0.2).toFixed(4)}`,
      x: `${cx}*(1+${shake}*sin(on*0.31)*cos(on*0.07))`,
      y: `${cy}*(1+${shake}*cos(on*0.23)*sin(on*0.11))`,
    },
  };
  return e[move];
}

/**
 * MockVideoProvider: renders real H.264 videos with ffmpeg, honouring mode, inputs, duration,
 * fps, resolution, ratio, seed, camera preset + intensity, motion, fidelity... no GPU needed.
 */
export class MockVideoProvider implements VideoProvider {
  readonly module = "video" as const;
  readonly id = "mock-video";
  readonly engine = "mock";
  readonly name = "NX Mock Video";
  readonly description = "Moteur de test sans GPU : vraies vidéos MP4 rendues par ffmpeg, tous réglages respectés.";
  readonly backend = "in-process (CPU)";
  readonly capabilities: ReadonlySet<VideoCapability> = new Set<VideoCapability>([
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
  ]);
  readonly limits = { maxDuration: 30, durations: [5, 10, 15, 20, 30], resolutions: ["480p", "720p", "1080p"] };
  readonly quality = { text_to_video: 1, image_to_video: 1, video_to_video: 1, first_last_frame: 1, extend: 1 };

  constructor(private readonly minSeconds = 4) {}

  async health() {
    return { ok: true };
  }

  generateTextToVideo(p: VideoParams, ctx: ProviderContext) {
    return this.render(p, { keyframes: [] }, ctx);
  }
  generateImageToVideo(p: VideoParams, i: VideoInputs, ctx: ProviderContext) {
    return this.render(p, i, ctx);
  }
  generateVideoToVideo(p: VideoParams, i: VideoInputs, ctx: ProviderContext) {
    return this.render(p, i, ctx);
  }
  generateFirstLastFrame(p: VideoParams, i: VideoInputs, ctx: ProviderContext) {
    return this.render(p, i, ctx);
  }
  extendVideo(p: VideoParams, i: VideoInputs, ctx: ProviderContext) {
    return this.render({ ...p, operation: "image_to_video" }, { ...i, image: i.extendLastFrame }, ctx, "extend");
  }

  private async render(p: VideoParams, inputs: VideoInputs, ctx: ProviderContext, labelOp?: string): Promise<ProviderOutput> {
    const hooks = testHooks(p.prompt, ctx.attempt);
    ctx.report("starting", 0.3, "Loading mock video engine");
    const FPS = p.fps;
    const { width: W, height: H } = videoSize(p);
    const frames = Math.round(p.duration * FPS);
    const S = p.resolution === "1080p" ? 1.25 : 1.5; // supersampling for smooth sub-pixel camera moves
    const SW = Math.round((W * S) / 2) * 2;
    const SH = Math.round((H * S) / 2) * 2;
    const seed = p.seed ?? 1;
    const rand = mulberry32(seed);
    const out = path.join(ctx.workDir, "mock_raw.mp4");
    const cover = `scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH},setsar=1,fps=${FPS},format=yuv420p`;
    const args: string[] = [];
    const chains: string[] = [];
    const nInputs = () => args.filter((a) => a === "-i").length;
    const loopImage = (file: string) => args.push("-loop", "1", "-framerate", String(FPS), "-t", String(p.duration), "-i", file);

    switch (p.operation) {
      case "text_to_video": {
        const c = palette(seed + hashString(p.prompt), p.creativity);
        const types = ["linear", "radial", "circular", "spiral"];
        args.push(
          "-f", "lavfi", "-i",
          `gradients=s=${SW}x${SH}:r=${FPS}:d=${p.duration}:nb_colors=4:c0=${c[0]}:c1=${c[1]}:c2=${c[2]}:c3=${c[3]}:seed=${seed}:speed=${(0.004 + p.subjectMotion * 0.03).toFixed(4)}:type=${types[seed % 4]}`,
        );
        chains.push(`[0:v]${cover}[base]`);
        break;
      }
      case "image_to_video": {
        loopImage(inputs.image!);
        // Low fidelity → the image drifts in colour/texture; high fidelity → untouched.
        const drift = (1 - p.sourceFidelity) * 0.6;
        chains.push(`[0:v]${cover},hue=h='${(drift * 40).toFixed(1)}*sin(2*PI*t/${p.duration})':s=${(1 + drift * 0.5).toFixed(2)}[base]`);
        break;
      }
      case "first_last_frame": {
        const kf = inputs.keyframes.length >= 2 ? inputs.keyframes : [
          { path: inputs.image!, position: 0 },
          { path: inputs.endImage!, position: 1 },
        ];
        kf.forEach((k) => loopImage(k.path));
        kf.forEach((_, i) => chains.push(`[${i}:v]${cover}[k${i}]`));
        // Chain cross-fades between consecutive keyframes (2 for first/last, more later).
        let cur = "k0";
        for (let i = 1; i < kf.length; i++) {
          const segStart = kf[i - 1]!.position * p.duration;
          const segEnd = kf[i]!.position * p.duration;
          const fade = Math.max(0.4, (segEnd - segStart) * (0.4 + 0.4 * p.motionStrength));
          const offset = Math.max(0, segStart + (segEnd - segStart - fade) / 2);
          chains.push(`[${cur}][k${i}]xfade=transition=fade:duration=${fade.toFixed(2)}:offset=${offset.toFixed(2)}[x${i}]`);
          cur = `x${i}`;
        }
        chains.push(`[${cur}]null[base]`);
        break;
      }
      case "video_to_video": {
        args.push("-stream_loop", "-1", "-t", String(p.duration), "-i", inputs.video!);
        const s = p.videoStrength;
        const edges = p.preserve.structure ? "edgedetect=mode=colormix:high=0.2:low=0.05," : "";
        chains.push(
          `[0:v]${cover},split[v0][v1]`,
          `[v1]${edges}hue=h=${Math.round(rand() * 360)}:s=${(1 + s).toFixed(2)}[fx]`,
          `[v0][fx]blend=all_mode=normal:all_opacity=${(0.15 + 0.75 * s * (p.preserve.composition ? 0.7 : 1)).toFixed(2)}[base]`,
        );
        break;
      }
      case "extend":
        throw new Error("extend is rendered as image_to_video from the last frame");
    }

    let cur = "base";
    if (inputs.reference) {
      loopImage(inputs.reference);
      const rw = Math.round(SW / 5 / 2) * 2;
      chains.push(`[${nInputs() - 1}:v]scale=${rw}:-2,format=yuv420p[ref]`);
      chains.push(`[${cur}][ref]overlay=x=W-w-${Math.round(SW * 0.03)}:y=${Math.round(SH * 0.03)}:shortest=1[withref]`);
      cur = "withref";
    }

    const cam = cameraExpressions(p.camera.move, p.camera.intensity, p.motionStrength, frames);
    chains.push(
      `[${cur}]zoompan=z='${cam.z}':x='${cam.x}':y='${cam.y}':d=1:s=${W}x${H}:fps=${FPS},` +
        `hue=h='${(p.subjectMotion * p.motionStrength * 30).toFixed(1)}*sin(2*PI*t/${p.duration})',eq=saturation=${(0.85 + p.creativity * 0.5).toFixed(2)}[cam]`,
    );
    cur = "cam";

    const lines = [
      `${labelOp === "extend" ? "Extend" : OPERATION_LABEL[p.operation]} · ${p.duration}s · ${p.aspectRatio} · ${p.resolution} · ${FPS}fps · seed ${seed}`,
      `camera ${CAMERA_LABEL[p.camera.move]} (${p.camera.intensity}) · motion ${p.motionStrength.toFixed(2)} · creativity ${p.creativity.toFixed(2)} · cfg ${p.promptAdherence}`,
      ...(p.prompt ? wrap(p.prompt, 60, 3) : []),
      ...(p.negativePrompt ? wrap(`− ${p.negativePrompt}`, 60, 1) : []),
    ];
    const label = await labelFilter(ctx.workDir, W, H, "NX STUDIO  ·  MOCK VIDEO", lines);
    if (label) {
      chains.push(`[${cur}]${label}[out]`);
      cur = "out";
    }

    const minMs = this.minSeconds * 1000 * (hooks.slow ? 3 : 1);
    await paced(
      ctx,
      minMs,
      Math.max(10, Math.round(frames / 8)),
      (onProgress) =>
        ffmpeg(
          [
            ...args,
            "-filter_complex", chains.join(";"),
            "-map", `[${cur}]`,
            "-frames:v", String(frames),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-an",
            out,
          ],
          { signal: ctx.signal, totalFrames: frames, onProgress },
        ),
      hooks.failPermanent || hooks.failOnce ? () => throwHook(hooks) : undefined,
    );
    return { path: out, seed };
  }
}
