# Providers et capacités

Un *provider* est un moteur de génération vu par NX STUDIO. Le code de l'application ne connaît aucun modèle en particulier : il ne manipule que l'interface `ImageProvider` ou `VideoProvider` (`apps/server/src/providers/types.ts`).

## Le contrat

Chaque provider déclare :

| Champ | Exemple | Rôle |
|---|---|---|
| `id` | `mock-video`, `ltx@runpod-1` | Identifiant unique. Pour un moteur distant : `<moteur>@<serveur GPU>` |
| `engine` | `ltx` | Famille de moteur. L'utilisateur peut choisir une famille plutôt qu'un serveur précis |
| `module` | `image` ou `video` | |
| `capabilities` | `image_to_video`, `camera_control`, `seed`… | Ce que le moteur sait faire. L'interface n'affiche que les réglages correspondants |
| `limits` | `maxDuration: 20`, `resolutions: ["720p"]`, `maxOutputs: 4` | Limites vérifiées avant d'accepter un job |
| `quality` | `{ image_to_video: 92 }` | Score par opération, utilisé par le routage automatique |
| `health()` | | Disponibilité en direct (serveur GPU joignable, modèle chargé) |

Puis une méthode par opération, chacune optionnelle :

- Image : `generateTextToImage`, `generateImageToImage`, `editImage`, `inpaint`, `outpaint`, `upscale`, `createVariation`.
- Vidéo : `generateTextToVideo`, `generateImageToVideo`, `generateVideoToVideo`, `generateFirstLastFrame`, `extendVideo`.

Une opération n'est utilisable que si la méthode existe **et** que la capacité du même nom est déclarée. Le statut et l'annulation ne font pas partie de l'interface : le statut vit dans la base (file de jobs), et l'annulation arrive au provider par un `AbortSignal`.

Le provider renvoie un fichier brut. C'est le worker qui le ré-encode (MP4 H.264 `faststart` ou image au format demandé), crée la miniature et le range dans le stockage. Pour `extendVideo`, le provider ne renvoie que la suite ; le worker la colle après la vidéo d'origine.

La liste complète des capacités est dans `packages/shared/src/common.ts`.

## Routage : quel moteur prend un job

Le champ `model` d'une génération accepte trois formes (`apps/server/src/providers/registry.ts`) :

1. **`auto`** : si l'admin a choisi un moteur par défaut pour le module, il est utilisé s'il peut prendre le job. Sinon, NX STUDIO prend le provider disponible qui a le meilleur score `quality` pour l'opération.
2. **Une famille** (`ltx`, `wan`, `flux`…) : le meilleur serveur disponible qui la sert.
3. **Un id exact** (`ltx@runpod-1`) : ce provider-là.

Un provider est écarté s'il est désactivé, s'il ne gère pas l'opération, si la durée, la résolution ou le nombre d'images dépasse ses limites, ou s'il ne répond pas. Si aucun ne reste, la génération est refusée tout de suite (HTTP 422, code `no_provider`) avec la raison de chaque refus, au lieu d'attendre dans la file.

## Administration

**Settings → Moteurs** (admin) liste tous les providers avec leur backend, leurs capacités et leur santé. On peut :
- activer ou désactiver un provider ;
- le définir comme moteur par défaut de son module ;
- le tester (appel de santé avec la latence).

Ces choix sont stockés dans la table `providers`. Les providers eux-mêmes viennent du code (mocks) et de `NX_GPU_ENDPOINTS` (moteurs distants). Aucun secret n'est stocké en base.

## Les moteurs de test (mocks)

`mock-image` et `mock-video` tournent sur le CPU avec ffmpeg et produisent de vrais fichiers : dégradés et motifs pour les images, et pour la vidéo un rendu qui applique le mouvement de caméra demandé à l'image source. Ils déclarent toutes les capacités, ce qui permet de tester toute l'interface sans GPU. Ils se désactivent avec `NX_ENABLE_MOCK=false`.

Mots-clés dans le prompt, pour tester les cas difficiles :

| Mot-clé | Effet |
|---|---|
| `#fail` | Échec définitif : le job finit en *Failed* |
| `#fail-once` | Échec passager à la première tentative, puis réussite via le retry automatique |
| `#slow` | Job trois fois plus long, pour tester l'annulation et la file |

## Les moteurs distants

Ils sont déclarés dans `NX_GPU_ENDPOINTS` (voir [CONFIGURATION](CONFIGURATION.md)) et parlent le protocole NX GPU (voir [GPU_WORKERS](GPU_WORKERS.md)). Pour chaque serveur GPU, NX STUDIO :
1. prend la liste `engines` de la configuration, ou à défaut celle que renvoie `/v1/health` au démarrage ;
2. crée un provider par moteur connu du catalogue (`apps/server/src/providers/remote/catalog.ts`) ;
3. met à jour capacités et limites avec ce que le serveur GPU annonce dans `/v1/health`.

Le catalogue décrit les moteurs étudiés dans [MODELS.md](MODELS.md) :

| Id | Module | Moteur |
|---|---|---|
| `ltx` | vidéo | LTX-2.5, jusqu'à 20 s, moteur image→vidéo recommandé |
| `wan` | vidéo | Wan 2.2 A14B, clips de 5 s (10 s via Extend) |
| `hunyuan` | vidéo | HunyuanVideo 1.5 (licence exclue en UE) |
| `qwen-image` | image | Qwen-Image |
| `qwen-image-edit` | image | Qwen-Image-Edit 2511, l'édition en langage naturel |
| `flux` | image | FLUX.2 [klein] 4B |
| `sdxl` | image | SDXL |
| `real-esrgan` | image | Upscale |

Pour l'édition, NX STUDIO envoie au serveur GPU l'instruction déjà analysée (`intent` : action, cible, valeur, par exemple « changer le texte en NX STUDIO »). Il envoie aussi la taille de sortie calculée (`target`), si bien que les moteurs n'ont ni format ni langage à interpréter.

## Ajouter un provider

**Un nouveau moteur open-source (cas normal)**
1. L'implémenter côté serveur GPU (`gpu-worker/nx_gpu/engines/`, voir [GPU_WORKERS](GPU_WORKERS.md)).
2. Ajouter son entrée dans `catalog.ts` : nom, capacités, limites, scores.
3. L'ajouter à `NX_ENGINES` sur la machine GPU.

Aucun autre changement n'est nécessaire : l'interface s'adapte aux capacités.

**Une API externe (service hébergé)**
1. Écrire une classe qui implémente `ImageProvider` ou `VideoProvider`, sur le modèle de `providers/remote/remote-provider.ts`.
2. Lire sa clé d'API dans une variable d'environnement du serveur, jamais dans la base ni dans l'interface.
3. L'enregistrer dans `services/container.ts`.
4. Lever `ProviderError(message, code, retryable)` en cas d'échec : `retryable = true` pour une panne passagère (quota, timeout), `false` pour une erreur de paramètres.
