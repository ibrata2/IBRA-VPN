#!/bin/bash
# Installs each IBRA VPN APK on the running emulator, opens the IBRA home screen,
# checks the app is alive with no crash, and saves a screenshot. Exits 1 if any APK fails.
APKS="$1"; SHOTS="$2"; PKG=com.ibraprogram.ibravpn
mkdir -p "$SHOTS"; fail=0
adb shell settings put global window_animation_scale 0 >/dev/null 2>&1
echo "emulator ABIs: $(adb shell getprop ro.product.cpu.abilist)"
for apk in "$APKS"/*.apk; do
  name=$(basename "$apk" .apk); abi=${name##*_}
  echo "=== $name"
  adb uninstall $PKG >/dev/null 2>&1
  if ! adb install -r "$apk" 2>&1 | tee /tmp/inst.txt | grep -q Success; then
    echo "INSTALL FAILED: $(cat /tmp/inst.txt)"; fail=1; continue
  fi
  adb logcat -c
  adb shell am start -W -n $PKG/com.v2ray.ang.ui.IbraHomeActivity >/dev/null
  sleep 25
  pid=$(adb shell pidof $PKG | tr -d '\r')
  crash=$(adb logcat -d -b crash | grep -A12 "$PKG" | head -30)
  adb exec-out screencap -p > "$SHOTS/$abi.png"
  # also open the full server list screen to make sure it works too
  adb shell am start -n $PKG/com.v2ray.ang.ui.main.MainActivity >/dev/null; sleep 6
  pid2=$(adb shell pidof $PKG | tr -d '\r')
  crash2=$(adb logcat -d -b crash | grep -A12 "$PKG" | head -30)
  adb exec-out screencap -p > "$SHOTS/$abi-servers.png"
  if [ -z "$pid" ] || [ -z "$pid2" ] || [ -n "$crash$crash2" ]; then
    echo "FAILED $name (pid='$pid' pid2='$pid2')"; echo "$crash$crash2"; fail=1
  else
    echo "OK $name — running (pid $pid), no crash"
  fi
done
exit $fail
