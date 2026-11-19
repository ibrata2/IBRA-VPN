#!/usr/bin/env python3
"""IBRA VPN for Android — turns a v2rayNG checkout (GPLv3, github.com/2dust/v2rayNG) into IBRA VPN.
Usage: rebrand.py <v2rayng-root> <version e.g. 1.0.2>
برمجة وتطوير ابراهيم الخزرجي
"""
import os, re, sys, shutil, glob

root, version = sys.argv[1], sys.argv[2]
app = os.path.join(root, 'V2rayNG', 'app')
main = os.path.join(app, 'src', 'main')
pkg = os.path.join(main, 'java', 'com', 'v2ray', 'ang')
here = os.path.dirname(os.path.abspath(__file__))

APP_ID = 'com.ibraprogram.ibravpn'
FREE_SUBS = [
    ('⚡ IBRA مجاني 1', 'https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt'),
    ('⚡ IBRA مجاني 2', 'https://raw.githubusercontent.com/MatinGhanbari/v2ray-configs/main/subscriptions/v2ray/super-sub.txt'),
]

def edit(path, fn, must=True):
    with open(path, encoding='utf-8') as f: s = f.read()
    n = fn(s)
    if must and n == s: raise SystemExit(f'rebrand: nothing changed in {path}')
    with open(path, 'w', encoding='utf-8') as f: f.write(n)

def sub(pattern, repl, count=0, flags=0):
    return lambda s: re.sub(pattern, repl, s, count=count, flags=flags)

# 1) application id, version, apk names
a, b, c = (int(x) for x in version.split('.'))
code = a * 10000 + b * 100 + c
def gradle(s):
    s = s.replace('applicationId = "com.v2ray.ang"', f'applicationId = "{APP_ID}"')
    s = re.sub(r'versionCode = \d+', f'versionCode = {code}', s, count=1)
    s = re.sub(r'versionName = "[^"]+"', f'versionName = "{version}"', s, count=1)
    s = s.replace('"v2rayNG_${variant.versionName}-fdroid_${abi}.apk"', '"IBRA-VPN-Android-${variant.versionName}-fdroid_${abi}.apk"')
    s = s.replace('"v2rayNG_${variant.versionName}_${abi}.apk"', '"IBRA-VPN-Android-${variant.versionName}_${abi}.apk"')
    return s
edit(os.path.join(app, 'build.gradle.kts'), gradle)

# 2) app name in every language
for f in glob.glob(os.path.join(main, 'res', 'values*', 'strings.xml')):
    edit(f, sub(r'<string name="app_name"([^>]*)>[^<]*</string>', r'<string name="app_name"\1>IBRA VPN</string>'), must=False)

# 3) red theme (orange accents -> IBRA red) and dark icon background
edit(os.path.join(pkg, 'ui', 'compose', 'Theme.kt'), lambda s: s
     .replace('0xFFf97910', '0xFFE3141C').replace('0xFFFFE8D6', '0xFFFFDADB').replace('0xFF2B1700', '0xFF410004'))
edit(os.path.join(main, 'res', 'values', 'ic_launcher_background.xml'), sub(r'#[0-9A-Fa-f]{6}', '#0B0B0E'))
banner = os.path.join(main, 'res', 'values', 'ic_banner_background.xml')
if os.path.exists(banner): edit(banner, sub(r'#[0-9A-Fa-f]{6}', '#0B0B0E'), must=False)

# 4) icons
for d in glob.glob(os.path.join(here, 'res', 'mipmap-*')):
    dst = os.path.join(main, 'res', os.path.basename(d))
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(d):
        shutil.copy(os.path.join(d, f), os.path.join(dst, f))
for f in glob.glob(os.path.join(main, 'res', 'mipmap-*', '*.webp')):
    base = os.path.splitext(f)[0]
    if os.path.exists(base + '.png'): os.remove(f)

# 5) links: updates come from IBRA-VPN releases, Telegram/feedback go to ibraprogram
def cfg(s):
    s = s.replace('const val APP_API_URL = "https://api.github.com/repos/2dust/v2rayNG/releases"',
                  'const val APP_API_URL = "https://api.github.com/repos/ibrata2/IBRA-VPN/releases"')
    s = s.replace('const val TG_CHANNEL_URL = "https://t.me/github_2dust"', 'const val TG_CHANNEL_URL = "https://t.me/ibraprogram"')
    s = s.replace('const val APP_ISSUES_URL = "$APP_URL/issues"', 'const val APP_ISSUES_URL = "https://t.me/ibraprogram"')
    s = s.replace('const val APP_PROMOTION_URL = "aHR0cHM6Ly85LjIzNDQ1Ni54eXovYWJjLmh0bWw="', 'const val APP_PROMOTION_URL = ""')
    if 'IBRA_TIKTOK_URL' not in s:
        s = s.replace('const val TG_CHANNEL_URL', 'const val IBRA_TIKTOK_URL = "https://www.tiktok.com/@ibraprogram"\n    const val IBRA_SITE_URL = "https://ibraprogram.netlify.app/"\n    const val TG_CHANNEL_URL', 1)
    return s
edit(os.path.join(pkg, 'AppConfig.kt'), cfg)

# 6) About: credit + Telegram + TikTok on top
def about(s):
    block = '''            SettingsMenuItem(
                icon = painterResource(R.drawable.ic_telegram_24dp),
                title = "برمجة وتطوير ابراهيم الخزرجي",
                onClick = { Utils.openUri(context, AppConfig.IBRA_SITE_URL) }
            )
            SettingsMenuItem(
                icon = painterResource(R.drawable.ic_source_code_24dp),
                title = "كل تطبيقاتي · ibraprogram.netlify.app",
                onClick = { Utils.openUri(context, AppConfig.IBRA_SITE_URL) }
            )
            SettingsMenuItem(
                icon = painterResource(R.drawable.ic_telegram_24dp),
                title = "Telegram · ibraprogram",
                onClick = { Utils.openUri(context, AppConfig.TG_CHANNEL_URL) }
            )
            SettingsMenuItem(
                icon = painterResource(R.drawable.ic_feedback_24dp),
                title = "TikTok · ibraprogram",
                onClick = { Utils.openUri(context, AppConfig.IBRA_TIKTOK_URL) }
            )
'''
    anchor = '''            SettingsMenuItem(
                icon = painterResource(R.drawable.ic_source_code_24dp),'''
    if anchor not in s: raise SystemExit('rebrand: About anchor not found')
    return s.replace(anchor, block + anchor, 1)
edit(os.path.join(pkg, 'ui', 'AboutActivity.kt'), about)

# 7) first launch: add the free server subscriptions ("get new servers" = update subscriptions)
seed_kt = '''package com.v2ray.ang

import android.content.Context
import com.v2ray.ang.dto.entities.SubscriptionItem
import com.v2ray.ang.handler.MmkvManager

/** IBRA VPN: adds the free server lists once, on first launch. */
object IbraSeed {
    private val SUBS = listOf(
%s
    )

    fun run(context: Context) {
        val prefs = context.getSharedPreferences("ibra_seed", Context.MODE_PRIVATE)
        if (prefs.getBoolean("seed_v2", false)) return
        try {
            val existing = MmkvManager.decodeSubscriptions().map { it.subscription.url }.toSet()
            for ((name, url) in SUBS) {
                if (url in existing) continue
                MmkvManager.encodeSubscription("", SubscriptionItem(remarks = name, url = url, autoUpdate = true, updateInterval = 360))
            }
            // IBRA look everywhere: dark theme with the app's red colours (no wallpaper colours)
            MmkvManager.encodeSettings(AppConfig.PREF_UI_MODE_NIGHT, "2")
            MmkvManager.encodeSettings(AppConfig.PREF_DYNAMIC_COLOR, false)
            prefs.edit().putBoolean("seed_v2", true).apply()
        } catch (_: Throwable) { }
    }
}
''' % ',\n'.join(f'        "{n}" to "{u}"' for n, u in FREE_SUBS)
with open(os.path.join(pkg, 'IbraSeed.kt'), 'w', encoding='utf-8') as f: f.write(seed_kt)
edit(os.path.join(pkg, 'AngApplication.kt'), lambda s: s.replace(
    '        SettingsManager.initApp(this)\n', '        SettingsManager.initApp(this)\n\n        // IBRA VPN: routing files (geosite/geoip) must exist before the first connection —\n        // the original app only copied them when its own main screen opened\n        SettingsManager.initAssets(this, assets)\n\n        // IBRA VPN: free server lists\n        IbraSeed.run(this)\n', 1))

# 7b) "كل السيرفرات" (the original screen) returns to the IBRA home screen: after Connect, and on Back
def main_activity(s):
    a = '        BackHandler { moveTaskToBack(false) }'
    b = '        LauncherManager.startService(this)\n    }'
    if a not in s or b not in s: raise SystemExit('rebrand: MainActivity anchors not found')
    s = s.replace(a, '        BackHandler { if (isTaskRoot) moveTaskToBack(false) else finish() }', 1)
    s = s.replace(b, '        LauncherManager.startService(this)\n        // opened from the IBRA home screen: go back there to see the connection\n        if (!isTaskRoot) finish()\n    }', 1)
    return s
edit(os.path.join(pkg, 'ui', 'main', 'MainActivity.kt'), main_activity)

# 8) IBRA home screen as the launcher (the original screen stays as "كل السيرفرات")
shutil.copy(os.path.join(here, 'IbraHomeActivity.kt'), os.path.join(pkg, 'ui', 'IbraHomeActivity.kt'))
def manifest(s):
    old = '''            <intent-filter>
                <action android:name="android.intent.action.MAIN" />

                <category android:name="android.intent.category.LAUNCHER" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.service.quicksettings.action.QS_TILE_PREFERENCES" />'''
    if old not in s: raise SystemExit('rebrand: manifest launcher block not found')
    s = s.replace(old, '''            <intent-filter>
                <action android:name="android.service.quicksettings.action.QS_TILE_PREFERENCES" />''', 1)
    home = '''        <activity
            android:name=".ui.IbraHomeActivity"
            android:exported="true"
            android:launchMode="singleTask">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />

                <category android:name="android.intent.category.LAUNCHER" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>
        <activity
            android:name=".ui.main.MainActivity"'''
    return s.replace('''        <activity
            android:name=".ui.main.MainActivity"''', home, 1)
edit(os.path.join(main, 'AndroidManifest.xml'), manifest)

print(f'IBRA VPN rebrand done: {APP_ID} v{version} (code {code})')
