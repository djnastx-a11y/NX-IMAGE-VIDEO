/**
 * NX Studio / OpenMontage bootstrap.
 * Fetches the unmodified upstream at a reviewed commit, into an ignored directory.
 * No third-party code runs on --doctor or --fetch. --setup is opt-in.
 *
 * Upstream: https://github.com/calesthio/OpenMontage (AGPL-3.0).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPENMONTAGE_UPSTREAM = "https://github.com/calesthio/OpenMontage.git";
export const OPENMONTAGE_COMMIT = "e01dbf433f46eeb91d39bf905e194162921019a3";
export const NX_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const OPENMONTAGE_HOME = join(NX_REPOSITORY_ROOT, ".nx", "openmontage");

const REQUIRED = ["LICENSE", "AGENT_GUIDE.md", "pipeline_defs", "backlot", "tools", "remotion-composer"];
const WINDOWS = process.platform === "win32";

function command(name, args, cwd, timeout = 120_000) {
  return spawnSync(name, args, { cwd, encoding: "utf8", shell: false, timeout, maxBuffer: 2_000_000 });
}

function mustRun(name, args, cwd, timeout) {
  const result = command(name, args, cwd, timeout);
  if (result.error || result.status !== 0) {
    const detail = String(result.error?.message || result.stderr || result.stdout || "unknown error").slice(0, 1500);
    throw new Error(name + " failed: " + detail);
  }
  return String(result.stdout || "").trim();
}

export function inspectEngine(directory = OPENMONTAGE_HOME) {
  const present = existsSync(directory);
  const missing = present ? REQUIRED.filter((entry) => !existsSync(join(directory, entry))) : [...REQUIRED];
  const revision = present && existsSync(join(directory, ".git"))
    ? String(command("git", ["-C", directory, "rev-parse", "HEAD"]).stdout || "").trim()
    : null;
  return {
    path: directory,
    present,
    revision: revision || null,
    revisionPinned: revision === OPENMONTAGE_COMMIT,
    filesComplete: missing.length === 0,
    missing,
  };
}

export function prerequisiteStatus() {
  const check = (name, args = ["--version"]) => {
    const result = command(name, args);
    return !result.error && result.status === 0;
  };
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const py = WINDOWS ? check("py", ["-3", "--version"]) : check("python3", ["--version"]);
  return { node: nodeMajor >= 18, git: check("git"), python: py, ffmpeg: check("ffmpeg"), make: WINDOWS ? false : check("make") };
}

export function doctor() {
  const engine = inspectEngine();
  const tools = prerequisiteStatus();
  return {
    product: "NX Studio",
    engine: "OpenMontage",
    upstream: OPENMONTAGE_UPSTREAM,
    pinnedRevision: OPENMONTAGE_COMMIT,
    engine,
    prerequisites: tools,
    readyForSetup: engine.revisionPinned && engine.filesComplete && tools.node && tools.python && tools.ffmpeg && tools.make,
    readyForProduction: false,
    notice: "This checks source and prerequisites, not render capability, provider costs, auth or smartphone delivery.",
  };
}

export function fetchPinnedSource() {
  const existing = inspectEngine();
  if (existing.present) {
    if (existing.revisionPinned && existing.filesComplete) return { unchanged: true, ...existing };
    throw new Error("OpenMontage directory already exists but does not match the pinned source. Refusing to overwrite it.");
  }
  if (!prerequisiteStatus().git) throw new Error("git is required.");
  mkdirSync(dirname(OPENMONTAGE_HOME), { recursive: true });
  // Temporary directory is created next to destination for atomic rename on the same volume.
  const temporary = mkdtempSync(join(dirname(OPENMONTAGE_HOME), ".om-fetch-"));
  try {
    mustRun("git", ["init", "-q", temporary]);
    mustRun("git", ["-C", temporary, "remote", "add", "origin", OPENMONTAGE_UPSTREAM]);
    mustRun("git", ["-C", temporary, "fetch", "--depth=1", "--no-tags", "origin", OPENMONTAGE_COMMIT]);
    mustRun("git", ["-C", temporary, "checkout", "-q", "--detach", "FETCH_HEAD"]);
    const checked = inspectEngine(temporary);
    if (!checked.revisionPinned || !checked.filesComplete) throw new Error("Source verification failed; nothing installed.");
    renameSync(temporary, OPENMONTAGE_HOME);
    return { unchanged: false, ...inspectEngine() };
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}

export function setupDependencies() {
  const state = doctor();
  if (!state.readyForSetup) throw new Error("Run --fetch and --doctor first; required source or system dependencies are missing.");
  // Explicit step only. Installs upstream Python/npm packages, never configures billable provider keys.
  mustRun("make", ["setup"], OPENMONTAGE_HOME, 1_200_000);
  return { setupAttempted: true, engineRevision: OPENMONTAGE_COMMIT, paidProvidersEnabled: false };
}

export function runLocalBacklot() {
  const state = inspectEngine();
  if (!state.revisionPinned || !state.filesComplete) throw new Error("Verified OpenMontage checkout required.");
  const python = WINDOWS ? join(OPENMONTAGE_HOME, ".venv", "Scripts", "python.exe") : join(OPENMONTAGE_HOME, ".venv", "bin", "python");
  if (!existsSync(python)) throw new Error("OpenMontage Python environment not found. Run --setup first.");
  // Backlot is deliberately localhost-only. Never expose it publicly without NX authentication.
  const child = spawnSync(python, ["-m", "backlot", "serve", "--port", "4750"], { cwd: OPENMONTAGE_HOME, stdio: "inherit", shell: false });
  if (child.error || child.status !== 0) throw new Error("Backlot failed to start: " + String(child.error?.message || child.status));
}

const requested = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (requested) {
  const op = process.argv[2] || "--doctor";
  try {
    if (op === "--doctor") process.stdout.write(JSON.stringify(doctor(), null, 2) + "\n");
    else if (op === "--fetch") process.stdout.write(JSON.stringify(fetchPinnedSource(), null, 2) + "\n");
    else if (op === "--setup") process.stdout.write(JSON.stringify(setupDependencies(), null, 2) + "\n");
    else if (op === "--backlot") runLocalBacklot();
    else throw new Error("Unknown command. Use --doctor, --fetch, --setup or --backlot.");
  } catch (error) {
    process.stderr.write("NX Studio/OpenMontage: " + error.message + "\n");
    process.exitCode = 1;
  }
}
