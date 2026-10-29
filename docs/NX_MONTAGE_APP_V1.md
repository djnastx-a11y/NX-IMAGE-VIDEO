# NX Montage — premier parcours intégré à NX Studio

Statut: **branche de développement / PR #3, non fusionnée et non déployée**.
Le rendu CLI OpenMontage et un test d'intégration authentifié avec PostgreSQL ont été démontrés dans GitHub Actions. Ne pas confondre cela avec une application installée sur Galaxy S25+.

## Ce qui marche dans le code
- Écran React `/montage`, accessible sur mobile, création de 1 à 6 scènes de titres, 2–6 s chacune.
- GET `/api/openmontage/status`, GET `/api/openmontage/jobs`, POST `/api/openmontage/jobs`, GET `/api/openmontage/jobs/:id`, toutes sous authentification NX.
- Version source originale OpenMontage fixée à `e01dbf433f46eeb91d39bf905e194162921019a3`.
- Composition `Explainer` de Remotion **réellement exécutée**, MP4 16:9 à 480×270 (aperçu), pas de requête IA payante.
- Résultat enregistré dans la médiathèque privée existante (propriétaire et projet), miniature JPEG, lien de téléchargement.
- Historique dans PostgreSQL et messages d'erreur affichés dans l'application.
- Limites sur la taille des champs, nombre de scènes, durée, ressources et concurrence.

**Limites explicites** : Cette version pilote produit des scènes de texte/graphisme ; elle ne transcrit pas encore des médias utilisateur, ne monte pas des rushs, ne suit pas toute la chaîne d'agents/pipelines OpenMontage, n'exporte pas encore en 9:16 et n'est pas une APK native. Un appel HTTP crée un rendu dans le processus Node local, sans worker distribué durable. Une interruption de processus peut laisser un job inachevé ; réserver à une recette mono-instance.

## Développement contrôlé sur un hôte dédié
Pré-requis : Git, Node.js >=22, PostgreSQL 16, ffmpeg/ffprobe, assez d'espace disque et mémoire pour Chromium. Les dépendances ne sont pas garanties sur Oracle Always Free ; mesurer les ressources avant de déployer.

```bash
git checkout feat/nx-studio-openmontage-engine-20261025
npm ci
node integrations/openmontage/engine.mjs --fetch
# Contrôler la provenance du SHA et la licence avant d'exécuter les dépendances.
cd .nx/openmontage/remotion-composer
npm install --ignore-scripts --no-audit --no-fund
cd ../../..
node integrations/openmontage/engine.mjs --doctor
# Dans ton .env NON VERSIONNÉ pour ton unique serveur de test :
# NX_OPENMONTAGE_ENABLED=true
# NX_OPENMONTAGE_HOME=/chemin/absolu/NX-IMAGE-VIDEO/.nx/openmontage
npm run build
npm start
```

Le `--doctor` natif vérifie les sources et prérequis OpenMontage sans prétendre tester le rendu. L'endpoint NX `/api/openmontage/status` exige une session NX.

### Test E2E automatisé
- Workflow GitHub `.github/workflows/openmontage-e2e.yml` : PostgreSQL temporaire, vraies dépendances Remotion, deux utilisateurs et rendu à partir d'un storyboard personnalisé.
- Contrôles : login obligatoire, propriété du job et des médias, lecture du MP4 H.264.
- `.github/workflows/nx-montage-build.yml` compile serveur, web et teste les contrats sans base ni compte IA.
- Aucune clé facturable autorisée dans ces workflows.

## Mise en service mobile
1. Valider l'AGPL-3.0 d'OpenMontage, y compris l'accès au code des modifications si servi en réseau, et les licences des médias.
2. Déployer sur un serveur Node avec TLS HTTPS, PostgreSQL et volume persistant, distinct de Carlton.
3. Vérifier `/api/health` et la vraie page `/montage`, puis connexion administrateur.
4. Confirmer le statut « Moteur local connecté » et réussir un rendu custom sur la machine de destination.
5. Essayer en Chrome sur Samsung S25+ puis installer le raccourci web app via « Ajouter à l'écran d'accueil ». Une APK native demande une étape de packaging Android séparée.
6. Ne pas publier ni activer de fournisseur vidéo IA payant sans autorisation précise.

Cette PR n'active aucun nouvel abonnement, aucune requête client externe et aucun déploiement de production.

## Image serveur autonome (recette uniquement)
Une variante isolée est préparée :
- `Dockerfile.openmontage` : assemble l'interface, l'API, PostgreSQL à part, les sources OpenMontage épinglées, FFmpeg et Chromium.
- `compose.openmontage.yml` : base PostgreSQL et volumes persistants; port HTTP lié **uniquement à 127.0.0.1**.

```bash
# Dans le dossier NX-IMAGE-VIDEO, avec .env local et POSTGRES_PASSWORD défini :
docker compose -f compose.openmontage.yml up -d --build
docker compose -f compose.openmontage.yml ps
# localhost seulement : pour le Samsung, mettre un reverse proxy HTTPS devant.
```

Le pilote n'active aucun service d'inférence payant. Vérifier l'usage mémoire/disque et l'accès HTTPS avant de créer une VM. L'image Docker doit être passée par la CI et un test réel sur le serveur de destination avant toute annonce de disponibilité mobile.
