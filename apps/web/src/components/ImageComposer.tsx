import { useEffect, useMemo, useRef, useState } from "react";
import {
  IMAGE_RATIOS,
  IMAGE_RESOLUTIONS,
  imageParamsSchema,
  imageSize,
  missingImageInputs,
  parseEditInstruction,
  type ImageOperation,
  type ImageParams,
  type Job,
  type Media,
  type Preset,
} from "@nx/shared";
import { api, uploadMedia } from "../lib/api";
import { useData, useJobs, useToast } from "../lib/store";
import { Icon } from "./icons";
import { MediaSlot } from "./MediaSlot";
import { MaskEditor, type MaskEditorHandle } from "./MaskEditor";
import { ModelSelect, PresetBar, SeedField, useCapabilities } from "./controls";
import { Field, Segmented, Slider, Toggle } from "./ui";

const OPS: { op: ImageOperation; label: string }[] = [
  { op: "text_to_image", label: "Text to Image" },
  { op: "image_to_image", label: "Image to Image" },
  { op: "edit", label: "Édition" },
  { op: "inpaint", label: "Inpainting" },
  { op: "outpaint", label: "Outpainting" },
  { op: "upscale", label: "Upscale" },
  { op: "variation", label: "Variation" },
];

const EDIT_EXAMPLES = [
  "Supprime toutes les écritures sans modifier le reste.",
  "Remplace uniquement le décor par une rue de nuit sous la pluie.",
  "Garde exactement le personnage et change uniquement ses vêtements en costume noir.",
  "Change uniquement l'éclairage en coucher de soleil.",
  "Retire la voiture au premier plan.",
  "Passe cette image du 16:9 au 9:16 et reconstruis naturellement les zones manquantes.",
];

const defaults = (operation: ImageOperation): ImageParams => imageParamsSchema.parse({ operation });

export interface ImageComposerInit {
  job?: Job;
  sourceMediaId?: string;
  op?: ImageOperation;
}

export function ImageComposer({ init, onCreated }: { init?: ImageComposerInit; onCreated?(jobs: Job[]): void }) {
  const { currentProject } = useData();
  const { upsert } = useJobs();
  const { push } = useToast();
  const [p, setP] = useState<ImageParams>(() => defaults("text_to_image"));
  const [media, setMedia] = useState<Record<string, Media | null>>({});
  const [refs, setRefs] = useState<(Media | null)[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMask, setHasMask] = useState(false);
  const mask = useRef<MaskEditorHandle>(null);
  const set = (patch: Partial<ImageParams>) => setP((x) => ({ ...x, ...patch }));
  const cap = useCapabilities("image", p.operation, p.model);
  const has = (c: string) => cap.caps.has(c);

  // Load a job's settings (Réutiliser / Duplicate) or a source image (Modifier / from library)
  useEffect(() => {
    if (!init) return;
    if (init.job) {
      const jp = imageParamsSchema.parse(init.job.params);
      setP({ ...jp });
      const byId = new Map(init.job.sources.map((m) => [m.id, m]));
      setMedia({ source: byId.get(jp.sourceMediaId ?? "") ?? null });
      setRefs(jp.references.map((r) => byId.get(r.mediaId) ?? null));
    } else if (init.sourceMediaId) {
      api.mediaItem(init.sourceMediaId).then((m) => setMedia((x) => ({ ...x, source: m })), () => {});
      setP((x) => ({ ...x, operation: init.op ?? "edit" }));
    } else if (init.op) setP((x) => ({ ...x, operation: init.op! }));
  }, [init]);

  const op = p.operation;
  const source = media.source ?? null;
  const intent = useMemo(() => (op === "edit" && p.instruction ? parseEditInstruction(p.instruction) : null), [op, p.instruction]);
  const full: ImageParams = {
    ...p,
    sourceMediaId: op === "text_to_image" ? null : source?.id ?? null,
    references: refs.filter((m): m is Media => !!m).map((m, i) => ({ mediaId: m.id, type: p.references[i]?.type ?? "general", weight: p.references[i]?.weight ?? 0.6 })),
  };
  const missing = missingImageInputs({ ...full, maskMediaId: hasMask ? "pending" : null } as ImageParams);
  const size = op === "text_to_image" || op === "image_to_image" ? imageSize(p) : null;

  const generate = async () => {
    setBusy(true);
    try {
      let maskMediaId: string | null = null;
      if (op === "inpaint") {
        const blob = await mask.current?.exportMask();
        if (!blob) throw new Error("Peins la zone à régénérer sur l'image");
        maskMediaId = (await uploadMedia(new File([blob], "mask.png", { type: "image/png" }), { purpose: "mask", projectId: currentProject })).id;
      }
      const jobs = await api.createJob({ module: "image", projectId: currentProject, params: { ...full, maskMediaId } });
      upsert(jobs);
      onCreated?.(jobs);
      push("success", "Génération ajoutée à la file");
    } catch (e) {
      push("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = (pr: Preset) => setP((x) => imageParamsSchema.parse({ ...x, ...pr.params, operation: (pr.params as Partial<ImageParams>).operation ?? x.operation }));
  const presetParams = () => {
    const { sourceMediaId: _s, maskMediaId: _m, references: _r, ...rest } = p;
    return rest;
  };

  return (
    <div className="card composer">
      <div className="op-tabs" role="tablist">
        {OPS.map((o) => (
          <button key={o.op} role="tab" className={`op-tab${o.op === op ? " on" : ""}`} aria-selected={o.op === op} onClick={() => set({ operation: o.op, model: "auto" })}>
            {o.label}
          </button>
        ))}
      </div>
      <div className="composer-body">
        <PresetBar module="image" onApply={applyPreset} current={presetParams} />

        {op !== "text_to_image" && op !== "inpaint" && (
          <div className="field">
            <MediaSlot kind="image" title="Image source" value={source} onChange={(m) => setMedia((x) => ({ ...x, source: m }))} />
          </div>
        )}
        {op === "inpaint" &&
          (source ? (
            <div className="field">
              <div className="label">
                <span>Peins la zone à régénérer</span>
                <button className="btn ghost sm" onClick={() => setMedia((x) => ({ ...x, source: null }))}>
                  Changer d'image
                </button>
              </div>
              <MaskEditor ref={mask} source={source} onChange={setHasMask} />
            </div>
          ) : (
            <div className="field">
              <MediaSlot kind="image" title="Image à retoucher" value={null} onChange={(m) => setMedia((x) => ({ ...x, source: m }))} />
            </div>
          ))}

        {op === "edit" ? (
          <Field label="Instruction" hint="Décris simplement la modification. Le reste de l'image est conservé.">
            <textarea className="textarea" value={p.instruction} onChange={(e) => set({ instruction: e.target.value })} placeholder="ex. Remplace uniquement le décor par une plage au coucher du soleil" />
            {intent && (
              <div className="intent">
                <Icon name="wand" style={{ width: 14, height: 14 }} /> Compris : {intent.label}
                {intent.preserveRest ? " · reste conservé" : ""}
              </div>
            )}
            <div className="examples">
              {EDIT_EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => set({ instruction: ex })}>
                  {ex}
                </button>
              ))}
            </div>
          </Field>
        ) : op !== "upscale" ? (
          <Field label={op === "variation" ? "Prompt (optionnel)" : "Prompt"}>
            <textarea
              className="textarea"
              value={p.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
              placeholder={op === "inpaint" ? "Ce qui doit apparaître dans la zone peinte" : op === "outpaint" ? "Ce qui doit remplir les nouvelles zones" : "Décris l'image…"}
            />
          </Field>
        ) : null}

        {has("negative_prompt") && op !== "upscale" && op !== "edit" && (
          <Field label="Negative prompt">
            <input className="input" value={p.negativePrompt} onChange={(e) => set({ negativePrompt: e.target.value })} placeholder="flou, texte, filigrane, mains déformées…" />
          </Field>
        )}

        {(op === "text_to_image" || op === "image_to_image") && (
          <>
            <Field label="Format" right={size && <span className="val tiny">{size.width}×{size.height}</span>}>
              <Segmented wrap value={p.aspectRatio} onChange={(v) => set({ aspectRatio: v, width: null, height: null })} options={IMAGE_RATIOS.slice(0, 6).map((r) => ({ value: r, label: r }))} />
            </Field>
            <Field label="Résolution">
              <Segmented value={p.resolution} onChange={(v) => set({ resolution: v })} options={Object.keys(IMAGE_RESOLUTIONS).map((r) => ({ value: r as ImageParams["resolution"], label: r }))} />
            </Field>
          </>
        )}

        {(op === "image_to_image" || op === "inpaint") && (
          <Slider label="Strength" value={p.strength} min={0} max={1} onChange={(v) => set({ strength: v })} hint="0 = garder la source, 1 = s'en éloigner librement." />
        )}
        {op === "image_to_image" && <Toggle label="Conserver la composition" checked={p.preserveComposition} onChange={(v) => set({ preserveComposition: v })} />}

        {op === "outpaint" && <OutpaintControls p={p} set={set} source={source} />}

        {op === "upscale" && (
          <>
            <Field label="Facteur">
              <Segmented value={p.upscale.factor} onChange={(v) => set({ upscale: { ...p.upscale, factor: v, targetWidth: null } })} options={[{ value: 2 as const, label: "×2" }, { value: 4 as const, label: "×4" }]} />
            </Field>
            {source?.width && <div className="hint" style={{ marginTop: -8, marginBottom: 12 }}>{source.width}×{source.height} → {Math.min(8192, source.width * p.upscale.factor)}×{Math.round((Math.min(8192, source.width * p.upscale.factor) * (source.height ?? 1)) / source.width)}</div>}
            <Toggle label="Amélioration des détails" checked={p.upscale.enhanceDetails} onChange={(v) => set({ upscale: { ...p.upscale, enhanceDetails: v } })} />
          </>
        )}

        {op === "variation" && (
          <Field label="Niveau de variation">
            <Segmented value={p.variationLevel} onChange={(v) => set({ variationLevel: v })} options={[{ value: "subtle", label: "Faible" }, { value: "medium", label: "Moyenne" }, { value: "strong", label: "Forte" }]} />
          </Field>
        )}

        {has("multi_output") && op !== "upscale" && (
          <Field label="Nombre de résultats">
            <Segmented value={p.numOutputs} onChange={(v) => set({ numOutputs: v })} options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n), disabled: n > cap.maxOutputs }))} />
          </Field>
        )}

        <button type="button" className="advanced-toggle" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
          Réglages avancés <Icon name={advanced ? "x" : "plus"} style={{ width: 14, height: 14 }} />
        </button>
        {advanced && (
          <div style={{ paddingTop: 8 }}>
            <ModelSelect module="image" op={op} value={p.model} onChange={(v) => set({ model: v })} />
            {has("seed") && <SeedField value={p.seed} onChange={(v) => set({ seed: v })} />}
            {has("guidance") && op !== "upscale" && <Slider label="Guidance / prompt adherence" value={p.guidance} min={1} max={20} step={0.5} format={(v) => v.toFixed(1)} onChange={(v) => set({ guidance: v })} />}
            {op !== "upscale" && (
              <Field label="Qualité">
                <Segmented value={p.quality} onChange={(v) => set({ quality: v })} options={[{ value: "draft", label: "Brouillon" }, { value: "standard", label: "Standard" }, { value: "high", label: "Haute" }]} />
              </Field>
            )}
            {has("steps") && op !== "upscale" && (
              <Slider label="Steps" value={p.steps ?? 28} min={4} max={60} step={1} format={(v) => (p.steps === null ? `auto (${v})` : String(v))} onChange={(v) => set({ steps: v })} />
            )}
            {has("custom_size") && (op === "text_to_image" || op === "image_to_image") && (
              <Field label="Dimensions personnalisées" hint="Laisse vide pour utiliser format + résolution.">
                <div className="row">
                  <input className="input" inputMode="numeric" placeholder="largeur" value={p.width ?? ""} onChange={(e) => set({ width: e.target.value ? Math.max(256, Math.min(4096, Number(e.target.value) || 0)) : null })} />
                  ×
                  <input className="input" inputMode="numeric" placeholder="hauteur" value={p.height ?? ""} onChange={(e) => set({ height: e.target.value ? Math.max(256, Math.min(4096, Number(e.target.value) || 0)) : null })} />
                </div>
              </Field>
            )}
            <Field label="Format de sortie">
              <Segmented value={p.outputFormat} onChange={(v) => set({ outputFormat: v })} options={[{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }, { value: "webp", label: "WebP" }]} />
            </Field>
            {has("reference_image") && op !== "upscale" && (
              <Field label="Images de référence" hint={has("multi_reference") ? "Jusqu'à 4 références, chacune avec son type et son poids." : undefined}>
                <div className="col">
                  {refs.map((m, i) => (
                    <div key={i} className="card card-pad col" style={{ padding: 10 }}>
                      <MediaSlot compact kind="image" title={`Référence ${i + 1}`} value={m} onChange={(v) => setRefs((r) => r.map((x, n) => (n === i ? v : x)))} />
                      <div className="row">
                        <select
                          className="select"
                          value={p.references[i]?.type ?? "general"}
                          onChange={(e) => set({ references: Object.assign([...p.references], { [i]: { mediaId: m?.id ?? "", weight: p.references[i]?.weight ?? 0.6, type: e.target.value as "general" } }) })}
                          aria-label="Type de référence"
                        >
                          <option value="general">Générale</option>
                          {has("style_reference") && <option value="style">Style</option>}
                          {has("character_reference") && <option value="character">Personnage</option>}
                          {has("face_reference") && <option value="face">Visage</option>}
                        </select>
                        <input
                          className="range"
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={p.references[i]?.weight ?? 0.6}
                          onChange={(e) => set({ references: Object.assign([...p.references], { [i]: { mediaId: m?.id ?? "", type: p.references[i]?.type ?? "general", weight: Number(e.target.value) } }) })}
                          aria-label="Poids"
                        />
                        <button className="btn sm icon" onClick={() => (setRefs((r) => r.filter((_, n) => n !== i)), set({ references: p.references.filter((_, n) => n !== i) }))} aria-label="Retirer">
                          <Icon name="x" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {refs.length < (has("multi_reference") ? 4 : 1) && (
                    <button className="btn sm" onClick={() => setRefs((r) => [...r, null])}>
                      <Icon name="plus" /> Ajouter une référence
                    </button>
                  )}
                </div>
              </Field>
            )}
          </div>
        )}
      </div>
      <div className="composer-foot">
        {cap.none && <div className="job-error" style={{ marginBottom: 8 }}>Aucun moteur disponible pour cette opération.</div>}
        <button className="btn primary generate" disabled={busy || missing.length > 0 || cap.none} onClick={generate} title={missing.length ? `Manquant : ${missing.join(", ")}` : undefined}>
          {busy ? <div className="spinner" /> : <Icon name="sparkles" />}
          GENERATE
        </button>
        {missing.length > 0 && <div className="hint" style={{ textAlign: "center" }}>Manquant : {missing.join(", ")}</div>}
      </div>
    </div>
  );
}

function OutpaintControls({ p, set, source }: { p: ImageParams; set(x: Partial<ImageParams>): void; source: Media | null }) {
  const o = p.outpaint;
  const mode = o.targetRatio ? "ratio" : "sides";
  const w = source?.width ?? 1000;
  const h = source?.height ?? 1000;
  let { top, bottom, left, right } = o;
  if (o.targetRatio) {
    const [rw, rh] = o.targetRatio.split(":").map(Number) as [number, number];
    if (w / h < rw / rh) {
      const add = Math.round((h * rw) / rh) - w;
      left = Math.floor(add / 2);
      right = add - left;
      top = bottom = 0;
    } else {
      const add = Math.round((w * rh) / rw) - h;
      top = Math.floor(add / 2);
      bottom = add - top;
      left = right = 0;
    }
  }
  const W = w + left + right;
  const H = h + top + bottom;
  const step = Math.round(Math.max(w, h) / 8);
  const setSide = (side: "top" | "bottom" | "left" | "right", v: number) => set({ outpaint: { ...o, targetRatio: null, [side]: Math.max(0, v) } });
  return (
    <>
      <Field label="Étendre">
        <Segmented value={mode} onChange={(m) => set({ outpaint: m === "ratio" ? { ...o, targetRatio: "9:16" } : { ...o, targetRatio: null } })} options={[{ value: "sides", label: "Par côté" }, { value: "ratio", label: "Vers un format" }]} />
      </Field>
      {mode === "ratio" ? (
        <Field label="Format cible">
          <Segmented wrap value={o.targetRatio!} onChange={(v) => set({ outpaint: { ...o, targetRatio: v } })} options={IMAGE_RATIOS.slice(0, 6).map((r) => ({ value: r, label: r }))} />
        </Field>
      ) : (
        <div className="field">
          <div className="slots-2">
            {(["top", "bottom", "left", "right"] as const).map((s) => (
              <div key={s} className="row">
                <span className="small muted" style={{ width: 50 }}>{{ top: "Haut", bottom: "Bas", left: "Gauche", right: "Droite" }[s]}</span>
                <button className="btn sm icon" onClick={() => setSide(s, o[s] - step)} aria-label={`moins ${s}`}>−</button>
                <span className="mono" style={{ width: 44, textAlign: "center" }}>{o[s]}</span>
                <button className="btn sm icon" onClick={() => setSide(s, o[s] + step)} aria-label={`plus ${s}`}>+</button>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => set({ outpaint: { top: step, bottom: step, left: step, right: step, targetRatio: null } })}>
              Toutes directions
            </button>
            <button className="btn sm ghost" onClick={() => set({ outpaint: { top: 0, bottom: 0, left: 0, right: 0, targetRatio: null } })}>
              Réinitialiser
            </button>
          </div>
        </div>
      )}
      {source && (
        <div className="field">
          <div className="outpaint-box" style={{ aspectRatio: `${W}/${H}`, maxHeight: 260 }}>
            <div className="src" style={{ left: `${(left / W) * 100}%`, top: `${(top / H) * 100}%`, width: `${(w / W) * 100}%`, height: `${(h / H) * 100}%`, backgroundImage: `url(${source.thumbUrl ?? source.url})` }} />
          </div>
          <div className="hint">
            {w}×{h} → {W}×{H}
          </div>
        </div>
      )}
    </>
  );
}
