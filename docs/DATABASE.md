# Base de données

PostgreSQL contient toutes les données de NX STUDIO **et** la file des jobs. Le schéma est dans `apps/server/src/db/migrations/001_init.sql`. Les fichiers (images, vidéos, miniatures) ne sont pas en base : ils sont dans le stockage (dossier local ou bucket S3/R2), et la base ne garde que leur clé.

## Tables

| Table | Contenu |
|---|---|
| `users` | Comptes : email (unique sans tenir compte de la casse), nom, hash scrypt du mot de passe, rôle `admin` ou `user`, `disabled` |
| `sessions` | Une ligne par connexion. L'id est le **hash SHA-256** du jeton du cookie, jamais le jeton lui-même. Expiration, IP, navigateur |
| `projects` | Projets de l'utilisateur : nom, description, couleur, `archived` |
| `generation_jobs` | Une génération : module, opération, `kind` (generate, regenerate, variation, duplicate, animate, extend), paramètres complets (`params` en JSON), moteur utilisé, statut, étape, progression, tentatives, erreur, worker, heartbeat, durées. `parent_job_id` relie une variation ou un extend à son origine |
| `media` | Chaque fichier : image, vidéo ou masque ; `upload` ou `generated` ; clé de stockage, miniature, type MIME, dimensions, durée, taille, favori. Suppression logique (`deleted_at`) |
| `generation_outputs` | Lien entre un job et ses médias produits (index, seed) |
| `job_logs` | Journal détaillé de chaque job, affiché dans l'onglet Logs |
| `presets` | Presets intégrés (`owner_id` vide, `builtin`) et presets des utilisateurs |
| `providers` | Réglages admin des moteurs : activé, moteur par défaut. Aucun secret |
| `user_settings` | Préférences de chaque utilisateur |
| `system_settings` | Réglages globaux modifiables à chaud (clé `system` : file, uploads, moteurs par défaut) |
| `audit_logs` | Actions sensibles : connexions, réglages, utilisateurs, moteurs |
| `schema_migrations` | Migrations déjà appliquées |

Toutes les tables d'un utilisateur dépendent de `users` avec `ON DELETE CASCADE`. Les liens vers un projet utilisent `ON DELETE SET NULL` : supprimer un projet ne supprime pas ses médias.

## La file des jobs

- **Réservation.** Un worker prend un job avec :

  ```sql
  SELECT id FROM generation_jobs
  WHERE status = 'queued' AND deleted_at IS NULL AND run_after <= now()
  ORDER BY priority DESC, created_at, id
  LIMIT 1 FOR UPDATE SKIP LOCKED
  ```

  `SKIP LOCKED` permet à plusieurs workers de travailler en parallèle sans jamais prendre le même job. L'index partiel `jobs_queue_idx` rend cette requête instantanée.
- **Heartbeat.** Chaque mise à jour de progression rafraîchit `heartbeat_at`. Un job dont le heartbeat est trop ancien (`NX_LEASE_SECONDS`) est remis dans la file.
- **Retry.** Une erreur *retryable* repousse `run_after` de `délai × tentatives` tant que `attempts < max_attempts`.
- **Temps réel.** Un trigger sur `generation_jobs` appelle `pg_notify('nx_job_events', '<job>:<propriétaire>')` à chaque insertion ou modification. L'API écoute ce canal pour pousser les mises à jour aux navigateurs.

## Migrations

- Elles s'appliquent automatiquement au démarrage du serveur. À la main : `npm run migrate`, ou `npm run migrate:prod` dans un build.
- Ce sont des fichiers `NNN_nom.sql` appliqués dans l'ordre, chacun dans sa propre transaction.
- Un verrou consultatif PostgreSQL empêche deux processus (l'API et le worker qui démarrent ensemble) de les appliquer en même temps.
- **Pour changer le schéma :** ajouter un nouveau fichier (`002_…sql`) ; ne jamais modifier une migration déjà appliquée.

## Sauvegarde et restauration

```bash
pg_dump -Fc nxstudio > nx.dump                 # sauvegarde
pg_restore --clean --if-exists -d nxstudio nx.dump
```

La base ne contient pas les fichiers : il faut aussi sauvegarder le stockage des médias (voir [DEPLOYMENT](DEPLOYMENT.md)).
