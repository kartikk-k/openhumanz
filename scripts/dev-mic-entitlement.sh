#!/usr/bin/env bash
#
# Give the dev Electron binary a stable bundle id + the microphone entitlement,
# then ad-hoc re-sign it. Without this, macOS attributes mic access to the
# generic ad-hoc "com.github.Electron" identity, which gets stuck in a `denied`
# TCC state that can't be re-prompted or reliably reset — so hold-Space-to-talk
# never gets microphone access in development.
#
# macOS only. No-op on other platforms and when the app / codesign is absent.
# Idempotent: safe to run before every `bun start`.
set -euo pipefail

[ "$(uname)" = "Darwin" ] || exit 0

APP="node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"
BUNDLE_ID="com.openhumanz.dev"
# Display name macOS shows for this app in System Settings › Notifications and
# in the Focus allow-list. Without this the dev binary shows as the generic
# "Electron", which is impossible to find and shares state with every other
# unsigned Electron app.
APP_NAME="Assistant"

[ -d "$APP" ] || { echo "[dev-mic] $APP not found, skipping"; exit 0; }
command -v codesign >/dev/null 2>&1 || { echo "[dev-mic] codesign missing, skipping"; exit 0; }

# If already set up (right bundle id, audio entitlement, AND display name), do
# nothing. The display name check is what forces a one-time re-run on machines
# that were set up before the "Assistant" naming was added.
CURRENT_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST" 2>/dev/null || echo '')"
CURRENT_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$PLIST" 2>/dev/null || echo '')"
if [ "$CURRENT_ID" = "$BUNDLE_ID" ] && [ "$CURRENT_NAME" = "$APP_NAME" ] && \
   codesign -d --entitlements - "$APP" 2>/dev/null | grep -q "com.apple.security.device.audio-input"; then
  exit 0
fi

echo "[dev-mic] configuring Electron dev binary for microphone access…"

# 1) stable bundle id so TCC can track / reset this app distinctly
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$PLIST"

# 2) mic usage string (required or the request fails silently)
/usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription This app uses your microphone while you hold Space to talk." "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string This app uses your microphone while you hold Space to talk." "$PLIST"

# 2b) display name so macOS Notifications / Focus show "Assistant" rather than
# the generic "Electron" — required to find & allow the app in Focus settings.
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleName string $APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $APP_NAME" "$PLIST"

# 3) ad-hoc re-sign with the audio-input entitlement (+ JIT so Electron runs)
ENT="$(mktemp -t electron-dev-entitlements).plist"
cat > "$ENT" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.device.audio-input</key>
  <true/>
</dict>
</plist>
EOF

codesign --force --deep --sign - --entitlements "$ENT" "$APP" >/dev/null 2>&1 || {
  echo "[dev-mic] codesign failed; mic may not work in dev"; rm -f "$ENT"; exit 0;
}
rm -f "$ENT"

# 4) clear any stale denial for this id so the next request prompts fresh
tccutil reset Microphone "$BUNDLE_ID" >/dev/null 2>&1 || true

echo "[dev-mic] done — quit & relaunch, then hold Space to get the mic prompt."
