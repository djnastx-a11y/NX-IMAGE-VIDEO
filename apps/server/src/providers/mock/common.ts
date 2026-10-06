import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AbortedError, ProviderError } from "../../lib/errors.js";
import type { ProviderContext } from "../types.js";

export const FONT = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf",
].find((f) => fs.existsSync(f)) ?? null;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return "0x" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Hash of a string → stable number (to derive colours from words like "neon" or "forest"). */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function palette(seed: number, creativity = 0.5, n = 4): string[] {
  const rand = mulberry32(seed);
  const base = rand() * 360;
  const spread = 40 + creativity * 140;
  return Array.from({ length: n }, (_, i) => hsl((base + i * spread * (rand() + 0.5)) % 360, 0.55 + rand() * 0.35, 0.25 + rand() * 0.35));
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Test hooks available in any prompt / instruction:
 *  "#fail"      → permanent engine failure (job ends Failed)
 *  "#fail-once" → transient failure on the first attempt only (auto-retry then succeeds)
 *  "#slow"      → 3× longer job (to test cancel / queue)
 */
export function testHooks(text: string, attempt: number) {
  return {
    failPermanent: /#fail(?!-once)/i.test(text),
    failOnce: /#fail-once/i.test(text) && attempt <= 1,
    slow: /#slow/i.test(text),
  };
}

export function throwHook(h: ReturnType<typeof testHooks>) {
  if (h.failPermanent) throw new ProviderError("Simulated engine failure (#fail test hook)", "mock_failure", false);
  if (h.failOnce) throw new ProviderError("Simulated transient GPU error (#fail-once test hook)", "mock_transient", true);
}

/**
 * Paces a mock job so the queue / progress UI behaves like a real engine: runs `work` while
 * reporting step-like progress for at least `minMs`. `fail` (a test hook) throws once progress reaches 40%.
 */
export async function paced<T>(
  ctx: ProviderContext,
  minMs: number,
  steps: number,
  work: (onProgress: (p: number) => void) => Promise<T>,
  fail?: () => void,
): Promise<T> {
  const started = Date.now();
  let real = 0;
  const shown = () => Math.min(real, (Date.now() - started) / Math.max(1, minMs));
  const report = () => {
    const p = shown();
    ctx.report("processing", p, `Step ${Math.max(1, Math.ceil(p * steps))}/${steps}`);
  };
  const tick = setInterval(report, 200);
  try {
    const out = await work((p) => (real = p));
    real = 1;
    while (Date.now() - started < minMs) {
      if (fail && shown() >= 0.4) fail();
      await sleep(100, ctx.signal);
    }
    fail?.();
    report();
    return out;
  } finally {
    clearInterval(tick);
  }
}

/** Writes overlay text to files (drawtext textfile, expansion disabled) and returns the filter chain. */
export async function labelFilter(workDir: string, W: number, H: number, title: string, lines: string[]): Promise<string | null> {
  if (!FONT) return null;
  const tf = path.join(workDir, `title-${Math.random().toString(36).slice(2)}.txt`);
  const lf = path.join(workDir, `label-${Math.random().toString(36).slice(2)}.txt`);
  await fsp.writeFile(tf, title);
  await fsp.writeFile(lf, lines.join("\n"));
  const s = Math.min(W, H);
  const f1 = Math.max(12, Math.round(s / 30));
  const f2 = Math.max(10, Math.round(s / 42));
  return (
    `drawtext=fontfile=${FONT}:textfile=${tf}:expansion=none:fontcolor=white@0.92:fontsize=${f1}:x=${Math.round(W * 0.04)}:y=${Math.round(H * 0.04)}:box=1:boxcolor=black@0.35:boxborderw=${Math.round(f1 / 2)},` +
    `drawtext=fontfile=${FONT}:textfile=${lf}:expansion=none:fontcolor=white@0.85:fontsize=${f2}:line_spacing=${Math.round(f2 / 3)}:x=${Math.round(W * 0.04)}:y=h-th-${Math.round(H * 0.05)}:box=1:boxcolor=black@0.4:boxborderw=${Math.round(f2 / 2)}`
  );
}

export function wrap(s: string, n: number, maxLines: number): string[] {
  const words = s.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > n && cur) {
      lines.push(cur.trim());
      cur = w;
    } else cur += " " + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] += " …";
  }
  return lines;
}
