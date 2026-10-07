#!/bin/bash
# NX STUDIO on a Mac, in one command (see docs/GPU_WORKERS.md, "Rendre NX STUDIO joignable depuis un Mac"):
#   curl -fsSL https://raw.githubusercontent.com/djnastx-a11y/NX-IMAGE-VIDEO/main/scripts/mac-setup.sh | bash
# Needs Docker Desktop and the Tailscale app. Installs into ~/NX-STUDIO, keeps its .env (and so the data and
# tokens) when run again to update, starts NX STUDIO with docker compose and publishes it over HTTPS with
# Tailscale Funnel. Prints the address and the Kaggle agent token at the end.
# Written for macOS's bash 3.2: no bash 4 features.
set -euo pipefail

REPO="djnastx-a11y/NX-IMAGE-VIDEO"
BRANCH="${NX_BRANCH:-main}"
DIR="${NX_DIR:-$HOME/NX-STUDIO}"
PORT=8787

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }

# --- Docker
say "1/5  Docker"
if ! command -v docker >/dev/null 2>&1; then
  [ -x /Applications/Docker.app/Contents/Resources/bin/docker ] || die "Docker Desktop n'est pas installé : https://www.docker.com/products/docker-desktop/"
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi
if ! docker info >/dev/null 2>&1; then
  echo "Démarrage de Docker Desktop…"
  open -a Docker 2>/dev/null || true
  for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || die "Docker Desktop ne répond pas. Ouvre-le, accepte les conditions, puis relance cette commande."
fi
echo "Docker est prêt."

# --- Code (a tarball: no git or Xcode tools needed)
say "2/5  Téléchargement de NX STUDIO dans $DIR"
mkdir -p "$DIR"
if [ -n "$(ls -A "$DIR")" ] && [ ! -f "$DIR/docker-compose.yml" ]; then
  die "$DIR existe déjà et ne contient pas NX STUDIO ; choisis un autre dossier avec NX_DIR=..."
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$BRANCH" | tar -xz -C "$TMP"
SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -f "$SRC/docker-compose.yml" ] || die "téléchargement incomplet"
# replace the code, keep .env
find "$DIR" -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} +
cp -R "$SRC"/. "$DIR"/
cd "$DIR"

# --- Configuration (only the first time)
if [ ! -f .env ]; then
  say "3/5  Création de la configuration (.env)"
  rand() { openssl rand -hex "$1"; }
  sed \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 24)|" \
    -e "s|^NX_PORT=.*|NX_PORT=127.0.0.1:$PORT|" \
    -e "s|^NX_ENABLE_MOCK=.*|NX_ENABLE_MOCK=false|" \
    .env.example >.env
  cat >>.env <<EOF

# --- GPU gratuit sur Kaggle (mode agent, docs/GPU_WORKERS.md)
NX_GPU_AGENTS=[{"id":"kaggle","tokenEnv":"NX_GPU_AGENT_TOKEN_KAGGLE","engines":["ltx-video","wan-5b","flux","real-esrgan"]}]
NX_GPU_AGENT_TOKEN_KAGGLE=$(rand 32)
EOF
  chmod 600 .env
else
  say "3/5  Configuration existante conservée (.env)"
fi

# --- Start
say "4/5  Lancement de NX STUDIO (la première fois, la construction prend plusieurs minutes)"
docker compose up -d --build
printf 'Attente du démarrage'
for _ in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  printf '.'; sleep 2
done
echo
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || die "NX STUDIO ne répond pas. Détails : cd $DIR && docker compose logs app"
echo "NX STUDIO tourne."

# --- Public HTTPS address
say "5/5  Adresse publique avec Tailscale"
TS="$(command -v tailscale 2>/dev/null || true)"
[ -n "$TS" ] || TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TS" ] || die "Tailscale n'est pas installé : https://tailscale.com/download/mac"
"$TS" status >/dev/null 2>&1 || die "Tailscale n'est pas connecté. Ouvre l'application Tailscale, connecte-toi, puis relance cette commande."
echo "Si un lien s'affiche ci-dessous, ouvre-le et accepte d'activer Funnel, puis reviens ici."
"$TS" funnel --bg "$PORT"
# the first DNSName of the status is this Mac's ("Self" comes before "Peer"); no python on a fresh Mac
HOST="$("$TS" status --json | grep -m1 '"DNSName"' | sed -E 's/.*"DNSName": *"([^"]*)".*/\1/; s/\.$//')"
[ -n "$HOST" ] || die "adresse Tailscale introuvable ; lance : $TS funnel status"
URL="https://$HOST"
TOKEN="$(sed -n 's/^NX_GPU_AGENT_TOKEN_KAGGLE=//p' .env)"

# The whole Kaggle notebook in one cell, address and token filled in: Jb pastes it into an empty notebook.
CELL="$DIR/kaggle-cellule.txt"
cat >"$CELL" <<EOF
# NX STUDIO : moteur GPU gratuit sur Kaggle. Réglages du notebook : GPU T4 x2, Internet On.
NX_URL = "$URL"
NX_GPU_AGENT_TOKEN = "$TOKEN"
ENGINES = "ltx-video,real-esrgan"   # images : "flux,real-esrgan"   vidéo plus fidèle mais lente : "wan-5b"

import os, subprocess, sys
subprocess.run("rm -rf /kaggle/working/nx && git clone -q --depth 1 https://github.com/$REPO /kaggle/working/nx"
               " && pip install -q -r /kaggle/working/nx/gpu-worker/requirements-kaggle.txt", shell=True, check=True)
env = dict(os.environ, NX_URL=NX_URL, NX_GPU_AGENT_TOKEN=NX_GPU_AGENT_TOKEN, NX_ENGINES=ENGINES,
           HF_HOME="/tmp/hf", NX_GPU_MODELS_DIR="/tmp/nx-models", NX_GPU_DATA_DIR="/tmp/nx-gpu",
           NX_GPU_OFFLOAD="model", PYTHONUNBUFFERED="1")
proc = subprocess.Popen([sys.executable, "-m", "nx_gpu.agent"], cwd="/kaggle/working/nx/gpu-worker", env=env,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
for line in proc.stdout:
    print(line, end="", flush=True)
proc.wait()
print("Agent arrêté, code", proc.returncode)
EOF
chmod 600 "$CELL"
open -e "$CELL" 2>/dev/null || true

say "C'est prêt."
cat <<EOF

  Adresse de NX STUDIO (ordinateur et téléphone) :
      $URL

  Pour Kaggle : le fichier kaggle-cellule.txt vient de s'ouvrir dans TextEdit.
  Copie tout (Cmd+A puis Cmd+C) et colle-le dans la case de code du notebook Kaggle.
  (Il est aussi dans $CELL)

  Il contient ton jeton, qui sert de mot de passe : garde le notebook privé
  (c'est le réglage par défaut de Kaggle) et ne le partage avec personne.
  Le Mac doit rester allumé (pas en veille) pendant que tu utilises NX STUDIO.
  Pour mettre à jour NX STUDIO plus tard : relance la même commande.

EOF
