import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NX_REPOSITORY_ROOT,
  OPENMONTAGE_COMMIT,
  OPENMONTAGE_HOME,
  OPENMONTAGE_UPSTREAM,
  doctor,
  inspectEngine,
} from "./engine.mjs";

test("OpenMontage upstream is pinned to an immutable commit, not latest", () => {
  assert.match(OPENMONTAGE_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(OPENMONTAGE_UPSTREAM, "https://github.com/calesthio/OpenMontage.git");
  assert.equal(OPENMONTAGE_HOME, join(NX_REPOSITORY_ROOT, ".nx", "openmontage"));
});

test("doctor is read only, machine parseable and never claims a render has been tested", () => {
  const before = existsSync(OPENMONTAGE_HOME);
  const data = JSON.parse(execFileSync(process.execPath, [join(NX_REPOSITORY_ROOT, "integrations", "openmontage", "engine.mjs"), "--doctor"], {
    cwd: NX_REPOSITORY_ROOT, encoding: "utf8", timeout: 20_000,
  }));
  assert.equal(data.product, "NX Studio");
  assert.equal(data.engine, "OpenMontage");
  assert.equal(data.readyForProduction, false);
  assert.equal(data.pinnedRevision, OPENMONTAGE_COMMIT);
  assert.equal(existsSync(OPENMONTAGE_HOME), before);
  assert.equal(typeof data.prerequisites.ffmpeg, "boolean");
});

test("incomplete checkout never passes validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "nx-openmontage-test-"));
  try {
    assert.equal(inspectEngine(dir).filesComplete, false);
    for (const name of ["LICENSE", "AGENT_GUIDE.md"]) writeFileSync(join(dir, name), "test");
    for (const name of ["pipeline_defs", "backlot", "tools", "remotion-composer"]) mkdirSync(join(dir, name));
    assert.equal(inspectEngine(dir).filesComplete, true);
    assert.equal(inspectEngine(dir).revisionPinned, false);
    assert.equal(doctor().readyForProduction, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
