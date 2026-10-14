// Tether core: pinning, pairing, RPC + mux client, Bonjour. Views live in UI.swift.
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
/// Error text with codes (incl. the underlying CFNetwork/stream error) so a field report pins the cause.
func failText(_ e: Error) -> String {
    let n = e as NSError, u = n.userInfo[NSUnderlyingErrorKey] as? NSError
    return "\(n.localizedDescription) [\(n.code)\(u.map { " / \($0.domain) \($0.code)" } ?? "")]"
}
/// Toast text: network failures become one plain sentence; everything else keeps its own message.
func userText(_ e: Error) -> String {
    guard let u = e as? URLError else { return e.localizedDescription }
    switch u.code {
    case .timedOut: return String(localized: "The Mac took too long to answer. Check that DSH is running.")
    case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
        return String(localized: "No network connection. Try again when you're back online.")
    case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
        return String(localized: "Can't reach the Mac. Is DSH open and Tailscale or Wi-Fi on?")
    case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .secureConnectionFailed:
        return String(localized: "The Mac's certificate didn't match. Pair again with a fresh QR code.")
    default: return e.localizedDescription
    }
}
/// Gateway refusals (raw English from server.mjs) become one plain sentence; unknown messages pass through.
func gatewayText(_ code: Int, _ m: String) -> String {
    if code == 429 { return String(localized: "Too many requests. Wait a few seconds and try again.") }
    if code == 403, m == "endpoint not allowed" { return String(localized: "This action isn't available from the phone yet.") }
    if code == 413 || m.contains("too large") { return String(localized: "That's too large to send.") }
    return m
}

/// What the banner tells the user when the Mac is unreachable. On Wi‑Fi with a tailnet address we still
/// point at Tailscale: "same Wi‑Fi" is wrong advice on office/café Wi‑Fi.
func lostHint(onWiFi: Bool, hasTailnet: Bool) -> String {
    if !hasTailnet { return onWiFi ? String(localized: "Can't reach your Mac. Make sure it's awake and on the same Wi‑Fi.")
                                   : String(localized: "Install Tailscale on this iPhone and the Mac to connect away from home.") }
    return onWiFi ? String(localized: "Can't reach your Mac. On the same Wi‑Fi, check it's awake; elsewhere, open Tailscale on both.")
                  : String(localized: "Open Tailscale on this iPhone (and the Mac).")
}

/// Whether the banner explains the lost link: never when connected; a first connect only once it has hung (slow).
func showsLostHint(_ s: Client.Conn, slow: Bool) -> Bool { s == .off || s == .reconnecting || (s == .connecting && slow) }
/// What the empty Sessions list shows: "No sessions" only after a list really came back empty; before that a spinner
/// while a link is up or being made, nothing when off (the banner explains why).
enum SessionsPlaceholder { case none, loading, empty }
func sessionsPlaceholder(loaded: Bool, count: Int, state: Client.Conn) -> SessionsPlaceholder {
    if count > 0 { return .none }
    if loaded { return .empty }
    return state == .off ? .none : .loading
}

/// Session title as typed: trimmed, nil when blank (a blank title would leave an unnamed row).
func cleanTitle(_ s: String) -> String? { let t = s.trimmingCharacters(in: .whitespacesAndNewlines); return t.isEmpty ? nil : t }

/// Sidebar accordion: `raw` is newline-joined titles the user toggled; Archived starts folded, others open.
/// shortcut: keyed by title, two workspaces with the same title fold together; key by workspace id if that matters.
func groupFolded(_ raw: String, _ title: String) -> Bool { raw.split(separator: "\n").contains { $0 == title } != (title == String(localized: "Archived")) }
func toggledFold(_ raw: String, _ title: String) -> String {
    var s = raw.split(separator: "\n").map(String.init)
    if let i = s.firstIndex(of: title) { s.remove(at: i) } else { s.append(title) }
    return s.joined(separator: "\n")
}
func groupIcon(_ title: String) -> String {
    switch title {
    case String(localized: "Pinned"): "pin"
    case String(localized: "Archived"): "archivebox"
    case String(localized: "Ungrouped"): "tray"
    default: "folder"
    }
}

/// New-session sheet: folders of past sessions, newest first, each once, minus `excluding` (DSH projects).
func recentFolders(_ sessions: [Sess], excluding: Set<String>) -> [String] {
    var seen = excluding
    return sessions.sorted { ($0.updated ?? .distantPast) > ($1.updated ?? .distantPast) }.map(\.cwd).filter { !$0.isEmpty && seen.insert($0).inserted }
}
/// Typed Mac folder: trimmed, nil unless absolute or home-relative (a bare name would land in DSH's cwd).
func macPath(_ s: String) -> String? {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.hasPrefix("/") || t.hasPrefix("~") ? t : nil
}

/// RFC 1918 + link-local IPv4 only: a pairing QR can never point the app at the internet.
func isLANv4(_ h: String) -> Bool {
    let o = h.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) ?? -1 }
    guard o.count == 4, o.allSatisfy({ (0...255).contains($0) }), h.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == ".") }) else { return false }
    return o[0] == 10 || (o[0] == 172 && (16...31).contains(o[1])) || (o[0] == 192 && o[1] == 168) || (o[0] == 169 && o[1] == 254)
}

/// Bonjour may resolve the Mac over the USB cable (169.254.x link-local); the gateway only listens on its Wi‑Fi
/// subnet, so adopting that address would replace a working LAN host with one that always fails.
func bonjourHost(_ h: String) -> Bool { isLANv4(h) && !h.hasPrefix("169.254.") }

/// Tailscale CGNAT IPv4 (100.64.0.0/10) or a lowercase MagicDNS name (*.ts.net): reachable only inside the user's tailnet.
func isTailnet(_ h: String) -> Bool {
    let o = h.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) ?? -1 }
    if o.count == 4, o.allSatisfy({ (0...255).contains($0) }), h.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == ".") }) {
        return o[0] == 100 && (64...127).contains(o[1])
    }
    return h.count <= 253 && h.hasSuffix(".ts.net") && h.count > 7 && !h.hasPrefix(".") && !h.contains("..")
        && h.allSatisfy({ $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "." || $0 == "-") })
}

struct Invite: Decodable { let v: Int; let host: String; let port: Int; let fp: String; let code: String; var ts: String? = nil }
/// QR / pasted payload from the Mac: {"v":1,"host","port","fp","code","ts"?}; ts = the Mac's Tailscale IP.
func parseInvite(_ s: String) -> Invite? {
    guard let d = s.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
          let i = try? JSONDecoder().decode(Invite.self, from: d), i.v == 1, isLANv4(i.host),
          (1...65535).contains(i.port), let fp = normFp(i.fp), (1...128).contains(i.code.count), i.ts.map(isTailnet) ?? true else { return nil }
    return Invite(v: 1, host: i.host, port: i.port, fp: fp, code: i.code, ts: i.ts)
}

/// Splits on triple-backtick fences: prose blocks and code blocks; lang is the fence's language tag ("" if none).
func mdBlocks(_ s: String) -> [(code: Bool, text: String, lang: String)] {
    s.components(separatedBy: "```").enumerated().compactMap { i, part in
        if i % 2 == 0 { let t = part.trimmingCharacters(in: .newlines); return t.isEmpty ? nil : (false, t, "") }
        var lines = part.components(separatedBy: "\n")
        let lang = lines.count > 1 ? lines.removeFirst().trimmingCharacters(in: .whitespaces) : ""
        return (true, lines.joined(separator: "\n").trimmingCharacters(in: .newlines), lang)
    }
}

/// One prose line classified for block rendering (headings, lists, quotes, rules); inline syntax stays for AttributedString.
enum MdLine: Equatable { case heading(Int, String), bullet(Int, String), number(Int, String, String), quote(String), rule, blank, text(String) }

/// "| a | b |" → ["a", "b"]; separator rows ("|---|:-:|") → [] so they are dropped; nil when not a table row.
/// Escaped pipes (\|) stay inside the cell as a literal "|".
func tableRow(_ raw: String) -> [String]? {
    let s = raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\\|", with: "\u{E000}")
    guard s.hasPrefix("|"), s.count > 1 else { return nil }
    var cells = s.dropFirst().components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\u{E000}", with: "|") }
    if s.hasSuffix("|") { cells.removeLast() }
    return cells.allSatisfy { !$0.isEmpty && $0.allSatisfy { "-:".contains($0) } } ? [] : cells
}

enum MdPart: Equatable { case line(String), table([[String]]) }

/// Prose split into plain lines and runs of consecutive table rows; an indented plain line continues the list item above it.
func mdParts(_ prose: String) -> [MdPart] {
    var out: [MdPart] = []
    for l in prose.components(separatedBy: "\n") {
        guard let row = tableRow(l) else {
            if l.hasPrefix("  "), case .text(let t) = mdLine(l), case .line(let p)? = out.last {
                switch mdLine(p) { case .bullet, .number: out[out.count - 1] = .line(p + " " + t); continue
                default: break }
            }
            out.append(.line(l)); continue
        }
        if case .table(var rows)? = out.last { if !row.isEmpty { rows.append(row) }; out[out.count - 1] = .table(rows) }
        else { out.append(.table(row.isEmpty ? [] : [row])) }
    }
    return out
}

// shortcut: line-based (list continuations are joined in mdParts); switch to swift-markdown if replies need nested blocks inside items.
func mdLine(_ raw: String) -> MdLine {
    let body = raw.drop { $0 == " " }, indent = (raw.count - body.count) / 2
    let s = String(body)
    if s.isEmpty { return .blank }
    if ["---", "***", "___"].contains(s) { return .rule }
    let hashes = s.prefix { $0 == "#" }.count
    if (1...6).contains(hashes), s.dropFirst(hashes).first == " " { return .heading(hashes, String(s.dropFirst(hashes + 1))) }
    if let f = s.first, "-*+".contains(f), s.dropFirst().first == " " { return .bullet(indent, String(s.dropFirst(2))) }
    let digits = s.prefix { $0.isNumber }
    if !digits.isEmpty, digits.count <= 3, s.dropFirst(digits.count).hasPrefix(". ") { return .number(indent, String(digits), String(s.dropFirst(digits.count + 2))) }
    if s.hasPrefix(">") { return .quote(String(s.dropFirst()).trimmingCharacters(in: .whitespaces)) }
    return .text(s)
}

/// DSH message content is a string or [ContentBlock]; only text is rendered, images become a marker (or nothing when shown as thumbnails).
func contentText(_ c: Any?, imageMarker: Bool = true) -> String {
    if let s = c as? String { return s }
    return (c as? [J] ?? []).compactMap { b -> String? in
        switch b["type"] as? String {
        case "text": return b["text"] as? String
        case "image": return imageMarker ? "🖼" : nil
        case "file": return "📎 " + (((b["attachment"] as? J)?["name"] as? String) ?? "file")
        default: return nil
        }
    }.joined(separator: "\n")
}

/// Attachment ids of the image blocks in a folded-log message (`{type:"image", attachment:{attachmentId}}`).
func imageIds(_ c: Any?) -> [String] {
    (c as? [J] ?? []).compactMap { $0["type"] as? String == "image" ? ($0["attachment"] as? J)?["attachmentId"] as? String : nil }
}

func usageText(_ u: J) -> String {
    // status line is one lineLimit(1) row: compact counts, cache/reasoning dropped so model + ctx never truncate
    let n = { (k: String) in (u[k] as? Int).map(compactCount) }
    return [("in", n("inputTokens")), ("out", n("outputTokens")), ("total", n("totalTokens"))]
        .compactMap { k, v in v.map { "\(k) \($0)" } }.joined(separator: " · ")
}

/// Full per-field usage, one per line, for the tap-to-expand status detail (the one-line row drops cache/reasoning).
func usageDetail(_ u: J) -> String {
    [("Input", "inputTokens"), ("Output", "outputTokens"), ("Cache read", "cacheReadTokens"), ("Cache write", "cacheWriteTokens"), ("Reasoning", "reasoningTokens"), ("Total", "totalTokens")]
        .compactMap { label, k in (u[k] as? Int).map { "\(label): \($0.formatted())" } }.joined(separator: "\n")
}

/// 950 → "950", 1_234 → "1.2k", 12_345 → "12k", 1_260_000 → "1.3M".
func compactCount(_ n: Int) -> String {
    if n < 1000 { return "\(n)" }
    if n < 1_000_000 { return String(format: n < 10_000 ? "%.1fk" : "%.0fk", Double(n) / 1000).replacingOccurrences(of: ".0k", with: "k") }
    return String(format: "%.1fM", Double(n) / 1_000_000).replacingOccurrences(of: ".0M", with: "M")
}

/// Context occupancy 0…1 from the newest usage sample, using desktop's pressure formula (input + cache read + cache write) / window.
func contextShare(_ u: J?, window: Double?) -> Double? {
    guard let u, let win = window, win > 0, let input = (u["inputTokens"] as? NSNumber)?.doubleValue else { return nil }
    let cache = ["cacheReadTokens", "cacheWriteTokens"].compactMap { (u[$0] as? NSNumber)?.doubleValue }.reduce(0, +)
    return min(1, (input + cache) / win)
}

/// Context is nearly full: warn and offer /compact before the model starts losing history.
func contextHot(_ share: Double?) -> Bool { (share ?? 0) >= 0.8 }

/// Folds one DSH `agent/inbox/spliced` event into the pending-input lists (same splice rule as desktop's inbox projection).
/// Out-of-range splices are clamped: a snapshot window can start after the event that queued an item.
func applySplice(_ inbox: inout [String: [J]], _ d: J) {
    guard let t = d["target"] as? String else { return }
    var list = inbox[t] ?? []
    let start = min(max(d["start"] as? Int ?? 0, 0), list.count)
    let n = min(max(d["removedCount"] as? Int ?? 0, 0), list.count - start)
    list.replaceSubrange(start..<start + n, with: d["inserted"] as? [J] ?? [])
    inbox[t] = list
}

/// "model · effort" from a DSH model selection ({provider, model, reasoningEffort}).
func modelLabel(_ s: J?) -> String? {
    guard let m = s?["model"] as? String else { return nil }
    return [m, s?["reasoningEffort"] as? String].compactMap { $0 }.joined(separator: " · ")
}

/// Whether a shown "model · effort" label is this model (and effort, when given); drives the menu checkmarks.
func modelMatches(_ shown: String?, _ model: String, _ effort: String? = nil) -> Bool {
    guard let shown else { return false }
    if let effort { return shown == model + " · " + effort }
    return shown == model || shown.hasPrefix(model + " · ")
}

func compactJSON(_ v: Any?, limit: Int = 300) -> String {
    guard let v else { return "" }
    if let s = v as? String { return String(s.prefix(limit)) }
    guard JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]) else { return "\(v)".prefix(limit).description }
    return String(decoding: d, as: UTF8.self).prefix(limit).description
}

/// Codex-style tool row title: "name  <main argument>" (command, path, query…); raw JSON only when no known key is present.
func toolSummary(_ name: String, _ args: Any?) -> String {
    let a = args as? J ?? [:]
    let main = ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "prompt", "description"].lazy.compactMap { a[$0] as? String }.first
    return "\(name) \(main.map { String($0.prefix(300)) } ?? compactJSON(args))".trimmingCharacters(in: .whitespaces)
}

// MARK: - Models

struct Pairing: Codable { var host: String; var port: Int; var fp: String; var token: String; var deviceId: String; var name: String; var expiresAt: String; var ts: String? = nil }

/// A picked file waiting to be uploaded with the next prompt.
struct Attachment: Identifiable {
    let id = UUID(); let name: String; let data: Data
    /// base64 grows ~33%, so 10 MB stays under the gateway's 16 MB body cap.
    static let maxBytes = 10 << 20
    static func load(_ url: URL) throws -> Attachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= maxBytes else { throw Fail(String(localized: "\(url.lastPathComponent) is larger than 10 MB")) }
        let d = try Data(contentsOf: url)
        guard d.count <= maxBytes else { throw Fail(String(localized: "\(url.lastPathComponent) is larger than 10 MB")) }
        return Attachment(name: url.lastPathComponent, data: d)
    }
}

struct Line: Identifiable {
    enum Kind { case user, assistant, reasoning, command, tool, result, error }
    let id = UUID(); let kind: Kind; let text: String
    /// Tool rows only: the result is folded into its call (matched by callId) instead of a separate line.
    var callId: String? = nil; var args: String? = nil; var output: String? = nil; var failed = false
    /// User rows only: image attachment ids, fetched lazily via session/attachment.
    var images: [String] = []
}

/// Regenerate: the user message that produced `id` (nearest user row above it).
func promptLine(before id: UUID, in t: [Line]) -> Line? {
    guard let i = t.firstIndex(where: { $0.id == id }) else { return nil }
    return t[..<i].last { $0.kind == .user }
}

/// Retry for a failed turn: only the transcript's last line, and only when it is an error, offers re-sending its prompt.
func retryPrompt(for id: UUID, in t: [Line]) -> Line? {
    guard let last = t.last, last.id == id, last.kind == .error else { return nil }
    return promptLine(before: id, in: t)
}

/// True when no user prompt follows the line, i.e. it belongs to the turn in flight.
func inCurrentTurn(_ id: UUID, in t: [Line]) -> Bool {
    guard let i = t.firstIndex(where: { $0.id == id }) else { return false }
    return !t[(i + 1)...].contains { $0.kind == .user }
}

/// Approval sheet: the pending tool call's summary and arguments, so the user sees what they allow (matched by callId).
func approvalCall(_ req: J, in t: [Line]) -> Line? {
    guard let cid = req["callId"] as? String else { return nil }
    return t.last { $0.kind == .tool && $0.callId == cid }
}

/// Share conversation: user/assistant turns as Markdown; tool, reasoning and error rows are left out.
func transcriptMarkdown(_ t: [Line], title: String) -> String {
    let body = t.compactMap { l -> String? in
        switch l.kind {
        case .user: return "**You:** " + l.text
        case .assistant: return l.text
        default: return nil
        }
    }
    return (["# " + title] + body).joined(separator: "\n\n")
}

/// Codex-style turn timer: "7s", "1m 05s", "1h 02m".
func elapsedText(_ s: Int) -> String {
    let s = max(0, s)
    if s < 60 { return "\(s)s" }
    if s < 3600 { return String(format: "%dm %02ds", s / 60, s % 60) }
    return String(format: "%dh %02dm", s / 3600, s % 3600 / 60)
}

/// DSH TodoItem: status is pending | in_progress | completed.
struct Todo: Equatable { let content: String, status: String }
func parseTodos(_ v: Any?) -> [Todo]? {
    (v as? [J])?.compactMap { t in (t["content"] as? String).map { Todo(content: $0, status: t["status"] as? String ?? "pending") } }
}

/// DSH userQuestions projection: {active:[{callId, questions, state}]}, possibly wrapped in {val:…}. Every active row is still answerable,
/// so a phone that connects after the question was asked can still answer it (waterfall events only reach clients online at the time).
func parseQuestions(_ v: Any?, session: String) -> [Prompt] {
    let j = v as? J, a = ((j?["val"] as? J) ?? j)?["active"] as? [J] ?? []
    return a.compactMap { r in (r["callId"] as? String).map { Prompt(id: $0, event: "userQuestions/answer", agentId: session, request: r) } }
}

struct Sess: Identifiable {
    let id: String, title: String, cwd: String, parent: String?, running: Bool, preset: String?, model: String?, context: Double?, permission: String?, todos: [Todo]?, updated: Date?, questions: [Prompt], goal: Goal?
    init?(_ j: J) {
        guard let id = j["sessionId"] as? String else { return nil }
        let p = (j["projections"] as? J)?["values"] as? J
        self.id = id; title = (p?["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Untitled")
        // shortcut: parent read from list item or subagent projection, both unverified live (no subagent sessions seen); check once a subagent runs.
        cwd = j["cwd"] as? String ?? ""; parent = (j["parentSessionId"] ?? (p?["subagent"] as? J)?["parentSessionId"]) as? String
        running = j["running"] as? Bool ?? false; preset = p?["agentPreset"] as? String
        updated = (j["updatedAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
        permission = (p?["permissions"] as? J)?["currentValue"] as? String
        todos = parseTodos(p?["todos"])
        questions = parseQuestions(p?["userQuestions"], session: id)
        // Projection nests the goal: {val?:{goal:{id,revision,phase,...}, roundsStarted}}; flatten for Goal.
        let gv = (p?["goal"] as? J).map { ($0["val"] as? J) ?? $0 }
        goal = Goal((gv?["goal"] as? J)?.merging(gv ?? [:]) { a, _ in a })
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
    /// DSH plan-review intent: the label that approves the plan in one tap.
    var approve: String? = nil
    static func parse(_ r: J) -> [Question] {
        (r["questions"] as? [J] ?? []).compactMap { q in
            guard let id = q["id"] as? String else { return nil }
            let intent = q["intent"] as? J
            return Question(id: id, question: q["question"] as? String ?? "", detail: q["detail"] as? String, header: q["header"] as? String,
                            multi: q["multiSelect"] as? Bool ?? false,
                            options: (q["options"] as? [J] ?? []).compactMap { o in (o["label"] as? String).map { Opt(label: $0, desc: o["description"] as? String) } },
                            approve: intent?["kind"] as? String == "plan-review" ? intent?["approve"] as? String : nil)
        }
    }
}

struct ModelGroup: Identifiable { let id: String, name: String; let models: [Model] }
struct Model: Identifiable { let id: String, name: String; let efforts: [String] }
struct Preset: Identifiable { let id: String, name: String; let desc: String?; let broken: Bool; var isDefault = false }
/// DSH presets often ship only an id ("ptc", "standard"); show "PTC" / "Standard" instead of raw ids.
func presetLabel(_ id: String) -> String { id.count <= 3 ? id.uppercased() : id.prefix(1).uppercased() + id.dropFirst() }
// The catalog sends raw ids as names; DSH desktop labels them itself, so mirror its labels.
func permLabel(_ id: String, _ name: String?) -> String {
    let known = ["read-only": "Read only", "workspace-write": "Workspace write", "danger-full-access": "Full access", "auto": "Auto review (experimental)"]
    if let n = name, n != id, !n.isEmpty { return n }
    return known[id] ?? id
}
/// The session's preset only when it isn't the default one; the composer chip shows nothing otherwise.
func customPreset(_ cur: String?, _ presets: [Preset]) -> Preset? {
    guard let cur, presets.first(where: { $0.isDefault })?.id != cur else { return nil }
    return presets.first { $0.id == cur }
}
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
    var paused: Bool { phase == "paused" }
    /// "paused · 2/10" for the conversation's goal card.
    var summary: String { [phase, max > 0 ? "\(rounds)/\(max)" : rounds > 0 ? "\(rounds)" : ""].filter { !$0.isEmpty }.joined(separator: " · ") }
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
final class Pinner: NSObject, URLSessionTaskDelegate {
    let fp: String
    init(fp: String) { self.fp = fp }
    func urlSession(_ s: URLSession, didReceive ch: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        // Non-trust challenges (e.g. client-certificate probes) must not kill the handshake; default handling sends no cert and never bypasses the pin below.
        guard ch.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else { return (.performDefaultHandling, nil) }
        guard let t = ch.protectionSpace.serverTrust,
              let leaf = (SecTrustCopyCertificateChain(t) as? [SecCertificate])?.first,
              pinMatches(der: SecCertificateCopyData(leaf) as Data, fp: fp) else { return (.cancelAuthenticationChallenge, nil) }
        return (.useCredential, URLCredential(trust: t))
    }
    // WebSocket tasks may deliver the trust challenge at task level; same pin, same rules.
    func urlSession(_ s: URLSession, task: URLSessionTask, didReceive ch: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        await urlSession(s, didReceive: ch)
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
    @Published var tab = 0 // 0 Sessions, 1 Agents, 2 Settings
    @Published var sessions: [Sess] = []
    @Published var sessionsLoaded = false // a session/list reply arrived for this pairing
    /// Sessions whose turn ended while you were elsewhere; cleared when opened (desktop's unread dot).
    @Published var finished = Set(UserDefaults.standard.stringArray(forKey: "finished") ?? []) {
        didSet { UserDefaults.standard.set(Array(finished), forKey: "finished") }
    }
    @Published var current: String?
    @Published var transcript: [Line] = []
    @Published var streaming = ""
    @Published var reasoning = ""
    @Published var running = false
    /// DSH's own turn/start time (event `time`, ms), so the turn timer is right even when the chat is opened mid-turn.
    @Published var turnStartedAt: Date?
    /// What prompt() is doing right now ("Uploading x…" / "Sending…"), shown under the optimistic bubble.
    @Published var sendStatus: String?
    @Published var usage: J?
    /// Context-window size from the newest `request/context` record; nil until one is seen in this session's log.
    @Published var contextWindow: Double?
    @Published var model: String?
    @Published var defaultModel: String?
    @Published var catalog: [ModelGroup] = []
    @Published var workspaces: [Workspace] = []
    @Published var pinned: [String] = []
    @Published var archived: [String] = []
    @Published var commands: [Cmd] = []
    @Published var presets: [Preset] = []
    @Published var perms: [Preset] = [] // permissionPresets/catalog options (id = value)
    @Published var skills: [Cmd] = []
    @Published var liveTodos: [Todo]? // latest todo/write in the follow stream; nil = not seen yet
    var shownTodos: [Todo] { liveTodos ?? currentSess?.todos ?? [] }
    @Published var goal: Goal?
    /// The follow snapshot is a window; true when DSH has earlier history to page in via session/page.
    @Published var hasOlder = false
    private var oldestSeq: Int?, throughSeq: Int?, replaying = false
    /// Pending prompts (DSH inbox): "next-turn" waits for the running turn, "next-step" is steering.
    @Published var inbox: [String: [J]] = [:]
    var queued: [J] { (inbox["next-step"] ?? []) + (inbox["next-turn"] ?? []) }
    @Published var prompts: [Prompt] = []
    @Published var found: [String: Found] = [:]
    enum Route { case lan, tailscale }
    @Published var route: Route?
    @Published var onWiFi = true
    /// Why the last attempt failed, per address; shown in Settings so a dead route is visible instead of guessed.
    @Published var lastFail: String?

    private var urlSession: URLSession?, sessionFp = ""
    private var ws: URLSessionWebSocketTask?
    private var followId: String?
    private var attempt = 0, probing = false
    private var browser: NWBrowser?
    private var pathMon: NWPathMonitor?

    var currentSess: Sess? { sessions.first { $0.id == current } }
    /// Plain-language problem with DSH behind the gateway; nil when fine or unknown.
    var upstreamText: String? {
        switch upstream {
        case "", "connected": return nil
        case "disconnected": return String(localized: "DSH is closed or restarting on your Mac.")
        case let s where s.hasPrefix("waiting"): return String(localized: "Turn on the Tether plugin (dsh-mobile-bridge) in DSH on your Mac.")
        default: return String(localized: "DSH on your Mac is not responding.")
        }
    }
    /// What the next turn will use: live header/selection, else the session's saved selection, else DSH's default.
    var shownModel: String? { model ?? currentSess?.model ?? defaultModel }
    func title(_ id: String) -> String { sessions.first { $0.id == id }?.title ?? String(id.prefix(8)) }

    /// Unsent composer text per session, kept across navigation and app restarts (text only).
    func draft(_ sid: String?) -> String { (UserDefaults.standard.dictionary(forKey: "drafts") as? [String: String])?[sid ?? ""] ?? "" }
    func setDraft(_ t: String, _ sid: String?) {
        guard let sid else { return }
        var d = UserDefaults.standard.dictionary(forKey: "drafts") as? [String: String] ?? [:]
        d[sid] = t.isEmpty ? nil : t
        UserDefaults.standard.set(d, forKey: "drafts")
    }

    /// Sidebar order like desktop DSH: pinned, one section per project, unassigned, archived.
    /// `project` (a workspace id) narrows every group to that project; an unknown id shows everything.
    func sessionGroups(project: String? = nil) -> [(title: String, items: [Sess])] {
        // newest activity first inside each group, like the desktop sidebar; pinned keeps the user's pin order
        let only = workspaces.first { $0.id == project }
        let roots = sessions.filter { $0.parent == nil && (only?.sessions.contains($0.id) ?? true) }.sorted { ($0.updated ?? .distantPast) > ($1.updated ?? .distantPast) }
        let rest = roots.filter { !pinned.contains($0.id) && !archived.contains($0.id) }
        var out = [(String(localized: "Pinned"), pinned.compactMap { id in roots.first { $0.id == id } })]
        var used = Set<String>()
        for w in workspaces { let s = rest.filter { w.sessions.contains($0.id) }; used.formUnion(s.map(\.id)); out.append((w.title, s)) }
        out.append((String(localized: "Ungrouped"), rest.filter { !used.contains($0.id) }))
        out.append((String(localized: "Archived"), roots.filter { archived.contains($0.id) }))
        return out.filter { !$0.1.isEmpty }.map { (title: $0.0, items: $0.1) }
    }

    /// Instant title filter while typing; server search adds content hits after a pause.
    func titleMatches(_ q: String, project: String? = nil) -> [Sess] {
        let q = q.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return [] }
        let only = workspaces.first { $0.id == project }
        return sessions.filter { $0.parent == nil && (only?.sessions.contains($0.id) ?? true) && $0.title.localizedStandardContains(q) }
            .sorted { ($0.updated ?? .distantPast) > ($1.updated ?? .distantPast) }
    }

    func run(_ op: @escaping @MainActor () async throws -> Void) { Task { do { try await op() } catch { self.error = userText(error) } } }

    private func http(_ fp: String) -> URLSession {
        if urlSession == nil || fp != sessionFp {
            urlSession?.invalidateAndCancel()
            urlSession = URLSession(configuration: .ephemeral, delegate: Pinner(fp: fp), delegateQueue: nil); sessionFp = fp
        }
        return urlSession!
    }

    /// Addresses to try: LAN first on Wi-Fi, Tailscale first elsewhere.
    private func addrs(_ host: String, _ ts: String?) -> [(String, Route)] {
        let all: [(String, Route)] = [(host, .lan)] + (ts.map { [($0, .tailscale)] } ?? [])
        return onWiFi ? all : all.reversed()
    }

    private func call(_ path: String, _ body: Any?) async throws -> Any? {
        guard let p = pairing else { throw Fail(String(localized: "Not paired")) }
        let list = addrs(p.host, p.ts)
        var got: (Data, URLResponse)?
        var fails: [String] = []
        for (n, (host, rt)) in list.enumerated() {
            var r = URLRequest(url: URL(string: "https://\(host):\(p.port)\(path)")!)
            if n < list.count - 1 { r.timeoutInterval = 5 } // fallback exists: fail fast
            r.setValue("Bearer \(p.token)", forHTTPHeaderField: "Authorization")
            if let body {
                r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                r.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            do { got = try await http(p.fp).data(for: r); route = rt; lastFail = nil; break }
            catch let e as URLError {
                fails.append("\(rt == .lan ? "LAN" : "Tailscale") \(host): \(failText(e))")
                if n == list.count - 1 { lastFail = fails.joined(separator: "\n"); throw e }
            }
        }
        guard let (d, resp) = got else { throw Fail("Unreachable") }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0, json = try? JSONSerialization.jsonObject(with: d)
        if code == 401 { forget(String(localized: "This iPhone was revoked or its token expired. Pair again.")) }
        guard code == 200 else {
            let m = ((json as? J)?["error"] as? String) ?? "HTTP \(code)"
            if m == "DSH host unavailable" { upstream = "disconnected"; throw Fail(String(localized: "DSH is closed or restarting on your Mac. Try again in a moment.")) }
            throw Fail(gatewayText(code, m))
        }
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
            let list = addrs(inv.host, inv.ts)
            var got: (Data, URLResponse)?
            for (n, (host, _)) in list.enumerated() {
                // Mac holds the reply until approved (≤120 s); only the last address gets the long wait.
                var r = URLRequest(url: URL(string: "https://\(host):\(inv.port)/pair")!, timeoutInterval: n < list.count - 1 ? 5 : 150)
                r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                r.httpBody = try JSONSerialization.data(withJSONObject: ["code": inv.code, "name": UIDevice.current.name])
                do { got = try await http(inv.fp).data(for: r); break }
                catch let e as URLError where n < list.count - 1 { _ = e; continue }
            }
            guard let (d, resp) = got else { throw Fail("Unreachable") }
            guard (resp as? HTTPURLResponse)?.statusCode == 200, let o = try JSONSerialization.jsonObject(with: d) as? J,
                  let token = o["token"] as? String, token.count >= 40, let id = o["deviceId"] as? String
            else { throw Fail(String(localized: "Pairing was denied or the code expired. Show a fresh QR code on the Mac.")) }
            pairing = Pairing(host: inv.host, port: inv.port, fp: inv.fp, token: token, deviceId: id, name: o["name"] as? String ?? "", expiresAt: o["expiresAt"] as? String ?? "", ts: inv.ts)
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            connect()
        } catch { self.error = userText(error) }
    }

    func forget(_ why: String? = nil) {
        ws?.cancel(with: .goingAway, reason: nil); ws = nil; followId = nil
        pairing = nil; sessions = []; sessionsLoaded = false; transcript = []; prompts = []; current = nil; path = []; goal = nil; state = .off
        UserDefaults.standard.removeObject(forKey: "seenSessions")
        if let why { error = why }
    }

    func setAddress(_ host: String, _ port: Int?) {
        guard isLANv4(host) || isTailnet(host), let port, (1...65535).contains(port) else { error = String(localized: "Enter a private LAN or Tailscale address and port."); return }
        let lan = isLANv4(host)
        if lan { pairing?.host = host } else { pairing?.ts = host }
        pairing?.port = port; lastFail = nil
        reconnect(via: lan ? .lan : .tailscale) // try the address the user just typed first, no LAN probe
    }

    // MARK: Mux socket

    func connect() {
        guard let p = pairing, ws == nil else { return }
        // Unknown route + a fallback exists: probe /me first (5 s per address) instead of guessing. Guessing LAN on a
        // foreign Wi‑Fi (office) left the socket stuck on "connecting" for the full timeout.
        if route == nil, p.ts != nil {
            guard !probing else { return }
            probing = true
            state = attempt == 0 ? .connecting : .reconnecting
            Task { await self.refreshMe(); self.probing = false; if self.route == nil { self.route = self.onWiFi ? .lan : .tailscale }; self.connect() }
            return
        }
        let host = (route ?? .lan) == .tailscale ? (p.ts ?? p.host) : p.host
        var r = URLRequest(url: URL(string: "wss://\(host):\(p.port)/api/remote.mux")!)
        r.setValue("Bearer \(p.token)", forHTTPHeaderField: "Authorization")
        let t = http(p.fp).webSocketTask(with: r)
        t.maximumMessageSize = 16 << 20
        ws = t; state = attempt == 0 ? .connecting : .reconnecting
        t.resume(); listen(t)
        send(["type": "open", "streamId": "ev", "endpoint": "$events", "payload": ["args": J()]])
        send(["type": "open", "streamId": "ws", "endpoint": "workspace/follow", "payload": ["args": J()]])
        if let s = current { openFollow(s) }
    }

    func reconnect(via r: Route? = nil) { ws?.cancel(with: .goingAway, reason: nil); ws = nil; followId = nil; attempt = 0; route = r; connect() }

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
                case .failure(let e):
                    if self.state != .connected { self.lastFail = "WebSocket \(t.originalRequest?.url?.host ?? ""): \(failText(e))" }
                    self.drop()
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
        guard let me = try? await call("/me", nil) as? J else { upstream = ""; return } // Mac itself unreachable: don't blame DSH
        upstream = me["upstream"] as? String ?? ""
        if let e = me["expiresAt"] as? String { pairing?.expiresAt = e }
        if let t = me["tailscale"] as? String, isTailnet(t), t != pairing?.ts { pairing?.ts = t } // learned without re-pairing
    }

    private func onFrame(_ f: J) {
        let id = f["streamId"] as? String
        switch f["type"] as? String {
        case "item":
            guard let v = f["value"] as? J else { return }
            if id == "ev" { onEvent(v) } else if id == "ws" { onWorkspace(v) } else if id == followId { onFollow(v) }
        case "error":
            let m = (f["error"] as? J)?["message"] as? String
            if m == "DSH host unavailable" { upstream = "disconnected" } else { error = m } // banner covers it; no blocking alert
            // A failed follow must not leave followId set, or follow() thinks the conversation is live and never reopens it.
            if id == followId, let s = current {
                followId = nil
                Task { try? await Task.sleep(for: .seconds(3)); if self.current == s, self.followId == nil, self.ws != nil { self.openFollow(s) } }
            }
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
            if let e = v["event"] as? String, ["api-session/added", "api-session/removed", "api-session/status", "api-session/activity", "agent-preset/selected"].contains(e) {
                Task { try? await loadSessions() }
            }
            if v["event"] as? String == "api-session/error" { sessionError(v["args"] as? [Any] ?? []) }
            if v["event"] as? String == "goal/activation-changed" { Task { await loadGoal() } }
            // Desktop edited slash commands / permission presets: refresh so the phone's pickers don't go stale.
            if v["event"] as? String == "commands/change" { Task { await loadCommands() } }
            if v["event"] as? String == "permission-presets/catalog-changed" { Task { await loadAgents() } }
        default: break
        }
    }

    /// DSH's live failures with no turn position (agent crash, provider/activation error): args = [sessionId, message].
    func sessionError(_ args: [Any]) {
        guard args.count >= 2, let sid = args[0] as? String, let m = args[1] as? String, !m.isEmpty else { return }
        if sid == current {
            if transcript.last?.kind != .error || transcript.last?.text != m { transcript.append(Line(kind: .error, text: m)) }
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        } else {
            notify(String(localized: "DSH error"), (sessions.first { $0.id == sid }?.title).map { "\($0): \(m)" } ?? m)
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

    /// Show a session's conversation from any tab (e.g. a subagent row in Agents).
    func open(_ sid: String) { finished.remove(sid); follow(sid); path = [sid]; tab = 0 }

    func follow(_ sid: String) {
        if sid == current, followId != nil { return } // re-opening the live session keeps its stream and transcript
        if let old = followId { send(["type": "cancel", "streamId": old]) }
        current = sid; transcript = []; streaming = ""; reasoning = ""; usage = nil; contextWindow = nil; model = nil; goal = nil; inbox = [:]; liveTodos = nil
        hasOlder = false; oldestSeq = nil; throughSeq = nil
        running = currentSess?.running ?? false
        openFollow(sid)
        Task { await loadCommands(); await loadGoal() }
    }

    private func openFollow(_ sid: String) {
        let id = "f-" + UUID().uuidString; followId = id
        send(["type": "open", "streamId": id, "endpoint": "session/follow",
              "payload": ["args": ["request": ["address": ["kind": "session", "sessionId": sid], "assistantStream": true]]]])
    }

    private func onFollow(_ v: J) {
        switch v["type"] as? String {
        case "snapshot":
            let events = (v["records"] as? [J] ?? []).compactMap { $0["event"] as? J }
            replaySnapshot(events)
            hasOlder = v["hasMore"] as? Bool == true && oldestSeq != nil
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

    /// History replay: rebuilds lines and live state but never re-fires per-turn side effects (notification, haptic, goal reload).
    func replaySnapshot(_ events: [J]) {
        transcript = []; streaming = ""; reasoning = ""; inbox = [:]; liveTodos = nil; turnStartedAt = nil
        replaying = true; events.forEach(apply); replaying = false
        oldestSeq = events.first?["seq"] as? Int; throughSeq = events.last?["seq"] as? Int
    }

    func apply(_ e: J) {
        let d = e["data"] as? J ?? [:]
        switch e["type"] as? String {
        case "user/message":
            // DSH also logs runtime-context / skill-catalog injections as user messages; show only what the user typed.
            let kind = (d["source"] as? J)?["kind"] as? String
            if kind == nil || kind == "user" { transcript.append(Line(kind: .user, text: contentText(d["content"], imageMarker: false), images: imageIds(d["content"]))) }
        case "request/header":
            if let m = modelLabel((d["header"] as? J)?["config"] as? J) { model = m }
        case "request/context":
            if model == nil, let m = d["model"] as? String { model = m }
            if let w = (d["contextWindow"] as? NSNumber)?.doubleValue { contextWindow = w }
        case "assistant/message":
            let content = (d["message"] as? J)?["content"]
            let r = (content as? [J] ?? []).filter { $0["type"] as? String == "reasoning" }.compactMap { $0["text"] as? String }.joined(separator: "\n")
            if !r.isEmpty { transcript.append(Line(kind: .reasoning, text: r)) }
            let t = contentText(content)
            if !t.isEmpty { transcript.append(Line(kind: .assistant, text: t)) }
            if let u = d["usage"] as? J { usage = u }
        case "command/run": transcript.append(Line(kind: .command, text: "/\(d["name"] as? String ?? "") \(d["args"] as? String ?? "")".trimmingCharacters(in: .whitespaces)))
        case "command/done": if let t = d["text"] as? String, !t.isEmpty { transcript.append(Line(kind: d["kind"] as? String == "error" ? .error : .result, text: t)) }
        case "tool/call": transcript.append(Line(kind: .tool, text: toolSummary(d["name"] as? String ?? "tool", d["arguments"]), callId: d["callId"] as? String, args: compactJSON(d["arguments"], limit: 4000)))
        case "tool/result":
            let m = d["message"] as? J
            let bad = m?["isError"] as? Bool == true || d["error"] != nil
            let out = String(contentText(m?["content"]).prefix(600))
            if let cid = (m?["toolCallId"] ?? (m?["source"] as? J)?["callId"]) as? String, let i = transcript.lastIndex(where: { $0.callId == cid }) {
                transcript[i].output = out; transcript[i].failed = bad
            } else { transcript.append(Line(kind: bad ? .error : .result, text: out)) }
        case "turn/start":
            running = true
            turnStartedAt = (e["time"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
        case "agent/inbox/spliced": applySplice(&inbox, d)
        case "todo/write": liveTodos = parseTodos(d["todos"]) ?? []
        case "turn/end":
            if let m = ((d["reason"] as? J)?["error"] as? J)?["message"] as? String { transcript.append(Line(kind: .error, text: m)) }
            if running, !replaying {
                notify(String(localized: "Turn finished"), currentSess?.title ?? "")
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
            running = false
            turnStartedAt = nil
            if goal != nil, !replaying { Task { await loadGoal() } } // rounds / phase move per turn
        default: break
        }
    }

    /// DSH desktop's history page shape: up to 500 messages, at least 2 whole turns.
    static func pageRequest(_ sid: String, through: Int, before: Int) -> J {
        ["request": ["address": ["kind": "session", "sessionId": sid], "throughSeq": through, "beforeSeq": before,
                     "maxMessages": 500, "turnWindow": ["minMessages": 50, "minTurns": 2]]]
    }

    func loadOlder() async throws {
        guard let sid = current, let before = oldestSeq, let through = throughSeq else { return }
        let v = try await rpc("session/page", Self.pageRequest(sid, through: through, before: before)) as? J
        guard current == sid, oldestSeq == before else { return } // session switched or snapshot replaced meanwhile
        prependHistory((v?["records"] as? [J] ?? []).compactMap { $0["event"] as? J })
        hasOlder = v?["hasMore"] as? Bool == true
    }

    /// Old events build lines only; live state (running, model, usage, todos, inbox, goal) stays as the snapshot left it.
    func prependHistory(_ events: [J]) {
        guard !events.isEmpty else { return }
        let keep = (transcript, running, model, usage, liveTodos, inbox, goal, contextWindow, turnStartedAt)
        replaying = true; transcript = []
        events.forEach(apply)
        replaying = false
        transcript += keep.0; running = keep.1; model = keep.2; usage = keep.3; liveTodos = keep.4; inbox = keep.5; goal = keep.6
        contextWindow = keep.7; turnStartedAt = keep.8
        oldestSeq = events.first?["seq"] as? Int ?? oldestSeq
    }

    // MARK: Actions (wire shapes from the DSH host types)

    func loadSessions() async throws {
        // Remote session/list returns every visible session with no cursor (e2e asserts this).
        let v = try await rpc("session/list", ["_request": J()]) as? J
        let fresh = (v?["items"] as? [J] ?? []).compactMap(Sess.init)
        // Cold start: compare against the last list seen before the app was closed, so turns that finished meanwhile still get a dot.
        let old = sessions.isEmpty ? (UserDefaults.standard.array(forKey: "seenSessions") as? [J] ?? []).compactMap(Sess.init) : sessions
        // Drop dots for sessions that vanished (archived elsewhere) so the badge can't stick.
        finished = finished.intersection(fresh.map(\.id)).union(Self.justFinished(old: old, new: fresh, current: current))
        sessions = fresh
        sessionsLoaded = true
        // session/list carries projections.values.userQuestions ({active, settled}, verified live by gateway/e2e.mjs).
        let live = prompts.filter { $0.event != "userQuestions/answer" }, waiting = Set(live.compactMap(\.agentId))
        prompts = live + fresh.flatMap(\.questions).filter { !waiting.contains($0.agentId ?? "") }
        UserDefaults.standard.set(Self.snapshot(fresh), forKey: "seenSessions")
        if let s = currentSess, s.running != running, streaming.isEmpty { running = s.running }
    }

    /// Just the fields justFinished compares, in the wire shape Sess.init reads back.
    static func snapshot(_ s: [Sess]) -> [J] {
        s.map { s in
            var j: J = ["sessionId": s.id, "running": s.running, "projections": ["values": ["title": s.title]]]
            if let u = s.updated { j["updatedAt"] = u.timeIntervalSince1970 * 1000 }
            return j
        }
    }

    /// Not the open chat, idle now, and either was running last list or got a newer updatedAt (a whole turn between two refreshes) without a rename.
    static func justFinished(old: [Sess], new: [Sess], current: String?) -> Set<String> {
        let prev = Dictionary(old.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return Set(new.filter { n in
            guard !n.running, n.id != current, let o = prev[n.id] else { return false }
            if o.running { return true }
            guard let a = o.updated, let b = n.updated else { return false }
            return b > a && o.title == n.title
        }.map(\.id))
    }

    func create(cwd: String?, workspaceId: String? = nil) async throws {
        var r = J(); if let cwd, !cwd.isEmpty { r["cwd"] = cwd }; if let workspaceId { r["workspaceId"] = workspaceId }
        let v = try await rpc("session/create", ["request": r]) as? J
        try await loadSessions()
        if let id = v?["sessionId"] as? String { open(id) }
    }

    func fork(_ id: String) async throws {
        let v = try await rpc("session/fork", ["request": ["sessionId": id]]) as? J
        try await loadSessions()
        if let n = v?["sessionId"] as? String { open(n) }
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
        guard current == sid else { return } // session switched while loading; don't show the old session's commands
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
        guard let t = cleanTitle(title) else { return }
        _ = try await rpc("session/rename", ["request": ["sessionId": id, "title": t]]); try await loadSessions()
    }

    func search(_ q: String) async throws -> [Hit] {
        let v = try await rpc("session/search", ["request": ["query": q]]) as? J
        return (v?["items"] as? [J] ?? []).compactMap { i in (i["sessionId"] as? String).map { Hit(session: $0, snippet: i["snippet"] as? String ?? "") } }
    }

    /// mode "queue" starts a turn or waits behind the running one (desktop's default busy-Enter, shown in its QueueDock);
    /// "steer" injects into the running turn. Composer sends always queue; the queue dock's "Send now" steers.
    func prompt(_ text: String, images: [Data], files: [Attachment] = [], steer: Bool = false) async throws {
        guard let sid = current else { return }
        defer { sendStatus = nil }
        var receipts: [String] = []
        // receipts are scoped to this session; the host resolves them when the prompt arrives
        for f in files {
            sendStatus = String(localized: "Uploading \(f.name)…")
            let v = try await rpc("fileUploads/upload", ["agentId": sid, "request": ["data": f.data.base64EncodedString(), "name": f.name]]) as? J
            guard let r = v?["receiptId"] as? String else { throw Fail(String(localized: "Upload failed: \(f.name)")) }
            receipts.append(r)
        }
        sendStatus = String(localized: "Sending…")
        let content = Self.promptContent(text, images: images, receipts: receipts)
        _ = try await rpc("session/prompt", ["request": ["requestId": UUID().uuidString, "sessionId": sid, "mode": steer ? "steer" : "queue", "content": content]])
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func promptContent(_ text: String, images: [Data], receipts: [String]) -> [J] {
        (text.isEmpty ? [] : [["type": "text", "text": text]])
            + images.map { ["type": "image", "mediaType": "image/jpeg", "data": $0.base64EncodedString()] }
            + receipts.map { ["type": "file", "receiptId": $0] }
    }

    func stop() async throws {
        guard let sid = current else { return }
        _ = try await rpc("session/cancel", ["request": ["sessionId": sid]])
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// Re-send a user line with its images (refetched from the host); fails instead of silently dropping one.
    func resend(_ line: Line) async throws {
        var imgs: [Data] = []
        for id in line.images {
            guard let d = await image(id)?.jpegData(compressionQuality: 0.8) else { throw Fail(String(localized: "Couldn't load an attached image")) }
            imgs.append(d)
        }
        try await prompt(line.text, images: imgs)
    }

    /// NSCache evicts under memory pressure, so long chats with many images can't grow memory unbounded.
    private let imageCache = NSCache<NSString, UIImage>()
    /// Bytes of one image the current session references (desktop's readAttachment); cached per attachment id.
    func image(_ id: String) async -> UIImage? {
        if let i = imageCache.object(forKey: id as NSString) { return i }
        guard let sid = current, let v = try? await rpc("session/attachment", ["request": ["sessionId": sid, "attachmentId": id]]) as? J,
              let b = v["data"] as? String, let d = Data(base64Encoded: b), let i = UIImage(data: d) else { return nil }
        imageCache.setObject(i, forKey: id as NSString)
        return i
    }

    /// Queue edits like desktop's QueueDock: action is ["kind": "edit", "content": …] / ["kind": "remove"] / ["kind": "steer"].
    func updateQueue(_ itemId: String, _ action: J) async throws {
        guard let sid = current else { return }
        _ = try await rpc("session/updateQueue", ["request": ["sessionId": sid, "itemId": itemId, "action": action]])
    }

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
                (p["id"] as? String).map { Preset(id: $0, name: p["name"] as? String ?? presetLabel($0), desc: p["description"] as? String, broken: p["broken"] as? Bool ?? false, isDefault: p["isDefault"] as? Bool ?? false) }
            }
        }
        if let v = try? await rpc("permissionPresets/catalog") as? J {
            perms = (v["options"] as? [J] ?? []).compactMap { o in
                (o["value"] as? String).map { Preset(id: $0, name: permLabel($0, o["name"] as? String), desc: o["description"] as? String, broken: false) }
            }
        }
        skills = []
        if let sid = current, let v = try? await rpc("skills/list", ["request": ["sessionId": sid]]) as? J {
            skills = (v["skills"] as? [J] ?? []).compactMap { s in (s["name"] as? String).map { Cmd(name: $0, desc: s["description"] as? String ?? "", hint: nil) } }
        }
        await loadGoal()
    }

    /// Same path as desktop's /permission popup; refresh so Sess.permission picks up the new currentValue.
    func selectPermission(_ v: String) async throws { try await execute("/permission \(v)"); try await loadSessions() }

    func selectPreset(_ id: String) async throws {
        guard let sid = current else { return }
        _ = try await rpc("agentPresets/select", ["agentId": sid, "agentPreset": id]); try await loadSessions()
    }

    /// Only writes if the user is still on the same session, so a slow reply never shows another session's goal.
    func loadGoal() async {
        guard let sid = current else { goal = nil; return }
        let g = Goal(try? await rpc("goals/get", ["agentId": sid]))
        if current == sid { goal = g }
    }

    func createGoal(_ objective: String) async throws {
        guard let sid = current else { return }
        _ = try await rpc("goals/create", ["agentId": sid, "request": ["objective": objective]]); await loadGoal()
    }

    /// New objective for the current goal; rounds and phase stay as they are.
    func editGoal(_ objective: String) async throws {
        guard let sid = current, let g = goal else { return }
        _ = try await rpc("goals/edit", ["agentId": sid, "ref": g.ref, "request": ["objective": objective]]); await loadGoal()
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

    /// Desktop's "message subagent": queue (or steer into a running turn) a prompt on a child session.
    func promptSubagent(_ child: Sess, _ text: String) async throws {
        guard let r = Self.subagentRequest(child, text) else { return }
        _ = try await rpc("subagents/prompt", ["request": r])
    }

    static func subagentRequest(_ child: Sess, _ text: String) -> J? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parent = child.parent, !t.isEmpty else { return nil }
        return ["requestId": UUID().uuidString, "parentSessionId": parent, "childSessionId": child.id, "mode": "continuable",
                "delivery": child.running ? "steer" : "queue", "content": promptContent(t, images: [], receipts: []),
                "clientTimeZone": TimeZone.current.identifier]
    }

    /// value nil = "let the Mac decide" (next handler, i.e. the desktop prompt).
    func answer(_ p: Prompt, _ value: Any?) async throws {
        prompts.removeAll { $0.id == p.id }
        if p.event == "userQuestions/answer" {
            // Projection question: nil = leave it for the Mac (nothing to hand back), value = answer directly.
            guard let value, let agent = p.agentId else { return }
            _ = try await rpc("userQuestions/answer", ["agentId": agent, "callId": p.id, "answer": value]); return
        }
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
        if pathMon == nil {
            let m = NWPathMonitor()
            m.pathUpdateHandler = { path in Task { @MainActor in
                let w = path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet)
                guard w != self.onWiFi else { return }
                self.onWiFi = w
                self.urlSession?.finishTasksAndInvalidate(); self.urlSession = nil // pooled sockets belong to the old interface; don't abort handshakes mid-flight
                if self.pairing != nil, path.status == .satisfied { self.reconnect() } // Wi‑Fi ⇄ cellular: old route is dead, switch now
            } }
            m.start(queue: .main); pathMon = m
        }
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
                    if bonjourHost(h) { MainActor.assumeIsolated { self.found[fp] = Found(fp: fp, name: name, host: h, port: Int(port.rawValue)) } }
                }
                c.cancel()
            case .failed, .waiting: c.cancel()
            default: break
            }
        }
        c.start(queue: .main)
    }
}

