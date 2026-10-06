import { useEffect, useMemo, useState } from "react";
import type { Job, Module } from "@nx/shared";
import { api } from "../lib/api";
import { useData, useJobs } from "../lib/store";
import { JobCard } from "./JobCard";
import { Empty, Segmented } from "./ui";

/** Live list of generations (queue + results) for a module, filtered by the current project. */
export function ResultsFeed({ module, onReuse, title = "Générations" }: { module?: Module; onReuse?(j: Job): void; title?: string }) {
  const { byId, upsert } = useJobs();
  const { currentProject } = useData();
  const [ids, setIds] = useState<string[] | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "completed" | "failed">("all");
  const [limit, setLimit] = useState(24);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let off = false;
    api
      .jobs({ module, projectId: currentProject ?? undefined, status: filter === "all" ? undefined : filter, limit })
      .then((r) => {
        if (off) return;
        upsert(r.items);
        setIds(r.items.map((j) => j.id));
        setTotal(r.total);
      })
      .catch(() => setIds([]));
    return () => {
      off = true;
    };
  }, [module, currentProject, filter, limit, upsert]);

  // Jobs created or updated live (this tab or another device) join the feed without a reload.
  const jobs = useMemo(() => {
    const known = new Set(ids ?? []);
    const list = [...byId.values()].filter(
      (j) =>
        (known.has(j.id) || (!module || j.module === module) && (currentProject ? j.projectId === currentProject : true)) &&
        (filter === "all" ||
          (filter === "active" && ["queued", "starting", "processing", "encoding"].includes(j.status)) ||
          (filter === "completed" && j.status === "completed") ||
          (filter === "failed" && ["failed", "cancelled"].includes(j.status))),
    );
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [byId, ids, module, currentProject, filter]);

  const active = [...byId.values()].filter((j) => (!module || j.module === module) && ["queued", "starting", "processing", "encoding"].includes(j.status)).length;

  return (
    <section>
      <div className="results-head">
        <h2 style={{ margin: 0, fontSize: 15 }}>{title}</h2>
        {active > 0 && <span className="badge processing">{active} en cours</span>}
        <div className="grow" />
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Tout" },
            { value: "active", label: "Queue" },
            { value: "completed", label: "Terminés" },
            { value: "failed", label: "Échecs" },
          ]}
        />
      </div>
      {ids === null ? (
        <div className="empty">
          <div className="spinner" style={{ margin: "0 auto" }} />
        </div>
      ) : jobs.length === 0 ? (
        <Empty title="Aucune génération ici">Choisis tes réglages puis clique sur Generate. Les jobs apparaissent ici avec leur progression.</Empty>
      ) : (
        <>
          <div className="results-grid">
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} onReuse={onReuse} />
            ))}
          </div>
          {total > limit && (
            <div style={{ textAlign: "center", marginTop: 16 }}>
              <button className="btn" onClick={() => setLimit((l) => l + 24)}>
                Voir plus
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
