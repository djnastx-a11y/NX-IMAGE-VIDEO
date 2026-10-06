import { useEffect, useState } from "react";
import {
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  firstLastFrames,
  missingVideoInputs,
  videoParamsSchema,
  videoSize,
  type Job,
  type Media,
  type Preset,
  type VideoOperation,
  type VideoParams,
} from "@nx/shared";
import { api } from "../lib/api";
import { useData, useJobs, useToast } from "../lib/store";
import { Icon } from "./icons";
import { MediaSlot } from "./MediaSlot";
import { CameraPicker, ModelSelect, PresetBar, SeedField, useCapabilities } from "./controls";
import { Field, Segmented, Slider, Toggle } from "./ui";

const OPS: { op: VideoOperation; label: string }[] = [
  { op: "text_to_video", label: "Text to Video" },
  { op: "image_to_video", label: "Image to Video" },
  { op: "first_last_frame", label: "First / Last Frame" },
  { op: "video_to_video", label: "Video to Video" },
];

export interface VideoComposerInit {
  job?: Job;
  imageMediaId?: string;
  videoMediaId?: string;
}

export function VideoComposer({ init, onCreated }: { init?: VideoComposerInit; onCreated?(jobs: Job[]): void }) {
  const { currentProject } = useData();
  const { upsert } = useJobs();
  const { push } = useToast();
  const [p, setP] = useState<VideoParams>(() => videoParamsSchema.parse({ operation: "text_to_video" }));
  const [m, setM] = useState<{ image: Media | null; first: Media | null; last: Media | null; video: Media | null; ref: Media | null }>({ image: null, first: null, last: null, video: null, ref: null });
  const [count, setCount] = useState(1);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<VideoParams>) => setP((x) => ({ ...x, ...patch }));
  const op = p.operation;
  const cap = useCapabilities("video", op, p.model);
  const has = (c: string) => cap.caps.has(c);

  useEffect(() => {
    if (!init) return;
    if (init.job) {
      const jp = videoParamsSchema.parse(init.job.params);
      const byId = new Map(init.job.sources.map((s) => [s.id, s]));
      const fl = firstLastFrames(jp);
      // an Extend job is reused as the image-to-video settings it was made from
      setP({ ...jp, operation: jp.operation === "extend" ? "image_to_video" : jp.operation, extendMediaId: null });
      setM({
        image: byId.get(jp.sourceImageId ?? "") ?? null,
        first: byId.get(fl.first ?? "") ?? null,
        last: byId.get(fl.last ?? "") ?? null,
        video: byId.get(jp.sourceVideoId ?? "") ?? null,
        ref: byId.get(jp.referenceImageId ?? "") ?? null,
      });
    } else if (init.imageMediaId) {
      api.mediaItem(init.imageMediaId).then((img) => setM((x) => ({ ...x, image: img })), () => {});
      set({ operation: "image_to_video" });
    } else if (init.videoMediaId) {
      api.mediaItem(init.videoMediaId).then((v) => setM((x) => ({ ...x, video: v })), () => {});
      set({ operation: "video_to_video" });
    }
  }, [init]);

  const full: VideoParams = {
    ...p,
    sourceImageId: op === "image_to_video" ? m.image?.id ?? null : null,
    keyframes: op === "first_last_frame" ? [m.first && { mediaId: m.first.id, position: 0 }, m.last && { mediaId: m.last.id, position: 1 }].filter((k): k is { mediaId: string; position: number } => !!k) : [],
    sourceVideoId: op === "video_to_video" ? m.video?.id ?? null : null,
    referenceImageId: has("reference_image") ? m.ref?.id ?? null : null,
  };
  const missing = missingVideoInputs(full);
  const size = videoSize(p);
  const durations = [5, 10, 15];

  const generate = async () => {
    setBusy(true);
    try {
      const jobs = await api.createJob({ module: "video", projectId: currentProject, params: full, count });
      upsert(jobs);
      onCreated?.(jobs);
      push("success", jobs.length > 1 ? `${jobs.length} variantes ajoutées à la file` : "Génération ajoutée à la file");
    } catch (e) {
      push("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = (pr: Preset) => setP((x) => videoParamsSchema.parse({ ...x, ...pr.params, operation: (pr.params as Partial<VideoParams>).operation ?? x.operation }));
  const presetParams = () => {
    const { sourceImageId: _a, keyframes: _b, sourceVideoId: _c, referenceImageId: _d, extendMediaId: _e, ...rest } = p;
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
        <PresetBar module="video" onApply={applyPreset} current={presetParams} />

        {op === "image_to_video" && (
          <div className="field">
            <MediaSlot kind="image" title="Image" value={m.image} onChange={(v) => setM((x) => ({ ...x, image: v }))} />
          </div>
        )}
        {op === "first_last_frame" && (
          <div className="field slots-2">
            <MediaSlot compact kind="image" title="Première image" subtitle="Image de départ" value={m.first} onChange={(v) => setM((x) => ({ ...x, first: v }))} />
            <MediaSlot compact kind="image" title="Dernière image" subtitle="Image de fin" value={m.last} onChange={(v) => setM((x) => ({ ...x, last: v }))} />
          </div>
        )}
        {op === "video_to_video" && (
          <div className="field">
            <MediaSlot kind="video" title="Vidéo source" value={m.video} onChange={(v) => setM((x) => ({ ...x, video: v }))} />
          </div>
        )}

        <Field label={op === "text_to_video" ? "Prompt" : op === "first_last_frame" ? "Prompt de transition" : "Prompt mouvement"}>
          <textarea
            className="textarea"
            value={p.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            placeholder={op === "text_to_video" ? "Décris la scène, le sujet, l'action, l'ambiance…" : op === "image_to_video" ? "Décris le mouvement : ce qui bouge, comment, la caméra…" : op === "first_last_frame" ? "Comment passer de la première à la dernière image…" : "Le nouveau style ou la transformation…"}
          />
        </Field>
        {has("negative_prompt") && (
          <Field label="Negative prompt">
            <input className="input" value={p.negativePrompt} onChange={(e) => set({ negativePrompt: e.target.value })} placeholder="morphing, visages déformés, scintillement, texte…" />
          </Field>
        )}

        <Field label="Durée">
          <Segmented
            value={p.duration}
            onChange={(v) => set({ duration: v })}
            options={durations.map((d) => ({ value: d, label: `${d} s`, disabled: cap.maxDuration > 0 && d > cap.maxDuration, title: cap.maxDuration && d > cap.maxDuration ? `Max ${cap.maxDuration}s pour ce modèle` : undefined }))}
          />
        </Field>
        {op !== "video_to_video" && (
          <Field label="Format" right={<span className="val tiny">{size.width}×{size.height}</span>}>
            <Segmented wrap value={p.aspectRatio} onChange={(v) => set({ aspectRatio: v })} options={VIDEO_RATIOS.map((r) => ({ value: r, label: r }))} />
          </Field>
        )}

        {has("camera_control") && <CameraPicker value={p.camera.move} intensity={p.camera.intensity} onChange={(move, intensity) => set({ camera: { move, intensity } })} />}

        <Slider label="Motion strength" value={p.motionStrength} min={0} max={1} onChange={(v) => set({ motionStrength: v })} />
        {op === "image_to_video" && <Slider label="Fidélité à l'image source" value={p.sourceFidelity} min={0} max={1} onChange={(v) => set({ sourceFidelity: v })} hint="Élevée = l'image source est conservée au maximum." />}
        {op === "video_to_video" && (
          <>
            <Slider label="Strength" value={p.videoStrength} min={0} max={1} onChange={(v) => set({ videoStrength: v })} hint="Intensité de la transformation." />
            <div className="field">
              <div className="label">Conserver</div>
              <Toggle label="Mouvement" checked={p.preserve.motion} onChange={(v) => set({ preserve: { ...p.preserve, motion: v } })} />
              <Toggle label="Composition" checked={p.preserve.composition} onChange={(v) => set({ preserve: { ...p.preserve, composition: v } })} />
              <Toggle label="Structure" checked={p.preserve.structure} onChange={(v) => set({ preserve: { ...p.preserve, structure: v } })} />
              <Toggle label="Personnage" checked={p.preserve.character} onChange={(v) => set({ preserve: { ...p.preserve, character: v } })} />
              {has("face_preservation") && <Toggle label="Visage" checked={p.preserve.face} onChange={(v) => set({ preserve: { ...p.preserve, face: v } })} />}
            </div>
          </>
        )}

        <Field label="Variantes">
          <Segmented value={count} onChange={setCount} options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))} />
        </Field>

        <button type="button" className="advanced-toggle" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
          Réglages avancés <Icon name={advanced ? "x" : "plus"} style={{ width: 14, height: 14 }} />
        </button>
        {advanced && (
          <div style={{ paddingTop: 8 }}>
            <ModelSelect module="video" op={op} value={p.model} onChange={(v) => set({ model: v })} />
            <Field label="Résolution">
              <Segmented
                value={p.resolution}
                onChange={(v) => set({ resolution: v })}
                options={Object.keys(VIDEO_RESOLUTIONS).map((r) => ({ value: r as VideoParams["resolution"], label: r, disabled: cap.resolutions.size > 0 && !cap.resolutions.has(r) }))}
              />
            </Field>
            {has("seed") && <SeedField value={p.seed} onChange={(v) => set({ seed: v })} />}
            {has("subject_motion") && <Slider label="Mouvement du sujet" value={p.subjectMotion} min={0} max={1} onChange={(v) => set({ subjectMotion: v })} />}
            <Slider label="Creativity" value={p.creativity} min={0} max={1} onChange={(v) => set({ creativity: v })} hint="Faible = suit le prompt / la source de près." />
            <Slider label="Prompt adherence" value={p.promptAdherence} min={1} max={20} step={0.5} format={(v) => v.toFixed(1)} onChange={(v) => set({ promptAdherence: v })} />
            <Field label="Qualité">
              <Segmented value={p.quality} onChange={(v) => set({ quality: v })} options={[{ value: "fast", label: "Rapide" }, { value: "standard", label: "Standard" }, { value: "high", label: "Haute" }]} />
            </Field>
            {has("fps") && (
              <Field label="FPS">
                <Segmented value={p.fps} onChange={(v) => set({ fps: v })} options={[16, 24, 30].map((f) => ({ value: f, label: String(f) }))} />
              </Field>
            )}
            {has("reference_image") && (
              <Field label="Image de référence (style / personnage)">
                <MediaSlot compact kind="image" title="Référence" value={m.ref} onChange={(v) => setM((x) => ({ ...x, ref: v }))} />
              </Field>
            )}
          </div>
        )}
      </div>
      <div className="composer-foot">
        {cap.none && <div className="job-error" style={{ marginBottom: 8 }}>Aucun moteur disponible pour cette opération.</div>}
        <button className="btn primary generate" disabled={busy || missing.length > 0 || cap.none} onClick={generate}>
          {busy ? <div className="spinner" /> : <Icon name="sparkles" />}
          GENERATE{count > 1 ? ` ×${count}` : ""}
        </button>
        {missing.length > 0 && <div className="hint" style={{ textAlign: "center" }}>Manquant : {missing.join(", ")}</div>}
      </div>
    </div>
  );
}
