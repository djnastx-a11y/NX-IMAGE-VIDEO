import { z } from "zod";
import type { ImageCapability, JobKind, JobStatus, Module, Operation, Role, VideoCapability } from "./common.js";
import { imageParamsSchema, type ImageParams } from "./image.js";
import { videoParamsSchema, type VideoParams } from "./video.js";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  counts?: { media: number; jobs: number };
  coverUrl?: string | null;
}

export interface Media {
  id: string;
  kind: "image" | "video" | "mask";
  source: "upload" | "generated";
  mime: string;
  url: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  sizeBytes: number;
  originalName: string | null;
  favorite: boolean;
  projectId: string | null;
  jobId: string | null;
  prompt: string | null;
  createdAt: string;
}

export type JobParams = ImageParams | VideoParams;

export interface JobLog {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown> | null;
}

export interface Job {
  id: string;
  module: Module;
  operation: Operation;
  kind: JobKind;
  parentJobId: string | null;
  batchId: string;
  projectId: string | null;
  userId: string;
  params: JobParams;
  providerId: string | null;
  model: string | null;
  status: JobStatus;
  stage: string | null;
  progress: number;
  priority: number;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  durationMs: number | null;
  queuePosition: number | null;
  outputs: Media[];
  sources: Media[];
}

export interface ProviderInfo {
  id: string;
  module: Module;
  name: string;
  engine: string;
  description: string;
  backend: string;
  enabled: boolean;
  isDefault: boolean;
  available: boolean;
  unavailableReason: string | null;
  capabilities: (ImageCapability | VideoCapability)[];
  limits: {
    maxDuration?: number;
    durations?: number[];
    resolutions?: string[];
    ratios?: string[];
    maxOutputs?: number;
  };
}

export interface Preset {
  id: string;
  module: Module;
  name: string;
  description: string;
  builtin: boolean;
  projectId: string | null;
  params: Partial<ImageParams> | Partial<VideoParams>;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
}

export type ServerEvent =
  | { type: "job"; job: Job }
  | { type: "job_deleted"; id: string }
  | { type: "ping"; at: string };

// ---------- request schemas ----------

export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#7c5cff"),
});
export const updateProjectSchema = createProjectSchema.partial().extend({ archived: z.boolean().optional() });

export const createJobSchema = z.discriminatedUnion("module", [
  z.object({
    module: z.literal("image"),
    params: imageParamsSchema,
    projectId: z.string().uuid().nullable().default(null),
    priority: z.number().int().min(-10).max(10).default(0),
  }),
  z.object({
    module: z.literal("video"),
    params: videoParamsSchema,
    /** number of variants; each one is its own job with its own seed */
    count: z.number().int().min(1).max(4).default(1),
    projectId: z.string().uuid().nullable().default(null),
    priority: z.number().int().min(-10).max(10).default(0),
  }),
]);
export type CreateJobRequest = z.input<typeof createJobSchema>;

export const presetBodySchema = z.object({
  module: z.enum(["image", "video"]),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(""),
  projectId: z.string().uuid().nullable().default(null),
  params: z.record(z.string(), z.unknown()),
});

export interface SystemSettings {
  queue: { concurrency: number; maxAttempts: number; retryBackoffSec: number };
  uploads: { maxImageMb: number; maxVideoMb: number };
  defaults: {
    imageProvider: string;
    videoProvider: string;
    image: Partial<ImageParams>;
    video: Partial<VideoParams>;
  };
}

export interface AuditLog {
  id: string;
  at: string;
  userId: string | null;
  userEmail: string | null;
  action: string;
  target: string | null;
  data: Record<string, unknown> | null;
  ip: string | null;
}
