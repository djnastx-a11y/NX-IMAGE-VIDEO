# Étude des moteurs réels : quels modèles brancher en premier

Étude faite le 6 octobre 2026, à partir des fiches officielles (Hugging Face, GitHub, licences), du classement Artificial Analysis (votes humains en aveugle) et des tarifs publics RunPod. Les sources sont listées en bas de page.

**À lire avant tout :** les vitesses de génération ci-dessous ne viennent pas de nous. Elles sont reprises des éditeurs, ou laissées vides quand personne ne publie de chiffre fiable. Elles seront mesurées pendant la première session GPU (voir « Ce qu'il faut mesurer »). Seule cette mesure fixera le coût réel par vidéo.

## Critères

| Critère | Pourquoi |
|---|---|
| Qualité perçue | Classement Artificial Analysis, Elo issu de votes humains en aveugle |
| Fidélité à l'image source | C'est le cœur du flux « Animate in NX VIDEO » |
| Licence | Usage commercial (DJ, pubs), restrictions géographiques, plafond de chiffre d'affaires |
| VRAM | Détermine le GPU à louer, donc le prix |
| Durées et modes | 5/10/15 s, image → vidéo, first/last frame, video → video, extend |
| Intégration | Pipeline Diffusers officiel, donc branchement propre dans `gpu-worker/` |

## Vidéo

| Modèle | Taille | Licence | VRAM | Ce qu'il fait | Classement open-weights |
|---|---|---|---|---|---|
| **LTX-2.5** (Lightricks, août 2026) | 22B, version distillée en 8 étapes | Communautaire LTX : **gratuit, usage commercial compris, sous 10 M$ de CA annuel** | FP8 : 24–32 Go (4090/5090) ; confortable : 48 Go et plus | T2V, I2V, V2V, audio natif, multi-plans, jusqu'à 20 s, jusqu'à la 4K, conditionnement d'image à un index de frame (base du first/last frame) | I2V : **3e (Elo 1038)**, 1er parmi les modèles utilisables en Europe |
| **Wan 2.2 I2V/T2V A14B** (Alibaba, juil. 2025) | 27B MoE, 14B actifs | **Apache-2.0** (le plus libre) | Officiel : 80 Go ; avec FP8 et distillation communautaire en 4 étapes : bien moins | T2V, I2V 480p/720p, clips d'environ 5 s ; first/last frame via la variante FLF ; pas d'audio | Absent du classement avec audio |
| Wan 2.2 TI2V-5B | 5B | Apache-2.0 | 24 Go | T2V et I2V 720p 24 fps ; environ 9 min pour 5 s sur une 4090 (éditeur) | — |
| HunyuanVideo 1.5 (Tencent, nov. 2025) | 8,3B | Licence Tencent **qui exclut l'UE, le Royaume-Uni et la Corée du Sud** | 14 Go avec offload | T2V et I2V 480p/720p, 121 frames (environ 5 s) | — |
| MiniMax H3 (juil. 2026) | 33B | Licence communautaire **qui exclut l'UE, le Royaume-Uni, les États-Unis et la Corée du Sud** | 42,5 Go minimum en quantifié, plusieurs GPU recommandés | T2V, I2V, audio, jusqu'à 15 s | I2V : 1er (Elo 1181) |
| Wan 2.5 / 2.6 | — | **API uniquement, pas de poids publiés** | — | — | — |

Ce qu'on en retient :

- **MiniMax H3** est le meilleur sur le papier. Mais sa licence exclut l'UE, et il faut plusieurs GPU. Il est écarté tant qu'on ne sait pas depuis quel pays NX STUDIO est utilisé.
- **HunyuanVideo 1.5** a la même exclusion UE/Royaume-Uni. Il est écarté pour la même raison.
- **LTX-2.5** est le modèle open-weights le mieux classé dont la licence nous convient. Il couvre aussi nos durées de 5, 10 et 15 s sans « extend », le video → video et l'audio. Il est rapide grâce à sa version distillée : l'éditeur annonce 6 à 8 s pour un clip de 10 s sur un GPU de datacenter, chiffre à vérifier.
- **Wan 2.2** reste la référence pour la fidélité à l'image source, avec la licence la plus libre (Apache-2.0). Il génère des clips d'environ 5 s ; une vidéo de 10 s passe donc par l'Extend de NX STUDIO, qui fonctionne déjà.

## Image

| Modèle | Taille | Licence | VRAM | Ce qu'il fait |
|---|---|---|---|---|
| **Qwen-Image-Edit-2511** (Alibaba) | 20B | **Apache-2.0** | BF16 : environ 40 Go ; FP8 : environ 20 Go (estimation à mesurer) | Édition en langage naturel (retirer du texte, changer un décor, une tenue, un objet), cohérence du personnage, plusieurs images en entrée. Pipeline Diffusers `QwenImageEditPlusPipeline` |
| **FLUX.2 [klein] 4B** (Black Forest Labs) | 4B | **Apache-2.0** | environ 13 Go | T2I, édition et multi-références dans un seul modèle, moins d'une seconde par image (éditeur) |
| Z-Image-Turbo (Alibaba Tongyi, nov. 2025) | 6B | Apache-2.0 | 16 Go | T2I très rapide (8 étapes) ; version Edit annoncée mais pas encore publiée |
| Qwen-Image (2512) | 20B | Apache-2.0 | environ 40 Go en BF16 | T2I, excellent rendu du texte dans l'image (affiches) |
| FLUX.2 [dev] | 32B | **Non commerciale** pour le modèle | 24 Go et plus en 4 bits | Meilleure qualité FLUX ; licence à éviter pour un usage pro |
| Real-ESRGAN | petit | BSD-3 | moins de 4 Go | Upscale ×2/×4 |

## Recommandation

**Premier moteur vidéo : LTX-2.5 (version distillée).**
- C'est le meilleur classement open-weights en image → vidéo parmi les modèles utilisables en Europe.
- Sa licence est gratuite sous 10 M$ de CA.
- Il gère nativement les 10–15 s, le video → video et l'audio.
- Il tient sur un seul GPU loué.

**Deuxième moteur vidéo : Wan 2.2 I2V A14B.** On le branche pour comparer la fidélité à l'image source, avec une licence Apache-2.0. NX STUDIO choisit déjà le moteur selon l'opération ; on pourra fixer « Auto » sur le meilleur des deux après mesure.

**Premiers moteurs image, tous deux en Apache-2.0 :**
- **Qwen-Image-Edit-2511** pour l'édition en langage naturel, l'inpainting et l'outpainting.
- **FLUX.2 [klein] 4B** pour le text → image, les variations et l'image → image.
- **Real-ESRGAN** pour l'upscale.

**GPU :** une seule machine de **48 Go (L40S, environ 1,09 $/h chez RunPod)** devrait suffire à tester tout ça en FP8. Une **H100 80 Go (2,89 $/h)** donne de la marge, sans offload. En usage perso intermittent, la formule « serverless » de RunPod (facturée à la seconde, 1,75 $/h en 48 Go, 4,79 $/h en H100) évite de payer un GPU qui attend. Elle a en revanche un démarrage à froid de plusieurs dizaines de secondes, le temps de charger le modèle.

**Ordre de grandeur du coût, à confirmer par la mesure :** si un clip de 10 s en 720p prend 1 à 2 minutes de GPU sur H100 serverless, il coûte environ 0,08 à 0,16 $. Une image prend quelques secondes, donc moins d'un centime.

## Ce qu'il faut mesurer pendant la première session GPU

Le script de mesure sera `gpu-worker/bench.py`, à écrire avec l'intégration réelle.
- Temps et pic de VRAM par moteur : 5 s et 10 s, en 480p, 720p et 1080p, en 9:16 et 16:9.
- Fidélité à l'image source en I2V : même image, mêmes prompts, LTX-2.5 contre Wan 2.2, comparaison à l'œil sur 10 cas types (portrait, rue, club, produit).
- Le first/last frame avec chaque moteur.
- Le temps de démarrage à froid en serverless.

## Sources

- Classement I2V open-weights : https://artificialanalysis.ai/video/leaderboard/image-to-video/open-weights
- Classement T2V open-weights : https://artificialanalysis.ai/video/leaderboard/text-to-video/open-weights
- LTX-2.5 : https://huggingface.co/Lightricks/LTX-2.5 et https://comfyui-wiki.com/en/news/2026-08-11-ltx-2-5-open-weights-release
- Licence LTX (seuil de 10 M$) : https://ltx.io/model/license
- Matériel LTX : https://ltx.io/blog/hardware-for-ai-video-models
- Wan 2.2 : https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B et https://github.com/Wan-Video/Wan2.2
- Wan 2.5/2.6 sans poids publiés : https://localaimaster.com/blog/wan-2-7-open-source
- Distillation Wan 2.2 en 4 étapes : https://cnb.cool/ai-models/lightx2v/Wan2.2-I2V-A14B-Moe-Distill-Lightx2v
- HunyuanVideo 1.5 et sa licence : https://huggingface.co/tencent/HunyuanVideo-1.5
- Licence de MiniMax H3 : https://rits.shanghai.nyu.edu/ai/minimax-ships-h3-weights-with-the-us-and-eu-excluded/
- Qwen-Image-Edit-2511 : https://huggingface.co/Qwen/Qwen-Image-Edit-2511
- FLUX.2 [klein] 4B : https://huggingface.co/black-forest-labs/FLUX.2-klein-4B
- FLUX.2 [dev] : https://huggingface.co/black-forest-labs/FLUX.2-dev
- Z-Image-Turbo : https://huggingface.co/Tongyi-MAI/Z-Image-Turbo
- Panorama des modèles image : https://www.bentoml.com/blog/a-guide-to-open-source-image-generation-models
- Panorama des modèles vidéo : https://www.thundercompute.com/blog/best-open-source-ai-video-generation-models
- Tarifs RunPod (mis à jour le 27/09/2026) : https://www.runpod.io/pricing
