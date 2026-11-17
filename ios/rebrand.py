#!/usr/bin/env python3
"""IBRA VPN for iPhone — rebrands sing-box-for-apple (GPLv3) and writes the ldid entitlements.
Usage: rebrand.py <clients/apple dir> <out-entitlements-dir>
برمجة وتطوير ابراهيم الخزرجي
"""
import os, re, sys, shutil, glob

apple, ent_out = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
BUNDLE = 'com.ibraprogram.ibravpn'
GROUP = 'group.' + BUNDLE
TEAM = 'IBRAPROG00'

pbx = os.path.join(apple, 'sing-box.xcodeproj', 'project.pbxproj')
s = open(pbx, encoding='utf-8').read()
n = s.replace('INFOPLIST_KEY_CFBundleDisplayName = "sing-box";', 'INFOPLIST_KEY_CFBundleDisplayName = "IBRA VPN";')
if n == s: raise SystemExit('rebrand: display name not found')
# SFI's code uses iOS 16 SwiftUI APIs; raise the 15.0 targets (newer targets stay as they are)
n = n.replace('IPHONEOS_DEPLOYMENT_TARGET = 15.0;', 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;')
open(pbx, 'w', encoding='utf-8').write(n)

icon_dir = os.path.join(apple, 'SFI', 'Assets.xcassets', 'AppIcon.appiconset')
for f in ('1024.png', '1024-dark.png', '1024-tinted.png'):
    shutil.copy(os.path.join(here, f), os.path.join(icon_dir, f))

# Localized display names, if any string catalog overrides CFBundleDisplayName
for f in glob.glob(os.path.join(apple, '**', 'InfoPlist.xcstrings'), recursive=True):
    t = open(f, encoding='utf-8').read()
    open(f, 'w', encoding='utf-8').write(t.replace('"sing-box"', '"IBRA VPN"'))

# Settings: IBRA section (site, Telegram, TikTok, credit) above "About"
sv = os.path.join(apple, 'ApplicationLibrary', 'Views', 'Setting', 'SettingView.swift')
t = open(sv, encoding='utf-8').read()
anchor = '                Section("About") {'
if anchor not in t: raise SystemExit('rebrand: SettingView anchor not found')
ibra = '''                Section(header: Text("برمجة وتطوير ابراهيم الخزرجي")) {
                    FormLink(destination: URL(string: "https://ibraprogram.netlify.app/")!) {
                        Label("كل تطبيقاتي · ibraprogram.netlify.app", systemImage: "globe")
                    }
                    FormLink(destination: URL(string: "https://t.me/ibraprogram")!) {
                        Label("Telegram · ibraprogram", systemImage: "paperplane.fill")
                    }
                    FormLink(destination: URL(string: "https://www.tiktok.com/@ibraprogram")!) {
                        Label("TikTok · ibraprogram", systemImage: "music.note")
                    }
                }
'''
if 'ibraprogram.netlify.app' not in t:
    t = t.replace(anchor, ibra + anchor, 1)
    open(sv, 'w', encoding='utf-8').write(t)

os.makedirs(ent_out, exist_ok=True)
def plist(app_id, extra=''):
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>application-identifier</key><string>{TEAM}.{app_id}</string>
	<key>com.apple.developer.team-identifier</key><string>{TEAM}</string>
	<key>com.apple.security.application-groups</key><array><string>{GROUP}</string></array>
	<key>keychain-access-groups</key><array><string>{TEAM}.{BUNDLE}</string></array>
	<key>get-task-allow</key><false/>{extra}
</dict></plist>
'''
NE = '''
	<key>com.apple.developer.networking.networkextension</key><array><string>packet-tunnel-provider</string></array>'''
open(os.path.join(ent_out, 'App.plist'), 'w').write(plist(BUNDLE, NE))
open(os.path.join(ent_out, 'Extension.plist'), 'w').write(plist(BUNDLE + '.extension', NE + '''
	<key>com.apple.developer.networking.wifi-info</key><true/>
	<key>com.apple.developer.networking.multicast</key><true/>'''))
open(os.path.join(ent_out, 'Other.plist'), 'w').write(plist(BUNDLE + '.other'))
print('IBRA VPN iOS rebrand done')
