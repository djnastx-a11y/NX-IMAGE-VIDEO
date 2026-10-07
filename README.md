# NX STUDIO

Studio privé de génération et d'édition d'images et de vidéos par IA, en deux modules.

- **NX IMAGE**
  - Génération : text to image, image to image, variations.
  - Édition : en langage naturel, inpainting au pinceau, outpainting, références.
  - Sortie : upscale, export PNG, JPEG ou WebP.
- **NX VIDEO**
  - Génération : text to video, image to video, first/last frame, video to video.
  - Caméra : 15 mouvements avec réglage d'intensité.
  - Suite d'une vidéo : variantes, extend.

Les deux modules partagent la bibliothèque de médias, l'historique, les projets, les presets, la file d'attente avec progression en direct et l'administration. Le bouton **Animate in NX VIDEO** envoie une image de NX IMAGE vers NX VIDEO.

NX STUDIO ne dépend d'aucun moteur. Les moteurs (Wan, LTX, FLUX, Qwen…) sont des *providers* interchangeables. Ils tournent sur une machine GPU séparée qui parle le **protocole NX GPU** : PC local, RunPod, Vast.ai, serveur dédié, ou gratuitement sur **Kaggle**, dont la session se connecte elle-même à NX STUDIO (voir [docs/GPU_WORKERS.md](docs/GPU_WORKERS.md#gpu-gratuit--kaggle-mode-agent)). Les moteurs de test (mocks) produisent de vrais fichiers PNG et MP4 sans GPU, ce qui permet de tout tester.

## Démarrage rapide (Docker)

```bash
cp .env.example .env        # renseigner au moins POSTGRES_PASSWORD
docker compose up -d --build
open http://localhost:8787   # la première visite propose de créer le compte admin
```

En local sans HTTPS, mettre `COOKIE_SECURE=false` dans `.env`, sinon le navigateur refuse le cookie de session.

## Démarrage en développement

Prérequis : Node 22 ou plus, PostgreSQL 16 et ffmpeg. Détails dans [docs/INSTALL.md](docs/INSTALL.md).

```bash
npm ci
createdb nxstudio
npm run dev                  # API sur :8787 et interface Vite sur :5173
```

## Tests

| Commande | Ce qui est testé |
|---|---|
| `npm test` | 14 tests unitaires (paramètres, tailles, compréhension des instructions d'édition) et 41 tests d'intégration sur un vrai PostgreSQL : auth, projets, uploads, chaque opération image et vidéo, file, statuts, retry, annulation, historique, bibliothèque, presets, admin, plus la chaîne GPU distante complète contre le serveur GPU Python, en mode serveur et en mode agent |
| `cd gpu-worker && pytest` | Le serveur GPU : protocole, authentification, sorties, échecs, annulation, et le câblage des moteurs réels (LTX, Wan, Qwen, FLUX, Real-ESRGAN) contre les signatures exactes de diffusers |
| `npm run e2e:server` puis `npm run e2e` | 7 parcours dans un vrai navigateur, sur desktop et sur téléphone, dont le parcours complet image → Animate → vidéo 10 s 9:16 → bibliothèque → téléchargement, variation, extend |

## Documentation

- [Installation et développement](docs/INSTALL.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Variables d'environnement](docs/CONFIGURATION.md)
- [Mise en production](docs/DEPLOYMENT.md)
- [Providers et capacités](docs/PROVIDERS.md)
- [Serveur GPU et protocole NX GPU](docs/GPU_WORKERS.md)
- [Base de données](docs/DATABASE.md)
- [Étude des moteurs réels](docs/MODELS.md)
- [Dépannage](docs/TROUBLESHOOTING.md)

## État

| Partie | État |
|---|---|
| Application complète avec les moteurs de test | Vérifiée : tests automatisés et navigateur, en local et sous Docker Compose |
| Chaîne NX STUDIO → serveur GPU → résultats | Vérifiée avec les moteurs « fake » du serveur GPU |
| Agent GPU (Kaggle) | Chaîne vérifiée avec les moteurs « fake ». Notebook Kaggle écrit, pas encore lancé sur Kaggle |
| Moteurs IA réels (LTX-2.5, LTX-Video 2B, Wan 2.2 A14B et 5B, Qwen-Image-Edit, FLUX.2, Real-ESRGAN) | Écrits, testés sans GPU, image Docker construite. Reste à les lancer et les mesurer sur une vraie machine GPU, voir [docs/GPU_WORKERS.md](docs/GPU_WORKERS.md#ce-qui-est-vérifié-et-ce-qui-ne-lest-pas-encore) |
