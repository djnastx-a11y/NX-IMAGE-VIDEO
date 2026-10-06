import type {
  AuditLog,
  CreateJobRequest,
  Job,
  JobLog,
  Media,
  Module,
  Paginated,
  Preset,
  Project,
  ProviderInfo,
  SystemSettings,
  User,
} from "@nx/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event("nx:unauthorized"));
    throw new ApiError(res.status, data?.error ?? res.statusText, data?.code, data?.details);
  }
  return data as T;
}

const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** Upload with progress (XHR, since fetch has no upload progress). */
export function uploadMedia(file: File, opts: { projectId?: string | null; purpose?: "media" | "mask"; onProgress?: (p: number) => void } = {}): Promise<Media> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/media${qs({ projectId: opts.projectId, purpose: opts.purpose })}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: { error?: string; code?: string } | Media | undefined;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Media);
      else reject(new ApiError(xhr.status, (data as { error?: string })?.error ?? `Upload failed (${xhr.status})`, (data as { code?: string })?.code));
    };
    xhr.onerror = () => reject(new ApiError(0, "Réseau indisponible"));
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

export const api = {
  // auth
  authStatus: () => request<{ setupRequired: boolean; user: User | null }>("GET", "/api/auth/status"),
  setup: (b: { email: string; password: string; name: string }) => request<{ user: User }>("POST", "/api/auth/setup", b),
  login: (email: string, password: string) => request<{ user: User }>("POST", "/api/auth/login", { email, password }),
  logout: () => request("POST", "/api/auth/logout"),
  me: () => request<{ user: User; settings: Record<string, unknown> }>("GET", "/api/auth/me"),
  changePassword: (current: string, next: string) => request("POST", "/api/auth/password", { current, next }),
  updateMySettings: (patch: Record<string, unknown>) => request<Record<string, unknown>>("PATCH", "/api/me/settings", patch),

  // projects
  projects: (archived = false) => request<Project[]>("GET", `/api/projects${qs({ archived })}`),
  createProject: (b: { name: string; description?: string; color?: string }) => request<Project>("POST", "/api/projects", b),
  updateProject: (id: string, b: Partial<Project>) => request<Project>("PATCH", `/api/projects/${id}`, b),
  deleteProject: (id: string) => request("DELETE", `/api/projects/${id}`),

  // media
  media: (f: { section?: string; projectId?: string; q?: string; sort?: string; limit?: number; offset?: number }) =>
    request<Paginated<Media>>("GET", `/api/media${qs(f)}`),
  mediaItem: (id: string) => request<Media>("GET", `/api/media/${id}`),
  updateMedia: (id: string, b: { favorite?: boolean; projectId?: string | null }) => request<Media>("PATCH", `/api/media/${id}`, b),
  deleteMedia: (id: string) => request("DELETE", `/api/media/${id}`),

  // jobs
  createJob: (b: CreateJobRequest) => request<Job[]>("POST", "/api/jobs", b),
  jobs: (f: { module?: Module; status?: string; projectId?: string; q?: string; limit?: number; offset?: number }) =>
    request<Paginated<Job>>("GET", `/api/jobs${qs(f)}`),
  job: (id: string) => request<Job>("GET", `/api/jobs/${id}`),
  jobLogs: (id: string) => request<JobLog[]>("GET", `/api/jobs/${id}/logs`),
  cancel: (id: string) => request<Job>("POST", `/api/jobs/${id}/cancel`),
  retry: (id: string) => request<Job>("POST", `/api/jobs/${id}/retry`),
  regenerate: (id: string) => request<Job[]>("POST", `/api/jobs/${id}/regenerate`),
  variation: (id: string, b: { count?: number; sameSeed?: boolean; level?: string; outputIndex?: number; prompt?: string }) =>
    request<Job[]>("POST", `/api/jobs/${id}/variation`, b),
  duplicate: (id: string, overrides: Record<string, unknown> = {}) => request<Job[]>("POST", `/api/jobs/${id}/duplicate`, { overrides }),
  extend: (id: string, seconds: number, prompt?: string) => request<Job[]>("POST", `/api/jobs/${id}/extend`, { seconds, prompt }),
  updateJob: (id: string, b: { priority?: number; projectId?: string | null }) => request<Job>("PATCH", `/api/jobs/${id}`, b),
  deleteJob: (id: string) => request("DELETE", `/api/jobs/${id}`),

  // presets / providers
  presets: (module?: Module) => request<Preset[]>("GET", `/api/presets${qs({ module })}`),
  createPreset: (b: { module: Module; name: string; description?: string; projectId?: string | null; params: Record<string, unknown> }) =>
    request<Preset>("POST", "/api/presets", b),
  deletePreset: (id: string) => request("DELETE", `/api/presets/${id}`),
  providers: (module?: Module) => request<ProviderInfo[]>("GET", `/api/providers${qs({ module })}`),

  // admin
  adminOverview: () =>
    request<{
      stats: Record<string, number>;
      workers: { workerId: string; running: number; lastHeartbeat: string }[];
      storage: { ok: boolean; detail: string };
      db: { ok: boolean; version: string };
      config: Record<string, unknown>;
      settings: SystemSettings;
    }>("GET", "/api/admin/overview"),
  adminSettings: (patch: unknown) => request<SystemSettings>("PATCH", "/api/admin/settings", patch),
  adminProviders: () => request<ProviderInfo[]>("GET", "/api/admin/providers"),
  adminProvider: (id: string, b: { enabled?: boolean; isDefault?: boolean }) => request<ProviderInfo>("PATCH", `/api/admin/providers/${encodeURIComponent(id)}`, b),
  adminTestProvider: (id: string) => request<{ ok: boolean; reason: string | null; latencyMs: number }>("POST", `/api/admin/providers/${encodeURIComponent(id)}/test`),
  adminUsers: () => request<(User & { disabled: boolean })[]>("GET", "/api/admin/users"),
  adminCreateUser: (b: { email: string; name: string; password: string; role: string }) => request<User>("POST", "/api/admin/users", b),
  adminUpdateUser: (id: string, b: { role?: string; disabled?: boolean }) => request<User>("PATCH", `/api/admin/users/${id}`, b),
  adminAudit: () => request<AuditLog[]>("GET", "/api/admin/audit"),
  adminFailures: () =>
    request<{ id: string; module: string; operation: string; provider_id: string | null; model: string | null; error: string; error_code: string; attempts: number; finished_at: string; worker_id: string | null; email: string }[]>(
      "GET",
      "/api/admin/failures",
    ),
};
