import pino from "pino";

/**
 * Structured JSON logs. Every job log line carries job, provider, model, stage, worker and user
 * so a failure can be traced quickly (`grep '"job":"<id>"'`).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { app: "nx-studio" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ["password", "*.password", "token", "*.token", "headers.authorization", "headers.cookie"], censor: "[redacted]" },
});
export type Logger = typeof logger;
