import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { AuditLog, ProviderInfo, SystemSettings, User } from "@nx/shared";
import { api } from "../lib/api";
import { useAuth, useData, useToast } from "../lib/store";
import { Layout } from "../components/Layout";
import { Icon } from "../components/icons";
import { ProviderCard } from "./Models";
import { Empty, Field, fmtDate, Modal } from "../components/ui";

type Tab = "account" | "overview" | "providers" | "system" | "users" | "audit" | "failures";

export function SettingsPage() {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const admin = user?.role === "admin";
  const tab = ((sp.get("tab") as Tab) ?? "account") as Tab;
  const setTab = (t: Tab) => setSp({ tab: t }, { replace: true });
  const tabs: { id: Tab; label: string; admin?: boolean }[] = [
    { id: "account", label: "Compte" },
    { id: "overview", label: "Système", admin: true },
    { id: "providers", label: "Moteurs", admin: true },
    { id: "system", label: "File & uploads", admin: true },
    { id: "users", label: "Utilisateurs", admin: true },
    { id: "failures", label: "Échecs", admin: true },
    { id: "audit", label: "Audit", admin: true },
  ];
  const visible = tabs.filter((t) => !t.admin || admin);
  const current = visible.some((t) => t.id === tab) ? tab : "account";
  return (
    <Layout title="Settings">
      <div className="tabs" role="tablist">
        {visible.map((t) => (
          <button key={t.id} role="tab" aria-selected={current === t.id} className={`tab${current === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {current === "account" && <Account />}
      {current === "overview" && <Overview />}
      {current === "providers" && <Providers />}
      {current === "system" && <SystemSettingsForm />}
      {current === "users" && <Users />}
      {current === "failures" && <Failures />}
      {current === "audit" && <Audit />}
    </Layout>
  );
}

/* ------------------------------------------------------------------ account */

function Account() {
  const { user, setUser } = useAuth();
  const { push } = useToast();
  const nav = useNavigate();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const change = async () => {
    try {
      await api.changePassword(cur, next);
      setCur("");
      setNext("");
      push("success", "Mot de passe modifié. Les autres sessions ont été déconnectées.");
    } catch (e) {
      push("error", (e as Error).message);
    }
  };
  const logout = async () => {
    await api.logout().catch(() => {});
    setUser(null);
    nav("/");
  };
  return (
    <div className="settings-grid">
      <div className="card card-pad col">
        <h2 className="section-title">Compte</h2>
        <dl className="kv">
          <dt>Nom</dt>
          <dd>{user?.name}</dd>
          <dt>Email</dt>
          <dd>{user?.email}</dd>
          <dt>Rôle</dt>
          <dd>{user?.role === "admin" ? "Administrateur" : "Utilisateur"}</dd>
        </dl>
        <button className="btn" onClick={logout}>
          <Icon name="logout" /> Se déconnecter
        </button>
      </div>
      <form
        className="card card-pad col"
        onSubmit={(e) => {
          e.preventDefault();
          void change();
        }}
      >
        <h2 className="section-title">Mot de passe</h2>
        <Field label="Mot de passe actuel">
          <input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label="Nouveau mot de passe" hint="10 caractères minimum.">
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={10} />
        </Field>
        <button className="btn primary" disabled={!cur || next.length < 10}>
          Modifier
        </button>
      </form>
      <div className="card card-pad col">
        <h2 className="section-title">Raccourcis</h2>
        <Link className="btn" to="/projects">
          <Icon name="folder" /> Projects
        </Link>
        <Link className="btn" to="/models">
          <Icon name="cpu" /> Models
        </Link>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ admin: overview */

function Overview() {
  const [o, setO] = useState<Awaited<ReturnType<typeof api.adminOverview>> | null>(null);
  useEffect(() => {
    const load = () => api.adminOverview().then(setO, () => {});
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  if (!o) return <Spinner />;
  const labels: Record<string, string> = { queued: "En file", starting: "Démarrage", processing: "Génération", encoding: "Encodage", completed: "Terminés", failed: "Échecs", cancelled: "Annulés" };
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="stat-grid">
        {Object.entries(o.stats).map(([k, n]) => (
          <div key={k} className="card stat">
            <div className="tiny muted">{labels[k] ?? k}</div>
            <div className="n">{n}</div>
          </div>
        ))}
      </div>
      <div className="settings-grid">
        <div className="card card-pad col">
          <h2 className="section-title">Santé</h2>
          <dl className="kv">
            <dt>Base de données</dt>
            <dd>{o.db.ok ? "OK" : "Erreur"} · <span className="tiny muted">{o.db.version.split(" on ")[0]}</span></dd>
            <dt>Stockage</dt>
            <dd>{o.storage.ok ? "OK" : "Erreur"} · <span className="tiny muted">{o.storage.detail}</span></dd>
            <dt>Workers actifs</dt>
            <dd>
              {o.workers.length === 0
                ? "aucun job en cours"
                : o.workers.map((w) => (
                    <div key={w.workerId} className="mono tiny">
                      {w.workerId} · {w.running} job(s) · {fmtDate(w.lastHeartbeat)}
                    </div>
                  ))}
            </dd>
          </dl>
        </div>
        <div className="card card-pad col">
          <h2 className="section-title">Variables serveur (secrets masqués)</h2>
          <dl className="kv mono tiny">
            {Object.entries(o.config).map(([k, v]) => (
              <Kv key={k} k={k} v={typeof v === "object" ? JSON.stringify(v) : String(v)} />
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

/* ------------------------------------------------------------------ admin: providers */

function Providers() {
  const { push } = useToast();
  const { reloadProviders } = useData();
  const [list, setList] = useState<ProviderInfo[] | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const load = () => api.adminProviders().then(setList, () => setList([]));
  useEffect(() => void load(), []);
  const patch = async (id: string, b: { enabled?: boolean; isDefault?: boolean }) => {
    try {
      await api.adminProvider(id, b);
      await Promise.all([load(), reloadProviders()]);
    } catch (e) {
      push("error", (e as Error).message);
    }
  };
  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "Test…" }));
    try {
      const r = await api.adminTestProvider(id);
      setTests((t) => ({ ...t, [id]: r.ok ? `OK · ${r.latencyMs} ms` : `Échec : ${r.reason}` }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: (e as Error).message }));
    }
  };
  if (!list) return <Spinner />;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="small muted">
        Les moteurs réels se déclarent côté serveur via <span className="mono">NX_GPU_ENDPOINTS</span> (les clés restent sur le serveur). Ici : activer, définir le
        moteur par défaut, tester.
      </div>
      <div className="project-grid">
        {list.map((p) => (
          <ProviderCard key={p.id} p={p}>
            <div className="row wrap">
              <button className="btn sm" onClick={() => void patch(p.id, { enabled: !p.enabled })}>
                {p.enabled ? "Désactiver" : "Activer"}
              </button>
              <button className="btn sm" disabled={!p.enabled} onClick={() => void patch(p.id, { isDefault: !p.isDefault })}>
                {p.isDefault ? "Retirer défaut" : "Par défaut"}
              </button>
              <button className="btn sm" onClick={() => void test(p.id)}>
                <Icon name="bolt" /> Tester
              </button>
            </div>
            {tests[p.id] && <div className="tiny" data-test-result={p.id}>{tests[p.id]}</div>}
          </ProviderCard>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ admin: queue, uploads, defaults */

function SystemSettingsForm() {
  const { push } = useToast();
  const { providers } = useData();
  const [s, setS] = useState<SystemSettings | null>(null);
  useEffect(() => void api.adminOverview().then((o) => setS(o.settings), () => {}), []);
  if (!s) return <Spinner />;
  const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));
  const save = async () => {
    try {
      setS(
        await api.adminSettings({
          queue: s.queue,
          uploads: s.uploads,
          defaults: { imageProvider: s.defaults.imageProvider, videoProvider: s.defaults.videoProvider },
        }),
      );
      push("success", "Réglages enregistrés");
    } catch (e) {
      push("error", (e as Error).message);
    }
  };
  const engines = (m: "image" | "video") => providers.filter((p) => p.module === m);
  return (
    <form
      className="settings-grid"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="card card-pad col">
        <h2 className="section-title">File d'attente</h2>
        <Field label="Jobs en parallèle par worker">
          <input className="input" type="number" min={1} max={32} value={s.queue.concurrency} onChange={(e) => setS({ ...s, queue: { ...s.queue, concurrency: num(e.target.value) } })} />
        </Field>
        <Field label="Tentatives max (retry automatique)">
          <input className="input" type="number" min={1} max={10} value={s.queue.maxAttempts} onChange={(e) => setS({ ...s, queue: { ...s.queue, maxAttempts: num(e.target.value) } })} />
        </Field>
        <Field label="Délai entre tentatives (s)">
          <input className="input" type="number" min={0} max={3600} value={s.queue.retryBackoffSec} onChange={(e) => setS({ ...s, queue: { ...s.queue, retryBackoffSec: num(e.target.value) } })} />
        </Field>
      </div>
      <div className="card card-pad col">
        <h2 className="section-title">Uploads</h2>
        <Field label="Taille max image (Mo)">
          <input className="input" type="number" min={1} max={200} value={s.uploads.maxImageMb} onChange={(e) => setS({ ...s, uploads: { ...s.uploads, maxImageMb: num(e.target.value) } })} />
        </Field>
        <Field label="Taille max vidéo (Mo)">
          <input className="input" type="number" min={1} max={4000} value={s.uploads.maxVideoMb} onChange={(e) => setS({ ...s, uploads: { ...s.uploads, maxVideoMb: num(e.target.value) } })} />
        </Field>
      </div>
      <div className="card card-pad col">
        <h2 className="section-title">Moteurs par défaut</h2>
        {(["image", "video"] as const).map((m) => (
          <Field key={m} label={m === "image" ? "NX IMAGE" : "NX VIDEO"}>
            <select
              className="select"
              value={m === "image" ? s.defaults.imageProvider : s.defaults.videoProvider}
              onChange={(e) => setS({ ...s, defaults: { ...s.defaults, [m === "image" ? "imageProvider" : "videoProvider"]: e.target.value } })}
            >
              <option value="auto">Auto (meilleur disponible)</option>
              {engines(m).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        ))}
        <button className="btn primary">Enregistrer</button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ admin: users */

function Users() {
  const { push } = useToast();
  const { user: me } = useAuth();
  const [list, setList] = useState<(User & { disabled: boolean })[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api.adminUsers().then(setList, () => setList([]));
  useEffect(() => void load(), []);
  const patch = async (id: string, b: { role?: string; disabled?: boolean }) => {
    try {
      await api.adminUpdateUser(id, b);
      await load();
    } catch (e) {
      push("error", (e as Error).message);
    }
  };
  if (!list) return <Spinner />;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div>
        <button className="btn primary sm" onClick={() => setAdding(true)}>
          <Icon name="plus" /> Ajouter un utilisateur
        </button>
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Utilisateur</th>
              <th>Rôle</th>
              <th className="hide-sm">Créé</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id}>
                <td>
                  <div>{u.name}</div>
                  <div className="tiny muted">{u.email}</div>
                </td>
                <td>
                  <select className="select" style={{ width: 130 }} value={u.role} disabled={u.id === me?.id} onChange={(e) => void patch(u.id, { role: e.target.value })}>
                    <option value="user">Utilisateur</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td className="hide-sm small">{fmtDate(u.createdAt)}</td>
                <td style={{ textAlign: "right" }}>
                  {u.id !== me?.id && (
                    <button className="btn sm" onClick={() => void patch(u.id, { disabled: !u.disabled })}>
                      {u.disabled ? "Réactiver" : "Désactiver"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && (
        <AddUser
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function AddUser({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const { push } = useToast();
  const [b, setB] = useState({ email: "", name: "", password: "", role: "user" });
  return (
    <Modal title="Nouvel utilisateur" onClose={onClose}>
      <form
        className="col"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.adminCreateUser(b);
            push("success", "Utilisateur créé");
            onDone();
          } catch (err) {
            push("error", (err as Error).message);
          }
        }}
      >
        <Field label="Email">
          <input className="input" type="email" required value={b.email} onChange={(e) => setB({ ...b, email: e.target.value })} />
        </Field>
        <Field label="Nom">
          <input className="input" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} />
        </Field>
        <Field label="Mot de passe" hint="10 caractères minimum.">
          <input className="input" type="password" autoComplete="new-password" required minLength={10} value={b.password} onChange={(e) => setB({ ...b, password: e.target.value })} />
        </Field>
        <Field label="Rôle">
          <select className="select" value={b.role} onChange={(e) => setB({ ...b, role: e.target.value })}>
            <option value="user">Utilisateur</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <button className="btn primary">Créer</button>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ admin: failures & audit */

function Failures() {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.adminFailures>> | null>(null);
  useEffect(() => void api.adminFailures().then(setList, () => setList([])), []);
  if (!list) return <Spinner />;
  if (!list.length) return <Empty title="Aucun échec">Les générations en échec définitif apparaissent ici avec leur erreur.</Empty>;
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Opération</th>
            <th>Erreur</th>
            <th className="hide-sm">Moteur</th>
            <th className="hide-sm">Utilisateur</th>
          </tr>
        </thead>
        <tbody>
          {list.map((f) => (
            <tr key={f.id}>
              <td className="small nowrap">{f.finished_at ? fmtDate(f.finished_at) : "—"}</td>
              <td className="small">
                {f.module} · {f.operation}
              </td>
              <td className="small">
                {f.error} <span className="tiny muted">({f.error_code}, {f.attempts} essai{f.attempts > 1 ? "s" : ""})</span>
              </td>
              <td className="hide-sm small mono">{f.provider_id ?? "—"}</td>
              <td className="hide-sm small">{f.email}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Audit() {
  const [list, setList] = useState<AuditLog[] | null>(null);
  useEffect(() => void api.adminAudit().then(setList, () => setList([])), []);
  if (!list) return <Spinner />;
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Action</th>
            <th className="hide-sm">Utilisateur</th>
            <th className="hide-sm">Cible</th>
            <th className="hide-sm">IP</th>
          </tr>
        </thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id}>
              <td className="small nowrap">{fmtDate(a.at)}</td>
              <td className="small mono">{a.action}</td>
              <td className="hide-sm small">{a.userEmail ?? "—"}</td>
              <td className="hide-sm tiny mono ellipsis" style={{ maxWidth: 220 }}>{a.target ?? ""}</td>
              <td className="hide-sm tiny mono">{a.ip ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Spinner() {
  return (
    <div className="empty">
      <div className="spinner" style={{ margin: "0 auto" }} />
    </div>
  );
}
