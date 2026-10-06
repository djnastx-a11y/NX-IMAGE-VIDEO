# Mise en production

## Option recommandée : un petit serveur + Docker Compose

NX STUDIO lui-même n'a pas besoin de GPU. Un VPS de 2 vCPU et 4 Go de RAM suffit (Hetzner, OVH, Scaleway…), ou un Mac/PC qui reste allumé. Le GPU est une machine à part, voir [GPU_WORKERS.md](GPU_WORKERS.md).

```bash
git clone <dépôt> nx-studio && cd nx-studio
cp .env.example .env
#   POSTGRES_PASSWORD=<long et aléatoire>
#   ADMIN_EMAIL / ADMIN_PASSWORD  (ou création au premier accès)
#   STORAGE_DRIVER=s3 + S3_* si les médias vont sur R2/S3
docker compose up -d --build
docker compose logs -f app
```

`docker-compose.yml` démarre trois services :
- `db` : PostgreSQL 16, données dans le volume `pgdata`.
- `app` : `NX_ROLE=api`, l'API et l'interface sur le port `NX_PORT` (8787 par défaut).
- `worker` : `NX_ROLE=worker`, qui exécute les générations. Pour plus de débit : `docker compose up -d --scale worker=2`.

`app` et `worker` partagent le volume `media` pour le stockage local. Avec S3/R2, ce volume ne sert plus qu'aux fichiers temporaires.

Ce déploiement a été vérifié : image construite, puis les 7 parcours navigateur passés contre `docker compose` avec l'API et le worker dans des conteneurs séparés.

## HTTPS (obligatoire hors de chez soi)

Mettre un reverse proxy devant le port 8787. Exemple avec Caddy, qui obtient le certificat tout seul :

```
studio.mondomaine.fr {
    reverse_proxy 127.0.0.1:8787
}
```

Garder `COOKIE_SECURE=true` et `TRUST_PROXY=true`. Le flux temps réel (SSE, `/api/events`) passe sans réglage particulier dans Caddy. Avec Nginx, ajouter `proxy_buffering off;` sur `/api/events`, et mettre `client_max_body_size` au-dessus de la taille d'upload vidéo maximale.

Pour accéder au studio depuis son téléphone sans l'exposer à Internet, il existe une alternative : **Tailscale** sur le serveur et sur le téléphone, l'app restant sur l'adresse privée.

## Stockage S3 / Cloudflare R2

```
STORAGE_DRIVER=s3
S3_BUCKET=nx-studio
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

Le bucket reste **privé**. NX STUDIO vérifie la session, puis redirige vers une URL signée valable quelques minutes. R2 ne facture pas la bande passante sortante, ce qui est intéressant pour la vidéo.

Le pilote S3 est écrit avec le SDK AWS officiel, mais il n'a pas encore été testé contre un vrai bucket. Il faut le valider au moment de brancher R2.

## Sauvegardes

- **Base :** `docker compose exec db pg_dump -U nx nxstudio | gzip > nx-$(date +%F).sql.gz`, chaque nuit via cron.
- **Médias en local :** sauvegarder le volume `media`. Sur R2/S3 : activer le versioning du bucket ou une réplication.

## Mise à jour

```bash
git pull
docker compose up -d --build     # les migrations de base s'appliquent toutes seules au démarrage
```

## Surveillance

- `GET /api/health` renvoie `{ ok, db }` ; c'est aussi le healthcheck Docker.
- **Settings → Système** (admin) : compteurs de la file, workers actifs, santé de la base et du stockage, configuration (sans secrets).
- **Settings → Échecs** : les dernières générations en échec, avec leur erreur, leur moteur et leur worker.
- Logs JSON (pino) sur la sortie standard : `docker compose logs -f worker | grep '"job"'`. Ils peuvent être envoyés tels quels vers Loki, Datadog, Better Stack…
