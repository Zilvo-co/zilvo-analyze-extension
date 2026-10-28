#!/usr/bin/env bash
#
# scripts/package.sh — build a Chrome Web Store upload zip.
#
# The store rejects any zip where manifest.json is not AT THE ROOT of the
# archive (and macOS "Compress" adds a wrapping folder + __MACOSX junk).
# This script stages only the files the shipped (root level) extension needs,
# then zips the CONTENTS of that staging dir so manifest.json lands at root.
#
# Usage: npm run package
#
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./manifest.json').version")
OUT="zilvo-analyze-extension-v${VERSION}.zip"
STAGE_ROOT=$(mktemp -d)
STAGE="$STAGE_ROOT/extension"
trap 'rm -rf "$STAGE_ROOT"' EXIT

mkdir -p "$STAGE/icons"

# Files referenced by manifest.json / popup.html.
cp manifest.json background.js popup.html popup.js styles.css content_zilvo.js "$STAGE/"

# Local ES modules imported by background.js and popup.js.
mkdir -p "$STAGE/helpers" "$STAGE/shared"
cp helpers/*.js "$STAGE/helpers/"
cp shared/zilvo-urls.js "$STAGE/shared/"

# Icons declared in manifest.json + logo used in popup.html.
cp icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png \
   icons/zilvo-logo.png "$STAGE/icons/"

# Strip macOS noise that breaks/inflates the upload.
find "$STAGE" -name '.DS_Store' -delete
find "$STAGE" -name '._*' -delete

# Sanity-check every manifest reference actually exists in the package.
node - "$STAGE" <<'NODE'
const fs = require('fs');
const path = require('path');
const stage = process.argv[2];
const m = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
const refs = new Set([...(m.content_scripts || []).flatMap((c) => c.js || []), m.background?.service_worker, m.background?.page, m.action?.default_popup, m.side_panel?.default_path, ...Object.values(m.icons || {}), ...Object.values(m.action?.default_icon || {})].filter(Boolean));
const missing = [...refs].filter((r) => !fs.existsSync(path.join(stage, r)));
if (missing.length) {
  console.error('✗ manifest references missing files:', missing.join(', '));
  process.exit(1);
}
console.log(`✓ manifest.json valid — ${refs.size} referenced files present`);
NODE

rm -f "$OUT"
(cd "$STAGE" && zip -rX -q "$OLDPWD/$OUT" .)

# Fail loudly if manifest.json is not at the zip root.
if ! unzip -Z1 "$OUT" | grep -qx 'manifest.json'; then
  echo "✗ manifest.json is not at the zip root — aborting" >&2
  exit 1
fi

echo "✓ built $OUT ($(du -h "$OUT" | cut -f1), $(unzip -Z1 "$OUT" | wc -l | tr -d ' ') files)"
echo "  manifest_version 3 · version $VERSION · manifest.json at zip root"
