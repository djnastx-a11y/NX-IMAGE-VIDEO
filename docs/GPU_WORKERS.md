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

Le registre des moteurs réels est dans `gpu-worker/nx_gpu/engines/__init__.py` (`REAL_ENGINES`). Un moteur est une classe `Engine` (`engines/base.py`) :

```python
class MonMoteur(Engine):
    def load(self):                        # télécharge/charge les poids une fois
        ...
    def run(self, operation, params, ctx): # une génération
        img = ctx.file("image")            # fichiers reçus
        ctx.progress(0.5, "Denoising")     # progression ; lève Cancelled si le job est annulé
        ...
        return [Output(path, seed=params.get("seed"), mime="video/mp4")]
```

Lever `EngineError(message, retryable=True)` pour une erreur passagère. Les moteurs réels prévus et leur choix sont expliqués dans [MODELS.md](MODELS.md). Ils ne peuvent être vérifiés que sur un vrai GPU : tant qu'ils n'ont pas tourné sur une machine GPU, ils ne sont pas considérés comme terminés.

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
