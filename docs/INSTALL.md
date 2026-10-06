# Installation et développement

## Prérequis

| Outil | Version | Pourquoi |
|---|---|---|
| Node.js | 22 ou plus | Serveur et interface |
| PostgreSQL | 16 (14 ou plus devrait marcher) | Données et file d'attente des jobs |
| ffmpeg | 6.x | Miniatures, encodage MP4, export d'images, moteurs de test |
| Python | 3.10 ou plus | Seulement pour le serveur GPU (`gpu-worker/`) |

Sur Mac (Homebrew) : `brew install node@22 postgresql@16 ffmpeg && brew services start postgresql@16`.

## Installation

```bash
npm ci
createdb nxstudio               # ou : psql -c "CREATE DATABASE nxstudio"
```

Par défaut, le serveur se connecte à `postgres://nx@127.0.0.1:5432/nxstudio`. Pour une autre base, définir `DATABASE_URL`. Les migrations s'appliquent toutes seules au démarrage (`npm run migrate` pour les lancer à la main).

## Lancer en développement

```bash
npm run dev
```

- API et worker : http://localhost:8787 (rechargement automatique via `tsx watch`).
- Interface : http://localhost:5173 (Vite, qui redirige `/api` vers 8787).
- Première visite : écran de création du compte administrateur.
- Médias : dans `apps/server/data/media` (variable `NX_DATA_DIR`).

## Build de production

```bash
npm run build      # typecheck, puis bundle du serveur (apps/server/dist) et de l'interface (apps/web/dist)
npm start          # sert l'API et l'interface sur :8787
```

## Tests

```bash
# Unitaires et intégration : il faut une base de test vide (elle est réinitialisée à chaque lancement)
createdb nxstudio_test
npm test

# Serveur GPU
cd gpu-worker && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest

# Navigateur (Playwright + Chromium)
npm run build
npm run e2e:server &            # recrée la base nxe2e et démarre l'app sur :8787
npm run e2e
```

Les tests de la chaîne GPU distante (`apps/server/test/remote.test.ts`) lancent le serveur GPU Python. Ils sont ignorés si `gpu-worker/.venv` n'existe pas.

Le Chromium fourni par Playwright ne sait pas décoder le H.264. Les tests navigateur vérifient donc les vidéos en les téléchargeant puis en les analysant avec ffprobe. Chrome et Safari, eux, les lisent normalement.

## Organisation du code

```
packages/shared/     types et schémas (zod) communs : paramètres image/vidéo, API, instructions d'édition
apps/server/         API Fastify, worker de jobs, providers, stockage, base de données
  src/api/           routes HTTP, SSE
  src/worker/        exécution des jobs (claim, heartbeat, retry, encodage, stockage)
  src/providers/     interfaces, mocks, providers distants (protocole NX GPU), registre et routage
  src/storage/       stockage local et S3/R2
  src/db/            pool, migrations SQL
  test/              tests d'intégration
apps/web/            interface React (Vite)
gpu-worker/          serveur GPU Python (protocole NX GPU, moteurs)
e2e/                 tests navigateur Playwright
docs/                documentation
```
