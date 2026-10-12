// DSH Mobile views. State and networking live in Core.swift (Client).
import SwiftUI
import PhotosUI
import AVFoundation

@main struct DSHMobileApp: App {
    @StateObject private var client = Client()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            Root().environmentObject(client)
                .onChange(of: phase, initial: true) { _, p in if p == .active { client.browse(); client.wake() } }
        }
    }
}

struct Root: View {
    @EnvironmentObject var c: Client
    var body: some View {
        Group {
            if c.pairing == nil { PairView() } else {
                TabView(selection: $c.tab) {
                    ConversationView().tabItem { Label("Conversation", systemImage: "bubble.left.and.bubble.right") }.tag(0)
                    SessionsView().tabItem { Label("Sessions", systemImage: "list.bullet") }.tag(1)
                    AgentsView().tabItem { Label("Agents", systemImage: "person.2") }.tag(2)
                    SettingsView().tabItem { Label("Settings", systemImage: "gear") }.tag(3)
                }
                .sheet(item: Binding(get: { c.prompts.first }, set: { _ in })) { PromptSheet(p: $0).interactiveDismissDisabled() }
            }
        }
        .alert("Error", isPresented: Binding(get: { c.error != nil }, set: { if !$0 { c.error = nil } })) { Button("OK") {} } message: { Text(c.error ?? "") }
    }
}

/// Small connection badge shown in navigation bars.
struct ConnBadge: View {
    @EnvironmentObject var c: Client
    var body: some View {
        Circle().fill(c.state == .connected ? .green : c.state == .off ? .red : .orange).frame(width: 9, height: 9)
            .accessibilityLabel(Text(LocalizedStringKey(c.state.rawValue)))
    }
}

// MARK: - Pairing

struct PairView: View {
    @EnvironmentObject var c: Client
    @State private var scanning = false
    @State private var pasted = ""
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button { scanning = true } label: { Label("Scan QR code", systemImage: "qrcode.viewfinder") }
                } footer: { Text("On your Mac run the DSH Mobile gateway, open its admin page and scan the code. The Mac must approve this iPhone.") }
                Section("Or paste the pairing code") {
                    TextField("{\"v\":1,…}", text: $pasted, axis: .vertical).font(.caption.monospaced()).autocorrectionDisabled().textInputAutocapitalization(.never)
                    Button("Pair") { use(pasted) }.disabled(pasted.isEmpty)
                }
                if !c.found.isEmpty {
                    Section { ForEach(Array(c.found.values)) { f in LabeledContent(f.name, value: "\(f.host):\(f.port)") } }
                    header: { Text("Macs on this network") } footer: { Text("Pairing still needs the QR code: it carries the certificate fingerprint and one-time code.") }
                }
                if let s = c.pairingStatus { Section { HStack { ProgressView(); Text(s) } } }
            }
            .navigationTitle("Pair with Mac")
            .sheet(isPresented: $scanning) {
                QRScanner { s in scanning = false; use(s) }.ignoresSafeArea()
            }
        }
    }
    func use(_ s: String) {
        guard let inv = parseInvite(s) else { c.error = String(localized: "That is not a valid DSH pairing code for a local network."); return }
        Task { await c.pair(inv) }
    }
}

struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    func makeCoordinator() -> Coord { Coord(onCode) }
    func makeUIViewController(context: Context) -> UIViewController {
        let vc = UIViewController(), s = context.coordinator.session
        vc.view.backgroundColor = .black
        guard let dev = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: dev), s.canAddInput(input) else {
            let l = UILabel(); l.text = String(localized: "Camera unavailable. Paste the pairing code instead."); l.textColor = .white; l.numberOfLines = 0; l.textAlignment = .center
            l.frame = vc.view.bounds.insetBy(dx: 24, dy: 0); l.autoresizingMask = [.flexibleWidth, .flexibleHeight]; vc.view.addSubview(l)
            return vc
        }
        s.addInput(input)
        let out = AVCaptureMetadataOutput(); s.addOutput(out)
        out.setMetadataObjectsDelegate(context.coordinator, queue: .main); out.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: s); layer.videoGravity = .resizeAspectFill; layer.frame = UIScreen.main.bounds
        vc.view.layer.addSublayer(layer)
        DispatchQueue.global().async { s.startRunning() }
        return vc
    }
    func updateUIViewController(_ vc: UIViewController, context: Context) {}
    static func dismantleUIViewController(_ vc: UIViewController, coordinator: Coord) { coordinator.session.stopRunning() }
    final class Coord: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let session = AVCaptureSession(), onCode: (String) -> Void
        var done = false
        init(_ f: @escaping (String) -> Void) { onCode = f }
        func metadataOutput(_ o: AVCaptureMetadataOutput, didOutput objs: [AVMetadataObject], from: AVCaptureConnection) {
            guard !done, let s = (objs.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            done = true; UINotificationFeedbackGenerator().notificationOccurred(.success); onCode(s)
        }
    }
}

// MARK: - Conversation

struct ConversationView: View {
    @EnvironmentObject var c: Client
    @State private var text = ""
    @State private var picks: [PhotosPickerItem] = []
    @State private var images: [Data] = []
    @FocusState private var focused: Bool
    var body: some View {
        NavigationStack {
            Group {
                if c.current == nil {
                    ContentUnavailableView { Label("No session", systemImage: "bubble.left") } description: { Text("Pick or create a session.") } actions: {
                        Button("Sessions") { c.tab = 1 }
                    }
                } else { transcript }
            }
            .navigationTitle(c.currentSess?.title ?? String(localized: "Conversation"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ConnBadge() }
                if c.current != nil { ToolbarItem(placement: .topBarTrailing) { ModelMenu() } }
            }
        }
    }

    var transcript: some View {
        ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(c.transcript) { LineView(line: $0) }
                        if !c.streaming.isEmpty { LineView(line: Line(kind: .assistant, text: c.streaming)) }
                        if c.running && c.streaming.isEmpty { ProgressView().padding(.leading) }
                        Color.clear.frame(height: 1).id("end")
                    }.padding()
                }
                .scrollDismissesKeyboard(.interactively)
                // composer pinned via safeAreaInset so keyboard/tab switches never leave it floating mid-screen
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(spacing: 0) {
                        if let u = c.usage { Text(usageText(u)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary).padding(.horizontal) }
                        composer
                    }.background(.bar)
                }
                .onChange(of: c.transcript.count) { proxy.scrollTo("end") }
                .onChange(of: c.streaming) { proxy.scrollTo("end") }
        }
    }

    var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !images.isEmpty {
                ScrollView(.horizontal) { HStack { ForEach(images.indices, id: \.self) { i in
                    Image(uiImage: UIImage(data: images[i]) ?? UIImage()).resizable().scaledToFill().frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(alignment: .topTrailing) { Button { images.remove(at: i) } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Remove image") }
                } } }
            }
            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(selection: $picks, maxSelectionCount: 4, matching: .images) { Image(systemName: "photo").imageScale(.large) }
                    .accessibilityLabel("Attach image")
                TextField("Message", text: $text, axis: .vertical).lineLimit(1...6).focused($focused)
                    .padding(8).background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
                if c.running {
                    Button { c.run { try await c.stop() } } label: { Image(systemName: "stop.circle.fill").font(.title) }.accessibilityLabel("Stop")
                } else {
                    Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.title) }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty).accessibilityLabel("Send")
                }
            }
        }
        .padding(8)
        .onChange(of: picks) { _, items in
            Task {
                for it in items { if let d = try? await it.loadTransferable(type: Data.self), let j = jpeg(d) { images.append(j) } }
                picks = []
            }
        }
    }

    func send() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines), imgs = images
        text = ""; images = []
        c.run { try await c.prompt(t, images: imgs) }
    }

    /// Downscale to 1600 px and JPEG-encode so a photo stays well under the gateway's 16 MB body cap.
    func jpeg(_ d: Data) -> Data? {
        guard let img = UIImage(data: d) else { return nil }
        let s = min(1, 1600 / max(img.size.width, img.size.height))
        let size = CGSize(width: img.size.width * s, height: img.size.height * s)
        return UIGraphicsImageRenderer(size: size).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }.jpegData(compressionQuality: 0.7)
    }
}

struct LineView: View {
    let line: Line
    var body: some View {
        switch line.kind {
        case .user:
            HStack { Spacer(minLength: 40); Text(line.text).textSelection(.enabled).padding(10).background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 14)) }
        case .assistant: Markdown(text: line.text)
        case .tool: Label(line.text, systemImage: "wrench.and.screwdriver").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(3)
        case .result: Text(line.text).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(6).padding(.leading, 24)
        case .error: Label(line.text, systemImage: "exclamationmark.triangle").font(.caption.monospaced()).foregroundStyle(.red).lineLimit(6)
        }
    }
}

/// Inline Markdown via AttributedString; fenced code blocks get a monospaced box with a Copy button.
struct Markdown: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(mdBlocks(text).enumerated()), id: \.offset) { _, b in
                if b.code {
                    VStack(alignment: .trailing, spacing: 4) {
                        Button { UIPasteboard.general.string = b.text; UIImpactFeedbackGenerator(style: .light).impactOccurred() } label: { Label("Copy", systemImage: "doc.on.doc").font(.caption) }
                        ScrollView(.horizontal) { Text(b.text).font(.caption.monospaced()).textSelection(.enabled) }
                    }
                    .padding(8).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                } else {
                    Text((try? AttributedString(markdown: b.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(b.text))
                        .textSelection(.enabled)
                }
            }
        }
    }
}

struct ModelMenu: View {
    @EnvironmentObject var c: Client
    var body: some View {
        Menu {
            ForEach(c.catalog) { g in
                Section(g.name) {
                    ForEach(g.models) { m in
                        if m.efforts.isEmpty { Button(m.name) { c.run { try await c.selectModel(g.id, m.id, nil) } } }
                        else { Menu(m.name) { ForEach(m.efforts, id: \.self) { e in Button(e) { c.run { try await c.selectModel(g.id, m.id, e) } } } } }
                    }
                }
            }
            if c.catalog.isEmpty { Text("Loading models…") }
        } label: { Label(c.model ?? String(localized: "Model"), systemImage: "cpu").labelStyle(.titleAndIcon).font(.caption) }
        .onAppear { if c.catalog.isEmpty { c.run { try await c.loadCatalog() } } }
    }
}

// MARK: - Sessions

struct SessionsView: View {
    @EnvironmentObject var c: Client
    @State private var query = ""
    @State private var hits: [Hit] = []
    @State private var creating = false
    @State private var renaming: Sess?
    @State private var newTitle = ""
    var body: some View {
        NavigationStack {
            List {
                if query.isEmpty {
                    ForEach(c.sessions.filter { $0.parent == nil }) { s in
                        Button { open(s.id) } label: { row(s) }
                            .swipeActions { Button("Rename") { renaming = s; newTitle = s.title }.tint(.blue) }
                            .contextMenu { Button("Rename") { renaming = s; newTitle = s.title } }
                    }
                } else {
                    ForEach(hits) { h in
                        Button { open(h.session) } label: { VStack(alignment: .leading) { Text(c.title(h.session)); Text(h.snippet).font(.caption).foregroundStyle(.secondary).lineLimit(2) } }
                    }
                }
            }
            .overlay { if c.sessions.isEmpty && query.isEmpty { ContentUnavailableView("No sessions", systemImage: "tray") } }
            .searchable(text: $query, prompt: "Search sessions")
            .onSubmit(of: .search) { let q = query; c.run { hits = try await c.search(q) } }
            .refreshable { try? await c.loadSessions() }
            .navigationTitle("Sessions")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ConnBadge() }
                ToolbarItem(placement: .topBarTrailing) { Button { creating = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New session") }
            }
            .sheet(isPresented: $creating) { NewSessionSheet() }
            .alert("Rename session", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Title", text: $newTitle)
                Button("Save") { if let s = renaming { let t = newTitle; c.run { try await c.rename(s.id, t) } } }
                Button("Cancel", role: .cancel) {}
            }
        }
    }
    func row(_ s: Sess) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(s.title).foregroundStyle(.primary).lineLimit(1)
                Text(s.cwd).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            }
            Spacer()
            if s.running { ProgressView() }
            if s.id == c.current { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
        }
    }
    func open(_ id: String) { c.follow(id); c.tab = 0 }
}

/// Pick an existing project (folder of a past session) or type a path.
struct NewSessionSheet: View {
    @EnvironmentObject var c: Client
    @Environment(\.dismiss) var dismiss
    @State private var custom = ""
    // shortcut: projects = folders of the loaded session page, add a workspace RPC if DSH ever exposes one
    var projects: [String] { var seen = Set<String>(); return c.sessions.map(\.cwd).filter { !$0.isEmpty && seen.insert($0).inserted } }
    var body: some View {
        NavigationStack {
            List {
                Section { Button("DSH default workspace") { create(nil) } }
                if !projects.isEmpty {
                    Section("Projects") {
                        ForEach(projects, id: \.self) { p in
                            Button { create(p) } label: {
                                VStack(alignment: .leading) { Text((p as NSString).lastPathComponent).foregroundStyle(.primary); Text(p).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head) }
                            }
                        }
                    }
                }
                Section("Other folder on Mac") {
                    TextField("/Users/…/project", text: $custom).autocorrectionDisabled().textInputAutocapitalization(.never).onSubmit { create(custom) }
                    Button("Create") { create(custom) }.disabled(custom.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .navigationTitle("New session").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
    func create(_ cwd: String?) {
        let d = cwd?.trimmingCharacters(in: .whitespaces)
        dismiss(); c.run { try await c.create(cwd: d) }
    }
}

// MARK: - Agents

struct AgentsView: View {
    @EnvironmentObject var c: Client
    @State private var objective = ""
    var body: some View {
        NavigationStack {
            List {
                if let s = c.currentSess {
                    Section("Agent preset") {
                        ForEach(c.presets) { p in
                            Button { c.run { try await c.selectPreset(p.id) } } label: {
                                HStack {
                                    VStack(alignment: .leading) { Text(p.name); if let d = p.desc { Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2) } }
                                    Spacer(); if s.preset == p.id { Image(systemName: "checkmark") }
                                }
                            }.disabled(p.broken)
                        }
                    }
                    Section("Goal") {
                        if let g = c.goal {
                            Text(g.objective)
                            LabeledContent("Status", value: g.phase)
                            LabeledContent("Rounds", value: g.max > 0 ? "\(g.rounds)/\(g.max)" : "\(g.rounds)")
                            if let b = g.blocked { Text(b).font(.caption).foregroundStyle(.orange) }
                            HStack {
                                Button("Pause") { act("pause") }; Button("Resume") { act("resume") }
                                Button("Complete") { act("complete") }; Button("Clear", role: .destructive) { act("clear") }
                            }.buttonStyle(.bordered).font(.caption)
                        } else {
                            TextField("Objective", text: $objective, axis: .vertical)
                            Button("Start goal") { let o = objective; objective = ""; c.run { try await c.createGoal(o) } }.disabled(objective.isEmpty)
                        }
                    }
                    Section("Subagents") {
                        let kids = c.sessions.filter { $0.parent == s.id }
                        if kids.isEmpty { Text("None").foregroundStyle(.secondary) }
                        ForEach(kids) { k in
                            HStack {
                                Text(k.title).lineLimit(1); Spacer()
                                if k.running {
                                    ProgressView()
                                    Button { c.run { try await c.interrupt(k) } } label: { Image(systemName: "stop.circle") }.accessibilityLabel("Interrupt").buttonStyle(.borderless)
                                }
                            }
                        }
                    }
                } else {
                    ContentUnavailableView("No session", systemImage: "person.2", description: Text("Open a session to manage its agents."))
                }
            }
            .navigationTitle("Agents")
            .toolbar { ToolbarItem(placement: .topBarLeading) { ConnBadge() } }
            .refreshable { await c.loadAgents() }
            .task(id: c.current) { await c.loadAgents() }
        }
    }
    func act(_ v: String) { c.run { try await c.goalAction(v) } }
}

// MARK: - Settings

struct SettingsView: View {
    @EnvironmentObject var c: Client
    @State private var host = ""
    @State private var port = ""
    @State private var confirmUnpair = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    LabeledContent("Status") { HStack { ConnBadge(); Text(LocalizedStringKey(c.state.rawValue)) } }
                    LabeledContent("DSH on Mac", value: c.upstream.isEmpty ? "—" : c.upstream)
                    if let p = c.pairing {
                        LabeledContent("Address", value: "\(p.host):\(p.port)")
                        LabeledContent("Certificate", value: String(p.fp.prefix(16)) + "…").font(.caption.monospaced())
                    }
                    Button("Reconnect") { c.reconnect() }
                }
                Section {
                    TextField("IP address", text: $host).keyboardType(.decimalPad)
                    TextField("Port", text: $port).keyboardType(.numberPad)
                    Button("Use this address") { c.setAddress(host, Int(port)) }.disabled(host.isEmpty)
                } header: { Text("Manual address") } footer: { Text("Only needed if the Mac's IP changed and Bonjour cannot find it. The pinned certificate is still required.") }
                if let p = c.pairing {
                    Section("This iPhone") {
                        LabeledContent("Name", value: p.name)
                        LabeledContent("Token expires", value: (try? Date(p.expiresAt, strategy: .iso8601))?.formatted(date: .abbreviated, time: .shortened) ?? p.expiresAt)
                        Button("Unpair", role: .destructive) { confirmUnpair = true }
                    }
                }
            }
            .navigationTitle("Settings")
            .onAppear { if let p = c.pairing { host = p.host; port = "\(p.port)" } }
            .confirmationDialog("Unpair this iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) { c.forget() }
            } message: { Text("The token is deleted from this iPhone. Also revoke it on the Mac to invalidate it there.") }
        }
    }
}

// MARK: - Approvals and questions (waterfall prompts)

struct PromptSheet: View {
    @EnvironmentObject var c: Client
    let p: Prompt
    @State private var picked: [String: Set<String>] = [:]
    @State private var custom: [String: String] = [:]
    var body: some View {
        NavigationStack {
            Form {
                if let a = p.agentId { LabeledContent("Session", value: c.title(a)) }
                if p.event == "approval/request" {
                    Section("Tool") {
                        Text(p.request["toolName"] as? String ?? "?").font(.headline.monospaced())
                        if let r = ((p.request["displayReason"] as? J)?["en"] as? String) ?? p.request["reason"] as? String { Text(r) }
                    }
                    Section {
                        Button("Allow once") { send("allowed-once") }.bold()
                        Button("Deny", role: .destructive) { send("rejected") }
                    }
                } else {
                    ForEach(Question.parse(p.request)) { q in
                        Section {
                            Text(q.question).bold()
                            if let d = q.detail { Text(d).font(.caption).foregroundStyle(.secondary) }
                            ForEach(q.options) { o in
                                Button { toggle(q, o.label) } label: {
                                    HStack {
                                        VStack(alignment: .leading) { Text(o.label); if let d = o.desc { Text(d).font(.caption).foregroundStyle(.secondary) } }
                                        Spacer(); if picked[q.id, default: []].contains(o.label) { Image(systemName: "checkmark") }
                                    }
                                }
                            }
                            TextField("Other answer", text: Binding(get: { custom[q.id] ?? "" }, set: { custom[q.id] = $0 }))
                        } header: { if let h = q.header { Text(h) } }
                    }
                    Section { Button("Send answer") { sendAnswers() }.bold() }
                }
                Section { Button("Decide on Mac") { c.run { try await c.answer(p, nil) } } } footer: { Text("Hands this prompt back to the DSH window on your Mac.") }
            }
            .navigationTitle(p.event == "approval/request" ? "Approval needed" : "Question")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
    func toggle(_ q: Question, _ l: String) {
        var s = picked[q.id, default: []]
        if s.contains(l) { s.remove(l) } else { if !q.multi { s = [] }; s.insert(l) }
        picked[q.id] = s; UISelectionFeedbackGenerator().selectionChanged()
    }
    func send(_ v: String) { c.run { try await c.answer(p, v) } }
    func sendAnswers() {
        let a: [J] = Question.parse(p.request).map { q in
            var item: J = ["id": q.id, "selected": Array(picked[q.id, default: []])]
            if let t = custom[q.id]?.trimmingCharacters(in: .whitespaces), !t.isEmpty { item["custom"] = t }
            return item
        }
        c.run { try await c.answer(p, ["answers": a]) }
    }
}

