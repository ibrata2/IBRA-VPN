// IBRA VPN — iPhone interface (same layout as the Windows app). برمجة وتطوير ابراهيم الخزرجي
// Copied into sing-box-for-apple/ApplicationLibrary/Views/Dashboard by ios/rebrand.py.
#if os(iOS)
    import Foundation
    import Libbox
    import Library
    import NetworkExtension
    import SwiftUI

    public enum IBRAConfig {
        public static let profileName = "IBRA VPN — سيرفرات مجانية"
        public static let profileURL = "https://raw.githubusercontent.com/ibrata2/IBRA-VPN/main/profiles/free.json"
        public static let tgListURL = "https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt"
        public static let releaseAPI = "https://api.github.com/repos/ibrata2/IBRA-VPN/releases/latest"
        public static let builtinTG = [
            "tg://proxy?server=fast.strobox.info&port=443&secret=ddf0eeb0bd9adc4fd4a93994ee3b2a216b",
            "tg://proxy?server=Tond.strobox.info&port=443&secret=ddf0eeb0bd9adc4fd4a93994ee3b2a216b",
        ]
        public static let siteURL = "https://ibraprogram.netlify.app/"
        public static let telegramURL = "https://t.me/ibraprogram"
        public static let tiktokURL = "https://www.tiktok.com/@ibraprogram"
        static let red = Color(red: 0.89, green: 0.08, blue: 0.11)
        static let red2 = Color(red: 1.0, green: 0.29, blue: 0.31)
        static let muted = Color(white: 0.64)
        public static var version: String {
            (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0"
        }
    }

    public enum IBRASeed {
        /// True when the packet-tunnel extension (the VPN engine) is inside the installed app.
        public static var hasTunnelExtension: Bool {
            guard let url = Bundle.main.builtInPlugInsURL,
                  let items = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil) else { return false }
            for item in items where item.pathExtension == "appex" {
                if let bundle = Bundle(url: item),
                   let ext = bundle.object(forInfoDictionaryKey: "NSExtension") as? [String: Any],
                   (ext["NSExtensionPointIdentifier"] as? String) == "com.apple.networkextension.packet-tunnel"
                {
                    return true
                }
            }
            return false
        }

        public nonisolated static func ensureProfile() async throws {
            let all = try await ProfileManager.list()
            let selected = await SharedPreferences.selectedProfileID.get()
            if let existing = all.first(where: { $0.remoteURL == IBRAConfig.profileURL }) {
                if selected < 0 || !all.contains(where: { $0.id == selected }) {
                    await SharedPreferences.selectedProfileID.set(existing.mustID)
                }
                return
            }
            let content = try await HTTPClient.getStringAsync(IBRAConfig.profileURL)
            var checkError: NSError?
            LibboxCheckConfig(content, &checkError)
            if let checkError { throw checkError }
            let nextID = try await ProfileManager.nextID()
            let dir = FilePath.sharedDirectory.appendingPathComponent("configs", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try content.write(to: dir.appendingPathComponent("config_\(nextID).json"), atomically: true, encoding: .utf8)
            let name = try await ProfileManager.uniqueName(IBRAConfig.profileName)
            let profile = Profile(
                name: name, type: .remote, path: "configs/config_\(nextID).json",
                remoteURL: IBRAConfig.profileURL, autoUpdate: true, autoUpdateInterval: 360, lastUpdated: Date()
            )
            try await ProfileManager.create(profile)
            try? UIProfileUpdateTask.configure()
            await SharedPreferences.selectedProfileID.set(profile.mustID)
        }

        public nonisolated static func updateServers() async throws -> Int {
            try await ensureProfile()
            guard let profile = try await ProfileManager.list().first(where: { $0.remoteURL == IBRAConfig.profileURL }) else { return 0 }
            try await profile.updateRemoteProfile()
            return await countServers()
        }

        public nonisolated static func countServers() async -> Int {
            guard let profile = try? await ProfileManager.list().first(where: { $0.remoteURL == IBRAConfig.profileURL }) else { return 0 }
            let url = FilePath.sharedDirectory.appendingPathComponent(profile.path)
            guard let data = try? Data(contentsOf: url),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let outbounds = json["outbounds"] as? [[String: Any]] else { return 0 }
            let skip: Set<String> = ["selector", "urltest", "direct", "block", "dns"]
            return outbounds.filter { !skip.contains(($0["type"] as? String) ?? "") }.count
        }

        public nonisolated static func fetchTelegramProxies() async -> [String] {
            guard let text = try? await HTTPClient.getStringAsync(IBRAConfig.tgListURL) else { return [] }
            var out: [String] = []
            for raw in text.split(whereSeparator: \.isNewline) {
                var line = raw.trimmingCharacters(in: .whitespaces)
                guard line.contains("proxy?server=") else { continue }
                if let r = line.range(of: "proxy?") { line = "tg://" + line[r.lowerBound...] }
                line = line.replacingOccurrences(of: ".&port", with: "&port")
                if !out.contains(line) { out.append(line) }
                if out.count >= 30 { break }
            }
            return out
        }

        /// Latest published version, or nil if it can't be checked.
        public nonisolated static func latestVersion() async -> String? {
            guard let text = try? await HTTPClient.getStringAsync(IBRAConfig.releaseAPI),
                  let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  let tag = json["tag_name"] as? String else { return nil }
            return tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        }

        public static func isNewer(_ a: String, than b: String) -> Bool {
            let pa = a.split(separator: ".").map { Int($0) ?? 0 }
            let pb = b.split(separator: ".").map { Int($0) ?? 0 }
            for i in 0 ..< max(pa.count, pb.count) {
                let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
                if x != y { return x > y }
            }
            return false
        }
    }

    private enum IBRATab: Int, CaseIterable {
        case home, servers, settings, about
        var title: String {
            switch self {
            case .home: return "الرئيسية"
            case .servers: return "السيرفرات"
            case .settings: return "الإعدادات"
            case .about: return "حول"
            }
        }

        var icon: String {
            switch self {
            case .home: return "power"
            case .servers: return "server.rack"
            case .settings: return "gearshape.fill"
            case .about: return "info.circle"
            }
        }
    }

    /// Root of the iPhone app: four tabs like the Windows app.
    public struct IBRARootView: View {
        @EnvironmentObject private var environments: ExtensionEnvironments
        @State private var tab: IBRATab = .home
        @State private var note: String?
        @State private var serverCount = 0
        @State private var working = false
        @State private var tgProxies: [String] = IBRAConfig.builtinTG
        @State private var loadingTG = false
        @State private var showGroups = false
        @State private var showAdvanced = false
        @State private var showLogs = false
        @State private var updateText = ""
        @State private var newVersion: String?
        @State private var checkingUpdate = false

        public init() {}

        public var body: some View {
            VStack(spacing: 0) {
                header
                ScrollView {
                    VStack(spacing: 14) {
                        if let note { noteView(note) }
                        switch tab {
                        case .home: homePage
                        case .servers: serversPage
                        case .settings: settingsPage
                        case .about: aboutPage
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                tabBar
            }
            .background(
                RadialGradient(colors: [Color(red: 0.25, green: 0.02, blue: 0.04), Color(red: 0.04, green: 0.04, blue: 0.05)],
                               center: .top, startRadius: 10, endRadius: 700)
                    .ignoresSafeArea()
            )
            .environment(\.layoutDirection, .rightToLeft)
            .preferredColorScheme(.dark)
            .task { await firstRun() }
            .sheet(isPresented: $showGroups) {
                NavigationView {
                    GroupListView().environmentObject(environments)
                        .navigationTitle("اختيار السيرفر").navigationBarTitleDisplayMode(.inline)
                }
            }
            .sheet(isPresented: $showAdvanced) {
                NavigationView {
                    SettingView().environmentObject(environments)
                        .navigationTitle("الإعدادات المتقدمة").navigationBarTitleDisplayMode(.inline)
                }
            }
            .sheet(isPresented: $showLogs) {
                NavigationView {
                    LogView().environmentObject(environments)
                        .navigationTitle("السجل").navigationBarTitleDisplayMode(.inline)
                }
            }
        }

        // MARK: header & tab bar

        private var header: some View {
            HStack(spacing: 8) {
                Image(systemName: "shield.lefthalf.filled").font(.system(size: 22, weight: .bold)).foregroundStyle(IBRAConfig.red)
                Text("IBRA ").font(.system(size: 22, weight: .heavy)) + Text("VPN").font(.system(size: 22, weight: .heavy)).foregroundColor(IBRAConfig.red)
                Spacer()
            }
            .environment(\.layoutDirection, .leftToRight)
            .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 4)
        }

        private var tabBar: some View {
            HStack {
                ForEach(IBRATab.allCases, id: \.rawValue) { t in
                    Button {
                        tab = t
                        note = nil
                    } label: {
                        VStack(spacing: 3) {
                            Image(systemName: t.icon).font(.system(size: 19, weight: .semibold))
                            Text(t.title).font(.system(size: 11, weight: .semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(tab == t ? IBRAConfig.red2 : IBRAConfig.muted)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 8).padding(.bottom, 4)
            .background(Color.black.opacity(0.55).ignoresSafeArea(edges: .bottom))
            .overlay(Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1), alignment: .top)
        }

        private func noteView(_ text: String) -> some View {
            Text(text)
                .font(.footnote.weight(.semibold)).foregroundStyle(.white).multilineTextAlignment(.center)
                .padding(12).frame(maxWidth: .infinity)
                .background(RoundedRectangle(cornerRadius: 14).fill(IBRAConfig.red.opacity(0.25)))
                .onTapGesture { note = nil }
        }

        // MARK: home

        @ViewBuilder
        private var homePage: some View {
            if !IBRASeed.hasTunnelExtension {
                engineMissingCard
            } else if let profile = environments.extensionProfile {
                IBRAPowerCard(profile: profile, note: $note, onConnected: { environments.commandClient.connect() })
            } else {
                installCard
            }
            VStack(alignment: .leading, spacing: 10) {
                Label("السيرفر", systemImage: "bolt.fill").font(.headline)
                Text(serverCount > 0 ? "⚡ تلقائي — الأسرع من \(serverCount) سيرفر" : "يتم تجهيز السيرفرات…")
                    .font(.subheadline).foregroundStyle(IBRAConfig.muted)
                HStack(spacing: 10) {
                    Button { Task { await refreshServers() } } label: {
                        Text(working ? "جاري التحديث…" : "جلب سيرفرات").lineLimit(1).frame(maxWidth: .infinity).padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent).tint(IBRAConfig.red).disabled(working)
                    Button { tab = .servers } label: {
                        Text("كل السيرفرات").lineLimit(1).frame(maxWidth: .infinity).padding(.vertical, 10)
                    }
                    .buttonStyle(.bordered).tint(.white)
                }
            }
            .padding(16).ibraCard()
            Label("انستغرام وفيسبوك وواتساب تشتغل بالـ IP الحقيقي — حماية من التحقق والحظر", systemImage: "checkmark.shield.fill")
                .font(.footnote.weight(.semibold)).foregroundStyle(.green)
                .padding(14).frame(maxWidth: .infinity, alignment: .leading).ibraCard()
        }

        private var engineMissingCard: some View {
            VStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 40)).foregroundStyle(.yellow)
                Text("محرك الـ VPN مو موجود بهذي النسخة").font(.headline)
                Text("طريقة التنصيب حذفت محرك الـ VPN من التطبيق. نصّب ملف IPA بالـ TrollStore، أو وقّعه بحساب مطوّر Apple مدفوع (يدعم VPN). التوقيع بحساب مجاني أو ببعض الشهادات العامة يحذف المحرك.")
                    .font(.footnote).foregroundStyle(IBRAConfig.muted).multilineTextAlignment(.center)
                Text("بروكسيات تليكرام تشتغل عادي من صفحة السيرفرات 👇").font(.footnote.weight(.semibold))
            }
            .padding(18).frame(maxWidth: .infinity).ibraCard()
        }

        private var installCard: some View {
            VStack(spacing: 12) {
                Image(systemName: "lock.shield").font(.system(size: 44)).foregroundStyle(IBRAConfig.red)
                Text("خطوة وحدة قبل أول اتصال").font(.headline)
                Text("اضغط الزر واسمح بإضافة إعدادات VPN حتى يشتغل التطبيق.")
                    .font(.subheadline).foregroundStyle(IBRAConfig.muted).multilineTextAlignment(.center)
                Button {
                    Task {
                        do {
                            try await IBRASeed.ensureProfile()
                            try await ExtensionProfile.install()
                            await environments.reload()
                        } catch { note = "تعذر التفعيل: \(error.localizedDescription)" }
                    }
                } label: {
                    Text("تفعيل IBRA VPN").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent).tint(IBRAConfig.red)
            }
            .padding(20).ibraCard()
        }

        // MARK: servers

        @ViewBuilder
        private var serversPage: some View {
            VStack(alignment: .leading, spacing: 12) {
                Label("السيرفرات المجانية", systemImage: "server.rack").font(.headline)
                Text(serverCount > 0 ? "\(serverCount) سيرفر — التطبيق يفحصها ويختار الأسرع تلقائياً، وتتحدث كل 6 ساعات" : "اضغط جلب سيرفرات جديدة")
                    .font(.subheadline).foregroundStyle(IBRAConfig.muted)
                Button { Task { await refreshServers() } } label: {
                    Label(working ? "جاري التحديث…" : "جلب سيرفرات جديدة", systemImage: "arrow.clockwise")
                        .lineLimit(1).frame(maxWidth: .infinity).padding(.vertical, 11)
                }
                .buttonStyle(.borderedProminent).tint(IBRAConfig.red).disabled(working)
                Button { showGroups = true } label: {
                    Label("اختيار سيرفر معيّن", systemImage: "list.bullet").lineLimit(1).frame(maxWidth: .infinity).padding(.vertical, 11)
                }
                .buttonStyle(.bordered).tint(.white)
                .disabled(environments.extensionProfile?.status.isConnectedStrict != true)
                Text("اختيار سيرفر معيّن يشتغل بعد الاتصال").font(.caption).foregroundStyle(IBRAConfig.muted)
            }
            .padding(16).ibraCard()

            VStack(alignment: .leading, spacing: 10) {
                Label("بروكسيات تليكرام", systemImage: "paperplane.fill").font(.headline)
                Text("تشتغل داخل تليكرام فقط — اضغط اتصال وتليكرام يضيفها").font(.caption).foregroundStyle(IBRAConfig.muted)
                ForEach(Array(tgProxies.enumerated()), id: \.offset) { index, link in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("بروكسي \(index + 1)").font(.subheadline.weight(.semibold))
                            Text(host(of: link)).font(.caption2).foregroundStyle(IBRAConfig.muted).lineLimit(1)
                        }
                        Spacer()
                        if let url = URL(string: link) {
                            Link("اتصال", destination: url)
                                .font(.subheadline.weight(.bold))
                                .padding(.horizontal, 16).padding(.vertical, 7)
                                .background(Capsule().fill(Color(red: 0.16, green: 0.67, blue: 0.93)))
                                .foregroundStyle(.white)
                        }
                    }
                }
                Button {
                    Task {
                        loadingTG = true
                        let more = await IBRASeed.fetchTelegramProxies()
                        loadingTG = false
                        if more.isEmpty { note = "تعذر جلب بروكسيات جديدة — حاول مرة ثانية" }
                        else { tgProxies = IBRAConfig.builtinTG + more.filter { !IBRAConfig.builtinTG.contains($0) } }
                    }
                } label: {
                    Label(loadingTG ? "جاري الجلب…" : "جلب بروكسيات جديدة", systemImage: "arrow.down.circle").frame(maxWidth: .infinity).padding(.vertical, 9)
                }
                .buttonStyle(.bordered).tint(.white).disabled(loadingTG)
            }
            .padding(16).ibraCard()
        }

        // MARK: settings

        @ViewBuilder
        private var settingsPage: some View {
            VStack(alignment: .leading, spacing: 12) {
                Label("التحديثات", systemImage: "arrow.down.app.fill").font(.headline)
                HStack {
                    Text("الإصدار الحالي").foregroundStyle(IBRAConfig.muted)
                    Spacer()
                    Text("v\(IBRAConfig.version)").font(.system(.body, design: .monospaced))
                }
                if !updateText.isEmpty {
                    Text(updateText).font(.subheadline.weight(.semibold))
                        .foregroundStyle(newVersion != nil ? IBRAConfig.red2 : .green)
                }
                Button { Task { await checkUpdate() } } label: {
                    Label(checkingUpdate ? "جاري البحث…" : "البحث عن تحديث", systemImage: "magnifyingglass")
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                }
                .buttonStyle(.bordered).tint(.white).disabled(checkingUpdate)
                if newVersion != nil, let url = URL(string: IBRAConfig.siteURL) {
                    Link(destination: url) {
                        Label("تحميل التحديث من موقعي", systemImage: "arrow.down.circle.fill")
                            .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(RoundedRectangle(cornerRadius: 12).fill(IBRAConfig.red))
                            .foregroundStyle(.white)
                    }
                }
            }
            .padding(16).ibraCard()

            VStack(alignment: .leading, spacing: 12) {
                Label("الاتصال", systemImage: "network").font(.headline)
                settingRow("السيرفرات تتحدث تلقائياً", "كل 6 ساعات")
                settingRow("اختيار السيرفر", "تلقائي — الأسرع")
                settingRow("حماية انستا وفيس", "مفعّلة")
                Divider().overlay(Color.white.opacity(0.1))
                Button { showAdvanced = true } label: {
                    Label("الإعدادات المتقدمة", systemImage: "slider.horizontal.3").frame(maxWidth: .infinity, alignment: .leading)
                }
                .foregroundStyle(.white)
                Button { showLogs = true } label: {
                    Label("السجل", systemImage: "doc.text.magnifyingglass").frame(maxWidth: .infinity, alignment: .leading)
                }
                .foregroundStyle(.white)
            }
            .padding(16).ibraCard()
        }

        private func settingRow(_ title: String, _ value: String) -> some View {
            HStack {
                Text(title)
                Spacer()
                Text(value).foregroundStyle(IBRAConfig.muted)
            }
            .font(.subheadline)
        }

        // MARK: about

        private var aboutPage: some View {
            VStack(spacing: 12) {
                Image(systemName: "shield.lefthalf.filled").font(.system(size: 70)).foregroundStyle(IBRAConfig.red)
                    .shadow(color: IBRAConfig.red.opacity(0.6), radius: 20)
                (Text("IBRA ").font(.system(size: 30, weight: .heavy)) + Text("VPN").font(.system(size: 30, weight: .heavy)).foregroundColor(IBRAConfig.red))
                    .environment(\.layoutDirection, .leftToRight)
                Text("v\(IBRAConfig.version)").font(.footnote).foregroundStyle(IBRAConfig.muted)
                Text("تطبيق اتصال آمن يفتح المواقع والتطبيقات المحجوبة مثل تليكرام، بسيرفرات مجانية تتحدث تلقائياً.")
                    .font(.subheadline).foregroundStyle(IBRAConfig.muted).multilineTextAlignment(.center)
                Text("برمجة وتطوير ابراهيم الخزرجي").font(.headline).foregroundStyle(IBRAConfig.red2)
                    .padding(.vertical, 10).padding(.horizontal, 18)
                    .background(RoundedRectangle(cornerRadius: 14).stroke(IBRAConfig.red.opacity(0.5)))
                ibraLink("كل تطبيقاتي · ibraprogram.netlify.app", "globe", IBRAConfig.siteURL, highlight: true)
                ibraLink("Telegram · ibraprogram", "paperplane.fill", IBRAConfig.telegramURL)
                ibraLink("TikTok · ibraprogram", "music.note", IBRAConfig.tiktokURL)
                Text("يعمل بمحرك sing-box مفتوح المصدر (GPLv3)").font(.caption2).foregroundStyle(IBRAConfig.muted)
            }
            .padding(18).frame(maxWidth: .infinity).ibraCard()
        }

        private func ibraLink(_ title: String, _ icon: String, _ url: String, highlight: Bool = false) -> some View {
            Link(destination: URL(string: url)!) {
                Label(title, systemImage: icon)
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 12).fill(highlight ? IBRAConfig.red.opacity(0.22) : Color.white.opacity(0.06)))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(highlight ? IBRAConfig.red : Color.white.opacity(0.1)))
            }
            .foregroundStyle(.white)
        }

        // MARK: actions

        private func host(of link: String) -> String {
            URLComponents(string: link)?.queryItems?.first(where: { $0.name == "server" })?.value ?? ""
        }

        private func firstRun() async {
            do { try await IBRASeed.ensureProfile() } catch {
                note = "تعذر تحميل السيرفرات المجانية — تأكد من الإنترنت واضغط \"جلب سيرفرات\""
            }
            serverCount = await IBRASeed.countServers()
            if let latest = await IBRASeed.latestVersion(), IBRASeed.isNewer(latest, than: IBRAConfig.version) {
                newVersion = latest
                updateText = "يتوفر تحديث جديد \(latest)"
            }
        }

        private func refreshServers() async {
            working = true
            defer { working = false }
            do {
                serverCount = try await IBRASeed.updateServers()
                note = "تم تحديث السيرفرات (\(serverCount) سيرفر)"
            } catch {
                note = "تعذر التحديث: \(error.localizedDescription)"
            }
        }

        private func checkUpdate() async {
            checkingUpdate = true
            defer { checkingUpdate = false }
            guard let latest = await IBRASeed.latestVersion() else {
                updateText = "تعذر البحث عن تحديث — تأكد من الإنترنت"
                newVersion = nil
                return
            }
            if IBRASeed.isNewer(latest, than: IBRAConfig.version) {
                newVersion = latest
                updateText = "يتوفر تحديث جديد \(latest)"
            } else {
                newVersion = nil
                updateText = "عندك آخر إصدار ✓"
            }
        }
    }

    /// Kept so older references still compile; the app now uses IBRARootView.
    public struct IBRAHomeView: View {
        public init() {}
        public var body: some View { IBRARootView() }
    }

    private struct IBRAPowerCard: View {
        @ObservedObject var profile: ExtensionProfile
        @Binding var note: String?
        let onConnected: () -> Void
        @State private var starting = false

        var body: some View {
            VStack(spacing: 14) {
                Button { toggle() } label: {
                    ZStack {
                        Circle().stroke(on ? IBRAConfig.red.opacity(0.45) : Color.white.opacity(0.08), lineWidth: 14).frame(width: 190, height: 190)
                        Circle()
                            .fill(on ? AnyShapeStyle(LinearGradient(colors: [IBRAConfig.red2, IBRAConfig.red], startPoint: .top, endPoint: .bottom)) : AnyShapeStyle(Color.white.opacity(0.07)))
                            .frame(width: 140, height: 140)
                            .shadow(color: on ? IBRAConfig.red.opacity(0.7) : .clear, radius: 30)
                        if busy {
                            ProgressView().scaleEffect(1.8).tint(.white)
                        } else {
                            Image(systemName: "power").font(.system(size: 54, weight: .bold)).foregroundStyle(on ? .white : .gray)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(busy)
                Text(statusText).font(.title3.weight(.heavy)).foregroundStyle(on ? IBRAConfig.red2 : .white)
                if on, let since = profile.connectedDate {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(elapsed(since, context.date)).font(.system(.body, design: .monospaced)).foregroundStyle(IBRAConfig.muted)
                    }
                    .environment(\.layoutDirection, .leftToRight)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
            .ibraCard()
            .onChange(of: profile.status) { status in
                if starting {
                    if status.isConnectedStrict { starting = false; onConnected() }
                    else if status == .disconnected {
                        starting = false
                        note = "ما گدر يتصل — جرّب \"جلب سيرفرات\" وبعدين اتصل مرة ثانية"
                    }
                }
            }
        }

        private var on: Bool { profile.status.isConnectedStrict }
        private var busy: Bool { profile.status == .connecting || profile.status == .disconnecting || profile.status == .reasserting }

        private var statusText: String {
            switch profile.status {
            case .connected: return "متصل ومحمي"
            case .connecting, .reasserting: return "جاري الاتصال…"
            case .disconnecting: return "جاري القطع…"
            case .invalid: return "يحتاج تفعيل"
            default: return "غير متصل"
            }
        }

        private func toggle() {
            Task {
                do {
                    if on {
                        try await profile.stop()
                    } else {
                        guard IBRASeed.hasTunnelExtension else {
                            note = "محرك الـ VPN مو موجود بهذي النسخة — نصّب بالـ TrollStore أو بحساب مطوّر مدفوع"
                            return
                        }
                        try await IBRASeed.ensureProfile()
                        starting = true
                        try await profile.start()
                    }
                    note = nil
                } catch {
                    starting = false
                    let text = error.localizedDescription
                    if text.contains("VPN") && (text.contains("not installed") || text.contains("تنزيل") || text.contains("مثبت")) {
                        note = "iPhone ما لگى محرك الـ VPN — طريقة التوقيع غيّرت التطبيق. نصّب بالـ TrollStore أو بحساب مطوّر مدفوع."
                    } else {
                        note = "تعذر الاتصال: \(text)"
                    }
                }
            }
        }

        private func elapsed(_ from: Date, _ now: Date) -> String {
            let s = max(0, Int(now.timeIntervalSince(from)))
            return String(format: "%02d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
        }
    }

    private extension View {
        func ibraCard() -> some View {
            background(RoundedRectangle(cornerRadius: 20).fill(Color.white.opacity(0.055)))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.08)))
        }
    }
#endif
