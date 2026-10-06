import type { Module } from "@nx/shared";

type Builtin = { slug: string; module: Module; name: string; description: string; params: Record<string, unknown> };

/** Starter presets (idempotently upserted at boot). User presets are separate and never touched. */
export const BUILTIN_PRESETS: Builtin[] = [
  {
    slug: "australia-street-halloween",
    module: "image",
    name: "Australia Street Halloween",
    description: "Affiche de soirée Halloween, ambiance rue de nuit, néons orange et violet.",
    params: {
      aspectRatio: "4:5",
      resolution: "1.5K",
      guidance: 6,
      quality: "high",
      prompt: "Halloween night party on Australia Street, glowing pumpkins, orange and purple neon, fog, crowd silhouettes, cinematic",
      negativePrompt: "blurry, low quality, watermark, deformed hands",
    },
  },
  {
    slug: "poster-editing",
    module: "image",
    name: "Poster Editing",
    description: "Édition d'affiche : garde la composition, modifie uniquement ce qui est demandé.",
    params: { operation: "edit", strength: 0.35, preserveComposition: true, guidance: 5, outputFormat: "png" },
  },
  {
    slug: "realistic-portrait",
    module: "image",
    name: "Realistic Portrait",
    description: "Portrait photo réaliste 4:5, peau naturelle, lumière douce.",
    params: {
      aspectRatio: "4:5",
      resolution: "1.5K",
      guidance: 4.5,
      quality: "high",
      negativePrompt: "plastic skin, oversaturated, extra fingers, cartoon, watermark",
    },
  },
  {
    slug: "product-commercial",
    module: "image",
    name: "Product Commercial",
    description: "Packshot produit 1:1 studio, fond propre, reflets maîtrisés.",
    params: { aspectRatio: "1:1", resolution: "1.5K", guidance: 7, quality: "high", negativePrompt: "clutter, text, watermark, low quality" },
  },
  {
    slug: "dj-promo",
    module: "video",
    name: "DJ Promo",
    description: "Reel 9:16 de 10 s pour promo DJ, zoom avant énergique.",
    params: { aspectRatio: "9:16", duration: 10, resolution: "720p", camera: { move: "zoom_in", intensity: 6 }, motionStrength: 0.7, subjectMotion: 0.7 },
  },
  {
    slug: "club-cinematic",
    module: "video",
    name: "Club Cinematic",
    description: "Ambiance club cinématique 21:9, travelling lent, lumières stroboscopiques.",
    params: {
      aspectRatio: "21:9",
      duration: 10,
      resolution: "1080p",
      camera: { move: "tracking", intensity: 4 },
      motionStrength: 0.5,
      creativity: 0.4,
      negativePrompt: "flicker artifacts, distorted faces, watermark",
    },
  },
  {
    slug: "cinematic-drone",
    module: "video",
    name: "Cinematic Drone",
    description: "Plan drone ascendant 16:9, mouvement ample et fluide.",
    params: { aspectRatio: "16:9", duration: 10, camera: { move: "drone", intensity: 6 }, motionStrength: 0.4, subjectMotion: 0.3 },
  },
  {
    slug: "fast-club-motion",
    module: "video",
    name: "Fast Club Motion",
    description: "9:16 nerveux, caméra à l'épaule, beaucoup de mouvement.",
    params: { aspectRatio: "9:16", duration: 5, camera: { move: "handheld", intensity: 8 }, motionStrength: 0.9, subjectMotion: 0.9, creativity: 0.6 },
  },
  {
    slug: "horror",
    module: "video",
    name: "Horror",
    description: "Dolly in lent et oppressant, faible créativité, tons froids.",
    params: {
      duration: 10,
      camera: { move: "dolly_in", intensity: 3 },
      motionStrength: 0.3,
      creativity: 0.35,
      negativePrompt: "bright colors, cheerful, cartoon",
    },
  },
  {
    slug: "natural-human-motion",
    module: "video",
    name: "Natural Human Motion",
    description: "Mouvements humains naturels, caméra fixe, forte fidélité à l'image source.",
    params: {
      operation: "image_to_video",
      camera: { move: "static", intensity: 2 },
      motionStrength: 0.45,
      subjectMotion: 0.6,
      sourceFidelity: 0.9,
      negativePrompt: "morphing, extra limbs, distorted face, jitter",
    },
  },
];
