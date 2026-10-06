import type { ImageParams, Module, ProviderInfo, VideoParams } from "@nx/shared";
import { HttpError } from "../lib/errors.js";
import type { ProviderSettingsRepo, ProviderSettingsRow } from "../repos/presets.js";
import type { SettingsRepo } from "../repos/settings.js";
import { providerInfo, supportsOperation, type AnyProvider } from "./types.js";

export class RoutingError extends HttpError {
  constructor(message: string) {
    super(422, message, "no_provider");
  }
}

/** Why a provider cannot take these params, or null if it can. */
export function incompatibility(p: AnyProvider, params: ImageParams | VideoParams): string | null {
  if (!supportsOperation(p, params.operation)) return `${p.name} ne gère pas « ${params.operation} »`;
  if (p.module === "video") {
    const v = params as VideoParams;
    if (p.limits.maxDuration && v.duration > p.limits.maxDuration) return `${p.name} est limité à ${p.limits.maxDuration}s`;
    if (p.limits.resolutions && !p.limits.resolutions.includes(v.resolution)) return `${p.name} ne gère pas ${v.resolution}`;
  } else {
    const i = params as ImageParams;
    if (p.limits.maxOutputs && i.numOutputs > p.limits.maxOutputs) return `${p.name} produit au plus ${p.limits.maxOutputs} images`;
    if ((i.width || i.height) && !(p.capabilities as ReadonlySet<string>).has("custom_size")) return `${p.name} n'accepte pas de dimensions personnalisées`;
  }
  return null;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, AnyProvider>();
  private settingsCache: { at: number; value: Map<string, ProviderSettingsRow> } | null = null;

  constructor(
    private readonly providerSettings: ProviderSettingsRepo,
    private readonly system: SettingsRepo,
  ) {}

  async register(p: AnyProvider) {
    this.providers.set(p.id, p);
    await this.providerSettings.ensure(p.id, p.module);
    this.settingsCache = null;
  }

  list(module?: Module): AnyProvider[] {
    return [...this.providers.values()].filter((p) => !module || p.module === module);
  }

  get(id: string): AnyProvider | undefined {
    return this.providers.get(id);
  }

  invalidate() {
    this.settingsCache = null;
  }

  private async settings(): Promise<Map<string, ProviderSettingsRow>> {
    if (this.settingsCache && Date.now() - this.settingsCache.at < 3000) return this.settingsCache.value;
    const value = await this.providerSettings.all();
    this.settingsCache = { at: Date.now(), value };
    return value;
  }

  private async state(p: AnyProvider) {
    const s = (await this.settings()).get(p.id);
    return { enabled: s?.enabled ?? true, isDefault: s?.is_default ?? false };
  }

  async infos(module?: Module): Promise<ProviderInfo[]> {
    return Promise.all(this.list(module).map(async (p) => providerInfo(p, await p.health(), await this.state(p))));
  }

  /** Health check on demand (admin "Tester"), with latency. */
  async test(id: string): Promise<{ ok: boolean; reason: string | null; latencyMs: number }> {
    const p = this.get(id);
    if (!p) throw new HttpError(404, "Provider not found");
    const t = Date.now();
    const h = await p.health();
    return { ok: h.ok, reason: h.reason ?? null, latencyMs: Date.now() - t };
  }

  /**
   * Picks the engine for a job:
   *  - model "auto": the admin's default provider for the module if it can take the job, otherwise the
   *    available provider with the best quality score for the operation;
   *  - an engine family ("wan", "flux"): the best available endpoint serving it;
   *  - an exact provider id: that provider, if it can take the job.
   */
  async resolve(module: Module, params: ImageParams | VideoParams): Promise<AnyProvider> {
    const all = this.list(module);
    const sys = await this.system.system();
    const sysDefault = module === "image" ? sys.defaults.imageProvider : sys.defaults.videoProvider;
    const model = params.model === "auto" && sysDefault && sysDefault !== "auto" ? sysDefault : params.model;
    let candidates = all;
    if (model !== "auto") {
      candidates = all.filter((p) => p.id === model || p.engine === model);
      if (!candidates.length && params.model !== "auto") throw new RoutingError(`Moteur inconnu : ${params.model}`);
      if (!candidates.length) candidates = all; // stale system default: fall back to auto
    }
    const reasons: string[] = [];
    const ok: { p: AnyProvider; score: number }[] = [];
    for (const p of candidates) {
      const st = await this.state(p);
      if (!st.enabled) {
        reasons.push(`${p.name} : désactivé`);
        continue;
      }
      const why = incompatibility(p, params);
      if (why) {
        reasons.push(why);
        continue;
      }
      const h = await p.health();
      if (!h.ok) {
        reasons.push(`${p.name} : ${h.reason ?? "indisponible"}`);
        continue;
      }
      const q = (p.quality as Record<string, number | undefined>)[params.operation] ?? 0;
      ok.push({ p, score: q + (params.model === "auto" && st.isDefault ? 1000 : 0) });
    }
    ok.sort((a, b) => b.score - a.score);
    if (!ok.length) throw new RoutingError(`Aucun moteur disponible pour cette génération (${reasons.join(" ; ") || "aucun moteur configuré"})`);
    return ok[0]!.p;
  }
}
