import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { STATUS_LABEL, type JobStatus } from "@nx/shared";
import { useData, useToast } from "../lib/store";
import { Icon } from "./icons";

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  wrap,
}: {
  value: T;
  options: { value: NoInfer<T>; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  wrap?: boolean;
}) {
  return (
    <div className={`seg${wrap ? " wrap" : ""}`} role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "on" : ""}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  format = (v: number) => v.toFixed(2),
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(v: number): void;
  format?: (v: number) => string;
  hint?: string;
}) {
  return (
    <div className="field">
      <div className="label">
        <span>{label}</span>
        <span className="val">{format(value)}</span>
      </div>
      <input className="range" type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: ReactNode }) {
  return (
    <label className="row" style={{ justifyContent: "space-between", cursor: "pointer", padding: "4px 0" }}>
      <span className="small" style={{ color: "var(--text-2)", fontWeight: 600 }}>
        {label}
      </span>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
    </label>
  );
}

export function Field({ label, children, hint, right }: { label: ReactNode; children: ReactNode; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div className="field">
      <div className="label">
        <span>{label}</span>
        {right}
      </div>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function StatusBadge({ status }: { status: JobStatus }) {
  const live = ["queued", "starting", "processing", "encoding"].includes(status);
  return (
    <span className={`badge ${status}`}>
      <span className={`dot${live ? " pulse" : ""}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Modal({ title, onClose, children, wide, actions }: { title: ReactNode; onClose(): void; children: ReactNode; wide?: boolean; actions?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  // portal: a modal opened from inside a sticky panel must not be trapped in its stacking context
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal>
        <div className="modal-head">
          <h3>{title}</h3>
          {actions}
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Fermer">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ProjectSelect({ value, onChange, allowAll }: { value: string | null; onChange(v: string | null): void; allowAll?: boolean }) {
  const { projects } = useData();
  return (
    <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} aria-label="Projet">
      <option value="">{allowAll ? "Tous les projets" : "Sans projet"}</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useToast();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <Icon name={t.kind === "error" ? "alert" : t.kind === "success" ? "check" : "info"} style={{ width: 16, height: 16, flex: "none", marginTop: 1 }} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{title}</div>
      {children}
    </div>
  );
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(0)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);
export const fmtDate = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
export const fmtDuration = (ms: number | null) => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
