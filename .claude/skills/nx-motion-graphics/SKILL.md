---
name: nx-motion-graphics
description: Prépare des animations et habillages vidéo 9:16 ou 16:9 pour NX Studio, Australia Street et NASTX avec HyperFrames si le plugin est réellement installé, sans modifier les moteurs IA existants.
---

# NX Studio | Habillage vidéo isolé

Ce skill prépare des montages typographiques, titres animés, transitions et compositions HTML, pas une génération photoréaliste équivalente à Kling AI. Préserver NX IMAGE, NX VIDEO, le protocole NX GPU, la file de jobs et les modèles existants.

1. Choisir un preset exact dans `presets/nx_motion_formats.json` : 1080x1920 pour story 9:16, ou 1920x1080 pour TV 16:9.
2. Utiliser les médias sources validés, ne pas recréer ni modifier le logo officiel Australia Street ou le koala. Ne jamais substituer un visuel inventé à un fichier manquant.
3. Préparer un brief de scène avec durée, placement du texte, fond réel, timing et mouvements. Le montage reste local et séparé de la génération par GPU.
4. Si le plugin HyperFrames officiel est installé, vérifier l'interface CLI correspondant à sa version, puis suivre le workflow `/hyperframes:hyperframes` pour lint, prévisualisation et rendu. Ne jamais inventer de commande de rendu.
5. Vérifier un fichier MP4 réel, sa taille, durée, résolution et son cadrage avant d'annoncer qu'il est livré. Sans HyperFrames installé, livrer le brief uniquement et signaler que le rendu n'est pas exécuté.
6. Aucune publication automatique ni dépense de crédit ou appel à un service tiers sans autorisation explicite.

Référence : https://github.com/heygen-com/hyperframes , Apache-2.0. Installation facultative sur le poste Claude Code après revue des permissions. Le moteur ne remplace pas Wan, LTX, FLUX, Qwen ni aucun provider NX Studio.
