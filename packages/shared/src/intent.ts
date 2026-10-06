/**
 * Natural-language edit instructions → structured intent.
 *
 * Instruction-following editing models (FLUX Kontext, Qwen-Image-Edit...) consume the raw
 * instruction directly; the intent is still computed so that:
 *  - the UI can show how the instruction was understood,
 *  - non-instruction engines can be driven (reframe → outpaint, etc.),
 *  - the mock provider can apply a visible, matching transformation.
 */
import { IMAGE_RATIOS, type ImageRatio } from "./image.js";

export const EDIT_INTENTS = [
  "remove_text",
  "remove_object",
  "add_object",
  "replace_object",
  "replace_background",
  "change_outfit",
  "change_lighting",
  "reframe",
  "style",
  "generic",
] as const;
export type EditIntentType = (typeof EDIT_INTENTS)[number];

export interface EditIntent {
  type: EditIntentType;
  /** Object / element the edit is about, when it could be extracted */
  target: string | null;
  /** reframe: the requested aspect ratio */
  targetRatio: ImageRatio | null;
  /** True when the instruction insists the rest of the image must stay untouched */
  preserveRest: boolean;
  label: string;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, " ");

const LABEL: Record<EditIntentType, string> = {
  remove_text: "Suppression des textes",
  remove_object: "Suppression d'un élément",
  add_object: "Ajout d'un élément",
  replace_object: "Remplacement d'un élément",
  replace_background: "Remplacement du décor",
  change_outfit: "Changement de tenue",
  change_lighting: "Changement d'éclairage",
  reframe: "Recadrage avec reconstruction",
  style: "Changement de style",
  generic: "Édition libre",
};

function after(text: string, words: string[]): string | null {
  for (const w of words) {
    const re = new RegExp(`\\b${w}\\b\\s+(?:(?:le|la|les|l|un|une|des|du|de|cet|cette|ce|ces|the|a|an|this|that)\\s+)?([^,.;]+)`);
    const m = re.exec(text);
    if (m?.[1]) return m[1].replace(/\s+(sans|without|et|and|mais|but)\b.*$/, "").trim().slice(0, 80) || null;
  }
  return null;
}

export function parseEditInstruction(instruction: string): EditIntent {
  const t = norm(instruction);
  const preserveRest = /(sans (rien )?(modifier|changer|toucher)|uniquement|seulement|exactement|garde|keep|only|without changing|rest unchanged)/.test(t);
  const make = (type: EditIntentType, target: string | null = null, targetRatio: ImageRatio | null = null): EditIntent => ({
    type,
    target,
    targetRatio,
    preserveRest,
    label: LABEL[type] + (target ? ` : ${target}` : targetRatio ? ` vers ${targetRatio}` : ""),
  });

  const ratios = [...t.matchAll(/\b(\d{1,2})\s*[:/x]\s*(\d{1,2})\b/g)].map((m) => `${m[1]}:${m[2]}`);
  const lastRatio = ratios.reverse().find((r) => (IMAGE_RATIOS as readonly string[]).includes(r)) as ImageRatio | undefined;
  if (lastRatio && /(passe|convert|reframe|recadr|format|etend|extend|reconstru|outpaint|zones? manquantes?)/.test(t)) {
    return make("reframe", null, lastRatio);
  }

  const removeVerb = /(supprim|retir|enleve|efface|remove|erase|delete|get rid)/.test(t);
  if (removeVerb && /(ecriture|texte|text|lettr|watermark|filigrane|logo|inscription|sous-titre|caption)/.test(t)) {
    return make("remove_text");
  }
  if (/(decor|arriere-plan|arriere plan|fond|background|backdrop|scene)/.test(t) && /(remplac|change|modifi|replace|swap|met|mettre|place)/.test(t)) {
    return make("replace_background", after(t, ["par", "with", "en", "dans", "into"]));
  }
  if (/(vetement|tenue|habit|outfit|clothes|clothing|robe|veste|costume|t-shirt|tshirt|chemise|dress|jacket)/.test(t)) {
    return make("change_outfit", after(t, ["par", "with", "en", "into"]));
  }
  if (/(eclairage|lumiere|lighting|light|eclaire|golden hour|neon|nuit|night|coucher de soleil|sunset|ombre)/.test(t)) {
    return make("change_lighting", after(t, ["en", "par", "to", "with", "pour"]));
  }
  if (removeVerb) return make("remove_object", after(t, ["supprime", "retire", "enleve", "efface", "remove", "erase", "delete"]));
  if (/(remplac|replace|swap)/.test(t)) return make("replace_object", after(t, ["remplace", "replace", "swap"]));
  if (/(ajout|rajout|add|insere|insert|place|mets|mettre)/.test(t)) return make("add_object", after(t, ["ajoute", "rajoute", "add", "insere", "insert", "place", "mets"]));
  if (/(style|anime|manga|aquarelle|watercolor|peinture|painting|cinematique|cinematic|noir et blanc|black and white|vintage)/.test(t)) {
    return make("style", after(t, ["en", "style", "into", "as"]));
  }
  return make("generic");
}
