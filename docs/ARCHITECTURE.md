# Architecture

```
 Navigateur (Mac, téléphone)
   │  HTTPS : API JSON, uploads, SSE (temps réel), médias via URL authentifiées
   ▼
 ┌──────────────────────────────┐        ┌─────────────────────────────┐
 │ NX STUDIO server (Node/TS)   │        │ PostgreSQL                  │
 │  role api : Fastify, web app ├───────►│  données + file des jobs    │
 │  role worker : JobRunner     │◄───────┤  LISTEN/NOTIFY (temps réel) │
 └──────┬───────────────┬───────┘        └─────────────────────────────┘
        │               │
        │ StorageProvider (local ou S3/R2)
        │               │
        │ Providers : mocks (CPU)   |   distants (protocole NX GPU, HTTP)
        ▼                               ▼
   ffmpeg local                  ┌───────────────────────────┐
                                 │ Serveur GPU (gpu-worker/)  │  PC local, RunPod, Vast.ai,
                                 │ FastAPI + moteurs IA       │  serveur dédié…
                                 └───────────────────────────┘
```

## Les morceaux

| Partie | Rôle | Code |
|---|---|---|
| Types partagés | Schémas zod des paramètres image et vidéo, DTO de l'API, parseur d'instructions d'édition. Utilisés à la fois par l'interface et par le serveur | `packages/shared` |
| API | Auth, projets, médias, jobs, presets, providers, admin, SSE | `apps/server/src/api` |
| Worker | Prend les jobs dans la file, choisit le moteur, suit la progression, gère les retry, encode puis stocke | `apps/server/src/worker` |
| Providers | Interfaces `ImageProvider` et `VideoProvider`, mocks, providers distants, registre et routage | `apps/server/src/providers` |
| Stockage | `StorageProvider` : local en développement, S3/R2 en production | `apps/server/src/storage` |
| Interface | React + Vite, pilotée par les capacités des moteurs | `apps/web` |
| Serveur GPU | Expose les moteurs IA via le protocole NX GPU | `gpu-worker` |

Un seul binaire serveur couvre plusieurs rôles (`NX_ROLE`) :
- `all` : un seul processus, le plus simple.
- `api` : l'API et l'interface, sans worker.
- `worker` : le worker seul. On peut en lancer plusieurs ; ils se partagent PostgreSQL et le stockage.

## Deux écarts au stack proposé, et pourquoi

1. **Fastify + React/Vite au lieu de Next.js.** NX STUDIO est une application privée derrière un login : le rendu serveur et le SEO n'apportent rien. En revanche, il lui faut une API séparée et durable (le serveur GPU et d'éventuels clients mobiles la consomment), des connexions SSE longues, et des uploads de vidéos en streaming. Fastify fait tout ça simplement. L'interface est une SPA servie par le même serveur, donc un seul conteneur et aucun problème de CORS.
2. **File d'attente dans PostgreSQL au lieu de Redis/BullMQ.** Les jobs vivent déjà dans la base (historique, paramètres, sorties). Le worker les réserve avec `SELECT … FOR UPDATE SKIP LOCKED`, ce qui marche avec plusieurs workers. Le temps réel passe par `LISTEN/NOTIFY`. On obtient une seule source de vérité transactionnelle et un service de moins à opérer. Pour les volumes de NX STUDIO (des générations de plusieurs secondes à plusieurs minutes), c'est largement suffisant. Redis pourra s'ajouter plus tard pour un rate limiting réparti sur plusieurs serveurs API.

## Cycle de vie d'un job

```
queued ──claim──► starting ──► processing ──► encoding ──► completed
   ▲                 │              │             │
   │  retry auto     └──────────────┴─────────────┴──► failed (erreur gardée)
   └── (erreur « retryable », attempts < max, délai croissant)
 cancel possible à tout moment ──► cancelled ; retry manuel ──► queued
```

- **Réservation.** Le worker prend le job de plus haute priorité, puis le plus ancien. Il pose un bail (`lease`) qu'il renouvelle toutes les 5 s par un heartbeat. Si un worker meurt, le job revient dans la file une fois le bail expiré.
- **Progression.** `starting` couvre 0–5 %, `processing` 5–90 % (rapporté par le moteur), `encoding` 90–100 %.
- **Annulation.** Le worker vérifie toutes les 500 ms si le job a été annulé. Il interrompt alors le moteur, y compris sur la machine GPU distante (`POST /v1/jobs/:id/cancel`).
- **Retry automatique.** Il s'applique seulement aux erreurs marquées *retryable* : GPU injoignable, manque de mémoire, timeout. Une erreur de paramètres échoue tout de suite.
- **Arrêt propre.** Les jobs en cours sont rendus à la file, pas perdus.
- **Logs.** Chaque étape est écrite dans `job_logs` (visible dans l'onglet Logs) et dans les logs JSON du serveur (pino). Chaque ligne indique le provider, le modèle, le job, l'étape, la durée, l'erreur, le worker et l'utilisateur.

## Temps réel

Un trigger PostgreSQL émet `pg_notify('nx_job_events', '<job>:<owner>')` à chaque changement de job. Chaque processus API écoute ce canal et pousse le job mis à jour aux navigateurs de son propriétaire via SSE (`/api/events`), regroupé toutes les 250 ms. Le worker et l'API peuvent donc tourner sur des machines différentes.

## Sécurité

- **Mots de passe.** Hachés en scrypt, 10 caractères minimum. Un changement de mot de passe déconnecte les autres sessions.
- **Sessions.** Jeton aléatoire dans un cookie `httpOnly`, `SameSite=Lax`, `Secure` en production. Seul le hash SHA-256 du jeton est stocké en base.
- **Rôles.** `admin` et `user`. Les routes `/api/admin/*` sont réservées aux admins. Chaque média, job, projet et preset appartient à son utilisateur ; un autre utilisateur reçoit 404.
- **Médias privés par défaut.** Pas d'URL publique : les fichiers passent par `/api/media/:id/file` après contrôle de la session. En S3/R2, le serveur redirige vers une URL signée de courte durée.
- **Uploads.** Quatre contrôles :
  - liste blanche de types MIME ;
  - extension cohérente avec le type ;
  - vérification des octets réels du fichier (signature PNG, JPEG, MP4…) ;
  - taille maximale réglable, analyse ffprobe, plafond de pixels.

  Les noms de fichiers sont nettoyés, et les clés de stockage sont générées par le serveur.
- **Rate limiting.** Global, plus une limite stricte sur la connexion.
- **Secrets.** Ils restent dans les variables d'environnement du serveur. L'admin n'affiche que leur nom (`env:NX_GPU_TOKEN_…`), et le mot de passe de la base est masqué. Les jetons des serveurs GPU ne transitent jamais par l'interface.
- **Audit.** Connexions, changements de réglages, gestion des utilisateurs et des moteurs sont enregistrés dans `audit_logs`.
