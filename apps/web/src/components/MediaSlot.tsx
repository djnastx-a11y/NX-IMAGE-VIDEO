import { useEffect, useRef, useState } from "react";
import type { Media } from "@nx/shared";
import { api, uploadMedia } from "../lib/api";
import { useData, useToast } from "../lib/store";
import { Icon } from "./icons";
import { Empty, Modal, Segmented } from "./ui";

const ACCEPT = { image: "image/png,image/jpeg,image/webp", video: "video/mp4,video/quicktime,video/webm" };

/** Upload by click / drag & drop, or pick an existing media from the library. */
export function MediaSlot({
  kind,
  value,
  onChange,
  title,
  subtitle,
  compact,
}: {
  kind: "image" | "video";
  value: Media | null;
  onChange(m: Media | null): void;
  title: string;
  subtitle?: string;
  compact?: boolean;
}) {
  const { currentProject } = useData();
  const { push } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setProgress(0);
    try {
      const m = await uploadMedia(file, { projectId: currentProject, onProgress: setProgress });
      if (m.kind !== kind) {
        push("error", kind === "image" ? "Ce champ attend une image" : "Ce champ attend une vidéo");
        return;
      }
      onChange(m);
    } catch (e) {
      push("error", (e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  if (value) {
    return (
      <div className="slot filled" style={compact ? { minHeight: 90 } : undefined}>
        {value.kind === "video" ? (
          <video src={value.url} poster={value.thumbUrl ?? undefined} muted playsInline loop autoPlay />
        ) : (
          <img src={value.thumbUrl ?? value.url} alt={title} />
        )}
        <span className="slot-tag pill">{title}</span>
        <div className="slot-actions">
          <button type="button" className="btn sm icon" title="Remplacer" onClick={() => setPicking(true)}>
            <Icon name="refresh" />
          </button>
          <button type="button" className="btn sm icon" title="Retirer" onClick={() => onChange(null)}>
            <Icon name="x" />
          </button>
        </div>
        {picking && <MediaPicker kind={kind} onClose={() => setPicking(false)} onPick={(m) => (onChange(m), setPicking(false))} onUpload={() => input.current?.click()} />}
        <input ref={input} type="file" hidden accept={ACCEPT[kind]} onChange={(e) => void upload(e.target.files?.[0])} />
      </div>
    );
  }

  return (
    <>
      <div
        className={`slot${drag ? " drag" : ""}`}
        style={compact ? { minHeight: 90 } : undefined}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void upload(e.dataTransfer.files?.[0]);
        }}
      >
        <div className="slot-inner">
          {progress !== null ? (
            <div className="col" style={{ alignItems: "center" }}>
              <div className="spinner" />
              <span>Envoi… {Math.round(progress * 100)}%</span>
            </div>
          ) : (
            <>
              <Icon name="upload" style={{ width: 22, height: 22, margin: "0 auto 6px" }} />
              <strong>{title}</strong>
              {subtitle ?? (kind === "image" ? "PNG, JPEG, WebP — glisser-déposer ou cliquer" : "MP4, MOV, WebM — glisser-déposer ou cliquer")}
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPicking(true);
                  }}
                >
                  <Icon name="grid" /> Bibliothèque
                </button>
              </div>
            </>
          )}
        </div>
        {progress !== null && <div className="upbar" style={{ width: `${progress * 100}%` }} />}
        <input ref={input} type="file" hidden accept={ACCEPT[kind]} onChange={(e) => void upload(e.target.files?.[0])} />
      </div>
      {picking && <MediaPicker kind={kind} onClose={() => setPicking(false)} onPick={(m) => (onChange(m), setPicking(false))} onUpload={() => (setPicking(false), input.current?.click())} />}
    </>
  );
}

export function MediaPicker({ kind, onPick, onClose, onUpload }: { kind: "image" | "video"; onPick(m: Media): void; onClose(): void; onUpload?(): void }) {
  const [section, setSection] = useState<"all" | "generated" | "uploads" | "favorites">("all");
  const [items, setItems] = useState<Media[] | null>(null);
  const { currentProject } = useData();
  const [onlyProject, setOnlyProject] = useState(!!currentProject);
  useEffect(() => {
    setItems(null);
    api
      .media({ section: section === "all" ? (kind === "image" ? "images" : "videos") : section, projectId: onlyProject && currentProject ? currentProject : undefined, limit: 120 })
      .then((r) => setItems(r.items.filter((m) => m.kind === kind)))
      .catch(() => setItems([]));
  }, [section, kind, onlyProject, currentProject]);
  return (
    <Modal
      title={kind === "image" ? "Choisir une image" : "Choisir une vidéo"}
      onClose={onClose}
      wide
      actions={
        onUpload && (
          <button className="btn sm" onClick={onUpload}>
            <Icon name="upload" /> Importer
          </button>
        )
      }
    >
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <Segmented
          value={section}
          onChange={setSection}
          options={[
            { value: "all", label: "Tout" },
            { value: "generated", label: "Générés" },
            { value: "uploads", label: "Imports" },
            { value: "favorites", label: "Favoris" },
          ]}
        />
        {currentProject && (
          <label className="row small muted" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={onlyProject} onChange={(e) => setOnlyProject(e.target.checked)} /> Projet courant uniquement
          </label>
        )}
      </div>
      {items === null ? (
        <div className="empty">
          <div className="spinner" style={{ margin: "0 auto" }} />
        </div>
      ) : items.length === 0 ? (
        <Empty title="Rien ici pour l'instant" />
      ) : (
        <div className="media-grid">
          {items.map((m) => (
            <div key={m.id} className="media-tile" onClick={() => onPick(m)} role="button" tabIndex={0}>
              <img src={m.thumbUrl ?? m.url} alt="" loading="lazy" />
              <div className="tile-top">
                <span className="pill">{m.source === "upload" ? "Import" : "Généré"}</span>
                {m.kind === "video" && <span className="pill">{m.durationSec?.toFixed(0)}s</span>}
              </div>
              {(m.prompt || m.originalName) && <div className="tile-bot ellipsis">{m.prompt || m.originalName}</div>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
