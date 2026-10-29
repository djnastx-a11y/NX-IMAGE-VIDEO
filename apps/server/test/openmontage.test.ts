import { describe, expect, it } from "vitest";
import { openMontageProps, openMontageSpec, OpenMontageService } from "../src/services/openmontage.js";

describe("NX Studio OpenMontage preview contract", () => {
  const request = {
    title: "NX Studio",
    projectId: null,
    theme: "clean-professional" as const,
    scenes: [
      { kind: "hero_title" as const, title: "Hello NX", subtitle: "Studio", duration: 3 },
      { kind: "text_card" as const, title: "Second scene", subtitle: "A preview", duration: 4 },
    ],
  };
  it("builds an original OpenMontage Explainer composition timeline", () => {
    const parsed = openMontageSpec.parse(request);
    const props = openMontageProps(parsed);
    expect(props.cuts).toHaveLength(2);
    expect(props.cuts[0]).toMatchObject({ type: "hero_title", in_seconds: 0, out_seconds: 3, text: "Hello NX" });
    expect(props.cuts[1]).toMatchObject({ type: "text_card", in_seconds: 3, out_seconds: 7 });
    expect(props.audio).toEqual({});
  });
  it("rejects untrusted paths, oversized scenes and extra fields", () => {
    expect(() => openMontageSpec.parse({ ...request, scenes: [{ title: "ok", subtitle: "", kind: "video", duration: 3 }] })).toThrow();
    expect(() => openMontageSpec.parse({ ...request, scenes: request.scenes.concat(request.scenes, request.scenes, request.scenes) })).toThrow();
    expect(() => openMontageSpec.parse({ ...request, scenes: [{ title: "<script>", subtitle: "", duration: 3, source: "https://example.com/private" }] })).toThrow();
    expect(() => openMontageSpec.parse({ ...request, title: "x".repeat(200) })).toThrow();
  });
  it("remains disabled in a default server environment", () => {
    const before = process.env.NX_OPENMONTAGE_ENABLED;
    delete process.env.NX_OPENMONTAGE_ENABLED;
    try {
      const s = new OpenMontageService({} as never);
      expect(s.status().enabled).toBe(false);
      expect(s.status().ready).toBe(false);
    } finally {
      if (before === undefined) delete process.env.NX_OPENMONTAGE_ENABLED;
      else process.env.NX_OPENMONTAGE_ENABLED = before;
    }
  });
});
