# Serveur GPU et protocole NX GPU

NX STUDIO ne lance jamais de modèle IA lui-même. Il envoie les générations à un ou plusieurs **serveurs GPU** qui parlent le protocole NX GPU, un petit protocole HTTP. Le serveur fourni est dans `gpu-worker/` (Python, FastAPI). La même image tourne sur un PC avec une carte NVIDIA, un pod RunPod, une instance Vast.ai ou un serveur dédié.

Deux façons de relier une machine GPU :

```
mode serveur : NX STUDIO (worker)  ──HTTPS + jeton──►  serveur GPU (nx_gpu.server)
mode agent   : NX STUDIO  ◄──HTTPS + jeton──  agent GPU (nx_gpu.agent), qui vient chercher le travail
```

- **Mode serveur** : la machine GPU doit être joignable depuis NX STUDIO (RunPod, Vast.ai, serveur dédié).
- **Mode agent** : la machine GPU n'a besoin d'aucune adresse publique. C'est elle qui se connecte à NX STUDIO. C'est le mode à utiliser avec le GPU gratuit de **Kaggle**, voir [plus bas](#gpu-gratuit--kaggle-mode-agent).

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
| `ltx-video` | `Lightricks/LTX-Video-0.9.5` (2B) | texte→vidéo, image→vidéo, first/last frame, keyframes, vidéo→vidéo, extend ; jusqu'à 10 s à 24 i/s | 16 Go (T4 de Kaggle) |
| `wan-5b` | `Wan-AI/Wan2.2-TI2V-5B-Diffusers` | texte→vidéo, image→vidéo, extend ; 5 s à 24 i/s | 16 Go avec `NX_GPU_OFFLOAD=model`, lent sur T4 |
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
| `NX_LTXV_MODEL`, `NX_LTXV_STEPS` | voir tableau, `40` | LTX-Video 2B (`ltx-video`) |
| `NX_WAN5B_MODEL`, `NX_WAN5B_STEPS` | voir tableau, `30` | Wan 2.2 5B (`wan-5b`) |
| `NX_GPU_DTYPE` | automatique | `bfloat16` si la carte le gère vraiment (RTX 30xx et plus récentes, A100, H100…), sinon `float16` (T4, P100). À forcer seulement en cas de souci |
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
- L'image Docker se construit. diffusers 0.41.0, transformers 5.19 et PyTorch s'y importent ensemble, et les moteurs s'y créent.
- `tests/test_engines.py` (13 tests) remplace PyTorch et les modèles par des doublures, puis vérifie pour chaque opération :
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
| **Kaggle (gratuit)** | Sans rien payer | Mode agent. T4 16 Go, 30 h par semaine, sessions de 12 h au plus. Moteurs légers seulement (`ltx-video`, `wan-5b`, `flux`, `real-esrgan`). Usage personnel non commercial |
| **PC local avec carte NVIDIA** | 24 Go de VRAM ou plus (RTX 4090/5090) | Gratuit à l'usage. Le Mac ne convient pas : les moteurs vidéo visés demandent CUDA |
| **RunPod** (pod ou serverless) | Le plus simple à la demande | Choisir un GPU de 48 Go ou plus (L40S, A6000, H100). Exposer le port 8188 en HTTPS via le proxy RunPod et définir `NX_GPU_TOKEN` |
| **Vast.ai** | Le moins cher | Machines de particuliers : qualité variable. Toujours un jeton |
| **Serveur dédié** | Usage intensif et régulier | Mettre un reverse proxy HTTPS devant le port 8188 |

Dans tous les cas :
- le serveur GPU est joignable depuis Internet, donc **`NX_GPU_TOKEN` est obligatoire** ;
- le jeton ne va que dans les variables d'environnement du serveur GPU et du serveur NX STUDIO, jamais dans l'interface ;
- mettre les poids des modèles sur un volume persistant (`HF_HOME`), pour ne pas les retélécharger à chaque démarrage.

Plusieurs serveurs GPU peuvent être déclarés dans `NX_GPU_ENDPOINTS`. Le routage choisit alors celui qui est disponible et sert le moteur demandé.

## GPU gratuit : Kaggle (mode agent)

Kaggle prête gratuitement une carte NVIDIA T4 (16 Go) ou P100, **30 heures par semaine**, par sessions de 12 heures au plus. Une session Kaggle n'a pas d'adresse publique : c'est pourquoi l'agent se connecte lui-même à NX STUDIO et vient chercher le travail (« long polling » HTTPS). NX STUDIO, lui, doit être joignable depuis Internet, voir [Rendre NX STUDIO joignable depuis un Mac](#rendre-nx-studio-joignable-depuis-un-mac).

### 1. Côté NX STUDIO

Déclarer l'agent et son jeton (un long jeton aléatoire, par exemple `openssl rand -hex 32`) dans `.env` :

```bash
NX_GPU_AGENTS='[{"id":"kaggle","tokenEnv":"NX_GPU_AGENT_TOKEN_KAGGLE","engines":["ltx-video","wan-5b","flux","real-esrgan"]}]'
NX_GPU_AGENT_TOKEN_KAGGLE=<jeton>
```

`engines` liste tout ce que l'agent *peut* servir. Les moteurs apparaissent dans **Settings → Moteurs** sous les ids `ltx-video@kaggle`, `flux@kaggle`, etc. Seuls ceux que la session en cours a chargés sont disponibles. Quand la session Kaggle est arrêtée, ils passent hors ligne, et un job déjà envoyé échoue proprement après environ 3 minutes (il est relancé si d'autres tentatives restent).

Pour ne jamais recevoir de résultat factice, mettre aussi `NX_ENABLE_MOCK=false` : sans GPU connecté, la génération refuse alors de démarrer au lieu d'utiliser les moteurs de test.

### 2. Côté Kaggle

Le notebook prêt à l'emploi est [`gpu-worker/kaggle/nx-studio-gpu.ipynb`](../gpu-worker/kaggle/nx-studio-gpu.ipynb).

1. Créer un compte sur kaggle.com et vérifier son numéro de téléphone (obligatoire pour le GPU et Internet).
2. *Create → New Notebook*, puis *File → Import Notebook* et choisir le fichier `.ipynb`.
3. *Settings → Accelerator* : **GPU T4 x2** (ou P100). *Settings → Internet* : **On**.
4. *Add-ons → Secrets* : ajouter `NX_URL` (l'adresse publique de NX STUDIO, par exemple `https://mon-mac.tailXXXX.ts.net`) et `NX_GPU_AGENT_TOKEN` (le même jeton que `NX_GPU_AGENT_TOKEN_KAGGLE`), et les cocher pour ce notebook.
5. Dans la 2e cellule, choisir les moteurs de la session (la mémoire ne permet pas de tout charger à la fois) :
   - `ltx-video,real-esrgan` : vidéo et upscale (par défaut) ;
   - `flux,real-esrgan` : images et upscale ;
   - `wan-5b` : vidéo plus fidèle, mais beaucoup plus lente sur T4.
6. *Save Version → Save & Run All*. La session tourne alors en arrière-plan jusqu'à 12 h, même onglet fermé. Pour l'arrêter et économiser le quota : *View Active Events → Stop*.

Au premier lancement de chaque session, les poids sont téléchargés depuis Hugging Face (plusieurs Go), ce qui prend quelques minutes avant que les moteurs n'apparaissent dans NX STUDIO.

### Le protocole agent

Toutes les routes exigent `Authorization: Bearer <jeton>`. Un agent ne voit que ses propres tâches.

| Route | Rôle |
|---|---|
| `POST /api/gpu-agent/heartbeat` | Signale l'agent et ses moteurs chargés (toutes les 10 s) |
| `POST /api/gpu-agent/claim` | Attend jusqu'à 25 s une tâche, et la renvoie dès qu'il y en a une |
| `GET /api/gpu-agent/tasks/:id/files/:champ` | Fichier d'entrée de la tâche |
| `POST /api/gpu-agent/tasks/:id/progress` | Progression ; la réponse `{ cancel }` transmet l'annulation |
| `POST /api/gpu-agent/tasks/:id/outputs?index&mime&seed` | Envoi d'un résultat (multipart) |
| `POST /api/gpu-agent/tasks/:id/complete` et `/fail` | Fin de la tâche |

Les fichiers d'une tâche sont supprimés du stockage de NX STUDIO dès que le job est terminé. Cette chaîne est couverte par `apps/server/test/agent.test.ts` avec l'agent Python et ses moteurs « fake » : jeton refusé, agent hors ligne, image→vidéo 9:16 puis extend à 10 s, plusieurs images, nettoyage, échec, retry, annulation.

### Limites honnêtes

- **Pas encore lancé sur Kaggle.** Le notebook et les moteurs légers sont testés sans GPU (signatures diffusers, chaîne complète avec moteurs « fake »). La compatibilité avec la version de PyTorch installée par Kaggle, la mémoire et les temps réels restent à vérifier à la première session.
- **Vitesse.** Le T4 est une carte de 2018. Il faut compter plusieurs minutes pour un clip LTX-Video de 5 s en 480p, nettement plus en 720p ou avec `wan-5b`. C'est une estimation, pas une mesure.
- **Qualité.** Ces modèles légers sont en dessous de Kling ou Veo. Les moteurs `ltx` (LTX-2.5) et `wan` (A14B) sont meilleurs mais demandent 48 Go.
- **Disponibilité.** Quota de 30 h par semaine ; il faut relancer le notebook à chaque session.

## Rendre NX STUDIO joignable depuis un Mac

L'agent Kaggle et le téléphone doivent pouvoir joindre NX STUDIO par Internet. Sur un Mac, le plus simple et gratuit est **Tailscale Funnel**, qui donne une adresse HTTPS fixe du type `https://mon-mac.tailXXXX.ts.net` :

1. Lancer NX STUDIO sur le Mac avec Docker Desktop (gratuit pour un usage personnel) : `docker compose up -d --build`, voir le [README](../README.md). Garder `COOKIE_SECURE=true` : Funnel fournit le HTTPS.
2. Installer l'application Tailscale pour macOS et se connecter (compte gratuit).
3. Dans la console Tailscale (*DNS*), activer **MagicDNS** et **HTTPS Certificates**.
4. Dans le Terminal : `tailscale funnel --bg 8787`. La commande affiche l'adresse publique ; c'est la valeur de `NX_URL` et `PUBLIC_URL`.

Le Mac doit rester allumé et ne pas se mettre en veille pendant l'utilisation (*Réglages → Écran → Options avancées → Empêcher la suspension automatique* sur secteur). Les médias restent sur le Mac ; seuls les fichiers d'une génération en cours transitent par Kaggle, et Kaggle efface sa machine à la fin de chaque session.
