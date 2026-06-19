#!/usr/bin/env bash
# Первичная установка bron-bot на чистый Ubuntu-сервер (когда CI ещё не настроен).
# Файл должен быть с LF-переводами строк (см. .gitattributes).
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info(){ echo -e "${GREEN}[INFO]${NC} $*"; }
error(){ echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
prompt(){ read -rp "$(echo -e "${YELLOW}>>> $1: ${NC}")" "$2"; }

GIT_REPO=${GIT_REPO:-https://github.com/dimatolpygin/torgi}
prompt "Ветка [master]" BRANCH; BRANCH=${BRANCH:-master}
prompt "Каталог [/opt/bron-bot]" INSTALL_DIR; INSTALL_DIR=${INSTALL_DIR:-/opt/bron-bot}
prompt "TELEGRAM_BOT_TOKEN" TELEGRAM_BOT_TOKEN
prompt "ACCOUNTS (логин:пароль,логин:пароль)" ACCOUNTS

PGPASSWORD=$(openssl rand -hex 24)

command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }

if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR" && git fetch --all && git checkout "$BRANCH" && git reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$GIT_REPO" "$INSTALL_DIR" && cd "$INSTALL_DIR"
fi

cat > .env <<ENVEOF
SITE_BASE_URL=https://gorod.it-minsk.by
RINOK_ID=10
ASSORT_IDS=2
TZ_NAME=Europe/Minsk
PREPARE_LEAD_SECONDS=120
DRY_RUN=true
ACCOUNTS=${ACCOUNTS}
PGHOST=postgres
PGPORT=5432
PGUSER=bron
PGPASSWORD=${PGPASSWORD}
PGDATABASE=bron
REDIS_HOST=redis
REDIS_PORT=6379
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
LOG_LEVEL=info
ENVEOF
chmod 600 .env

docker compose up -d --build
info "Готово. Логи: docker compose -f ${INSTALL_DIR}/docker-compose.yml logs -f app"
