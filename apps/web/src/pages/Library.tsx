import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Job, Media } from "@nx/shared";
import { api } from "../lib/api";
import { useData, useJobs, useToast } from "../lib/store";
import { Layout } from "../components/Layout";
import { JobViewer } from "../components/JobCard";
import { Icon } from "../components/icons";
import { Empty, fmtBytes, fmtDate, Modal, ProjectSelect, Segmented } from "../components/ui";

type Section = "all" | "images" | "videos" | "uploads" | "generated" | "favorites";

export function LibraryPage() {
  const [sp] = useSearchParams();
  const [section, setSection] = useState<Section>((sp.get("section") as Section) ?? "all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("newest");
  const { currentProject } = useData();
  const [items, setItems] = useState<Media[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(60);
  const [open, setOpen] = useState<Media | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const { completedTick } = useJobs();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .media({ section, q: q || undefined, sort, projectId: currentProject ?? undefined, limit })
        .then((r) => (setItems(r.items), setTotal(r.total)))
        .catch(() => setItems([]));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [section, q, sort, currentProject, limit, completedTick, reload]);

  const openItem = async (m: Media) => {
    if (m.jobId) {
      try {
        setJob(await api.job(m.jobId));
        return;
      } catch {
        /* job deleted: fall back to media view */
      }
    }
    setOpen(m);
  };

  return (
    <Layout title="Library">
      <div className="col" style={{ gap: 12, marginBottom: 16 }}>
        <div className="hstack-scroll">
          <Segmented
            value={section}
            onChange={setSection}
            options={[
              { value: "all", label: "All" },
              { value: "images", label: "Images" },
              { value: "videos", label: "Videos" },
              { value: "uploads", label: "Uploads" },
              { value: "generated", label: "Generated" },
              { value: "favorites", label: "Favorites" },
            ]}
          />
        </div>
        <div className="row">
          <div className="grow" style={{ position: "relative" }}>
            <input className="input" placeholder="Rechercher un prompt, un nom de fichier…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Recherche" />
          </div>
          <select className="select" style={{ width: 150 }} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Tri">
            <option value="newest">Plus récents</option>
            <option value="oldest">Plus anciens</option>
            <option value="largest">Plus lourds</option>
            <option value="name">Nom / prompt</option>
          </select>
        </div>
        <div className="small muted">{total} média{total > 1 ? "s" : ""}</div>
      </div>
      {items === null ? (
        <div className="empty">
          <div className="spinner" style={{ margin: "0 auto" }} />
        </div>
      ) : items.length === 0 ? (
        <Empty title="Bibliothèque vide">Les images et vidéos générées ou importées apparaissent ici.</Empty>
      ) : (
        <>
          <div className="media-grid">
            {items.map((m) => (
              <div key={m.id} className="media-tile" role="button" tabIndex={0} onClick={() => void openItem(m)} data-media={m.id}>
                <img src={m.thumbUrl ?? m.url} alt={m.prompt ?? m.originalName ?? ""} loading="lazy" />
                <div className="tile-top">
                  <span className="pill">{m.kind === "video" ? `▶ ${m.durationSec?.toFixed(0)}s` : m.source === "upload" ? "Import" : "Image"}</span>
                  {m.favorite && <span className="pill" style={{ color: "#f472b6" }}>♥</span>}
                </div>
                <div className="tile-bot ellipsis">{m.prompt || m.originalName || fmtDate(m.createdAt)}</div>
              </div>
            ))}
          </div>
          {total > items.length && (
            <div style={{ textAlign: "center", marginTop: 16 }}>
              <button className="btn" onClick={() => setLimit((l) => l + 60)}>
                Voir plus
              </button>
            </div>
          )}
        </>
      )}
      {open && <MediaViewer media={open} onClose={() => setOpen(null)} onChanged={() => setReload((r) => r + 1)} />}
      {job && <JobViewer job={job} onClose={() => (setJob(null), setReload((r) => r + 1))} />}
    </Layout>
  );
}

/** Viewer for uploads (generated media open their job viewer instead). */
export function MediaViewer({ media, onClose, onChanged }: { media: Media; onClose(): void; onChanged(): void }) {
  const nav = useNavigate();
  const { push } = useToast();
  const [m, setM] = useState(media);
  const update = async (b: { favorite?: boolean; projectId?: string | null }) => {
    try {
      setM(await api.updateMedia(m.id, b));
      onChanged();
    } catch (e) {
      push("error", (e as Error).message);
    }
  };
  return (
    <Modal title={m.originalName ?? (m.kind === "video" ? "Vidéo" : "Image")} onClose={onClose} wide>
      <div className="viewer">
        <div className="viewer-media">{m.kind === "video" ? <video src={m.url} controls autoPlay playsInline loop /> : <img src={m.url} alt="" />}</div>
        <div className="col">
          <dl className="kv">
            <dt>Type</dt>
            <dd>{m.kind} · {m.source === "upload" ? "import" : "généré"}</dd>
            <dt>Dimensions</dt>
            <dd>{m.width}×{m.height}</dd>
            {m.durationSec != null && (
              <>
                <dt>Durée</dt>
                <dd>{m.durationSec.toFixed(1)} s</dd>
              </>
            )}
            <dt>Poids</dt>
            <dd>{fmtBytes(m.sizeBytes)}</dd>
            <dt>Ajouté</dt>
            <dd>{fmtDate(m.createdAt)}</dd>
          </dl>
          <div className="field">
            <div className="label">Projet</div>
            <ProjectSelect value={m.projectId} onChange={(v) => void update({ projectId: v })} />
          </div>
          <a className="btn primary" href={`${m.url}?download=1`} download>
            <Icon name="download" /> Télécharger
          </a>
          {m.kind === "image" ? (
            <div className="row wrap">
              <button className="btn sm primary" onClick={() => nav(`/video?image=${m.id}`)}>
                <Icon name="film" /> Animate in NX VIDEO
              </button>
              <button className="btn sm" onClick={() => nav(`/image?source=${m.id}&op=edit`)}>
                <Icon name="wand" /> Modifier
              </button>
              <button className="btn sm" onClick={() => nav(`/image?source=${m.id}&op=upscale`)}>
                <Icon name="expand" /> Upscale
              </button>
            </div>
          ) : (
            <button className="btn sm" onClick={() => nav(`/video?video=${m.id}`)}>
              <Icon name="video" /> Utiliser en Video to Video
            </button>
          )}
          <div className="row">
            <button className="btn sm" onClick={() => void update({ favorite: !m.favorite })}>
              <Icon name="heart" /> {m.favorite ? "Retirer des favoris" : "Favori"}
            </button>
            <button
              className="btn sm danger ghost"
              onClick={async () => {
                if (!confirm("Supprimer ce média ?")) return;
                await api.deleteMedia(m.id);
                onChanged();
                onClose();
              }}
            >
              <Icon name="trash" /> Supprimer
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
