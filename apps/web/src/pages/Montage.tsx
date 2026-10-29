import { useCallback, useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Icon } from "../components/icons";
import { useData, useToast } from "../lib/store";
import { api, type MontageScene, type MontageJob, type MontageRequest, type MontageStatus } from "../lib/api";

const starterScenes: MontageScene[] = [
  { title: "NX STUDIO", subtitle: "Ton idée devient une vidéo", kind: "hero_title", duration: 3 },
  { title: "Crée, compose, exporte", subtitle: "Un projet, un studio, un montage", kind: "text_card", duration: 3 },
  { title: "À toi de jouer", subtitle: "Premier aperçu généré avec OpenMontage", kind: "text_card", duration: 3 },
];

const THEMES: { value: MontageRequest["theme"]; label: string }[] = [
  { value: "clean-professional", label: "Premium clair" },
  { value: "minimalist-diagram", label: "Minimal" },
  { value: "flat-motion-graphics", label: "Motion graphique" },
];

export function MontagePage() {
  const { currentProject } = useData();
  const { push } = useToast();
  const [status, setStatus] = useState<MontageStatus | null>(null);
  const [jobs, setJobs] = useState<MontageJob[]>([]);
  const [title, setTitle] = useState("Mon premier montage NX");
  const [theme, setTheme] = useState<MontageRequest["theme"]>("clean-professional");
  const [scenes, setScenes] = useState<MontageScene[]>(starterScenes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const [s, j] = await Promise.all([api.montageStatus(), api.montageJobs()]);
    setStatus(s); setJobs(j);
  }, []);

  useEffect(() => {
    void refresh().catch((e: Error) => setError(e.message));
    const handle = window.setInterval(() => {
      void api.montageJobs().then(setJobs).catch(() => {});
    }, 2500);
    return () => window.clearInterval(handle);
  }, [refresh]);

  const updateScene = (index: number, patch: Partial<MontageScene>) => setScenes((all) =>
    all.map((s, i) => i === index ? { ...s, ...patch } : s));

  const create = async () => {
    setError("");
    setBusy(true);
    try {
      const job = await api.montageRender({ title: title.trim(), projectId: currentProject || null, theme, scenes });
      setJobs((list) => [job, ...list]);
      push("success", "Montage lancé. Suis l'export ici.");
    } catch (e) {
      setError((e as Error).message);
      push("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return <Layout title="NX Montage">
    <section className="montage-intro">
      <div className="montage-eyebrow">NX STUDIO / OPENMONTAGE</div>
      <h2>Compose ta vidéo</h2>
      <p>Écris tes scènes, choisis le style, lance un aperçu MP4 avec le moteur original OpenMontage. Sans appel à une IA payante.</p>
      <div className={status?.ready ? "montage-engine ready" : "montage-engine offline"}>
        <span className="conn" style={{ background: status?.ready ? "#34d399" : "#fbbf24" }} />
        {status?.ready ? "Moteur local connecté" : "Moteur en attente d'installation serveur"}
        <span className="montage-engine-desc">{status?.message || "Vérification en cours…"}</span>
      </div>
    </section>
    <div className="montage-columns">
      <div className="card montage-form">
        <h3>01 · Ton storyboard</h3>
        <label className="field"><span className="label">Nom du montage</span>
          <input className="input" maxLength={90} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field"><span className="label">Direction artistique</span>
          <select className="input" value={theme} onChange={(e) => setTheme(e.target.value as MontageRequest["theme"])}>
            {THEMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <div className="montage-scenes">
          {scenes.map((s, i) => <article className="montage-scene" key={i}>
            <div className="montage-scene-header">
              <strong>Scène {String(i + 1).padStart(2, "0")}</strong>
              <span>{s.duration} secondes</span>
              {scenes.length > 1 && <button className="montage-remove" onClick={() => setScenes((a) => a.filter((_, index) => index !== i))} type="button" aria-label={"Supprimer scène " + (i + 1)}>×</button>}
            </div>
            <input className="input" aria-label={"Titre scène " + (i + 1)} maxLength={100} value={s.title} onChange={(e) => updateScene(i, { title: e.target.value })} placeholder="Titre principal" />
            <input className="input" aria-label={"Sous-titre scène " + (i + 1)} maxLength={160} value={s.subtitle} onChange={(e) => updateScene(i, { subtitle: e.target.value })} placeholder="Sous-titre" />
            <div className="montage-scene-controls">
              <select className="input" value={s.kind} onChange={(e) => updateScene(i, { kind: e.target.value as MontageScene["kind"] })} aria-label={"Type scène " + (i + 1)}>
                <option value="hero_title">Titre cinéma</option>
                <option value="text_card">Carte animée</option>
              </select>
              <select className="input" value={s.duration} onChange={(e) => updateScene(i, { duration: Number(e.target.value) })} aria-label={"Durée scène " + (i + 1)}>
                {[2,3,4,5,6].map((n) => <option key={n} value={n}>{n}s</option>)}
              </select>
            </div>
          </article>)}
        </div>
        {scenes.length < 6 && <button className="btn" type="button" onClick={() => setScenes((s) => [...s, { title: "", subtitle: "", kind: "text_card", duration: 3 }])}><Icon name="plus" /> Ajouter une scène</button>}
        <div className="montage-export">
          <span>Aperçu 16:9 · 480 × 270 · {scenes.reduce((n, s) => n + s.duration, 0)} s</span>
          <button className="btn primary" type="button" onClick={() => void create()}
            disabled={!status?.ready || busy || !title.trim() || scenes.some((s) => !s.title.trim())}>
            <Icon name="play" /> {busy ? "Préparation…" : "Lancer le rendu"}
          </button>
          {error && <div className="job-error" role="alert">{error}</div>}
          {!status?.ready && <p className="hint">Les scènes restent modifiables. Le rendu sera activé une fois OpenMontage installé et autorisé sur ton serveur NX Studio.</p>}
        </div>
      </div>
      <div className="card montage-history">
        <h3>02 · Tes exports</h3>
        {jobs.length === 0 && <p className="hint">Aucun montage lancé. Les exports terminés apparaîtront aussi dans ta bibliothèque NX Studio.</p>}
        {jobs.map((job) => <article key={job.id} className="montage-result">
          <div className="montage-scene-header">
            <strong>{job.title}</strong>
            <span className={"montage-label " + job.status}>{{
              queued: "En attente", running: "Rendu en cours", completed: "Terminé", failed: "Échec",
            }[job.status]}</span>
          </div>
          <small>{new Date(job.createdAt).toLocaleString("fr-FR")}</small>
          {job.videoUrl && <><video className="montage-video" src={job.videoUrl} controls playsInline preload="metadata" />
            <a href={job.videoUrl + "?download=1"} className="btn" download><Icon name="download" /> Télécharger le MP4</a></>}
          {job.error && <div className="job-error">{job.error}</div>}
        </article>)}
        <button className="btn" onClick={() => void refresh().catch((e: Error) => setError(e.message))} type="button"><Icon name="refresh" /> Actualiser</button>
      </div>
    </div>
  </Layout>;
}
