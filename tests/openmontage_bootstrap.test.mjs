import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENMONTAGE_COMMIT, inspectEngine, doctor } from "../integrations/openmontage/engine.mjs";

test("missing engine is reported without running installation", () => {
  const temp = mkdtempSync(join(tmpdir(), "nx-om-"));
  try {
    const status = inspectEngine(join(temp, "missing"));
    assert.equal(status.present, false);
    assert.equal(status.filesComplete, false);
    assert.equal(status.revisionPinned, false);
    assert.ok(status.missing.includes("LICENSE"));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("metadata must remain pinned to an explicit upstream revision", () => {
  assert.match(OPENMONTAGE_COMMIT, /^[a-f0-9]{40}$/);
  const status = doctor();
  assert.equal(status.engine, "OpenMontage");
  assert.equal(status.readyForProduction, false);
  assert.equal(status.pinnedRevision, OPENMONTAGE_COMMIT);
});
