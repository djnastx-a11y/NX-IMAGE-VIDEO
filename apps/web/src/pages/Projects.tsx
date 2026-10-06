import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Project } from "@nx/shared";
import { api } from "../lib/api";
import { useData, useToast } from "../lib/store";
import { Layout } from "../components/Layout";
import { Icon } from "../components/icons";
import { Empty, Field, fmtDate, Modal, Toggle } from "../components/ui";

const COLORS = ["#7c5cff", "#22d3ee", "#f472b6", "#f59e0b", "#34d399", "#ef4444", "#60a5fa", "#a3e635"];

export function ProjectsPage() {
  const { reloadProjects, currentProject, setCurrentProject } = useData();
  const { push } = useToast();
  const nav = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const [list, setList] = useState<Project[] | null>(null);
  const [edit, setEdit] = useState<Project | "new" | null>(null);

  const load = () => api.projects(showArchived).then(setList, () => setList([]));
  useEffect(() => void load(), [showArchived]);

  const openProject = (p: Project, to = "/library") => {
    setCurrentProject(p.id);
    nav(to);
  };
  const saved = async () => {
    setEdit(null);
    await Promise.all([load(), reloadProjects()]);
  };

  return (
    <Layout
      title="Projects"
      actions={
        <button className="btn primary sm" onClick={() => setEdit("new")}>
          <Icon name="plus" /> Nouveau
        </button>
      }
    >
      <div className="row" style={{ marginBottom: 14, maxWidth: 260 }}>
        <Toggle label="Afficher les archivés" checked={showArchived} onChange={setShowArchived} />
      </div>
      {list === null ? (
        <div className="empty">
          <div className="spinner" style={{ margin: "0 auto" }} />
        </div>
      ) : list.length === 0 ? (
        <Empty title="Aucun projet">
          Crée un projet (ex. Australia Street, Halloween, DJ…) pour ranger médias, générations et presets.
          <div style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => setEdit("new")}>
              <Icon name="plus" /> Créer un projet
            </button>
          </div>
        </Empty>
      ) : (
        <div className="project-grid">
          {list.map((p) => (
            <div key={p.id} className="card project-card" data-project={p.id} onClick={() => openProject(p)}>
              <div className="project-cover">
                {p.coverUrl ? <img src={p.coverUrl} alt="" /> : <div style={{ position: "absolute", inset: 0, background: `linear-gradient(135deg, ${p.color}55, transparent)` }} />}
                <div className="stripe" style={{ background: p.color }} />
                {currentProject === p.id && <span className="pill" style={{ position: "absolute", right: 8, top: 8 }}>Actif</span>}
              </div>
              <div className="card-pad col" style={{ gap: 6 }}>
                <div className="row">
                  <strong className="ellipsis grow">{p.name}</strong>
                  {p.archived && <span className="badge">Archivé</span>}
                  <button
                    className="btn ghost icon sm"
                    aria-label="Modifier le projet"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEdit(p);
                    }}
                  >
                    <Icon name="settings" />
                  </button>
                </div>
                {p.description && <div className="small muted ellipsis-2">{p.description}</div>}
                <div className="tiny muted">
                  {p.counts?.media ?? 0} médias · {p.counts?.jobs ?? 0} générations · {fmtDate(p.updatedAt)}
                </div>
                <div className="row" onClick={(e) => e.stopPropagation()}>
                  <button className="btn sm" onClick={() => openProject(p, "/image")}>
                    <Icon name="image" /> Image
                  </button>
                  <button className="btn sm" onClick={() => openProject(p, "/video")}>
                    <Icon name="video" /> Vidéo
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {edit && (
        <ProjectEditor
          project={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={saved}
          onDeleted={async (id) => {
            if (currentProject === id) setCurrentProject(null);
            push("success", "Projet supprimé (les médias restent dans la bibliothèque)");
            await saved();
          }}
        />
      )}
    </Layout>
  );
}

function ProjectEditor({ project, onClose, onSaved, onDeleted }: { project: Project | null; onClose(): void; onSaved(): void; onDeleted(id: string): void }) {
  const { push } = useToast();
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [color, setColor] = useState(project?.color ?? COLORS[0]!);
  const [archived, setArchived] = useState(project?.archived ?? false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (project) await api.updateProject(project.id, { name, description, color, archived });
      else await api.createProject({ name, description, color });
      push("success", project ? "Projet mis à jour" : "Projet créé");
      onSaved();
    } catch (e) {
      push("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!project || !confirm(`Supprimer le projet « ${project.name} » ? Ses médias et générations restent dans la bibliothèque, sans projet.`)) return;
    try {
      await api.deleteProject(project.id);
      onDeleted(project.id);
    } catch (e) {
      push("error", (e as Error).message);
    }
  };

  return (
    <Modal title={project ? "Modifier le projet" : "Nouveau projet"} onClose={onClose}>
      <form
        className="col"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Nom">
          <input className="input" aria-label="Nom" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Australia Street" maxLength={80} required />
        </Field>
        <Field label="Description">
          <textarea className="textarea" style={{ minHeight: 70 }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <Field label="Couleur">
          <div className="row wrap">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                onClick={() => setColor(c)}
                style={{ width: 28, height: 28, borderRadius: 999, background: c, border: color === c ? "2px solid #fff" : "2px solid transparent", cursor: "pointer" }}
              />
            ))}
          </div>
        </Field>
        {project && <Toggle label="Archivé" checked={archived} onChange={setArchived} />}
        <div className="row" style={{ marginTop: 8 }}>
          {project && (
            <button type="button" className="btn danger ghost" onClick={del}>
              <Icon name="trash" /> Supprimer
            </button>
          )}
          <div className="grow" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Annuler
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {project ? "Enregistrer" : "Créer"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
