# Variables d'environnement

Toutes les variables se lisent au démarrage du serveur (`apps/server/src/config.ts`). Le modèle complet est dans [`.env.example`](../.env.example). Les réglages modifiables à chaud (file d'attente, uploads, moteurs par défaut) se changent dans **Settings → File & uploads** et sont stockés en base.

## Serveur

| Variable | Défaut | Rôle |
|---|---|---|
| `NODE_ENV` | `development` | `production` active les cookies `Secure`, `TRUST_PROXY` et désactive le CORS |
| `NX_ROLE` | `all` | `all`, `api` ou `worker`, voir [ARCHITECTURE](ARCHITECTURE.md) |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | Écoute HTTP |
| `DATABASE_URL` | `postgres://nx@127.0.0.1:5432/nxstudio` | PostgreSQL |
| `NX_DATA_DIR` | `./data` | Dossier de travail : médias locaux et fichiers temporaires des jobs |
| `NX_WEB_DIR` | `../web/dist` | Interface buildée, servie par le serveur |
| `TRUST_PROXY` | `true` en prod | À activer derrière un reverse proxy, pour avoir les vraies IP dans les logs et le rate limiting |

## Sessions et compte admin

| Variable | Défaut | Rôle |
|---|---|---|
| `SESSION_TTL_DAYS` | `30` | Durée de session ; elle est prolongée à chaque utilisation |
| `COOKIE_SECURE` | `true` en prod | Cookie envoyé seulement en HTTPS. Mettre `false` pour tester en HTTP local |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | Crée le premier admin au démarrage si la base n'a aucun utilisateur. Sinon, la première visite affiche l'écran de création |

## Stockage des médias

| Variable | Défaut | Rôle |
|---|---|---|
| `STORAGE_DRIVER` | `local` | `local` ou `s3` (AWS S3, Cloudflare R2, MinIO, Backblaze B2…) |
| `NX_MEDIA_DIR` | `$NX_DATA_DIR/media` | Dossier des médias en mode local |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` | — , `auto`, — | Bucket. Pour R2 : `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Clés d'accès (secrets) |
| `S3_FORCE_PATH_STYLE` | `true` | Nécessaire pour R2 et MinIO |
| `S3_PREFIX` | vide | Préfixe des clés, pour partager un bucket |

## Worker

| Variable | Défaut | Rôle |
|---|---|---|
| `NX_WORKER_ID` | `hostname-pid` | Identifiant, visible dans les logs et dans l'admin |
| `NX_WORKER_CONCURRENCY` | `2` | Valeur de secours seulement : c'est le réglage admin **Jobs en parallèle par worker** (2 par défaut) qui s'applique |
| `NX_LEASE_SECONDS` | `60` | Au-delà, un job sans heartbeat retourne dans la file |
| `NX_WORKER_POLL_MS` | `1000` | Fréquence de recherche de jobs (un nouveau job réveille aussi le worker local tout de suite) |

## Moteurs

| Variable | Défaut | Rôle |
|---|---|---|
| `NX_ENABLE_MOCK` | `true` | Moteurs de test, sans GPU |
| `NX_MOCK_MIN_SECONDS` | `4` | Durée minimale simulée d'une génération de test |
| `NX_GPU_ENDPOINTS` | vide | Tableau JSON des serveurs GPU : `[{"id":"runpod-1","url":"https://…","tokenEnv":"NX_GPU_TOKEN_RUNPOD1","engines":["ltx","wan"]}]`. `engines` est optionnel : s'il manque, les moteurs sont découverts via `/v1/health` |
| `NX_GPU_TOKEN_…` | — | Le jeton de chaque serveur GPU, dans la variable nommée par `tokenEnv` |

## Sécurité

| Variable | Défaut | Rôle |
|---|---|---|
| `RATE_LIMIT_MAX` | `600` | Requêtes API par minute et par IP (hors fichiers médias et SSE) |
| `RATE_LIMIT_LOGIN_MAX` | `10` | Tentatives de connexion par minute et par IP |

## Serveur GPU (`gpu-worker/`)

| Variable | Défaut | Rôle |
|---|---|---|
| `NX_ENGINES` | — | Moteurs servis, par ex. `ltx,wan`. Pour des moteurs de test : `fake:ltx,fake:flux` |
| `NX_GPU_TOKEN` | vide | Jeton Bearer exigé par le serveur. **À toujours définir** si la machine est joignable depuis Internet |
| `PORT` | `8188` | Port HTTP |
| `NX_GPU_DATA_DIR` | `/tmp/nx-gpu` | Fichiers des jobs |
| `NX_GPU_CONCURRENCY` | `1` | Jobs simultanés (1 par GPU) |
| `NX_GPU_JOB_TTL` | `3600` | Secondes avant suppression des fichiers d'un job terminé |
| `NX_GPU_MAX_UPLOAD_MB` | `500` | Taille maximale d'une requête |
| `NX_GPU_PRELOAD` | `1` | Charger les modèles au démarrage (`0` : au premier job) |
| `NX_FAKE_SECONDS` | `2` | Durée des moteurs de test |
| `NX_GPU_OFFLOAD`, `NX_LTX_*`, `NX_WAN_*`, `NX_QWEN_*`, `NX_FLUX_*`, `NX_ESRGAN_*` | — | Réglages des moteurs réels, voir [GPU_WORKERS](GPU_WORKERS.md#réglages) |
