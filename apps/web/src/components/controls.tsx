import { useEffect, useState } from "react";
import { CAMERA_LABEL, CAMERA_MOVES, type CameraMove, type Module, type Operation, type Preset, type ProviderInfo } from "@nx/shared";
import { api } from "../lib/api";
import { useData, useToast } from "../lib/store";
import { Icon } from "./icons";
import { Field, Modal } from "./ui";

/** Providers able to run an operation (enabled ones first). */
export function providersFor(providers: ProviderInfo[], module: Module, op: Operation) {
  return providers.filter((p) => p.module === module && p.capabilities.includes(op as never) && p.enabled);
}

/**
 * Capabilities of the current model choice. For "auto" this is the union over the available providers
 * able to run the operation, so the UI only shows settings that some engine will honour.
 */
export function useCapabilities(module: Module, op: Operation, model: string) {
  const { providers } = useData();
  const candidates = providersFor(providers, module, op).filter((p) => (model === "auto" ? p.available : p.id === model || p.engine === model));
  const caps = new Set<string>(candidates.flatMap((p) => p.capabilities));
  const durations = [...new Set(candidates.flatMap((p) => p.limits.durations ?? []))].sort((a, b) => a - b);
  const maxDuration = Math.max(0, ...candidates.map((p) => p.limits.maxDuration ?? 0));
  const resolutions = new Set(candidates.flatMap((p) => p.limits.resolutions ?? []));
  const maxOutputs = Math.max(1, ...candidates.map((p) => p.limits.maxOutputs ?? 1));
  return { caps, candidates, durations, maxDuration, resolutions, maxOutputs, none: candidates.length === 0 };
}

export function ModelSelect({ module, op, value, onChange }: { module: Module; op: Operation; value: string; onChange(v: string): void }) {
  const { providers } = useData();
  const list = providersFor(providers, module, op);
  const current = list.find((p) => p.id === value);
  return (
    <Field label="Modèle" hint={value === "auto" ? "Auto choisit le meilleur moteur disponible pour ce type de génération." : current?.description}>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Modèle">
        <option value="auto">Auto (meilleur moteur)</option>
        {list.map((p) => (
          <option key={p.id} value={p.id} disabled={!p.available}>
            {p.name} · {p.backend}
            {p.available ? "" : ` — ${p.unavailableReason}`}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function SeedField({ value, onChange }: { value: number | null; onChange(v: number | null): void }) {
  const locked = value !== null;
  return (
    <Field
      label="Seed"
      right={
        <label className="row tiny" style={{ cursor: "pointer", gap: 6 }}>
          <input type="checkbox" checked={locked} onChange={(e) => onChange(e.target.checked ? Math.floor(Math.random() * 2_147_483_647) : null)} />
          fixe
        </label>
      }
      hint={locked ? "Même seed + mêmes réglages = même résultat." : "Aléatoire à chaque génération."}
    >
      <div className="row">
        <input
          className="input mono"
          inputMode="numeric"
          placeholder="Aléatoire"
          value={value ?? ""}
          onChange={(e) => {
            const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
            onChange(Number.isFinite(n) ? Math.min(n, 2_147_483_647) : null);
          }}
          aria-label="Seed"
        />
        <button type="button" className="btn icon" title="Nouvelle seed" onClick={() => onChange(Math.floor(Math.random() * 2_147_483_647))}>
          <Icon name="shuffle" />
        </button>
      </div>
    </Field>
  );
}

const CAM_ICON: Partial<Record<CameraMove, string>> = {
  static: "M6 12h12",
  zoom_in: "M12 6v12M6 12h12",
  zoom_out: "M6 12h12",
  pan_left: "M18 12H6m4-4-4 4 4 4",
  pan_right: "M6 12h12m-4-4 4 4-4 4",
  tilt_up: "M12 18V6m-4 4 4-4 4 4",
  tilt_down: "M12 6v12m-4-4 4 4 4-4",
  dolly_in: "M7 17l10-10M11 7h6v6",
  dolly_out: "M17 7 7 17m0-6v6h6",
  orbit_left: "M19 12a7 4 0 1 1-3-3.3M9 8l-3 1 1 3",
  orbit_right: "M5 12a7 4 0 1 0 3-3.3M15 8l3 1-1 3",
  tracking: "M4 16h16M8 12l4-4 4 4",
  drone: "M12 8V4M8 8h8l-2 8h-4z",
  crane: "M5 19V9l7-5 7 5M12 4v15",
  handheld: "M4 12c2-3 4 3 6 0s4 3 6 0 3 3 4 0",
};

export function CameraPicker({ value, intensity, onChange, disabled }: { value: CameraMove; intensity: number; onChange(move: CameraMove, intensity: number): void; disabled?: boolean }) {
  return (
    <div className="field">
      <div className="label">
        <span>Camera control</span>
        <span className="val">{CAMERA_LABEL[value]}</span>
      </div>
      <div className="camera-grid">
        {CAMERA_MOVES.map((m) => (
          <button key={m} type="button" className={`camera-btn${m === value ? " on" : ""}`} disabled={disabled} onClick={() => onChange(m, intensity)} aria-pressed={m === value}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <rect x="2.5" y="2.5" width="19" height="19" rx="4" opacity=".25" />
              <path d={CAM_ICON[m]} />
            </svg>
            {CAMERA_LABEL[m]}
          </button>
        ))}
      </div>
      {value !== "static" && (
        <div style={{ marginTop: 10 }}>
          <div className="label">
            <span>Intensité caméra</span>
            <span className="val">{intensity}</span>
          </div>
          <input className="range" type="range" min={0} max={10} step={1} value={intensity} disabled={disabled} onChange={(e) => onChange(value, Number(e.target.value))} aria-label="Intensité caméra" />
        </div>
      )}
    </div>
  );
}

/** Built-in + personal presets: one tap applies, and current settings can be saved. */
export function PresetBar({ module, onApply, current }: { module: Module; onApply(p: Preset): void; current: () => Record<string, unknown> }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const { push } = useToast();
  const { currentProject } = useData();
  const load = () => api.presets(module).then(setPresets, () => {});
  useEffect(() => {
    void load();
  }, [module]);
  return (
    <div className="field">
      <div className="label">
        <span>Presets</span>
        <button type="button" className="btn ghost sm" onClick={() => setSaving(true)}>
          <Icon name="save" /> Sauver
        </button>
      </div>
      <div className="hstack-scroll">
        {presets.map((p) => (
          <button key={p.id} type="button" className="chip" title={p.description} onClick={() => (onApply(p), push("info", `Preset « ${p.name} » appliqué`))}>
            {!p.builtin && <Icon name="save" style={{ width: 12, height: 12 }} />}
            {p.name}
          </button>
        ))}
      </div>
      {saving && (
        <Modal title="Enregistrer un preset" onClose={() => setSaving(false)}>
          <Field label="Nom">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. DJ Promo Carolina" autoFocus />
          </Field>
          <p className="small muted">Le preset garde le modèle, le format, la durée, la caméra, le mouvement, la seed, les réglages avancés et le negative prompt. Les fichiers source ne sont pas inclus.</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button
              className="btn primary"
              disabled={!name.trim()}
              onClick={async () => {
                try {
                  await api.createPreset({ module, name: name.trim(), projectId: currentProject, params: current() });
                  push("success", "Preset enregistré");
                  setSaving(false);
                  setName("");
                  void load();
                } catch (e) {
                  push("error", (e as Error).message);
                }
              }}
            >
              Enregistrer
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
