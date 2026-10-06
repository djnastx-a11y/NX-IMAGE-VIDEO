import { describe, expect, it } from "vitest";
import { createJobSchema, imageParamsSchema, imageSize, missingImageInputs, missingVideoInputs, parseEditInstruction, videoParamsSchema, videoSize } from "../src/index.js";

describe("natural-language edit instructions (Jb's examples)", () => {
  const cases: [string, string, Partial<{ targetRatio: string; preserveRest: boolean }>?][] = [
    ["Supprime toutes les écritures sans modifier le reste.", "remove_text", { preserveRest: true }],
    ["Remplace uniquement le décor.", "replace_background", { preserveRest: true }],
    ["Garde exactement le personnage et change uniquement ses vêtements.", "change_outfit", { preserveRest: true }],
    ["Change uniquement l'éclairage.", "change_lighting", { preserveRest: true }],
    ["Retire cet objet.", "remove_object"],
    ["Ajoute une moto rouge à gauche.", "add_object"],
    ["Passe cette image du 16:9 au 9:16 et reconstruis naturellement les zones manquantes.", "reframe", { targetRatio: "9:16" }],
    ["Replace the background with a beach at sunset", "replace_background"],
    ["Remove the watermark", "remove_text"],
  ];
  it.each(cases)("%s", (text, type, extra) => {
    const intent = parseEditInstruction(text);
    expect(intent.type).toBe(type);
    if (extra) expect(intent).toMatchObject(extra);
  });

  it("extracts the replacement target", () => {
    expect(parseEditInstruction("Remplace le fond par une rue de nuit sous la pluie").target).toBe("rue de nuit sous la pluie");
  });
});

describe("sizes", () => {
  it("video: short edge from the resolution, even dimensions", () => {
    expect(videoSize({ aspectRatio: "9:16", resolution: "720p" })).toEqual({ width: 720, height: 1280 });
    expect(videoSize({ aspectRatio: "16:9", resolution: "1080p" })).toEqual({ width: 1920, height: 1080 });
    expect(videoSize({ aspectRatio: "9:16", resolution: "480p" })).toEqual({ width: 480, height: 854 });
  });
  it("image: long edge from the resolution, custom size wins", () => {
    expect(imageSize({ aspectRatio: "1:1", resolution: "1K", width: null, height: null })).toEqual({ width: 1024, height: 1024 });
    expect(imageSize({ aspectRatio: "4:5", resolution: "2K", width: null, height: null })).toEqual({ width: 1638, height: 2048 });
    expect(imageSize({ aspectRatio: "1:1", resolution: "1K", width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });
});

describe("parameter schemas", () => {
  it("fills defaults and reports missing inputs", () => {
    const v = videoParamsSchema.parse({ operation: "image_to_video" });
    expect(v.duration).toBe(5);
    expect(missingVideoInputs(v)).toContain("image source");
    const i = imageParamsSchema.parse({ operation: "inpaint", sourceMediaId: "00000000-0000-4000-8000-000000000000" });
    expect(missingImageInputs(i)).toEqual(["masque"]);
  });
  it("rejects out-of-range values", () => {
    expect(() => videoParamsSchema.parse({ operation: "text_to_video", duration: 600 })).toThrow();
    expect(() => imageParamsSchema.parse({ operation: "text_to_image", numOutputs: 9 })).toThrow();
    expect(() => createJobSchema.parse({ module: "video", params: { operation: "text_to_video" }, count: 9 })).toThrow();
  });
});
