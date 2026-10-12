# NX Studio | Essai HyperFrames sans modifier les générations

Statut : **workflow de préparation disponible sur cette branche**. La bibliothèque HyperFrames n'est pas installée, aucun MP4 n'a été rendu et aucun moteur GPU ou provider n'a été modifié.

Le skill `.claude/skills/nx-motion-graphics/SKILL.md` décrit le flux pour Claude Code et le manifest `presets/nx_motion_formats.json` verrouille deux formats vidéo. Il peut produire des briefs et, après installation explicite du plugin officiel, guider des rendus typographiques HTML vers MP4.

Le logiciel amont https://github.com/heygen-com/hyperframes (Apache-2.0) documente l'installation Claude Code :

```text
claude plugin marketplace add heygen-com/hyperframes
claude plugin install hyperframes@hyperframes
```

Ces commandes doivent être exécutées sur le poste Claude Code après contrôle des permissions et de la version, pas par le worker Cloudflare. Il ne faut ni confondre le rendu d'habillage HTML avec la génération IA d'une scène, ni installer HyperFrames comme remplacement de NX VIDEO.

Commande de test local du manifest : `node tests/nx_motion_formats.mjs`. Une revue de rendu réel devra vérifier les exports 9:16, 16:9, qualité des textes, dimensions du fichier et conservation des vrais assets Australia Street avant d'envisager un branchement dans l'interface.
