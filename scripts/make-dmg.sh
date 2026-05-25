#!/usr/bin/env bash
# Pack the freshly built Sisyphus.app into a minimal .dmg using hdiutil.
#
# We skip Tauri's built-in dmg target because its create-dmg fork drives
# Finder via AppleScript, which intermittently times out on macOS 13+
# ("AppleEvent timed out", error -1712). hdiutil's UDZO format gives us a
# plain compressed dmg without that cosmetic step.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$REPO_ROOT/src-tauri/target/release/bundle/macos/Sisyphus.app"
VERSION="$(node -p "require('$REPO_ROOT/src-tauri/tauri.conf.json').version")"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) DMG_ARCH=arm64 ;;
  x86_64) DMG_ARCH=x64 ;;
  *) DMG_ARCH="$ARCH" ;;
esac
DMG="$REPO_ROOT/src-tauri/target/release/bundle/macos/Sisyphus_${VERSION}_${DMG_ARCH}.dmg"

if [ ! -d "$APP" ]; then
  echo "error: $APP not found — run \`pnpm tauri build\` first" >&2
  exit 1
fi

rm -f "$DMG"

# Stage a tmpdir with the .app and an Applications symlink so users can
# drag-drop straight into /Applications.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

hdiutil create \
  -volname "Sisyphus" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$DMG"

echo "ok → $DMG"
