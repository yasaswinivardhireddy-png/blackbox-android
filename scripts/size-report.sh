#!/usr/bin/env bash
# Prints the SDK's footprint as a markdown table. Run after:
#   ./gradlew :blackbox:assembleRelease :sample:assembleRelease
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
AAR=$ROOT/blackbox/build/outputs/aar/blackbox-release.aar
APK=$ROOT/sample/build/outputs/apk/release/sample-release.apk
MAPPING=$ROOT/sample/build/outputs/mapping/release/mapping.txt
kb() { awk -v b="$1" 'BEGIN { printf "%.1f KB", b / 1024 }'; }
size() { wc -c <"$1" | tr -d ' '; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
unzip -q "$AAR" -d "$tmp/aar"

echo "### SDK footprint"
echo
echo "| Artifact | Size |"
echo "|---|---|"
echo "| blackbox-release.aar | $(kb "$(size "$AAR")") |"
echo "| classes.jar in the AAR (before R8) | $(kb "$(size "$tmp/aar/classes.jar")") |"
for so in "$tmp"/aar/jni/*/libblackbox.so; do
  echo "| libblackbox.so, $(basename "$(dirname "$so")") | $(kb "$(size "$so")") |"
done

APKANALYZER=$(find "${ANDROID_HOME:-/nonexistent}/cmdline-tools" -name apkanalyzer -type f 2>/dev/null | head -n 1 || true)
if [[ -n $APKANALYZER && -f $APK ]]; then
  # Defined methods and dex bytes of the SDK after R8, deobfuscated with the mapping. The sample
  # app lives in a subpackage of the SDK's package, so its share is subtracted.
  packages=$("$APKANALYZER" dex packages --defined-only --proguard-mappings "$MAPPING" "$APK")
  sdk=$(echo "$packages" | awk '$1 == "P" && $NF == "io.github.yasaswini.blackbox" { print $3, $5 }')
  app=$(echo "$packages" | awk '$1 == "P" && $NF == "io.github.yasaswini.blackbox.sample" { print $3, $5 }')
  if [[ -n $sdk ]]; then
    read -r sdk_methods sdk_bytes <<<"$sdk"
    read -r app_methods app_bytes <<<"${app:-0 0}"
    echo "| SDK code in the minified sample app | $((sdk_methods - app_methods)) methods, $(kb $((sdk_bytes - app_bytes))) of dex |"
  fi
  echo "| sample-release.apk (whole app, 2 ABIs) | $(kb "$(size "$APK")") |"
fi
