# Serveur GPU et protocole NX GPU

NX STUDIO ne lance jamais de modèle IA lui-même. Il envoie les générations à un ou plusieurs **serveurs GPU** qui parlent le protocole NX GPU, un petit protocole HTTP. Le serveur fourni est dans `gpu-worker/` (Python, FastAPI). La même image tourne sur un PC avec une carte NVIDIA, un pod RunPod, une instance Vast.ai ou un serveur dédié.

```
NX STUDIO (worker)  ──HTTPS + jeton──►  serveur GPU  ──►  moteurs (LTX, Wan, FLUX, Qwen…)
```

## Le protocole

Toutes les routes exigent `Authorization: Bearer <jeton>` dès que le serveur a un jeton (`NX_GPU_TOKEN`). La comparaison du jeton se fait en temps constant.

| Route | Réponse |
|---|---|
| `GET /v1/health` | `{ ok, version, gpu, queue, engines: [{ id, module, capabilities, limits, loaded }], failed_engines }` |
| `POST /v1/jobs` (multipart) | `{ id }`. Champs : `engine`, `operation`, `job_id` (id NX STUDIO, pour les logs), `params` (JSON), puis les fichiers |
| `GET /v1/jobs/:id` | `{ id, status, stage, progress, error, retryable, outputs: [{ index, seed, mime }] }` |
| `POST /v1/jobs/:id/cancel` | `{ ok }` |
| `GET /v1/jobs/:id/outputs/:n` | Le fichier produit |

- **Statuts :** `queued`, `running`, `completed`, `failed`, `cancelled`. `progress` va de 0 à 1.
- **Fichiers image :** `source`, `mask`, `reference_0`, `reference_1`…
- **Fichiers vidéo :** `image`, `end_image`, `reference`, `video`, `keyframe_0`…
- **`params`** contient les paramètres de la génération, plus :
  - `target` : la taille de sortie exacte en pixels ;
  - `intent` : pour l'édition, l'instruction déjà analysée ;
  - `references` et `keyframes` : le lien entre chaque fichier et son type, son poids ou sa position.
- **Erreurs :** `retryable: true` signale une panne passagère (manque de mémoire GPU, par exemple). NX STUDIO relance alors le job automatiquement ; sinon le job échoue tout de suite.
- **Extend :** NX STUDIO l'envoie comme un `image_to_video` à partir de la dernière image de la vidéo, puis colle lui-même la suite.

Côté NX STUDIO, le client interroge le statut toutes les secondes et tolère 15 erreurs réseau d'affilée avant d'abandonner (erreur *retryable*). L'annulation dans l'interface est transmise au serveur GPU. Le serveur GPU exécute les jobs un par un (`NX_GPU_CONCURRENCY=1`) et supprime les fichiers d'un job une heure après la fin (`NX_GPU_JOB_TTL`).

## Lancer le serveur GPU sans GPU (moteurs « fake »)

Les moteurs `fake:<id>` ont les mêmes ids et capacités que les vrais, mais produisent des images et vidéos de test avec ffmpeg. Ils servent à tester toute la chaîne n'importe où.

```bash
cd gpu-worker
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
NX_ENGINES=fake:ltx,fake:wan,fake:flux,fake:qwen-image-edit,fake:real-esrgan \
NX_GPU_TOKEN=un-long-jeton-aleatoire \
.venv/bin/python -m nx_gpu.server          # écoute sur :8188
```

Puis côté NX STUDIO :

```bash
NX_GPU_ENDPOINTS='[{"id":"local-gpu","url":"http://127.0.0.1:8188","tokenEnv":"NX_GPU_TOKEN_LOCAL"}]'
NX_GPU_TOKEN_LOCAL=un-long-jeton-aleatoire
```

Les moteurs apparaissent dans **Settings → Moteurs** sous les ids `ltx@local-gpu`, `wan@local-gpu`, etc. Mots-clés de test dans le prompt :
- `#fail` : échec définitif ;
- `#oom` : manque de mémoire simulé, donc *retryable* ;
- `#slow` : cinq fois plus long.

Cette chaîne est couverte par `apps/server/test/remote.test.ts` (découverte, vidéo 5 s puis extend à 10 s, plusieurs images, upscale, refus d'une opération non gérée, échecs, retry, annulation).

## Moteurs réels

Ils sont écrits avec la bibliothèque open-source **diffusers** (Hugging Face) et téléchargent les poids publics des modèles au premier chargement.

| Id | Modèle (par défaut) | Opérations | Mémoire GPU visée |
|---|---|---|---|
| `ltx` | `Lightricks/LTX-2.5-Diffusers` | texte→vidéo, image→vidéo, first/last frame, keyframes, vidéo→vidéo, extend ; jusqu'à 20 s | 48 Go et plus |
| `wan` | `Wan-AI/Wan2.2-I2V-A14B-Diffusers` et `…-T2V-A14B-Diffusers` | texte→vidéo, image→vidéo, first/last frame, extend ; 5 s à 16 i/s | 48 Go et plus |
| `qwen-image-edit` | `Qwen/Qwen-Image-Edit-2511` | édition en langage naturel avec références, inpainting, outpainting | 48 Go et plus |
| `qwen-image` | `Qwen/Qwen-Image` | texte→image, image→image, variations | 48 Go et plus |
| `flux` | `black-forest-labs/FLUX.2-klein-4B` | texte→image, image→image, édition, variations, références | 16 Go et plus |
| `real-esrgan` | `RealESRGAN_x4plus` | upscale x2/x4 ou à une largeur donnée | 4 Go et plus |

Choix de mise en œuvre :
- **Mouvements de caméra.** Ils sont écrits dans le prompt (« the camera dollies in toward the subject, smoothly »), avec un vocabulaire qui dépend de l'intensité. Ces modèles suivent bien ce langage, et aucun module supplémentaire n'est nécessaire.
- **Taille de sortie.** Les modèles exigent des multiples de 16 ou 32 pixels. Le moteur génère à la taille valide la plus proche, puis la vidéo ou l'image est recadrée à la taille exacte demandée (720×1280 pour du 9:16 en 720p).
- **Durée LTX.** 10 s à 24 i/s donnent 241 images.
- **Durée Wan.** Wan produit 5 s ; 10 s s'obtiennent avec Extend.
- **Vidéo→vidéo LTX.** La vidéo source sert de conditionnement, avec la force choisie dans l'interface. Pour un vrai transfert de style, LTX propose des modules IC-LoRA, à évaluer.
- **Échecs.** Un manque de mémoire GPU devient une erreur *retryable*. L'annulation arrête le calcul entre deux étapes.
- **Chargement.** Un moteur qui ne se charge pas (poids introuvables, pas de GPU) n'empêche pas les autres de tourner : il apparaît dans `failed_engines` avec son erreur.

### Réglages

| Variable | Défaut | Rôle |
|---|---|---|
| `NX_GPU_OFFLOAD` | `model` | `none` : tout en mémoire GPU, le plus rapide si elle suffit. `model` : chaque sous-modèle passe sur le GPU seulement quand il travaille. `sequential` : le moins de mémoire, le plus lent |
| `NX_LTX_MODEL`, `NX_LTX_STEPS` | voir tableau, `30` | Modèle et nombre d'étapes LTX (une version distillée tourne en environ 8 étapes) |
| `NX_WAN_I2V_MODEL`, `NX_WAN_T2V_MODEL`, `NX_WAN_STEPS` | voir tableau, `40` | Wan ; `NX_WAN_KEEP_BOTH=1` garde les deux modèles chargés |
| `NX_QWEN_IMAGE_MODEL`, `NX_QWEN_EDIT_MODEL`, `NX_QWEN_STEPS` | voir tableau, `40` | Qwen |
| `NX_FLUX_MODEL`, `NX_FLUX_STEPS`, `NX_FLUX_STEPS_DISTILLED` | voir tableau, `50`, `4` | FLUX.2 (klein est distillé : 4 étapes) |
| `NX_ESRGAN_WEIGHTS`, `NX_ESRGAN_TILE` | téléchargé, `512` | Poids Real-ESRGAN et taille des tuiles |
| `HF_HOME`, `NX_GPU_MODELS_DIR` | `/models/hf`, `/models/nx` dans l'image | Où les poids sont stockés : à mettre sur un volume persistant |

### Image Docker

```bash
docker build -t nx-gpu gpu-worker
docker run --gpus all -p 8188:8188 -v nx-models:/models \
  -e NX_ENGINES=ltx,qwen-image-edit,real-esrgan -e NX_GPU_TOKEN=<jeton> nx-gpu
```

L'image contient PyTorch 2.14 compilé pour **CUDA 13**. La machine GPU doit donc avoir un pilote NVIDIA récent (série 580 ou plus) et le NVIDIA Container Toolkit. Sur RunPod et Vast.ai, filtrer les machines sur « CUDA 13 ».

### Ce qui est vérifié, et ce qui ne l'est pas encore

**Vérifié ici, sans GPU :**
- L'image Docker se construit. diffusers 0.41.0, transformers 5.19 et PyTorch s'y importent ensemble, et les six moteurs s'y créent.
- `tests/test_engines.py` (11 tests) remplace PyTorch et les modèles par des doublures, puis vérifie pour chaque opération :
  - la traduction des paramètres (taille, nombre d'images, conditionnements, caméra, guidance, seed) ;
  - que chaque argument passé existe bien dans la signature réelle du pipeline diffusers 0.41.0 ;
  - la progression, l'annulation et le manque de mémoire ;
  - l'encodage du MP4 final à la bonne taille, analysé avec ffprobe.
- Un job qui arrive pendant le chargement initial attend ce chargement, au lieu de charger le modèle une seconde fois.
- `bench.py` a tourné contre le serveur GPU avec les moteurs « fake ».

**Pas encore vérifié, faute de GPU :**
- la qualité des résultats ;
- les temps de génération ;
- la mémoire réellement utilisée ;
- le téléchargement des poids.

C'est le rôle de `bench.py` sur la première machine GPU.

### Mesurer sur une vraie machine GPU

```bash
python bench.py --url https://<serveur-gpu> --token <jeton> --image photo.jpg --repeat 2
```

Le script lance les cas types de [MODELS.md](MODELS.md) (image→vidéo 5 et 10 s en 9:16 720p, texte→vidéo, édition, texte→image, upscale) pour les moteurs chargés. Il mesure le temps et, s'il tourne sur la machine GPU, le pic de mémoire. Il range les résultats et un rapport JSON dans `bench-results/`. Le premier passage inclut le chargement du modèle, d'où `--repeat 2`.

## Où faire tourner le serveur GPU

| Option | Pour qui | Points d'attention |
|---|---|---|
| **PC local avec carte NVIDIA** | 24 Go de VRAM ou plus (RTX 4090/5090) | Gratuit à l'usage. Le Mac ne convient pas : les moteurs vidéo visés demandent CUDA |
| **RunPod** (pod ou serverless) | Le plus simple à la demande | Choisir un GPU de 48 Go ou plus (L40S, A6000, H100). Exposer le port 8188 en HTTPS via le proxy RunPod et définir `NX_GPU_TOKEN` |
| **Vast.ai** | Le moins cher | Machines de particuliers : qualité variable. Toujours un jeton |
| **Serveur dédié** | Usage intensif et régulier | Mettre un reverse proxy HTTPS devant le port 8188 |

Dans tous les cas :
- le serveur GPU est joignable depuis Internet, donc **`NX_GPU_TOKEN` est obligatoire** ;
- le jeton ne va que dans les variables d'environnement du serveur GPU et du serveur NX STUDIO, jamais dans l'interface ;
- mettre les poids des modèles sur un volume persistant (`HF_HOME`), pour ne pas les retélécharger à chaque démarrage.

Plusieurs serveurs GPU peuvent être déclarés dans `NX_GPU_ENDPOINTS`. Le routage choisit alors celui qui est disponible et sert le moteur demandé.
