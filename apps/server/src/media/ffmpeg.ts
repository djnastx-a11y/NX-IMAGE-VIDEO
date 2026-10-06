import { spawn } from "node:child_process";

import { AbortedError } from "../lib/errors.js";

export interface ProbeResult {
  width: number | null;
  height: number | null;
  durationSec: number | null;
  hasVideo: boolean;
  codec: string | null;
  frames: number | null;
}

function run(cmd: string, args: string[], signal?: AbortSignal, onStdout?: (chunk: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      out += d;
      onStdout?.(d);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      err = (err + d).slice(-8000);
    });
    child.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new AbortedError());
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with code ${code}: ${err.trim().split("\n").slice(-4).join(" | ")}`));
    });
  });
}

export async function probe(file: string): Promise<ProbeResult> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name,nb_frames:format=duration",
    "-of", "json",
    file,
  ]);
  const j = JSON.parse(out) as {
    streams?: { width?: number; height?: number; codec_name?: string; nb_frames?: string }[];
    format?: { duration?: string };
  };
  const s = j.streams?.[0];
  const d = j.format?.duration ? Number(j.format.duration) : NaN;
  return {
    width: s?.width ?? null,
    height: s?.height ?? null,
    codec: s?.codec_name ?? null,
    hasVideo: !!s,
    durationSec: Number.isFinite(d) ? d : null,
    frames: s?.nb_frames ? Number(s.nb_frames) : null,
  };
}

/**
 * Runs ffmpeg and reports progress in [0,1] based on the number of frames written.
 */
export async function ffmpeg(
  args: string[],
  opts: { signal?: AbortSignal; totalFrames?: number; onProgress?: (p: number) => void } = {},
): Promise<void> {
  let buf = "";
  await run(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-progress", "pipe:1", ...args],
    opts.signal,
    (chunk) => {
      if (!opts.onProgress || !opts.totalFrames) return;
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^frame=(\d+)/.exec(line);
        if (m) opts.onProgress(Math.min(1, Number(m[1]) / opts.totalFrames));
      }
    },
  );
}

export async function extractFrame(video: string, out: string, at: "first" | "last" | number, signal?: AbortSignal) {
  if (at === "last") {
    // -sseof seeks relative to the end; grab the very last decodable frame.
    await ffmpeg(["-sseof", "-0.25", "-i", video, "-update", "1", "-q:v", "2", out], { signal });
    return;
  }
  const t = at === "first" ? 0 : at;
  await ffmpeg(["-ss", String(t), "-i", video, "-frames:v", "1", "-q:v", "2", "-update", "1", out], { signal });
}

/** 512px-wide JPEG thumbnail of an image or of a video frame. */
export async function makeThumbnail(input: string, out: string, durationSec: number | null) {
  const seek = durationSec ? ["-ss", Math.min(durationSec / 2, 1.5).toFixed(2)] : [];
  await ffmpeg([...seek, "-i", input, "-frames:v", "1", "-vf", "scale='min(512,iw)':-2", "-q:v", "4", "-update", "1", out]);
}

/** Converts/encodes a still image to the requested delivery format. */
export async function encodeImage(input: string, out: string, format: "png" | "jpeg" | "webp", signal?: AbortSignal) {
  const codec =
    format === "png"
      ? ["-c:v", "png", "-pix_fmt", "rgb24"]
      : format === "jpeg"
        ? ["-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj444p"]
        : ["-c:v", "libwebp", "-quality", "92", "-pix_fmt", "yuv420p"];
  await ffmpeg(["-i", input, "-frames:v", "1", ...codec, "-update", "1", out], { signal });
}

export const IMAGE_FORMAT_MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

/** Final delivery encode: H.264 / yuv420p / faststart so it plays everywhere, including iOS Safari. */
export function deliveryEncodeArgs(): string[] {
  return ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"];
}
