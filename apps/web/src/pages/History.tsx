import { useEffect, useState } from "react";
import { OPERATION_LABEL, type Job, type Module, type ParamsView } from "@nx/shared";
import { api } from "../lib/api";
import { useData, useJobs } from "../lib/store";
import { Layout } from "../components/Layout";
import { JobViewer } from "../components/JobCard";
import { Empty, fmtDate, fmtDuration, Segmented, StatusBadge } from "../components/ui";

type StatusFilter = "all" | "active" | "completed" | "failed";

/** Shared history of both modules: one row per generation, with every parameter one click away. */
export function HistoryPage() {
  const { byId, upsert, completedTick } = useJobs();
  const { currentProject, projects } = useData();
  const [module, setModule] = useState<Module | "all">("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(50);
  const [ids, setIds] = useState<string[] | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<Job | null>(null);

  useEffect(() => {
    let off = false;
    const t = setTimeout(() => {
      api
        .jobs({ module: module === "all" ? undefined : module, status: status === "all" ? undefined : status, projectId: currentProject ?? undefined, q: q || undefined, limit })
        .then((r) => {
          if (off) return;
          upsert(r.items);
          setIds(r.items.map((j) => j.id));
          setTotal(r.total);
        })
        .catch(() => setIds([]));
    }, q ? 250 : 0);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, [module, status, currentProject, q, limit, completedTick, upsert]);

  const rows = (ids ?? []).map((id) => byId.get(id)).filter((j): j is Job => !!j);
  const projectName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? "—";

  return (
    <Layout title="History">
      <div className="col" style={{ gap: 12, marginBottom: 16 }}>
        <div className="row wrap">
          <Segmented
            value={module}
            onChange={setModule}
            options={[
              { value: "all", label: "Tout" },
              { value: "image", label: "Images" },
              { value: "video", label: "Vidéos" },
            ]}
          />
          <Segmented
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "Tous statuts" },
              { value: "active", label: "En cours" },
              { value: "completed", label: "Terminés" },
              { value: "failed", label: "Échecs" },
            ]}
          />
        </div>
        <input className="input" placeholder="Rechercher dans les prompts…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Recherche" />
        <div className="small muted">{total} génération{total > 1 ? "s" : ""}</div>
      </div>

      {ids === null ? (
        <div className="empty">
          <div className="spinner" style={{ margin: "0 auto" }} />
        </div>
      ) : rows.length === 0 ? (
        <Empty title="Aucun historique">Chaque génération lancée apparaît ici avec tous ses paramètres.</Empty>
      ) : (
        <div className="card table-wrap">
          <table className="table history-table">
            <thead>
              <tr>
                <th />
                <th>Date</th>
                <th>Type</th>
                <th>Prompt</th>
                <th className="hide-sm">Projet</th>
                <th className="hide-sm">Moteur</th>
                <th className="hide-sm">Seed</th>
                <th>Statut</th>
                <th className="hide-sm">Durée</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => {
                const p = j.params as ParamsView;
                const thumb = j.outputs[0]?.thumbUrl ?? j.sources[0]?.thumbUrl;
                return (
                  <tr key={j.id} className="clickable" onClick={() => setOpen(j)} data-job={j.id}>
                    <td style={{ width: 56 }}>{thumb ? <img className="row-thumb" src={thumb} alt="" loading="lazy" /> : <div className="row-thumb" />}</td>
                    <td className="nowrap small">{fmtDate(j.createdAt)}</td>
                    <td className="nowrap small">
                      {j.module === "video" ? "Vidéo" : "Image"} · {OPERATION_LABEL[j.operation]}
                      {j.module === "video" && <span className="muted"> · {p.duration}s</span>}
                    </td>
                    <td>
                      <div className="ellipsis-2">{(j.operation === "edit" ? p.instruction : p.prompt) || <span className="muted">—</span>}</div>
                      {j.error && <div className="tiny" style={{ color: "var(--danger)" }}>{j.error}</div>}
                    </td>
                    <td className="hide-sm small">{projectName(j.projectId)}</td>
                    <td className="hide-sm small mono">{j.providerId ?? "auto"}</td>
                    <td className="hide-sm small mono">{j.params.seed ?? "aléatoire"}</td>
                    <td>
                      <StatusBadge status={j.status} />
                      {["processing", "encoding"].includes(j.status) && <span className="tiny muted"> {Math.round(j.progress * 100)}%</span>}
                    </td>
                    <td className="hide-sm small">{fmtDuration(j.durationMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total > rows.length && rows.length > 0 && (
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <button className="btn" onClick={() => setLimit((l) => l + 50)}>
            Voir plus
          </button>
        </div>
      )}
      {open && <JobViewer job={open} onClose={() => setOpen(null)} />}
    </Layout>
  );
}
