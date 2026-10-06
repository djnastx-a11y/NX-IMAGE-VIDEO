import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { GpuEndpointConfig } from "../../config.js";
import { AbortedError, ProviderError } from "../../lib/errors.js";
import type { ProviderContext, ProviderOutput } from "../types.js";

export interface RemoteHealth {
  ok: boolean;
  gpu?: string;
  engines?: { id: string; capabilities?: string[]; limits?: Record<string, unknown> }[];
}

interface RemoteJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage?: string;
  progress?: number;
  error?: string;
  retryable?: boolean;
  outputs?: { index: number; seed?: number | null; mime?: string }[];
}

/**
 * Client for the NX GPU protocol (docs/GPU_WORKERS.md). The same protocol is served on a local GPU,
 * a RunPod pod, a Vast.ai instance or a dedicated server: switching infrastructure = changing a URL.
 *
 *   GET  /v1/health                 → { ok, gpu, engines: [{ id, capabilities?, limits? }] }
 *   POST /v1/jobs   (multipart)     → { id }        fields: engine, operation, params(JSON), files...
 *   GET  /v1/jobs/:id               → { status, stage, progress, error, retryable, outputs }
 *   POST /v1/jobs/:id/cancel
 *   GET  /v1/jobs/:id/outputs/:n    → file
 */
export class GpuClient {
  private healthCache: { at: number; value: RemoteHealth | Error } | null = null;

  constructor(
    readonly endpoint: GpuEndpointConfig,
    private readonly pollMs = 1000,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private headers(): Record<string, string> {
    const token = this.endpoint.tokenEnv ? this.env[this.endpoint.tokenEnv] : undefined;
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  private url(p: string) {
    return this.endpoint.url.replace(/\/+$/, "") + p;
  }

  async health(maxAgeMs = 15_000): Promise<RemoteHealth> {
    if (this.healthCache && Date.now() - this.healthCache.at < maxAgeMs) {
      if (this.healthCache.value instanceof Error) throw this.healthCache.value;
      return this.healthCache.value;
    }
    try {
      const res = await fetch(this.url("/v1/health"), { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const value = (await res.json()) as RemoteHealth;
      this.healthCache = { at: Date.now(), value };
      return value;
    } catch (e) {
      const err = new Error(`GPU endpoint "${this.endpoint.id}" unreachable: ${(e as Error).message}`);
      this.healthCache = { at: Date.now(), value: err };
      throw err;
    }
  }

  /** Submits a job, follows it to completion and downloads its outputs into ctx.workDir. */
  async run(engine: string, operation: string, params: unknown, files: Record<string, string | undefined>, ctx: ProviderContext): Promise<ProviderOutput[]> {
    ctx.report("starting", 0.1, `Uploading inputs to ${this.endpoint.id}`);
    const form = new FormData();
    form.set("engine", engine);
    form.set("operation", operation);
    form.set("job_id", ctx.jobId);
    form.set("params", JSON.stringify(params));
    for (const [field, file] of Object.entries(files)) {
      if (file) form.set(field, await fs.openAsBlob(file), path.basename(file));
    }
    let created: Response;
    try {
      created = await fetch(this.url("/v1/jobs"), { method: "POST", body: form, headers: this.headers(), signal: ctx.signal });
    } catch (e) {
      if (ctx.signal.aborted) throw new AbortedError();
      throw new ProviderError(`GPU endpoint ${this.endpoint.id} unreachable: ${(e as Error).message}`, "gpu_unreachable", true);
    }
    if (!created.ok) {
      const body = await created.text();
      throw new ProviderError(`GPU endpoint rejected the job (HTTP ${created.status}): ${body.slice(0, 500)}`, "gpu_rejected", created.status >= 500);
    }
    const { id: remoteId } = (await created.json()) as { id: string };
    ctx.log("remote job submitted", { endpoint: this.endpoint.id, remoteId, engine });

    const cancelRemote = () => {
      fetch(this.url(`/v1/jobs/${remoteId}/cancel`), { method: "POST", headers: this.headers() }).catch(() => {});
    };
    ctx.signal.addEventListener("abort", cancelRemote, { once: true });
    try {
      let failures = 0;
      let st: RemoteJob;
      for (;;) {
        await new Promise((r) => setTimeout(r, this.pollMs));
        if (ctx.signal.aborted) throw new AbortedError();
        try {
          const res = await fetch(this.url(`/v1/jobs/${remoteId}`), { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          st = (await res.json()) as RemoteJob;
          failures = 0;
        } catch (e) {
          if (++failures >= 15) throw new ProviderError(`Lost contact with GPU endpoint ${this.endpoint.id}: ${(e as Error).message}`, "gpu_lost", true);
          continue;
        }
        if (st.status === "queued") ctx.report("starting", 0.4, st.stage ?? "Waiting for a GPU");
        else if (st.status === "running") ctx.report("processing", st.progress ?? 0, st.stage);
        else if (st.status === "failed") throw new ProviderError(st.error ?? "Remote generation failed", "gpu_job_failed", !!st.retryable);
        else if (st.status === "cancelled") throw new AbortedError();
        else if (st.status === "completed") break;
      }
      const outputs: ProviderOutput[] = [];
      for (const o of st.outputs?.length ? st.outputs : [{ index: 0 }]) {
        const res = await fetch(this.url(`/v1/jobs/${remoteId}/outputs/${o.index}`), { headers: this.headers(), signal: ctx.signal });
        if (!res.ok || !res.body) throw new ProviderError(`Could not download output ${o.index}: HTTP ${res.status}`, "gpu_download", true);
        const ext = (o.mime ?? res.headers.get("content-type") ?? "").includes("video") ? "mp4" : "png";
        const out = path.join(ctx.workDir, `remote_${o.index}.${ext}`);
        await pipeline(Readable.fromWeb(res.body as WebReadableStream), fs.createWriteStream(out));
        outputs.push({ path: out, seed: o.seed ?? null });
      }
      ctx.report("processing", 1);
      return outputs;
    } finally {
      ctx.signal.removeEventListener("abort", cancelRemote);
    }
  }
}
