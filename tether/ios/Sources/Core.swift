// Tether core: pinning, pairing, RPC + mux client, Bonjour. Views live in UI.swift.
import Foundation
import CryptoKit
import Network
import Security
import UIKit
import UserNotifications
import LocalAuthentication

typealias J = [String: Any]
/// `status`: the HTTP status of a refused gateway call (0 for other errors).
struct Fail: LocalizedError { let errorDescription: String?; var status = 0; init(_ m: String, status: Int = 0) { errorDescription = m; self.status = status } }

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
    if code == 404, m == "no such branch" { return String(localized: "This branch no longer exists.") }
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

/// iOS lets no app switch another app's VPN on, and a bare tailscale:// is Tailscale's tailnet-lock signing deeplink
/// ("Could not sign device"). So Tether ships a signed one-step Shortcut (Tailscale › Connect, runs without opening
/// Tailscale); run-shortcut executes it with no prompt and returns to tether://tailscale/<ok|error|cancel>.
let tsShortcutName = "Tether Tailscale"
func tailscaleShortcutURL() -> URL {
    var u = URLComponents(string: "shortcuts://x-callback-url/run-shortcut")!
    u.queryItems = [.init(name: "name", value: tsShortcutName)]
        + [("success", "ok"), ("error", "error"), ("cancel", "cancel")].map { .init(name: "x-" + $0.0, value: "tether://tailscale/" + $0.1) }
    return u.url!
}
/// Tunnel interfaces on the current path. iOS keeps a few utun up for its own services, so callers compare sets:
/// a new utun appearing is a VPN (Tailscale) coming up.
func vpnTunnels(_ names: [String]) -> Set<String> { Set(names.filter { $0.hasPrefix("utun") || $0.hasPrefix("ipsec") }) }
let tailscaleStoreURL = URL(string: "https://apps.apple.com/app/id1470499037")!
/// Auto-run only off Wi‑Fi (home LAN needs no tunnel), once per outage, and only once the Shortcut has proven it works
/// (a missing Shortcut would strand the user in the Shortcuts app).
func shouldAutoTailscale(onWiFi: Bool, hasTailnet: Bool, auto: Bool, ready: Bool, tried: Bool) -> Bool {
    !onWiFi && hasTailnet && auto && ready && !tried
}
/// Request time-out per address: 5 s while a fallback address is left; 10 s for the last one of the first-connect probe
/// (an unreachable Mac then shows as offline after about 15 s, not after the system's 60 s); else the system's.
func requestTimeout(last: Bool, probing: Bool) -> TimeInterval? { !last ? 5 : probing ? 10 : nil }
/// Whether an unreachable Mac gets the Tailscale button: off Wi‑Fi always, and on any Wi‑Fi when the Mac has a tailnet
/// address (office Wi‑Fi to the home Mac needs the tunnel too; Tether cannot tell the home Wi‑Fi from another one).
func offersTailscale(onWiFi: Bool, hasTailnet: Bool) -> Bool { !onWiFi || hasTailnet }
/// Whether the banner explains the lost link: never when connected; a first connect only once it has hung (slow).
func showsLostHint(_ s: Client.Conn, slow: Bool) -> Bool { s == .off || s == .reconnecting || (s == .connecting && slow) }
/// After the socket closed: a link that worked (iOS closes it in the background, a Wi‑Fi blip) gets a quiet retry that
/// shows "Connecting…" with a spinner. Only a connect that failed counts as an attempt and shows the offline view.
func afterDrop(live: Bool, attempt: Int) -> (attempt: Int, state: Client.Conn) { live ? (0, .connecting) : (attempt + 1, .reconnecting) }
/// The Mac's addresses in the order to try. The one that answered last goes first: from another Wi‑Fi the Mac's LAN
/// address never answers, and each request waited its 5 s time-out before it tried Tailscale. Else LAN first on Wi‑Fi,
/// Tailscale first elsewhere.
func addressOrder(host: String, ts: String?, onWiFi: Bool, last: Client.Route?) -> [(String, Client.Route)] {
    let all: [(String, Client.Route)] = [(host, .lan)] + (ts.map { [($0, .tailscale)] } ?? [])
    let byNet = onWiFi ? all : all.reversed()
    guard let last else { return byNet }
    return byNet.filter { $0.1 == last } + byNet.filter { $0.1 != last }
}
/// A message on its way to the Mac: it shows at once, faded, until the Mac's copy arrives (same request id).
struct Outgoing: Identifiable, Equatable { let id: String; let session: String; let text: String; let attachments: Int }
/// The request id that a user message (a chat event or a queued inbox item) carries from `session/prompt`.
func promptRequestId(_ message: J?) -> String? { ((message?["source"] as? J)?["rpcId"]) as? String }
/// What the Sessions tab shows instead of rows. Sessions need a live link: a cached list while off/reconnecting would
/// look usable but every tap fails, so it is replaced by the offline view. "No sessions" only after a real empty reply.
enum SessionsPlaceholder { case none, loading, empty, offline }
func sessionsPlaceholder(loaded: Bool, count: Int, state: Client.Conn) -> SessionsPlaceholder {
    switch state {
    case .off, .reconnecting: return .offline
    case .connecting: return .loading
    case .connected: return count > 0 ? .none : loaded ? .empty : .loading
    }
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
/// Collapse all projects (Composer Plus): the project groups (a folder, or Ungrouped) that are open now. Pinned and
/// Archived do not count. The button shows only while this list is not empty, as on the desktop.
func openProjects(_ groups: [(title: String, items: [Sess], path: String?)], folds: String) -> [String] {
    groups.filter { ($0.path != nil || $0.title == String(localized: "Ungrouped")) && !groupFolded(folds, $0.title) }.map(\.title)
}
func groupIcon(_ title: String) -> String {
    switch title {
    case String(localized: "Pinned"): "pin"
    case String(localized: "Archived"): "archivebox"
    case String(localized: "Ungrouped"): "tray"
    case String(localized: "All sessions"): "list.bullet"
    default: "folder"
    }
}

/// New-session sheet: folders of past sessions, newest first, each once, minus `excluding` (DSH projects).
func recentFolders(_ sessions: [Sess], excluding: Set<String>) -> [String] {
    var seen = excluding
    return sessions.sorted { ($0.updated ?? .distantPast) > ($1.updated ?? .distantPast) }.map(\.cwd).filter { !$0.isEmpty && seen.insert($0).inserted }
}
/// Project search in a new chat (Composer Plus `projectPicker`): every word of `q` is in one of the texts, case and
/// accents ignored (ğ = g, ı = i); the projects that match, A–Z like Finder ("app2" before "app10").
func searchHit(_ q: String, _ texts: String...) -> Bool {
    let fold = { (s: String) in s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).replacingOccurrences(of: "ı", with: "i") }
    let hay = fold(texts.joined(separator: " "))
    return fold(q).split(whereSeparator: \.isWhitespace).allSatisfy { hay.contains($0) }
}
func pickerProjects(_ ws: [Workspace], query q: String) -> [Workspace] {
    ws.filter { searchHit(q, $0.title, $0.path) }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
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

struct Invite: Decodable, Equatable { let v: Int; let host: String; let port: Int; let fp: String; let code: String; var ts: String? = nil; var mac: String? = nil }
/// QR / pasted payload from the Mac: `tether://pair?v=1&host&port&fp&code&mac?&ts?` (the iPhone Camera app opens it in
/// Tether), or the older JSON text {"v":1,"host","port","fp","code","ts"?,"mac"?}. ts = the Mac's Tailscale IP, mac = its name.
func parseInvite(_ s: String) -> Invite? {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    let raw: Invite?
    if let u = URLComponents(string: t), u.scheme == "tether", u.host == "pair" {
        // '+' is a space in form encoding (an older gateway wrote it so); a real '+' arrives as %2B.
        let q = Dictionary((u.percentEncodedQueryItems ?? []).compactMap { i in
            i.value.flatMap { $0.replacingOccurrences(of: "+", with: "%20").removingPercentEncoding }.map { (i.name, $0) }
        }, uniquingKeysWith: { a, _ in a })
        guard let v = q["v"].flatMap({ Int($0) }), let host = q["host"], let port = q["port"].flatMap({ Int($0) }), let fp = q["fp"], let code = q["code"] else { return nil }
        raw = Invite(v: v, host: host, port: port, fp: fp, code: code, ts: q["ts"], mac: q["mac"])
    } else {
        raw = t.data(using: .utf8).flatMap { try? JSONDecoder().decode(Invite.self, from: $0) }
    }
    guard let i = raw, i.v == 1, isLANv4(i.host), (1...65535).contains(i.port), let fp = normFp(i.fp), (1...128).contains(i.code.count),
          i.ts.map(isTailnet) ?? true else { return nil }
    return Invite(v: 1, host: i.host, port: i.port, fp: fp, code: i.code, ts: i.ts, mac: i.mac.flatMap(macLabel))
}

/// Pairings that a new pairing replaces: the same certificate, or the same Mac at the same address with an older
/// certificate (the Mac made a new one). Without this the old entry stays and keeps trying a certificate that is gone.
func replacedBy(_ list: [Pairing], _ p: Pairing) -> Set<String> {
    // An old entry without a name (an older gateway) at the same address is the same Mac: its certificate is gone there.
    // ponytail: two different Macs that used one address at different times and have no name lose the older entry;
    // pairing it again brings it back.
    Set(list.filter { $0.fp == p.fp || ($0.host == p.host && $0.port == p.port && ($0.mac == nil || $0.mac == p.mac)) }.map(\.fp))
}
/// The user's own name for the Mac that a code is for, when this iPhone paired with that Mac before (also with an
/// older certificate: the same match as `replacedBy`). The pair screen then shows that name, not the Mac's own name.
func knownAlias(_ list: [Pairing], _ inv: Invite) -> String? {
    list.first { $0.label != nil && ($0.fp == inv.fp || ($0.host == inv.host && $0.port == inv.port && ($0.mac == nil || $0.mac == inv.mac))) }?.label
}
/// A yes/no that a URLSession delegate callback and the pairing task share (both reach it through the main actor).
final class Flag: @unchecked Sendable { var on = false }

/// What the pair screen shows while one pairing runs. `waiting` carries when the Mac stops waiting for Approve.
enum PairPhase: Equatable {
    case idle, connecting(String), waiting(String, until: Date), done(String), failed(String)
    var busy: Bool { switch self { case .connecting, .waiting, .done: true; default: false } }
}
/// The gateway's refusals → one sentence that says what to do next.
func pairFailText(status: Int, error: String?) -> String {
    switch (status, error) {
    case (403, "pairing denied"): return String(localized: "The Mac denied this iPhone. Click Approve next time.")
    case (403, "pairing expired"): return String(localized: "Nobody clicked Approve on the Mac in time. Scan the code again.")
    case (403, _): return String(localized: "This code was already used or is too old. Scan the new code on the Mac.")
    case (429, _): return String(localized: "Too many tries. Wait a minute, then scan again.")
    default: return String(localized: "The Mac answered with an error (\(status)). Scan the code again.")
    }
}

/// A Mac name from the gateway or the user: trimmed, no control characters, at most 64 characters; nil when blank.
func macLabel(_ s: String) -> String? {
    let t = String(String.UnicodeScalarView(s.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })).trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : String(t.prefix(64))
}

/// Pairings in the picker's order. A new pairing for a Mac that is already in the list (same certificate) replaces it in
/// place and keeps the user's own label; any other Mac is added at the end. There is no limit on the count.
func upserted(_ list: [Pairing], _ p: Pairing) -> [Pairing] {
    guard let i = list.firstIndex(where: { $0.fp == p.fp }) else { return list + [p] }
    var out = list, n = p
    n.label = list[i].label ?? p.label
    out[i] = n
    return out
}
/// The Mac to show after `fp` is unpaired: the one that came after it in the list, else the one before it.
func nextActive(_ list: [Pairing], removed fp: String) -> String? {
    guard let i = list.firstIndex(where: { $0.fp == fp }) else { return list.first?.fp }
    let rest = list.filter { $0.fp != fp }
    return rest.isEmpty ? nil : rest[min(i, rest.count - 1)].fp
}
/// UserDefaults key of one per-Mac value. Session ids are unique only inside one DSH, so unread dots, the last seen list
/// and drafts of two Macs must not share a key. The first Mac (migrated from the one-Mac build) keeps the old bare key.
func macKey(_ key: String, _ fp: String?, legacy: String?) -> String {
    guard let fp, fp != legacy else { return key }
    return "\(key).\(fp.prefix(16))"
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

/// Queue reorder: a queued message's text, or nil when it has images or files (those rows cannot move).
func queueText(_ item: J) -> String? {
    let c = item["content"]
    if let s = c as? String { return s }
    guard let blocks = c as? [J], blocks.allSatisfy({ $0["type"] as? String == "text" }) else { return nil }
    return blocks.compactMap { $0["text"] as? String }.joined()
}

/// Queue edit: the text of a queued message without the image and file markers (its text blocks, as dsh joins them).
func queueEditText(_ c: Any?) -> String {
    if let s = c as? String { return s }
    return (c as? [J] ?? []).compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined()
}

/// Queue edit: the images and files of a queued message, in order. nil when the message has a block that the editor
/// does not know (a save would drop it), so that message gets no editor.
func queueAttachments(_ c: Any?) -> [(type: String, id: String, name: String)]? {
    var out: [(type: String, id: String, name: String)] = []
    for b in c as? [J] ?? [] {
        let type = b["type"] as? String
        if type == "text" { continue }
        guard type == "image" || type == "file", let a = b["attachment"] as? J, let id = a["attachmentId"] as? String else { return nil }
        out.append((type!, id, a["name"] as? String ?? type!))
    }
    return out
}

/// Queue edit: the new content of a queued message, for the Mac's `queue-edit` route (dsh's own edit when it is text only).
/// The text stays where it was: first when the message had text before its first attachment, else after the attachments.
/// The kept attachments (`keep`: attachment ids) stay in their order; new images, then new files (upload receipt ids)
/// come after them. A blank text is left out. nil: nothing to save (no text, no attachments, or a block that it does not know).
func queueEditContent(original: Any?, text: String, keep: [String], newImages: [Data], newFiles: [String]) -> [J]? {
    guard let atts = queueAttachments(original) else { return nil }
    let blocks = original as? [J] ?? []
    let first = blocks.firstIndex { $0["type"] as? String != "text" }
    let textFirst = first.map { f in blocks.prefix(f).contains { $0["type"] as? String == "text" } } ?? true
    // One `keep` entry keeps one block: a message that carries the same attachment twice can keep one or both.
    var left = keep
    let kept: [J] = atts.compactMap { a in
        guard let i = left.firstIndex(of: a.id) else { return nil }
        left.remove(at: i)
        return ["type": a.type, "attachmentId": a.id]
    }
    // The same image parts as a prompt (Client.promptContent): the composer's JPEG data.
    let added: [J] = newImages.map { ["type": "image", "mediaType": "image/jpeg", "data": $0.base64EncodedString()] }
        + newFiles.map { ["type": "file", "receiptId": $0] }
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let say: [J] = t.isEmpty ? [] : [["type": "text", "text": t]]
    let out = textFirst ? say + kept + added : kept + added + say
    return out.isEmpty ? nil : out
}

/// Queue edit: the message as the editor showed it (`seen` of the `queue-edit` route), one item per block in order:
/// `["text", text]`, or `[type, attachmentId]` for an image or a file (null when the block has no id). The Mac refuses
/// the save (409) when the message changed since then, for example after an edit on another device.
func queueEditSeen(_ c: Any?) -> [[Any]] {
    if let s = c as? String { return [["text", s]] }
    // The same items as index.js `seenOf` (null for a value that the block does not have), so the two compare equal.
    let or = { (v: String?) -> Any in v ?? NSNull() }
    return (c as? [J] ?? []).map { b in
        let type = b["type"] as? String
        if type == "text" { return ["text", or(b["text"] as? String)] }
        return [or(type), or((b["attachment"] as? J)?["attachmentId"] as? String)]
    }
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

/// One paired Mac. `mac` is the name the Mac reports; `label` is the user's own name for it (wins when set).
struct Pairing: Codable, Identifiable {
    var host: String; var port: Int; var fp: String; var token: String; var deviceId: String; var name: String; var expiresAt: String; var ts: String? = nil
    var mac: String? = nil; var label: String? = nil
    var id: String { fp }
    var title: String { label ?? mac ?? host }
}

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
    /// `turn`: the end of a turn, with its summary ("Completed in 1m 5s"); `failed` = it failed or stopped.
    enum Kind { case user, assistant, reasoning, command, tool, result, error, turn }
    let id = UUID(); let kind: Kind; let text: String
    /// Tool rows only: the result is folded into its call (matched by callId) instead of a separate line.
    var callId: String? = nil; var args: String? = nil; var output: String? = nil; var failed = false
    /// User rows only: image attachment ids, fetched lazily via session/attachment.
    var images: [String] = []
    /// Tool rows only: the tool's name, for the step group's title.
    var tool: String? = nil
    /// The log seq of the event that made this row: a user row's seq is what Roll back sends.
    var seq: Int? = nil
}

// MARK: - Composer Plus features (the dsh-composer-plus plugin on the Mac; see tether/FEATURES.md)

/// Turn rollback: the rows that a rollback took out of the chat. dsh keeps them in the log; its marker message
/// (`composer-plus-rollback`, or `dsh-rewind` from dsh-rewind-plugin) names them in `sourceEventSeqs`. A span is
/// [first, marker], both included. dsh's /compact marker is not a withdraw: its messages stay.
let rollbackSource = "composer-plus-rollback"
let withdrawKinds: Set<String> = [rollbackSource, "dsh-rewind"]
func rollbackSpan(_ e: J) -> ClosedRange<Int>? {
    guard e["type"] as? String == "user/message", let kind = ((e["data"] as? J)?["source"] as? J)?["kind"] as? String, withdrawKinds.contains(kind),
          let seq = e["seq"] as? Int, let first = (e["sourceEventSeqs"] as? [Int])?.min(), first <= seq else { return nil }
    return first...seq
}
/// Redo after a rollback: the newest rollback can be redone while nothing came after it. Its marker is the chat's last
/// user/message (a later message, also dsh's own context note of a new turn, ends the offer). The same rule as
/// `redoTarget` in index.js.
func redoTarget(_ events: [J]) -> Int? {
    guard let last = events.last(where: { $0["type"] as? String == "user/message" }),
          ((last["data"] as? J)?["source"] as? J)?["kind"] as? String == rollbackSource,
          (last["sourceEventSeqs"] as? [Int])?.isEmpty == false else { return nil }
    return last["seq"] as? Int
}
/// The Redo offer that shows: the Mac's offer while it is still the chat's newest rollback and the chat is idle.
func redoShown(offer: Int?, events: [J], running: Bool) -> Int? {
    guard let offer, !running, redoTarget(events) == offer else { return nil }
    return offer
}
/// The events that the chat shows: without those in a rollback span.
func withoutRolledBack(_ events: [J]) -> [J] {
    let spans = events.compactMap(rollbackSpan)
    guard !spans.isEmpty else { return events }
    return events.filter { e in (e["seq"] as? Int).map { s in !spans.contains { $0.contains(s) } } ?? true }
}

/// One-click Continue: the seq that `/api/composer-plus.continue` resumes after. The newest turn event decides: an open
/// turn (its turn/start), or a turn that ended other than "completed" (stopped, failed, cut off). nil: nothing to continue.
func continueAfter(_ events: [J]) -> Int? {
    for e in events.reversed() {
        switch e["type"] as? String {
        case "turn/end": return ((e["data"] as? J)?["reason"] as? J)?["kind"] as? String == "completed" ? nil : e["seq"] as? Int
        case "turn/start": return e["seq"] as? Int
        default: continue
        }
    }
    return nil
}

/// Complete while typing: the same rules as on the Mac: 3+ characters, at most 4000, not a slash command.
func completable(_ typed: String) -> Bool {
    let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.count >= 3 && typed.count <= 4000 && !t.hasPrefix("/")
}
/// The rest of a completion that still fits what is typed now (typing along the guess needs no new ask); nil otherwise.
func completionRest(typed: String, asked: String, completion: String) -> String? {
    let full = asked + completion
    guard typed.count >= asked.count, full.count > typed.count, full.hasPrefix(typed) else { return nil }
    return String(full.dropFirst(typed.count))
}

/// Improve prompt: the same rules as on the Mac: some text, at most 8000 characters, not a slash command.
func improvable(_ draft: String) -> Bool {
    let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    return !t.isEmpty && draft.utf16.count <= 8000 && !t.hasPrefix("/") // the Mac counts UTF-16 units (JS length)
}

/// Next message prediction: the seq of the newest turn/end when it is the last turn event and finished normally.
func predictAfter(_ events: [J]) -> Int? {
    for e in events.reversed() {
        switch e["type"] as? String {
        case "turn/end": return ((e["data"] as? J)?["reason"] as? J)?["kind"] as? String == "completed" ? e["seq"] as? Int : nil
        case "turn/start": return nil
        default: continue
        }
    }
    return nil
}

/// Copy session link: dsh's session URI. Pasted into another chat, dsh attaches that chat as read-only context.
func sessionLink(_ id: String) -> String {
    let json = (try? JSONSerialization.data(withJSONObject: [id], options: [.withoutEscapingSlashes])).map { String(decoding: $0.dropFirst().dropLast(), as: UTF8.self) } ?? "\"\(id)\""
    return "dsh-session:" + Data(json.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

/// Copy message link: the session link and the message's event seq, `dsh-session:<payload>#<seq>` (client.js messageLink).
func messageLink(_ sessionId: String, _ seq: Int) -> String { sessionLink(sessionId) + "#\(seq)" }
/// The session id in a session link's payload; nil unless dsh writes exactly this payload for that id.
private func linkedSession(_ payload: String) -> String? {
    var b = payload.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    b += String(repeating: "=", count: (4 - b.count % 4) % 4)
    guard let d = Data(base64Encoded: b), let id = (try? JSONSerialization.jsonObject(with: d, options: .fragmentsAllowed)) as? String,
          !id.isEmpty, sessionLink(id) == "dsh-session:" + payload else { return nil }
    return id
}
// A seq ends at a character that is not a word character, "#" or a decimal part ("#1." at the end of a sentence counts).
private let messageLinkRE = try! NSRegularExpression(pattern: #"dsh-session:([A-Za-z0-9_-]+)#([0-9]{1,15})(?![\w#]|\.[0-9])|@(session-[A-Za-z0-9-]{1,100})#([0-9]{1,15})(?![\w#]|\.[0-9])"#)
/// The message links in a text: the link as copied (`dsh-session:<payload>#<seq>`, canonical payload only) and the form
/// that dsh keeps after it sends the message (`@session-<id>#<seq>`). The same forms as client.js messageLinkRule.
func parseMessageLink(_ text: String) -> [(range: Range<String.Index>, sessionId: String, seq: Int)] {
    messageLinkRE.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in
        let group = { (i: Int) in Range(m.range(at: i), in: text).map { String(text[$0]) } }
        guard let r = Range(m.range, in: text) else { return nil }
        if let id = group(3), let seq = group(4).flatMap({ Int($0) }) { return (r, id, seq) }
        guard let id = group(1).flatMap(linkedSession), let seq = group(2).flatMap({ Int($0) }) else { return nil }
        return (r, id, seq)
    }
}
/// Open a message link: the shown row nearest before the message (the message itself when it shows). A message in a
/// folded turn or a step group lands on an earlier row that shows.
func jumpTarget(_ rows: [ChatRow], seq: Int) -> UUID? {
    rows.compactMap { r -> (id: UUID, seq: Int)? in
        if case .line(let l) = r, let s = l.seq, s <= seq { return (l.id, s) }
        return nil
    }.max { $0.seq < $1.seq }?.id
}
/// A request to scroll the open chat to a message (Copy message link → Open message).
struct Jump: Equatable { let sessionId: String; let seq: Int; var id = UUID() }

/// Branch badge: the `branches` map of `/plus/branches` (`{on, branches: {sessionId: name}}`); off on the Mac = none.
func sessionBranches(_ o: J) -> [String: String] {
    guard o["on"] as? Bool == true, let b = o["branches"] as? J else { return [:] }
    return b.compactMapValues { v in (v as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(200)) } }
}
/// Find in chat: text folded for matching, as on the Mac (case, accents, Turkish dotless ı).
func findFold(_ s: String) -> String { s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).replacingOccurrences(of: "ı", with: "i") }
/// Find in chat: the shown rows that hold `query` (your messages and the answers that the screen shows; folded steps and
/// earlier pages that are not loaded are not searched), top to bottom, with the number of matches in each.
func findRows(_ rows: [ChatRow], query: String) -> [(id: UUID, count: Int)] {
    let q = findFold(query.trimmingCharacters(in: .whitespacesAndNewlines))
    guard !q.isEmpty else { return [] }
    return rows.compactMap { r in
        guard case .line(let l) = r, l.kind == .user || l.kind == .assistant else { return nil }
        let n = findFold(l.text).components(separatedBy: q).count - 1
        return n > 0 ? (l.id, n) : nil
    }
}

/// Changes panel: the query of a `changes` or `diff` call. `ws` hides the changes in whitespace only (git diff -w).
/// `pending` (mode "pending"): two branch refs, the files that `ref` brings into `target`.
func changesQuery(_ sessionId: String, mode: String, ws: Bool, commit: String? = nil, path: String? = nil,
                  pending: (ref: String, target: String)? = nil) -> [String: String] {
    var q = ["sessionId": sessionId, "mode": mode]
    if ws { q["ws"] = "1" }
    if let commit { q["commit"] = commit }
    if let pending { q["ref"] = pending.ref; q["target"] = pending.target }
    if let path { q["path"] = path }
    return q
}

/// Mark all as read: the chats of one project (its workspace's session ids) that show the green dot.
func unreadIn(_ ids: [String], finished: Set<String>) -> [String] { ids.filter(finished.contains) }

/// Plan mode: dsh's `plan` projection. A pending switch flips the host value (as dsh's own plan chip reads it).
func planOn(_ plan: J?) -> Bool {
    guard let plan, let active = plan["active"] as? Bool else { return false }
    return plan["pending"] as? Bool == true ? !active : active
}
/// The plan button on a draft: a leading `/plan` goes away, else `/plan ` comes first (not `/planning`).
func planToggled(_ draft: String) -> String {
    guard let r = draft.range(of: #"^/plan(?=$|\s)[ \t]?"#, options: .regularExpression) else { return "/plan " + draft }
    return String(draft[r.upperBound...])
}

/// Queue reorder: dsh has no "move", so a move rewrites the texts of the rows between the two places, from the last
/// row up (the first row may start to send at any moment). Each change is (row index, new text, old text).
func queueMove(_ texts: [String?], from: Int, to: Int) -> [(row: Int, next: String, prev: String)]? {
    guard from != to, texts.indices.contains(from), texts.indices.contains(to),
          texts[min(from, to)...max(from, to)].allSatisfy({ $0 != nil }) else { return nil }
    var order = Array(texts.indices)
    order.insert(order.remove(at: from), at: to)
    return texts.indices.reversed().compactMap { i in order[i] == i ? nil : (i, texts[order[i]]!, texts[i]!) }
}

/// The summary row of a finished turn, as in DSH desktop. A failed or stopped turn does not fold (`failed`).
func turnLine(reason: String?, start: Date?, end: Date?) -> Line {
    switch reason {
    case "aborted", "interrupted": return Line(kind: .turn, text: String(localized: "Stopped"), failed: true)
    case "error": return Line(kind: .turn, text: String(localized: "Failed"), failed: true)
    default:
        guard let start, let end else { return Line(kind: .turn, text: String(localized: "Completed")) }
        let t = max(1, Int(end.timeIntervalSince(start))), h = t / 3600
        let d = (h > 0 ? "\(h)h " : "") + (t >= 60 ? "\(t / 60 % 60)m " : "") + "\(t % 60)s"
        return Line(kind: .turn, text: String(localized: "Completed in \(d)"))
    }
}

/// One row of the chat as DSH desktop shows it.
enum ChatRow: Identifiable {
    case line(Line)
    /// Thinking and tool calls in a row, folded into one line. `live`: the step that runs now.
    case steps([Line], live: Bool)
    /// A finished turn's summary row above its content; a foldable turn shows only this row and its answer.
    case turn(Line, foldable: Bool)
    var id: UUID {
        switch self {
        case .line(let l), .turn(let l, _): l.id
        case .steps(let ls, _): ls[0].id
        }
    }
}

/// The chat in DSH desktop's shape. A finished turn folds to its summary and its last answer until the user opens it
/// (`open`: ids of the turn rows the user opened); a failed or stopped turn stays open.
func chatRows(_ t: [Line], open: Set<UUID>, running: Bool) -> [ChatRow] {
    var rows: [ChatRow] = [], chunk: [Line] = []
    func flush(end: Line?, live: Bool) {
        let answer = end == nil ? nil : chunk.last { $0.kind == .assistant }?.id
        let process = chunk.contains { $0.id != answer }
        if let end, !chunk.isEmpty { rows.append(.turn(end, foldable: process && !end.failed)) }
        let folded = end.map { !$0.failed && process && !open.contains($0.id) } ?? false
        var steps: [Line] = []
        for l in chunk where !folded || l.id == answer {
            if l.kind == .reasoning || l.kind == .tool { steps.append(l); continue }
            if !steps.isEmpty { rows.append(.steps(steps, live: false)); steps = [] }
            rows.append(.line(l))
        }
        if !steps.isEmpty { rows.append(.steps(steps, live: live)) }
        chunk = []
    }
    for l in t {
        switch l.kind {
        case .user: flush(end: nil, live: false); rows.append(.line(l))
        case .turn: flush(end: l, live: false)
        default: chunk.append(l)
        }
    }
    flush(end: nil, live: running)
    return rows
}

/// DSH desktop's kinds of work (its process-activity map): which kind a tool call is.
func stepKind(_ tool: String) -> String {
    switch tool {
    case "read": "read"
    case "read_image": "readImage"
    case "grep", "glob": "search"
    case "write": "write"
    case "edit", "apply_patch": "edit"
    case "bash", "pwsh", "exec_command", "write_stdin": "commands"
    case "run_code": "code"
    case "web_search": "webSearch"
    case "web_fetch": "webFetch"
    case "todo_write", "create_goal", "update_goal", "get_goal": "plan"
    case "ask_user_question", "request_user_input": "questions"
    default: tool.hasSuffix("_inspect") ? "search" : tool.hasPrefix("terminal_") ? "commands"
        : tool == "subagent" || tool.hasPrefix("subagent_") ? "subagents" : "tools"
    }
}
private let stepDone = ["thinking": "Analysis completed", "read": "Read files", "readImage": "Read images", "write": "Wrote files",
    "search": "Searched code", "edit": "Edited files", "commands": "Ran commands", "code": "Ran code", "webSearch": "Searched the web",
    "webFetch": "Visited web pages", "subagents": "Coordinated subagents", "plan": "Updated the plan", "questions": "Asked questions", "tools": "Called tools"]
private let stepLive = ["thinking": "Analyzing the request", "read": "Reading files", "readImage": "Reading images", "write": "Writing files",
    "search": "Searching code", "edit": "Editing files", "commands": "Running commands", "code": "Running code", "webSearch": "Searching the web",
    "webFetch": "Visiting web pages", "subagents": "Coordinating subagents", "plan": "Updating the plan", "questions": "Waiting for your action", "tools": "Calling tools"]
private func stepText(_ table: [String: String], _ k: String) -> String { String(localized: String.LocalizationValue(table[k] ?? table["tools"]!)) }

/// A step group's title and its kind of work, as in DSH desktop. Done: the three most frequent kinds ("Read files and
/// searched code"). Live: what runs now and on what ("Running commands · npm test").
func stepsTitle(_ lines: [Line], live: Bool) -> (title: String, kind: String) {
    if live {
        guard let l = lines.last, l.kind == .tool, l.output == nil else { return (stepText(stepLive, "thinking"), "thinking") }
        let k = stepKind(l.tool ?? "")
        // ponytail: the detail is the tool row's text without the name; a call with no known main argument shows JSON.
        let detail = String(l.text.dropFirst((l.tool ?? "").count)).trimmingCharacters(in: .whitespaces)
        return (stepText(stepLive, k) + (detail.isEmpty ? "" : " · " + detail), k)
    }
    var counts: [(kind: String, n: Int)] = []
    for l in lines where l.kind == .tool {
        let k = stepKind(l.tool ?? "")
        if let i = counts.firstIndex(where: { $0.kind == k }) { counts[i].n += 1 } else { counts.append((k, 1)) }
    }
    // most calls first; a tie keeps the order of first use
    let ranked = counts.enumerated().sorted { ($0.element.n, -$0.offset) > ($1.element.n, -$1.offset) }.map(\.element.kind)
    let labels = ranked.prefix(3).map { stepText(stepDone, $0) }
    guard let first = labels.first else { return (stepText(stepDone, "thinking"), "thinking") }
    let rest = labels.dropFirst().map { $0.prefix(1).lowercased() + $0.dropFirst() }
    let title = rest.count == 1 ? String(localized: "\(first) and \(rest[0])")
        : ([first] + rest).joined(separator: ", ") + (ranked.count > 3 ? String(localized: ", etc.") : "")
    return (title, ranked[0])
}

/// Regenerate: the user message that produced `id` (nearest user row above it).
func promptLine(before id: UUID, in t: [Line]) -> Line? {
    guard let i = t.firstIndex(where: { $0.id == id }) else { return nil }
    return t[..<i].last { $0.kind == .user }
}

/// Retry for a failed turn: only the transcript's last line, and only when it is an error, offers re-sending its prompt.
func retryPrompt(for id: UUID, in t: [Line]) -> Line? {
    guard let last = t.last(where: { $0.kind != .turn }), last.id == id, last.kind == .error else { return nil }
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

/// Share conversation: user/assistant turns as Markdown, the same shape as the Mac's "Export as Markdown" (a `## You` or
/// `## Assistant` section per message; replies in a row join; an open code fence is closed). Tool, reasoning and error
/// rows are left out.
func transcriptMarkdown(_ t: [Line], title: String) -> String {
    var sections: [(user: Bool, text: String)] = []
    for l in t where l.kind == .user || l.kind == .assistant {
        let text = l.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        let user = l.kind == .user
        if !user, let last = sections.last, !last.user { sections[sections.count - 1].text += "\n\n" + text } else { sections.append((user, text)) }
    }
    let head = title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    let body = sections.flatMap { ["## " + ($0.user ? "You" : "Assistant"), closeFences($0.text)] }
    return (["# " + (head.isEmpty ? "Chat" : head)] + body).joined(separator: "\n\n") + "\n"
}

/// Close a code fence that the text leaves open (CommonMark: 3+ backticks or tildes; the closer is the same character, at
/// least as long, with no info string), as the Mac's export does.
func closeFences(_ text: String) -> String {
    var open: String?
    // `\.isNewline`: Swift keeps "\r\n" as one Character, so splitting on "\n" alone would miss CRLF lines.
    for line in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
        var s = Substring(line); var pad = 0
        while s.first == " ", pad < 3 { s = s.dropFirst(); pad += 1 }
        guard let c = s.first, c == "`" || c == "~" else { continue }
        let run = s.prefix { $0 == c }
        guard run.count >= 3 else { continue }
        let info = s.dropFirst(run.count)
        if let o = open {
            if o.first == c, run.count >= o.count, info.trimmingCharacters(in: .whitespaces).isEmpty { open = nil }
        } else if !(c == "`" && info.contains("`")) { open = String(run) }
    }
    return open.map { text + "\n" + $0 } ?? text
}

/// Feature ideas: the fixed focus topics under the focus field (the same six as on the Mac).
let focusPresets = ["Performance", "Accessibility", "Tests", "Security", "Usability", "Documentation"]
/// Feature ideas: the longest focus topic in UTF-16 units, as the browser field and the Mac count it.
let focusMax = 80
/// The focus topic cut to `focusMax` UTF-16 units without splitting a character.
func clampFocus(_ v: String) -> String {
    var out = ""
    for ch in v { if out.utf16.count + ch.utf16.count > focusMax { break }; out.append(ch) }
    return out
}
/// Later list → Copy as checklist: one `- [ ] Title — Summary` line per idea, as on the Mac.
func laterChecklist(_ ideas: [J]) -> String {
    ideas.map { "- [ ] \($0["title"] as? String ?? "") — \($0["summary"] as? String ?? "")" }.joined(separator: "\n") + "\n"
}
/// Changes → "Chats that changed this file": one row of `/plus/file-chats` (newest first, as the Mac answers).
struct FileChatRow: Equatable {
    let sessionId: String, seq: Int, count: Int
    let title: String?, request: String?, withdrawn: Bool, time: Date?
    var id: String { "\(sessionId)#\(seq)" }
}
func fileChatRows(_ d: J) -> [FileChatRow] {
    (d["chats"] as? [J] ?? []).compactMap { r in
        guard let sid = r["sessionId"] as? String, let seq = r["seq"] as? Int else { return nil }
        let ms = (r["time"] as? NSNumber)?.doubleValue ?? 0
        return FileChatRow(sessionId: sid, seq: seq, count: r["count"] as? Int ?? 1, title: r["title"] as? String, request: r["request"] as? String,
                           withdrawn: r["withdrawn"] as? Bool == true, time: ms > 0 ? Date(timeIntervalSince1970: ms / 1000) : nil)
    }
}
/// Later list → Open GitHub issue: the link that the Mac saved on an idea, only an https `…/<owner>/<repo>/issues/<n>` URL
/// (the same rule as the Mac's client), else nil (the button shows).
func issueLink(_ v: Any?) -> (url: URL, number: Int)? {
    guard let o = v as? J, let s = o["url"] as? String,
          s.range(of: #"^https://[A-Za-z0-9_.-]+(:[0-9]{1,5})?/[^\s/]+/[^\s/]+/issues/[0-9]{1,9}$"#, options: .regularExpression) != nil,
          let url = URL(string: s), let n = Int(s.split(separator: "/").last ?? "") else { return nil }
    return (url, n)
}

/// Changes → Tree: one branch of the branch map from `/plus/graph` (the Mac sends the current branch or a detached HEAD
/// first, then the other local branches, then remote ones, newest commit first) with its last commit and its place on the
/// map: `state` "main", "merged" (`target` took it; `merge` is the merge commit, none for a fast-forward) or "waiting"
/// (`target` is the branch that it started from, can be absent); `reached`: the main branch has its work; `level`: its
/// row (0 = the main branch). A Mac from before the map sends no `state` ("").
struct GraphBranch: Identifiable, Hashable {
    var id: String { ref }
    let ref: String, name: String, kind: String, current: Bool, sha: String, time: Int, author: String, subject: String
    let state: String, reached: Bool, target: String?, merge: String?, level: Int
    init?(_ j: J) {
        guard let ref = j["ref"] as? String, let name = j["name"] as? String, let kind = j["kind"] as? String, let sha = j["sha"] as? String else { return nil }
        self.ref = ref; self.name = name; self.kind = kind; current = j["current"] as? Bool == true; self.sha = sha
        time = j["time"] as? Int ?? 0; author = j["author"] as? String ?? ""; subject = j["subject"] as? String ?? ""
        state = j["state"] as? String ?? ""; reached = j["reached"] as? Bool == true
        target = j["target"] as? String; merge = j["merge"] as? String; level = max(0, j["level"] as? Int ?? 0)
    }
}
/// Changes → Tree: the map's order on the phone: the main branch, then each branch under its target (depth first, in the
/// Mac's order). A branch whose target is absent or not in the list starts its own tree after the main branch's tree.
func mapOrder(_ list: [GraphBranch]) -> [GraphBranch] {
    let refs = Set(list.map(\.ref))
    var under: [String: [GraphBranch]] = [:], roots: [GraphBranch] = []
    for b in list {
        if b.state != "main", let t = b.target, t != b.ref, refs.contains(t) { under[t, default: []].append(b) } else { roots.append(b) }
    }
    var out: [GraphBranch] = [], seen = Set<String>()
    func add(_ b: GraphBranch) { guard seen.insert(b.ref).inserted else { return }; out.append(b); under[b.ref]?.forEach(add) }
    (roots.filter { $0.state == "main" } + roots.filter { $0.state != "main" }).forEach(add)
    list.forEach(add) // a loop of targets (the Mac never sends one): its branches come last
    return out
}
/// One box of the map on screen; `picked: false` = dimmed (only on the way to the main branch).
struct MapRow: Identifiable { let branch: GraphBranch, picked: Bool; var id: String { branch.ref } }
/// Changes → Tree, the count cards: "merged" or "waiting" keeps the branches in that state and, not `picked` (the map dims
/// them), the branches that their arrows go through to the main branch, as on the Mac; "all" keeps all. In map order.
func mapFilter(_ list: [GraphBranch], _ filter: String) -> [MapRow] {
    let byRef = Dictionary(list.map { ($0.ref, $0) }, uniquingKeysWith: { a, _ in a })
    let picked = Set(list.filter { filter == "all" || $0.state == filter }.map(\.ref))
    var shown = Set<String>()
    for ref in picked {
        var b = byRef[ref], k = 0
        while let x = b, k <= list.count { shown.insert(x.ref); b = x.target.flatMap { byRef[$0] }; k += 1 }
    }
    return mapOrder(list.filter { shown.contains($0.ref) }).map { MapRow(branch: $0, picked: picked.contains($0.ref)) }
}
/// One commit of a branch from `/plus/graph?ref=` (newest first) and its ref tags.
struct GraphRef: Equatable { let name: String, kind: String; var current = false; var key: String { kind + ":" + name } }
struct GraphCommit: Identifiable {
    var id: String { sha }
    let sha: String, refs: [GraphRef], author: String, time: Int, subject: String
    init(sha: String, refs: [GraphRef] = [], author: String = "", time: Int = 0, subject: String = "") {
        self.sha = sha; self.refs = refs; self.author = author; self.time = time; self.subject = subject
    }
    init?(_ j: J) {
        guard let sha = j["sha"] as? String else { return nil }
        let refs = (j["refs"] as? [J] ?? []).compactMap { r -> GraphRef? in
            guard let n = r["name"] as? String, let k = r["kind"] as? String else { return nil }
            return GraphRef(name: n, kind: k, current: r["current"] as? Bool == true)
        }
        self.init(sha: sha, refs: refs, author: j["author"] as? String ?? "",
                  time: j["time"] as? Int ?? 0, subject: j["subject"] as? String ?? "")
    }
}
/// The tags on a commit row of an open branch: not that branch itself; the current branch first, then local branches,
/// a detached HEAD, remote branches and tags (the same order as on the Mac).
func commitTags(_ c: GraphCommit, of b: GraphBranch) -> [GraphRef] {
    let order = ["local": 0, "head": 1, "remote": 2, "tag": 3]
    let rank = { (r: GraphRef) in r.current ? -1 : order[r.kind] ?? 9 }
    return c.refs.filter { !($0.name == b.name && $0.kind == b.kind) }.enumerated()
        .sorted { rank($0.element) != rank($1.element) ? rank($0.element) < rank($1.element) : $0.offset < $1.offset }.map(\.element)
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

/// Project status: the marker of a project row, as Composer Plus draws it in the desktop sidebar. Waiting for you wins,
/// then a finished chat that you did not open (also while another chat runs), then running.
enum ProjectMark: Equatable { case waiting, done, running(Int) }
func projectMark(_ chats: [Sess], all: [Sess], waiting: Set<String>, finished: Set<String>) -> ProjectMark? {
    let mine = chats.filter { $0.parent == nil }
    if mine.contains(where: { waiting.contains($0.id) }) { return .waiting }
    if mine.contains(where: { finished.contains($0.id) }) { return .done }
    let n = mine.filter { isRunning($0, all) }.count
    return n > 0 ? .running(n) : nil
}
/// Order by status (view only): finished and not opened, then running or waiting, then the rest; else dsh's order.
func statusRank(_ s: Sess, all: [Sess], waiting: Set<String>, finished: Set<String>) -> Int {
    finished.contains(s.id) ? 0 : isRunning(s, all) || waiting.contains(s.id) ? 1 : 2
}
/// Recent projects filter: a chat counts when it changed in the last 2 hours, runs, waits, finished unseen, or is open.
func recentChat(_ s: Sess, all: [Sess], now: Date, open: String?, waiting: Set<String>, finished: Set<String>) -> Bool {
    s.id == open || waiting.contains(s.id) || finished.contains(s.id) || isRunning(s, all) || (s.updated.map { now.timeIntervalSince($0) <= 7200 } ?? false)
}

/// Green dots from the Mac (Composer Plus keeps them): the chats that finished and that no device opened yet. Only root
/// chats that are idle now, and never the chat on screen (it is read while you look at it).
func shownUnread(host: [String], sessions: [Sess], open: String?) -> Set<String> {
    let idle = Set(sessions.filter { $0.parent == nil && !isRunning($0, sessions) }.map(\.id))
    return Set(host).intersection(idle).subtracting(open.map { [$0] } ?? [])
}

/// A chat shows "Running" while its own turn or one of its subagents runs, as in the DSH desktop sidebar.
func isRunning(_ s: Sess, _ all: [Sess]) -> Bool { s.running || all.contains { $0.parent == s.id && $0.running } }

/// Branch per chat: the branch of the chat's folder (`GET /plus/worktrees`); nil outside a git repository.
struct BranchState: Equatable {
    let name: String, upstream: String?, ahead: Int, behind: Int, changes: Int
    init?(_ o: J) {
        guard o["repo"] as? Bool == true, let b = o["branch"] as? String, !b.isEmpty else { return nil }
        name = b; upstream = o["upstream"] as? String
        ahead = o["ahead"] as? Int ?? 0; behind = o["behind"] as? Int ?? 0; changes = o["changes"] as? Int ?? 0
    }
    /// "3 changes · ↑2 ↓1", or "not pushed" without an upstream; zero parts are left out. A detached HEAD (`(abc1234)`)
    /// is not a branch to push, as on the Mac.
    var detail: String {
        var parts: [String] = []
        if changes > 0 { parts.append(changes == 1 ? String(localized: "1 change") : String(localized: "\(changes) changes")) }
        if upstream == nil { if !name.hasPrefix("(") { parts.append(String(localized: "not pushed")) } }
        else if ahead > 0 || behind > 0 { parts.append([ahead > 0 ? "↑\(ahead)" : nil, behind > 0 ? "↓\(behind)" : nil].compactMap { $0 }.joined(separator: " ")) }
        return parts.joined(separator: " · ")
    }
}

struct Sess: Identifiable {
    let id: String, title: String, cwd: String, parent: String?, running: Bool, preset: String?, model: String?, context: Double?, permission: String?, todos: [Todo]?, updated: Date?, questions: [Prompt], goal: Goal?
    /// dsh's `plan` projection ({active, pending?}); nil when dsh does not send it.
    var plan: J? = nil
    init?(_ j: J) {
        guard let id = j["sessionId"] as? String else { return nil }
        let p = (j["projections"] as? J)?["values"] as? J
        self.id = id; title = (p?["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Untitled")
        // Only a subagent chat has a parent here. dsh's fork (Branch, Composer Plus Redo, Tether's Fork) also writes
        // parentSessionId but no origin: that chat is a root chat of its own (as in dsh's sidebar and index.js isRootChat).
        cwd = j["cwd"] as? String ?? ""
        parent = ((j["origin"] as? String) == "subagent" ? j["parentSessionId"] as? String : nil) ?? (p?["subagent"] as? J)?["parentSessionId"] as? String
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
        plan = p?["plan"] as? J
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

// MARK: - Keychain: one item holding every pairing (tokens included), this device only.

enum Keychain {
    static func item(_ account: String) -> J { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dsh-mobile", kSecAttrAccount as String: account] }
    private static func read(_ account: String) -> Data? {
        var q = item(account); q[kSecReturnData as String] = true
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }
    /// Every paired Mac. The one-Mac build stored a single pairing under "pairing": it moves into the list once, and
    /// `legacy` returns its fingerprint so that Mac keeps its old UserDefaults keys.
    static func load() -> (list: [Pairing], legacy: String?) {
        if let d = read("pairings"), let list = try? JSONDecoder().decode([Pairing].self, from: d) {
            return (list, UserDefaults.standard.string(forKey: "legacyMac"))
        }
        guard let d = read("pairing"), let one = try? JSONDecoder().decode(Pairing.self, from: d) else { return ([], nil) }
        save([one]); UserDefaults.standard.set(one.fp, forKey: "legacyMac")
        // Delete the old item only when the list is really saved; otherwise the next launch tries again.
        if read("pairings") != nil { SecItemDelete(item("pairing") as CFDictionary) }
        return ([one], one.fp)
    }
    static func save(_ list: [Pairing]) {
        SecItemDelete(item("pairings") as CFDictionary)
        guard !list.isEmpty, let d = try? JSONEncoder().encode(list) else { return }
        var a = item("pairings"); a[kSecValueData as String] = d; a[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(a as CFDictionary, nil)
    }
}

/// Accepts the server only if its leaf certificate matches the pinned fingerprint; system CAs are never consulted.
final class Pinner: NSObject, URLSessionTaskDelegate {
    let fp: String
    /// Pairing only: called once the Mac's certificate matched (the Mac is reachable and has the request).
    var onTrusted: (() -> Void)?
    /// True after a certificate that did not match; URLSession then reports only "cancelled".
    private(set) var rejected = false
    init(fp: String) { self.fp = fp }
    func urlSession(_ s: URLSession, didReceive ch: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        // Non-trust challenges (e.g. client-certificate probes) must not kill the handshake; default handling sends no cert and never bypasses the pin below.
        guard ch.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else { return (.performDefaultHandling, nil) }
        guard let t = ch.protectionSpace.serverTrust,
              let leaf = (SecTrustCopyCertificateChain(t) as? [SecCertificate])?.first,
              pinMatches(der: SecCertificateCopyData(leaf) as Data, fp: fp) else { rejected = true; return (.cancelAuthenticationChallenge, nil) }
        onTrusted?()
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

    /// Every paired Mac, in the picker's order; no limit. Saved in the Keychain as one item.
    @Published var pairings: [Pairing] { didSet { Keychain.save(pairings) } }
    /// The Mac on screen. Every request, socket and list uses only this Mac's address, pin and token.
    @Published var activeFp: String? { didSet { UserDefaults.standard.set(activeFp, forKey: "activeMac") } }
    /// The Mac paired by the one-Mac build: it keeps the old bare UserDefaults keys (see macKey).
    private let legacyFp: String?
    /// The active Mac's pairing. Writes go into `pairings` (address learned from Bonjour, Tailscale, renewed token).
    var pairing: Pairing? {
        get { pairings.first { $0.fp == activeFp } }
        set {
            if let n = newValue { pairings = upserted(pairings, n); activeFp = n.fp }
            else if let fp = activeFp { pairings.removeAll { $0.fp == fp }; activeFp = nil }
        }
    }
    private func key(_ k: String) -> String { macKey(k, activeFp, legacy: legacyFp) }
    /// The Mac in the "Rename Mac" box (Mac picker or Settings), and the text in that box. The text is set only when
    /// the box opens: Save reads it after the box starts to close.
    @Published var renamingMac: Pairing? { didSet { if let p = renamingMac { renameText = p.title } } }
    @Published var renameText = ""
    /// The name the pair screen shows for a code: the user's own name for that Mac, else the Mac's name, else its address.
    func shownName(_ inv: Invite) -> String { knownAlias(pairings, inv) ?? inv.mac ?? inv.host }

    init() {
        let (list, legacy) = Keychain.load()
        pairings = list; legacyFp = legacy
        let saved = UserDefaults.standard.string(forKey: "activeMac")
        activeFp = list.contains { $0.fp == saved } ? saved : list.first?.fp
        finished = Set(UserDefaults.standard.stringArray(forKey: macKey("finished", activeFp, legacy: legacy)) ?? [])
        // A paired Mac connects as soon as the app is active: the first frames show the spinner, not "Not connected".
        if activeFp != nil { state = .connecting }
    }

    @Published var state = Conn.off
    @Published var upstream = ""
    @Published var error: String?
    /// The one pairing that runs now (pair screen). Only one at a time: `pair` refuses a second while this is busy.
    @Published var pairPhase = PairPhase.idle
    /// A tether://pair link that another app (the Camera) opened: the pair screen asks before it connects.
    @Published var linkInvite: Invite?
    private var pairTask: Task<Bool, Never>?
    /// The "Add a Mac" pair sheet is open (from the Mac picker or Settings).
    @Published var addingMac = false
    @Published var path: [String] = [] // Sessions navigation stack; non-empty = conversation on screen
    @Published var tab = 0 // 0 Sessions, 1 Agents, 2 Settings
    @Published var sessions: [Sess] = []
    @Published var sessionsLoaded = false // a session/list reply arrived for this pairing
    /// Sessions whose turn ended while you were elsewhere; cleared when opened (desktop's unread dot).
    @Published var finished = Set<String>() {
        // no Mac on screen (last one unpaired): nothing to save, and the bare key may still belong to the migrated Mac
        didSet { if activeFp != nil { UserDefaults.standard.set(Array(finished), forKey: key("finished")) } }
    }
    @Published var current: String?
    /// Branch badge (Composer Plus): the git branch of each chat's folder at its last turn, as the Mac recorded it.
    @Published var branches: [String: String] = [:]
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
    /// Every event of the open chat, oldest first: rollback markers can hide earlier rows, so the rows are rebuilt from it.
    private var events: [J] = []
    /// One-click Continue: the turn seq to resume after, when the last turn stopped, failed or was cut off.
    @Published var continueSeq: Int?
    /// Next message prediction (Composer Plus, switched on in the Mac's Settings): the guess for the chat's last finished turn.
    @Published var prediction: (seq: Int, text: String)?
    private var predicted: String? // "sid:seq" asked already: one model call per finished turn
    /// Composer Plus routes on this Mac (`/me` → plus). An older gateway or plugin has none: those features hide.
    @Published var plus: Set<String> = []
    /// Turn rollback: dsh-rewind-plugin owns rollback, or the switch is off on the Mac (then no ↶).
    @Published var rollbackOn = false
    /// Allow for this chat: chat id → tools allowed without asking.
    @Published var grants: [String: [String]] = [:]
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
    /// Off Wi‑Fi with the Mac unreachable: run the Tailscale Shortcut once per outage (re-armed when connected or on Wi‑Fi).
    // off by default: it brings the Shortcuts app to the front; a Shortcuts automation or VPN On Demand does it silently
    // new key: the previous build stored "tsAuto" defaulting to on
    @Published var tsAuto = UserDefaults.standard.bool(forKey: "tsAutoShortcut") { didSet { UserDefaults.standard.set(tsAuto, forKey: "tsAutoShortcut") } }
    /// The Shortcut came back with x-success at least once, so it is installed and allowed to run unattended.
    /// iOS gives apps no list of the user's shortcuts: one run from Tether is the only way to know that it is there.
    @Published var tsReady = UserDefaults.standard.bool(forKey: "tsReady") { didSet { UserDefaults.standard.set(tsReady, forKey: "tsReady") } }
    /// Why the last run from Tether failed, as Shortcuts reports it (errorMessage); nil after a good run.
    @Published var tsError: String?
    private var tsTried = false

    private var urlSession: URLSession?, sessionFp = ""
    private var ws: URLSessionWebSocketTask?
    private var followId: String?
    private var attempt = 0, probing = false
    private var browser: NWBrowser?
    private var pathMon: NWPathMonitor?
    private var tunnels: Set<String> = []

    var currentSess: Sess? { sessions.first { $0.id == current } }
    /// Plain-language problem with DSH behind the gateway; nil when fine or unknown.
    var upstreamText: String? {
        switch upstream {
        case "", "connected": return nil
        case "disconnected": return String(localized: "DSH is closed or restarting on your Mac.")
        default: return String(localized: "DSH on your Mac is not responding.")
        }
    }
    /// What the next turn will use: live header/selection, else the session's saved selection, else DSH's default.
    var shownModel: String? { model ?? currentSess?.model ?? defaultModel }
    func title(_ id: String) -> String { sessions.first { $0.id == id }?.title ?? String(id.prefix(8)) }

    /// Unsent composer text per session of the active Mac, kept across navigation and app restarts (text only).
    func draft(_ sid: String?) -> String { (UserDefaults.standard.dictionary(forKey: key("drafts")) as? [String: String])?[sid ?? ""] ?? "" }
    func setDraft(_ t: String, _ sid: String?) {
        guard let sid else { return }
        var d = UserDefaults.standard.dictionary(forKey: key("drafts")) as? [String: String] ?? [:]
        d[sid] = t.isEmpty ? nil : t
        UserDefaults.standard.set(d, forKey: key("drafts"))
    }

    /// Sidebar order like desktop DSH: pinned, one section per project, unassigned, archived.
    /// `project` (a workspace id) narrows every group to that project; an unknown id shows everything.
    /// Chats waiting for an answer from you (approval, question, plan review) on this Mac.
    var waitingChats: Set<String> { Set(prompts.compactMap(\.agentId)) }
    /// Composer Plus view options for the list (kept on this iPhone): Active in the last 2 hours, Order by status.
    @Published var recentOnly = UserDefaults.standard.bool(forKey: "recentProjects") { didSet { UserDefaults.standard.set(recentOnly, forKey: "recentProjects") } }
    @Published var byStatus = UserDefaults.standard.bool(forKey: "statusOrder") { didSet { UserDefaults.standard.set(byStatus, forKey: "statusOrder") } }
    /// dsh's "Group by → In one list" (this iPhone only): every chat in one list, not under its project.
    @Published var oneList = UserDefaults.standard.bool(forKey: "sessionsOneList") { didSet { UserDefaults.standard.set(oneList, forKey: "sessionsOneList") } }

    func sessionGroups(project: String? = nil, now: Date = .now) -> [(title: String, items: [Sess], path: String?)] {
        // newest activity first inside each group, like the desktop sidebar; pinned keeps the user's pin order
        let only = workspaces.first { $0.id == project }
        let wait = waitingChats
        var roots = sessions.filter { $0.parent == nil && (only?.sessions.contains($0.id) ?? true) }.sorted { ($0.updated ?? .distantPast) > ($1.updated ?? .distantPast) }
        // view only, as on the desktop: a stable sort keeps the newest first inside each rank
        if byStatus { roots = roots.enumerated().sorted { a, b in
            let (x, y) = (statusRank(a.element, all: sessions, waiting: wait, finished: finished), statusRank(b.element, all: sessions, waiting: wait, finished: finished))
            return x != y ? x < y : a.offset < b.offset }.map(\.element) }
        let rest = roots.filter { !pinned.contains($0.id) && !archived.contains($0.id) }
        var out: [(String, [Sess], String?)] = [(String(localized: "Pinned"), pinned.compactMap { id in roots.first { $0.id == id } }, nil)]
        if oneList {
            // No projects here, so the 2-hour filter keeps each recent chat (by project it keeps whole projects).
            let recent = { (s: Sess) in !self.recentOnly || recentChat(s, all: self.sessions, now: now, open: self.current, waiting: wait, finished: self.finished) }
            out.append((String(localized: "All sessions"), rest.filter(recent), nil))
            out.append((String(localized: "Archived"), roots.filter { archived.contains($0.id) && recent($0) }, nil))
            return out.filter { !$0.1.isEmpty }.map { (title: $0.0, items: $0.1, path: $0.2) }
        }
        var used = Set<String>()
        for w in workspaces { let s = rest.filter { w.sessions.contains($0.id) }; used.formUnion(s.map(\.id)); out.append((w.title, s, w.path)) }
        out.append((String(localized: "Ungrouped"), rest.filter { !used.contains($0.id) }, nil))
        out.append((String(localized: "Archived"), roots.filter { archived.contains($0.id) }, nil))
        // A project stays when one of its chats is recent; then the whole project shows, as on the desktop.
        if recentOnly { out = out.filter { $0.0 == String(localized: "Pinned") || $0.1.contains { recentChat($0, all: sessions, now: now, open: current, waiting: wait, finished: finished) } } }
        return out.filter { !$0.1.isEmpty }.map { (title: $0.0, items: $0.1, path: $0.2) }
    }

    /// Instant title filter while typing; server search adds content hits after a pause.
    func titleMatches(_ q: String, project: String? = nil) -> [Sess] {
        let q = q.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return [] }
        let only = workspaces.first { $0.id == project }
        return sessions.filter { $0.parent == nil && (only?.sessions.contains($0.id) ?? true) && $0.title.localizedStandardContains(q) }
            .sorted { ($0.updated ?? .distantPast) > ($1.updated ?? .distantPast) }
    }

    /// Actions that wait for the Mac now. While one takes longer than 0.4 s, `waitShown` puts up the WaitPill.
    @Published private(set) var waiting = 0 { didSet { if waiting == 0 { waitShown = false } } }
    @Published private(set) var waitShown = false
    private var waitGen = 0
    /// Messages sent from this iPhone that the Mac did not show yet (each chat shows its own, faded, with "Sending…").
    @Published var outgoing: [Outgoing] = []
    /// A chat opened and its messages are on the way: the chat shows a spinner, not the empty-chat screen.
    @Published var loadingChat = false
    /// `waits: false`: the action shows its own progress (a message's "Sending…" bubble).
    func run(waits: Bool = true, _ op: @escaping @MainActor () async throws -> Void) {
        if waits {
            waiting += 1
            if waiting == 1 {
                // A quick answer shows nothing; a new wait that starts later gets its own 0.4 s.
                waitGen += 1; let gen = waitGen
                Task { try? await Task.sleep(for: .milliseconds(400)); if gen == waitGen, waiting > 0 { waitShown = true } }
            }
        }
        Task {
            defer { if waits { waiting -= 1 } }
            do { try await op() } catch is CancellationError {} catch { self.error = userText(error) }
        }
    }

    private func http(_ fp: String) -> URLSession {
        if urlSession == nil || fp != sessionFp {
            urlSession?.invalidateAndCancel()
            urlSession = URLSession(configuration: .ephemeral, delegate: Pinner(fp: fp), delegateQueue: nil); sessionFp = fp
        }
        return urlSession!
    }

    private func addrs(_ host: String, _ ts: String?) -> [(String, Route)] { addressOrder(host: host, ts: ts, onWiFi: onWiFi, last: route) }

    /// `wait`: a model call on the Mac (Improve prompt) that answers only at its end: one address (the one that worked last),
    /// with this time-out. Not the 5 s fallback: a slow answer is not a dead address, and a second try would find the
    /// Mac's first call still running.
    private func call(_ path: String, _ body: Any?, get: Bool = false, wait: TimeInterval? = nil) async throws -> Any? {
        guard let p = pairing else { throw Fail(String(localized: "Not paired")) }
        let all = addrs(p.host, p.ts)
        let list = wait == nil ? all : [all.first { $0.1 == route } ?? all[0]]
        var got: (Data, URLResponse)?
        var fails: [String] = []
        for (n, (host, rt)) in list.enumerated() {
            // Switched Macs: stop here. A fallback try would rebuild the shared URLSession with the old pin and cancel
            // the new Mac's requests.
            guard activeFp == p.fp else { throw CancellationError() }
            var r = URLRequest(url: URL(string: "https://\(host):\(p.port)\(path)")!)
            if let wait { r.timeoutInterval = wait } else if let t = requestTimeout(last: n == list.count - 1, probing: probing) { r.timeoutInterval = t }
            r.setValue("Bearer \(p.token)", forHTTPHeaderField: "Authorization")
            if let body, !get {
                r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                r.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            do { got = try await http(p.fp).data(for: r); if activeFp == p.fp { route = rt; lastFail = nil }; break }
            catch let e as URLError {
                fails.append("\(rt == .lan ? "LAN" : "Tailscale") \(host): \(failText(e))")
                if n == list.count - 1 { if activeFp == p.fp { lastFail = fails.joined(separator: "\n") }; throw e }
            }
        }
        guard let (d, resp) = got else { throw Fail("Unreachable") }
        // The user may have switched Macs while this request ran: its answer must not touch the Mac now on screen.
        guard activeFp == p.fp else { throw CancellationError() }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0, json = try? JSONSerialization.jsonObject(with: d)
        if code == 401 { forget(String(localized: "This iPhone was revoked or its token expired. Pair again."), fp: p.fp) }
        guard code == 200 else {
            let m = ((json as? J)?["error"] as? String) ?? "HTTP \(code)"
            if m == "DSH host unavailable" { upstream = "disconnected"; throw Fail(String(localized: "DSH is closed or restarting on your Mac. Try again in a moment.")) }
            throw Fail(gatewayText(code, m), status: code)
        }
        return json
    }

    func rpc(_ method: String, _ args: J = [:]) async throws -> Any? {
        let o = try await call("/api/" + method, ["type": "client-request", "rpcId": UUID().uuidString, "method": method, "payload": ["args": args]]) as? J
        guard let res = o?["result"] as? J else { throw Fail("Bad response") }
        if res["ok"] as? Bool == true { return res["value"] }
        throw Fail(((res["error"] as? J)?["message"] as? String) ?? "Request failed")
    }

    // MARK: Composer Plus (the plugin's own routes through the gateway: /plus/<name>)

    /// GET with a query, or POST with a JSON body. An older plugin without the route answers 404: the caller hides it.
    func plusCall(_ name: String, query: [String: String] = [:], body: J? = nil, wait: TimeInterval? = nil) async throws -> J {
        var c = URLComponents(); c.path = "/plus/" + name
        if !query.isEmpty { c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        return try await call(c.percentEncodedPath + (c.percentEncodedQuery.map { "?" + $0 } ?? ""), body, get: body == nil, wait: wait) as? J ?? [:]
    }

    private func loadRollback(_ sid: String) async {
        guard plus.contains("rollback"), let o = try? await plusCall("rollback", query: ["sessionId": sid]), current == sid else { return }
        rollbackOn = o["on"] as? Bool == true && o["rewind"] as? Bool != true
        redoOffer = o["redo"] as? Int
    }
    /// Redo (Turn rollback): the rollback marker seq that the Mac offers to redo; nil = no offer.
    @Published var redoOffer: Int?
    /// The Redo offer on screen: hidden while the chat runs and after anything comes after the rollback.
    var redoSeq: Int? { currentSess?.parent == nil ? redoShown(offer: redoOffer, events: events, running: running) : nil }
    /// One redo at a time: the buttons are off and a second call does nothing while one runs.
    @Published private(set) var redoing = false
    /// What a redo with files would change: `nil` = that rollback kept no files.
    func redoPreview(_ marker: Int) async throws -> [(path: String, action: String, changed: Bool)]? {
        guard let sid = current else { return nil }
        let o = try await plusCall("rollback", body: ["sessionId": sid, "redo": marker, "preview": true])
        guard let files = o["files"] as? [J] else { return nil }
        return files.compactMap { f in (f["path"] as? String).map { ($0, f["action"] as? String ?? "restore", f["changed"] as? Bool == true) } }
    }
    /// Redo: the Mac starts a new chat from just before the rollback (with `files`, the files come back too) and the phone
    /// opens it. The rolled-back chat stays as it is. Answers the files that stayed as they are (changed or skipped).
    func redo(_ marker: Int, files: Bool, overwrite: Bool) async throws -> [String] {
        guard !redoing, let sid = current else { return [] }
        redoing = true
        defer { redoing = false }
        let o = try await plusCall("rollback", body: ["sessionId": sid, "redo": marker, "files": files, "overwrite": overwrite])
        if redoOffer == marker { redoOffer = nil }
        let f = o["files"] as? J
        let kept = (f?["changed"] as? [String] ?? []) + (f?["skipped"] as? [J] ?? []).compactMap { $0["path"] as? String }
        if let new = o["sessionId"] as? String { try? await loadSessions(); open(new) }
        return kept
    }

    /// Mark all as read: the green dots of these chats go here and in the Mac's unread list (the other phones too).
    func markAllRead(_ ids: [String]) async throws {
        guard plus.contains("unread"), !ids.isEmpty else { return }
        _ = try await plusCall("unread", body: ["sessionIds": ids])
        finished.subtract(ids)
    }

    /// Open message (Copy message link): the chat opens and scrolls to the message. Not in the list: a short notice.
    @Published var jump: Jump?
    func openMessage(_ sessionId: String, seq: Int) {
        guard sessions.contains(where: { $0.id == sessionId }) else { error = String(localized: "This message is not in the chat any more."); return }
        if current != sessionId || path.isEmpty { open(sessionId) }
        jump = Jump(sessionId: sessionId, seq: seq)
    }
    /// What a rollback with files would change: nil = no git or no snapshot (then only "Chat only").
    func rollbackPreview(_ seq: Int) async throws -> [(path: String, action: String)]? {
        guard let sid = current else { return nil }
        let o = try await plusCall("rollback", body: ["sessionId": sid, "seq": seq, "preview": true])
        guard o["git"] as? Bool == true, o["snapshot"] as? Bool == true else { return nil }
        return (o["files"] as? [J] ?? []).compactMap { f in (f["path"] as? String).map { ($0, f["action"] as? String ?? "restore") } }
    }
    /// Takes the message and everything after it out of the chat (the Mac draws a marker; the follow stream brings it).
    /// Returns the message's text for the composer, and the files that were not put back.
    func rollback(_ seq: Int, files: Bool) async throws -> (text: String, skipped: [String], attachments: Int) {
        guard let sid = current else { return ("", [], 0) }
        let o = try await plusCall("rollback", body: ["sessionId": sid, "seq": seq, "files": files])
        let skipped = ((o["files"] as? J)?["skipped"] as? [J] ?? []).compactMap { $0["path"] as? String }
        if current == sid, let m = o["markerSeq"] as? Int { redoOffer = m }
        return (o["text"] as? String ?? "", skipped, o["attachments"] as? Int ?? 0)
    }

    /// One-click Continue: the turn goes on from where it stopped, without a chat message.
    func continueTurn() async throws {
        guard let sid = current, let after = continueSeq else { return }
        continueSeq = nil // one tap; the next turn/start or turn/end sets it again
        do { _ = try await plusCall("continue", body: ["sessionId": sid, "afterSeq": after]) }
        catch { continueSeq = continueAfter(events); throw error }
    }

    /// Asks the Mac for a guess of the next message after the chat's last finished turn. The Mac answers 409 while the
    /// feature is off (or the chat moved on); then nothing shows. Only one call per finished turn.
    func loadPrediction() {
        guard plus.contains("predict"), let sid = current, currentSess?.parent == nil, let seq = predictAfter(events) else { return }
        let key = "\(sid):\(seq)"
        guard predicted != key else { return }
        predicted = key
        Task { @MainActor in
            guard let o = try? await plusCall("predict", body: ["sessionId": sid, "afterSeq": seq]), current == sid,
                  o["afterSeq"] as? Int == seq, predictAfter(events) == seq, let t = o["text"] as? String, !t.isEmpty else { return }
            prediction = (seq, t)
        }
    }

    /// Complete while typing (Composer Plus, switched on in the Mac's Settings): the words that may come after `typed`.
    /// nil when the Mac has it off (409), an older plugin has no route (404), or the answer is for other text.
    func complete(_ typed: String) async -> String? {
        guard plus.contains("complete"), let sid = current, currentSess?.parent == nil, completable(typed) else { return nil }
        guard let o = try? await plusCall("complete", body: ["sessionId": sid, "text": typed]), current == sid,
              o["text"] as? String == typed, let rest = o["completion"] as? String, !rest.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return rest
    }

    /// Improve prompt (Composer Plus): the Mac rewrites `draft` as a clearer prompt with this chat and its project as context.
    /// nil when the answer is for other text or is empty; throws the Mac's error (shown to the user).
    func improve(_ draft: String) async throws -> String? {
        guard plus.contains("improve"), let sid = current, currentSess?.parent == nil, improvable(draft) else { return nil }
        // The Mac's call can take up to 120 s (a reasoning model); a Cancel closes the request and the gateway stops it.
        let o = try await plusCall("improve", body: ["sessionId": sid, "text": draft], wait: 130)
        guard current == sid, o["text"] as? String == draft, let t = o["improved"] as? String, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return t
    }

    /// Delete chat: the chat stops and its history (with its subagent chats) goes to the Mac's Trash.
    func deleteChat(_ id: String) async throws {
        _ = try await plusCall("delete-chat", body: ["sessionId": id])
        if current == id { path = [] }
        try await loadSessions()
    }

    /// Allow for this chat: grants come from the Mac (the desktop and the phone share them).
    /// Grant changes started on this phone. A read answer that comes after a change started is older than that change's
    /// answer: it is dropped, so a slow read never brings back a revoked grant or removes a new one.
    private var grantWrites = 0
    func loadGrants() async {
        let mine = grantWrites
        guard let o = try? await plusCall("grants"), mine == grantWrites else { return }
        grants = o.compactMapValues { $0 as? [String] }
    }
    func allowForChat(_ p: Prompt) async throws {
        guard let sid = p.agentId, let tool = p.request["toolName"] as? String else { return }
        try await answer(p, "allowed-once") // first the answer, then the grant: a failed answer grants nothing
        try await writeGrants(["action": "grant", "sessionId": sid, "tool": tool])
    }
    func revokeGrants(_ sid: String) async throws { try await writeGrants(["action": "revoke", "sessionId": sid]) }
    private func writeGrants(_ body: J) async throws {
        grantWrites += 1
        let mine = grantWrites
        let o = try await plusCall("grants", body: body)
        if mine == grantWrites { grants = o.compactMapValues { $0 as? [String] } }
    }

    /// Plan mode: leave it as dsh's plan chip does.
    func leavePlan() async throws { try await execute("/plan off") }

    /// Queue reorder: one move at a time. The Mac's plugin moves the message itself (also with images); an older plugin
    /// without that route: the texts move through dsh's edit, and on a failure the done edits go back.
    @Published var movingQueue = false
    /// Which rows can move: your own messages with the Mac's route, else text rows only.
    func canMoveQueued(from: Int, to: Int) -> Bool {
        let rows = inbox["next-turn"] ?? []
        guard from != to, rows.indices.contains(from), rows.indices.contains(to) else { return false }
        if plus.contains("queue-move") { return rows[min(from, to)...max(from, to)].allSatisfy { ($0["source"] as? J)?["kind"] as? String == "user" } }
        return queueMove(rows.map { queueText($0) }, from: from, to: to) != nil
    }
    func moveQueued(from: Int, to: Int) async throws {
        let rows = inbox["next-turn"] ?? []
        // Not while a queued message is edited: a move (or its text rewrite) would change the message under the editor.
        guard !movingQueue, editingQueued == nil, canMoveQueued(from: from, to: to), let sid = current, let item = rows[from]["id"] as? String else { return }
        if plus.contains("queue-move") {
            movingQueue = true; defer { movingQueue = false }
            do { _ = try await plusCall("queue-move", body: ["sessionId": sid, "itemId": item, "to": to, "before": rows.compactMap { $0["id"] as? String }]) }
            catch { throw Fail(String(localized: "Reorder failed: a message may have already started sending.")) }
            return
        }
        guard let changes = queueMove(rows.map { queueText($0) }, from: from, to: to) else { return }
        movingQueue = true; defer { movingQueue = false }
        var done: [(row: Int, next: String, prev: String)] = []
        let edit = { (i: Int, t: String) async throws in
            guard let id = rows[i]["id"] as? String else { throw Fail("Bad queue item") }
            try await self.updateQueue(id, ["kind": "edit", "content": [["type": "text", "text": t]]])
        }
        do { for c in changes { try await edit(c.row, c.next); done.append(c) } }
        catch {
            for c in done.reversed() { try? await edit(c.row, c.prev) }
            throw Fail(String(localized: "Reorder failed: a message may have already started sending."))
        }
    }

    /// Queue edit: the queued message whose editor is open (`open`) or whose save runs (`saving`). Meanwhile nothing else
    /// changes that message (no Send now, no Remove, no second editor or save) and no queue move runs; a running move
    /// keeps the editor closed. `session`: the chat of the message, so a save goes to that chat.
    struct QueuedEdit: Equatable { let id: String; let session: String; var saving = false; var open = true }
    @Published private(set) var editingQueued: QueuedEdit?
    /// The Mac's `queue-edit` route edits your own next-turn messages and keeps, removes and adds images and files.
    /// Without it (an older plugin) only dsh's own edit is safe, and that takes text only.
    func queueEditsAttachments(_ item: J) -> Bool {
        guard plus.contains("queue-edit"), (item["source"] as? J)?["kind"] as? String == "user", let id = item["id"] as? String else { return false }
        return (inbox["next-turn"] ?? []).contains { $0["id"] as? String == id }
    }
    /// Edit shows for a text-only message, and for a message with images or files only when the Mac can keep them.
    func queueEditable(_ item: J) -> Bool {
        guard item["id"] is String, let atts = queueAttachments(item["content"]) else { return false }
        return atts.isEmpty || queueEditsAttachments(item)
    }
    /// Opens the editor of this message. false while a move runs or a message is edited.
    func beginQueueEdit(_ item: J) -> Bool {
        guard editingQueued == nil, !movingQueue, let sid = current, let id = item["id"] as? String, queueEditable(item) else { return false }
        editingQueued = QueuedEdit(id: id, session: sid)
        return true
    }
    /// The editor closed (Save, Cancel, a swipe down, its view gone). A running save keeps the state until it ends.
    func endQueueEdit(_ id: String) {
        guard editingQueued?.id == id else { return }
        if editingQueued?.saving == true { editingQueued?.open = false } else { editingQueued = nil }
    }
    /// Saves the edited message. With images or files: the Mac's `queue-edit` route (new files are uploaded to the chat
    /// first); text only: dsh's own edit. false: nothing was sent (no editor open for it, or its save already runs).
    @discardableResult
    func saveQueued(_ item: J, text: String, keep: [String], images: [Data], files: [Attachment]) async throws -> Bool {
        guard let id = item["id"] as? String, let e = editingQueued, e.id == id, e.open, !e.saving else { return false }
        editingQueued?.saving = true
        defer {
            if editingQueued?.id == id { if editingQueued?.open == false { editingQueued = nil } else { editingQueued?.saving = false } }
            sendStatus = nil
        }
        let sid = e.session
        if keep.isEmpty, images.isEmpty, files.isEmpty {
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { throw Fail(String(localized: "Write a message or keep an attachment.")) }
            try await queueAction(sid, id, ["kind": "edit", "content": [["type": "text", "text": t]]])
            editingQueued?.open = false // saved: the editor closes, and no second save goes while it animates out
            return true
        }
        guard plus.contains("queue-edit") else { throw Fail(String(localized: "The Mac cannot keep the images or files of a queued message. Update Composer Plus on the Mac.")) }
        var receipts: [String] = []
        for f in files {
            sendStatus = String(localized: "Uploading \(f.name)…")
            let v = try await rpc("fileUploads/upload", ["agentId": sid, "request": ["data": f.data.base64EncodedString(), "name": f.name]]) as? J
            guard let r = v?["receiptId"] as? String else { throw Fail(String(localized: "Upload failed: \(f.name)")) }
            receipts.append(r)
        }
        sendStatus = nil
        guard let content = queueEditContent(original: item["content"], text: text, keep: keep, newImages: images, newFiles: receipts) else {
            throw Fail(String(localized: "Write a message or keep an attachment."))
        }
        // One address with a long time-out: the 5 s fallback to a second address would find this save still running on the
        // Mac (409, "a queue change … is already running") and show a false error.
        // `seen`: the message as the editor opened it (the Mac refuses a message that changed since then).
        _ = try await plusCall("queue-edit", body: ["sessionId": sid, "itemId": id, "content": content, "seen": queueEditSeen(item["content"])], wait: 60)
        editingQueued?.open = false
        return true
    }

    // MARK: Pairing

    /// Starts one pairing. Every entry point (scanner, pasted link, Camera link) comes here, so a second pairing while
    /// one runs is refused. True when the Mac approved this iPhone; the Mac is then on screen.
    @discardableResult func pair(_ inv: Invite) async -> Bool {
        guard !pairPhase.busy else { return false }
        // Busy at once, before the task runs: a second tap in the same moment finds it busy.
        pairPhase = .connecting(shownName(inv))
        linkInvite = nil
        let t = Task { await runPair(inv) }
        pairTask = t
        defer { pairTask = nil }
        return await t.value
    }
    /// The iPhone stops waiting. The Mac page then says that this iPhone stopped waiting.
    func cancelPair() { pairTask?.cancel() }
    /// Back to the start screen after a failure.
    func resetPair() { if !pairPhase.busy { pairPhase = .idle } }
    /// A tether://pair link from the Camera app (or any app). It only fills the confirm card: nothing connects until
    /// the user taps Connect, so a link alone can never pair this iPhone with a Mac.
    func openPairLink(_ u: URL) {
        guard let inv = parseInvite(u.absoluteString) else { error = String(localized: "This pairing link is broken or not for a local network. Show a new code on the Mac."); return }
        guard !pairPhase.busy else { return }
        pairPhase = .idle; linkInvite = inv
        if pairing != nil { addingMac = true }
    }

    private func runPair(_ inv: Invite) async -> Bool {
        let name = shownName(inv)
        // The user looks at the Mac to click Approve: keep the screen on, and keep the request alive for a short time
        // if they leave the app. A dropped request makes the Mac's Approve card go away.
        UIApplication.shared.isIdleTimerDisabled = true
        var bg = UIBackgroundTaskIdentifier.invalid
        bg = UIApplication.shared.beginBackgroundTask(withName: "Pairing") { UIApplication.shared.endBackgroundTask(bg); bg = .invalid }
        defer { UIApplication.shared.isIdleTimerDisabled = false; if bg != .invalid { UIApplication.shared.endBackgroundTask(bg) } }
        do {
            let (d, status) = try await pairRequest(inv, name: name)
            let o = (try? JSONSerialization.jsonObject(with: d)) as? J
            guard status == 200, let o, let token = o["token"] as? String, token.count >= 40, let id = o["deviceId"] as? String else {
                pairPhase = .failed(pairFailText(status: status, error: o?["error"] as? String))
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                return false
            }
            let mac = (o["mac"] as? String).flatMap(macLabel) ?? inv.mac
            let p = Pairing(host: inv.host, port: inv.port, fp: inv.fp, token: token, deviceId: id, name: o["name"] as? String ?? "", expiresAt: o["expiresAt"] as? String ?? "", ts: inv.ts, mac: mac)
            pairings = upserted(pairings, p) // saved at once; the screen changes after the short "Connected" moment
            pairPhase = .done(knownAlias(pairings, inv) ?? mac ?? inv.host)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            try? await Task.sleep(for: .seconds(1.2))
            adopt(p)
            pairPhase = .idle
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            // A Mac without the user's own name: ask for one now, filled with the Mac's name. The short wait lets the
            // "Add a Mac" sheet close first; an alert does not show while a sheet closes.
            if pairing?.fp == p.fp, pairing?.label == nil {
                try? await Task.sleep(for: .seconds(0.6))
                if renamingMac == nil, let q = pairing, q.fp == p.fp, q.label == nil { renamingMac = q }
            }
            return true
        } catch {
            if Task.isCancelled || error is CancellationError { pairPhase = .idle; return false }
            pairPhase = .failed(userText(error))
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return false
        }
    }

    /// One POST /pair per address (LAN first on Wi‑Fi). Each try has its own pinned session: the reconnect loop of
    /// another (or an out-of-date) pairing rebuilds the shared session, and that used to cancel this request while the
    /// Mac waited for Approve, so the Approve card went away.
    private func pairRequest(_ inv: Invite, name: String) async throws -> (Data, Int) {
        for (host, _) in addrs(inv.host, inv.ts) {
            let reached = Flag(), pin = Pinner(fp: inv.fp)
            pin.onTrusted = {
                guard !reached.on else { return }
                reached.on = true // at once, on the TLS callback: the watchdog below must not cancel a request the Mac holds
                Task { @MainActor in
                    self.pairPhase = .waiting(name, until: Date().addingTimeInterval(120)) // the gateway waits 120 s for Approve
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                }
            }
            let s = URLSession(configuration: .ephemeral, delegate: pin, delegateQueue: nil)
            defer { s.invalidateAndCancel() }
            var r = URLRequest(url: URL(string: "https://\(host):\(inv.port)/pair")!, timeoutInterval: 150)
            r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: ["code": inv.code, "name": UIDevice.current.name])
            // No TLS answer in 10 s: this address is dead. Try the next one instead of a 150 s wait.
            let watchdog = Task { try? await Task.sleep(for: .seconds(10)); if !Task.isCancelled, !reached.on { s.invalidateAndCancel() } }
            defer { watchdog.cancel() }
            do {
                let (d, resp) = try await s.data(for: r)
                return (d, (resp as? HTTPURLResponse)?.statusCode ?? 0)
            } catch {
                try Task.checkCancellation()
                if pin.rejected { throw Fail(String(localized: "This code doesn't match the Mac's certificate. Show a new code on the Mac and scan again.")) }
                if reached.on { throw Fail(String(localized: "The connection to the Mac broke while it waited for Approve. Scan the code again.")) }
            }
        }
        throw Fail(String(localized: "Can't reach \(name) at \(inv.host). Put this iPhone on the same Wi‑Fi as the Mac. If iOS asks to find devices on your local network, tap Allow."))
    }

    /// The new pairing goes on screen. An older entry for the same Mac (an old certificate) leaves this iPhone and
    /// gives its name to the new one.
    private func adopt(_ p: Pairing) {
        let gone = replacedBy(pairings, p).subtracting([p.fp])
        let label = pairings.first { gone.contains($0.fp) && $0.label != nil }?.label
        for fp in gone { for k in ["seenSessions", "finished", "drafts"] { UserDefaults.standard.removeObject(forKey: macKey(k, fp, legacy: legacyFp)) } }
        pairings.removeAll { gone.contains($0.fp) }
        if let label, let i = pairings.firstIndex(where: { $0.fp == p.fp }), pairings[i].label == nil { pairings[i].label = label }
        switchMac(p.fp, force: true)
        addingMac = false
    }

    /// Show another paired Mac: close this Mac's socket, clear everything on screen, load that Mac's own unread dots, and
    /// connect with that Mac's address, pin and token only. `force` reconnects even when it is already the active Mac.
    func switchMac(_ fp: String, force: Bool = false) {
        guard pairings.contains(where: { $0.fp == fp }), force || fp != activeFp else { return }
        closeScreen()
        activeFp = fp
        finished = Set(UserDefaults.standard.stringArray(forKey: key("finished")) ?? [])
        connect()
    }

    /// Drop the socket and every per-Mac value on screen. A stale reply from the old Mac checks `ws` / `current` and stops.
    private func closeScreen() {
        ws?.cancel(with: .goingAway, reason: nil); ws = nil; followId = nil
        urlSession?.invalidateAndCancel(); urlSession = nil // pooled TLS sockets belong to the old Mac's pin
        sessions = []; sessionsLoaded = false; transcript = []; streaming = ""; reasoning = ""; running = false; prompts = []; branches = [:]
        current = nil; path = []; goal = nil; state = .off; upstream = ""; route = nil; lastFail = nil; attempt = 0; probing = false
        outgoing = []; loadingChat = false; editingQueued = nil
        workspaces = []; pinned = []; archived = []; commands = []; catalog = []; presets = []; perms = []; skills = []
        usage = nil; model = nil; defaultModel = nil; inbox = [:]; liveTodos = nil; contextWindow = nil; turnStartedAt = nil; hasOlder = false
    }

    /// Rename a paired Mac on this iPhone only; a blank name goes back to the name the Mac reports. A saved name stays
    /// when the Mac's own name changes later.
    func renameMac(_ fp: String, _ name: String) {
        guard let i = pairings.firstIndex(where: { $0.fp == fp }) else { return }
        pairings[i].label = macLabel(name)
    }

    /// Unpair the active Mac (or `fp`): its token leaves this iPhone and its per-Mac keys are deleted. Then the next Mac
    /// in the list goes on screen; with none left, the pair screen shows.
    func forget(_ why: String? = nil, fp: String? = nil) {
        guard let gone = fp ?? activeFp else { return }
        let next = nextActive(pairings, removed: gone)
        let wasActive = gone == activeFp
        for k in ["seenSessions", "finished", "drafts"] { UserDefaults.standard.removeObject(forKey: macKey(k, gone, legacy: legacyFp)) }
        if wasActive { closeScreen() }
        pairings.removeAll { $0.fp == gone }
        if wasActive {
            activeFp = nil
            if let next { switchMac(next, force: true) } else { finished = [] }
        }
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
            let mac = p.fp
            Task {
                await self.refreshMe()
                guard self.activeFp == mac else { return } // switched meanwhile: switchMac already reset probing and connected
                self.probing = false
                // No address answered (Tailscale off, Mac asleep): show it now, with the Tailscale button, instead of a
                // socket on a guessed route that stays on "Connecting…" until its timeout. drop() retries with backoff.
                if self.route == nil { self.drop(); return }
                self.connect()
            }
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
        // Back in front: the next try is a fresh one, so the screen shows "Connecting…", not the failures of the background.
        if state != .connected, pairing != nil { attempt = 0; if state == .reconnecting { state = .connecting } }
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
        (attempt, state) = afterDrop(live: state == .connected, attempt: attempt)
        if attempt >= 2 { maybeAutoTailscale() } // one blip isn't an outage; two failed sockets off Wi‑Fi are
        let delay = Double(min(30, 1 << min(attempt, 5))), mac = activeFp
        Task {
            try? await Task.sleep(for: .seconds(delay))
            guard self.ws == nil, self.activeFp == mac, let p = self.pairing else { return } // a Mac switch connects on its own
            // Bonjour fallback: same pinned certificate seen at a new address (DHCP change) → follow it. Pinning keeps this safe.
            if let f = self.found[p.fp], f.host != p.host || f.port != p.port { self.pairing?.host = f.host; self.pairing?.port = f.port }
            await self.refreshMe() // a 401 here means revoked/expired → unpairs instead of looping
            guard self.activeFp == mac else { return }
            self.connect()
        }
    }

    var tailscaleInstalled: Bool { UIApplication.shared.canOpenURL(URL(string: "tailscale://")!) } // canOpen only; never opened
    /// Runs the Tether Tailscale Shortcut (connects, comes back); App Store when Tailscale itself is missing.
    func openTailscale() {
        tsTried = true
        UIApplication.shared.open(tailscaleInstalled ? tailscaleShortcutURL() : tailscaleStoreURL)
    }
    /// tether://tailscale/<result>[?errorMessage=…] from the Shortcut. ok: tunnel is up, go straight to the tailnet address.
    func tailscaleReturned(_ u: URL) {
        switch u.lastPathComponent {
        case "ok":
            tsReady = true; tsError = nil
            if pairing?.ts != nil { reconnect(via: onWiFi ? nil : .tailscale) }
        case "error":
            tsReady = false
            // Any app can open this URL: show the text only, without control characters and not longer than 200.
            let m = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "errorMessage" }?.value
            tsError = m.map { String(String.UnicodeScalarView($0.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })).trimmingCharacters(in: .whitespaces) }
                .flatMap { $0.isEmpty ? nil : String($0.prefix(200)) } ?? String(localized: "Shortcuts gave no reason.")
            error = String(localized: "The Tether Tailscale shortcut didn't run. See Settings › Tailscale.")
        default: break
        }
    }
    private func maybeAutoTailscale() {
        guard UIApplication.shared.applicationState == .active,
              shouldAutoTailscale(onWiFi: onWiFi, hasTailnet: pairing?.ts != nil, auto: tsAuto, ready: tsReady, tried: tsTried) else { return }
        openTailscale()
    }

    func refreshMe() async {
        let mac = activeFp
        let me = try? await call("/me", nil) as? J
        guard activeFp == mac else { return } // another Mac is on screen now
        guard let me else { upstream = ""; return } // Mac itself unreachable: don't blame DSH
        upstream = me["upstream"] as? String ?? ""
        if let e = me["expiresAt"] as? String { pairing?.expiresAt = e }
        if let t = me["tailscale"] as? String, isTailnet(t), t != pairing?.ts { pairing?.ts = t } // learned without re-pairing
        if let m = (me["mac"] as? String).flatMap(macLabel), m != pairing?.mac { pairing?.mac = m } // a gateway that reports its name
        plus = Set(me["plus"] as? [String] ?? [])
        if plus.contains("grants") { await loadGrants() }
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
                followId = nil; loadingChat = false
                Task { try? await Task.sleep(for: .seconds(3)); if self.current == s, self.followId == nil, self.ws != nil { self.openFollow(s) } }
            }
        case "end": if id == followId { followId = nil; loadingChat = false }
        default: break
        }
    }

    private func onEvent(_ v: J) {
        switch v["type"] as? String {
        case "ready":
            state = .connected; attempt = 0; prompts = []; tsTried = false // the gateway re-sends everything still pending right after ready
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
            // Green dots changed on the Mac (a turn ended, or a chat was read on the Mac or another phone).
            if v["event"] as? String == "composer-plus/unread", let ids = (v["args"] as? [Any])?.first as? [String] { applyUnread(ids) }
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
    func open(_ sid: String) {
        finished.remove(sid); markRead(sid); follow(sid); path = [sid]; tab = 0
        // The Mac ends a grant after its time limit: read them again, so an ended grant leaves the Revoke row.
        if plus.contains("grants") { Task { await loadGrants() } }
    }

    /// Tells the Mac that this chat is read, so its dot goes on the other devices too. An older Mac without the route: no call.
    private func markRead(_ sid: String) {
        guard plus.contains("unread") else { return }
        Task { _ = try? await plusCall("unread", body: ["sessionIds": [sid]]) }
    }
    /// The chat you look at now. `current` stays set after Back (its stream stays open), so it counts only while the
    /// conversation is on screen.
    private var onScreen: String? { path.isEmpty ? nil : current }
    /// The Mac's dots replace this iPhone's. The chat on screen is read: the Mac hears it at once.
    private func applyUnread(_ host: [String]) {
        finished = shownUnread(host: host, sessions: sessions, open: onScreen)
        if let s = onScreen, host.contains(s) { markRead(s) }
    }

    func follow(_ sid: String) {
        if sid == current, followId != nil { return } // re-opening the live session keeps its stream and transcript
        if let old = followId { send(["type": "cancel", "streamId": old]) }
        current = sid; transcript = []; streaming = ""; reasoning = ""; usage = nil; contextWindow = nil; model = nil; goal = nil; inbox = [:]; liveTodos = nil
        hasOlder = false; oldestSeq = nil; throughSeq = nil; events = []; continueSeq = nil; rollbackOn = false; prediction = nil; redoOffer = nil
        branch = nil; newBranch = false
        running = currentSess?.running ?? false
        loadingChat = true
        openFollow(sid)
        Task { await loadCommands(); await loadGoal(); await loadRollback(sid); await loadBranch(sid) }
    }

    // MARK: Branch per chat (Composer Plus `worktreeChats`)

    /// The open chat's git branch, its change count and push state; nil outside a repository or on an older Mac.
    @Published var branch: BranchState?
    /// "New branch" is on for the next message of the open chat: the Mac names a branch from it, makes a worktree and
    /// starts a new chat there with the message.
    @Published var newBranch = false
    /// One branch start at a time (the send button and a second tap both check it).
    @Published private(set) var branching = false
    func loadBranch(_ sid: String) async {
        // Only the first read after the phone made the chat (a failed read does not choose later, when it has messages).
        let made = fresh == sid
        if made { fresh = nil }
        guard plus.contains("worktrees"), let o = try? await plusCall("worktrees", query: ["sessionId": sid]), current == sid else { return }
        branch = BranchState(o)
        // A chat made on this phone starts on "New branch", as on the Mac; the `+` menu switches it off.
        if made { newBranch = currentSess?.parent == nil && Self.startsOnNewBranch(o) }
    }
    /// The chat that this phone just made: its first branch read chooses the default.
    private var fresh: String?
    /// "New branch" by default only where the Mac can make one: the main folder of a repository with a commit (not a
    /// worktree folder or a submodule).
    static func startsOnNewBranch(_ o: J) -> Bool {
        BranchState(o) != nil && o["root"] is String && o["worktree"] as? Bool != true && o["hasCommit"] as? Bool != false
    }
    /// Sends `text`, `images` and `files` as the first message of a new chat on a new branch; the phone opens that chat.
    func startOnBranch(_ text: String, images: [Data] = [], files: [Attachment] = []) async throws {
        // A throw (not a return) so the composer puts the text back.
        guard !branching else { throw Fail(String(localized: "A branch is already being created for this chat.")) }
        guard let sid = current else { throw Fail(String(localized: "Could not start the chat on a new branch.")) }
        branching = true
        defer { branching = false; sendStatus = nil }
        // The files go to this chat first (as for a normal message); the Mac gives them to the new chat.
        var receipts: [String] = []
        for f in files {
            sendStatus = String(localized: "Uploading \(f.name)…")
            let v = try await rpc("fileUploads/upload", ["agentId": sid, "request": ["data": f.data.base64EncodedString(), "name": f.name]]) as? J
            guard let r = v?["receiptId"] as? String else { throw Fail(String(localized: "Upload failed: \(f.name)")) }
            receipts.append(r)
        }
        sendStatus = String(localized: "Creating branch…")
        var body: J = ["action": "start", "sessionId": sid, "text": text]
        let parts = Self.promptContent("", images: images, receipts: receipts)
        if !parts.isEmpty { body["attachments"] = parts }
        // Longer than the Mac's own steps (name 10 s, `worktree add` up to 120 s, the copy): a phone timeout must not
        // put the text back while the Mac still starts the chat (a resend would make a second branch).
        let o = try await plusCall("worktrees", body: body, wait: 240)
        newBranch = false
        try await loadSessions()
        if let n = o["sessionId"] as? String { open(n) }
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
        self.events = events; loadingChat = false
        rebuild()
        oldestSeq = events.first?["seq"] as? Int; throughSeq = events.last?["seq"] as? Int
    }
    /// The rows again from `events`, without the rows a rollback took out. Live state comes from the replay too.
    private func rebuild() {
        transcript = []; streaming = ""; reasoning = ""; inbox = [:]; liveTodos = nil; turnStartedAt = nil
        replaying = true; withoutRolledBack(events).forEach(draw); replaying = false
        // A rollback can hide a turn's end but not its start: the newest turn event of the whole log decides, as in continueAfter.
        if let last = events.last(where: { ["turn/start", "turn/end"].contains($0["type"] as? String) }) {
            running = last["type"] as? String == "turn/start"
            turnStartedAt = running ? (last["time"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) } : nil
        }
        continueSeq = continueAfter(events)
        loadPrediction() // opening a chat whose last turn finished shows its guess too
    }

    /// A live event: kept for a later rebuild. A rollback marker hides earlier rows, so the chat is drawn again.
    func apply(_ e: J) {
        events.append(e)
        if rollbackSpan(e) != nil {
            let keep = (running, model, usage, goal, contextWindow); rebuild(); (running, model, usage, goal, contextWindow) = keep
            // A rollback from the Mac or another phone: ask the Mac for its Redo offer.
            if let sid = current, !replaying { Task { await loadRollback(sid) } }
            return
        }
        draw(e)
        if ["turn/start", "turn/end"].contains(e["type"] as? String) {
            continueSeq = continueAfter(events)
            if prediction != nil && predictAfter(events) != prediction?.seq { prediction = nil } // a new turn: the old guess goes
            loadPrediction()
            // The turn may have changed files or committed: read the branch state again (live events only).
            if e["type"] as? String == "turn/end", !replaying, let sid = current { Task { await loadBranch(sid) } }
        }
    }

    private func draw(_ e: J) {
        let d = e["data"] as? J ?? [:]
        arrived(e["type"] as? String == "user/message" ? [d] : e["type"] as? String == "agent/inbox/spliced" ? d["inserted"] as? [J] ?? [] : [])
        switch e["type"] as? String {
        case "user/message":
            // DSH also logs runtime-context / skill-catalog injections as user messages; show only what the user typed.
            let kind = (d["source"] as? J)?["kind"] as? String
            if kind == nil || kind == "user" { transcript.append(Line(kind: .user, text: contentText(d["content"], imageMarker: false), images: imageIds(d["content"]), seq: e["seq"] as? Int)) }
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
            if !t.isEmpty { transcript.append(Line(kind: .assistant, text: t, seq: e["seq"] as? Int)) }
            if let u = d["usage"] as? J { usage = u }
        case "command/run": transcript.append(Line(kind: .command, text: "/\(d["name"] as? String ?? "") \(d["args"] as? String ?? "")".trimmingCharacters(in: .whitespaces)))
        case "command/done": if let t = d["text"] as? String, !t.isEmpty { transcript.append(Line(kind: d["kind"] as? String == "error" ? .error : .result, text: t)) }
        case "tool/call":
            let name = d["name"] as? String ?? "tool"
            transcript.append(Line(kind: .tool, text: toolSummary(name, d["arguments"]), callId: d["callId"] as? String, args: compactJSON(d["arguments"], limit: 4000), tool: name))
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
            let reason = d["reason"] as? J
            if let m = (reason?["error"] as? J)?["message"] as? String { transcript.append(Line(kind: .error, text: m)) }
            transcript.append(turnLine(reason: reason?["kind"] as? String, start: turnStartedAt,
                                       end: (e["time"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }))
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
    func prependHistory(_ older: [J]) {
        guard !older.isEmpty else { return }
        let keep = (running, model, usage, liveTodos, inbox, goal, contextWindow, turnStartedAt)
        events = older + events
        rebuild()
        running = keep.0; model = keep.1; usage = keep.2; liveTodos = keep.3; inbox = keep.4; goal = keep.5
        contextWindow = keep.6; turnStartedAt = keep.7
        oldestSeq = older.first?["seq"] as? Int ?? oldestSeq
    }

    // MARK: Actions (wire shapes from the DSH host types)

    func loadSessions() async throws {
        // Remote session/list returns every visible session with no cursor (e2e asserts this).
        // A reply that arrives after a Mac switch throws CancellationError in call(): it never reaches this list.
        let v = try await rpc("session/list", ["_request": J()]) as? J
        let fresh = (v?["items"] as? [J] ?? []).compactMap(Sess.init)
        // Branch badges: best-effort (an older Mac has no route; then no badges). Asked now, read after the dots.
        let wantBranches = plus.contains("branches")
        async let branchReply: J? = wantBranches ? plusCall("branches") : nil
        // Green dots: the Mac keeps them (a chat read on the Mac or another phone loses its dot here too).
        var host: [String]?
        if plus.contains("unread") {
            do { host = try await plusCall("unread")["unread"] as? [String] }
            catch is CancellationError { throw CancellationError() } // another Mac is on screen now
            catch {} // the Mac could not answer: the local rule below
        }
        if let host {
            finished = shownUnread(host: host, sessions: fresh, open: onScreen)
            if let s = onScreen, host.contains(s) { markRead(s) }
        } else {
            // An older Mac: guess from two lists. Cold start: compare against the last list seen before the app was
            // closed, so turns that finished meanwhile still get a dot.
            let old = sessions.isEmpty ? (UserDefaults.standard.array(forKey: key("seenSessions")) as? [J] ?? []).compactMap(Sess.init) : sessions
            // Drop dots for sessions that vanished (archived elsewhere) so the badge can't stick, and for sessions that run
            // again: a running chat shows the spinner, not "Finished".
            finished = finished.intersection(fresh.filter { !isRunning($0, fresh) }.map(\.id)).union(Self.justFinished(old: old, new: fresh, current: current))
        }
        if wantBranches {
            do { if let o = try await branchReply { branches = sessionBranches(o) } }
            catch is CancellationError { throw CancellationError() } catch {}
        } else { branches = [:] }
        sessions = fresh
        sessionsLoaded = true
        // session/list carries projections.values.userQuestions ({active, settled}, verified live by gateway/e2e.mjs).
        let live = prompts.filter { $0.event != "userQuestions/answer" }, waiting = Set(live.compactMap(\.agentId))
        prompts = live + fresh.flatMap(\.questions).filter { !waiting.contains($0.agentId ?? "") }
        UserDefaults.standard.set(Self.snapshot(fresh), forKey: key("seenSessions"))
        if let s = currentSess, s.running != running, streaming.isEmpty { running = s.running }
    }

    /// Just the fields justFinished compares, in the wire shape Sess.init reads back.
    static func snapshot(_ s: [Sess]) -> [J] {
        s.map { s in
            var j: J = ["sessionId": s.id, "running": s.running, "projections": ["values": ["title": s.title]]]
            if let u = s.updated { j["updatedAt"] = u.timeIntervalSince1970 * 1000 }
            if let p = s.parent { j["parentSessionId"] = p; j["origin"] = "subagent" } // a chat counts as running while its subagent runs
            return j
        }
    }

    /// Not the open chat, idle now (its subagents too), and either was running last list or got a newer updatedAt (a whole turn between two refreshes) without a rename.
    static func justFinished(old: [Sess], new: [Sess], current: String?) -> Set<String> {
        let prev = Dictionary(old.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return Set(new.filter { n in
            guard !isRunning(n, new), n.id != current, let o = prev[n.id] else { return false }
            if isRunning(o, old) { return true }
            guard let a = o.updated, let b = n.updated else { return false }
            return b > a && o.title == n.title
        }.map(\.id))
    }

    /// DSH refuses a session/create with both: a workspace gives its own folder (and adds the chat to that project).
    static func createRequest(cwd: String?, workspaceId: String?) -> J {
        if let workspaceId { return ["workspaceId": workspaceId] }
        if let cwd, !cwd.isEmpty { return ["cwd": cwd] }
        return J()
    }

    func create(cwd: String?, workspaceId: String? = nil) async throws {
        let v = try await rpc("session/create", ["request": Self.createRequest(cwd: cwd, workspaceId: workspaceId)]) as? J
        try await loadSessions()
        if let id = v?["sessionId"] as? String { fresh = id; open(id) }
    }

    /// The workspace of a Mac answer to `/plus/new-session-workspace`; nil (DSH picks) for anything else.
    static func defaultWorkspaceId(_ o: J?) -> String? {
        guard let id = o?["workspaceId"] as? String, !id.isEmpty else { return nil }
        return id
    }

    /// Quick chat: the Mac's default workspace (Composer Plus → Default workspace for New session). Switched off, an older
    /// Mac or any failure: DSH's own default folder, as before.
    func createQuick() async throws {
        let o = plus.contains("new-session-workspace") ? try? await plusCall("new-session-workspace", body: [:]) : nil
        try await create(cwd: nil, workspaceId: Self.defaultWorkspaceId(o))
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
        // The message shows at once with "Sending…" until the Mac's copy arrives; a failed send takes it away again.
        let rid = UUID().uuidString
        outgoing.append(Outgoing(id: rid, session: sid, text: text, attachments: images.count + files.count))
        defer { sendStatus = nil }
        do { try await deliver(rid, sid, text, images: images, files: files, steer: steer) }
        catch { outgoing.removeAll { $0.id == rid }; throw error }
        // The Mac took it. Its copy comes on the chat's stream; if that stream is down, the bubble still goes after 15 s
        // (the next snapshot shows the message).
        Task { try? await Task.sleep(for: .seconds(15)); outgoing.removeAll { $0.id == rid } }
    }
    private func deliver(_ rid: String, _ sid: String, _ text: String, images: [Data], files: [Attachment], steer: Bool) async throws {
        var receipts: [String] = []
        // receipts are scoped to this session; the host resolves them when the prompt arrives
        for f in files {
            sendStatus = String(localized: "Uploading \(f.name)…")
            let v = try await rpc("fileUploads/upload", ["agentId": sid, "request": ["data": f.data.base64EncodedString(), "name": f.name]]) as? J
            guard let r = v?["receiptId"] as? String else { throw Fail(String(localized: "Upload failed: \(f.name)")) }
            receipts.append(r)
        }
        sendStatus = nil
        let content = Self.promptContent(text, images: images, receipts: receipts)
        _ = try await rpc("session/prompt", ["request": ["requestId": rid, "sessionId": sid, "mode": steer ? "steer" : "queue", "content": content]])
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// The Mac's copy of a message sent from here (in the chat or in its queue): its "Sending…" bubble goes.
    private func arrived(_ messages: [J]) {
        let ids = Set(messages.compactMap(promptRequestId))
        if !ids.isEmpty { outgoing.removeAll { ids.contains($0.id) } }
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
    /// Nothing for a message whose editor is open or whose save runs (Queue edit).
    func updateQueue(_ itemId: String, _ action: J) async throws {
        guard let sid = current, editingQueued?.id != itemId else { return }
        try await queueAction(sid, itemId, action)
    }
    private func queueAction(_ sid: String, _ itemId: String, _ action: J) async throws {
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
                let tunnels = vpnTunnels(path.availableInterfaces.map(\.name))
                let tunnelsChanged = tunnels != self.tunnels; self.tunnels = tunnels
                if w != self.onWiFi {
                    self.onWiFi = w; if w { self.tsTried = false }
                    self.urlSession?.finishTasksAndInvalidate(); self.urlSession = nil // pooled sockets belong to the old interface; don't abort handshakes mid-flight
                    if self.pairing != nil, path.status == .satisfied { self.reconnect() } // Wi‑Fi ⇄ cellular: old route is dead, switch now
                } else if tunnelsChanged, self.state != .connected, self.pairing?.ts != nil, path.status == .satisfied {
                    // a tunnel just came up (Tailscale turned on by the user, an automation, or On Demand): don't sit out the backoff
                    self.reconnect(via: w ? nil : .tailscale)
                }
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


// MARK: - App lock (Face ID, Touch ID or the device passcode)

/// The result of one unlock request.
enum UnlockResult: Equatable { case ok, cancelled, noPasscode, failed(String) }

/// Tether's app lock. While `on`, the app is locked when it starts and when it comes back from the background; the
/// user unlocks with Face ID, Touch ID or the device passcode. `inactive` (Control Center, the Face ID sheet itself, a
/// call) only covers the screen: it never locks, so the Face ID sheet cannot start a loop.
@MainActor final class AppLock: ObservableObject {
    @Published private(set) var on: Bool
    @Published private(set) var locked: Bool
    /// The screen is covered: locked, or inactive while on (the app switcher shows no chat).
    @Published private(set) var covered: Bool
    /// The reason the last unlock did not work; shown on the lock screen.
    @Published var message: String?
    /// A Face ID (or passcode) request runs: the Unlock button and the switch wait.
    @Published private(set) var asking = false
    /// One automatic ask per lock (at start, or back from the background). The Face ID sheet makes the app inactive and,
    /// when it closes, active again: without this a Cancel would show a new sheet at once, again and again. After that
    /// the user asks with the Unlock button.
    private var autoAsk: Bool
    private let defaults: UserDefaults
    private let authenticate: (String) async -> UnlockResult
    static let key = "appLock"

    init(defaults: UserDefaults = .standard, authenticate: @escaping (String) async -> UnlockResult = AppLock.deviceOwner) {
        self.defaults = defaults; self.authenticate = authenticate
        let on = defaults.bool(forKey: AppLock.key)
        self.on = on; locked = on; covered = on; autoAsk = on
    }

    /// A scene phase change of the app.
    func phase(_ p: ScenePhaseKind) {
        guard on else { covered = false; return }
        switch p {
        case .background: locked = true; covered = true; autoAsk = true
        case .inactive: covered = true
        case .active:
            if !locked { covered = false; return }
            covered = true
            if autoAsk { autoAsk = false; Task { await unlock() } }
        }
    }

    /// Asks once. A second call while one runs does nothing.
    func unlock() async {
        guard on, locked, !asking else { return }
        asking = true
        defer { asking = false }
        switch await authenticate(String(localized: "Unlock Tether to see your chats.")) {
        case .ok: locked = false; covered = false; message = nil
        case .cancelled: message = nil
        case .noPasscode:
            // No passcode on this iPhone: the lock cannot work. Turn it off instead of locking the user out.
            setStored(false); locked = false; covered = false
            message = String(localized: "Set a passcode on this iPhone to use the app lock. The lock is off.")
        case .failed(let m): message = m
        }
    }

    /// The Settings switch. Turning it on asks first, so a lock that the user cannot open never starts.
    @discardableResult func setOn(_ value: Bool) async -> Bool {
        guard value != on, !asking else { return on == value }
        if !value { setStored(false); locked = false; covered = false; return true }
        asking = true
        defer { asking = false }
        switch await authenticate(String(localized: "Turn on the app lock for Tether.")) {
        case .ok: setStored(true); message = nil; return true
        case .noPasscode: message = String(localized: "Set a passcode on this iPhone to use the app lock."); return false
        case .cancelled: return false
        case .failed(let m): message = m; return false
        }
    }

    private func setStored(_ v: Bool) { on = v; defaults.set(v, forKey: AppLock.key) }

    /// Face ID or Touch ID, with the device passcode as the fallback. A new context each time: an old one keeps its result.
    static func deviceOwner(_ reason: String) async -> UnlockResult {
        let ctx = LAContext()
        var e: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &e) else {
            return e?.code == LAError.passcodeNotSet.rawValue ? .noPasscode : .failed(e?.localizedDescription ?? String(localized: "This iPhone cannot check who you are."))
        }
        do { return try await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) ? .ok : .cancelled }
        catch let err as LAError {
            switch err.code {
            case .userCancel, .appCancel, .systemCancel: return .cancelled
            case .passcodeNotSet: return .noPasscode
            default: return .failed(err.localizedDescription)
            }
        } catch { return .failed(error.localizedDescription) }
    }

    /// The kind of lock this iPhone offers, for the switch's label.
    static var kind: LABiometryType {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        return ctx.biometryType
    }
    /// The iPhone has a passcode (the lock needs one).
    static var available: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }
}

/// SwiftUI's ScenePhase without SwiftUI (Core.swift has no SwiftUI import).
enum ScenePhaseKind { case active, inactive, background }
