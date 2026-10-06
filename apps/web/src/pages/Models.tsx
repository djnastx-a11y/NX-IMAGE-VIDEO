import { Link } from "react-router-dom";
import type { Module, ProviderInfo } from "@nx/shared";
import { useAuth, useData } from "../lib/store";
import { Layout } from "../components/Layout";
import { Empty } from "../components/ui";

const CAP_LABEL: Record<string, string> = {
  text_to_image: "Text to Image",
  image_to_image: "Image to Image",
  edit: "Édition",
  inpaint: "Inpainting",
  outpaint: "Outpainting",
  upscale: "Upscale",
  variation: "Variations",
  text_to_video: "Text to Video",
  image_to_video: "Image to Video",
  first_last_frame: "First/Last frame",
  video_to_video: "Video to Video",
  extend: "Extend",
  camera_control: "Caméra",
  negative_prompt: "Negative prompt",
  seed: "Seed",
  reference_image: "Référence",
};

/** Engines the router can use, their status and what each one supports. */
export function ModelsPage() {
  const { providers } = useData();
  const { user } = useAuth();
  const groups: { module: Module; title: string }[] = [
    { module: "image", title: "NX IMAGE" },
    { module: "video", title: "NX VIDEO" },
  ];
  return (
    <Layout title="Models">
      <div className="hero" style={{ marginBottom: 18 }}>
        <div className="small muted">
          En mode <strong>Auto</strong>, NX STUDIO choisit le meilleur moteur disponible pour chaque opération. Les moteurs « Mock » produisent de vrais fichiers
          sans GPU pour tester tous les workflows ; les moteurs réels se branchent via un serveur GPU (local, RunPod, Vast.ai, serveur dédié).
          {user?.role === "admin" && (
            <>
              {" "}
              Gestion : <Link to="/settings?tab=providers">Settings → Moteurs</Link>.
            </>
          )}
        </div>
      </div>
      {groups.map((g) => {
        const list = providers.filter((p) => p.module === g.module);
        return (
          <section key={g.module} style={{ marginBottom: 24 }}>
            <h2 className="section-title">{g.title}</h2>
            {list.length === 0 ? (
              <Empty title="Aucun moteur" />
            ) : (
              <div className="project-grid">
                {list.map((p) => (
                  <ProviderCard key={p.id} p={p} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </Layout>
  );
}

export function ProviderCard({ p, children }: { p: ProviderInfo; children?: React.ReactNode }) {
  const ops = p.capabilities.filter((c) => c in CAP_LABEL);
  return (
    <div className="card card-pad col" style={{ gap: 8 }} data-provider={p.id}>
      <div className="row">
        <strong className="grow ellipsis">{p.name}</strong>
        {p.isDefault && <span className="badge processing">Défaut</span>}
        <span className={`badge ${!p.enabled ? "cancelled" : p.available ? "completed" : "failed"}`}>
          <span className="dot" />
          {!p.enabled ? "Désactivé" : p.available ? "Disponible" : "Indisponible"}
        </span>
      </div>
      <div className="tiny muted mono">
        {p.id} · {p.backend}
      </div>
      <div className="small muted">{p.description}</div>
      {p.unavailableReason && p.enabled && <div className="tiny" style={{ color: "var(--danger)" }}>{p.unavailableReason}</div>}
      <div className="row wrap" style={{ gap: 4 }}>
        {ops.map((c) => (
          <span key={c} className="tag">
            {CAP_LABEL[c]}
          </span>
        ))}
      </div>
      {!!(p.limits.maxDuration || p.limits.resolutions?.length || p.limits.maxOutputs) && (
        <div className="tiny muted">
          {p.limits.maxDuration ? `Durée max ${p.limits.maxDuration}s · ` : ""}
          {p.limits.resolutions?.length ? `${p.limits.resolutions.join(", ")} · ` : ""}
          {p.limits.maxOutputs ? `jusqu'à ${p.limits.maxOutputs} résultats` : ""}
        </div>
      )}
      {children}
    </div>
  );
}
