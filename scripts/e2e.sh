#!/usr/bin/env bash
# End-to-end run on an emulator: starts the triage server, uploads symbols and the R8 mapping,
# runs every sample scenario in the release (R8-minified) app, then checks what the server
# concluded. Also measures SDK init time and captures a Perfetto trace of a cold start.
#
# Needs: a booted device or emulator (x86_64), node >= 22.18, and a built release APK:
#   ./gradlew :sample:assembleRelease && ./scripts/e2e.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${E2E_OUT:-$ROOT/e2e-out}
PKG=io.github.yasaswini.blackbox.sample
APK=$ROOT/sample/build/outputs/apk/release/sample-release.apk
MAPPING=$ROOT/sample/build/outputs/mapping/release/mapping.txt
PORT=8080
URL=http://127.0.0.1:$PORT
KEY=sample-key
rm -rf "$OUT" && mkdir -p "$OUT/screenshots"

log() { printf '\n== %s\n' "$*"; }

log "Starting the server"
(cd "$ROOT/server" && PORT=$PORT DATA_DIR="$OUT/server-data" API_KEYS=$KEY LOG_REQUESTS=1 \
  node --disable-warning=ExperimentalWarning src/main.ts >"$OUT/server.log" 2>&1) &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true; kill ${LOGCAT_PID:-0} 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf "$URL/healthz" >/dev/null && break; sleep 1; done
head -n 2 "$OUT/server.log"

log "Uploading native symbols and the R8 mapping"
for so in $(find "$ROOT/sample/build/intermediates" -path '*merged_native_libs*release*' -path '*x86_64*' -name '*.so'); do
  curl -sf -X POST -H "authorization: Bearer $KEY" --data-binary @"$so" "$URL/v1/symbols?name=$(basename "$so")"; echo
done
curl -sf -X POST -H "authorization: Bearer $KEY" --data-binary @"$MAPPING" "$URL/v1/mappings?version=1.0.0&build=1"; echo

log "Preparing the device"
adb wait-for-device
adb shell getprop ro.build.fingerprint
echo "ANR timeout multiplier: $(adb shell getprop ro.hw_timeout_multiplier | tr -d '\r')"
adb reverse tcp:$PORT tcp:$PORT
# Without error dialogs, the system kills an ANRing or crashing app instead of waiting for a tap.
adb shell settings put global hide_error_dialogs 1
# Makes the SDK log its per-phase init cost on every launch.
adb shell setprop log.tag.Blackbox DEBUG
adb install -r "$APK" >/dev/null
adb logcat -c
adb logcat -v time >"$OUT/logcat.txt" 2>&1 &
LOGCAT_PID=$!

alive() { adb shell pidof "$PKG" >/dev/null 2>&1; }
home() { adb shell input keyevent KEYCODE_HOME; }
# Starts the app normally so the SDK uploads what the previous process left on disk.
deliver() {
  adb shell am start -W -n "$PKG/.MainActivity" >/dev/null
  sleep 5
  home
  sleep 3
}

log "Cold start under Perfetto"
adb shell am force-stop "$PKG"
adb shell perfetto --background -o /data/misc/perfetto-traces/startup.perfetto-trace -t 12s -b 64mb -a "$PKG" am wm view dalvik sched gfx >/dev/null || echo "perfetto unavailable"
sleep 2
adb shell am start -W -n "$PKG/.MainActivity" | tee "$OUT/cold-start.txt"
sleep 3
adb exec-out screencap -p >"$OUT/screenshots/sample-app.png"
sleep 9
adb pull /data/misc/perfetto-traces/startup.perfetto-trace "$OUT/startup.perfetto-trace" >/dev/null || true
home
sleep 3

# run <scenario> <seconds> [anr]
run() {
  local key=$1 secs=$2 mode=${3:-}
  log "Scenario $key"
  adb shell am force-stop "$PKG"
  adb shell am start -W -n "$PKG/.MainActivity" --es scenario "$key" >/dev/null
  if [[ $mode == anr ]]; then
    sleep 4
    # An input event the blocked main thread cannot handle; the dispatch timeout raises the ANR.
    adb shell input keyevent KEYCODE_DPAD_DOWN
    for _ in $(seq 1 "$secs"); do alive || break; sleep 1; done
    alive && echo "warning: $key did not end in an ANR kill" || echo "process ended (ANR)"
  else
    sleep "$secs"
  fi
  if alive; then home; sleep 3; else deliver; fi
}

run jvm_crash 4
run native_crash 4
run native_abort 4
run race 5
run oom 8
run anr_lock 45 anr
run anr_io 45 anr
run jank 7
run leak 7
run non_fatal 3
deliver

log "SDK init time on the main thread (from logcat)"
grep -o 'Blackbox.init took [0-9]* us' "$OUT/logcat.txt" | awk '{print $3}' | sort -n >"$OUT/init-us.txt" || true
if [[ -s $OUT/init-us.txt ]]; then
  awk '{a[NR]=$1} END {printf "launches=%d min=%d p50=%d p90=%d max=%d (us)\n", NR, a[1], a[int((NR+1)/2)], a[int(NR*0.9+0.5)], a[NR]}' "$OUT/init-us.txt" | tee "$OUT/init-summary.txt"
fi
grep -o 'init took [0-9]* us on the main thread: .*' "$OUT/logcat.txt" >"$OUT/init-phases.txt" || true
head -n 3 "$OUT/init-phases.txt"

log "Perfetto: Blackbox trace sections during cold start"
if [[ -s $OUT/startup.perfetto-trace ]]; then
  cat >"$OUT/startup.sql" <<SQL
SELECT s.name AS slice, t.name AS thread, s.dur / 1000 AS dur_us
FROM slice s JOIN thread_track tt ON s.track_id = tt.id JOIN thread t USING (utid) JOIN process p USING (upid)
WHERE p.name = '$PKG' AND (s.name LIKE 'Blackbox.%' OR s.name IN ('bindApplication', 'activityStart', 'activityResume'))
ORDER BY s.ts LIMIT 20;
SQL
  (cd "$OUT" && curl -sSLo trace_processor https://get.perfetto.dev/trace_processor && chmod +x trace_processor &&
    ./trace_processor --query-file startup.sql startup.perfetto-trace 2>/dev/null | tee perfetto-startup.csv) || echo "trace_processor failed"
fi

log "Verifying diagnoses"
status=0
(cd "$ROOT/server" && node --disable-warning=ExperimentalWarning scripts/e2e-verify.ts --url "$URL" --out "$OUT") || status=$?

log "Dashboard screenshots"
CHROME=$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)
if [[ -n $CHROME ]]; then
  for view in native_crash anr; do
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1440,1900 --virtual-time-budget=8000 \
      --screenshot="$OUT/screenshots/dashboard-$view.png" "$URL/?kind=$view" >/dev/null 2>&1 || true
  done
fi
exit $status
