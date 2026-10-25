# NX Studio : moteur OpenMontage

## Décision produit (25 octobre 2026)

NX Studio reste la marque, l'application et la bibliothèque média de NX Empire.
OpenMontage est désormais la base de référence pour la **production vidéo complète**, pas un produit à réécrire depuis zéro.
Les fonctionnalités existantes NX IMAGE et NX VIDEO restent isolées jusqu'à validation de la nouvelle chaîne.

**Ne pas prétendre que NX Studio est installé sur le téléphone ou accessible à distance.**
Le dépôt contient une application web en cours de validation, pas un APK livré au propriétaire.

## Source et licence

- Source originale : https://github.com/calesthio/OpenMontage
- Révision verrouillée : `e01dbf433f46eeb91d39bf905e194162921019a3`
- Licence du moteur : **GNU AGPL-3.0** (fichier `LICENSE` dans le checkout original).
- Conserver les mentions de copyright et les avis de licence d'OpenMontage.
- Si le logiciel AGPL est modifié et mis à disposition via réseau, respecter l'obligation correspondante de fourniture du code source modifié. Ne jamais prétendre que le moteur original est une création NX.
- Ne pas réutiliser les logos ou marques d'OpenMontage comme marque NX.

Ce projet référence le moteur externe sans dupliquer ni modifier ses sources. Le moteur est téléchargé dans `.nx/openmontage/`, dossier local ignoré par Git.

## Installation sur un hôte de développement autorisé

Prérequis : Node.js 22 pour NX Studio, Git, Python 3.10+, FFmpeg, `make`, accès GitHub pour la récupération. Sur Windows, utiliser WSL Linux pour la phase initiale.

Depuis la racine de NX-IMAGE-VIDEO :

```sh
node integrations/openmontage/engine.mjs --doctor
node integrations/openmontage/engine.mjs --fetch
node integrations/openmontage/engine.mjs --doctor
node integrations/openmontage/engine.mjs --setup
node integrations/openmontage/engine.mjs --backlot
```

- `--doctor` est sans accès réseau, sans écriture et sans inférence.
- `--fetch` récupère seulement le dépôt public à sa révision SHA vérifiée, dans un répertoire local vide.
- `--setup` exécute `make setup` **uniquement sur demande explicite**. Cette étape télécharge des paquets Python/npm et exécute leurs scripts d'installation. Revoir ces dépendances dans un environnement isolé avant exécution sur un serveur sensible.
- `--backlot` lance le tableau OpenMontage sur le **127.0.0.1:4750 de l'hôte**. Son interface n'est pas authentifiée pour une exposition publique.
- Ne pas ouvrir le port Backlot sur Internet. L'accès distant Samsung demandera une passerelle NX authentifiée, un tunnel privé approuvé ou un autre modèle d'accès sécurisé.

OpenMontage est piloté par un agent de programmation via ses fichiers `AGENT_GUIDE.md` et `pipeline_defs/`. **Un tableau Backlot ne suffit pas à créer une vidéo.** Le flux ne sera déclaré utilisable qu'après test complet d'une production et export MP4.

## Ce que nous reprenons du moteur

1. Brief, recherche, script et storyboard avec choix du pipeline.
2. Analyse de vidéos de référence et sélection des rushs.
3. Validation humaine des scènes, choix des fournisseurs et plafond de coût.
4. Montage, narration, musique, sous-titres et composition via les outils réels.
5. Contrôle qualité, journal des décisions, attribution des médias.
6. Exports MP4 en 9:16, 16:9 et 1:1 selon les productions.

Usages NX : teasers Australia Street, publicités DJ NASTX, vidéos NX Commerce. Garder les logos officiels et les créations validées sans les régénérer.

## Étapes de mise en service, ordre à respecter

1. Terminer la vérification d'origine et les tests hors réseau du bootstrap (dans cette branche).
2. Installer et tester le moteur sur un hôte isolé compatible, **pas** sur le Worker Cloudflare de Carlton. Ce Worker ne peut pas exécuter la pile native Python/FFmpeg/Remotion.
3. Exécuter la démonstration locale, puis une production réelle sans fournisseur payant. Mesurer durée, RAM, CPU, stockage, droits des médias et coût.
4. Ajouter un connecteur sécurisé au serveur NX Studio pour envoyer un brief, lire états/journaux et récupérer les fichiers de sortie. Respecter les gates et approbations OpenMontage, ne pas remplacer un agent par un appel arbitraire aux outils.
5. Exposer une interface web privée, authentifiée et utilisable depuis le Galaxy S25+ ; fabriquer une APK uniquement si un emballage mobile apporte une valeur démontrée.
6. Livrer l'URL ou l'APK réellement testé et ses preuves de fonctionnement, puis envisager le déploiement durable.

L'instance Oracle OmniRoute n'est pas un serveur de rendu vidéo garanti : il faut mesurer les ressources au lieu de supposer que l'Always Free sera suffisant.

## État vérifiable au 25 octobre 2026

- [x] Branche d'intégration isolée.
- [x] Préparation du téléchargement de source verrouillée et doctor sans réseau.
- [x] Tests hors réseau ajoutés (résultat CI à vérifier).
- [ ] Moteur récupéré sur l'hôte de production/recette.
- [ ] Dépendances installées et auditées sur cet hôte.
- [ ] Production réelle et export MP4 vérifiés.
- [ ] Authentification et accès mobile sécurisés.
- [ ] APK ou URL NX Studio remise au propriétaire.

Aucun appel de génération payant, aucune carte bancaire, aucun secret, aucune modification de la production Carlton.
