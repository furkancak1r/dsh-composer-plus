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
                // tether://tailscale/<ok|error|cancel>: the Tether Tailscale Shortcut finished and bounced back here.
                // tether://pair?…: the Mac's pairing code, opened from the Camera app; it asks before it connects.
                .onOpenURL { u in
                    guard u.scheme == "tether" else { return }
                    if u.host == "tailscale" { client.tailscaleReturned(u) } else if u.host == "pair" { client.openPairLink(u) }
                }
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
                // a new view tree per Mac: no scroll position, search text or sheet of one Mac stays on screen for another
                .id(c.activeFp)
                .sheet(item: Binding(get: { c.prompts.first }, set: { _ in })) { PromptSheet(p: $0).interactiveDismissDisabled() }
                .sheet(isPresented: $c.addingMac) { PairView(adding: true) }
                .alert(Text(c.renamingMac?.label == nil ? "Name this Mac" : "Rename Mac"), isPresented: Binding(get: { c.renamingMac != nil }, set: { if !$0 { c.renamingMac = nil } }), presenting: c.renamingMac) { p in
                    TextField("Name", text: $c.renameText)
                    Button("Save") { c.renameMac(p.fp, c.renameText) }
                    Button("Cancel", role: .cancel) {}
                } message: { p in
                    Text("Tether shows this name for the Mac, only on this iPhone. Leave it empty to use the Mac's own name: \(p.mac ?? p.host).")
                }
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

/// DSH desktop's "Running" mark (its StateDot "ongoing"): a faint ring with an arc that turns. Green means
/// "Completed" there, so a running chat must not be green here.
struct RunningSpinner: View {
    var size: CGFloat = 14
    @Environment(\.accessibilityReduceMotion) private var still
    var body: some View {
        // TimelineView, not a repeatForever animation: that one also moves the row in a List when it appears.
        TimelineView(.animation(paused: still)) { ctx in
            let turn = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.5) / 1.5
            ZStack {
                Circle().stroke(lineWidth: 2).opacity(0.25)
                Circle().trim(from: 0, to: 0.3).stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(still ? -90 : turn * 360 - 90))
            }
            .padding(1)
        }
        // Color.secondary, not .secondary: inside a Button the hierarchical style turns into the blue tint
        .foregroundStyle(Color.secondary)
        .frame(width: size, height: size)
    }
}

/// Project status marker (Composer Plus), the same marks as a chat row: waiting hand, green dot, spinner.
struct ProjectMarkView: View {
    let mark: ProjectMark
    var body: some View {
        switch mark {
        case .waiting: Image(systemName: "hand.raised.fill").font(.caption).foregroundStyle(.orange).accessibilityLabel("A chat is waiting for you")
        case .done: Circle().fill(.green).frame(width: 8, height: 8).accessibilityLabel("A chat finished")
        case .running(let n): RunningSpinner(size: 12).accessibilityLabel(Text("\(n) chat(s) running"))
        }
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

/// Top-left of every tab: the connection badge and the Mac on screen. Tap to switch to another paired Mac or add one.
/// Any number of Macs; only the one on screen is connected.
struct MacPicker: View {
    @EnvironmentObject var c: Client
    var body: some View {
        Menu {
            Picker("Mac", selection: Binding(get: { c.activeFp ?? "" }, set: { c.switchMac($0) })) {
                ForEach(c.pairings) { p in Label(p.title, systemImage: "laptopcomputer").tag(p.fp) }
            }
            Divider()
            if let p = c.pairing { Button { c.renamingMac = p } label: { Label("Rename this Mac…", systemImage: "pencil") } }
            Button { c.addingMac = true } label: { Label("Add a Mac…", systemImage: "plus") }
        } label: {
            HStack(spacing: 6) {
                ConnBadge()
                Text(c.pairing?.title ?? "").font(.subheadline.weight(.semibold)).lineLimit(1).frame(maxWidth: 150, alignment: .leading)
                Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
            }
            .foregroundStyle(.primary)
        }
        .accessibilityLabel("Mac")
        .accessibilityValue(Text("\(c.pairing?.title ?? ""), \(String(localized: String.LocalizationValue(c.state.rawValue)))"))
        .accessibilityHint("Switches to another Mac")
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
            // The Mac made a new certificate (or this pairing was removed there): a new code is the fix.
            Button("Scan a new code") { c.addingMac = true }.font(.footnote)
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

/// First screen and the "Add a Mac" sheet. One clear action (scan), what happens on the Mac, then a status card
/// that follows the pairing: code read → waiting for Approve → connected, or what went wrong and what to do.
struct PairView: View {
    @EnvironmentObject var c: Client
    @Environment(\.dismiss) private var dismiss
    /// Shown as a sheet from the Mac picker to pair one more Mac; the Macs already paired stay.
    var adding = false
    @State private var scanning = false
    @State private var pasting = false
    @State private var pasted = ""
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if c.pairPhase != .idle { PairStatusCard() }
                    else if let inv = c.linkInvite { LinkConfirmCard(inv: inv) }
                    else { intro }
                }
                .padding(.horizontal, 22).padding(.top, adding ? 8 : 28).padding(.bottom, 32)
                .animation(.snappy, value: c.pairPhase)
            }
            .scrollBounceBehavior(.basedOnSize)
            .navigationTitle(adding ? "Add a Mac" : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { if adding { ToolbarItem(placement: .cancellationAction) { Button("Close") { c.cancelPair(); dismiss() } } } }
            // A swipe must not hide a pairing that still waits for Approve; Close cancels it on purpose.
            .interactiveDismissDisabled(c.pairPhase.busy)
            .onDisappear { if adding { c.resetPair(); c.linkInvite = nil } }
            .sheet(isPresented: $scanning) { ScanSheet { s in scanning = false; use(s) } }
            .alert("Paste pairing link", isPresented: $pasting) {
                TextField("tether://pair?…", text: $pasted).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button("Connect") { use(pasted); pasted = "" }
                Button("Cancel", role: .cancel) { pasted = "" }
            } message: { Text("On the Mac, click Copy pairing link under the code. Then paste it here.") }
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 22) {
            if !adding {
                VStack(alignment: .leading, spacing: 6) {
                    Image(systemName: "laptopcomputer.and.iphone").font(.system(size: 34, weight: .regular)).foregroundStyle(.tint).padding(.bottom, 6).accessibilityHidden(true)
                    Text("Connect to your Mac").font(.title.bold())
                    Text("Use DeepSeek Harness on your Mac from this iPhone.").foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 14) {
                Step(n: 1, text: "On the Mac, open DeepSeek Harness. Click **Mobile connect** at the bottom left. (First time: turn it on in Settings › Composer Plus.)")
                Step(n: 2, text: "Scan the code on the Mac with the button below. The iPhone Camera works too: tap **Open in Tether**.")
                Step(n: 3, text: "Click **Approve** on the Mac.")
            }
            Button { scanning = true } label: { Label("Scan code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity).padding(.vertical, 6) }
                .buttonStyle(.borderedProminent).controlSize(.large)
            // Macs already paired are not offered again (same certificate fingerprint).
            let fresh = c.found.values.filter { f in !c.pairings.contains { $0.fp == f.fp } }.sorted { $0.name < $1.name }
            if !fresh.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Macs on this Wi‑Fi").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(fresh) { f in Label(f.name, systemImage: "laptopcomputer").font(.subheadline) }
                    Text("Scan the code on that Mac to connect.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Button("Paste a pairing link instead") { pasting = true }.font(.footnote)
            Text("The iPhone and the Mac must be on the same Wi‑Fi, or both on Tailscale.").font(.footnote).foregroundStyle(.secondary)
        }
    }

    func use(_ s: String) {
        guard let inv = parseInvite(s) else { c.error = String(localized: "That isn't a Tether code. Scan the code under Mobile connect on the Mac."); return }
        Task { await c.pair(inv) } // paired: the new Mac is on screen and the sheet closes (Client.adopt)
    }
}

private struct Step: View {
    let n: Int; let text: LocalizedStringKey
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(n)").font(.footnote.weight(.bold)).frame(width: 22, height: 22).background(Circle().strokeBorder(.tertiary))
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The pairing in progress, or how it ended.
private struct PairStatusCard: View {
    @EnvironmentObject var c: Client
    var body: some View {
        VStack(spacing: 16) {
            switch c.pairPhase {
            case .connecting(let mac):
                ProgressView().controlSize(.large).padding(.top, 8)
                Text("Code read").font(.title3.bold())
                Text("Connecting to \(mac)…").foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("Cancel", role: .cancel) { c.cancelPair() }
            case .waiting(let mac, let until):
                Image(systemName: "hand.tap").font(.system(size: 40)).foregroundStyle(.tint).symbolEffect(.pulse, options: .repeating).accessibilityHidden(true)
                Text("Click Approve on \(mac)").font(.title3.bold()).multilineTextAlignment(.center)
                Text("The Mac shows this iPhone's name. Keep Tether open until you click Approve.").foregroundStyle(.secondary).multilineTextAlignment(.center)
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let s = max(0, Int(until.timeIntervalSince(ctx.date)))
                    Text("\(s / 60):\(String(format: "%02d", s % 60)) left").font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
                }
                Button("Cancel", role: .cancel) { c.cancelPair() }
            case .done(let mac):
                Image(systemName: "checkmark.circle.fill").font(.system(size: 48)).foregroundStyle(.green).symbolEffect(.bounce, value: mac).accessibilityHidden(true)
                Text("Connected to \(mac)").font(.title3.bold()).multilineTextAlignment(.center)
            case .failed(let why):
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 40)).foregroundStyle(.orange).accessibilityHidden(true)
                Text("Not connected").font(.title3.bold())
                Text(why).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("Try again") { c.resetPair() }.buttonStyle(.borderedProminent)
            case .idle: EmptyView()
            }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 28).padding(.horizontal, 20)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .contain)
    }
}

/// A tether://pair link from the Camera app: say which Mac, connect only on a tap.
private struct LinkConfirmCard: View {
    @EnvironmentObject var c: Client
    let inv: Invite
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "laptopcomputer").font(.system(size: 40)).foregroundStyle(.tint).padding(.top, 6).accessibilityHidden(true)
            Text("Connect to \(c.shownName(inv))?").font(.title3.bold()).multilineTextAlignment(.center)
            // A link can come from any app or web page: show where it points, so a stranger's link stands out.
            Text("\(inv.host) · on your network").font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
            Text("Then click Approve on the Mac.").foregroundStyle(.secondary)
            Button { Task { await c.pair(inv) } } label: { Text("Connect").frame(maxWidth: .infinity).padding(.vertical, 6) }
                .buttonStyle(.borderedProminent).controlSize(.large)
            Button("Cancel", role: .cancel) { c.linkInvite = nil }
        }
        .frame(maxWidth: .infinity).padding(24)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 20))
    }
}

/// Full-screen scanner with a frame, a hint and a close button. A QR that is not a Tether code says so and scanning
/// goes on; a Tether code closes the sheet at once with a tap on the wrist (haptic) and the status card takes over.
struct ScanSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var wrong = false
    var body: some View {
        ZStack {
            QRScanner { s in
                guard parseInvite(s) != nil else { wrong = true; UINotificationFeedbackGenerator().notificationOccurred(.warning); return false }
                UINotificationFeedbackGenerator().notificationOccurred(.success); onCode(s); return true
            }.ignoresSafeArea()
            RoundedRectangle(cornerRadius: 28).strokeBorder(.white.opacity(0.9), lineWidth: 3).frame(width: 250, height: 250).accessibilityHidden(true)
            VStack {
                HStack { Spacer(); Button { dismiss() } label: { Image(systemName: "xmark").font(.headline).padding(12).background(.ultraThinMaterial, in: Circle()) }.accessibilityLabel("Close") }
                Spacer()
                Text(wrong ? "That isn't a Tether code. Point at the code under Mobile connect on the Mac." : "Point at the code on the Mac")
                    .font(.callout.weight(.medium)).multilineTextAlignment(.center)
                    .padding(.horizontal, 16).padding(.vertical, 10).background(.ultraThinMaterial, in: Capsule())
                    .animation(.snappy, value: wrong)
            }
            .padding(20).foregroundStyle(.white)
        }
        .background(.black)
        .task(id: wrong) { if wrong { try? await Task.sleep(for: .seconds(3)); wrong = false } }
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
    /// Returns true when the code was used (scanning stops), false to keep scanning.
    let onCode: (String) -> Bool
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
        let session = AVCaptureSession(), onCode: (String) -> Bool
        var done = false, lastBad = ""
        init(_ f: @escaping (String) -> Bool) { onCode = f }
        func metadataOutput(_ o: AVCaptureMetadataOutput, didOutput objs: [AVMetadataObject], from: AVCaptureConnection) {
            guard !done, let s = (objs.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            guard s != lastBad else { return } // the same wrong code stays in view: say it once
            if onCode(s) { done = true } else { lastBad = s }
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
    /// Finished turns the user opened. A new chat starts with every finished turn folded, as DSH desktop does.
    @State private var openTurns = Set<UUID>()
    @State private var showUsage = false
    @State private var showChanges = false
    @State private var showIdeas = false
    @State private var deleting = false
    /// Turn rollback: the user row whose ↶ was tapped.
    @State private var rollingBack: Line?
    // fallback only: used when the turn/start event carried no time
    @State private var turnStart: Date?
    /// Complete while typing: the Mac's answer for the text `asked`.
    @State private var guess: (asked: String, completion: String)?
    @FocusState private var focused: Bool
    /// With more than one Mac, the chat says which Mac it runs on.
    private var macSubtitle: String { c.pairings.count > 1 ? c.pairing?.title ?? "" : "" }
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
                    if !macSubtitle.isEmpty { Label(macSubtitle, systemImage: "laptopcomputer") }
                    if let id = c.current {
                        if let p = c.currentSess?.parent { Button { c.open(p) } label: { Label("Open parent session", systemImage: "arrow.turn.left.up") } }
                        Button { newTitle = c.currentSess?.title ?? ""; renaming = true } label: { Label("Rename", systemImage: "pencil") }
                        Button { editGoal() } label: { Label(c.goal == nil ? String(localized: "Set goal…") : String(localized: "Edit goal…"), systemImage: "target") }
                        Button { c.run { try await c.fork(id) } } label: { Label("Fork", systemImage: "arrow.triangle.branch") }
                        Button { c.run { try await c.togglePin(id) } } label: { Label(c.pinned.contains(id) ? String(localized: "Unpin") : String(localized: "Pin"), systemImage: "pin") }
                        // Composer Plus (on the Mac): shown only when the Mac's plugin has the route
                        if let g = c.grants[id], !g.isEmpty {
                            Button { c.run { try await c.revokeGrants(id) } } label: { Label("\(g.count) tool(s) allowed · Revoke", systemImage: "checkmark.shield") }
                        }
                        if c.plus.contains("changes") { Button { showChanges = true } label: { Label("Changes", systemImage: "plusminus") } }
                        if c.plus.contains("ideas") { Button { showIdeas = true } label: { Label("Feature ideas", systemImage: "lightbulb") } }
                        Button { UIPasteboard.general.string = sessionLink(id); UINotificationFeedbackGenerator().notificationOccurred(.success) } label: { Label("Copy session link", systemImage: "link") }
                        if c.transcript.contains(where: { $0.kind == .assistant }) {
                            Button {
                                UIPasteboard.general.string = transcriptMarkdown(c.transcript, title: c.currentSess?.title ?? String(localized: "Conversation"))
                                UINotificationFeedbackGenerator().notificationOccurred(.success)
                            } label: { Label("Copy conversation", systemImage: "doc.on.doc") }
                            ShareLink(item: transcriptMarkdown(c.transcript, title: c.currentSess?.title ?? String(localized: "Conversation"))) { Label("Share conversation", systemImage: "square.and.arrow.up") }
                        }
                        Button(role: .destructive) { let was = c.archived.contains(id); c.run { try await c.toggleArchive(id); if !was { c.path = [] } } } label: { Label(c.archived.contains(id) ? String(localized: "Unarchive") : String(localized: "Archive"), systemImage: "archivebox") }
                        if c.plus.contains("delete-chat"), c.currentSess?.parent == nil { Button(role: .destructive) { deleting = true } label: { Label("Delete…", systemImage: "trash") } }
                    }
                }
            }
            .sheet(isPresented: $creating) { NewSessionSheet() }
            .sheet(isPresented: $showChanges) { if let id = c.current { ChangesSheet(sessionId: id) } }
            .sheet(isPresented: $showIdeas) { if let id = c.current { IdeasSheet(sessionId: id) } }
            .sheet(item: $rollingBack) { l in RollbackSheet(line: l) { t in if text.isEmpty { text = t; focused = true } } }
            .confirmationDialog("Delete this chat?", isPresented: $deleting, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { if let id = c.current { c.run { try await c.deleteChat(id) } } }
            } message: { Text("“\(c.currentSess?.title ?? "")” stops and its saved history, with its subagent chats, moves to the Trash on your Mac. To get it back, put the folder back and restart DSH.") }
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
            .onChange(of: c.current) { text = c.draft(c.current); guess = nil }
            .onChange(of: text) { c.setDraft(text, c.current) }
            // Complete while typing: ask after a pause; a newer keystroke cancels this task. Typing along the guess needs no ask.
            .task(id: text) {
                if let g = guess, completionRest(typed: text, asked: g.asked, completion: g.completion) != nil { return }
                guess = nil
                guard focused, completable(text) else { return }
                try? await Task.sleep(for: .milliseconds(450))
                guard !Task.isCancelled else { return }
                let asked = text
                if let rest = await c.complete(asked), !Task.isCancelled, text == asked { guess = (asked, rest) }
            }
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
                        // DSH desktop's shape: thinking and tool calls fold into one step row; a finished turn folds to
                        // "Completed in …" and its answer until tapped.
                        ForEach(chatRows(c.transcript, open: openTurns, running: c.running)) { row in
                            switch row {
                            case .line(let l): LineView(line: l, onEdit: { text = $0; focused = true }, onRollback: canRollBack(l) ? { rollingBack = l } : nil)
                            case .steps(let ls, let live): StepsView(lines: ls, live: live && c.streaming.isEmpty)
                            case .turn(let l, let foldable):
                                TurnRow(line: l, foldable: foldable, open: openTurns.contains(l.id)) {
                                    withAnimation(.snappy) { if openTurns.contains(l.id) { openTurns.remove(l.id) } else { openTurns.insert(l.id) } }
                                }
                            }
                        }
                        if !c.reasoning.isEmpty { StepsView(lines: [Line(kind: .reasoning, text: c.reasoning)], live: true) }
                        if !c.streaming.isEmpty { LineView(line: Line(kind: .assistant, text: c.streaming), live: true) }
                        // upload/send progress first, so a large file never looks like a dead Send button
                        if let s = c.sendStatus ?? (c.running && c.streaming.isEmpty && c.reasoning.isEmpty && c.transcript.last?.kind != .tool ? String(localized: "Working…") : nil) {
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
                .onChange(of: c.current) { openTurns = [] }
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
                // Queue reorder (Composer Plus): only the next-turn rows move, and only past text-only rows.
                let at = (c.inbox["next-turn"] ?? []).firstIndex { $0["id"] as? String == id }
                HStack(spacing: 8) {
                    Image(systemName: steering ? "arrow.turn.down.right" : "clock").font(.caption).foregroundStyle(.secondary)
                    Text(contentText(item["content"])).font(.footnote).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    Menu {
                        if !steering { Button { c.run { try await c.updateQueue(id, ["kind": "steer"]) } } label: { Label("Send now", systemImage: "arrow.up") } }
                        if let at, c.canMoveQueued(from: at, to: at - 1) { Button { c.run { try await c.moveQueued(from: at, to: at - 1) } } label: { Label("Move up", systemImage: "arrow.up.to.line") }.disabled(c.movingQueue) }
                        if let at, c.canMoveQueued(from: at, to: at + 1) { Button { c.run { try await c.moveQueued(from: at, to: at + 1) } } label: { Label("Move down", systemImage: "arrow.down.to.line") }.disabled(c.movingQueue) }
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
            // Next message prediction (Composer Plus): the guess for this chat, over an empty composer; a tap puts it in.
            if let p = c.prediction, text.isEmpty, images.isEmpty, files.isEmpty, !c.running {
                Button { text = p.text; c.prediction = nil; focused = true } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles").font(.caption).foregroundStyle(.secondary)
                        Text(verbatim: p.text).font(.subheadline).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Text("Tap to use").font(.caption2).foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 6).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Suggested next message: \(p.text)"))
                .accessibilityHint(Text("Puts it in the message field"))
            }
            // Complete while typing (Composer Plus): how the message may go on; a tap adds it at the end.
            if let g = guess, let rest = completionRest(typed: text, asked: g.asked, completion: g.completion) {
                Button { text += rest; guess = nil; focused = true } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "text.cursor").font(.caption).foregroundStyle(.secondary)
                        (Text(verbatim: "…") + Text(verbatim: rest.trimmingCharacters(in: .whitespaces))).font(.subheadline).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Text("Tap to add").font(.caption2).foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 6).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Suggested completion: \(rest)"))
                .accessibilityHint(Text("Adds it to the message"))
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
                planButton
                Spacer(minLength: 0)
                if c.running && canSend { roundButton("arrow.up", action: send).accessibilityLabel("Queue") }
                if c.running { roundButton("stop.fill") { c.run { try await c.stop() } }.accessibilityLabel("Stop") }
                // One-click Continue (Composer Plus): after a stopped, failed or cut-off turn, an empty composer resumes it
                else if showContinue { roundButton("play.fill") { c.run { try await c.continueTurn() } }.accessibilityLabel("Continue") }
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

    private var showContinue: Bool {
        c.plus.contains("continue") && c.continueSeq != nil && !canSend && c.currentSess?.parent == nil
    }
    /// Plan mode (Composer Plus plan toggle): in plan mode, tap leaves it; else it adds or drops a leading `/plan`.
    @ViewBuilder private var planButton: some View {
        let on = planOn(c.currentSess?.plan), drafted = text.range(of: #"^/plan(?=$|\s)"#, options: .regularExpression) != nil
        Button {
            if on { c.run { try await c.leavePlan() } } else { text = planToggled(text) }
            UISelectionFeedbackGenerator().selectionChanged()
        } label: {
            Image(systemName: "list.bullet.clipboard").font(.footnote.weight(.medium))
                .foregroundStyle(on || drafted ? Color.accentColor : Color.secondary)
                .frame(width: 32, height: 32).background(on || drafted ? Color.accentColor.opacity(0.15) : Color(.tertiarySystemFill), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(on ? "Leave plan mode" : drafted ? "Remove /plan" : "Plan first")
    }
    /// ↶ on your own messages (Composer Plus turn rollback): only in a top-level chat, not while a rollback runs.
    private func canRollBack(_ l: Line) -> Bool { l.kind == .user && l.seq != nil && c.rollbackOn && c.currentSess?.parent == nil }

    func roundButton(_ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 14, weight: .bold)).foregroundStyle(Color(.systemBackground))
                .frame(width: 32, height: 32).background(Color.primary, in: Circle())
        }
        .buttonStyle(.plain).opacity(canSend || c.running || (icon == "play.fill") ? 1 : 0.3)
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
    /// Turn rollback (Composer Plus): nil when this row cannot be rolled back.
    var onRollback: (() -> Void)? = nil
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
                if let onRollback { Button(action: onRollback) { Label("Roll back to before this message", systemImage: "arrow.uturn.backward") } }
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
            // Only inside an open step group (StepsView), which is the fold: the text shows at once.
            Text(line.text).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
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
        case .turn: EmptyView() // shown by TurnRow
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

/// Thinking and tool calls in a row, folded into one line as in DSH desktop: "Read files and searched code" with an
/// icon and a chevron; tap to see each step. The step that runs now says what it does and stays folded too.
struct StepsView: View {
    let lines: [Line]
    let live: Bool
    @State private var open = false
    var body: some View {
        let (title, kind) = stepsTitle(lines, live: live)
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    if live { RunningSpinner(size: 13) } else { Image(systemName: stepIcon(kind)).frame(width: 14) }
                    Text(title).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).rotationEffect(.degrees(open ? 180 : 0))
                    Spacer(minLength: 0)
                }
                .font(.footnote).foregroundStyle(Color.secondary).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(Text(open ? "Expanded" : "Collapsed"))
            if open {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(lines) { l in LineView(line: l, live: live && l.id == lines.last?.id && l.kind == .reasoning) }
                }
                .padding(.leading, 10).overlay(alignment: .leading) { Rectangle().fill(Color(.separator)).frame(width: 1) }
            }
        }
    }
    private func stepIcon(_ k: String) -> String {
        switch k {
        case "read", "readImage": "doc.text"
        case "search": "magnifyingglass"
        case "write", "edit": "pencil"
        case "commands", "code": "terminal"
        case "webSearch", "webFetch": "globe"
        case "subagents": "person.2"
        case "plan": "checklist"
        case "questions": "questionmark.bubble"
        case "thinking": "brain"
        default: "wrench.and.screwdriver"
        }
    }
}

/// A finished turn's summary row, as in DSH desktop: "Completed in 1m 5s" with a thin line under it. Tap to show or
/// hide the turn's steps; the answer stays visible. A failed or stopped turn shows "Failed" / "Stopped" and stays open.
struct TurnRow: View {
    let line: Line
    let foldable: Bool
    let open: Bool
    let toggle: () -> Void
    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 4) {
                Text(line.text).monospacedDigit().lineLimit(1)
                if foldable { Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).rotationEffect(.degrees(open ? 180 : 0)) }
                Spacer(minLength: 0)
            }
            .font(.footnote).foregroundStyle(line.failed ? Color.red.opacity(0.8) : Color.secondary)
            .padding(.bottom, 8).contentShape(Rectangle())
            .overlay(alignment: .bottom) { Rectangle().fill(Color(.separator)).frame(height: 0.5) }
        }
        .buttonStyle(.plain).disabled(!foldable)
        .accessibilityValue(foldable ? Text(open ? "Expanded" : "Collapsed") : Text(""))
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
    @State private var deleting: Sess?
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
                        // accordion like the desktop sidebar; Archived starts folded; a folded group shows no chats, as on the desktop
                        let folded = groupFolded(shownFolds, g.title)
                        Section {
                            // List's own row insert animation; a custom .move transition made rows pop in on expand
                            ForEach(folded ? [] : g.items) { s in sessionRow(s) }
                        } header: {
                            Button {
                                withAnimation(.snappy(duration: 0.3)) { shownFolds = toggledFold(shownFolds, g.title) }
                                folds = shownFolds
                            } label: {
                                HStack {
                                    Label("\(g.title) (\(g.items.count))", systemImage: groupIcon(g.title))
                                    Spacer()
                                    // Project status (Composer Plus): a folded project still says that a chat works or waits
                                    if let m = projectMark(g.items, all: c.sessions, waiting: c.waitingChats, finished: c.finished) { ProjectMarkView(mark: m) }
                                    Image(systemName: "chevron.right").rotationEffect(.degrees(folded ? 0 : 90))
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .contextMenu { if let path = g.path { Button { UIPasteboard.general.string = path } label: { Label("Copy path", systemImage: "doc.on.doc") } } }
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
                ToolbarItem(placement: .topBarLeading) { MacPicker() }
                // Collapse all projects (Composer Plus): in view only while a project is open, as on the desktop
                if c.state == .connected && query.isEmpty && !openProjects(c.sessionGroups(project: project.isEmpty ? nil : project), folds: shownFolds).isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { collapseAll() } label: { Image(systemName: "rectangle.compress.vertical") }
                            .accessibilityLabel("Collapse all projects")
                    }
                }
                if c.state == .connected {
                    ToolbarItem(placement: .topBarTrailing) {
                        let active = c.workspaces.first { $0.id == project }
                        Menu {
                            if !c.workspaces.isEmpty {
                                Picker("Project", selection: $project) {
                                    Text("All projects").tag("")
                                    ForEach(c.workspaces) { Text($0.title).tag($0.id) }
                                }
                            }
                            // dsh's Group by (this iPhone only)
                            Picker("Group by", selection: $c.oneList) {
                                Label("By project", systemImage: "folder").tag(false)
                                Label("In one list", systemImage: "list.bullet").tag(true)
                            }
                            // Composer Plus view options (this iPhone only)
                            Toggle("Active in the last 2 hours", isOn: $c.recentOnly)
                            Toggle("Order by status", isOn: $c.byStatus)
                        } label: { Image(systemName: active == nil && !c.recentOnly && !c.byStatus && !c.oneList ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill") }
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
            .confirmationDialog("Delete this chat?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { s in
                Button("Delete", role: .destructive) { c.run { try await c.deleteChat(s.id) } }
            } message: { s in Text("“\(s.title)” stops and its saved history, with its subagent chats, moves to the Trash on your Mac. To get it back, put the folder back and restart DSH.") }
        }
    }
    /// Collapse all projects (Composer Plus): every open project group folds; Pinned and Archived keep their state.
    private func collapseAll() {
        var f = shownFolds
        for title in openProjects(c.sessionGroups(project: project.isEmpty ? nil : project), folds: f) { f = toggledFold(f, title) }
        withAnimation(.snappy(duration: 0.3)) { shownFolds = f }
        folds = f
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
                Button { UIPasteboard.general.string = sessionLink(s.id) } label: { Label("Copy session link", systemImage: "link") }
                if c.plus.contains("delete-chat") { Button(role: .destructive) { deleting = s } label: { Label("Delete…", systemImage: "trash") } }
            }
    }
    func row(_ s: Sess) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if c.pinned.contains(s.id) { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange) }
                    // Color.primary: in a Button, .primary is the blue tint and every chat looks like a link
                    Text(s.title).foregroundStyle(Color.primary).lineLimit(1)
                }
                HStack(spacing: 0) {
                    Text([s.model, (s.cwd as NSString).lastPathComponent].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    if let d = s.updated { Text(" · ") + Text(d, format: .relative(presentation: .named, unitsStyle: .abbreviated)) }
                }
                .font(.caption).foregroundStyle(Color.secondary).lineLimit(1)
            }
            Spacer()
            if let g = s.goal, !g.phase.hasPrefix("complete") { Image(systemName: "target").font(.caption).foregroundStyle(g.paused ? Color.secondary : Color.accentColor).accessibilityLabel("Goal: \(g.summary)") }
            if c.prompts.contains(where: { $0.agentId == s.id }) { Image(systemName: "hand.raised.fill").foregroundStyle(.orange).accessibilityLabel("Waiting for you") }
            // DSH desktop's marks: a turning ring while it runs (also while a subagent runs), green when it finished
            if isRunning(s, c.sessions) { RunningSpinner().accessibilityLabel("Running") }
            else if c.finished.contains(s.id) { Circle().fill(.green).frame(width: 8, height: 8).accessibilityLabel("Finished") }
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
    // Extra folders: cwds of all sessions (session/list is unpaged), minus the DSH projects already listed.
    var folders: [String] { recentFolders(c.sessions, excluding: Set(c.workspaces.map(\.path))).filter { searchHit(q, $0) } }
    var projects: [Workspace] { pickerProjects(c.workspaces, query: q) } // A–Z, as in Composer Plus on the Mac
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
            .searchable(text: $q, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search projects and folders")
            .onSubmit(of: .search) { // Return picks the first match, as on the Mac
                if !q.trimmingCharacters(in: .whitespaces).isEmpty, let w = projects.first { create(w.path, w.id) }
            }
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
                                    RunningSpinner().accessibilityLabel("Running")
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
            .toolbar { ToolbarItem(placement: .topBarLeading) { MacPicker() } }
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
    @State private var removing: Pairing?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(c.pairings) { p in
                        // Two styled buttons: in a Form row, default-style buttons would all fire on one tap.
                        HStack {
                            Button { c.switchMac(p.fp) } label: {
                                HStack {
                                    Label {
                                        VStack(alignment: .leading) {
                                            Text(p.title).foregroundStyle(.primary)
                                            // with the user's own name, the Mac's name stays visible under it
                                            Text(verbatim: [p.label == nil ? nil : p.mac, p.host].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                                        }
                                    } icon: { Image(systemName: "laptopcomputer").foregroundStyle(.tint) }
                                    Spacer()
                                    if p.fp == c.activeFp { Image(systemName: "checkmark").foregroundStyle(Color.accentColor).accessibilityLabel("On screen") }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            Button { c.renamingMac = p } label: { Image(systemName: "pencil").padding(.leading, 8) }
                                .buttonStyle(.borderless).accessibilityLabel(Text("Rename \(p.title)"))
                        }
                        .swipeActions {
                            Button(role: .destructive) { removing = p } label: { Label("Unpair", systemImage: "trash") }
                            Button { c.renamingMac = p } label: { Label("Rename", systemImage: "pencil") }.tint(.blue)
                        }
                        .contextMenu {
                            Button { c.renamingMac = p } label: { Label("Rename", systemImage: "pencil") }
                            Button(role: .destructive) { removing = p } label: { Label("Unpair", systemImage: "trash") }
                        }
                    }
                    Button { c.addingMac = true } label: { Label("Add a Mac…", systemImage: "plus") }
                } header: { Text("Macs") } footer: { Text("Pair as many Macs as you like. Only the Mac on screen is connected; switch with the name at the top left. Tap the pencil to give a Mac your own name.") }
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
                        // "Not checked yet", not "Not added": Tether cannot see the user's shortcuts, only a run from here.
                        LabeledContent("Shortcut", value: c.tsReady ? String(localized: "Ready") : c.tsError != nil ? String(localized: "Didn't run") : String(localized: "Not checked yet"))
                        if let e = c.tsError { Text(e).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                        if !c.tsReady { TailscaleShortcutLink() }
                        Button(c.tsReady ? LocalizedStringKey("Connect Tailscale now") : "Check the shortcut") { c.openTailscale() }
                        Toggle("Run the shortcut when the Mac is unreachable", isOn: $c.tsAuto).disabled(!c.tsReady)
                    } header: { Text("Tailscale") } footer: {
                        Text("iOS doesn't let apps see your shortcuts, so Tether can't tell that you added it. Tap Check the shortcut once: the shortcut runs, comes back to Tether, and this shows Ready. Its name must be exactly Tether Tailscale.\n\nSilent, no app switching: in Shortcuts › Automation › + › App › Tether › Is Opened › Run Immediately, add Tailscale › Connect. Tailscale connects in the background with just a banner, and Tether reconnects the moment the tunnel is up. Or turn on VPN On Demand in Tailscale's settings. The toggle above opens the Shortcuts app instead, so leave it off with an automation.")
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
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { MacPicker() }
                // number pad has no return key, so give it a Done button
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) } }
            }
            .onAppear { if let p = c.pairing { host = p.host; port = "\(p.port)" } }
            .confirmationDialog(Text("Unpair from \(c.pairing?.title ?? "")?"), isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) { c.forget() }
            } message: { Text("The token is deleted from this iPhone. Also revoke it on the Mac to invalidate it there.") }
            .confirmationDialog(Text("Unpair from \(removing?.title ?? "")?"), isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { p in
                Button("Unpair", role: .destructive) { c.forget(fp: p.fp) }
            } message: { _ in Text("The token is deleted from this iPhone. Also revoke it on the Mac to invalidate it there.") }
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
                        // Allow for this chat (Composer Plus): only for an Auto Review ask; the Mac remembers it for this chat
                        if isAutoReviewAsk, c.plus.contains("grants") {
                            Button("Allow for this chat") {
                                UINotificationFeedbackGenerator().notificationOccurred(.success)
                                c.run { try await c.allowForChat(p) }
                            }
                        }
                        Button("Deny", role: .destructive) { send("rejected") }
                    } footer: {
                        if isAutoReviewAsk, c.plus.contains("grants") { Text("Allow for this chat: \(p.request["toolName"] as? String ?? "") runs without asking for the rest of this chat, with any arguments. If the tool can write, that includes any write.") }
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
    private var isAutoReviewAsk: Bool { (p.request["reason"] as? String)?.hasPrefix("Auto review denied tool ") == true && p.agentId != nil }
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


// MARK: - Composer Plus (the dsh-composer-plus plugin on the Mac)

/// Changes panel: the chat's git changes, by mode; tap a file for its diff. Refreshes every 4 s while open.
struct ChangesSheet: View {
    @EnvironmentObject var c: Client
    @Environment(\.dismiss) private var dismiss
    let sessionId: String
    @AppStorage("changesMode") private var mode = "uncommitted"
    @State private var data: J?
    @State private var failed: String?
    private static let modes: [(id: String, label: LocalizedStringKey)] = [("uncommitted", "Uncommitted"), ("unstaged", "Unstaged"), ("staged", "Staged"), ("branch", "Branch")]
    var body: some View {
        NavigationStack {
            List {
                Picker("Mode", selection: $mode) { ForEach(Self.modes, id: \.id) { Text($0.label).tag($0.id) } }.pickerStyle(.segmented).listRowBackground(Color.clear)
                if let failed { Text(failed).foregroundStyle(.secondary) }
                else if let d = data {
                    if d["repo"] as? Bool == false { Text("This chat's folder is not a git repository.").foregroundStyle(.secondary) }
                    else if d["noUpstream"] as? Bool == true { Text("This branch has no upstream to compare with.").foregroundStyle(.secondary) }
                    else {
                        let files = d["files"] as? [J] ?? []
                        Section {
                            if files.isEmpty { Text("No file changes yet").foregroundStyle(.secondary) }
                            ForEach(files.indices, id: \.self) { i in
                                let f = files[i], path = f["path"] as? String ?? ""
                                NavigationLink { DiffView(sessionId: sessionId, mode: mode, path: path) } label: { fileRow(f) }
                            }
                            let more = (d["total"] as? Int ?? files.count) - files.count
                            if more > 0 { Text("\(more) more file(s) not shown").font(.footnote).foregroundStyle(.secondary) }
                        } header: {
                            HStack {
                                Text(d["branch"] as? String ?? "")
                                if let u = d["upstream"] as? String { Text("→ \(u)") }
                                Spacer()
                                Text("+\(d["added"] as? Int ?? 0)").foregroundStyle(.green); Text("−\(d["deleted"] as? Int ?? 0)").foregroundStyle(.red)
                            }.font(.caption.monospacedDigit())
                        }
                    }
                } else { ProgressView().frame(maxWidth: .infinity) }
            }
            .navigationTitle("Changes").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await load() }
            // the desktop panel refreshes every 4 s while it is on screen
            .task(id: mode) { data = nil; while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(4)) } }
        }
    }
    private func load() async {
        do { data = try await c.plusCall("changes", query: ["sessionId": sessionId, "mode": mode]); failed = nil }
        catch is CancellationError {} catch { failed = String(localized: "Could not read changes.") + " " + userText(error) }
    }
    private func fileRow(_ f: J) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(((f["path"] as? String ?? "") as NSString).lastPathComponent).font(.subheadline.monospaced()).lineLimit(1)
                Text(((f["path"] as? String ?? "") as NSString).deletingLastPathComponent).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            }
            Spacer()
            if f["untracked"] as? Bool == true { Text("new").font(.caption2).foregroundStyle(.secondary) }
            if f["binary"] as? Bool == true { Text("binary").font(.caption2).foregroundStyle(.secondary) }
            else { Text("+\(f["added"] as? Int ?? 0)").foregroundStyle(.green); Text("−\(f["deleted"] as? Int ?? 0)").foregroundStyle(.red) }
        }.font(.caption.monospacedDigit())
    }
}

/// One file's diff: the patch from its first hunk, colored by line.
struct DiffView: View {
    @EnvironmentObject var c: Client
    let sessionId: String, mode: String, path: String
    @State private var d: J?
    @State private var failed: String?
    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            if let failed { Text(failed).foregroundStyle(.secondary).padding() }
            else if let d {
                if d["binary"] as? Bool == true { Text("binary").foregroundStyle(.secondary).padding() }
                let lines = (d["patch"] as? String ?? "").split(separator: "\n", omittingEmptySubsequences: false).drop { !$0.hasPrefix("@@") }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                        Text(String(l).isEmpty ? " " : String(l)).font(.caption.monospaced())
                            .foregroundStyle(l.hasPrefix("@@") ? Color.secondary : .primary)
                            .padding(.horizontal, 8).frame(maxWidth: .infinity, alignment: .leading)
                            .background(l.hasPrefix("+") ? Color.green.opacity(0.12) : l.hasPrefix("-") ? Color.red.opacity(0.12) : .clear)
                    }
                    if d["truncated"] as? Bool == true { Text("Diff truncated.").font(.caption).foregroundStyle(.secondary).padding(8) }
                }
                .textSelection(.enabled)
            } else { ProgressView().padding() }
        }
        .navigationTitle((path as NSString).lastPathComponent).navigationBarTitleDisplayMode(.inline)
        .task {
            do { d = try await c.plusCall("diff", query: ["sessionId": sessionId, "mode": mode, "path": path]) }
            catch { failed = userText(error) }
        }
    }
}

/// Feature ideas: the chat's model suggests features for this project as cards. Swipe right or Plan: a new chat plans
/// it; Build now: a new chat builds it at once; swipe left: skip; Later: save it in this project's list.
struct IdeasSheet: View {
    @EnvironmentObject var c: Client
    @Environment(\.dismiss) private var dismiss
    let sessionId: String
    @State private var deck: [J] = []
    @State private var skipped: [J] = []
    @State private var later: [J] = []
    @State private var history: [J]?
    /// One network action at a time, as on the desktop.
    @State private var busy: LocalizedStringKey?
    @State private var drag: CGSize = .zero
    /// Optional focus topic: the model suggests only features about it. A preset chip fills it; the same chip again empties it.
    @State private var focus = ""
    @State private var copied = false
    /// The topic field and the six preset chips; used above the empty state and above the cards.
    private var focusBox: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Focus (optional), e.g. performance", text: $focus)
                .textFieldStyle(.roundedBorder).submitLabel(.go).onSubmit { suggest() }
                .onChange(of: focus) { _, v in if v.utf16.count > focusMax { focus = clampFocus(v) } }
                .accessibilityLabel("Focus topic")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(focusPresets, id: \.self) { p in
                        let on = focus.trimmingCharacters(in: .whitespaces) == p
                        Button { focus = on ? "" : p } label: { Text(LocalizedStringKey(p)).font(.footnote) }
                            .buttonStyle(.bordered).tint(on ? .accentColor : .secondary).accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
            }
        }
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if let top = deck.first {
                    focusBox
                    HStack {
                        Text("\(deck.count) idea(s) left").font(.footnote).foregroundStyle(.secondary)
                        Spacer()
                        Button { suggest() } label: { Label("More ideas", systemImage: "sparkles") }.font(.footnote)
                    }
                    card(top)
                        .offset(drag).rotationEffect(.degrees(Double(drag.width) / 25))
                        .gesture(DragGesture().onChanged { drag = $0.translation }.onEnded { g in
                            let w = g.translation.width, h = g.translation.height
                            withAnimation(.snappy) { drag = .zero }
                            if w > 110 { start(top, plan: true) } else if w < -110 { skip(top) } else if h > 110 { saveLater(top) }
                        })
                    HStack(spacing: 14) {
                        action("xmark", "Skip this idea") { skip(top) }
                        action("bookmark", "Save for later") { saveLater(top) }
                        action("bolt.fill", "Build now") { start(top, plan: false) }
                        action("checkmark", "Plan") { start(top, plan: true) }.tint(.accentColor)
                    }
                    if !skipped.isEmpty { Button("Undo") { deck.insert(skipped.removeLast(), at: 0) }.font(.footnote) }
                } else {
                    Spacer()
                    Image(systemName: "lightbulb").font(.system(size: 40)).foregroundStyle(.tint).accessibilityHidden(true)
                    Text("Feature ideas for this project").font(.title3.bold())
                    Text("The chat's model reads a short summary of this project (README, manifest, recent commits) and suggests features. Nothing in the project changes.")
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 24)
                    focusBox.padding(.horizontal, 24)
                    Button { suggest() } label: { Label(skipped.isEmpty ? "Suggest features" : "More ideas", systemImage: "sparkles").frame(maxWidth: .infinity).padding(.vertical, 4) }
                        .buttonStyle(.borderedProminent).controlSize(.large).padding(.horizontal, 24)
                    Spacer()
                }
                if let busy { HStack(spacing: 8) { ProgressView(); Text(busy) }.font(.footnote).foregroundStyle(.secondary) }
            }
            .padding()
            .disabled(busy != nil)
            .navigationTitle("Feature ideas").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        NavigationLink { laterList } label: { Label("Later (\(later.count))", systemImage: "bookmark") }
                        NavigationLink { historyList } label: { Label("History", systemImage: "clock") }
                    } label: { Image(systemName: "tray.full") }.accessibilityLabel("Saved ideas")
                }
            }
            .task { if let o = try? await c.plusCall("later", query: ["sessionId": sessionId]) { later = o["ideas"] as? [J] ?? [] } }
        }
    }
    private func card(_ i: J) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Text(i["title"] as? String ?? "").font(.title3.bold()); Spacer(); if let e = i["effort"] as? String { Text(LocalizedStringKey(e.capitalized)).font(.caption).padding(.horizontal, 8).padding(.vertical, 3).background(.quaternary, in: Capsule()) } }
            Text(i["summary"] as? String ?? "")
            if let w = i["why"] as? String { Text(w).font(.footnote).foregroundStyle(.secondary) }
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
    private func action(_ icon: String, _ label: LocalizedStringKey, _ f: @escaping () -> Void) -> some View {
        Button(action: f) { Image(systemName: icon).font(.title3.weight(.semibold)).frame(width: 54, height: 54).background(Color(.tertiarySystemFill), in: Circle()) }
            .buttonStyle(.plain).accessibilityLabel(label)
    }
    private func brief(_ i: J) -> J { i.filter { ["title", "summary", "why", "effort"].contains($0.key) } }
    private func run(_ what: LocalizedStringKey, _ op: @escaping () async throws -> Void) {
        guard busy == nil else { return }
        busy = what
        Task { defer { busy = nil }; do { try await op() } catch { c.error = userText(error) } }
    }
    private func suggest() {
        run("Thinking of ideas…") {
            // A focus goes only when it has text, so an empty field sends the same request as before. More ideas adds cards.
            var body: J = ["sessionId": sessionId, "locale": Locale.preferredLanguages.first ?? "en"]
            let topic = focus.trimmingCharacters(in: .whitespacesAndNewlines)
            if !topic.isEmpty { body["focus"] = topic }
            let o = try await c.plusCall("ideas", body: body)
            // More ideas adds to the cards left (as on the Mac); a fresh deck forgets the old Undo list.
            if deck.isEmpty { skipped = [] }
            deck += o["ideas"] as? [J] ?? []
        }
    }
    private func skip(_ i: J) { withAnimation(.snappy) { deck.removeFirst(); skipped.append(i) } }
    private func saveLater(_ i: J) {
        run("Saving…") {
            let o = try await c.plusCall("later", body: ["sessionId": sessionId, "add": brief(i)])
            later = o["ideas"] as? [J] ?? later; withAnimation(.snappy) { deck.removeAll { $0["id"] as? String == i["id"] as? String } }
        }
    }
    /// Plan: the new chat starts in plan mode, so nothing changes before the plan is approved. Build now: no plan.
    private func start(_ i: J, plan: Bool) {
        run("Starting a chat for this idea…") {
            let o = try await c.plusCall("ideas", body: ["sessionId": sessionId, "idea": brief(i), "plan": plan])
            deck.removeAll { $0["id"] as? String == i["id"] as? String }
            try? await c.loadSessions()
            if let sid = o["sessionId"] as? String { dismiss(); c.open(sid) }
        }
    }
    private var laterList: some View {
        List {
            if later.isEmpty { Text("No ideas saved for later.").foregroundStyle(.secondary) }
            ForEach(later.indices, id: \.self) { n in
                let i = later[n], id = i["id"] as? String ?? ""
                VStack(alignment: .leading, spacing: 4) { Text(i["title"] as? String ?? "").bold(); Text(i["summary"] as? String ?? "").font(.footnote).foregroundStyle(.secondary) }
                    .swipeActions {
                        Button(role: .destructive) { run("Saving…") { later = (try await c.plusCall("later", body: ["sessionId": sessionId, "remove": id]))["ideas"] as? [J] ?? later } } label: { Label("Remove", systemImage: "trash") }
                        Button { startLater(["start": id, "plan": false]) } label: { Label("Build now", systemImage: "bolt.fill") }.tint(.orange)
                        Button { startLater(["start": id]) } label: { Label("Plan", systemImage: "checkmark") }.tint(.accentColor)
                    }
            }
            if later.count >= 2 { Button("Plan all (\(later.count))") { startLater(["startAll": later.compactMap { $0["id"] as? String }]) } }
            // Copy as checklist: local, no network call; it stays on while another action runs.
            if !later.isEmpty {
                Button {
                    UIPasteboard.general.string = laterChecklist(later); copied = true
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                } label: { Label(copied ? "Copied" : "Copy as checklist", systemImage: copied ? "checkmark" : "checklist") }
            }
        }
        .navigationTitle("Saved for later")
    }
    private func startLater(_ b: J) {
        run("Starting a chat for this idea…") {
            let o = try await c.plusCall("later", body: b.merging(["sessionId": sessionId]) { a, _ in a })
            later = o["ideas"] as? [J] ?? later
            try? await c.loadSessions()
            if let sid = o["sessionId"] as? String { dismiss(); c.open(sid) }
        }
    }
    private var historyList: some View {
        List {
            Text("These ideas are not suggested again. Forget one to allow it again.").font(.footnote).foregroundStyle(.secondary)
            if history?.isEmpty == true { Text("No earlier ideas yet.").foregroundStyle(.secondary) }
            ForEach((history ?? []).indices, id: \.self) { n in
                let i = history![n], id = i["id"] as? String ?? ""
                VStack(alignment: .leading, spacing: 4) {
                    HStack { Text(i["title"] as? String ?? "").bold(); Spacer(); Text(i["started"] as? Bool == true ? "Started" : "Suggested").font(.caption2).foregroundStyle(.secondary) }
                    Text(i["summary"] as? String ?? "").font(.footnote).foregroundStyle(.secondary)
                }
                .swipeActions { Button(role: .destructive) { run("Saving…") { history = (try await c.plusCall("idea-history", body: ["sessionId": sessionId, "remove": id]))["ideas"] as? [J] } } label: { Label("Forget", systemImage: "trash") } }
            }
            if history?.isEmpty == false { Button("Forget all", role: .destructive) { run("Saving…") { history = (try await c.plusCall("idea-history", body: ["sessionId": sessionId, "clear": true]))["ideas"] as? [J] } } }
        }
        .navigationTitle("History")
        .task { history = (try? await c.plusCall("idea-history", query: ["sessionId": sessionId]))?["ideas"] as? [J] ?? [] }
    }
}

/// Turn rollback: take this message and everything after it out of the chat (and out of the model's context), and
/// put its text back in the composer. "Chat and files" also puts the project files back as they were before it.
struct RollbackSheet: View {
    @EnvironmentObject var c: Client
    @Environment(\.dismiss) private var dismiss
    let line: Line
    let onText: (String) -> Void
    @State private var files: [(path: String, action: String)]?
    @State private var checked = false
    @State private var working = false
    var body: some View {
        NavigationStack {
            Form {
                Section { Text(line.text).lineLimit(4).foregroundStyle(.secondary) } header: { Text("Roll back to before this message") }
                Section {
                    Button("Chat only") { go(files: false) }
                    if !checked { HStack { ProgressView(); Text("Checking the project files…") }.foregroundStyle(.secondary) }
                    else if let files, !files.isEmpty {
                        Button("Chat and files") { go(files: true) }
                        Text("Also put \(files.count) files back as they were before this message:").font(.footnote)
                        ForEach(files.prefix(20), id: \.path) { f in
                            Label(f.path, systemImage: f.action == "delete" ? "trash" : f.action == "create" ? "plus" : "arrow.uturn.backward").font(.caption.monospaced()).lineLimit(1)
                        }
                    }
                } footer: { Text("A running turn stops first. The chat log is not rewritten: a hidden marker hides the withdrawn part.") }
            }
            .disabled(working)
            .navigationTitle("Roll back").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task { if let s = line.seq { files = try? await c.rollbackPreview(s) }; checked = true }
        }
        .presentationDetents([.medium, .large])
    }
    private func go(files: Bool) {
        guard let s = line.seq, !working else { return }
        working = true
        Task {
            defer { working = false }
            do {
                let r = try await c.rollback(s, files: files)
                onText(r.text)
                if !r.skipped.isEmpty { c.error = String(localized: "\(r.skipped.count) files were not put back: \(r.skipped.joined(separator: ", "))") }
                else if r.attachments > 0 { c.error = String(localized: "Only the text came back: add the images or files of that message again.") }
                dismiss()
            } catch { c.error = String(localized: "Rollback failed: \(userText(error))") }
        }
    }
}
