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
                // tether://tailscale/<ok|error|cancel>: the Tether Tailscale Shortcut finished and bounced back here
                .onOpenURL { u in if u.scheme == "tether", u.host == "tailscale" { client.tailscaleReturned(u.lastPathComponent) } }
        }
    }
}

struct Root: View {
    @EnvironmentObject var c: Client
    var body: some View {
        Group {
            if c.pairing == nil { PairView() } else {
                TabView(selection: $c.tab) {
                    SessionsView().tabItem { Label("Sessions", systemImage: "bubble.left.and.bubble.right") }.badge(c.finished.count).tag(0)
                    AgentsView().tabItem { Label("Agents", systemImage: "person.2") }.tag(1)
                    SettingsView().tabItem { Label("Settings", systemImage: "gear") }.tag(2)
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

/// Full-screen stand-in while the Mac is unreachable: nothing stale is shown, and off Wi‑Fi the one obvious action is
/// turning Tailscale on (the Shortcut connects it and comes straight back).
struct OfflineView: View {
    @EnvironmentObject var c: Client
    var body: some View {
        let remote = !c.onWiFi && c.pairing?.ts != nil
        ContentUnavailableView {
            Label(c.state == .reconnecting ? "Connecting to your Mac…" : "Not connected", systemImage: remote ? "network.slash" : "wifi.slash")
        } description: {
            Text(c.upstreamText ?? lostHint(onWiFi: c.onWiFi, hasTailnet: c.pairing?.ts != nil))
        } actions: {
            if remote || (!c.onWiFi && c.pairing?.ts == nil) {
                Button { c.openTailscale() } label: { Label("Open Tailscale", systemImage: "point.3.connected.trianglepath.dotted") }
                    .buttonStyle(.borderedProminent)
                if !c.tsReady, c.tailscaleInstalled { TailscaleShortcutLink().font(.footnote) }
            }
            Button("Retry") { c.reconnect() }
        }
    }
}

/// Hands the bundled, signed "Tether Tailscale" Shortcut to the share sheet; picking Shortcuts adds it in one tap.
struct TailscaleShortcutLink: View {
    var body: some View {
        if let u = Bundle.main.url(forResource: tsShortcutName, withExtension: "shortcut") {
            ShareLink(item: u) { Label("Add the Tailscale shortcut", systemImage: "square.and.arrow.down") }
        }
    }
}

/// Says what is wrong with the link to the Mac, with a retry. Empty when all is well.
struct ConnBanner: View {
    @EnvironmentObject var c: Client
    @State private var slow = false
    var body: some View {
        // first connect stays quiet (badge shows it) until it hangs; a lost link earns a banner
        let lost = lostHint(onWiFi: c.onWiFi, hasTailnet: c.pairing?.ts != nil)
        let msg = c.upstreamText ?? (showsLostHint(c.state, slow: slow) ? lost : nil)
        Group { if let msg {
            HStack(spacing: 10) {
                if c.state == .reconnecting { ProgressView().controlSize(.small) } else { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityHidden(true) }
                Text(msg).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
                // off Wi‑Fi the fix is almost always "turn Tailscale on": one tap instead of leaving to find the app
                if c.upstreamText == nil, !c.onWiFi { Button("Tailscale") { c.openTailscale() }.font(.footnote.bold()).buttonStyle(.borderless) }
                Button("Retry") { c.reconnect() }.font(.footnote.bold()).buttonStyle(.borderless)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 12).padding(.top, 4)
            .accessibilityElement(children: .contain) // keep Retry its own VoiceOver target
        } }
        .task(id: c.state) { slow = false; if c.state == .connecting { try? await Task.sleep(for: .seconds(8)); if !Task.isCancelled { slow = true } } }
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
                } footer: { Text(verbatim: String(localized: "Where's the code? In DeepSeek Harness on your Mac, click Mobile connect at the bottom left. Scan the QR code there, then click Approve.")) }
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

/// System camera for attaching a fresh photo to the prompt.
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (Data) -> Void
    @Environment(\.dismiss) private var dismiss
    func makeCoordinator() -> Delegate { Delegate(self) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController(); p.sourceType = .camera; p.delegate = context.coordinator; return p
    }
    func updateUIViewController(_ p: UIImagePickerController, context: Context) {}
    final class Delegate: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ p: CameraPicker) { parent = p }
        func imagePickerController(_ p: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let d = (info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.9) { parent.onImage(d) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ p: UIImagePickerController) { parent.dismiss() }
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
    @State private var preview: UIImage?
    @State private var files: [Attachment] = []
    @State private var importing = false
    @State private var showPhotos = false
    @State private var shooting = false
    @State private var atBottom = true
    @State private var creating = false
    @State private var editing: J?
    @State private var editText = ""
    @State private var showTodos = false
    @State private var renaming = false
    @State private var newTitle = ""
    @State private var goalEditing = false
    @State private var goalText = ""
    @State private var confirmClearGoal = false
    @State private var loadingOlder = false
    @State private var showUsage = false
    // fallback only: used when the turn/start event carried no time
    @State private var turnStart: Date?
    @FocusState private var focused: Bool
    var body: some View {
        // no stale chat while unreachable: the Mac is the source of truth and every action would fail anyway
        Group { if c.state == .connected || c.state == .connecting { transcript } else { OfflineView() } }
            .safeAreaInset(edge: .top) { if c.state == .connecting { ConnBanner() } }
            .navigationTitle(c.currentSess?.title ?? String(localized: "Conversation"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .tabBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { ConnBadge() }
                ToolbarItem(placement: .topBarTrailing) { Button { creating = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New session") }
                // desktop's session menu: tap the title for rename / fork / pin / archive
                ToolbarTitleMenu {
                    if let id = c.current {
                        if let p = c.currentSess?.parent { Button { c.open(p) } label: { Label("Open parent session", systemImage: "arrow.turn.left.up") } }
                        Button { newTitle = c.currentSess?.title ?? ""; renaming = true } label: { Label("Rename", systemImage: "pencil") }
                        Button { editGoal() } label: { Label(c.goal == nil ? String(localized: "Set goal…") : String(localized: "Edit goal…"), systemImage: "target") }
                        Button { c.run { try await c.fork(id) } } label: { Label("Fork", systemImage: "arrow.triangle.branch") }
                        Button { c.run { try await c.togglePin(id) } } label: { Label(c.pinned.contains(id) ? String(localized: "Unpin") : String(localized: "Pin"), systemImage: "pin") }
                        if c.transcript.contains(where: { $0.kind == .assistant }) {
                            Button {
                                UIPasteboard.general.string = transcriptMarkdown(c.transcript, title: c.currentSess?.title ?? String(localized: "Conversation"))
                                UINotificationFeedbackGenerator().notificationOccurred(.success)
                            } label: { Label("Copy conversation", systemImage: "doc.on.doc") }
                            ShareLink(item: transcriptMarkdown(c.transcript, title: c.currentSess?.title ?? String(localized: "Conversation"))) { Label("Share conversation", systemImage: "square.and.arrow.up") }
                        }
                        Button(role: .destructive) { let was = c.archived.contains(id); c.run { try await c.toggleArchive(id); if !was { c.path = [] } } } label: { Label(c.archived.contains(id) ? String(localized: "Unarchive") : String(localized: "Archive"), systemImage: "archivebox") }
                    }
                }
            }
            .sheet(isPresented: $creating) { NewSessionSheet() }
            .alert("Rename session", isPresented: $renaming) {
                TextField("Title", text: $newTitle)
                Button("Save") { if let id = c.current { let t = newTitle; c.run { try await c.rename(id, t) } } }
                    .disabled(cleanTitle(newTitle) == nil)
                Button("Cancel", role: .cancel) {}
            }
            .alert(c.goal == nil ? "Set goal" : "Edit goal", isPresented: $goalEditing) {
                TextField("Objective", text: $goalText, axis: .vertical)
                Button("Save") {
                    let o = goalText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !o.isEmpty else { return }
                    let has = c.goal != nil
                    c.run { if has { try await c.editGoal(o) } else { try await c.createGoal(o) } }
                }
                Button("Cancel", role: .cancel) {}
            } message: { Text("The agent keeps working toward this until it is complete.") }
            // per-session draft: going back or switching sessions never loses typed text
            .onAppear { text = c.draft(c.current) }
            .onChange(of: c.current) { text = c.draft(c.current) }
            .onChange(of: text) { c.setDraft(text, c.current) }
            .alert("Edit queued message", isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
                TextField("Message", text: $editText, axis: .vertical)
                Button("Save") {
                    guard let id = editing?["id"] as? String else { return }
                    let t = editText.trimmingCharacters(in: .whitespacesAndNewlines)
                    c.run { try await c.updateQueue(id, t.isEmpty ? ["kind": "remove"] : ["kind": "edit", "content": [["type": "text", "text": t]]]) }
                }
                Button("Cancel", role: .cancel) {}
            }
    }

    var transcript: some View {
        ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if c.hasOlder {
                            Button {
                                loadingOlder = true
                                c.run { defer { loadingOlder = false }; try await c.loadOlder() }
                            } label: {
                                HStack(spacing: 6) {
                                    if loadingOlder { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.up.circle") }
                                    Text("Load earlier messages")
                                }.font(.footnote).frame(maxWidth: .infinity)
                            }.buttonStyle(.bordered).disabled(loadingOlder)
                        }
                        ForEach(c.transcript) { LineView(line: $0, onEdit: { text = $0; focused = true }) }
                        if !c.reasoning.isEmpty { LineView(line: Line(kind: .reasoning, text: c.reasoning), live: true) }
                        if !c.streaming.isEmpty { LineView(line: Line(kind: .assistant, text: c.streaming), live: true) }
                        // upload/send progress first, so a large file never looks like a dead Send button
                        if let s = c.sendStatus ?? (c.running && c.streaming.isEmpty && c.reasoning.isEmpty ? String(localized: "Working…") : nil) {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small); Text(s)
                                // elapsed time tells a slow turn apart from a stuck one
                                if c.running, let t = c.turnStartedAt ?? turnStart {
                                    TimelineView(.periodic(from: t, by: 1)) { ctx in Text(elapsedText(Int(ctx.date.timeIntervalSince(t)))).monospacedDigit().foregroundStyle(.tertiary) }
                                }
                            }.font(.footnote).foregroundStyle(.secondary)
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
                        if let g = c.goal { goalCard(g) }
                        if c.shownTodos.contains(where: { $0.status != "completed" }) { todoCard }
                        if !c.queued.isEmpty { queueDock }
                        if !suggestions.isEmpty { suggestionList }
                        composer
                        statusLine
                    }.background(.background)
                }
                // only follow output while the user is at the bottom, so reading history is not yanked away
                .onChange(of: c.transcript.count) { if atBottom { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: c.streaming) { if atBottom { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: c.reasoning) { if atBottom { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: c.sendStatus) { if atBottom { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: c.running, initial: true) { turnStart = c.running ? (turnStart ?? .now) : nil }
        }
    }

    var emptyState: some View {
        VStack(spacing: 8) {
            Group {
                Image(systemName: "sparkles").font(.largeTitle).foregroundStyle(.secondary)
                Text(c.shownModel ?? String(localized: "Model")).font(.headline)
                if let cwd = c.currentSess?.cwd, !cwd.isEmpty { Text(cwd).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head) }
                Text("Type / for commands").font(.caption).foregroundStyle(.tertiary)
            }.allowsHitTesting(false)
            // starter prompts fill the composer (not send) so they can be edited first
            VStack(spacing: 6) {
                ForEach([String(localized: "Explain this project"), String(localized: "Find and fix a bug"), String(localized: "Write tests for recent changes")], id: \.self) { s in
                    Button { text = s; focused = true } label: { Text(s).font(.footnote) }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small)
                }
            }.padding(.top, 8)
        }.padding()
    }

    /// Model · context % · token usage, like the desktop status bar.
    var statusLine: some View {
        // live while streaming; the session list's projected figure covers logs whose request/context fell outside the snapshot window
        let share = contextShare(c.usage, window: c.contextWindow) ?? c.currentSess?.context
        let ctx = share.map { "ctx \(Int(($0 * 100).rounded()))%" }
        let hot = contextHot(share)
        let canCompact = c.commands.contains { $0.name == "compact" } && !c.running
        // project folder first, like the desktop status bar, so the cwd stays visible once the transcript fills up
        let folder = c.currentSess.map { ($0.cwd as NSString).lastPathComponent }
        let parts = [folder, c.shownModel, ctx, c.usage.map(usageText)].compactMap { $0 }.filter { !$0.isEmpty }
        return Text(parts.joined(separator: " · ")).font(.caption2.monospacedDigit()).foregroundStyle(hot ? AnyShapeStyle(.orange) : AnyShapeStyle(.tertiary)).lineLimit(1).padding(.horizontal).padding(.bottom, 4)
            .contentShape(Rectangle())
            .onTapGesture { if c.usage != nil || hot { showUsage = true } }
            .accessibilityHint(c.usage != nil || hot ? "Shows token details" : "")
            .popover(isPresented: $showUsage) {
                VStack(alignment: .leading, spacing: 6) {
                    Text([folder, c.shownModel, ctx].compactMap { $0 }.joined(separator: " · ")).font(.footnote.weight(.semibold))
                    if let u = c.usage { Text(usageDetail(u)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary) }
                    if hot { Text("Context is almost full. Compacting summarizes older turns so the session can continue.").font(.footnote).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
                    if canCompact {
                        Button { showUsage = false; c.run { try await c.execute("/compact") } } label: { Label("Compact context", systemImage: "arrow.down.right.and.arrow.up.left") }
                            .buttonStyle(.bordered).controlSize(.small).padding(.top, 2)
                    }
                }.padding().presentationCompactAdaptation(.popover)
            }
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

    var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty || !files.isEmpty }

    /// Desktop goal bar: objective + phase/rounds, actions in a menu.
    func goalCard(_ g: Goal) -> some View {
        HStack(spacing: 8) {
            Image(systemName: g.paused ? "pause.circle" : "target").font(.caption).foregroundStyle(g.blocked != nil ? Color.orange : Color.accentColor)
            VStack(alignment: .leading, spacing: 1) {
                Text(g.objective).font(.footnote).lineLimit(1)
                Text(g.blocked ?? g.summary).font(.caption2).foregroundStyle(g.blocked != nil ? Color.orange : Color.secondary).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Menu {
                Button { editGoal() } label: { Label("Edit objective", systemImage: "pencil") }
                if g.paused { Button { goal("resume") } label: { Label("Resume", systemImage: "play") } }
                else { Button { goal("pause") } label: { Label("Pause", systemImage: "pause") } }
                Button { goal("complete") } label: { Label("Complete", systemImage: "checkmark") }
                Button(role: .destructive) { confirmClearGoal = true } label: { Label("Clear", systemImage: "xmark") }
            } label: { Image(systemName: "ellipsis").frame(width: 32, height: 32).contentShape(Rectangle()) }
            .accessibilityLabel("Goal actions")
        }
        .confirmationDialog("Clear this goal?", isPresented: $confirmClearGoal, titleVisibility: .visible) {
            Button("Clear goal", role: .destructive) { goal("clear") }
        } message: { Text("The agent stops working toward it. This can't be undone.") }
        .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 4)
        .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal, 10).padding(.top, 6)
        .accessibilityElement(children: .contain).accessibilityLabel(Text("Goal: \(g.objective)"))
    }

    func goal(_ verb: String) { c.run { try await c.goalAction(verb) } }
    func editGoal() { goalText = c.goal?.objective ?? ""; goalEditing = true }

    /// Desktop todo list: collapsed to "done/total · current task", tap to expand.
    var todoCard: some View {
        let todos = c.shownTodos
        let done = todos.filter { $0.status == "completed" }.count
        let current = todos.first { $0.status == "in_progress" } ?? todos.first { $0.status != "completed" }
        return VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy) { showTodos.toggle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "checklist").font(.caption).foregroundStyle(.secondary)
                    Text("\(done)/\(todos.count)").font(.footnote.monospacedDigit().weight(.semibold))
                    Text(current?.content ?? "").font(.footnote).foregroundStyle(.secondary).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.up").font(.caption2.weight(.semibold)).foregroundStyle(.tertiary).rotationEffect(.degrees(showTodos ? 180 : 0))
                }.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Tasks \(done) of \(todos.count) done"))
            if showTodos {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(todos.enumerated()), id: \.offset) { _, t in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Image(systemName: t.status == "completed" ? "checkmark.circle.fill" : t.status == "in_progress" ? "circle.dotted" : "circle")
                                    .font(.caption).foregroundStyle(t.status == "completed" ? Color.green : t.status == "in_progress" ? Color.accentColor : Color.secondary)
                                Text(t.content).font(.footnote).strikethrough(t.status == "completed")
                                    .foregroundStyle(t.status == "completed" ? .secondary : .primary).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }.frame(maxHeight: 180)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal, 10).padding(.top, 6)
    }

    /// Desktop QueueDock: messages typed while a turn runs wait here; send now (steer), edit or remove them.
    var queueDock: some View {
        VStack(spacing: 0) {
            ForEach(Array(c.queued.enumerated()), id: \.offset) { _, item in
                let id = item["id"] as? String ?? ""
                let steering = c.inbox["next-step"]?.contains { $0["id"] as? String == id } == true
                HStack(spacing: 8) {
                    Image(systemName: steering ? "arrow.turn.down.right" : "clock").font(.caption).foregroundStyle(.secondary)
                    Text(contentText(item["content"])).font(.footnote).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    Menu {
                        if !steering { Button { c.run { try await c.updateQueue(id, ["kind": "steer"]) } } label: { Label("Send now", systemImage: "arrow.up") } }
                        Button { editText = contentText(item["content"]); editing = item } label: { Label("Edit", systemImage: "pencil") }
                        Button(role: .destructive) { c.run { try await c.updateQueue(id, ["kind": "remove"]) } } label: { Label("Remove", systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis").frame(width: 32, height: 32).contentShape(Rectangle()) }
                    .accessibilityLabel("Queued message actions")
                }
                .padding(.horizontal, 14).padding(.vertical, 4)
            }
        }
        .padding(.vertical, 4)
        .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal, 10).padding(.top, 6)
        .accessibilityElement(children: .contain).accessibilityLabel("Queued messages")
    }

    /// Codex-style card: text on top, attach · model chip · send/stop on one row below.
    var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !images.isEmpty || !files.isEmpty {
                ScrollView(.horizontal) { HStack { ForEach(images.indices, id: \.self) { i in
                    Image(uiImage: UIImage(data: images[i]) ?? UIImage()).resizable().scaledToFill().frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle()).onTapGesture { preview = UIImage(data: images[i]) }
                        .accessibilityAddTraits(.isButton).accessibilityLabel("Preview image")
                        .overlay(alignment: .topTrailing) { Button { images.remove(at: i) } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Remove image") }
                }
                    ForEach(files) { f in
                        HStack(spacing: 6) {
                            Image(systemName: "doc").foregroundStyle(.secondary)
                            Text(f.name).font(.footnote).lineLimit(1).frame(maxWidth: 140)
                            Button { files.removeAll { $0.id == f.id } } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                                .buttonStyle(.plain).accessibilityLabel("Remove \(f.name)")
                        }
                        .padding(.horizontal, 10).frame(height: 52).background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                    }
                } }
                .fullScreenCover(isPresented: Binding(get: { preview != nil }, set: { if !$0 { preview = nil } })) {
                    if let preview { ImageViewer(img: preview) { self.preview = nil } }
                }
            }
            // while a turn runs, sending queues the next turn like desktop's default busy-Enter; the queue dock's "Send now" steers
            TextField(c.running ? "Queue a message…" : "Ask DeepSeek", text: $text, axis: .vertical).lineLimit(1...6).focused($focused).padding(.horizontal, 4)
            HStack(spacing: 10) {
                Menu {
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { shooting = true } label: { Label("Camera", systemImage: "camera") }
                    }
                    Button { showPhotos = true } label: { Label("Photos", systemImage: "photo") }
                    Button { importing = true } label: { Label("Files", systemImage: "doc") }
                    if UIPasteboard.general.hasImages {
                        Button { images += (UIPasteboard.general.images ?? []).prefix(4).compactMap { $0.jpegData(compressionQuality: 0.9).flatMap(jpeg) } } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
                    }
                } label: {
                    Image(systemName: "plus").font(.body.weight(.medium)).frame(width: 32, height: 32).background(Color(.tertiarySystemFill), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Attach")
                .fullScreenCover(isPresented: $shooting) {
                    CameraPicker { d in if let j = jpeg(d) { images.append(j) } }.ignoresSafeArea()
                }
                .photosPicker(isPresented: $showPhotos, selection: $picks, maxSelectionCount: 4, matching: .images)
                .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { res in
                    c.run {
                        for url in try res.get() { files.append(try Attachment.load(url)) }
                    }
                }
                ModelMenu()
                PermMenu()
                PresetMenu()
                Spacer(minLength: 0)
                if c.running && canSend { roundButton("arrow.up", action: send).accessibilityLabel("Queue") }
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
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines), imgs = images, fs = files
        text = ""; images = []; files = []
        let name = t.hasPrefix("/") ? String(t.dropFirst().prefix { !$0.isWhitespace }) : ""
        // a failed send (link down, Mac asleep) puts the draft back instead of losing it
        let restore = { if text.isEmpty && images.isEmpty && files.isEmpty { text = t; images = imgs; files = fs } }
        if imgs.isEmpty, fs.isEmpty, c.commands.contains(where: { $0.name == name }) {
            c.run { do { try await c.execute(t) } catch { restore(); throw error } }; return
        }
        atBottom = true
        c.run { do { try await c.prompt(t, images: imgs, files: fs) } catch { restore(); throw error } }
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
    var onEdit: ((String) -> Void)? = nil
    @State private var open = false
    @State private var copied = false
    @State private var selecting = false
    var body: some View {
        content.contextMenu {
            Button { UIPasteboard.general.string = [line.text, line.output].compactMap { $0 }.joined(separator: "\n\n") } label: { Label("Copy", systemImage: "doc.on.doc") }
            if line.kind == .assistant || line.kind == .reasoning, !live { Button { selecting = true } label: { Label("Select Text", systemImage: "selection.pin.in.out") } }
            if line.kind == .assistant, !live { ShareLink(item: line.text) { Label("Share", systemImage: "square.and.arrow.up") } }
            if line.kind == .user {
                if let onEdit { Button { onEdit(line.text) } label: { Label("Edit", systemImage: "pencil") } }
                Button { let l = line; c.run { try await c.resend(l) } } label: { Label("Resend", systemImage: "arrow.clockwise") }
            }
            if line.kind == .assistant, let p = promptLine(before: line.id, in: c.transcript) {
                Button { c.run { try await c.resend(p) } } label: { Label("Regenerate", systemImage: "arrow.triangle.2.circlepath") }
            }
        }
        .sheet(isPresented: $selecting) {
            NavigationStack {
                SelectableText(text: line.text)
                    .navigationTitle("Select Text").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { selecting = false } } }
            }
        }
    }
    @ViewBuilder var content: some View {
        switch line.kind {
        case .user:
            VStack(alignment: .trailing, spacing: 6) {
                if !line.images.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) { ForEach(line.images, id: \.self) { Thumb(id: $0) } }
                    }
                    .defaultScrollAnchor(.trailing).padding(.leading, 48)
                }
                if !line.text.isEmpty {
                    HStack { Spacer(minLength: 48); Text(line.text).textSelection(.enabled).padding(.horizontal, 14).padding(.vertical, 10).background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 18, style: .continuous)) }
                }
            }.frame(maxWidth: .infinity, alignment: .trailing)
        case .assistant:
            VStack(alignment: .leading, spacing: 6) {
                Markdown(text: line.text).frame(maxWidth: .infinity, alignment: .leading)
                if !live {
                    Button {
                        UIPasteboard.general.string = line.text; UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        copied = true
                        Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                    } label: {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption).foregroundStyle(.secondary).frame(width: 32, height: 28).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityLabel(copied ? "Copied" : "Copy")
                }
            }
        case .reasoning:
            DisclosureGroup(isExpanded: $open) {
                Text(line.text).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 10).overlay(alignment: .leading) { Rectangle().fill(Color(.separator)).frame(width: 2) }
            } label: {
                Text(live ? String(localized: "Thinking…") : String(localized: "Thought")).font(.footnote).foregroundStyle(.secondary)
            }
            .tint(.secondary)
        case .command: Label(line.text, systemImage: "chevron.right").font(.footnote.monospaced()).foregroundStyle(.secondary)
        case .tool:
            // Codex-style: one row per call, status icon, tap to see full arguments + output.
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    // an interrupted call from an earlier turn never gets output; only the turn in flight may spin
                    if line.output == nil && c.running && inCurrentTurn(line.id, in: c.transcript) { ProgressView().controlSize(.mini) }
                    else { Image(systemName: line.failed ? "xmark.circle" : line.output == nil ? "terminal" : "checkmark.circle").foregroundStyle(line.failed ? Color.red : .secondary) }
                    Text(line.text).lineLimit(open ? nil : 1)
                    Spacer(minLength: 0)
                    if line.output?.isEmpty == false || line.args?.isEmpty == false { Image(systemName: "chevron.right").font(.caption2).rotationEffect(.degrees(open ? 90 : 0)) }
                }
                .font(.footnote.monospaced()).foregroundStyle(.secondary)
                if open, let a = line.args, !a.isEmpty {
                    Text(a).font(.caption.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 22)
                }
                if open, let o = line.output, !o.isEmpty {
                    Text(o).font(.caption.monospaced()).foregroundStyle(line.failed ? .red : .secondary).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(8).padding(.trailing, 28)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(alignment: .topTrailing) {
                            // output only; the context menu's Copy still copies call + output
                            Button {
                                UIPasteboard.general.string = o; UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                copied = true
                                Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                            } label: {
                                Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption2).foregroundStyle(.secondary).frame(width: 32, height: 28).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).accessibilityLabel(copied ? "Copied" : "Copy output")
                        }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            .onTapGesture { withAnimation { open.toggle() } }
            .accessibilityAddTraits(.isButton)
        case .result: tap(Text(line.text).font(.caption.monospaced()).foregroundStyle(.secondary).padding(8)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous)), 6)
        case .error:
            VStack(alignment: .leading, spacing: 6) {
                tap(Label(line.text, systemImage: "exclamationmark.triangle").font(.caption.monospaced()).foregroundStyle(.red), 6)
                if !c.running, let p = retryPrompt(for: line.id, in: c.transcript) {
                    Button { c.run { try await c.resend(p) } } label: { Label("Retry", systemImage: "arrow.clockwise").font(.footnote.weight(.medium)) }
                        .buttonStyle(.bordered).controlSize(.small).tint(.secondary)
                }
            }
        }
    }
    /// Long tool output stays collapsed until tapped.
    func tap(_ v: some View, _ n: Int) -> some View {
        v.lineLimit(open ? nil : n).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle()).onTapGesture { withAnimation { open.toggle() } }
    }
}

/// Inline Markdown via AttributedString; fenced code blocks get a monospaced box with a Copy button.
/// Sent-image thumbnail, fetched lazily from DSH; tap for full screen.
struct Thumb: View {
    @EnvironmentObject var c: Client
    let id: String
    @State private var img: UIImage?
    @State private var failed = false
    @State private var full = false
    var body: some View {
        Group {
            if let img { Image(uiImage: img).resizable().scaledToFill() }
            else if failed { Image(systemName: "photo").font(.title2).foregroundStyle(.secondary) }
            else { ProgressView() }
        }
        .frame(width: 120, height: 160).background(Color(.secondarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { if img != nil { full = true } }
        .accessibilityElement().accessibilityLabel("Image").accessibilityAddTraits(.isButton)
        .task { img = await c.image(id); failed = img == nil }
        .fullScreenCover(isPresented: $full) {
            if let img { ImageViewer(img: img) { full = false } }
        }
    }
}

/// Pinch/double-tap zoom + share; zoom is clamped to 1…5×.
func zoomClamp(_ s: CGFloat) -> CGFloat { min(max(s, 1), 5) }

/// Read-only UITextView: SwiftUI Text only selects whole blocks, this allows partial selection like ChatGPT's "Select Text".
struct SelectableText: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let v = UITextView()
        v.isEditable = false; v.isSelectable = true; v.alwaysBounceVertical = true
        v.font = .preferredFont(forTextStyle: .body); v.adjustsFontForContentSizeCategory = true
        v.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 24, right: 12)
        v.text = text
        return v
    }
    func updateUIView(_ v: UITextView, context: Context) { if v.text != text { v.text = text } }
}

struct ImageViewer: View {
    let img: UIImage
    let close: () -> Void
    @State private var scale: CGFloat = 1
    @State private var base: CGFloat = 1
    @State private var off: CGSize = .zero
    @State private var offBase: CGSize = .zero
    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            Image(uiImage: img).resizable().scaledToFit()
                .scaleEffect(scale).offset(off)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .gesture(MagnifyGesture()
                    .onChanged { scale = zoomClamp(base * $0.magnification) }
                    .onEnded { _ in base = scale; if scale == 1 { off = .zero; offBase = .zero } })
                .simultaneousGesture(DragGesture()
                    .onChanged { g in
                        if scale > 1 { off = CGSize(width: offBase.width + g.translation.width, height: offBase.height + g.translation.height) }
                    }
                    .onEnded { g in
                        if scale > 1 { offBase = off } else if g.translation.height > 120 { close() }
                    })
                .onTapGesture(count: 2) {
                    withAnimation(.spring(duration: 0.3)) {
                        scale = scale > 1 ? 1 : 2.5; base = scale; off = .zero; offBase = .zero
                    }
                }
                .accessibilityLabel("Image")
            HStack {
                Button(action: close) { Image(systemName: "xmark.circle.fill").font(.title).symbolRenderingMode(.palette).foregroundStyle(.white, .white.opacity(0.25)) }
                    .accessibilityLabel("Close")
                Spacer()
                ShareLink(item: Image(uiImage: img), preview: SharePreview("Image", image: Image(uiImage: img))) {
                    Image(systemName: "square.and.arrow.up.circle.fill").font(.title).symbolRenderingMode(.palette).foregroundStyle(.white, .white.opacity(0.25))
                }.accessibilityLabel("Share")
            }.padding()
        }
    }
}

struct Markdown: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(mdBlocks(text).enumerated()), id: \.offset) { _, b in
                if b.code {
                    CodeBlock(text: b.text, lang: b.lang)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(mdParts(b.text).enumerated()), id: \.offset) { _, p in
                            switch p {
                            case .line(let l): MdLineView(line: mdLine(l))
                            case .table(let rows): MdTable(rows: rows)
                            }
                        }
                    }.textSelection(.enabled)
                }
            }
        }
    }
}

/// Codex-style fenced code: language label + Copy (flips to "Copied") in a header bar, code scrolls sideways.
struct CodeBlock: View {
    let text: String, lang: String
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(lang.isEmpty ? "code" : lang).font(.caption2.monospaced()).foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = text; UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                } label: { Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").font(.caption) }
                .buttonStyle(.plain).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10).padding(.vertical, 6).background(Color(.tertiarySystemFill))
            ScrollView(.horizontal) { Text(text).font(.caption.monospaced()).textSelection(.enabled).padding(10) }
        }
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color(.separator).opacity(0.5)))
    }
}

func mdInline(_ s: String) -> Text { Text((try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)) }

/// GitHub-style table: first row is the header; short rows are padded with empty cells.
struct MdTable: View {
    let rows: [[String]]
    var body: some View {
        if let head = rows.first {
            let w = rows.map(\.count).max() ?? head.count
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                        GridRow {
                            ForEach(0..<w, id: \.self) { j in
                                mdInline(j < r.count ? r[j] : "").font(i == 0 ? .footnote.weight(.semibold) : .footnote)
                            }
                        }
                        if i == 0 && rows.count > 1 { Divider() }
                    }
                }
            }
            .padding(10).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color(.separator).opacity(0.5)))
        }
    }
}

struct MdLineView: View {
    let line: MdLine
    func inline(_ s: String) -> Text { mdInline(s) }
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
                        if m.efforts.isEmpty { Button { c.run { try await c.selectModel(g.id, m.id, nil) } } label: { pick(m.name, modelMatches(c.shownModel, m.id)) } }
                        else {
                            Menu { ForEach(m.efforts, id: \.self) { e in Button { c.run { try await c.selectModel(g.id, m.id, e) } } label: { pick(e, modelMatches(c.shownModel, m.id, e)) } } }
                            label: { pick(m.name, modelMatches(c.shownModel, m.id)) }
                        }
                    }
                }
            }
            if c.catalog.isEmpty { Text("Loading models…") }
        } label: {
            // maxWidth keeps a long model name from squeezing the preset chip and buttons on small phones
            HStack(spacing: 3) { Text(c.shownModel ?? String(localized: "Model")).lineLimit(1).truncationMode(.middle).frame(maxWidth: 150); Image(systemName: "chevron.down").imageScale(.small) }
                .font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                .padding(.horizontal, 10).frame(height: 32).background(Color(.tertiarySystemFill), in: Capsule())
        }
        .accessibilityLabel(Text("Model"))
        .onAppear { if c.catalog.isEmpty { c.run { try await c.loadCatalog() } } }
    }
    @ViewBuilder func pick(_ t: String, _ on: Bool) -> some View { if on { Label(t, systemImage: "checkmark") } else { Text(t) } }
}

/// Codex-style permission chip next to the model; risky levels still go through a confirm.
struct PermMenu: View {
    @EnvironmentObject var c: Client
    @State private var risky: Preset?
    var body: some View {
        let cur = c.currentSess?.permission
        Menu {
            ForEach(c.perms) { p in
                Button { if ["danger-full-access", "auto"].contains(p.id) { risky = p } else { c.run { try await c.selectPermission(p.id) } } } label: {
                    if cur == p.id { Label(p.name, systemImage: "checkmark") } else { Text(p.name) }
                }
            }
            if c.perms.isEmpty { Text("Loading…") }
        } label: {
            Image(systemName: cur == "danger-full-access" ? "exclamationmark.shield" : cur == "auto" ? "checkmark.shield" : cur == "read-only" ? "lock.shield" : "shield")
                .font(.footnote.weight(.medium)).foregroundStyle(cur == "danger-full-access" ? Color.orange : Color.secondary)
                .frame(width: 32, height: 32).background(Color(.tertiarySystemFill), in: Circle())
        }
        .accessibilityLabel(Text("Permissions"))
        .accessibilityValue(Text(c.perms.first { $0.id == cur }?.name ?? ""))
        .confirmationDialog(Text("Give the agent \(risky?.name ?? "")?"), isPresented: Binding(get: { risky != nil }, set: { if !$0 { risky = nil } }), titleVisibility: .visible, presenting: risky) { p in
            Button("Allow", role: .destructive) { c.run { try await c.selectPermission(p.id) } }
        } message: { p in Text(p.id == "auto" ? "Actions run after an automatic safety review instead of asking you. Experimental." : "It can change files and run commands anywhere on your Mac without asking.") }
        .onAppear { if c.perms.isEmpty { Task { await c.loadAgents() } } }
    }
}

// MARK: - Sessions

/// Agent preset chip; only appears when the chat runs a non-default preset (e.g. PTC), so the default composer stays clean.
struct PresetMenu: View {
    @EnvironmentObject var c: Client
    var body: some View {
        let cur = c.currentSess?.preset
        if let p = customPreset(cur, c.presets) {
            Menu {
                ForEach(c.presets) { q in
                    Button { c.run { try await c.selectPreset(q.id) } } label: {
                        if cur == q.id { Label(q.name, systemImage: "checkmark") } else { Text(q.name) }
                    }.disabled(q.broken)
                }
            } label: {
                Text(p.name).lineLimit(1).frame(maxWidth: 90)
                    .font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).frame(height: 32).background(Color(.tertiarySystemFill), in: Capsule())
            }
            .accessibilityLabel(Text("Agent preset"))
            .accessibilityValue(Text(p.name))
        }
    }
}

struct SessionsView: View {
    @EnvironmentObject var c: Client
    @State private var query = ""
    @State private var hits: [Hit] = []
    @State private var searching = false
    @AppStorage("foldToggles") private var folds = ""
    // @AppStorage writes land outside the withAnimation transaction, so List rows snapped instead of sliding; animate a @State mirror
    @State private var shownFolds = ""
    @State private var creating = false
    @State private var renaming: Sess?
    @AppStorage("sessionProject") private var project = ""
    @State private var newTitle = ""
    var body: some View {
        NavigationStack(path: $c.path) {
            List {
                // in-list so it scrolls away with the content instead of pinning under the large title
                // offline: the centered OfflineView says it; a banner on top would repeat it
                if c.state == .connected || c.state == .connecting { Section { ConnBanner().listRowInsets(EdgeInsets()).listRowBackground(Color.clear) } }
                if c.state != .connected {
                    // sessions need a live link: no cached rows, the overlay explains and offers Tailscale
                } else if query.isEmpty {
                    // offset id: two DSH workspaces may share a title
                    ForEach(Array(c.sessionGroups(project: project.isEmpty ? nil : project).enumerated()), id: \.offset) { _, g in
                        // accordion like the desktop sidebar; Archived starts folded; a folded group still shows the open session
                        let folded = groupFolded(shownFolds, g.title)
                        Section {
                            // List's own row insert animation; a custom .move transition made rows pop in on expand
                            ForEach(folded ? g.items.filter { $0.id == c.current } : g.items) { s in sessionRow(s) }
                        } header: {
                            Button {
                                withAnimation(.snappy(duration: 0.3)) { shownFolds = toggledFold(shownFolds, g.title) }
                                folds = shownFolds
                            } label: {
                                HStack {
                                    Label("\(g.title) (\(g.items.count))", systemImage: groupIcon(g.title))
                                    Spacer()
                                    Image(systemName: "chevron.right").rotationEffect(.degrees(folded ? 0 : 90))
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .accessibilityValue(folded ? "Collapsed" : "Expanded")
                            .accessibilityHint(folded ? "Shows this group's sessions" : "Hides this group's sessions")
                        }
                    }
                } else {
                    let titles = c.titleMatches(query, project: project.isEmpty ? nil : project)
                    let ids = Set(titles.map(\.id))
                    let only = c.workspaces.first { $0.id == project }
                    let content = hits.filter { !ids.contains($0.session) && (only?.sessions.contains($0.session) ?? true) }
                    if !titles.isEmpty { Section("Titles") { ForEach(titles) { s in sessionRow(s) } } }
                    Section {
                        ForEach(content) { h in
                            Button { open(h.session) } label: { VStack(alignment: .leading) { Text(c.title(h.session)).foregroundStyle(.primary).lineLimit(1); Text(h.snippet).font(.caption).foregroundStyle(.secondary).lineLimit(2) } }
                        }
                        if searching { HStack { ProgressView(); Text("Searching messages…").foregroundStyle(.secondary) } }
                    } header: { if !content.isEmpty { Text("Messages") } }
                    if !searching && titles.isEmpty && content.isEmpty {
                        ContentUnavailableView.search(text: query).listRowBackground(Color.clear)
                    }
                }
            }
            .overlay { if query.isEmpty || c.state != .connected {
                switch sessionsPlaceholder(loaded: c.sessionsLoaded, count: c.sessions.count, state: c.state) {
                case .offline: OfflineView()
                case .empty: ContentUnavailableView { Label("No sessions", systemImage: "tray") } actions: { Button("New session") { creating = true }.buttonStyle(.borderedProminent) }
                case .loading: ProgressView("Loading sessions…")
                case .none: EmptyView()
                }
            } }
            .searchable(text: $query, prompt: "Search sessions")
            .onChange(of: folds, initial: true) { _, v in if v != shownFolds { shownFolds = v } }
            .task(id: query) {
                hits = []
                let q = query.trimmingCharacters(in: .whitespaces)
                guard !q.isEmpty else { searching = false; return }
                searching = true
                try? await Task.sleep(for: .milliseconds(350)) // debounce; a newer keystroke cancels this task
                guard !Task.isCancelled else { return }
                let r = try? await c.search(q)
                guard !Task.isCancelled else { return }
                hits = r ?? []; searching = false
            }
            .refreshable { try? await c.loadSessions() }
            .navigationTitle("Sessions")
            .navigationDestination(for: String.self) { _ in ConversationView() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ConnBadge() }
                if !c.workspaces.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        let active = c.workspaces.first { $0.id == project }
                        Menu {
                            Picker("Project", selection: $project) {
                                Text("All projects").tag("")
                                ForEach(c.workspaces) { Text($0.title).tag($0.id) }
                            }
                        } label: { Image(systemName: active == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill") }
                        .accessibilityLabel("Filter sessions")
                        .accessibilityValue(Text(active?.title ?? String(localized: "All projects")))
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { Button { creating = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New session") }
            }
            .sheet(isPresented: $creating) { NewSessionSheet() }
            .alert("Rename session", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Title", text: $newTitle)
                Button("Save") { if let s = renaming { let t = newTitle; c.run { try await c.rename(s.id, t) } } }
                    .disabled(cleanTitle(newTitle) == nil)
                Button("Cancel", role: .cancel) {}
            }
        }
    }
    func sessionRow(_ s: Sess) -> some View {
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
                if !s.cwd.isEmpty { Button { c.run { try await c.create(cwd: s.cwd) } } label: { Label("New session in this folder", systemImage: "plus.bubble") } }
                Button { c.run { try await c.toggleArchive(s.id) } } label: { Label(archiveLabel(s), systemImage: "archivebox") }
            }
    }
    func row(_ s: Sess) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if c.pinned.contains(s.id) { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange) }
                    Text(s.title).foregroundStyle(.primary).lineLimit(1)
                }
                HStack(spacing: 0) {
                    Text([s.model, (s.cwd as NSString).lastPathComponent].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    if let d = s.updated { Text(" · ") + Text(d, format: .relative(presentation: .named, unitsStyle: .abbreviated)) }
                }
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if let g = s.goal, !g.phase.hasPrefix("complete") { Image(systemName: "target").font(.caption).foregroundStyle(g.paused ? Color.secondary : Color.accentColor).accessibilityLabel("Goal: \(g.summary)") }
            if c.prompts.contains(where: { $0.agentId == s.id }) { Image(systemName: "hand.raised.fill").foregroundStyle(.orange).accessibilityLabel("Waiting for you") }
            if s.running { Circle().fill(.green).frame(width: 8, height: 8).accessibilityLabel("Running") }
            else if c.finished.contains(s.id) { Circle().fill(Color.accentColor).frame(width: 8, height: 8).accessibilityLabel("Finished") }
            if s.id == c.current { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
        }
    }
    func pinLabel(_ s: Sess) -> String { c.pinned.contains(s.id) ? String(localized: "Unpin") : String(localized: "Pin") }
    func archiveLabel(_ s: Sess) -> String { c.archived.contains(s.id) ? String(localized: "Unarchive") : String(localized: "Archive") }
    func open(_ id: String) { c.open(id) }
}

/// Pick a DSH project (workspace), a folder of a past session, or type a path. Search filters both lists.
struct NewSessionSheet: View {
    @EnvironmentObject var c: Client
    @Environment(\.dismiss) var dismiss
    @AppStorage("sessionProject") private var filter = ""
    @State private var custom = ""
    @State private var q = ""
    func hit(_ s: String...) -> Bool { q.isEmpty || s.contains { $0.localizedCaseInsensitiveContains(q) } }
    // Extra folders: cwds of all sessions (session/list is unpaged), minus the DSH projects already listed.
    var folders: [String] { recentFolders(c.sessions, excluding: Set(c.workspaces.map(\.path))).filter { hit($0) } }
    var projects: [Workspace] { c.workspaces.filter { hit($0.title, $0.path) } }
    var body: some View {
        NavigationStack {
            List {
                if q.isEmpty {
                    Section {
                        Button { create(nil) } label: { row(Text("Quick chat"), Text("DSH default workspace, no project"), "bubble.left") }
                    }
                }
                if !projects.isEmpty {
                    Section("Projects") {
                        ForEach(projects) { w in
                            Button { create(w.path, w.id) } label: { row(Text(verbatim: w.title), Text(verbatim: w.path), "folder.fill", checked: w.id == filter) }
                        }
                    }
                }
                if !folders.isEmpty {
                    Section("Recent folders") {
                        ForEach(folders, id: \.self) { p in
                            Button { create(p) } label: { row(Text(verbatim: (p as NSString).lastPathComponent), Text(verbatim: p), "clock") }
                        }
                    }
                }
                if !q.isEmpty && projects.isEmpty && folders.isEmpty {
                    ContentUnavailableView.search(text: q)
                }
                Section {
                    TextField("/Users/…/project", text: $custom).font(.body.monospaced())
                        .autocorrectionDisabled().textInputAutocapitalization(.never).keyboardType(.URL).submitLabel(.go)
                        .onSubmit { if let p = macPath(custom) { create(p) } }
                    Button { if let p = macPath(custom) { create(p) } } label: { Label("Start session here", systemImage: "arrow.right.circle.fill") }
                        .disabled(macPath(custom) == nil)
                } header: { Text("Other folder on Mac") } footer: {
                    if !custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && macPath(custom) == nil {
                        Text("Path must start with / or ~").foregroundStyle(.red)
                    } else { Text("Absolute path of a folder on your Mac") }
                }
            }
            .searchable(text: $q, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search projects and folders")
            .navigationTitle("New session").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
    // Text params: literals localize, paths/titles stay verbatim.
    func row(_ title: Text, _ sub: Text, _ icon: String, checked: Bool = false) -> some View {
        Label {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    title.foregroundStyle(.primary).lineLimit(1)
                    sub.font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                }
                Spacer()
                if checked { Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityLabel("Current filter") }
            }
        } icon: { Image(systemName: icon).foregroundStyle(.tint) }
    }
    func create(_ cwd: String?, _ workspace: String? = nil) {
        dismiss(); c.run { try await c.create(cwd: cwd, workspaceId: workspace) }
    }
}

// MARK: - Agents

struct AgentsView: View {
    @EnvironmentObject var c: Client
    @State private var objective = ""
    @State private var confirmClear = false
    @State private var risky: Preset? // desktop confirms before full access / auto
    @State private var messaging: Sess?
    @State private var subText = ""
    var body: some View {
        NavigationStack {
            List {
                if let s = c.currentSess {
                    Section("Agent preset") {
                        ForEach(c.presets) { p in
                            Button { c.run { try await c.selectPreset(p.id) } } label: {
                                HStack {
                                    VStack(alignment: .leading) { Text(p.name); if let d = p.desc ?? (p.isDefault ? "Default" : nil) { Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2) } }
                                    Spacer(); if s.preset == p.id || (s.preset == nil && p.isDefault) { Image(systemName: "checkmark") }
                                }
                            }.disabled(p.broken)
                        }
                    }
                    if !c.perms.isEmpty {
                        Section {
                            ForEach(c.perms) { p in
                                Button { if ["danger-full-access", "auto"].contains(p.id) { risky = p } else { c.run { try await c.selectPermission(p.id) } } } label: {
                                    HStack {
                                        VStack(alignment: .leading) { Text(p.name); if let d = p.desc { Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2) } }
                                        Spacer(); if s.permission == p.id { Image(systemName: "checkmark") }
                                    }
                                }
                            }
                        } header: { Text("Permissions") } footer: { Text("What the agent may do on your Mac without asking.") }
                    }
                    Section("Goal") {
                        if let g = c.goal {
                            Text(g.objective)
                            LabeledContent("Status", value: g.phase)
                            LabeledContent("Rounds", value: g.max > 0 ? "\(g.rounds)/\(g.max)" : "\(g.rounds)")
                            if let b = g.blocked { Text(b).font(.caption).foregroundStyle(.orange) }
                            HStack {
                                if g.paused { Button("Resume") { act("resume") } } else { Button("Pause") { act("pause") } }
                                Button("Complete") { act("complete") }; Button("Clear", role: .destructive) { confirmClear = true }
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
                                // tap the title to read the subagent's own transcript
                                Button { c.open(k.id) } label: { Text(k.title).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle()) }
                                    .buttonStyle(.borderless).foregroundStyle(.primary).accessibilityHint("Opens its conversation")
                                if k.running {
                                    ProgressView()
                                    Button { c.run { try await c.interrupt(k) } } label: { Image(systemName: "stop.circle") }.accessibilityLabel("Interrupt").buttonStyle(.borderless)
                                }
                                Button { subText = ""; messaging = k } label: { Image(systemName: "bubble.left") }.accessibilityLabel("Message subagent").buttonStyle(.borderless)
                            }
                        }
                    }
                    if !c.skills.isEmpty {
                        Section("Skills") {
                            ForEach(c.skills) { k in
                                VStack(alignment: .leading, spacing: 2) { Text(k.name).font(.body.monospaced()); if !k.desc.isEmpty { Text(k.desc).font(.caption).foregroundStyle(.secondary).lineLimit(3) } }
                            }
                        }
                    }
                } else {
                    ContentUnavailableView("No session", systemImage: "person.2", description: Text("Open a session to manage its agents."))
                }
            }
            .navigationTitle("Agents")
            .alert(Text("Message \(messaging?.title ?? "")"), isPresented: Binding(get: { messaging != nil }, set: { if !$0 { messaging = nil } }), presenting: messaging) { k in
                TextField("Message", text: $subText, axis: .vertical)
                Button("Send") { let t = subText; c.run { try await c.promptSubagent(k, t) } }
                Button("Cancel", role: .cancel) {}
            } message: { k in Text(k.running ? "Steers its running turn." : "Queued as its next turn.") }
            .confirmationDialog(Text("Give the agent \(risky?.name ?? "")?"), isPresented: Binding(get: { risky != nil }, set: { if !$0 { risky = nil } }), titleVisibility: .visible, presenting: risky) { p in
                Button("Allow", role: .destructive) { c.run { try await c.selectPermission(p.id) } }
            } message: { p in Text(p.id == "auto" ? "Actions run after an automatic safety review instead of asking you. Experimental." : "It can change files and run commands anywhere on your Mac without asking.") }
            .confirmationDialog("Clear this goal?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Clear goal", role: .destructive) { act("clear") }
            } message: { Text("The agent stops working toward it. This can't be undone.") }
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
                        LabeledContent("Local network", value: "\(p.host):\(p.port)").textSelection(.enabled)
                        LabeledContent("Tailscale", value: p.ts.map { "\($0):\(p.port)" } ?? "—").textSelection(.enabled)
                        LabeledContent("Route", value: c.route == .lan ? String(localized: "Local network") : c.route == .tailscale ? "Tailscale" : "—")
                        if c.state != .connected, let f = c.lastFail { Text(f).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                        LabeledContent("Certificate", value: String(p.fp.prefix(16)) + "…").font(.caption.monospaced())
                    }
                    Button("Reconnect") { c.reconnect() }
                }
                if c.pairing != nil {
                    Section {
                        LabeledContent("Shortcut", value: c.tsReady ? String(localized: "Ready") : String(localized: "Not added"))
                        TailscaleShortcutLink()
                        Button("Connect Tailscale now") { c.openTailscale() }
                        Toggle("Run the shortcut when the Mac is unreachable", isOn: $c.tsAuto).disabled(!c.tsReady)
                    } header: { Text("Tailscale") } footer: {
                        Text("Silent, no app switching: in Shortcuts › Automation › + › App › Tether › Is Opened › Run Immediately, add Tailscale › Connect. Tailscale connects in the background with just a banner, and Tether reconnects the moment the tunnel is up. Or turn on VPN On Demand in Tailscale's settings. The toggle above opens the Shortcuts app instead, so leave it off with an automation.")
                    }
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
                        let exp = try? Date(p.expiresAt, strategy: .iso8601)
                        LabeledContent("Token expires") {
                            // Warn a week ahead so the user re-pairs at home instead of losing access while away.
                            Text(exp?.formatted(date: .abbreviated, time: .shortened) ?? p.expiresAt)
                                .foregroundStyle(exp.map { $0.timeIntervalSinceNow < 7 * 86400 } == true ? .orange : .secondary)
                        }
                        LabeledContent("App version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")
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
                if let a = p.agentId {
                    LabeledContent("Session", value: c.title(a))
                    // The command is only known from the session's transcript; load it so the user can see what they allow.
                    if p.event == "approval/request", a != c.current { Button("Show the command") { c.open(a) } }
                }
                if p.event == "approval/request" {
                    Section("Tool") {
                        Text(p.request["toolName"] as? String ?? "?").font(.headline.monospaced())
                        if let r = ((p.request["displayReason"] as? J)?["en"] as? String) ?? p.request["reason"] as? String { Text(r) }
                        if p.agentId == c.current, let call = approvalCall(p.request, in: c.transcript) {
                            Text(call.text).font(.subheadline)
                            if let a = call.args, !a.isEmpty {
                                ScrollView { Text(a).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                                    .frame(maxHeight: 180)
                            }
                        }
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
                            if let ap = q.approve {
                                Button { sendAnswers([q.id: [ap]]) } label: { Label(ap, systemImage: "checkmark.circle.fill").bold() }
                            }
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
                // Projection questions have no "next handler"; they stay open on the Mac and would just reappear on the next refresh.
                if p.event != "userQuestions/answer" {
                    Section { Button("Decide on Mac") { c.run { try await c.answer(p, nil) } } } footer: { Text("Hands this prompt back to the DSH window on your Mac.") }
                }
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
    func send(_ v: String) {
        UINotificationFeedbackGenerator().notificationOccurred(v == "rejected" ? .warning : .success)
        c.run { try await c.answer(p, v) }
    }
    func sendAnswers(_ override: [String: Set<String>] = [:]) {
        let a: [J] = Question.parse(p.request).map { q in
            var item: J = ["id": q.id, "selected": Array(override[q.id] ?? picked[q.id, default: []])]
            if let t = custom[q.id]?.trimmingCharacters(in: .whitespaces), !t.isEmpty { item["custom"] = t }
            return item
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        c.run { try await c.answer(p, ["answers": a]) }
    }
}

