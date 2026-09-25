#!/usr/bin/env bash
set -euo pipefail

REPO='farijarifriyanto-debug/BotConnector-LibreChat'
RUNTIME_ROOT='/home/botadmin/newbotconnector/runtime/librechat'
SOURCE_ROOT="$RUNTIME_ROOT/source"
LOCK_FILE="$RUNTIME_ROOT/.production-deploy.lock"
MANIFEST_FILE="$RUNTIME_ROOT/RUNTIME_MANIFEST"
SERVICE='botconnector-librechat.service'

if [[ $# -ne 1 ]]; then
  echo 'Usage: promote-librechat.sh <artifact-dir>' >&2
  exit 2
fi

ARTIFACT_DIR="$(readlink -f "$1")"
ARTIFACT_MANIFEST="$ARTIFACT_DIR/manifest.txt"
ARTIFACT_TARBALL="$ARTIFACT_DIR/botconnector-librechat-build.tar.gz"
[[ -f "$ARTIFACT_MANIFEST" ]] || { echo "ERROR: missing $ARTIFACT_MANIFEST" >&2; exit 2; }
[[ -f "$ARTIFACT_TARBALL" ]] || { echo "ERROR: missing $ARTIFACT_TARBALL" >&2; exit 2; }

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo 'ERROR: another BotConnector production deployment is already running.' >&2
  exit 75
fi

ARTIFACT_SHA="$(awk -F= '$1=="commit"{print $2; exit}' "$ARTIFACT_MANIFEST")"
[[ "$ARTIFACT_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'ERROR: invalid artifact SHA.' >&2; exit 2; }
REMOTE_MAIN_SHA="$(git ls-remote "https://github.com/$REPO.git" refs/heads/main | awk '{print $1}')"
[[ "$REMOTE_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'ERROR: cannot resolve GitHub main.' >&2; exit 69; }

if [[ "$ARTIFACT_SHA" != "$REMOTE_MAIN_SHA" ]]; then
  echo 'STALE_ARTIFACT: refusing production deploy.' >&2
  echo "artifact=$ARTIFACT_SHA" >&2
  echo "current_main=$REMOTE_MAIN_SHA" >&2
  exit 78
fi

SHORT_SHA="$(printf '%s' "$ARTIFACT_SHA" | cut -c1-12)"
DEPLOY_ID="$SHORT_SHA-$(date +%Y%m%dT%H%M%S)"
RELEASE_DIR="$RUNTIME_ROOT/releases/$DEPLOY_ID"
STAGE_DIR="$RELEASE_DIR/stage"
ROLLBACK_DIR="$RELEASE_DIR/rollback"
mkdir -p "$STAGE_DIR" "$ROLLBACK_DIR"
tar -xzf "$ARTIFACT_TARBALL" -C "$STAGE_DIR"

ITEMS=(
  'api'
  'client/dist'
  'packages/data-provider/dist'
  'packages/data-schemas/dist'
  'packages/api/dist'
  'packages/client/dist'
  'node_modules/@librechat/agents'
  'deploy/librechat.botconnector.yaml'
)

for rel in "${ITEMS[@]}"; do
  [[ -e "$STAGE_DIR/$rel" ]] || { echo "ERROR: artifact missing $rel" >&2; exit 2; }
done

restore_previous() {
  set +e
  for rel in "${ITEMS[@]}"; do
    rm -rf "$SOURCE_ROOT/$rel"
    if [[ -e "$ROLLBACK_DIR/$rel" ]]; then
      mkdir -p "$(dirname "$SOURCE_ROOT/$rel")"
      mv "$ROLLBACK_DIR/$rel" "$SOURCE_ROOT/$rel"
    fi
  done
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  systemctl --user restart "$SERVICE" >/dev/null 2>&1 || true
  set -e
}

for rel in "${ITEMS[@]}"; do
  if [[ -e "$SOURCE_ROOT/$rel" ]]; then
    mkdir -p "$(dirname "$ROLLBACK_DIR/$rel")"
    mv "$SOURCE_ROOT/$rel" "$ROLLBACK_DIR/$rel"
  fi
  mkdir -p "$(dirname "$SOURCE_ROOT/$rel")"
  mv "$STAGE_DIR/$rel" "$SOURCE_ROOT/$rel"
done

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user restart "$SERVICE"

healthy=0
for _ in $(seq 1 40); do
  if systemctl --user is-active --quiet "$SERVICE" && curl -fsS http://127.0.0.1:18480/ >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done

if [[ "$healthy" -ne 1 ]]; then
  echo 'ERROR: production health-check failed; rolling back.' >&2
  restore_previous
  exit 70
fi

BUILT_AT="$(awk -F= '$1=="built_at"{print $2; exit}' "$ARTIFACT_MANIFEST")"
{
  echo "repository=$REPO"
  echo "deployed_head=$ARTIFACT_SHA"
  echo "current_main_at_deploy=$REMOTE_MAIN_SHA"
  echo "built_at=$BUILT_AT"
  echo "deployed_at=$(date -u +%FT%TZ)"
  echo "artifact_path=$ARTIFACT_TARBALL"
  echo "deploy_id=$DEPLOY_ID"
} > "$MANIFEST_FILE.tmp"
mv "$MANIFEST_FILE.tmp" "$MANIFEST_FILE"

echo 'DEPLOY_OK'
echo "sha=$ARTIFACT_SHA"
echo "deploy_id=$DEPLOY_ID"
