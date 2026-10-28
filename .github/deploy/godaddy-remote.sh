#!/usr/bin/env bash
# Runs on the GoDaddy (cPanel) host. .github/workflows/deploy-godaddy.yml pipes
# it over SSH after uploading a release bundle:
#
#   ssh host bash -s -- APP_DIR RELEASE BUNDLE BUNDLE_SHA256 INSTALL_DEPS SWAP_DIRS DB_PUSH < godaddy-remote.sh
#
#   APP_DIR        app root relative to $HOME (cPanel > Setup Node.js App)
#   RELEASE        git commit being deployed
#   BUNDLE         uploaded .tar.gz, relative to $HOME
#   BUNDLE_SHA256  checksum computed before upload
#   INSTALL_DEPS   auto | always | never
#   SWAP_DIRS      comma-separated dirs replaced as a whole (e.g. build), or "-"
#   DB_PUSH        true to run `npm run db:push` when prisma/ changed
#
# Bundle layout:
#   payload/              files to place into the app root
#   meta/deleted          NUL-separated paths removed in git since the last deploy
#   meta/deps-changed     1 when package.json / package-lock.json changed
#   meta/schema-changed   1 when prisma/ changed
#
# Files on the host that are not in the bundle (.env, node_modules, logs,
# uploads, tmp/) are never touched.
set -euo pipefail

if [ $# -ne 7 ]; then
  echo "::error::godaddy-remote.sh expects 7 arguments, got $#"
  exit 2
fi
APP_DIR=$1 RELEASE=$2 BUNDLE=$3 BUNDLE_SHA256=$4 INSTALL_DEPS=$5 SWAP_DIRS=$6 DB_PUSH=$7

log() { printf '==> %s\n' "$*"; }
fail() { printf '::error::%s\n' "$*"; exit 1; }

cd "$HOME"
APP="$HOME/$APP_DIR"
[ -d "$APP" ] || fail "App root ~/$APP_DIR does not exist. Create the app in cPanel > Setup Node.js App first."
[ -f "$BUNDLE" ] || fail "Bundle $BUNDLE was not uploaded."

actual_sha=$(sha256sum "$BUNDLE" | cut -d' ' -f1)
[ "$actual_sha" = "$BUNDLE_SHA256" ] || fail "Bundle checksum mismatch (expected $BUNDLE_SHA256, got $actual_sha)."

WORK="$HOME/.deploy/work-${APP_DIR//\//_}-$RELEASE"
rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK" "$HOME/$BUNDLE"' EXIT
# Bundles left behind by uploads that never got activated.
find "$HOME/.deploy/incoming" -name '*.tar.gz' -mmin +120 -delete 2>/dev/null || true
tar -xzf "$BUNDLE" -C "$WORK"
[ -d "$WORK/payload" ] || fail "Bundle has no payload/ directory."

meta() { [ -f "$WORK/meta/$1" ] && tr -d '[:space:]' < "$WORK/meta/$1" || true; }

if [ -d "$APP/.git" ]; then
  echo "::warning::~/$APP_DIR is a git checkout (cPanel Git Version Control). Files are deployed over it; do not also pull there."
fi

# 1. Directories that are rebuilt every release (the web build) are swapped
#    with two renames, so visitors never see a half-copied folder. The
#    previous copy stays as <dir>.previous for a quick manual rollback.
if [ "$SWAP_DIRS" != "-" ]; then
  IFS=, read -ra swap_dirs <<< "$SWAP_DIRS"
  for dir in "${swap_dirs[@]}"; do
    [ -d "$WORK/payload/$dir" ] || fail "Bundle is missing payload/$dir."
    rm -rf "$APP/$dir.previous"
    if [ -e "$APP/$dir" ]; then
      mv "$APP/$dir" "$APP/$dir.previous"
    fi
    mv "$WORK/payload/$dir" "$APP/$dir"
    log "Replaced $dir/"
  done
fi

# 2. Everything else is copied over the live tree.
file_count=$(find "$WORK/payload" -type f | wc -l)
cp -a "$WORK/payload/." "$APP/"
log "Copied $file_count file(s) into ~/$APP_DIR"

# 3. Remove files that were deleted in git since the last deploy.
if [ -s "$WORK/meta/deleted" ]; then
  while IFS= read -r -d '' file; do
    case "/$file/" in
      *//*|*/../*|*/./*) log "Skipping unsafe path: $file"; continue ;;
    esac
    if [ -f "$APP/$file" ] || [ -L "$APP/$file" ]; then
      rm -f -- "$APP/$file"
      log "Removed $file"
    fi
    # Drop folders left empty, stopping at the app root or a non-empty one.
    dir=$(dirname -- "$file")
    while [ "$dir" != . ] && rmdir -- "$APP/$dir" 2>/dev/null; do
      dir=$(dirname -- "$dir")
    done
  done < "$WORK/meta/deleted"
fi

# 4. Dependencies. cPanel keeps node_modules in a Node.js virtualenv
#    (~/nodevenv/<app>/<version>) that the app root links to, so npm must
#    run inside it. `npm ci` is avoided because it deletes that link.
activate_node() {
  local venv="" link
  link=$(readlink "$APP/node_modules" 2>/dev/null || true)
  case $link in
    */lib/node_modules) venv="${link%/lib/node_modules}/bin/activate" ;;
  esac
  if [ ! -f "$venv" ]; then
    venv=$(ls -d "$HOME/nodevenv/$APP_DIR"/*/bin/activate 2>/dev/null | sort -V | tail -n 1 || true)
  fi
  if [ -n "$venv" ] && [ -f "$venv" ]; then
    set +u
    # shellcheck disable=SC1090
    source "$venv"
    set -u
  elif ! command -v npm >/dev/null 2>&1; then
    fail "No Node.js environment found under ~/nodevenv/$APP_DIR. Create the app in cPanel > Setup Node.js App."
  fi
  log "Using Node.js $(node -v), npm $(npm -v)"
}

deps_changed=$(meta deps-changed)
schema_changed=$(meta schema-changed)
install=false
case $INSTALL_DEPS in
  always) install=true ;;
  auto)
    if [ "$deps_changed" = 1 ] || [ ! -e "$APP/node_modules/.package-lock.json" ]; then
      install=true
    fi
    ;;
  never) ;;
  *) fail "Unknown INSTALL_DEPS value: $INSTALL_DEPS" ;;
esac

if [ "$install" = true ] || [ "$schema_changed" = 1 ]; then
  activate_node
  cd "$APP"
  if [ "$install" = true ]; then
    # postinstall runs `prisma generate` as well.
    log "Installing dependencies"
    npm install --no-audit --no-fund
  else
    log "Prisma schema changed; regenerating the client"
    npm run db:generate
  fi
  if [ "$schema_changed" = 1 ]; then
    if [ "$DB_PUSH" = true ]; then
      log "Applying the Prisma schema to the database"
      npm run db:push
    else
      echo "::warning::prisma/ changed. Apply it with \`npm run db:push\` in ~/$APP_DIR (cPanel Terminal), or set the GODADDY_DB_PUSH variable to true."
    fi
  fi
  cd "$HOME"
else
  log "Dependencies unchanged; skipping npm install"
fi

# 5. Record the release and restart the Passenger app.
printf '%s\n' "$RELEASE" > "$APP/.deploy-revision"
mkdir -p "$APP/tmp"
touch "$APP/tmp/restart.txt"
if command -v cloudlinux-selector >/dev/null 2>&1; then
  if cloudlinux-selector restart --json --interpreter nodejs --app-root "$APP_DIR" >/dev/null 2>&1; then
    log "Restarted the app with cloudlinux-selector"
  else
    log "cloudlinux-selector restart failed; Passenger restarts via tmp/restart.txt"
  fi
else
  log "Touched tmp/restart.txt; Passenger restarts on the next request"
fi

log "Deployed $RELEASE to ~/$APP_DIR"
