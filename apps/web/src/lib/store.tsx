import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Job, Project, ProviderInfo, ServerEvent, User } from "@nx/shared";
import { api } from "./api";

/* ------------------------------------------------------------------ auth */

interface AuthState {
  user: User | null;
  loading: boolean;
  setupRequired: boolean;
  refresh(): Promise<void>;
  setUser(u: User | null): void;
}
const AuthCtx = createContext<AuthState>(null as never);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupRequired, setSetup] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const s = await api.authStatus();
      setUser(s.user);
      setSetup(s.setupRequired);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onUnauth = () => setUser(null);
    window.addEventListener("nx:unauthorized", onUnauth);
    return () => window.removeEventListener("nx:unauthorized", onUnauth);
  }, [refresh]);
  return <AuthCtx.Provider value={{ user, loading, setupRequired, refresh, setUser }}>{children}</AuthCtx.Provider>;
}
export const useAuth = () => useContext(AuthCtx);

/* ------------------------------------------------------------------ toasts */

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}
const ToastCtx = createContext<{ toasts: Toast[]; push(kind: Toast["kind"], text: string): void; dismiss(id: number): void }>(null as never);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: Toast["kind"], text: string) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-3), { id, kind, text }]);
      setTimeout(() => dismiss(id), kind === "error" ? 7000 : 3500);
    },
    [dismiss],
  );
  return <ToastCtx.Provider value={{ toasts, push, dismiss }}>{children}</ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

/* ------------------------------------------------------------------ live jobs (SSE) */

interface JobsState {
  /** Every job seen during this session, kept fresh by Server-Sent Events */
  byId: Map<string, Job>;
  upsert(jobs: Job[]): void;
  remove(id: string): void;
  /** Bumps whenever a job reaches a terminal state (library pages refresh on it) */
  completedTick: number;
  connected: boolean;
}
const JobsCtx = createContext<JobsState>(null as never);

export function JobsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [byId, setById] = useState<Map<string, Job>>(new Map());
  const [completedTick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const prev = useRef<Map<string, string>>(new Map());

  const upsert = useCallback((jobs: Job[]) => {
    setById((m) => {
      const n = new Map(m);
      let terminal = false;
      for (const j of jobs) {
        const old = n.get(j.id);
        if (old && old.updatedAt > j.updatedAt) continue;
        if (prev.current.get(j.id) !== j.status && ["completed", "failed", "cancelled"].includes(j.status) && old) terminal = true;
        prev.current.set(j.id, j.status);
        n.set(j.id, j);
      }
      if (terminal) setTick((t) => t + 1);
      return n;
    });
  }, []);
  const remove = useCallback((id: string) => setById((m) => {
    const n = new Map(m);
    n.delete(id);
    return n;
  }), []);

  useEffect(() => {
    if (!user) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      es = new EventSource("/api/events", { withCredentials: true });
      es.onopen = () => {
        setConnected(true);
        // catch up on anything missed while disconnected
        api.jobs({ status: "active", limit: 100 }).then((r) => upsert(r.items), () => {});
      };
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as ServerEvent;
        if (e.type === "job") upsert([e.job]);
        if (e.type === "job_deleted") remove(e.id);
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, [user, upsert, remove]);

  const value = useMemo(() => ({ byId, upsert, remove, completedTick, connected }), [byId, upsert, remove, completedTick, connected]);
  return <JobsCtx.Provider value={value}>{children}</JobsCtx.Provider>;
}
export const useJobs = () => useContext(JobsCtx);

/** Live version of a job (store first, fallback to the given snapshot). */
export function useLiveJob(job: Job): Job {
  const { byId } = useJobs();
  const live = byId.get(job.id);
  return live && live.updatedAt >= job.updatedAt ? live : job;
}

/* ------------------------------------------------------------------ shared data */

interface DataState {
  projects: Project[];
  reloadProjects(): Promise<void>;
  providers: ProviderInfo[];
  reloadProviders(): Promise<void>;
  currentProject: string | null;
  setCurrentProject(id: string | null): void;
}
const DataCtx = createContext<DataState>(null as never);

export function DataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [currentProject, setCP] = useState<string | null>(() => {
    try {
      return localStorage.getItem("nx.project");
    } catch {
      return null;
    }
  });
  const reloadProjects = useCallback(async () => setProjects(await api.projects()), []);
  const reloadProviders = useCallback(async () => setProviders(await api.providers()), []);
  useEffect(() => {
    if (!user) return;
    void reloadProjects();
    void reloadProviders();
    const t = setInterval(() => void reloadProviders().catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [user, reloadProjects, reloadProviders]);
  const setCurrentProject = (id: string | null) => {
    setCP(id);
    try {
      if (id) localStorage.setItem("nx.project", id);
      else localStorage.removeItem("nx.project");
    } catch {
      /* private mode */
    }
  };
  // forget a project that no longer exists
  useEffect(() => {
    if (currentProject && projects.length && !projects.some((p) => p.id === currentProject)) setCurrentProject(null);
  }, [projects, currentProject]);
  return (
    <DataCtx.Provider value={{ projects, reloadProjects, providers, reloadProviders, currentProject, setCurrentProject }}>{children}</DataCtx.Provider>
  );
}
export const useData = () => useContext(DataCtx);
