// IBRA VPN — iPhone home screen. برمجة وتطوير ابراهيم الخزرجي
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
        public static let builtinTG = [
            "tg://proxy?server=fast.strobox.info&port=443&secret=ddf0eeb0bd9adc4fd4a93994ee3b2a216b",
            "tg://proxy?server=Tond.strobox.info&port=443&secret=ddf0eeb0bd9adc4fd4a93994ee3b2a216b",
        ]
        public static let siteURL = "https://ibraprogram.netlify.app/"
        public static let telegramURL = "https://t.me/ibraprogram"
        public static let tiktokURL = "https://www.tiktok.com/@ibraprogram"
        static let red = Color(red: 0.89, green: 0.08, blue: 0.11)
        static let red2 = Color(red: 1.0, green: 0.29, blue: 0.31)
    }

    public enum IBRASeed {
        /// Adds the free servers profile once and makes sure a profile is selected.
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

        /// Downloads the newest free server list. Returns the number of servers in it.
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
    }

    public struct IBRAHomeView: View {
        @EnvironmentObject private var environments: ExtensionEnvironments
        @State private var note: String?
        @State private var working = false
        @State private var serverCount = 0
        @State private var tgProxies: [String] = IBRAConfig.builtinTG
        @State private var loadingTG = false
        @State private var showGroups = false
        @State private var showAdvanced = false

        public init() {}

        public var body: some View {
            ScrollView {
                VStack(spacing: 16) {
                    header
                    if let profile = environments.extensionProfile {
                        IBRAPowerCard(profile: profile, note: $note, onConnected: {
                            environments.commandClient.connect()
                        })
                    } else {
                        installCard
                    }
                    if let note {
                        Text(note)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(12)
                            .frame(maxWidth: .infinity)
                            .background(RoundedRectangle(cornerRadius: 14).fill(IBRAConfig.red.opacity(0.25)))
                    }
                    serversCard
                    telegramCard
                    aboutCard
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
            }
            .background(
                RadialGradient(colors: [Color(red: 0.25, green: 0.02, blue: 0.04), .black], center: .top, startRadius: 10, endRadius: 650)
                    .ignoresSafeArea()
            )
            .environment(\.layoutDirection, .rightToLeft)
            .preferredColorScheme(.dark)
            .task { await firstRun() }
            .sheet(isPresented: $showGroups) {
                NavigationView {
                    GroupListView()
                        .environmentObject(environments)
                        .navigationTitle("اختيار السيرفر")
                        .navigationBarTitleDisplayMode(.inline)
                }
            }
            .sheet(isPresented: $showAdvanced) {
                NavigationView {
                    DashboardView()
                        .environmentObject(environments)
                        .navigationTitle("الإعدادات المتقدمة")
                        .navigationBarTitleDisplayMode(.inline)
                }
            }
        }

        private var header: some View {
            HStack(spacing: 10) {
                Image(systemName: "shield.lefthalf.filled")
                    .font(.system(size: 26, weight: .bold))
                    .foregroundStyle(IBRAConfig.red)
                Text("IBRA ").font(.system(size: 26, weight: .heavy)) + Text("VPN").font(.system(size: 26, weight: .heavy)).foregroundColor(IBRAConfig.red)
                Spacer()
            }
            .environment(\.layoutDirection, .leftToRight)
            .padding(.top, 6)
        }

        private var installCard: some View {
            VStack(spacing: 12) {
                Image(systemName: "lock.shield").font(.system(size: 44)).foregroundStyle(IBRAConfig.red)
                Text("خطوة وحدة قبل أول اتصال").font(.headline)
                Text("اضغط الزر واسمح بإضافة إعدادات VPN حتى يشتغل التطبيق.")
                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button {
                    Task {
                        do {
                            try await IBRASeed.ensureProfile()
                            try await ExtensionProfile.install()
                            await environments.reload()
                        } catch { note = "تعذر التفعيل: \(error.localizedDescription)" }
                    }
                } label: {
                    Text("تفعيل IBRA VPN").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent).tint(IBRAConfig.red)
            }
            .padding(20)
            .ibraCard()
        }

        private var serversCard: some View {
            VStack(alignment: .leading, spacing: 12) {
                Label("السيرفرات المجانية", systemImage: "server.rack").font(.headline)
                Text(serverCount > 0 ? "\(serverCount) سيرفر — التطبيق يختار الأسرع تلقائياً، وتتحدث كل 6 ساعات" : "يتم تجهيز السيرفرات…")
                    .font(.subheadline).foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    Button {
                        Task { await refreshServers() }
                    } label: {
                        Label(working ? "جاري التحديث…" : "جلب سيرفرات جديدة", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent).tint(IBRAConfig.red).disabled(working)
                    Button {
                        showGroups = true
                    } label: {
                        Label("اختيار سيرفر", systemImage: "list.bullet").frame(maxWidth: .infinity).padding(.vertical, 10)
                    }
                    .buttonStyle(.bordered).tint(.white)
                    .disabled(environments.extensionProfile?.status.isConnectedStrict != true)
                }
                Label("انستغرام وفيسبوك وواتساب تشتغل بالـ IP الحقيقي — حماية من التحقق والحظر", systemImage: "checkmark.shield.fill")
                    .font(.caption).foregroundStyle(.green)
                Button("الإعدادات المتقدمة") { showAdvanced = true }
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(16)
            .ibraCard()
        }

        private var telegramCard: some View {
            VStack(alignment: .leading, spacing: 10) {
                Label("بروكسيات تليكرام", systemImage: "paperplane.fill").font(.headline)
                Text("تشتغل داخل تليكرام فقط — اضغط اتصال وتليكرام يضيفها").font(.caption).foregroundStyle(.secondary)
                ForEach(Array(tgProxies.enumerated()), id: \.offset) { index, link in
                    HStack {
                        Text("بروكسي \(index + 1)").font(.subheadline.weight(.semibold))
                        Text(host(of: link)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        Spacer()
                        if let url = URL(string: link) {
                            Link("اتصال", destination: url)
                                .font(.subheadline.weight(.bold))
                                .padding(.horizontal, 14).padding(.vertical, 6)
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
                        if more.isEmpty { note = "تعذر جلب بروكسيات جديدة — جرّب بعد الاتصال" } else { tgProxies = IBRAConfig.builtinTG + more.filter { !IBRAConfig.builtinTG.contains($0) } }
                    }
                } label: {
                    Label(loadingTG ? "جاري الجلب…" : "جلب بروكسيات جديدة", systemImage: "arrow.down.circle")
                }
                .font(.subheadline).disabled(loadingTG)
            }
            .padding(16)
            .ibraCard()
        }

        private var aboutCard: some View {
            VStack(spacing: 10) {
                Text("برمجة وتطوير ابراهيم الخزرجي").font(.headline).foregroundStyle(IBRAConfig.red2)
                ibraLink("كل تطبيقاتي · ibraprogram.netlify.app", "globe", IBRAConfig.siteURL, highlight: true)
                ibraLink("Telegram · ibraprogram", "paperplane.fill", IBRAConfig.telegramURL)
                ibraLink("TikTok · ibraprogram", "music.note", IBRAConfig.tiktokURL)
            }
            .padding(16)
            .ibraCard()
        }

        private func ibraLink(_ title: String, _ icon: String, _ url: String, highlight: Bool = false) -> some View {
            Link(destination: URL(string: url)!) {
                Label(title, systemImage: icon)
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                    .background(RoundedRectangle(cornerRadius: 12).fill(highlight ? IBRAConfig.red.opacity(0.22) : Color.white.opacity(0.06)))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(highlight ? IBRAConfig.red : Color.white.opacity(0.1)))
            }
            .foregroundStyle(.white)
        }

        private func host(of link: String) -> String {
            guard let comps = URLComponents(string: link) else { return "" }
            return comps.queryItems?.first(where: { $0.name == "server" })?.value ?? ""
        }

        private func firstRun() async {
            do { try await IBRASeed.ensureProfile() } catch {
                note = "تعذر تحميل السيرفرات المجانية — تأكد من الإنترنت واضغط \"جلب سيرفرات جديدة\""
            }
            serverCount = await IBRASeed.countServers()
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
                        Text(elapsed(since, context.date)).font(.system(.body, design: .monospaced)).foregroundStyle(.secondary)
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
                    else if status == .disconnected { starting = false }
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
                        try await IBRASeed.ensureProfile()
                        starting = true
                        try await profile.start()
                    }
                    note = nil
                } catch {
                    starting = false
                    note = "تعذر الاتصال: \(error.localizedDescription)"
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
