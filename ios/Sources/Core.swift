// DSH Mobile core: pinning, pairing, RPC + mux client, Bonjour. Views live in UI.swift.
import Foundation
import CryptoKit
import Network
import Security
import UIKit
import UserNotifications

typealias J = [String: Any]
struct Fail: LocalizedError { let errorDescription: String?; init(_ m: String) { errorDescription = m } }

// MARK: - Pure helpers (covered by Tests.swift)

/// Lowercase 64-hex SHA-256, accepting the "AB:CD:…" form too. nil if malformed.
func normFp(_ s: String) -> String? {
    let n = s.lowercased().replacingOccurrences(of: ":", with: "")
    return n.count == 64 && n.allSatisfy({ "0123456789abcdef".contains($0) }) ? n : nil
}
func sha256Hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
/// The only trust decision: the leaf certificate's DER must hash to the fingerprint from the QR code.
func pinMatches(der: Data, fp: String) -> Bool { normFp(fp) == sha256Hex(der) }

/// RFC 1918 + link-local IPv4 only: a pairing QR can never point the app at the internet.
func isLANv4(_ h: String) -> Bool {
    let o = h.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) ?? -1 }
    guard o.count == 4, o.allSatisfy({ (0...255).contains($0) }), h.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == ".") }) else { return false }
    return o[0] == 10 || (o[0] == 172 && (16...31).contains(o[1])) || (o[0] == 192 && o[1] == 168) || (o[0] == 169 && o[1] == 254)
}

struct Invite: Decodable { let v: Int; let host: String; let port: Int; let fp: String; let code: String }
/// QR / pasted payload from the Mac: {"v":1,"host","port","fp","code"}.
func parseInvite(_ s: String) -> Invite? {
    guard let d = s.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
          let i = try? JSONDecoder().decode(Invite.self, from: d), i.v == 1, isLANv4(i.host),
          (1...65535).contains(i.port), let fp = normFp(i.fp), (1...128).contains(i.code.count) else { return nil }
    return Invite(v: 1, host: i.host, port: i.port, fp: fp, code: i.code)
}

/// Splits on triple-backtick fences: prose blocks and code blocks (language tag dropped).
func mdBlocks(_ s: String) -> [(code: Bool, text: String)] {
    s.components(separatedBy: "```").enumerated().compactMap { i, part in
        if i % 2 == 0 { let t = part.trimmingCharacters(in: .newlines); return t.isEmpty ? nil : (false, t) }
        var lines = part.components(separatedBy: "\n")
        if lines.count > 1 { lines.removeFirst() }
        return (true, lines.joined(separator: "\n").trimmingCharacters(in: .newlines))
    }
}

/// DSH message content is a string or [ContentBlock]; only text is rendered, images become a marker.
func contentText(_ c: Any?) -> String {
    if let s = c as? String { return s }
    return (c as? [J] ?? []).compactMap { b -> String? in
        switch b["type"] as? String {
        case "text": return b["text"] as? String
        case "image": return "🖼"
        default: return nil
        }
    }.joined(separator: "\n")
}

func usageText(_ u: J) -> String {
    let n = { (k: String) in (u[k] as? Int).map { "\($0)" } }
    // shortcut: DSH exposes no context-window size, so only raw token counts are shown; add a % bar once the model catalog carries a limit.
    return [("in", n("inputTokens")), ("out", n("outputTokens")), ("cache", n("cacheReadTokens")), ("reasoning", n("reasoningTokens")), ("total", n("totalTokens"))]
        .compactMap { k, v in v.map { "\(k) \($0)" } }.joined(separator: " · ")
}

/// "model · effort" from a DSH model selection ({provider, model, reasoningEffort}).
func modelLabel(_ s: J?) -> String? {
    guard let m = s?["model"] as? String else { return nil }
    return [m, s?["reasoningEffort"] as? String].compactMap { $0 }.joined(separator: " · ")
}

func compactJSON(_ v: Any?, limit: Int = 300) -> String {
    guard let v else { return "" }
    if let s = v as? String { return String(s.prefix(limit)) }
    guard JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]) else { return "\(v)".prefix(limit).description }
    return String(decoding: d, as: UTF8.self).prefix(limit).description
}

// MARK: - Models

struct Pairing: Codable { var host: String; var port: Int; var fp: String; var token: String; var deviceId: String; var name: String; var expiresAt: String }

struct Line: Identifiable {
    enum Kind { case user, assistant, reasoning, command, tool, result, error }
    let id = UUID(); let kind: Kind; let text: String
}

struct Sess: Identifiable {
    let id: String, title: String, cwd: String, parent: String?, running: Bool, preset: String?, model: String?, context: Double?
    init?(_ j: J) {
        guard let id = j["sessionId"] as? String else { return nil }
        let p = (j["projections"] as? J)?["values"] as? J
        self.id = id; title = (p?["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Untitled")
        // shortcut: parent read from list item or subagent projection, both unverified live (no subagent sessions seen); check once a subagent runs.
        cwd = j["cwd"] as? String ?? ""; parent = (j["parentSessionId"] ?? (p?["subagent"] as? J)?["parentSessionId"]) as? String
        running = j["running"] as? Bool ?? false; preset = p?["agentPreset"] as? String
        let ms = p?["modelSelection"] as? J
        model = modelLabel((ms?["next"] as? J) ?? (ms?["lastUsed"] as? J))
        let cp = p?["contextPressure"] as? J, used = (cp?["projectedTokens"] as? NSNumber)?.doubleValue, win = (cp?["contextWindow"] as? NSNumber)?.doubleValue
        context = used.flatMap { u in win.flatMap { $0 > 0 ? u / $0 : nil } }
    }
}

struct Workspace: Identifiable {
    let id: String, path: String, title: String, sessions: [String]
    init?(_ j: J?) {
        guard let j, let id = j["workspaceId"] as? String else { return nil }
        self.id = id; path = j["path"] as? String ?? ""; sessions = j["sessionIds"] as? [String] ?? []
        title = (j["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (path as NSString).lastPathComponent
    }
}

struct Cmd: Identifiable { var id: String { name }; let name: String, desc: String, hint: String? }

struct Prompt: Identifiable { let id: String; let event: String; let agentId: String?; let request: J }

struct Question: Identifiable {
    struct Opt: Identifiable { var id: String { label }; let label: String; let desc: String? }
    let id: String, question: String, detail: String?, header: String?, multi: Bool, options: [Opt]
    static func parse(_ r: J) -> [Question] {
        (r["questions"] as? [J] ?? []).compactMap { q in
            guard let id = q["id"] as? String else { return nil }
            return Question(id: id, question: q["question"] as? String ?? "", detail: q["detail"] as? String, header: q["header"] as? String,
                            multi: q["multiSelect"] as? Bool ?? false,
                            options: (q["options"] as? [J] ?? []).compactMap { o in (o["label"] as? String).map { Opt(label: $0, desc: o["description"] as? String) } })
        }
    }
}

struct ModelGroup: Identifiable { let id: String, name: String; let models: [Model] }
struct Model: Identifiable { let id: String, name: String; let efforts: [String] }
struct Preset: Identifiable { let id: String, name: String; let desc: String?; let broken: Bool }
struct Hit: Identifiable { let id = UUID(); let session: String, snippet: String }
struct Found: Identifiable { var id: String { fp }; let fp: String, name: String, host: String; let port: Int }

struct Goal {
    let ref: J, objective: String, phase: String, rounds: Int, max: Int, blocked: String?
    init?(_ v: Any?) {
        guard let j = v as? J, let id = j["id"] as? String, let rev = j["revision"] else { return nil }
        ref = ["id": id, "revision": rev]; objective = j["objective"] as? String ?? ""; phase = j["phase"] as? String ?? ""
        rounds = j["roundsStarted"] as? Int ?? 0; max = j["maxGoalRounds"] as? Int ?? 0
        blocked = (j["blockedReason"] as? J)?["message"] as? String
    }
}

// MARK: - Keychain: one item holding the pairing (token included), this device only.

enum Keychain {
    static let base: J = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dsh-mobile", kSecAttrAccount as String: "pairing"]
    static func load() -> Pairing? {
        var q = base; q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: d)
    }
    static func save(_ p: Pairing?) {
        SecItemDelete(base as CFDictionary)
        guard let p, let d = try? JSONEncoder().encode(p) else { return }
        var a = base; a[kSecValueData as String] = d; a[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(a as CFDictionary, nil)
    }
}

/// Accepts the server only if its leaf certificate matches the pinned fingerprint; system CAs are never consulted.
final class Pinner: NSObject, URLSessionDelegate {
    let fp: String
    init(fp: String) { self.fp = fp }
    func urlSession(_ s: URLSession, didReceive ch: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard ch.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let t = ch.protectionSpace.serverTrust,
              let leaf = (SecTrustCopyCertificateChain(t) as? [SecCertificate])?.first,
              pinMatches(der: SecCertificateCopyData(leaf) as Data, fp: fp) else { return (.cancelAuthenticationChallenge, nil) }
        return (.useCredential, URLCredential(trust: t))
    }
}

// MARK: - Client

@MainActor final class Client: ObservableObject {
    enum Conn: String { case off = "Not connected", connecting = "Connecting…", connected = "Connected", reconnecting = "Reconnecting…" }

    @Published var pairing: Pairing? = Keychain.load() { didSet { Keychain.save(pairing) } }
    @Published var state = Conn.off
    @Published var upstream = ""
    @Published var error: String?
    @Published var pairingStatus: String?
    @Published var path: [String] = [] // Sessions navigation stack; non-empty = conversation on screen
    @Published var sessions: [Sess] = []
    @Published var current: String?
    @Published var transcript: [Line] = []
    @Published var streaming = ""
    @Published var reasoning = ""
    @Published var running = false
    @Published var usage: J?
    @Published var model: String?
    @Published var defaultModel: String?
    @Published var catalog: [ModelGroup] = []
    @Published var workspaces: [Workspace] = []
    @Published var pinned: [String] = []
    @Published var archived: [String] = []
    @Published var commands: [Cmd] = []
    @Published var presets: [Preset] = []
    @Published var goal: Goal?
    @Published var prompts: [Prompt] = []
    @Published var found: [String: Found] = [:]

    private var urlSession: URLSession?, sessionFp = ""
    private var ws: URLSessionWebSocketTask?
    private var followId: String?
    private var attempt = 0
    private var browser: NWBrowser?

    var currentSess: Sess? { sessions.first { $0.id == current } }
    /// What the next turn will use: live header/selection, else the session's saved selection, else DSH's default.
    var shownModel: String? { model ?? currentSess?.model ?? defaultModel }
    func title(_ id: String) -> String { sessions.first { $0.id == id }?.title ?? String(id.prefix(8)) }

    /// Sidebar order like desktop DSH: pinned, one section per project, unassigned, archived.
    func sessionGroups() -> [(title: String, items: [Sess])] {
        let roots = sessions.filter { $0.parent == nil }
        let rest = roots.filter { !pinned.contains($0.id) && !archived.contains($0.id) }
        var out = [(String(localized: "Pinned"), pinned.compactMap { id in roots.first { $0.id == id } })]
        var used = Set<String>()
        for w in workspaces { let s = rest.filter { w.sessions.contains($0.id) }; used.formUnion(s.map(\.id)); out.append((w.title, s)) }
        out.append((String(localized: "Other"), rest.filter { !used.contains($0.id) }))
        out.append((String(localized: "Archived"), roots.filter { archived.contains($0.id) }))
        return out.filter { !$0.1.isEmpty }.map { (title: $0.0, items: $0.1) }
    }

    func run(_ op: @escaping @MainActor () async throws -> Void) { Task { do { try await op() } catch { self.error = error.localizedDescription } } }

    private func http(_ fp: String) -> URLSession {
        if urlSession == nil || fp != sessionFp {
            urlSession?.invalidateAndCancel()
            urlSession = URLSession(configuration: .ephemeral, delegate: Pinner(fp: fp), delegateQueue: nil); sessionFp = fp
        }
        return urlSession!
    }

    private func call(_ path: String, _ body: Any?) async throws -> Any? {
        guard let p = pairing else { throw Fail(String(localized: "Not paired")) }
        var r = URLRequest(url: URL(string: "https://\(p.host):\(p.port)\(path)")!)
        r.setValue("Bearer \(p.token)", forHTTPHeaderField: "Authorization")
        if let body {
            r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (d, resp) = try await http(p.fp).data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0, json = try? JSONSerialization.jsonObject(with: d)
        if code == 401 { forget(String(localized: "This iPhone was revoked or its token expired. Pair again.")) }
        guard code == 200 else { throw Fail(((json as? J)?["error"] as? String) ?? "HTTP \(code)") }
        return json
    }

    func rpc(_ method: String, _ args: J = [:]) async throws -> Any? {
        let o = try await call("/api/" + method, ["type": "client-request", "rpcId": UUID().uuidString, "method": method, "payload": ["args": args]]) as? J
        guard let res = o?["result"] as? J else { throw Fail("Bad response") }
        if res["ok"] as? Bool == true { return res["value"] }
        throw Fail(((res["error"] as? J)?["message"] as? String) ?? "Request failed")
    }

    // MARK: Pairing

    func pair(_ inv: Invite) async {
        pairingStatus = String(localized: "Waiting for approval on your Mac…")
        defer { pairingStatus = nil }
        do {
            var r = URLRequest(url: URL(string: "https://\(inv.host):\(inv.port)/pair")!, timeoutInterval: 150) // Mac holds the reply until approved (≤120 s)
            r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: ["code": inv.code, "name": UIDevice.current.name])
            let (d, resp) = try await http(inv.fp).data(for: r)
            guard (resp as? HTTPURLResponse)?.statusCode == 200, let o = try JSONSerialization.jsonObject(with: d) as? J,
                  let token = o["token"] as? String, token.count >= 40, let id = o["deviceId"] as? String
            else { throw Fail(String(localized: "Pairing was denied or the code expired. Show a fresh QR code on the Mac.")) }
            pairing = Pairing(host: inv.host, port: inv.port, fp: inv.fp, token: token, deviceId: id, name: o["name"] as? String ?? "", expiresAt: o["expiresAt"] as? String ?? "")
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            connect()
        } catch { self.error = error.localizedDescription }
    }

    func forget(_ why: String? = nil) {
        ws?.cancel(with: .goingAway, reason: nil); ws = nil; followId = nil
        pairing = nil; sessions = []; transcript = []; prompts = []; current = nil; path = []; goal = nil; state = .off
        if let why { error = why }
    }

    func setAddress(_ host: String, _ port: Int?) {
        guard isLANv4(host), let port, (1...65535).contains(port) else { error = String(localized: "Enter a private LAN IPv4 address and port."); return }
        pairing?.host = host; pairing?.port = port; reconnect()
    }

    // MARK: Mux socket

    func connect() {
        guard let p = pairing, ws == nil else { return }
        var r = URLRequest(url: URL(string: "wss://\(p.host):\(p.port)/api/remote.mux")!)
        r.setValue("Bearer \(p.token)", forHTTPHeaderField: "Authorization")
        let t = http(p.fp).webSocketTask(with: r)
        t.maximumMessageSize = 16 << 20
        ws = t; state = attempt == 0 ? .connecting : .reconnecting
        t.resume(); listen(t)
        send(["type": "open", "streamId": "ev", "endpoint": "$events", "payload": ["args": J()]])
        send(["type": "open", "streamId": "ws", "endpoint": "workspace/follow", "payload": ["args": J()]])
        if let s = current { openFollow(s) }
    }

    func reconnect() { ws?.cancel(with: .goingAway, reason: nil); ws = nil; followId = nil; attempt = 0; connect() }

    /// On foreground: a socket iOS silently killed in the background is detected by a failed ping.
    func wake() {
        guard let t = ws else { return connect() }
        t.sendPing { e in if e != nil { Task { @MainActor in if t === self.ws { self.drop() } } } }
    }

    private func send(_ f: J) {
        guard let t = ws, let d = try? JSONSerialization.data(withJSONObject: f) else { return }
        t.send(.string(String(decoding: d, as: UTF8.self))) { _ in }
    }

    private func listen(_ t: URLSessionWebSocketTask) {
        t.receive { r in
            Task { @MainActor in
                guard t === self.ws else { return }
                switch r {
                case .failure: self.drop()
                case .success(.string(let s)):
                    if let f = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? J { self.onFrame(f) }
                    self.listen(t)
                case .success: self.listen(t)
                }
            }
        }
    }

    private func drop() {
        ws?.cancel(with: .goingAway, reason: nil); ws = nil; followId = nil
        guard pairing != nil else { state = .off; return }
        state = .reconnecting; attempt += 1
        let delay = Double(min(30, 1 << min(attempt, 5)))
        Task {
            try? await Task.sleep(for: .seconds(delay))
            guard self.ws == nil, let p = self.pairing else { return }
            // Bonjour fallback: same pinned certificate seen at a new address (DHCP change) → follow it. Pinning keeps this safe.
            if let f = self.found[p.fp], f.host != p.host || f.port != p.port { self.pairing?.host = f.host; self.pairing?.port = f.port }
            await self.refreshMe() // a 401 here means revoked/expired → unpairs instead of looping
            self.connect()
        }
    }

    func refreshMe() async {
        if let me = try? await call("/me", nil) as? J {
            upstream = me["upstream"] as? String ?? ""
            if let e = me["expiresAt"] as? String { pairing?.expiresAt = e }
        }
    }

    private func onFrame(_ f: J) {
        let id = f["streamId"] as? String
        switch f["type"] as? String {
        case "item":
            guard let v = f["value"] as? J else { return }
            if id == "ev" { onEvent(v) } else if id == "ws" { onWorkspace(v) } else if id == followId { onFollow(v) }
        case "error": error = (f["error"] as? J)?["message"] as? String
        case "end": if id == followId { followId = nil }
        default: break
        }
    }

    private func onEvent(_ v: J) {
        switch v["type"] as? String {
        case "ready":
            state = .connected; attempt = 0; prompts = [] // the gateway re-sends everything still pending right after ready
            Task { await refreshMe(); try? await loadSessions(); try? await loadCatalog() }
        case "waterfall":
            guard let id = v["eventId"] as? String, let ev = v["event"] as? String, !prompts.contains(where: { $0.id == id }) else { return }
            let req = v["request"] as? J ?? [:]
            prompts.append(Prompt(id: id, event: ev, agentId: v["agentId"] as? String, request: req))
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            if ev == "approval/request" { notify(String(localized: "Approval needed"), req["toolName"] as? String ?? "") }
            else { notify(String(localized: "DSH has a question"), Question.parse(req).first?.question ?? "") }
        case "cancel": prompts.removeAll { $0.id == v["eventId"] as? String }
        case "emit":
            if let e = v["event"] as? String, ["api-session/added", "api-session/removed", "api-session/status", "agent-preset/selected"].contains(e) {
                Task { try? await loadSessions() }
            }
        default: break
        }
    }

    func onWorkspace(_ v: J) {
        let base = v["type"] as? String == "baseline" ? v["value"] as? J : nil
        let f = base ?? v
        switch v["type"] as? String {
        case "baseline": workspaces = (base?["items"] as? [J] ?? []).compactMap(Workspace.init)
        case "upsert":
            guard let w = Workspace(v["workspace"] as? J) else { break }
            if let i = workspaces.firstIndex(where: { $0.id == w.id }) { workspaces[i] = w } else { workspaces.insert(w, at: 0) }
        case "remove": workspaces.removeAll { $0.id == v["workspaceId"] as? String }
        case "order":
            let ids = v["workspaceIds"] as? [String] ?? []
            workspaces.sort { (ids.firstIndex(of: $0.id) ?? .max) < (ids.firstIndex(of: $1.id) ?? .max) }
        default: break
        }
        if let a = f["archivedSessionIds"] as? [String] { archived = a }
        if let p = f["pinnedSessionIds"] as? [String] { pinned = p }
    }

    // MARK: Conversation stream

    func follow(_ sid: String) {
        if sid == current, followId != nil { return } // re-opening the live session keeps its stream and transcript
        if let old = followId { send(["type": "cancel", "streamId": old]) }
        current = sid; transcript = []; streaming = ""; reasoning = ""; usage = nil; model = nil; goal = nil
        running = currentSess?.running ?? false
        openFollow(sid)
        Task { await loadCommands() }
    }

    private func openFollow(_ sid: String) {
        let id = "f-" + UUID().uuidString; followId = id
        send(["type": "open", "streamId": id, "endpoint": "session/follow",
              "payload": ["args": ["request": ["address": ["kind": "session", "sessionId": sid], "assistantStream": true]]]])
    }

    private func onFollow(_ v: J) {
        switch v["type"] as? String {
        case "snapshot":
            // shortcut: only the snapshot window is shown (hasMore is ignored); page older history via session/page if long sessions need it.
            transcript = []; streaming = ""; reasoning = ""
            for r in v["records"] as? [J] ?? [] { if let e = r["event"] as? J { apply(e) } }
        case "event": if let e = v["event"] as? J { apply(e) }
        case "assistant-stream":
            let fr = v["frame"] as? J ?? [:]
            switch fr["type"] as? String {
            case "start": streaming = ""; reasoning = ""; running = true
            case "chunk":
                let c = fr["chunk"] as? J ?? [:]
                switch c["type"] as? String {
                case "text-delta": streaming += c["text"] as? String ?? ""
                case "reasoning-delta": reasoning += c["text"] as? String ?? ""
                case "usage": if let u = c["usage"] as? J { usage = u }
                default: break
                }
            case "end": streaming = ""; reasoning = ""
            default: break
            }
        default: break
        }
    }

    func apply(_ e: J) {
        let d = e["data"] as? J ?? [:]
        switch e["type"] as? String {
        case "user/message":
            // DSH also logs runtime-context / skill-catalog injections as user messages; show only what the user typed.
            let kind = (d["source"] as? J)?["kind"] as? String
            if kind == nil || kind == "user" { transcript.append(Line(kind: .user, text: contentText(d["content"]))) }
        case "request/header":
            if let m = modelLabel((d["header"] as? J)?["config"] as? J) { model = m }
        case "request/context": if model == nil, let m = d["model"] as? String { model = m }
        case "assistant/message":
            let content = (d["message"] as? J)?["content"]
            let r = (content as? [J] ?? []).filter { $0["type"] as? String == "reasoning" }.compactMap { $0["text"] as? String }.joined(separator: "\n")
            if !r.isEmpty { transcript.append(Line(kind: .reasoning, text: r)) }
            let t = contentText(content)
            if !t.isEmpty { transcript.append(Line(kind: .assistant, text: t)) }
            if let u = d["usage"] as? J { usage = u }
        case "command/run": transcript.append(Line(kind: .command, text: "/\(d["name"] as? String ?? "") \(d["args"] as? String ?? "")".trimmingCharacters(in: .whitespaces)))
        case "command/done": if let t = d["text"] as? String, !t.isEmpty { transcript.append(Line(kind: d["kind"] as? String == "error" ? .error : .result, text: t)) }
        case "tool/call": transcript.append(Line(kind: .tool, text: "\(d["name"] as? String ?? "tool") \(compactJSON(d["arguments"]))"))
        case "tool/result":
            let m = d["message"] as? J
            let bad = m?["isError"] as? Bool == true || d["error"] != nil
            transcript.append(Line(kind: bad ? .error : .result, text: String(contentText(m?["content"]).prefix(600))))
        case "turn/start": running = true
        case "turn/end":
            if let m = ((d["reason"] as? J)?["error"] as? J)?["message"] as? String { transcript.append(Line(kind: .error, text: m)) }
            if running { notify(String(localized: "Turn finished"), currentSess?.title ?? "") }
            running = false
        default: break
        }
    }

    // MARK: Actions (wire shapes from the DSH host types)

    func loadSessions() async throws {
        // shortcut: first page of session/list only; follow the cursor once users have hundreds of sessions.
        let v = try await rpc("session/list", ["_request": J()]) as? J
        sessions = (v?["items"] as? [J] ?? []).compactMap(Sess.init)
        if let s = currentSess, s.running != running, streaming.isEmpty { running = s.running }
    }

    func create(cwd: String?, workspaceId: String? = nil) async throws {
        var r = J(); if let cwd, !cwd.isEmpty { r["cwd"] = cwd }; if let workspaceId { r["workspaceId"] = workspaceId }
        let v = try await rpc("session/create", ["request": r]) as? J
        try await loadSessions()
        if let id = v?["sessionId"] as? String { follow(id); path = [id] }
    }

    func fork(_ id: String) async throws {
        let v = try await rpc("session/fork", ["request": ["sessionId": id]]) as? J
        try await loadSessions()
        if let n = v?["sessionId"] as? String { follow(n); path = [n] }
    }

    // Pinned/archived lists come back through the workspace/follow stream.
    func togglePin(_ id: String) async throws {
        _ = try await rpc(pinned.contains(id) ? "workspace/unpinSession" : "workspace/pinSession", ["request": ["sessionId": id]])
    }

    func toggleArchive(_ id: String) async throws {
        if archived.contains(id) { _ = try await rpc("workspace/unarchiveSession", ["request": ["sessionId": id]]) }
        else { _ = try await rpc("workspace/archiveSession", ["request": ["sessionId": id, "stopActivity": true]]) }
    }

    func loadCommands() async {
        guard let sid = current, let v = try? await rpc("commands/list", ["agentId": sid]) else { return }
        commands = ((v as? [J]) ?? ((v as? J)?["commands"] as? [J]) ?? []).compactMap { c in
            (c["name"] as? String).map { Cmd(name: $0, desc: c["description"] as? String ?? "", hint: (c["input"] as? J)?["hint"] as? String) }
        }
    }

    /// Runs a slash command like desktop DSH; its run/done events land in the transcript via the follow stream.
    func execute(_ line: String) async throws {
        guard let sid = current else { return }
        let v = try await rpc("commands/execute", ["agentId": sid, "line": line, "submittedAttachments": [J]()]) as? J
        guard let r = v?["result"] as? J else { throw Fail(String(localized: "Unknown command")) }
        if r["kind"] as? String == "error" { throw Fail(r["text"] as? String ?? String(localized: "Command failed")) }
    }

    func rename(_ id: String, _ title: String) async throws {
        _ = try await rpc("session/rename", ["request": ["sessionId": id, "title": title]]); try await loadSessions()
    }

    func search(_ q: String) async throws -> [Hit] {
        let v = try await rpc("session/search", ["request": ["query": q]]) as? J
        return (v?["items"] as? [J] ?? []).compactMap { i in (i["sessionId"] as? String).map { Hit(session: $0, snippet: i["snippet"] as? String ?? "") } }
    }

    /// mode "steer" injects into a running turn (desktop's send-while-running); "queue" starts/queues a turn.
    func prompt(_ text: String, images: [Data], steer: Bool = false) async throws {
        guard let sid = current else { return }
        var content: [J] = text.isEmpty ? [] : [["type": "text", "text": text]]
        content += images.map { ["type": "image", "mediaType": "image/jpeg", "data": $0.base64EncodedString()] }
        _ = try await rpc("session/prompt", ["request": ["requestId": UUID().uuidString, "sessionId": sid, "mode": steer ? "steer" : "queue", "content": content]])
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    func stop() async throws { if let sid = current { _ = try await rpc("session/cancel", ["request": ["sessionId": sid]]) } }

    func loadCatalog() async throws {
        let v = try await rpc("session/modelCatalog") as? J
        defaultModel = modelLabel(v?["default"] as? J)
        catalog = (v?["groups"] as? [J] ?? []).compactMap { g in
            guard let id = g["id"] as? String else { return nil }
            return ModelGroup(id: id, name: g["name"] as? String ?? id, models: (g["models"] as? [J] ?? []).compactMap { m in
                guard let mid = m["id"] as? String else { return nil }
                return Model(id: mid, name: m["name"] as? String ?? mid, efforts: ((m["reasoning"] as? J)?["efforts"] as? [J] ?? []).compactMap { $0["id"] as? String })
            })
        }
    }

    func selectModel(_ provider: String, _ m: String, _ effort: String?) async throws {
        guard let sid = current else { return }
        var r: J = ["sessionId": sid, "provider": provider, "model": m]; if let effort { r["reasoningEffort"] = effort }
        let v = try await rpc("session/selectModel", ["request": r]) as? J
        model = modelLabel(v?["selected"] as? J) ?? modelLabel(r)
    }

    func loadAgents() async {
        if let v = try? await rpc("agentPresets/list") as? J {
            presets = (v["presets"] as? [J] ?? []).compactMap { p in
                (p["id"] as? String).map { Preset(id: $0, name: p["name"] as? String ?? $0, desc: p["description"] as? String, broken: p["broken"] as? Bool ?? false) }
            }
        }
        await loadGoal()
    }

    func selectPreset(_ id: String) async throws {
        guard let sid = current else { return }
        _ = try await rpc("agentPresets/select", ["agentId": sid, "agentPreset": id]); try await loadSessions()
    }

    func loadGoal() async { goal = nil; if let sid = current { goal = Goal(try? await rpc("goals/get", ["agentId": sid])) } }

    func createGoal(_ objective: String) async throws {
        guard let sid = current else { return }
        _ = try await rpc("goals/create", ["agentId": sid, "request": ["objective": objective]]); await loadGoal()
    }

    /// verb: pause | resume | complete | clear
    func goalAction(_ verb: String) async throws {
        guard let sid = current, let g = goal else { return }
        _ = try await rpc("goals/" + verb, ["agentId": sid, "ref": g.ref]); await loadGoal()
    }

    func interrupt(_ child: Sess) async throws {
        guard let parent = child.parent else { return }
        _ = try await rpc("subagents/interruptByParent", ["childSessionId": child.id, "parentSessionId": parent, "mode": "continuable"])
    }

    /// value nil = "let the Mac decide" (next handler, i.e. the desktop prompt).
    func answer(_ p: Prompt, _ value: Any?) async throws {
        prompts.removeAll { $0.id == p.id }
        let outcome: J = value.map { ["kind": "result", "value": $0] } ?? ["kind": "next"]
        _ = try await rpc("$events/result", ["clientId": "mobile", "eventId": p.id, "outcome": outcome])
    }

    // shortcut: only notifies while iOS keeps the socket alive (seconds after backgrounding); real wake-ups need APNs via a relay, out of scope for LAN-only.
    private func notify(_ title: String, _ body: String) {
        guard UIApplication.shared.applicationState != .active else { return }
        let c = UNMutableNotificationContent(); c.title = title; c.body = body; c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }

    // MARK: Bonjour: _dshmobile._tcp with TXT fp=<sha256>, resolved to an IPv4 address.

    func browse() {
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_dshmobile._tcp", domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { results, _ in
            MainActor.assumeIsolated {
                for r in results {
                    guard case let .bonjour(txt) = r.metadata, let fp = txt["fp"].flatMap(normFp), case let .service(name, _, _, _) = r.endpoint else { continue }
                    self.resolve(r.endpoint, fp: fp, name: name)
                }
            }
        }
        b.start(queue: .main); browser = b
    }

    private func resolve(_ e: NWEndpoint, fp: String, name: String) {
        let params = NWParameters.tcp
        (params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
        let c = NWConnection(to: e, using: params)
        c.stateUpdateHandler = { s in
            switch s {
            case .ready:
                if case let .hostPort(host, port)? = c.currentPath?.remoteEndpoint, case let .ipv4(a) = host {
                    let h = "\(a)".components(separatedBy: "%")[0]
                    if isLANv4(h) { MainActor.assumeIsolated { self.found[fp] = Found(fp: fp, name: name, host: h, port: Int(port.rawValue)) } }
                }
                c.cancel()
            case .failed, .waiting: c.cancel()
            default: break
            }
        }
        c.start(queue: .main)
    }
}

