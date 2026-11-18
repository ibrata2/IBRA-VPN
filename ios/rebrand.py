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

# IBRA home screen replaces the stock dashboard tab on iPhone
shutil.copy(os.path.join(here, 'IBRAHomeView.swift'), os.path.join(apple, 'ApplicationLibrary', 'Views', 'Dashboard', 'IBRAHomeView.swift'))
nav = os.path.join(apple, 'ApplicationLibrary', 'Views', 'NavigationPage.swift')
t = open(nav, encoding='utf-8').read()
old = '''            case .dashboard:
                DashboardView()'''
if old not in t: raise SystemExit('rebrand: NavigationPage dashboard anchor not found')
t = t.replace(old, '''            case .dashboard:
                #if os(iOS)
                    IBRAHomeView()
                #else
                    DashboardView()
                #endif''', 1)
t = t.replace('''        case .dashboard:
            return String(localized: "Dashboard")''', '''        case .dashboard:
            return "الرئيسية"''', 1)
t = t.replace('''        case .dashboard:
            return "text.and.command.macwindow"''', '''        case .dashboard:
            return "power.circle.fill"''', 1)
open(nav, 'w', encoding='utf-8').write(t)

# Whole iPhone app = IBRA interface (no stock tabs, titles or floating buttons)
mv = os.path.join(apple, 'SFI', 'MainView.swift')
t = open(mv, encoding='utf-8').read()
old = '''    private var mainBody: some View {
        rootContent'''
if old not in t: raise SystemExit('rebrand: MainView mainBody anchor not found')
t = t.replace(old, '''    private var mainBody: some View {
        IBRARootView()''', 1)
open(mv, 'w', encoding='utf-8').write(t)

# Find the VPN engine by what it is (packet-tunnel extension), not by a fixed ID —
# re-signing tools often rename bundle IDs, which made iOS say the VPN app is not installed.
ac = os.path.join(apple, 'Library', 'Shared', 'AppConfiguration.swift')
t = open(ac, encoding='utf-8').read()
old = '''    public static var extensionBundleID: String {
        "\\(packageName).extension"
    }'''
if old not in t: raise SystemExit('rebrand: extensionBundleID anchor not found')
t = t.replace(old, '''    public static var extensionBundleID: String {
        if let found = installedTunnelExtensionID { return found }
        return "\\(packageName).extension"
    }

    private static let installedTunnelExtensionID: String? = {
        #if os(iOS)
            guard let url = Bundle.main.builtInPlugInsURL,
                  let items = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil) else { return nil }
            for item in items where item.pathExtension == "appex" {
                if let bundle = Bundle(url: item),
                   let ext = bundle.object(forInfoDictionaryKey: "NSExtension") as? [String: Any],
                   (ext["NSExtensionPointIdentifier"] as? String) == "com.apple.networkextension.packet-tunnel",
                   let id = bundle.bundleIdentifier
                {
                    return id
                }
            }
        #endif
        return nil
    }()''', 1)
open(ac, 'w', encoding='utf-8').write(t)

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
