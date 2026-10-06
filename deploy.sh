#!/usr/bin/env bash
#
# deploy.sh — mise à jour de HolidayHub sur le VPS.
#
# Lancé par GitHub Actions via SSH, ou à la main : /var/www/HolidayHub/deploy.sh
# La clé SSH de déploiement est restreinte à cette seule commande, donc le
# script ne reçoit aucun argument.
#
# Si l'application ne répond plus après la mise à jour, la version précédente
# est restaurée automatiquement.

set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/HolidayHub}"
PM2_NAME="${PM2_NAME:-holidayhub}"
HEALTH_PATH="${HEALTH_PATH:-/api/health}"
PORT_PAR_DEFAUT=7700
HEALTH_RETRIES=15

log()  { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m✖ %s\033[0m\n' "$1" >&2; }

cd "$APP_DIR"

# Le port vit dans le .env du serveur : on le lit plutôt que de le figer ici.
PORT="$(sed -n 's/^PORT=\([0-9]\{1,\}\).*/\1/p' .env 2>/dev/null | head -1 || true)"
HEALTH_URL="http://127.0.0.1:${PORT:-$PORT_PAR_DEFAUT}${HEALTH_PATH}"

# ── Ce qui est en ligne, et ce qui devrait l'être ───────────────
PREVIOUS="$(git rev-parse HEAD)"
git fetch --prune origin main
TARGET="$(git rev-parse origin/main)"

if [ "$PREVIOUS" = "$TARGET" ]; then
  log "Déjà à jour sur ${TARGET:0:8} — rien à faire."
  exit 0
fi

log "Mise à jour ${PREVIOUS:0:8} → ${TARGET:0:8}"
git --no-pager log --oneline "$PREVIOUS..$TARGET" | sed 's/^/    /'

# ── Dépendances : seulement si elles ont bougé ──────────────────
install_deps_if_needed() {
  local from="$1" to="$2"
  if ! git diff --quiet "$from" "$to" -- package.json package-lock.json; then
    log "Dépendances modifiées — npm ci"
    npm ci --omit=dev
  fi
}

# reset plutôt que pull : le serveur reflète exactement la branche,
# sans jamais rester bloqué sur un conflit local.
git reset --hard "$TARGET"
# Si npm ci échoue, le code est déjà à la nouvelle version mais pas ses
# dépendances : on revient à la version précédente au lieu de s'arrêter là.
if ! install_deps_if_needed "$PREVIOUS" "$TARGET"; then
  fail "npm ci a échoué — retour à ${PREVIOUS:0:8}"
  git reset --hard "$PREVIOUS"
  install_deps_if_needed "$TARGET" "$PREVIOUS" || true
  pm2 restart "$PM2_NAME" --update-env || true
  exit 1
fi

log "Redémarrage de $PM2_NAME"
pm2 restart "$PM2_NAME" --update-env

# ── Contrôle de santé ───────────────────────────────────────────
# /api/health est public et répond 200 quand l'app tourne : tout autre code
# (404 d'une route disparue, 502 du proxy…) est un échec.
log "Vérification de $HEALTH_URL"
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL" || true)"
  if [ "$CODE" = "200" ]; then
    log "En ligne sur ${TARGET:0:8} — HTTP $CODE ✅"
    exit 0
  fi
  sleep 1
done

# ── Retour arrière ──────────────────────────────────────────────
fail "Pas de réponse exploitable après $HEALTH_RETRIES secondes (dernier code : ${CODE:-aucun}) — retour à ${PREVIOUS:0:8}"
git reset --hard "$PREVIOUS"
install_deps_if_needed "$TARGET" "$PREVIOUS"
pm2 restart "$PM2_NAME" --update-env

printf '\n--- 40 dernières lignes de pm2 ---\n'
pm2 logs "$PM2_NAME" --lines 40 --nostream || true
exit 1
