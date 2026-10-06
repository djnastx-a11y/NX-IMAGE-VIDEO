# Dépannage

## Connexion et sessions

| Symptôme | Cause et solution |
|---|---|
| Je me connecte mais je reste sur l'écran de connexion | Le cookie est `Secure` et le site est en HTTP. En local, mettre `COOKIE_SECURE=false` ; en ligne, passer en HTTPS |
| « Too many requests » à la connexion | Plus de `RATE_LIMIT_LOGIN_MAX` tentatives par minute depuis la même IP. Attendre une minute. Derrière un proxy, vérifier `TRUST_PROXY=true`, sinon tout le monde partage l'IP du proxy |
| Mot de passe admin perdu | Utiliser la commande ci-dessous, depuis la machine du serveur |

Remettre un mot de passe depuis la machine du serveur (le compte est aussi réactivé, ses sessions fermées et l'action enregistrée dans l'audit) :

```bash
npm run reset-password -- jb@exemple.fr --admin             # en développement
docker compose exec app node apps/server/dist/reset-password-cli.js jb@exemple.fr --admin   # avec Docker
```

Le nouveau mot de passe est affiché une seule fois. Pour le choisir, le passer dans `NX_NEW_PASSWORD`. `--admin` redonne le rôle administrateur.

## Générations

| Symptôme | Cause et solution |
|---|---|
| « Aucun moteur disponible pour cette génération » | Le message dit pourquoi chaque moteur est écarté : désactivé, opération non gérée, durée ou résolution hors limites, serveur GPU injoignable. Voir **Settings → Moteurs**, bouton **Tester** |
| Le job reste en *Queued* | Aucun worker ne tourne. Avec Docker : `docker compose ps worker`. **Settings → Système** affiche les workers actifs. Un job retenté attend aussi son délai (`run_after`) |
| Le job échoue avec « Simulated… » | Le prompt contient un mot-clé de test (`#fail`, `#fail-once`, `#slow`, `#oom`) |
| Le job repart tout seul après un redémarrage | Normal : un job interrompu revient dans la file une fois son bail expiré (`NX_LEASE_SECONDS`), au lieu d'être perdu |
| La vidéo ne se lit pas dans le navigateur | Les sorties sont en H.264 `faststart`, lisibles par Chrome, Safari et Firefox. Seul le Chromium « open source » de Playwright ne lit pas le H.264 |
| Le détail d'un échec | **Settings → Échecs** (admin), ou l'onglet **Logs** du job |

## Serveur GPU

| Symptôme | Cause et solution |
|---|---|
| Les moteurs distants n'apparaissent pas | Si `engines` n'est pas indiqué dans `NX_GPU_ENDPOINTS`, la liste est lue sur `/v1/health` **au démarrage**. Si le serveur GPU était éteint à ce moment-là, indiquer `engines` explicitement ou redémarrer NX STUDIO |
| « Engine "ltx" not loaded on … » | Le moteur n'est pas dans `NX_ENGINES` du serveur GPU, ou son chargement a échoué : voir `failed_engines` dans `/v1/health` et les logs du serveur GPU |
| HTTP 401 du serveur GPU | Le jeton de `NX_GPU_TOKEN` (côté GPU) et celui de la variable nommée par `tokenEnv` (côté NX STUDIO) diffèrent |
| « CUDA out of memory » | Le job est relancé automatiquement. Si l'erreur revient : baisser la résolution ou la durée, ou prendre un GPU avec plus de mémoire |
| « Lost contact with GPU endpoint » | 15 échecs réseau d'affilée pendant le suivi du job. Le pod a peut-être été arrêté (Vast.ai, RunPod spot). Le job est relancé automatiquement |

Tester un serveur GPU à la main :

```bash
curl -H "Authorization: Bearer $NX_GPU_TOKEN" https://<serveur-gpu>/v1/health
```

## Uploads

| Symptôme | Cause et solution |
|---|---|
| « Type de fichier non autorisé » | Seuls PNG, JPEG, WebP, MP4, MOV et WebM sont acceptés, et le contenu réel du fichier doit correspondre à son extension |
| Fichier trop gros | La limite se règle dans **Settings → File & uploads**. Derrière Nginx, augmenter aussi `client_max_body_size` |

## Docker

| Symptôme | Cause et solution |
|---|---|
| `app` redémarre en boucle | `docker compose logs app`. Le plus souvent : `POSTGRES_PASSWORD` absent de `.env`, ou une base créée avec un autre mot de passe (supprimer le volume `pgdata` s'il ne contient rien d'important) |
| Les médias disparaissent après une mise à jour | Le volume `media` a été supprimé (`docker compose down -v`). Ne pas utiliser `-v` en production |

## Logs utiles

```bash
docker compose logs -f app worker          # NX STUDIO (JSON)
docker compose logs worker | grep '"err"'  # erreurs du worker
```

Chaque ligne d'un job contient son id, son moteur, son worker et son utilisateur : chercher l'id du job (visible dans l'onglet **Logs**) suffit à retrouver toute son histoire.
