// Tether views. State and networking live in Core.swift (Client).
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
                TabView {
                    SessionsView().tabItem { Label("Sessions", systemImage: "bubble.left.and.bubble.right") }
                    AgentsView().tabItem { Label("Agents", systemImage: "person.2") }
                    SettingsView().tabItem { Label("Settings", systemImage: "gear") }
                }
                .sheet(item: Binding(get: { c.prompts.first }, set: { _ in })) { PromptSheet(p: $0).interactiveDismissDisabled() }
            }
        }
        // every Form/List/ScrollView: dragging the content closes the keyboard
        .scrollDismissesKeyboard(.interactively)
        // non-blocking: errors are mostly transient (link drops, busy session), so a toast beats a modal that stalls the screen
        .overlay(alignment: .top) {
            if let e = c.error {
                Label(e, systemImage: "exclamationmark.circle.fill").font(.footnote).foregroundStyle(.primary)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule()).shadow(color: .black.opacity(0.12), radius: 8, y: 2)
                    .padding(.horizontal, 16).padding(.top, 6)
                    .onTapGesture { c.error = nil }
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: e) { try? await Task.sleep(for: .seconds(5)); if c.error == e { c.error = nil } }
                    .accessibilityAddTraits(.isStaticText).accessibilityHint(Text("Tap to dismiss"))
            }
        }
        .animation(.snappy, value: c.error)
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

/// Says what is wrong with the link to the Mac, with a retry. Empty when all is well.
struct ConnBanner: View {
    @EnvironmentObject var c: Client
    var body: some View {
        // first connect stays quiet (badge shows it); only a lost link earns a banner
        let lost = lostHint(onWiFi: c.onWiFi, hasTailnet: c.pairing?.ts != nil)
        let msg = c.upstreamText ?? (c.state == .connected || c.state == .connecting ? nil : lost)
        if let msg {
            HStack(spacing: 10) {
                if c.state == .reconnecting { ProgressView().controlSize(.small) } else { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                Text(msg).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
                Button("Retry") { c.reconnect() }.font(.footnote.bold()).buttonStyle(.borderless)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 12).padding(.top, 4)
            .accessibilityElement(children: .combine)
        }
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
                } footer: { Text("Where's the code? On your Mac, with DSH running, open http://127.0.0.1:19391 in a browser. The QR code is on that page; after scanning, click Approve there.") }
                Section("Or paste the pairing code") {
                    TextField("{\"v\":1,…}", text: $pasted, axis: .vertical).font(.caption.monospaced()).autocorrectionDisabled().textInputAutocapitalization(.never)
                    Button("Pair") { use(pasted) }.disabled(pasted.isEmpty)
                }
                if !c.found.isEmpty {
                    Section { ForEach(Array(c.found.values)) { f in
                        Button { scanning = true } label: { LabeledContent { Image(systemName: "qrcode.viewfinder") } label: { Label(f.name, systemImage: "laptopcomputer") } }
                    } }
                    header: { Text("Macs on this network") } footer: { Text("Tap to scan that Mac's QR code. It carries the certificate fingerprint and one-time code.") }
                }
                if let s = c.pairingStatus {
                    Section {
                        HStack(spacing: 12) { ProgressView(); Text(s).bold() }
                    } footer: { Text("Click Approve on your Mac's Tether page. The request expires after 2 minutes.") }
                }
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
        // preview view's own layer resizes with the sheet, unlike a sublayer sized once to the screen
        let pv = PreviewView(); pv.layer.session = s; pv.layer.videoGravity = .resizeAspectFill; vc.view = pv
        DispatchQueue.global().async { s.startRunning() }
        return vc
    }
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        override var layer: AVCaptureVideoPreviewLayer { super.layer as! AVCaptureVideoPreviewLayer }
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

// MARK: - Conversation (pushed from Sessions, so the system back button / edge swipe always leads out)

struct ConversationView: View {
    @EnvironmentObject var c: Client
    @State private var text = ""
    @State private var picks: [PhotosPickerItem] = []
    @State private var images: [Data] = []
    @State private var atBottom = true
    @State private var creating = false
    @FocusState private var focused: Bool
    var body: some View {
        transcript
            .safeAreaInset(edge: .top) { ConnBanner() }
            .navigationTitle(c.currentSess?.title ?? String(localized: "Conversation"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .tabBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { ConnBadge() }
                ToolbarItem(placement: .topBarTrailing) { Button { creating = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New session") }
            }
            .sheet(isPresented: $creating) { NewSessionSheet() }
    }

    var transcript: some View {
        ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(c.transcript) { LineView(line: $0) }
                        if !c.reasoning.isEmpty { LineView(line: Line(kind: .reasoning, text: c.reasoning), live: true) }
                        if !c.streaming.isEmpty { LineView(line: Line(kind: .assistant, text: c.streaming)) }
                        if c.running && c.streaming.isEmpty && c.reasoning.isEmpty {
                            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Working…") }.font(.footnote).foregroundStyle(.secondary)
                        }
                        // shortcut: 80 pt tall marker pulled up over the content = "near bottom" tolerance, so a streaming delta never flips atBottom off; use onScrollGeometryChange once iOS 18 is the floor.
                        Color.clear.frame(height: 80).padding(.top, -80).id("end")
                            .onAppear { atBottom = true }.onDisappear { atBottom = false }
                    }.padding(.horizontal, 16).padding(.vertical, 12)
                }
                // tapping the transcript closes the keyboard; simultaneous so links/selection keep working
                .simultaneousGesture(TapGesture().onEnded { focused = false })
                .defaultScrollAnchor(.bottom)
                .overlay { if c.transcript.isEmpty && !c.running { emptyState } }
                .overlay(alignment: .bottomTrailing) {
                    if !atBottom && !c.transcript.isEmpty {
                        Button { withAnimation { proxy.scrollTo("end", anchor: .bottom) } } label: {
                            Image(systemName: "arrow.down").font(.footnote.weight(.semibold)).frame(width: 34, height: 34)
                                .background(.regularMaterial, in: Circle()).overlay(Circle().strokeBorder(Color(.separator)))
                        }
                        .buttonStyle(.plain).padding(12).accessibilityLabel("Scroll to bottom")
                    }
                }
                .scrollDismissesKeyboard(.interactively)
                // composer pinned via safeAreaInset so keyboard/tab switches never leave it floating mid-screen
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(spacing: 0) {
                        if !suggestions.isEmpty { suggestionList }
                        composer
                        statusLine
                    }.background(.background)
                }
                // only follow output while the user is at the bottom, so reading history is not yanked away
                .onChange(of: c.transcript.count) { if atBottom { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: c.streaming) { if atBottom { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: c.reasoning) { if atBottom { proxy.scrollTo("end", anchor: .bottom) } }
        }
    }

    var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "sparkles").font(.largeTitle).foregroundStyle(.secondary)
            Text(c.shownModel ?? String(localized: "Model")).font(.headline)
            if let cwd = c.currentSess?.cwd, !cwd.isEmpty { Text(cwd).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head) }
            Text("Type / for commands").font(.caption).foregroundStyle(.tertiary)
        }.padding().allowsHitTesting(false)
    }

    /// Model · context % · token usage, like the desktop status bar.
    var statusLine: some View {
        let ctx = c.currentSess?.context.map { "ctx \(Int(($0 * 100).rounded()))%" }
        let parts = [c.shownModel, ctx, c.usage.map(usageText)].compactMap { $0 }.filter { !$0.isEmpty }
        return Text(parts.joined(separator: " · ")).font(.caption2.monospacedDigit()).foregroundStyle(.tertiary).lineLimit(1).padding(.horizontal).padding(.bottom, 4)
    }

    var suggestions: [Cmd] {
        guard text.hasPrefix("/"), !text.contains(" ") else { return [] }
        let q = text.dropFirst().lowercased()
        return c.commands.filter { q.isEmpty || $0.name.lowercased().hasPrefix(q) }
    }

    var suggestionList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(suggestions) { cmd in
                    Button { text = "/\(cmd.name) " } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("/\(cmd.name)").font(.callout.monospaced()) + Text(cmd.hint.map { "  \($0)" } ?? "").font(.caption).foregroundColor(.secondary)
                            if !cmd.desc.isEmpty { Text(cmd.desc).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal).padding(.vertical, 6).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    Divider()
                }
            }
        }.frame(maxHeight: 220).background(.bar)
    }

    var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty }

    /// Codex-style card: text on top, attach · model chip · send/stop on one row below.
    var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !images.isEmpty {
                ScrollView(.horizontal) { HStack { ForEach(images.indices, id: \.self) { i in
                    Image(uiImage: UIImage(data: images[i]) ?? UIImage()).resizable().scaledToFill().frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(alignment: .topTrailing) { Button { images.remove(at: i) } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Remove image") }
                } } }
            }
            TextField("Ask DeepSeek", text: $text, axis: .vertical).lineLimit(1...6).focused($focused).padding(.horizontal, 4)
            HStack(spacing: 10) {
                PhotosPicker(selection: $picks, maxSelectionCount: 4, matching: .images) {
                    Image(systemName: "plus").font(.body.weight(.medium)).frame(width: 32, height: 32).background(Color(.tertiarySystemFill), in: Circle())
                }
                .buttonStyle(.plain)
                    .accessibilityLabel("Attach image")
                ModelMenu()
                Spacer(minLength: 0)
                if c.running && canSend { roundButton("arrow.up", action: send).accessibilityLabel("Send now") }
                if c.running { roundButton("stop.fill") { c.run { try await c.stop() } }.accessibilityLabel("Stop") }
                else { roundButton("arrow.up", action: send).disabled(!canSend).accessibilityLabel("Send") }
            }
        }
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color(.separator).opacity(0.6)))
        .padding(.horizontal, 10).padding(.vertical, 6)
        .onChange(of: picks) { _, items in
            Task {
                for it in items { if let d = try? await it.loadTransferable(type: Data.self), let j = jpeg(d) { images.append(j) } }
                picks = []
            }
        }
    }

    func roundButton(_ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 14, weight: .bold)).foregroundStyle(Color(.systemBackground))
                .frame(width: 32, height: 32).background(Color.primary, in: Circle())
        }
        .buttonStyle(.plain).opacity(canSend || c.running ? 1 : 0.3)
    }

    func send() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines), imgs = images
        text = ""; images = []
        let name = t.hasPrefix("/") ? String(t.dropFirst().prefix { !$0.isWhitespace }) : ""
        // a failed send (link down, Mac asleep) puts the draft back instead of losing it
        let restore = { if text.isEmpty && images.isEmpty { text = t; images = imgs } }
        if imgs.isEmpty, c.commands.contains(where: { $0.name == name }) {
            c.run { do { try await c.execute(t) } catch { restore(); throw error } }; return
        }
        atBottom = true
        let steer = c.running
        c.run { do { try await c.prompt(t, images: imgs, steer: steer) } catch { restore(); throw error } }
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
    @EnvironmentObject var c: Client
    let line: Line
    var live = false
    @State private var open = false
    var body: some View {
        content.contextMenu {
            Button { UIPasteboard.general.string = line.text } label: { Label("Copy", systemImage: "doc.on.doc") }
            if line.kind == .user {
                Button { let t = line.text; c.run { try await c.prompt(t, images: [], steer: c.running) } } label: { Label("Resend", systemImage: "arrow.clockwise") }
            }
        }
    }
    @ViewBuilder var content: some View {
        switch line.kind {
        case .user:
            HStack { Spacer(minLength: 48); Text(line.text).textSelection(.enabled).padding(.horizontal, 14).padding(.vertical, 10).background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 18, style: .continuous)) }
        case .assistant: Markdown(text: line.text).frame(maxWidth: .infinity, alignment: .leading)
        case .reasoning:
            DisclosureGroup(isExpanded: $open) {
                Text(line.text).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 10).overlay(alignment: .leading) { Rectangle().fill(Color(.separator)).frame(width: 2) }
            } label: {
                Text(live ? String(localized: "Thinking…") : String(localized: "Thought")).font(.footnote).foregroundStyle(.secondary)
            }
            .tint(.secondary)
        case .command: Label(line.text, systemImage: "chevron.right").font(.footnote.monospaced()).foregroundStyle(.secondary)
        case .tool: tap(Label(line.text, systemImage: "terminal").font(.footnote.monospaced()).foregroundStyle(.secondary), 2)
        case .result: tap(Text(line.text).font(.caption.monospaced()).foregroundStyle(.secondary).padding(8)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous)), 6)
        case .error: tap(Label(line.text, systemImage: "exclamationmark.triangle").font(.caption.monospaced()).foregroundStyle(.red), 6)
        }
    }
    /// Long tool output stays collapsed until tapped.
    func tap(_ v: some View, _ n: Int) -> some View {
        v.lineLimit(open ? nil : n).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle()).onTapGesture { withAnimation { open.toggle() } }
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
                    .padding(10).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color(.separator).opacity(0.5)))
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(b.text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, l in MdLineView(line: mdLine(l)) }
                    }.textSelection(.enabled)
                }
            }
        }
    }
}

struct MdLineView: View {
    let line: MdLine
    func inline(_ s: String) -> Text { Text((try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)) }
    var body: some View {
        switch line {
        case .heading(let n, let s): inline(s).font(n == 1 ? .title3.bold() : n == 2 ? .headline : .subheadline.bold()).padding(.top, 4).accessibilityAddTraits(.isHeader)
        case .bullet(let i, let s): HStack(alignment: .firstTextBaseline, spacing: 8) { Text(i == 0 ? "•" : "◦").foregroundStyle(.secondary); inline(s) }.padding(.leading, CGFloat(i) * 16)
        case .number(let i, let n, let s): HStack(alignment: .firstTextBaseline, spacing: 6) { Text("\(n).").monospacedDigit().foregroundStyle(.secondary); inline(s) }.padding(.leading, CGFloat(i) * 16)
        case .quote(let s): inline(s).foregroundStyle(.secondary).padding(.leading, 10).overlay(alignment: .leading) { Capsule().fill(Color(.separator)).frame(width: 3) }
        case .rule: Divider().padding(.vertical, 4)
        case .blank: Color.clear.frame(height: 2)
        case .text(let s): inline(s)
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
        } label: {
            HStack(spacing: 3) { Text(c.shownModel ?? String(localized: "Model")).lineLimit(1); Image(systemName: "chevron.down").imageScale(.small) }
                .font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                .padding(.horizontal, 10).frame(height: 32).background(Color(.tertiarySystemFill), in: Capsule())
        }
        .accessibilityLabel(Text("Model"))
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
        NavigationStack(path: $c.path) {
            List {
                // in-list so it scrolls away with the content instead of pinning under the large title
                Section { ConnBanner().listRowInsets(EdgeInsets()).listRowBackground(Color.clear) }
                if query.isEmpty {
                    // offset id: two DSH workspaces may share a title
                    ForEach(Array(c.sessionGroups().enumerated()), id: \.offset) { _, g in
                        Section(g.title) {
                            ForEach(g.items) { s in
                                Button { open(s.id) } label: { row(s) }
                                    .swipeActions(edge: .leading) { Button { c.run { try await c.togglePin(s.id) } } label: { Label(pinLabel(s), systemImage: "pin") }.tint(.orange) }
                                    .swipeActions {
                                        Button { c.run { try await c.toggleArchive(s.id) } } label: { Label(archiveLabel(s), systemImage: "archivebox") }.tint(.gray)
                                        Button { renaming = s; newTitle = s.title } label: { Label("Rename", systemImage: "pencil") }.tint(.blue)
                                    }
                                    .contextMenu {
                                        Button { c.run { try await c.togglePin(s.id) } } label: { Label(pinLabel(s), systemImage: "pin") }
                                        Button { renaming = s; newTitle = s.title } label: { Label("Rename", systemImage: "pencil") }
                                        Button { c.run { try await c.fork(s.id) } } label: { Label("Fork", systemImage: "arrow.triangle.branch") }
                                        Button { c.run { try await c.toggleArchive(s.id) } } label: { Label(archiveLabel(s), systemImage: "archivebox") }
                                    }
                            }
                        }
                    }
                } else {
                    ForEach(hits) { h in
                        Button { open(h.session) } label: { VStack(alignment: .leading) { Text(c.title(h.session)); Text(h.snippet).font(.caption).foregroundStyle(.secondary).lineLimit(2) } }
                    }
                }
            }
            .overlay { if c.sessions.isEmpty && query.isEmpty {
                ContentUnavailableView { Label("No sessions", systemImage: "tray") } actions: { Button("New session") { creating = true }.buttonStyle(.borderedProminent) }
            } }
            .searchable(text: $query, prompt: "Search sessions")
            .onSubmit(of: .search) { let q = query; c.run { hits = try await c.search(q) } }
            .refreshable { try? await c.loadSessions() }
            .navigationTitle("Sessions")
            .navigationDestination(for: String.self) { _ in ConversationView() }
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
                HStack(spacing: 4) {
                    if c.pinned.contains(s.id) { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange) }
                    Text(s.title).foregroundStyle(.primary).lineLimit(1)
                }
                Text([s.model, (s.cwd as NSString).lastPathComponent].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if s.running { Circle().fill(.green).frame(width: 8, height: 8).accessibilityLabel("Running") }
            if s.id == c.current { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
        }
    }
    func pinLabel(_ s: Sess) -> String { c.pinned.contains(s.id) ? String(localized: "Unpin") : String(localized: "Pin") }
    func archiveLabel(_ s: Sess) -> String { c.archived.contains(s.id) ? String(localized: "Unarchive") : String(localized: "Archive") }
    func open(_ id: String) { c.follow(id); c.path = [id] }
}

/// Pick a DSH project (workspace), a folder of a past session, or type a path.
struct NewSessionSheet: View {
    @EnvironmentObject var c: Client
    @Environment(\.dismiss) var dismiss
    @State private var custom = ""
    // shortcut: extra folders come from the loaded session page only; fine until users have >1 page of sessions.
    var projects: [String] { var seen = Set(c.workspaces.map(\.path)); return c.sessions.map(\.cwd).filter { !$0.isEmpty && seen.insert($0).inserted } }
    var body: some View {
        NavigationStack {
            List {
                Section { Button("DSH default workspace") { create(nil) } }
                if !c.workspaces.isEmpty {
                    Section("Projects") {
                        ForEach(c.workspaces) { w in
                            Button { create(w.path, w.id) } label: {
                                VStack(alignment: .leading) { Text(w.title).foregroundStyle(.primary); Text(w.path).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head) }
                            }
                        }
                    }
                }
                if !projects.isEmpty {
                    Section("Recent folders") {
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
    func create(_ cwd: String?, _ workspace: String? = nil) {
        let d = cwd?.trimmingCharacters(in: .whitespaces)
        dismiss(); c.run { try await c.create(cwd: d, workspaceId: workspace) }
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
                    LabeledContent("DSH on Mac", value: c.upstream.isEmpty ? "—" : c.upstreamText ?? String(localized: "Running"))
                    if let p = c.pairing {
                        LabeledContent("Local network", value: "\(p.host):\(p.port)")
                        LabeledContent("Tailscale", value: p.ts.map { "\($0):\(p.port)" } ?? "—")
                        LabeledContent("Route", value: c.route == .lan ? String(localized: "Local network") : c.route == .tailscale ? "Tailscale" : "—")
                        if c.state != .connected, let f = c.lastFail { Text(f).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                        LabeledContent("Certificate", value: String(p.fp.prefix(16)) + "…").font(.caption.monospaced())
                    }
                    Button("Reconnect") { c.reconnect() }
                }
                Section {
                    TextField("IP or Tailscale address", text: $host).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Port", text: $port).keyboardType(.numberPad)
                    Button("Use this address") {
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                        // accept "100.x.y.z:19390" pasted into the address field too
                        let parts = host.trimmingCharacters(in: .whitespaces).lowercased().split(separator: ":", maxSplits: 1).map(String.init)
                        c.setAddress(parts.first ?? "", Int(parts.count > 1 ? parts[1] : port))
                    }.disabled(host.isEmpty)
                } header: { Text("Manual address") } footer: { Text("Only needed if the Mac's IP changed and Bonjour cannot find it. A LAN address or the Mac's Tailscale address (100.x or *.ts.net). The pinned certificate is still required.") }
                if let p = c.pairing {
                    Section("This iPhone") {
                        LabeledContent("Name", value: p.name)
                        LabeledContent("Token expires", value: (try? Date(p.expiresAt, strategy: .iso8601))?.formatted(date: .abbreviated, time: .shortened) ?? p.expiresAt)
                        Button("Unpair", role: .destructive) { confirmUnpair = true }
                    }
                }
            }
            .navigationTitle("Settings")
            // number pad has no return key, so give it a Done button
            .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) } } }
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

