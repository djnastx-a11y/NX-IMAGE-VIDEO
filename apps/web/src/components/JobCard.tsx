import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CAMERA_LABEL, OPERATION_LABEL, type Job, type JobLog, type Media, type ParamsView } from "@nx/shared";
import { api } from "../lib/api";
import { useJobs, useLiveJob, useToast } from "../lib/store";
import { Icon } from "./icons";
import { fmtDate, fmtDuration, Modal, Segmented, StatusBadge } from "./ui";

const ACTIVE = ["queued", "starting", "processing", "encoding"];
/** How a job was created, when it is not a plain generation (Extend already shows as the operation). */
const KIND_LABEL: Partial<Record<Job["kind"], string>> = { regenerate: "Regenerate", variation: "Variation", duplicate: "Copie", animate: "Animate" };

function useJobActions(job: Job, onReuse?: (j: Job) => void) {
  const { upsert, remove } = useJobs();
  const { push } = useToast();
  const nav = useNavigate();
  const run = async (label: string, fn: () => Promise<Job[] | Job | void>) => {
    try {
      const r = await fn();
      if (Array.isArray(r)) upsert(r);
      else if (r) upsert([r]);
      push("success", label);
    } catch (e) {
      push("error", (e as Error).message);
    }
  };
  return {
    cancel: () => run("Génération annulée", () => api.cancel(job.id)),
    retry: () => run("Relancée", () => api.retry(job.id)),
    regenerate: () => run("Nouvelle génération lancée", () => api.regenerate(job.id)),
    variation: (level: string, sameSeed = false, outputIndex = 0) =>
      run("Variations lancées", () => api.variation(job.id, { level, sameSeed, outputIndex, count: job.module === "image" ? 2 : 2 })),
    duplicate: () => run("Copie exacte lancée", () => api.duplicate(job.id)),
    extend: (s: number) => run(`Prolongation de ${s}s lancée`, () => api.extend(job.id, s)),
    reuse: () => (onReuse ? onReuse(job) : nav(`/${job.module}?from=${job.id}`)),
    animate: (m: Media) => nav(`/video?image=${m.id}`),
    editImage: (m: Media) => nav(`/image?op=edit&source=${m.id}`),
    favorite: async () => {
      const fav = !job.outputs.every((o) => o.favorite);
      try {
        await Promise.all(job.outputs.map((o) => api.updateMedia(o.id, { favorite: fav })));
        upsert([await api.job(job.id)]);
        push("success", fav ? "Ajouté aux favoris" : "Retiré des favoris");
      } catch (e) {
        push("error", (e as Error).message);
      }
    },
    del: async () => {
      if (!confirm("Supprimer cette génération et ses résultats ?")) return;
      try {
        await api.deleteJob(job.id);
        remove(job.id);
        push("success", "Supprimé");
      } catch (e) {
        push("error", (e as Error).message);
      }
    },
  };
}

function ratioOf(job: Job) {
  const o = job.outputs[0];
  if (o?.width && o?.height) return `${o.width}/${o.height}`;
  const p = job.params as { aspectRatio?: string };
  return p.aspectRatio ? p.aspectRatio.replace(":", "/") : "16/10";
}

export function JobCard({ job: snapshot, onReuse, onOpen }: { job: Job; onReuse?: (j: Job) => void; onOpen?: (j: Job) => void }) {
  const job = useLiveJob(snapshot);
  const a = useJobActions(job, onReuse);
  const [viewer, setViewer] = useState<number | null>(null);
  const active = ACTIVE.includes(job.status);
  const p = job.params as ParamsView;
  const text = job.operation === "edit" ? p.instruction || p.prompt : p.prompt;
  const fav = job.outputs.length > 0 && job.outputs.every((o) => o.favorite);
  const open = (i = 0) => (onOpen ? onOpen(job) : setViewer(i));

  return (
    <div className="card job-card" data-status={job.status} data-job={job.id}>
      <div className="job-media" style={{ aspectRatio: ratioOf(job), maxHeight: 420 }}>
        {job.status === "completed" && job.outputs.length > 0 ? (
          job.module === "video" ? (
            <video src={job.outputs[0]!.url} poster={job.outputs[0]!.thumbUrl ?? undefined} controls playsInline loop preload="metadata" />
          ) : job.outputs.length === 1 ? (
            <img src={job.outputs[0]!.url} alt={text} onClick={() => open(0)} style={{ cursor: "zoom-in" }} />
          ) : (
            <div className="multi">
              {job.outputs.map((o, i) => (
                <img key={o.id} src={o.thumbUrl ?? o.url} alt="" onClick={() => open(i)} />
              ))}
            </div>
          )
        ) : (
          <div className="placeholder">
            {active && <div className="shimmer" />}
            {active ? (
              <>
                <div className="pct">{Math.round(job.progress * 100)}%</div>
                <div className="small">
                  {job.status === "queued" ? (job.queuePosition ? `Position ${job.queuePosition} dans la file` : job.stage ?? "En file d'attente") : job.stage ?? ""}
                </div>
                <div className="progress" style={{ width: "70%" }}>
                  <div style={{ width: `${Math.max(2, job.progress * 100)}%` }} />
                </div>
              </>
            ) : (
              <>
                <Icon name={job.status === "failed" ? "alert" : "stop"} style={{ width: 28, height: 28 }} />
                <div className="small">{job.status === "failed" ? "Échec" : "Annulé"}</div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="job-body">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <StatusBadge status={job.status} />
          <span className="tiny muted">{fmtDate(job.createdAt)}</span>
        </div>
        <div className="job-prompt" title={text}>
          {text || <span className="muted">Sans prompt</span>}
        </div>
        <div className="job-meta">
          <span>{OPERATION_LABEL[job.operation]}</span>
          {KIND_LABEL[job.kind] && <span>{KIND_LABEL[job.kind]}</span>}
          {job.module === "video" ? (
            <>
              <span>{job.operation === "extend" ? `+${p.duration}s` : `${p.duration}s`}</span>
              <span>{p.aspectRatio}</span>
              <span>{p.resolution}</span>
              {p.camera?.move !== "static" && <span>{CAMERA_LABEL[p.camera.move]}</span>}
            </>
          ) : (
            <>
              {job.operation !== "upscale" && <span>{p.aspectRatio}</span>}
              {job.outputs.length > 1 && <span>×{job.outputs.length}</span>}
            </>
          )}
          {job.providerId && <span>{job.providerId}</span>}
          {job.durationMs != null && job.status === "completed" && <span>{fmtDuration(job.durationMs)}</span>}
          {job.attempts > 1 && <span>essai {job.attempts}</span>}
        </div>
        {job.error && job.status !== "completed" && <div className="job-error">{job.error}</div>}
        <div className="job-actions">
          {active && (
            <button className="btn sm" onClick={a.cancel}>
              <Icon name="stop" /> Annuler
            </button>
          )}
          {["failed", "cancelled"].includes(job.status) && (
            <button className="btn sm" onClick={a.retry}>
              <Icon name="refresh" /> Retry
            </button>
          )}
          {job.status === "completed" && (
            <>
              {job.outputs[0] && (
                <a className="btn sm icon" href={`${job.outputs[0].url}?download=1`} title="Télécharger" download>
                  <Icon name="download" />
                </a>
              )}
              <button className="btn sm icon" onClick={a.regenerate} title="Regenerate (nouvelle seed)">
                <Icon name="refresh" />
              </button>
              <button className="btn sm icon" onClick={() => a.variation("medium")} title="Variation">
                <Icon name="shuffle" />
              </button>
              {job.module === "video" && (
                <button className="btn sm" onClick={() => a.extend(5)} title="Prolonger de 5 secondes">
                  +5s
                </button>
              )}
              {job.module === "image" && job.outputs[0] && (
                <button className="btn sm" onClick={() => a.animate(job.outputs[0]!)} title="Animate in NX VIDEO">
                  <Icon name="film" /> Animate
                </button>
              )}
              <button className={`btn sm icon${fav ? " primary" : ""}`} onClick={a.favorite} title="Favori">
                <Icon name="heart" />
              </button>
            </>
          )}
          <button className="btn sm icon" onClick={a.reuse} title="Réutiliser les réglages">
            <Icon name="copy" />
          </button>
          <button className="btn sm icon ghost" onClick={() => open(0)} title="Détails">
            <Icon name="more" />
          </button>
        </div>
      </div>
      {viewer !== null && <JobViewer job={job} index={viewer} onClose={() => setViewer(null)} onReuse={onReuse} />}
    </div>
  );
}

/** Full detail: large preview, every parameter, logs, all actions. */
export function JobViewer({ job: snapshot, index = 0, onClose, onReuse }: { job: Job; index?: number; onClose(): void; onReuse?: (j: Job) => void }) {
  const job = useLiveJob(snapshot);
  const a = useJobActions(job, onReuse);
  const [i, setI] = useState(index);
  const [logs, setLogs] = useState<JobLog[] | null>(null);
  const [tab, setTab] = useState<"params" | "logs">("params");
  const [level, setLevel] = useState("medium");
  const [fmt, setFmt] = useState<"png" | "jpeg" | "webp">("png");
  const [ext, setExt] = useState(5);
  const out = job.outputs[i] ?? job.outputs[0];
  const p = job.params as unknown as Record<string, unknown>;

  useEffect(() => {
    if (tab === "logs") api.jobLogs(job.id).then(setLogs, () => setLogs([]));
  }, [tab, job.id, job.status]);

  return (
    <Modal title={`${OPERATION_LABEL[job.operation]} · ${fmtDate(job.createdAt)}`} onClose={onClose} wide actions={<StatusBadge status={job.status} />}>
      <div className="viewer">
        <div className="col">
          <div className="viewer-media">
            {out ? out.kind === "video" ? <video src={out.url} controls autoPlay loop playsInline /> : <img src={out.url} alt="" /> : <div className="muted">{job.stage ?? job.error ?? "Pas encore de résultat"}</div>}
          </div>
          {job.outputs.length > 1 && (
            <div className="hstack-scroll">
              {job.outputs.map((o, n) => (
                <img key={o.id} src={o.thumbUrl ?? o.url} alt="" onClick={() => setI(n)} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, cursor: "pointer", outline: n === i ? "2px solid var(--accent)" : "none" }} />
              ))}
            </div>
          )}
          {job.sources.length > 0 && (
            <div>
              <div className="section-title">Fichiers source</div>
              <div className="hstack-scroll">
                {job.sources.map((m) => (
                  <img key={m.id} src={m.thumbUrl ?? m.url} alt="" title={m.originalName ?? m.kind} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8 }} />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="col">
          {job.status === "completed" && out && (
            <div className="card card-pad col">
              <div className="section-title" style={{ margin: 0 }}>Actions</div>
              <div className="row">
                {out.kind === "image" ? (
                  <>
                    <select className="select" value={fmt} onChange={(e) => setFmt(e.target.value as typeof fmt)} style={{ width: 96 }} aria-label="Format">
                      <option value="png">PNG</option>
                      <option value="jpeg">JPEG</option>
                      <option value="webp">WebP</option>
                    </select>
                    <a className="btn primary grow" href={`${out.url}?format=${fmt}`} download>
                      <Icon name="download" /> Télécharger
                    </a>
                  </>
                ) : (
                  <a className="btn primary grow" href={`${out.url}?download=1`} download>
                    <Icon name="download" /> Télécharger MP4
                  </a>
                )}
              </div>
              <div className="row wrap">
                <button className="btn sm" onClick={a.regenerate}>
                  <Icon name="refresh" /> Regenerate
                </button>
                <button className="btn sm" onClick={a.duplicate}>
                  <Icon name="copy" /> Dupliquer
                </button>
                <button className="btn sm" onClick={a.reuse}>
                  <Icon name="undo" /> Réutiliser
                </button>
                <button className="btn sm" onClick={a.favorite}>
                  <Icon name="heart" /> Favori
                </button>
              </div>
              <div className="row">
                <select className="select" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Niveau de variation">
                  <option value="subtle">Variation faible</option>
                  <option value="medium">Variation moyenne</option>
                  <option value="strong">Variation forte</option>
                </select>
                <button className="btn sm" onClick={() => a.variation(level, false, i)}>
                  <Icon name="shuffle" /> Varier
                </button>
                <button className="btn sm" onClick={() => a.variation(level, true, i)} title="Même seed">
                  =seed
                </button>
              </div>
              {job.module === "video" ? (
                <div className="row">
                  <Segmented value={ext} onChange={setExt} options={[{ value: 5, label: "+5 s" }, { value: 10, label: "+10 s" }, { value: 15, label: "+15 s" }]} />
                  <button className="btn sm" onClick={() => a.extend(ext)}>
                    Extend
                  </button>
                </div>
              ) : (
                <div className="row wrap">
                  <button className="btn sm primary" onClick={() => a.animate(out)}>
                    <Icon name="film" /> Animate in NX VIDEO
                  </button>
                  <button className="btn sm" onClick={() => a.editImage(out)}>
                    <Icon name="wand" /> Modifier
                  </button>
                </div>
              )}
            </div>
          )}
          {ACTIVE.includes(job.status) && (
            <div className="card card-pad col">
              <div className="progress">
                <div style={{ width: `${job.progress * 100}%` }} />
              </div>
              <div className="small muted">{job.stage}</div>
              <button className="btn sm" onClick={a.cancel}>
                <Icon name="stop" /> Annuler
              </button>
            </div>
          )}
          {["failed", "cancelled"].includes(job.status) && (
            <div className="card card-pad col">
              {job.error && <div className="job-error">{job.error}</div>}
              <button className="btn sm" onClick={a.retry}>
                <Icon name="refresh" /> Retry
              </button>
            </div>
          )}
          <Segmented value={tab} onChange={setTab} options={[{ value: "params", label: "Paramètres" }, { value: "logs", label: "Logs" }]} />
          {tab === "params" ? (
            <dl className="kv">
              <dt>Statut</dt>
              <dd>{job.status}{job.stage ? ` · ${job.stage}` : ""}</dd>
              <dt>Provider</dt>
              <dd>{job.providerId ?? "—"}</dd>
              <dt>Modèle</dt>
              <dd>{job.model ?? String(p.model)}</dd>
              <dt>Temps</dt>
              <dd>{fmtDuration(job.durationMs)}</dd>
              <dt>Tentatives</dt>
              <dd>
                {job.attempts} / {job.maxAttempts}
              </dd>
              <dt>Priorité</dt>
              <dd>{job.priority}</dd>
              {Object.entries(p)
                .filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0))
                .map(([k, v]) => (
                  <FragmentKV key={k} k={k} v={v} />
                ))}
            </dl>
          ) : logs === null ? (
            <div className="spinner" />
          ) : (
            <div className="col" style={{ gap: 6 }}>
              {logs.map((l, n) => (
                <div key={n} className="mono" style={{ color: l.level === "error" ? "var(--danger)" : l.level === "warn" ? "var(--warning)" : "var(--text-2)" }}>
                  <span className="muted">{new Date(l.at).toLocaleTimeString("fr-FR")}</span> {l.message}
                  {l.data ? <span className="muted"> {JSON.stringify(l.data)}</span> : null}
                </div>
              ))}
            </div>
          )}
          <button className="btn sm danger ghost" onClick={async () => (await a.del(), onClose())}>
            <Icon name="trash" /> Supprimer
          </button>
        </div>
      </div>
    </Modal>
  );
}

function FragmentKV({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={typeof v === "object" ? "mono" : undefined}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
    </>
  );
}
