import { useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/store";
import { Field } from "../components/ui";

/** Sign-in, or first-run admin creation when the instance has no user yet. */
export function LoginPage() {
  const { setupRequired, refresh, setUser } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = setupRequired ? await api.setup({ email, password, name }) : await api.login(email, password);
      setUser(r.user);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form
        className="card auth-card col"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <img src="/logo.svg" alt="" width={44} height={44} />
        <h1>
          NX <span className="grad-text">STUDIO</span>
        </h1>
        <div className="small muted" style={{ marginBottom: 10 }}>
          {setupRequired ? "Première ouverture : crée le compte administrateur." : "Connecte-toi pour accéder à ton studio."}
        </div>
        {setupRequired && (
          <Field label="Nom">
            <input className="input" aria-label="Nom" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
        )}
        <Field label="Email">
          <input className="input" aria-label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
        </Field>
        <Field label="Mot de passe" hint={setupRequired ? "10 caractères minimum." : undefined}>
          <input
            className="input"
            aria-label="Mot de passe"
            type="password"
            required
            minLength={setupRequired ? 10 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={setupRequired ? "new-password" : "current-password"}
          />
        </Field>
        {error && <div className="job-error">{error}</div>}
        <button className="btn primary" style={{ height: 42, marginTop: 6 }} disabled={busy}>
          {busy ? <div className="spinner" /> : setupRequired ? "Créer le compte" : "Se connecter"}
        </button>
      </form>
    </div>
  );
}
