import XCTest
@testable import DSHMobile

/// Pure security / parsing checks. Network paths are covered by gateway/test.mjs.
final class CoreTests: XCTestCase {
    // Two independent self-signed EC P-256 certs (DER, base64) and the SHA-256 of cert A.
    let certA = Data(base64Encoded: "MIIBdzCCAR2gAwIBAgIUSSVfp+kxtdHDLK6tcQyZjQ569Q8wCgYIKoZIzj0EAwIwETEPMA0GA1UEAwwGdGVzdC1hMB4XDTI2MTAxMjE2NDgyMVoXDTM2MTAwOTE2NDgyMVowETEPMA0GA1UEAwwGdGVzdC1hMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUroA7G5hlAh+PCsAhf0JZZdvXoxh7u2Ia1hJ0e+2QOGBUMvaWRJyaBg0/AVfa3oDsrgSHWsb4ElgS3C/XuUdXKNTMFEwHQYDVR0OBBYEFOpGE1RC/HB6N7RpYoI4x7QNfKH5MB8GA1UdIwQYMBaAFOpGE1RC/HB6N7RpYoI4x7QNfKH5MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAPIyLkYx+821n4SgJUC7L/I+4pjCZiGdbTVwUuoLS8vGAiAUM76g1Hzx8K+JZ9Z3h4j8NvtV90vkcGjK8RkmbOXfMg==")!
    let certB = Data(base64Encoded: "MIIBdjCCAR2gAwIBAgIUIYxKjXLFjnawkA4VLpfPhIREdkAwCgYIKoZIzj0EAwIwETEPMA0GA1UEAwwGdGVzdC1iMB4XDTI2MTAxMjE2NDgyMVoXDTM2MTAwOTE2NDgyMVowETEPMA0GA1UEAwwGdGVzdC1iMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2WNtisygXWyLFI2yI+UqHTsVIVSFaxhryeWwLQu6qagmheIeW1lP4jkFwGJLsAIVO3p9J2IyY75p0B+iqsC62KNTMFEwHQYDVR0OBBYEFONYT9eNwNYC6SMfqncsusyO1GlGMB8GA1UdIwQYMBaAFONYT9eNwNYC6SMfqncsusyO1GlGMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIgUEXjM7izs86bBX3B269/AU9qpGJfQEUC9WYClcD8Fx0CIHHTLxOfGhiI+ts2+AhkkVuGLe+1h/PNwd+RUUU41hbi")!
    let fpA = "c669bc9676f7b7d4b0da00fbbebc96305a4cbca9e25f24a2b4e444ef125ebe74"

    func testPinAcceptsOwnCertificate() {
        XCTAssertEqual(sha256Hex(certA), fpA)
        XCTAssertTrue(pinMatches(der: certA, fp: fpA))
        let colons = stride(from: 0, to: 64, by: 2).map { i in fpA.dropFirst(i).prefix(2).uppercased() }.joined(separator: ":")
        XCTAssertTrue(pinMatches(der: certA, fp: colons))
    }

    func testPinRejectsOtherCertificate_MITM() {
        XCTAssertFalse(pinMatches(der: certB, fp: fpA))
        XCTAssertFalse(pinMatches(der: certA, fp: sha256Hex(certB)))
        XCTAssertFalse(pinMatches(der: certA, fp: ""))
        XCTAssertFalse(pinMatches(der: certA, fp: String(fpA.dropLast())))
    }

    func testLANOnly() {
        XCTAssertEqual(cleanTitle("  Fix login \n"), "Fix login")
        XCTAssertNil(cleanTitle(" \n\t "))
        // office Wi‑Fi with a tailnet address must not say "same Wi‑Fi" only
        XCTAssertTrue(lostHint(onWiFi: true, hasTailnet: true).contains("Tailscale"))
        XCTAssertTrue(lostHint(onWiFi: false, hasTailnet: false).contains("Install Tailscale"))
        XCTAssertFalse(lostHint(onWiFi: true, hasTailnet: false).contains("Tailscale"))
        // Tailscale: never the bare tailscale:// (that is Tailscale's tailnet-lock signing link); run the bundled Shortcut
        let sc = URLComponents(url: tailscaleShortcutURL(), resolvingAgainstBaseURL: false)!
        XCTAssertEqual(sc.scheme, "shortcuts"); XCTAssertEqual(sc.queryItems?.first { $0.name == "name" }?.value, "Tether Tailscale")
        XCTAssertEqual(sc.queryItems?.first { $0.name == "x-success" }?.value, "tether://tailscale/ok")
        XCTAssertEqual(sc.queryItems?.first { $0.name == "x-error" }?.value, "tether://tailscale/error")
        XCTAssertNotNil(Bundle(for: Client.self).url(forResource: tsShortcutName, withExtension: "shortcut"), "signed shortcut bundled")
        // a VPN coming up shows as a new utun; other interfaces don't count
        XCTAssertEqual(vpnTunnels(["en0", "pdp_ip0", "utun0", "utun3", "ipsec1", "lo0"]), ["utun0", "utun3", "ipsec1"])
        XCTAssertNotEqual(vpnTunnels(["pdp_ip0", "utun0"]), vpnTunnels(["pdp_ip0", "utun0", "utun4"]))
        // auto-run only off Wi‑Fi, with a tailnet address, a proven Shortcut, and once per outage
        XCTAssertTrue(shouldAutoTailscale(onWiFi: false, hasTailnet: true, auto: true, ready: true, tried: false))
        XCTAssertFalse(shouldAutoTailscale(onWiFi: true, hasTailnet: true, auto: true, ready: true, tried: false))
        XCTAssertFalse(shouldAutoTailscale(onWiFi: false, hasTailnet: true, auto: true, ready: true, tried: true))
        XCTAssertFalse(shouldAutoTailscale(onWiFi: false, hasTailnet: true, auto: true, ready: false, tried: false))
        XCTAssertFalse(shouldAutoTailscale(onWiFi: false, hasTailnet: false, auto: true, ready: true, tried: false))
        XCTAssertFalse(shouldAutoTailscale(onWiFi: false, hasTailnet: true, auto: false, ready: true, tried: false))
        // the Tailscale button: off Wi‑Fi always; on Wi‑Fi (office Wi‑Fi, home Mac) when the Mac has a tailnet address
        XCTAssertTrue(offersTailscale(onWiFi: false, hasTailnet: true))
        XCTAssertTrue(offersTailscale(onWiFi: false, hasTailnet: false))
        XCTAssertTrue(offersTailscale(onWiFi: true, hasTailnet: true))
        XCTAssertFalse(offersTailscale(onWiFi: true, hasTailnet: false))
        // the first-connect probe fails fast, also on its last address; other calls keep the system time-out there
        XCTAssertEqual(requestTimeout(last: false, probing: false), 5)
        XCTAssertEqual(requestTimeout(last: false, probing: true), 5)
        XCTAssertEqual(requestTimeout(last: true, probing: true), 10)
        XCTAssertNil(requestTimeout(last: true, probing: false))
        // a hung first connect gets the hint; a fresh one and a live link stay quiet
        XCTAssertFalse(showsLostHint(.connecting, slow: false))
        XCTAssertTrue(showsLostHint(.connecting, slow: true))
        XCTAssertFalse(showsLostHint(.connected, slow: true))
        XCTAssertTrue(showsLostHint(.reconnecting, slow: false))
        for ok in ["10.0.0.1", "172.16.4.2", "172.31.255.255", "192.168.1.44", "169.254.10.3"] { XCTAssertTrue(isLANv4(ok), ok) }
        for bad in ["8.8.8.8", "172.32.0.1", "192.169.0.1", "127.0.0.1", "0.0.0.0", "10.0.0", "10.0.0.256", "evil.com", "10.0.0.1.nip.io", "::1", " 10.0.0.1", "１0.0.0.1"] {
            XCTAssertFalse(isLANv4(bad), bad)
        }
        // Bonjour over the USB cable resolves to 169.254.x, where the gateway never listens
        XCTAssertTrue(bonjourHost("192.168.1.44"))
        XCTAssertFalse(bonjourHost("169.254.61.172"))
        XCTAssertFalse(bonjourHost("8.8.8.8"))
    }

    func testInboxSplice() {
        // the live sequence DSH emitted for: run a turn, queue a 2nd prompt, edit it, turn consumes it
        var inbox: [String: [J]] = [:]
        applySplice(&inbox, ["target": "next-turn", "start": 0, "inserted": [["id": "a"]]])
        applySplice(&inbox, ["target": "next-turn", "start": 0, "removedCount": 1, "inserted": [J]()])
        applySplice(&inbox, ["target": "next-turn", "start": 0, "inserted": [["id": "b", "content": "x"]]])
        applySplice(&inbox, ["target": "next-turn", "start": 0, "removedCount": 1, "inserted": [["id": "b", "content": "y"]], "outcome": "canceled"])
        XCTAssertEqual(inbox["next-turn"]?.map { $0["content"] as? String }, ["y"])
        applySplice(&inbox, ["target": "next-turn", "start": 0, "removedCount": 1, "inserted": [J]()])
        XCTAssertEqual(inbox["next-turn"]?.count, 0)
        // a removal for an item before the snapshot window must not crash
        applySplice(&inbox, ["target": "next-step", "start": 3, "removedCount": 2, "inserted": [J]()])
        XCTAssertEqual(inbox["next-step"]?.count, 0)
    }

    func testInvite() {
        let good = #"{"v":1,"host":"192.168.1.44","port":19390,"fp":"C6:69:BC:96:76:F7:B7:D4:B0:DA:00:FB:BE:BC:96:30:5A:4C:BC:A9:E2:5F:24:A2:B4:E4:44:EF:12:5E:BE:74","code":"123456"}"#
        let i = parseInvite(good)
        XCTAssertEqual(i?.fp, fpA)
        XCTAssertEqual(i?.port, 19390)
        XCTAssertNil(parseInvite(good.replacingOccurrences(of: "192.168.1.44", with: "93.184.216.34")), "public IP")
        XCTAssertNil(parseInvite(good.replacingOccurrences(of: #""v":1"#, with: #""v":2"#)), "version")
        XCTAssertNil(parseInvite(good.replacingOccurrences(of: "C6:69", with: "ZZ:69")), "bad fp")
        XCTAssertNil(parseInvite(good.replacingOccurrences(of: "19390", with: "70000")), "port")
        XCTAssertNil(parseInvite("not json"))
        XCTAssertNil(i?.ts, "old QR without ts still parses")
        let ts = good.replacingOccurrences(of: #""code""#, with: #""ts":"100.90.0.7","code""#)
        XCTAssertEqual(parseInvite(ts)?.ts, "100.90.0.7")
        XCTAssertNil(parseInvite(ts.replacingOccurrences(of: "100.90.0.7", with: "8.8.8.8")), "public ts")
    }

    /// The Mac's QR is now a tether:// link (the Camera app opens it in Tether). Same checks as the JSON text.
    func testPairLink() {
        let fp = "c669bc9676f7b7d4b0da00fbbebc96305a4cbca9e25f24a2b4e444ef125ebe74"
        let link = "tether://pair?v=1&host=192.168.1.44&port=19390&fp=\(fp)&code=ab-_12&mac=Ofis%20Mac%E2%80%99i%20%26%20co&ts=100.90.0.7"
        let i = parseInvite(link)
        XCTAssertEqual(i, Invite(v: 1, host: "192.168.1.44", port: 19390, fp: fp, code: "ab-_12", ts: "100.90.0.7", mac: "Ofis Mac’i & co"))
        XCTAssertEqual(parseInvite("  " + link + "\n"), i, "pasted with spaces")
        XCTAssertEqual(parseInvite(#"{"v":1,"host":"192.168.1.44","port":19390,"fp":"\#(fp)","code":"ab-_12","ts":"100.90.0.7","mac":"Ofis Mac’i & co"}"#), i, "old JSON text: same invite")
        XCTAssertNil(parseInvite(link.replacingOccurrences(of: "192.168.1.44", with: "93.184.216.34")), "public IP")
        XCTAssertNil(parseInvite(link.replacingOccurrences(of: "v=1", with: "v=2")), "version")
        XCTAssertNil(parseInvite(link.replacingOccurrences(of: "&code=ab-_12", with: "")), "no code")
        XCTAssertNil(parseInvite(link.replacingOccurrences(of: "ts=100.90.0.7", with: "ts=8.8.8.8")), "public ts")
        XCTAssertNil(parseInvite(link.replacingOccurrences(of: "tether://pair", with: "tether://tailscale")), "other tether link")
        XCTAssertNil(parseInvite(link.replacingOccurrences(of: "tether://", with: "https://")), "web link")
        XCTAssertNil(parseInvite("https://example.com"), "any other QR")
        XCTAssertEqual(parseInvite(link.replacingOccurrences(of: "%20", with: "+"))?.mac, "Ofis Mac’i & co", "'+' for a space (form encoding)")
        XCTAssertEqual(parseInvite(link.replacingOccurrences(of: "mac=Ofis%20Mac%E2%80%99i%20%26%20co", with: "mac=C%2B%2B%20Box"))?.mac, "C++ Box", "a real plus")
        XCTAssertNil(parseInvite(link.replacingOccurrences(of: "port=19390", with: "port=x")), "bad port")
    }

    /// A new pairing replaces the entry for the same Mac with an old certificate, so that entry stops its reconnect loop.
    func testReplacedBy() {
        let p = { (fp: String, host: String, mac: String?) in Pairing(host: host, port: 19390, fp: fp, token: "t", deviceId: "d", name: "n", expiresAt: "", mac: mac) }
        let list = [p("old", "192.168.2.63", "Furkan MacBook Pro"), p("other", "192.168.2.70", "Studio"), p("legacy", "192.168.2.63", nil), p("samehost", "192.168.2.63", "Another Mac")]
        XCTAssertEqual(replacedBy(list, p("new", "192.168.2.63", "Furkan MacBook Pro")), ["old", "legacy"], "same address: same name or no name")
        XCTAssertEqual(replacedBy(list, p("other", "192.168.9.9", "Studio")), ["other"], "same certificate at a new address")
        XCTAssertEqual(replacedBy(list, p("x", "192.168.2.80", "Furkan MacBook Pro")), [], "another address: a second Mac with the same name stays")
        XCTAssertEqual(pairFailText(status: 403, error: "pairing expired"), "Nobody clicked Approve on the Mac in time. Scan the code again.")
        XCTAssertNotEqual(pairFailText(status: 403, error: "pairing denied"), pairFailText(status: 403, error: "invalid or expired pairing code"))
        XCTAssertTrue(PairPhase.waiting("M", until: .now).busy); XCTAssertTrue(PairPhase.done("M").busy); XCTAssertFalse(PairPhase.failed("x").busy); XCTAssertFalse(PairPhase.idle.busy)
    }

    /// The pair screen shows the user's own name for a Mac this iPhone knows, also when the Mac has a new certificate.
    func testKnownAlias() {
        let fp = String(repeating: "ab", count: 32)
        var old = Pairing(host: "192.168.2.63", port: 19390, fp: "old", token: "t", deviceId: "d", name: "n", expiresAt: "", mac: "Furkan MacBook Pro")
        let inv = Invite(v: 1, host: "192.168.2.63", port: 19390, fp: fp, code: "c", mac: "Furkan MacBook Pro")
        XCTAssertNil(knownAlias([old], inv), "no name of the user's own: the Mac's name shows")
        old.label = "Office"
        XCTAssertEqual(knownAlias([old], inv), "Office", "same Mac, new certificate")
        XCTAssertNil(knownAlias([old], Invite(v: 1, host: "192.168.2.63", port: 19390, fp: fp, code: "c", mac: "Another Mac")), "another Mac at that address")
        XCTAssertNil(knownAlias([old], Invite(v: 1, host: "192.168.2.70", port: 19390, fp: fp, code: "c", mac: "Furkan MacBook Pro")), "a second Mac with the same name")
        XCTAssertEqual(old.title, "Office")
    }

    func testTailnet() {
        for ok in ["100.64.0.1", "100.127.255.255", "mac.tail1.ts.net"] { XCTAssertTrue(isTailnet(ok), ok) }
        for bad in ["100.63.0.1", "100.128.0.1", "MAC.ts.net", "evil.com", "ts.net.evil.com", ".ts.net", "8.8.8.8", "192.168.1.2", "a b.ts.net"] {
            XCTAssertFalse(isTailnet(bad), bad)
        }
        let old = #"{"host":"192.168.1.44","port":19390,"fp":"x","token":"t","deviceId":"d","name":"n","expiresAt":""}"#
        XCTAssertNotNil(try? JSONDecoder().decode(Pairing.self, from: Data(old.utf8)), "Keychain pairing from before Tailscale")
        XCTAssertEqual(try? JSONDecoder().decode(Pairing.self, from: Data(old.utf8)).title, "192.168.1.44", "one-Mac pairing has no name: the address")
    }

    func testManyMacs() {
        let p = { (fp: String, mac: String?) in Pairing(host: "192.168.1.\(fp.count)", port: 19390, fp: fp, token: "t-" + fp, deviceId: "d", name: "n", expiresAt: "", mac: mac) }
        // No limit: every new certificate is one more Mac, in pairing order.
        var list: [Pairing] = []
        for i in 0..<12 { list = upserted(list, p("fp\(i)", "Mac \(i)")) }
        XCTAssertEqual(list.map(\.fp), (0..<12).map { "fp\($0)" })
        // Pairing the same Mac again replaces it in place (new token) and keeps the user's label.
        list[3].label = "Office"
        list = upserted(list, p("fp3", "Mac 3 renamed"))
        XCTAssertEqual(list.count, 12); XCTAssertEqual(list[3].token, "t-fp3"); XCTAssertEqual(list[3].title, "Office"); XCTAssertEqual(list[3].mac, "Mac 3 renamed")
        XCTAssertEqual(list[4].title, "Mac 4", "no label: the name the Mac reports")
        // After unpairing, the next Mac in the list goes on screen; the last one falls back to the one before it.
        XCTAssertEqual(nextActive(list, removed: "fp3"), "fp4")
        XCTAssertEqual(nextActive(list, removed: "fp11"), "fp10")
        XCTAssertNil(nextActive([p("only", nil)], removed: "only"))
        // Per-Mac keys: the first (migrated) Mac keeps the old key; others get their own; no Mac = old key.
        XCTAssertEqual(macKey("finished", "fp0", legacy: "fp0"), "finished")
        XCTAssertEqual(macKey("finished", nil, legacy: "fp0"), "finished")
        XCTAssertNotEqual(macKey("finished", "aaaaaaaaaaaaaaaa1", legacy: nil), macKey("finished", "bbbbbbbbbbbbbbbb1", legacy: nil))
        XCTAssertEqual(macKey("drafts", "0123456789abcdef0123", legacy: nil), "drafts.0123456789abcdef")
        // Names: trimmed, no control characters, at most 64, blank = none.
        XCTAssertEqual(macLabel("  Studio \n"), "Studio"); XCTAssertNil(macLabel("  \n")); XCTAssertEqual(macLabel("A\u{7}B"), "AB")
        XCTAssertEqual(macLabel(String(repeating: "x", count: 90))?.count, 64)
        // A QR from a gateway with a name carries it; an old QR still parses without one.
        let qr = #"{"v":1,"host":"192.168.1.44","port":19390,"fp":"C6:69:BC:96:76:F7:B7:D4:B0:DA:00:FB:BE:BC:96:30:5A:4C:BC:A9:E2:5F:24:A2:B4:E4:44:EF:12:5E:BE:74","code":"123456","mac":" Studio "}"#
        XCTAssertEqual(parseInvite(qr)?.mac, "Studio")
    }

    @MainActor func testSwitchMacClearsScreen() {
        let c = Client()
        let saved = c.pairings
        defer { c.pairings = saved } // the Keychain item belongs to the real app
        c.pairings = [Pairing(host: "192.168.1.2", port: 19390, fp: "a1", token: "ta", deviceId: "d", name: "n", expiresAt: "", mac: "A"),
                      Pairing(host: "192.168.1.3", port: 19390, fp: "b2", token: "tb", deviceId: "d", name: "n", expiresAt: "", mac: "B")]
        c.activeFp = "a1"
        c.open("x"); c.transcript = [Line(kind: .user, text: "hi")]
        XCTAssertEqual(c.pairing?.token, "ta")
        c.switchMac("b2")
        XCTAssertEqual(c.activeFp, "b2"); XCTAssertEqual(c.pairing?.token, "tb", "requests now use B's token")
        XCTAssertNil(c.current); XCTAssertTrue(c.transcript.isEmpty); XCTAssertTrue(c.path.isEmpty, "nothing of A stays on screen")
        // A write through `pairing` changes only the active Mac.
        c.pairing?.ts = "100.90.0.7"
        XCTAssertEqual(c.pairings.first { $0.fp == "b2" }?.ts, "100.90.0.7"); XCTAssertNil(c.pairings.first { $0.fp == "a1" }?.ts)
        // Unpair a Mac that is not on screen: the screen stays on B.
        c.forget(fp: "a1")
        XCTAssertEqual(c.pairings.map(\.fp), ["b2"]); XCTAssertEqual(c.activeFp, "b2")
        // Unpair the last Mac: no Mac on screen (the pair screen shows).
        c.forget()
        XCTAssertTrue(c.pairings.isEmpty); XCTAssertNil(c.pairing)
    }

    func testMarkdownBlocks() {
        let b = mdBlocks("Intro **bold**\n```swift\nlet x = 1\n```\nAfter")
        XCTAssertEqual(b.map(\.code), [false, true, false])
        XCTAssertEqual(b[1].text, "let x = 1")
        XCTAssertEqual(b[1].lang, "swift")
        XCTAssertEqual(mdBlocks("```\nx\n```")[0].lang, "")
        XCTAssertEqual(b[2].text, "After")
        XCTAssertEqual(mdBlocks("plain").count, 1)
        XCTAssertEqual(mdLine("## Plan"), .heading(2, "Plan"))
        XCTAssertEqual(mdLine("#hashtag"), .text("#hashtag"))
        XCTAssertEqual(mdLine("  - item **b**"), .bullet(1, "item **b**"))
        XCTAssertEqual(mdLine("12. step"), .number(0, "12", "step"))
        XCTAssertEqual(mdLine("2024. yılı"), .text("2024. yılı"))
        XCTAssertEqual(mdLine("> note"), .quote("note"))
        XCTAssertEqual(mdLine("---"), .rule)
        XCTAssertEqual(mdLine("   "), .blank)
        XCTAssertEqual(mdLine("-5 degrees"), .text("-5 degrees"))
        XCTAssertEqual(tableRow("| a | b |"), ["a", "b"])
        XCTAssertEqual(tableRow("|---|:-:|"), [])
        XCTAssertNil(tableRow("plain"))
        XCTAssertEqual(tableRow("| a \\| b | c |"), ["a | b", "c"])
        XCTAssertEqual(mdParts("- one\n  more\n  - two\n\nplain"), [.line("- one more"), .line("  - two"), .line(""), .line("plain")])
        XCTAssertEqual(mdParts("x\n| a | b |\n|---|---|\n| 1 | 2 |\ny"), [.line("x"), .table([["a", "b"], ["1", "2"]]), .line("y")])
    }

    func testContentAndQuestions() {
        XCTAssertEqual(contentText([["type": "text", "text": "a"], ["type": "image"], ["type": "other"]]), "a\n🖼")
        let q = Question.parse(["questions": [["id": "q1", "question": "Which?", "multiSelect": true, "options": [["label": "A"], ["label": "B", "description": "b"]]], ["question": "no id"]]])
        XCTAssertEqual(q.count, 1)
        XCTAssertEqual(q[0].options.map(\.label), ["A", "B"])
        XCTAssertTrue(q[0].multi)
        XCTAssertNil(q[0].approve)
        let plan = Question.parse(["questions": [["id": "p", "question": "Plan?", "intent": ["kind": "plan-review", "approve": "Approve plan"]]]])
        XCTAssertEqual(plan[0].approve, "Approve plan")
    }

    @MainActor func testApplyHidesInjectedContextAndShowsModel() {
        let c = Client()
        c.apply(["type": "user/message", "data": ["source": ["kind": "runtime-context"], "content": [["type": "text", "text": "sys"]]]])
        c.apply(["type": "user/message", "data": ["source": ["kind": "user"], "content": [["type": "text", "text": "Selam"]]]])
        c.apply(["type": "request/header", "data": ["header": ["config": ["model": "deepseek-flash", "reasoningEffort": "high"]]]])
        XCTAssertEqual(c.transcript.map(\.text), ["Selam"])
        XCTAssertEqual(c.model, "deepseek-flash · high")
    }

    @MainActor func testAttachments() throws {
        let c = Client.promptContent("hi", images: [Data([1])], receipts: ["r1"])
        XCTAssertEqual(c.map { $0["type"] as? String }, ["text", "image", "file"])
        XCTAssertEqual(c[2]["receiptId"] as? String, "r1")
        XCTAssertTrue(Client.promptContent("", images: [], receipts: []).isEmpty)
        XCTAssertEqual(contentText([["type": "text", "text": "a"], ["type": "file", "attachment": ["name": "x.pdf"]]]), "a\n📎 x.pdf")
        let withImg: [J] = [["type": "image", "attachment": ["attachmentId": "a1"]], ["type": "text", "text": "x"]]
        XCTAssertEqual(imageIds(withImg), ["a1"])
        XCTAssertEqual(contentText(withImg, imageMarker: false), "x")
        XCTAssertTrue(contentText(withImg).contains("🖼"))
        let dir = FileManager.default.temporaryDirectory
        let small = dir.appendingPathComponent("a.txt"), big = dir.appendingPathComponent("big.bin")
        try Data("ok".utf8).write(to: small)
        try Data(count: Attachment.maxBytes + 1).write(to: big)
        XCTAssertEqual(try Attachment.load(small).name, "a.txt")
        XCTAssertThrowsError(try Attachment.load(big))
    }

    @MainActor func testSubagentPrompt() {
        let kid = Sess(["sessionId": "k", "parentSessionId": "p", "origin": "subagent", "projections": ["values": ["title": "k"]]])!
        let r = Client.subagentRequest(kid, "  go on ")
        XCTAssertEqual(r?["parentSessionId"] as? String, "p")
        XCTAssertEqual(r?["childSessionId"] as? String, "k")
        XCTAssertEqual(r?["delivery"] as? String, "queue")
        XCTAssertEqual((r?["content"] as? [J])?.first?["text"] as? String, "go on")
        XCTAssertNil(Client.subagentRequest(kid, "  "))
        XCTAssertNil(Client.subagentRequest(Sess(["sessionId": "root"])!, "x"))
    }

    @MainActor func testOpenFromOtherTab() {
        let c = Client()
        c.tab = 1
        c.open("x")
        XCTAssertEqual(c.tab, 0)
        XCTAssertEqual(c.path, ["x"])
        XCTAssertEqual(c.current, "x")
    }

    @MainActor func testPrependHistoryKeepsLiveState() {
        // snapshot replay: a finished turn ends not-running; a trailing open turn stays running
        let s = Client()
        s.replaySnapshot([["type": "turn/start", "seq": 1, "data": J()], ["type": "turn/end", "seq": 2, "data": J()]])
        XCTAssertFalse(s.running)
        s.replaySnapshot([["type": "turn/start", "seq": 7, "time": 1_700_000_000_000, "data": J()]])
        XCTAssertTrue(s.running)
        XCTAssertEqual(s.turnStartedAt, Date(timeIntervalSince1970: 1_700_000_000)) // timer counts from DSH's start, not from opening the chat
        s.apply(["type": "turn/end", "data": J()])
        XCTAssertNil(s.turnStartedAt)

        let c = Client()
        c.replaySnapshot([["type": "user/message", "seq": 7, "data": ["content": "new"]]]); c.running = true; c.model = "deepseek-v4"
        c.prependHistory([
            ["type": "turn/start", "seq": 3, "data": J()],
            ["type": "user/message", "seq": 4, "data": ["content": "old"]],
            ["type": "request/context", "seq": 5, "data": ["model": "other"]],
            ["type": "turn/end", "seq": 6, "data": J()],
        ])
        XCTAssertEqual(c.transcript.map(\.text), ["old", "Completed", "new"], "an old finished turn gets its summary row")
        XCTAssertTrue(c.running)
        XCTAssertEqual(c.model, "deepseek-v4")
        let r = Client.pageRequest("s", through: 9, before: 3)["request"] as? J
        XCTAssertEqual(r?["beforeSeq"] as? Int, 3)
        XCTAssertEqual(r?["throughSeq"] as? Int, 9)
    }

    @MainActor func testForkIsARootChat() {
        // dsh's session/fork (Branch, Redo, Tether's Fork) lists parentSessionId without origin: a chat of its own.
        let fork = Sess(["sessionId": "f", "parentSessionId": "p", "cwd": "/p/acme", "projections": ["values": ["title": "Redo"]]])!
        XCTAssertNil(fork.parent)
        let kid = Sess(["sessionId": "k", "parentSessionId": "p", "origin": "subagent"])!
        XCTAssertEqual(kid.parent, "p")
        XCTAssertEqual(Sess(["sessionId": "k2", "projections": ["values": ["subagent": ["parentSessionId": "p"]]]])!.parent, "p")
        let back = (Client.snapshot([fork, kid]) as [J]).compactMap(Sess.init)
        XCTAssertEqual(back.map(\.parent), [nil, "p"], "the saved list keeps which chat is a subagent")
        XCTAssertEqual(shownUnread(host: ["f", "k"], sessions: [fork, kid], open: nil), ["f"], "a fork gets its green dot")
    }

    @MainActor func testCreateRequestSendsWorkspaceOrFolder() {
        // DSH: "session.create accepts workspaceId or cwd, not both" (New session → Projects sent both).
        XCTAssertEqual(Client.createRequest(cwd: "/p/acme", workspaceId: "w1") as NSDictionary, ["workspaceId": "w1"])
        XCTAssertEqual(Client.createRequest(cwd: "/p/acme", workspaceId: nil) as NSDictionary, ["cwd": "/p/acme"])
        XCTAssertEqual(Client.createRequest(cwd: "", workspaceId: nil) as NSDictionary, [:])
        XCTAssertEqual(Client.createRequest(cwd: nil, workspaceId: nil) as NSDictionary, [:])
    }

    @MainActor func testReasoningSessionModelAndGroups() {
        let md = transcriptMarkdown([Line(kind: .user, text: "hi"), Line(kind: .tool, text: "ls"), Line(kind: .assistant, text: "hello")], title: "T")
        XCTAssertEqual(md, "# T\n\n## You\n\nhi\n\n## Assistant\n\nhello\n")
        // Export shape (as on the Mac): replies in a row join, an open fence is closed, empty rows and tools are left out.
        let two = transcriptMarkdown([Line(kind: .assistant, text: "a"), Line(kind: .tool, text: "ls"), Line(kind: .assistant, text: "```js\nx"), Line(kind: .user, text: "  ")], title: "  Login\n bug ")
        XCTAssertEqual(two, "# Login bug\n\n## Assistant\n\na\n\n```js\nx\n```\n")
        XCTAssertEqual(closeFences("~~~~\na\n~~~"), "~~~~\na\n~~~\n~~~~")
        XCTAssertEqual(closeFences("````md\n```js\ninner\n```\n````"), "````md\n```js\ninner\n```\n````")
        XCTAssertEqual(closeFences("``` a`b\ntext"), "``` a`b\ntext")
        XCTAssertEqual(closeFences("```\na\n``` x"), "```\na\n``` x\n```")
        XCTAssertEqual(laterChecklist([["title": "Dark mode", "summary": "A dark theme."], ["title": "Export", "summary": "Save as CSV.", "why": "x"]]), "- [ ] Dark mode — A dark theme.\n- [ ] Export — Save as CSV.\n")
        XCTAssertEqual(focusPresets.count, 6)
        // Open GitHub issue: only an https issue link of the Mac is a link.
        XCTAssertEqual(issueLink(["url": "https://github.com/acme/web/issues/42", "number": 42])?.number, 42)
        XCTAssertEqual(issueLink(["url": "https://github.com/acme/web/issues/42"])?.url.absoluteString, "https://github.com/acme/web/issues/42")
        XCTAssertEqual(issueLink(["url": "https://git.example.com:8443/acme/web/issues/3"])?.number, 3, "GitHub Enterprise with a port")
        for bad in ["javascript:alert(1)", "http://github.com/a/b/issues/1", "https://github.com/a/b/pull/1", "https://github.com/a/issues/1", "https://github.com/a/b/issues/1 x",
                    "https://github.com@evil.example/a/b/issues/1"] {
            XCTAssertNil(issueLink(["url": bad]), bad)
        }
        XCTAssertNil(issueLink(nil)); XCTAssertNil(issueLink("https://github.com/a/b/issues/1"))
        // Chats that changed this file: rows as the Mac answers them; a row without a chat id or seq is dropped.
        let fc = fileChatRows(["chats": [["sessionId": "s1", "seq": 9, "count": 2, "time": 1700000000000, "title": "T", "request": "Fix it"],
                                         ["sessionId": "s2", "seq": 4, "withdrawn": true], ["seq": 1], ["sessionId": "s3"]]])
        XCTAssertEqual(fc.map(\.id), ["s1#9", "s2#4"])
        XCTAssertEqual(fc[0].count, 2); XCTAssertEqual(fc[0].request, "Fix it"); XCTAssertEqual(fc[0].time?.timeIntervalSince1970, 1700000000)
        XCTAssertTrue(fc[1].withdrawn); XCTAssertNil(fc[1].time); XCTAssertEqual(fc[1].count, 1)
        XCTAssertTrue(fileChatRows([:]).isEmpty)
        // Find in chat: your messages and the answers, folded (case, accents, ı), counted per row; steps are not searched.
        let fu = Line(kind: .user, text: "Run NPM test, then npm test"), fa = Line(kind: .assistant, text: "Şeker: npm Test passed")
        let ft = Line(kind: .tool, text: "npm test"), fo = Line(kind: .assistant, text: "nothing here")
        let rows: [ChatRow] = [.line(fu), .steps([ft], live: false), .line(fo), .line(fa)]
        XCTAssertEqual(findRows(rows, query: "npm test").map(\.id), [fu.id, fa.id])
        XCTAssertEqual(findRows(rows, query: "npm test").map(\.count), [2, 1])
        XCTAssertEqual(findRows(rows, query: "seker").map(\.id), [fa.id])
        XCTAssertEqual(findRows(rows, query: "SIRT").count, 0)
        XCTAssertTrue(findRows(rows, query: "   ").isEmpty)
        XCTAssertEqual(findFold("İçİn ıI"), "icin ii")
        // Branch badge: the Mac's map; off on the Mac, a bad answer or an empty name = no badge.
        XCTAssertEqual(sessionBranches(["on": true, "branches": ["s1": "main", "s2": "", "s3": 7]]), ["s1": "main"])
        XCTAssertEqual(sessionBranches(["on": false, "branches": ["s1": "main"]]), [:])
        XCTAssertEqual(sessionBranches([:]), [:])
        XCTAssertEqual(closeFences("```js\r\nx"), "```js\r\nx\n```", "CRLF lines")
        XCTAssertEqual(clampFocus(String(repeating: "x", count: 79) + "😀"), String(repeating: "x", count: 79), "an emoji past 80 UTF-16 units is not split")
        XCTAssertEqual(clampFocus(String(repeating: "x", count: 78) + "😀y"), String(repeating: "x", count: 78) + "😀")
        let calls = [Line(kind: .tool, text: "old", callId: "c1"), Line(kind: .tool, text: "rm -rf build", callId: "c2", args: "{}")]
        XCTAssertEqual(approvalCall(["callId": "c2"], in: calls)?.text, "rm -rf build")
        XCTAssertNil(approvalCall(["toolName": "bash"], in: calls))
        XCTAssertTrue(modelMatches("deepseek-v4 · high", "deepseek-v4"))
        XCTAssertTrue(modelMatches("deepseek-v4 · high", "deepseek-v4", "high"))
        XCTAssertFalse(modelMatches("deepseek-v4 · high", "deepseek-v4", "low"))
        XCTAssertFalse(modelMatches("deepseek-v4-pro", "deepseek-v4"))
        XCTAssertFalse(modelMatches(nil, "deepseek-v4"))
        let c = Client()
        c.apply(["type": "assistant/message", "data": ["message": ["content": [["type": "reasoning", "text": "hmm"], ["type": "text", "text": "Hi"]]]]])
        XCTAssertEqual(c.transcript.map(\.kind), [.reasoning, .assistant])
        // tool result folds into its call by callId; an orphan result still shows on its own
        c.apply(["type": "tool/call", "data": ["callId": "k1", "name": "read", "arguments": ["path": "a"]]])
        c.apply(["type": "tool/result", "data": ["message": ["toolCallId": "k1", "isError": true, "content": [["type": "text", "text": "nope"]]]]])
        c.apply(["type": "tool/result", "data": ["message": ["toolCallId": "zz", "content": [["type": "text", "text": "x"]]]]])
        XCTAssertEqual(c.transcript.map(\.kind), [.reasoning, .assistant, .tool, .result])
        XCTAssertEqual(c.transcript[2].output, "nope"); XCTAssertTrue(c.transcript[2].failed)
        let mk = { (id: String) in Sess(["sessionId": id, "cwd": "/p", "projections": ["values": ["title": id,
            "modelSelection": ["next": ["model": "m", "reasoningEffort": "max"]], "contextPressure": ["projectedTokens": 250, "contextWindow": 1000]]]])! }
        let a = mk("a"); XCTAssertEqual(a.model, "m · max"); XCTAssertEqual(a.context, 0.25)
        XCTAssertEqual(contextShare(["inputTokens": 100, "cacheReadTokens": 300, "cacheWriteTokens": 100], window: 1000), 0.5)
        XCTAssertEqual(toolSummary("bash", ["command": "ls -la", "timeout": 5]), "bash ls -la")
        XCTAssertEqual(toolSummary("x", ["n": 1]), "x {\"n\":1}")
        XCTAssertEqual(toolSummary("noargs", nil), "noargs")
        let u1 = Line(kind: .user, text: "a"), a1 = Line(kind: .assistant, text: "x"), u2 = Line(kind: .user, text: "b"), a2 = Line(kind: .assistant, text: "y")
        XCTAssertEqual(promptLine(before: a2.id, in: [u1, a1, u2, a2])?.text, "b")
        XCTAssertEqual(promptLine(before: a1.id, in: [u1, a1, u2, a2])?.text, "a")
        XCTAssertNil(promptLine(before: u1.id, in: [u1, a1]))
        let err = Line(kind: .error, text: "rate limited")
        XCTAssertEqual(retryPrompt(for: err.id, in: [u1, a1, u2, err])?.text, "b")
        XCTAssertNil(retryPrompt(for: err.id, in: [u1, err, u2]), "an error followed by a newer prompt is stale")
        XCTAssertNil(retryPrompt(for: a2.id, in: [u2, a2]), "only error rows offer retry")
        let t1 = Line(kind: .tool, text: "x"), t2 = Line(kind: .tool, text: "y")
        XCTAssertFalse(inCurrentTurn(t1.id, in: [u1, t1, u2, t2]))
        XCTAssertTrue(inCurrentTurn(t2.id, in: [u1, t1, u2, t2]))
        XCTAssertEqual(elapsedText(7), "7s")
        XCTAssertEqual(elapsedText(65), "1m 05s")
        XCTAssertEqual(elapsedText(3720), "1h 02m")
        XCTAssertEqual(compactCount(950), "950")
        XCTAssertEqual(compactCount(1_000), "1k")
        XCTAssertEqual(compactCount(1_234), "1.2k")
        XCTAssertEqual(compactCount(12_345), "12k")
        XCTAssertEqual(compactCount(1_260_000), "1.3M")
        XCTAssertEqual(usageText(["inputTokens": 12_345, "outputTokens": 800, "cacheReadTokens": 5]), "in 12k · out 800")
        XCTAssertEqual(usageDetail(["inputTokens": 12, "cacheReadTokens": 5, "reasoningTokens": 3]), "Input: 12\nCache read: 5\nReasoning: 3")
        XCTAssertEqual(contextShare(["inputTokens": 5000], window: 1000), 1)
        XCTAssertNil(contextShare(["inputTokens": 5], window: nil))
        XCTAssertTrue(contextHot(0.8)); XCTAssertFalse(contextHot(0.79)); XCTAssertFalse(contextHot(nil))
        c.apply(["type": "request/context", "data": ["model": "m", "contextWindow": 2000]]); XCTAssertEqual(c.contextWindow, 2000)
        XCTAssertNil(a.permission)
        XCTAssertEqual(Sess(["sessionId": "p", "projections": ["values": ["permissions": ["currentValue": "read-only"]]]])?.permission, "read-only")
        c.sessions = [a, mk("b"), mk("c"), mk("d")]
        c.onWorkspace(["type": "baseline", "value": ["items": [["workspaceId": "w", "path": "/p/proj", "sessionIds": ["b"]]], "pinnedSessionIds": ["c"], "archivedSessionIds": ["d"]]])
        XCTAssertEqual(c.sessionGroups().map(\.title), ["Pinned", "proj", "Ungrouped", "Archived"])
        XCTAssertTrue(groupFolded("", "Archived")); XCTAssertFalse(groupFolded("", "proj"))
        let f = toggledFold("", "proj"); XCTAssertTrue(groupFolded(f, "proj")); XCTAssertEqual(toggledFold(f, "proj"), "")
        XCTAssertFalse(groupFolded(toggledFold(f, "Archived"), "Archived")); XCTAssertEqual(groupIcon("Ungrouped"), "tray")
        // Collapse all projects: only open project groups count; the button hides when none is open (Pinned stays open).
        XCTAssertEqual(openProjects(c.sessionGroups(), folds: ""), ["proj", "Ungrouped"])
        XCTAssertEqual(openProjects(c.sessionGroups(), folds: "proj"), ["Ungrouped"])
        XCTAssertEqual(openProjects(c.sessionGroups(), folds: "proj\nUngrouped"), [], "Pinned and Archived do not count")
        let fs = [Sess(["sessionId": "1", "cwd": "/old", "updatedAt": 1_000])!, Sess(["sessionId": "2", "cwd": "/new", "updatedAt": 3_000])!,
                  Sess(["sessionId": "3", "cwd": "/old", "updatedAt": 2_000])!, Sess(["sessionId": "4", "cwd": "/p", "updatedAt": 4_000])!]
        XCTAssertEqual(recentFolders(fs, excluding: ["/p"]), ["/new", "/old"])
        // Next message prediction: only right after a finished turn.
        let te = { (seq: Int, type: String, kind: String?) -> J in ["seq": seq, "type": type, "data": kind.map { ["reason": ["kind": $0]] } ?? [:]] }
        XCTAssertEqual(predictAfter([te(1, "turn/start", nil), te(4, "turn/end", "completed")]), 4)
        XCTAssertNil(predictAfter([te(1, "turn/start", nil), te(4, "turn/end", "interrupted")]), "stopped: Continue instead")
        XCTAssertNil(predictAfter([te(4, "turn/end", "completed"), te(5, "turn/start", nil)]), "running")
        XCTAssertEqual(predictAfter([te(4, "turn/end", "completed"), ["seq": 5, "type": "user/message"]]), 4, "other events do not count")
        XCTAssertNil(predictAfter([]))
        // Complete while typing: the same rules as the Mac; typing along the guess keeps it.
        XCTAssertTrue(completable("Run")); XCTAssertFalse(completable(" Ru ")); XCTAssertFalse(completable("/plan add"))
        XCTAssertFalse(completable(String(repeating: "a", count: 4001)))
        XCTAssertEqual(completionRest(typed: "Run the", asked: "Run the", completion: " tests now"), " tests now")
        XCTAssertEqual(completionRest(typed: "Run the te", asked: "Run the", completion: " tests now"), "sts now")
        XCTAssertNil(completionRest(typed: "Run the x", asked: "Run the", completion: " tests now"), "typed off the guess")
        XCTAssertNil(completionRest(typed: "Run the tests now", asked: "Run the", completion: " tests now"), "all typed")
        XCTAssertNil(completionRest(typed: "Run", asked: "Run the", completion: " tests"), "text was deleted")
        // Improve prompt: the same rules as the Mac: some text, at most 8000 characters, not a slash command.
        XCTAssertTrue(improvable("fix login")); XCTAssertTrue(improvable("x")); XCTAssertFalse(improvable("  \n "))
        XCTAssertFalse(improvable("/plan add tests")); XCTAssertFalse(improvable(String(repeating: "a", count: 8001)))
        XCTAssertTrue(improvable(String(repeating: "a", count: 8000)))
        // The Mac counts UTF-16 units: 4001 emoji are 8002 units.
        XCTAssertFalse(improvable(String(repeating: "😀", count: 4001))); XCTAssertTrue(improvable(String(repeating: "😀", count: 4000)))
        // Project search in a new chat: A–Z (numbers in natural order), every word, case and accents ignored.
        let ws = ["serit", "aiproxy", "Zeta", "ağaç-proje", "app10", "app2", "promes"].compactMap { Workspace(["workspaceId": $0, "path": "/p/\($0)", "title": $0]) }
        XCTAssertEqual(pickerProjects(ws, query: "").map(\.title), ["ağaç-proje", "aiproxy", "app2", "app10", "promes", "serit", "Zeta"])
        XCTAssertEqual(pickerProjects(ws, query: "PRO").map(\.title), ["ağaç-proje", "aiproxy", "promes"])
        XCTAssertEqual(pickerProjects(ws, query: "agac").map(\.title), ["ağaç-proje"])
        XCTAssertEqual(pickerProjects(ws, query: "p/ze").map(\.title), ["Zeta"], "the path matches too")
        XCTAssertTrue(searchHit("ILIK su", "ılık-su")); XCTAssertFalse(searchHit("x", "abc")); XCTAssertTrue(searchHit("  ", "abc"))
        XCTAssertEqual(macPath("  ~/code\n"), "~/code"); XCTAssertNil(macPath("code")); XCTAssertNil(macPath("  "))
        XCTAssertEqual(c.sessionGroups().map { $0.items.map(\.id) }, [["c"], ["b"], ["a"], ["d"]])
        XCTAssertEqual(c.sessionGroups(project: "w").map { $0.items.map(\.id) }, [["b"]])
        XCTAssertEqual(c.sessionGroups(project: "nope").count, 4)
        // In one list (dsh's Group by): no project groups, Pinned and Archived stay; the project filter still works.
        c.oneList = true
        XCTAssertEqual(c.sessionGroups().map(\.title), ["Pinned", "All sessions", "Archived"])
        XCTAssertEqual(c.sessionGroups()[0].items.map(\.id), ["c"]); XCTAssertEqual(c.sessionGroups()[2].items.map(\.id), ["d"])
        XCTAssertEqual(Set(c.sessionGroups()[1].items.map(\.id)), ["a", "b"], "the project chat and the ungrouped chat are in one list")
        XCTAssertEqual(c.sessionGroups(project: "w").map { $0.items.map(\.id) }, [["b"]])
        XCTAssertEqual(openProjects(c.sessionGroups(), folds: ""), [], "no projects: no Collapse all button")
        // the 2-hour filter keeps single chats here; the chats of this test have no time, so only the open one stays
        c.recentOnly = true; c.current = "a"
        XCTAssertEqual(c.sessionGroups().map { $0.items.map(\.id) }, [["c"], ["a"]], "Pinned always shows")
        c.recentOnly = false; c.current = nil
        c.oneList = false
        XCTAssertEqual(c.sessionGroups().map(\.title), ["Pinned", "proj", "Ungrouped", "Archived"])
        // newest first inside a group, sessions without a timestamp last
        let t = { (id: String, ms: Double?) in Sess(["sessionId": id, "updatedAt": ms as Any, "projections": ["values": ["title": id]]])! }
        c.sessions = [t("old", 1_000), t("none", nil), t("new", 2_000)]
        XCTAssertEqual(c.sessionGroups().last?.items.map(\.id), ["new", "old", "none"])
        XCTAssertEqual(c.titleMatches(" OL ").map(\.id), ["old"])
        XCTAssertTrue(c.titleMatches("  ").isEmpty)
        XCTAssertEqual(t("x", 1_500).updated, Date(timeIntervalSince1970: 1.5))
    }

    @MainActor func testTodos() {
        let c = Client()
        XCTAssertEqual(c.shownTodos, [])
        c.apply(["type": "todo/write", "data": ["todos": [["content": "a", "status": "completed"], ["content": "b", "status": "in_progress"]]]])
        XCTAssertEqual(c.shownTodos.map(\.status), ["completed", "in_progress"])
        let s = Sess(["sessionId": "t", "projections": ["values": ["todos": [["content": "x"]]]]])
        XCTAssertEqual(s?.todos, [Todo(content: "x", status: "pending")])
    }

    func testQuestions() {
        let row: J = ["callId": "c1", "questions": [["id": "q", "question": "?"]]]
        let w = parseQuestions(["val": ["active": [row, ["questions": []]]]], session: "s")
        XCTAssertEqual(w.map(\.id), ["c1"])
        XCTAssertEqual(w.first?.agentId, "s")
        XCTAssertEqual(w.first?.event, "userQuestions/answer")
        XCTAssertEqual(parseQuestions(["active": [row]], session: "s").count, 1)
        XCTAssertTrue(parseQuestions(nil, session: "s").isEmpty)
        XCTAssertEqual(Sess(["sessionId": "t", "projections": ["values": ["userQuestions": ["active": [row]]]]])?.questions.count, 1)
    }

    @MainActor func testDrafts() {
        let c = Client()
        c.setDraft("half typed", "draft-test")
        XCTAssertEqual(c.draft("draft-test"), "half typed")
        XCTAssertEqual(c.draft(nil), "")
        c.setDraft("", "draft-test")
        XCTAssertEqual(c.draft("draft-test"), "")
    }

    @MainActor func testSessionErrorShownOnceInOpenChat() {
        let c = Client()
        c.current = "s1"
        c.sessionError(["s1", "provider down"])
        c.sessionError(["s1", "provider down"])
        c.sessionError(["s1"]) // malformed
        XCTAssertEqual(c.transcript.filter { $0.kind == .error }.map(\.text), ["provider down"])
        c.sessionError(["other", "x"]) // other session: notification only
        XCTAssertEqual(c.transcript.count, 1)
    }

    func testGoal() {
        XCTAssertNil(Goal(["objective": "no id"]))
        let g = Goal(["id": "g1", "revision": 3, "objective": "ship", "phase": "paused", "roundsStarted": 2, "maxGoalRounds": 10])
        XCTAssertEqual(g?.summary, "paused · 2/10")
        XCTAssertEqual(g?.paused, true)
        XCTAssertEqual(Goal(["id": "g", "revision": 1, "phase": "active"])?.summary, "active")
        let s = Sess(["sessionId": "t", "projections": ["values": ["goal": ["val": ["goal": ["id": "g", "revision": 1, "phase": "paused", "maxGoalRounds": 10], "roundsStarted": 2]]]]])
        XCTAssertEqual(s?.goal?.summary, "paused · 2/10")
        XCTAssertNil(Sess(["sessionId": "t"])?.goal)
    }

    func testZoomClamp() {
        // preset labels (kept here to share the CoreTests class)
        XCTAssertEqual(presetLabel("ptc"), "PTC")
        XCTAssertEqual(presetLabel("standard"), "Standard")
        XCTAssertEqual(presetLabel(""), "")
        XCTAssertEqual(permLabel("auto", "auto"), "Auto review (experimental)")
        XCTAssertEqual(permLabel("danger-full-access", nil), "Full access")
        XCTAssertEqual(permLabel("auto", "Smart"), "Smart")
        XCTAssertEqual(permLabel("custom", nil), "custom")
        let ps = [Preset(id: "standard", name: "Standard", desc: nil, broken: false, isDefault: true), Preset(id: "ptc", name: "PTC", desc: nil, broken: false)]
        XCTAssertNil(customPreset(nil, ps))
        XCTAssertNil(customPreset("standard", ps))
        XCTAssertEqual(customPreset("ptc", ps)?.name, "PTC")
        XCTAssertNil(customPreset("gone", ps))
        XCTAssertEqual(zoomClamp(0.3), 1)
        XCTAssertEqual(zoomClamp(2), 2)
        XCTAssertEqual(zoomClamp(9), 5)
    }

    /// Tether can't list shortcuts: only a run that comes back says Ready; an error keeps Shortcuts' reason.
    @MainActor func testTailscaleReturned() {
        let c = Client(), was = c.tsReady
        defer { c.tsReady = was }
        c.tailscaleReturned(URL(string: "tether://tailscale/error?errorMessage=The%20shortcut%20could%20not%20be%20found.%0A")!)
        XCTAssertFalse(c.tsReady); XCTAssertEqual(c.tsError, "The shortcut could not be found.")
        c.tailscaleReturned(URL(string: "tether://tailscale/error")!)
        XCTAssertEqual(c.tsError, "Shortcuts gave no reason.")
        c.tailscaleReturned(URL(string: "tether://tailscale/ok?result=")!)
        XCTAssertTrue(c.tsReady); XCTAssertNil(c.tsError)
        c.tailscaleReturned(URL(string: "tether://tailscale/cancel")!)
        XCTAssertTrue(c.tsReady, "cancel changes nothing")
    }

    /// DSH desktop's chat shape: steps fold into one row; a finished turn folds to its summary and its answer.
    @MainActor func testChatRows() {
        let c = Client()
        c.apply(["type": "user/message", "data": ["content": "fix it"]])
        c.apply(["type": "turn/start", "time": 1_700_000_000_000, "data": J()])
        c.apply(["type": "assistant/message", "data": ["message": ["content": [["type": "reasoning", "text": "hmm"], ["type": "text", "text": "Looking."]]]]])
        c.apply(["type": "tool/call", "data": ["callId": "a", "name": "read", "arguments": ["path": "x"]]])
        c.apply(["type": "tool/call", "data": ["callId": "b", "name": "grep", "arguments": ["pattern": "y"]]])
        c.apply(["type": "tool/call", "data": ["callId": "d", "name": "read", "arguments": ["path": "z"]]])
        c.apply(["type": "assistant/message", "data": ["message": ["content": [["type": "text", "text": "Done."]]]]])
        c.apply(["type": "turn/end", "time": 1_700_000_065_000, "data": ["reason": ["kind": "completed"]]])
        let t = c.transcript
        XCTAssertEqual(t.last?.text, "Completed in 1m 5s")
        func shape(_ rows: [ChatRow]) -> [String] {
            rows.map { r in switch r {
                case .line(let l): l.text
                case .steps(let ls, let live): "steps \(ls.count)\(live ? " live" : "")"
                case .turn(let l, let f): "\(l.text)\(f ? " v" : "")"
            } }
        }
        XCTAssertEqual(shape(chatRows(t, open: [], running: false)), ["fix it", "Completed in 1m 5s v", "Done."], "folded: summary and answer only")
        XCTAssertEqual(shape(chatRows(t, open: [t.last!.id], running: false)), ["fix it", "Completed in 1m 5s v", "steps 1", "Looking.", "steps 3", "Done."])
        XCTAssertEqual(stepsTitle(Array(t[3...5]), live: false).title, "Read files and searched code", "most calls first")
        XCTAssertEqual(stepsTitle([t[2]], live: false).title, "Analysis completed")
        // the turn in flight: no summary yet, its last steps run
        let live = Array(t[0...5])
        XCTAssertEqual(shape(chatRows(live, open: [], running: true)), ["fix it", "steps 1", "Looking.", "steps 3 live"])
        XCTAssertEqual(stepsTitle([Line(kind: .tool, text: "bash npm test", tool: "bash")], live: true).title, "Running commands · npm test")
        // a failed or stopped turn does not fold
        let stop = turnLine(reason: "interrupted", start: nil, end: nil)
        XCTAssertEqual(shape(chatRows(live + [stop], open: [], running: false)), ["fix it", "Stopped", "steps 1", "Looking.", "steps 3"])
        XCTAssertEqual(turnLine(reason: "completed", start: .now, end: nil).text, "Completed")
        XCTAssertEqual(stepKind("terminal_run"), "commands"); XCTAssertEqual(stepKind("subagent_fork"), "subagents"); XCTAssertEqual(stepKind("x"), "tools")
        let five = ["read", "grep", "edit", "bash", "web_search"].map { Line(kind: .tool, text: $0, tool: $0) }
        XCTAssertEqual(stepsTitle(five, live: false).title, "Read files, searched code, edited files, etc.")
    }

    /// Composer Plus features: the same rules as the plugin's desktop half (client.js / index.js).
    @MainActor func testComposerPlusRules() {
        // Turn rollback: the marker hides [min(sourceEventSeqs), marker]; a live marker draws the chat again.
        let ev: [J] = [
            ["type": "user/message", "seq": 1, "data": ["content": "one", "source": ["kind": "user"]]],
            ["type": "assistant/message", "seq": 2, "data": ["message": ["content": [["type": "text", "text": "A1"]]]]],
            ["type": "user/message", "seq": 3, "data": ["content": "two", "source": ["kind": "user"]]],
            ["type": "assistant/message", "seq": 4, "data": ["message": ["content": [["type": "text", "text": "A2"]]]]],
        ]
        let marker: J = ["type": "user/message", "seq": 5, "sourceEventSeqs": [4, 3], "data": ["content": [], "source": ["kind": rollbackSource]]]
        XCTAssertEqual(rollbackSpan(marker), 3...5); XCTAssertNil(rollbackSpan(ev[0]))
        XCTAssertEqual(withoutRolledBack(ev + [marker]).compactMap { $0["seq"] as? Int }, [1, 2])
        // dsh-rewind-plugin's marker withdraws too; dsh's /compact marker only hides old messages from the model: they stay.
        let rewind: J = ["type": "user/message", "seq": 5, "sourceEventSeqs": [3, 4], "data": ["content": [], "source": ["kind": "dsh-rewind"]]]
        let compact: J = ["type": "user/message", "seq": 6, "sourceEventSeqs": [1, 2], "data": ["content": [], "source": ["kind": "compact-checkpoint"]]]
        XCTAssertEqual(rollbackSpan(rewind), 3...5); XCTAssertNil(rollbackSpan(compact))
        XCTAssertEqual(withoutRolledBack(ev + [rewind, compact]).compactMap { $0["seq"] as? Int }, [1, 2, 6])
        let c = Client()
        c.replaySnapshot(ev)
        XCTAssertEqual(c.transcript.map(\.text), ["one", "A1", "two", "A2"]); XCTAssertEqual(c.transcript[2].seq, 3, "a user row keeps its seq")
        c.apply(marker)
        XCTAssertEqual(c.transcript.map(\.text), ["one", "A1"], "the withdrawn rows leave at once")
        // A rolled-back chat opened later: the span hides both turn ends but not the first turn's start (seen live).
        let turns: [J] = [
            ["type": "turn/start", "seq": 4, "time": 1_700_000_000_000, "data": J()],
            ["type": "user/message", "seq": 8, "data": ["content": "one", "source": ["kind": "user"]]],
            ["type": "turn/end", "seq": 10, "data": ["reason": ["kind": "completed"]]],
            ["type": "turn/start", "seq": 11, "data": J()],
            ["type": "user/message", "seq": 12, "data": ["content": "two", "source": ["kind": "user"]]],
            ["type": "turn/end", "seq": 13, "data": ["reason": ["kind": "completed"]]],
            ["type": "user/message", "seq": 14, "sourceEventSeqs": [12, 8], "data": ["content": [], "source": ["kind": rollbackSource]]],
        ]
        let rolled = Client()
        rolled.replaySnapshot(turns)
        XCTAssertFalse(rolled.running, "a rolled-back chat that ended is not working")
        XCTAssertNil(rolled.turnStartedAt)
        XCTAssertNil(rolled.continueSeq)
        rolled.replaySnapshot(Array(turns.prefix(2)))
        XCTAssertTrue(rolled.running, "an open turn still runs")
        XCTAssertEqual(rolled.turnStartedAt, Date(timeIntervalSince1970: 1_700_000_000))
        // Continue: the newest turn decides; a completed turn needs nothing.
        let t = { (seq: Int, type: String, reason: String?) -> J in ["type": type, "seq": seq, "data": reason.map { ["reason": ["kind": $0]] } ?? J()] }
        XCTAssertNil(continueAfter([t(1, "turn/start", nil), t(2, "turn/end", "completed")]))
        XCTAssertEqual(continueAfter([t(1, "turn/start", nil), t(2, "turn/end", "interrupted")]), 2)
        XCTAssertEqual(continueAfter([t(1, "turn/end", "completed"), t(5, "turn/start", nil), t(6, "tool/call", nil)]), 5, "an open turn")
        XCTAssertNil(continueAfter([]))
        c.apply(t(6, "turn/start", nil)); c.apply(t(7, "turn/end", "error"))
        XCTAssertEqual(c.continueSeq, 7)
        // Copy session link: dsh-session: + base64url(JSON string), no padding (client.js sessionDeeplink).
        XCTAssertEqual(sessionLink("abc"), "dsh-session:ImFiYyI")
        XCTAssertEqual(sessionLink("a/b?"), "dsh-session:ImEvYj8i")
        // Plan mode: a pending switch flips the host value; the draft toggle adds or drops a leading /plan only.
        XCTAssertTrue(planOn(["active": true])); XCTAssertFalse(planOn(["active": true, "pending": true])); XCTAssertTrue(planOn(["active": false, "pending": true])); XCTAssertFalse(planOn(nil))
        XCTAssertEqual(planToggled("fix it"), "/plan fix it"); XCTAssertEqual(planToggled("/plan fix it"), "fix it")
        XCTAssertEqual(planToggled("/plan"), ""); XCTAssertEqual(planToggled("/planning x"), "/plan /planning x")
        // Queue reorder: texts move from the last row up; a row with an image cannot be crossed.
        let m = queueMove(["a", "b", "c"], from: 0, to: 2)!
        XCTAssertEqual(m.map(\.row), [2, 1, 0]); XCTAssertEqual(m.map(\.next), ["a", "c", "b"]); XCTAssertEqual(m.map(\.prev), ["c", "b", "a"])
        XCTAssertEqual(queueMove(["a", "b", "c"], from: 2, to: 1)!.map(\.next), ["b", "c"])
        XCTAssertNil(queueMove(["a", nil, "c"], from: 0, to: 2)); XCTAssertNil(queueMove(["a"], from: 0, to: 0))
        XCTAssertEqual(queueText(["content": [["type": "text", "text": "hi"]]]), "hi"); XCTAssertNil(queueText(["content": [["type": "image"]]]))
        // Project status: waiting wins, then an unseen finish, then running (with the count); subagents count for their parent.
        let s = { (id: String, run: Bool, parent: String?) in Sess(["sessionId": id, "running": run, "parentSessionId": parent as Any, "origin": "subagent"])! }
        let all = [s("a", false, nil), s("b", true, nil), s("k", true, "a"), s("d", false, nil)]
        XCTAssertEqual(projectMark(Array(all[0...1]), all: all, waiting: [], finished: []), .running(2))
        XCTAssertEqual(projectMark(Array(all[0...1]), all: all, waiting: [], finished: ["a"]), .done)
        XCTAssertEqual(projectMark(Array(all[0...1]), all: all, waiting: ["b"], finished: ["a"]), .waiting)
        XCTAssertNil(projectMark([all[3]], all: all, waiting: [], finished: []))
        // Order by status and the 2-hour filter.
        XCTAssertEqual([all[3], all[0], all[1]].sorted { statusRank($0, all: all, waiting: [], finished: ["d"]) < statusRank($1, all: all, waiting: [], finished: ["d"]) }.map(\.id), ["d", "a", "b"])
        let old = Sess(["sessionId": "o", "updatedAt": 1_000_000])!, now = Date(timeIntervalSince1970: 1_000 + 7300)
        XCTAssertFalse(recentChat(old, all: [old], now: now, open: nil, waiting: [], finished: []))
        XCTAssertTrue(recentChat(old, all: [old], now: Date(timeIntervalSince1970: 1_000 + 7100), open: nil, waiting: [], finished: []))
        XCTAssertTrue(recentChat(old, all: [old], now: now, open: "o", waiting: [], finished: []), "the open chat stays")
        // Green dots from the Mac: idle root chats only, never the chat on screen, never an id the list does not have.
        // "a" waits for its running subagent "k", so it shows the spinner, not a dot.
        XCTAssertEqual(shownUnread(host: ["a", "b", "k", "d", "gone"], sessions: all, open: nil), ["d"])
        XCTAssertEqual(shownUnread(host: ["d"], sessions: all, open: "d"), [], "the chat on screen is read")
        XCTAssertEqual(shownUnread(host: [], sessions: all, open: nil), [], "read on the Mac: the dot goes")
        let idle = [s("a", false, nil), s("k", false, "a")]
        XCTAssertEqual(shownUnread(host: ["a", "k"], sessions: idle, open: nil), ["a"], "a subagent never gets a dot")
    }

    /// Copy message link: the same link and the same two forms as client.js messageLink / messageLinkRule.
    func testMessageLink() {
        XCTAssertEqual(messageLink("abc", 42), "dsh-session:ImFiYyI#42")
        let id = "session-5e87ba98-b640-4cc7-b8a7-877edc05c3aa"
        let text = "see dsh-session:ImFiYyI#42 and @\(id)#5."
        let found = parseMessageLink(text)
        XCTAssertEqual(found.map(\.sessionId), ["abc", id]); XCTAssertEqual(found.map(\.seq), [42, 5])
        XCTAssertEqual(found.map { String(text[$0.range]) }, ["dsh-session:ImFiYyI#42", "@\(id)#5"], "the end of a sentence is not in the link")
        XCTAssertEqual(parseMessageLink(messageLink("a/b?", 7)).first?.sessionId, "a/b?")
        // Refused: not base64url, padding, no seq, a decimal or negative seq, a payload that dsh does not write, not a string.
        for bad in ["dsh-session:!!#1", "dsh-session:ImFiYyI=#1", "dsh-session:ImFiYyI", "dsh-session:ImFiYyI#1.5", "dsh-session:ImFiYyI#-1",
                    "dsh-session:ImFiYyJ#1", "dsh-session:MQ#1", "dsh-session:ImFiYyI#12x", "@\(id)#1.5", "@\(id)#2#3", "@other-x#1"] {
            XCTAssertTrue(parseMessageLink(bad).isEmpty, bad)
        }
    }

    /// Open message: the shown row nearest before the message; assistant rows keep their seq too.
    @MainActor func testJumpTarget() {
        let c = Client()
        c.replaySnapshot([
            ["type": "user/message", "seq": 1, "data": ["content": "one", "source": ["kind": "user"]]],
            ["type": "assistant/message", "seq": 2, "data": ["message": ["content": [["type": "text", "text": "A1"]]]]],
            ["type": "user/message", "seq": 5, "data": ["content": "two", "source": ["kind": "user"]]],
            ["type": "assistant/message", "seq": 7, "data": ["message": ["content": [["type": "text", "text": "A2"]]]]],
        ])
        XCTAssertEqual(c.transcript.map(\.seq), [1, 2, 5, 7], "assistant rows have a seq")
        let rows = chatRows(c.transcript, open: [], running: false)
        XCTAssertEqual(jumpTarget(rows, seq: 5), c.transcript[2].id)
        XCTAssertEqual(jumpTarget(rows, seq: 6), c.transcript[2].id, "a row that does not show: the one before it")
        XCTAssertEqual(jumpTarget(rows, seq: 99), c.transcript[3].id)
        XCTAssertNil(jumpTarget(rows, seq: 0))
        // A chat that is not in the list: a notice and no jump. Else the chat opens and the jump waits for it.
        c.sessions = [Sess(["sessionId": "s1"])!]
        c.openMessage("gone", seq: 3)
        XCTAssertEqual(c.error, "This message is not in the chat any more."); XCTAssertNil(c.jump)
        c.openMessage("s1", seq: 3)
        XCTAssertEqual(c.current, "s1"); XCTAssertEqual(c.jump?.seq, 3)
    }

    /// Changes: This chat is mode=chat; Hide whitespace adds ws=1 to every mode, commit and diff calls too.
    func testChangesQuery() {
        XCTAssertEqual(changesQuery("s", mode: "chat", ws: false), ["sessionId": "s", "mode": "chat"])
        XCTAssertEqual(changesQuery("s", mode: "uncommitted", ws: true), ["sessionId": "s", "mode": "uncommitted", "ws": "1"])
        XCTAssertEqual(changesQuery("s", mode: "commit", ws: true, commit: "abc", path: "a.txt"),
                       ["sessionId": "s", "mode": "commit", "ws": "1", "commit": "abc", "path": "a.txt"])
    }

    /// Mark all as read: only the chats of that project with a green dot.
    func testUnreadIn() {
        XCTAssertEqual(unreadIn(["a", "b", "c"], finished: ["b", "c", "x"]), ["b", "c"])
        XCTAssertEqual(unreadIn(["a"], finished: []), [])
    }

    /// Redo: the same offer rule as index.js redoTarget; the offer goes once anything comes after the rollback.
    @MainActor func testRedoOffer() {
        let ev: [J] = [
            ["type": "user/message", "seq": 1, "data": ["content": "one", "source": ["kind": "user"]]],
            ["type": "assistant/message", "seq": 2, "data": ["message": ["content": [["type": "text", "text": "A1"]]]]],
        ]
        let marker: J = ["type": "user/message", "seq": 5, "sourceEventSeqs": [1], "data": ["content": [], "source": ["kind": rollbackSource]]]
        XCTAssertNil(redoTarget(ev)); XCTAssertEqual(redoTarget(ev + [marker]), 5)
        var rewind = marker; rewind["data"] = ["content": [], "source": ["kind": "dsh-rewind"]]
        XCTAssertNil(redoTarget(ev + [rewind]), "only Composer Plus rollbacks can be redone")
        var empty = marker; empty["sourceEventSeqs"] = [Int]()
        XCTAssertNil(redoTarget(ev + [empty]))
        let note: J = ["type": "user/message", "seq": 6, "data": ["content": "ctx", "source": ["kind": "runtime-context"]]]
        XCTAssertNil(redoTarget(ev + [marker, note]), "a later message ends the offer")
        XCTAssertEqual(redoShown(offer: 5, events: ev + [marker], running: false), 5)
        XCTAssertNil(redoShown(offer: 5, events: ev + [marker], running: true), "not while the chat runs")
        XCTAssertNil(redoShown(offer: 4, events: ev + [marker], running: false), "an older offer")
        XCTAssertNil(redoShown(offer: nil, events: ev + [marker], running: false))
        let c = Client()
        c.replaySnapshot(ev + [marker]); c.redoOffer = 5
        XCTAssertEqual(c.redoSeq, 5)
        c.apply(["type": "user/message", "seq": 6, "data": ["content": "three", "source": ["kind": "user"]]])
        XCTAssertNil(c.redoSeq, "a new message hides the offer")
    }

    /// Redo: one at a time. A second call while one runs sends nothing; an error opens the guard again.
    @MainActor func testRedoRunsOnce() async {
        let c = Client()
        let saved = c.pairings, savedFp = c.activeFp
        defer { c.pairings = saved; c.activeFp = savedFp }
        // Nothing listens on port 9: the first call waits for the network, then fails.
        c.pairings = [Pairing(host: "127.0.0.1", port: 9, fp: "r1", token: "t", deviceId: "d", name: "n", expiresAt: "")]
        c.activeFp = "r1"; c.current = "s"
        let first = Task { try await c.redo(5, files: false, overwrite: false) }
        for _ in 0..<1000 where !c.redoing { await Task.yield() }
        XCTAssertTrue(c.redoing, "the first redo runs")
        let second = try? await c.redo(5, files: true, overwrite: true)
        XCTAssertEqual(second ?? ["threw"], [], "a second redo while one runs does nothing")
        let failed: Bool
        do { _ = try await first.value; failed = false } catch { failed = true }
        XCTAssertTrue(failed, "no Mac on that port")
        XCTAssertFalse(c.redoing, "the guard opens again after an error")
    }

    @MainActor func testJustFinished() {
        XCTAssertEqual(sessionsPlaceholder(loaded: false, count: 0, state: .connecting), .loading)
        // no cached sessions without a live link, even when a list was loaded before
        XCTAssertEqual(sessionsPlaceholder(loaded: false, count: 0, state: .off), .offline)
        XCTAssertEqual(sessionsPlaceholder(loaded: true, count: 3, state: .reconnecting), .offline)
        XCTAssertEqual(sessionsPlaceholder(loaded: true, count: 3, state: .off), .offline)
        XCTAssertEqual(sessionsPlaceholder(loaded: true, count: 0, state: .connected), .empty)
        XCTAssertEqual(sessionsPlaceholder(loaded: false, count: 0, state: .connected), .loading)
        XCTAssertEqual(sessionsPlaceholder(loaded: true, count: 3, state: .connected), SessionsPlaceholder.none)
        let s = { (id: String, run: Bool) in Sess(["sessionId": id, "running": run])! }
        let old = [s("a", true), s("b", true), s("c", false), s("d", true)]
        let new = [s("a", false), s("b", true), s("c", false), s("d", false)]
        XCTAssertEqual(Client.justFinished(old: old, new: new, current: "d"), ["a"])
        // A whole turn between refreshes: idle both times but updatedAt moved; a rename alone doesn't count.
        let t = { (id: String, at: Int, title: String) in Sess(["sessionId": id, "updatedAt": at, "projections": ["values": ["title": title]]])! }
        XCTAssertEqual(Client.justFinished(old: [t("e", 1, "x"), t("f", 1, "x"), t("g", 1, "x")], new: [t("e", 2, "x"), t("f", 2, "y"), t("g", 1, "x")], current: nil), ["e"])
        // Cold start: the persisted snapshot round-trips through UserDefaults and Sess.init.
        let saved = UserDefaults(suiteName: "test")!
        saved.set(Client.snapshot([s("h", true), t("i", 1, "x")]), forKey: "seen")
        let back = (saved.array(forKey: "seen") as? [J] ?? []).compactMap(Sess.init)
        XCTAssertEqual(Client.justFinished(old: back, new: [s("h", false), t("i", 2, "x")], current: nil), ["h", "i"])
        // As in DSH desktop: a chat runs while its subagent runs, and it finishes when the subagent stops.
        let k = { (id: String, parent: String, run: Bool) in Sess(["sessionId": id, "parentSessionId": parent, "origin": "subagent", "running": run])! }
        let busy = [s("p", false), k("p1", "p", true)]
        XCTAssertTrue(isRunning(busy[0], busy)); XCTAssertFalse(isRunning(s("q", false), busy))
        XCTAssertEqual(Client.justFinished(old: busy, new: busy, current: nil), [], "still running: no Finished mark")
        let cold = (Client.snapshot(busy) as [J]).compactMap(Sess.init)
        XCTAssertEqual(Client.justFinished(old: cold, new: [s("p", false), k("p1", "p", false)], current: nil), ["p", "p1"])
    }
}

final class UserTextTests: XCTestCase {
    func testUserText() {
        XCTAssertTrue(userText(URLError(.timedOut)).contains("too long"))
        XCTAssertTrue(userText(URLError(.cannotConnectToHost)).contains("reach the Mac"))
        XCTAssertEqual(userText(Fail("x")), "x")
        XCTAssertTrue(gatewayText(429, "rate limited").contains("Too many"))
        XCTAssertTrue(gatewayText(403, "endpoint not allowed").contains("phone"))
        XCTAssertTrue(gatewayText(400, "body too large").contains("too large to send"))
        XCTAssertEqual(gatewayText(500, "HTTP 500"), "HTTP 500")
    }
}


/// Changes panel branch tree: the same lanes and branch order as `graphRows` / `treeBranches` in client.js
/// (test/changes-tree.test.mjs has the same cases).
final class BranchTreeTests: XCTestCase {
    private func c(_ sha: String, _ parents: [String] = [], _ refs: [GraphRef] = []) -> GraphCommit { GraphCommit(sha: sha, parents: parents, refs: refs) }
    func testLinear() {
        XCTAssertEqual(graphRows([c("A", ["B"]), c("B", ["C"]), c("C")]), [
            GraphRow(col: 0, top: [], bottom: [[0, 0, 0]], width: 1), GraphRow(col: 0, top: [[0, 0]], bottom: [[0, 0, 0]], width: 1),
            GraphRow(col: 0, top: [[0, 0]], bottom: [], width: 1)])
    }
    func testMergeAndFork() {
        let rows = graphRows([c("M", ["W", "S"]), c("S", ["B"]), c("W", ["B"]), c("B", ["I"]), c("I")])
        XCTAssertEqual(rows[0], GraphRow(col: 0, top: [], bottom: [[0, 0, 0], [0, 1, 1]], width: 2))
        XCTAssertEqual(rows[1], GraphRow(col: 1, top: [[0, 0], [1, 1]], bottom: [[0, 0, 0], [1, 1, 1]], width: 2))
        XCTAssertEqual(rows[2], GraphRow(col: 0, top: [[0, 0], [1, 1]], bottom: [[1, 0, 1], [0, 0, 0]], width: 2), "the fork point joins the lanes")
        XCTAssertEqual(rows[3], GraphRow(col: 0, top: [[0, 0]], bottom: [[0, 0, 0]], width: 1), "the free lane goes away")
        XCTAssertEqual(rows[4].bottom, [])
        XCTAssertEqual(graphRows([c("T1", ["B"]), c("T2", ["B"]), c("B")])[1], GraphRow(col: 1, top: [[0, 0]], bottom: [[0, 0, 0], [1, 0, 1]], width: 2))
    }
    func testReuseRootsAndOpenParent() {
        let rows = graphRows([c("M", ["A", "X"]), c("X", ["Y"]), c("A", ["Y"]), c("N", ["Z"]), c("Y"), c("R")])
        XCTAssertEqual(rows[3].col, 1, "N takes the free lane 1")
        XCTAssertEqual(rows[4].bottom, [[1, 1, 1]], "the lane to Z stays open under Y")
        XCTAssertEqual(rows[5], GraphRow(col: 0, top: [[1, 1]], bottom: [[1, 1, 1]], width: 2), "a second root uses lane 0")
    }
    func testBranchesAndParsing() {
        let list = treeBranches([
            c("1", [], [GraphRef(name: "origin/main", kind: "remote"), GraphRef(name: "v1", kind: "tag")]),
            c("2", [], [GraphRef(name: "zeta", kind: "local"), GraphRef(name: "main", kind: "local", current: true)]),
            c("3", [], [GraphRef(name: "HEAD", kind: "head"), GraphRef(name: "alpha", kind: "local")])])
        XCTAssertEqual(list.map { "\($0.ref.name)@\($0.sha)" }, ["main@2", "alpha@3", "zeta@2", "HEAD@3", "origin/main@1"])
        let parsed = GraphCommit(["sha": "abc", "parents": ["p"], "refs": [["name": "main", "kind": "local", "current": true], ["kind": "tag"]], "author": "Demo", "time": 5, "subject": "Init"])
        XCTAssertEqual(parsed?.refs, [GraphRef(name: "main", kind: "local", current: true)])
        XCTAssertEqual(parsed?.parents, ["p"]); XCTAssertEqual(parsed?.time, 5)
        XCTAssertNil(GraphCommit(["subject": "no id"]))
    }
}

/// App lock: when it asks, what each answer does, and that the Face ID sheet itself (inactive) never starts a loop.
@MainActor final class AppLockTests: XCTestCase {
    /// A fake Face ID: answers from a list and counts the asks; `hold` keeps one ask open until `release`.
    final class FakeAuth {
        var answers: [UnlockResult] = []; var asks = 0
        var hold: CheckedContinuation<Void, Never>?; var holding = false
        func callAsFunction(_ reason: String) async -> UnlockResult {
            asks += 1
            if holding { await withCheckedContinuation { hold = $0 } }
            return answers.isEmpty ? .ok : answers.removeFirst()
        }
        func release() { holding = false; hold?.resume(); hold = nil }
    }
    func defaults() -> UserDefaults { let d = UserDefaults(suiteName: "applock-\(UUID().uuidString)")!; return d }
    /// Lets the unlock task that a phase change started run to its end (or to a held Face ID ask).
    func settle() async { for _ in 0..<20 { await Task.yield() }; try? await Task.sleep(for: .milliseconds(30)); for _ in 0..<20 { await Task.yield() } }

    func testOffByDefaultNeverAsks() async {
        let auth = FakeAuth(), lock = AppLock(defaults: defaults(), authenticate: auth.callAsFunction)
        XCTAssertFalse(lock.on); XCTAssertFalse(lock.locked); XCTAssertFalse(lock.covered)
        lock.phase(.background); lock.phase(.active); await settle()
        XCTAssertEqual(auth.asks, 0); XCTAssertFalse(lock.covered)
    }
    func testSwitchOnAsksFirstAndColdStartIsLocked() async {
        let d = defaults(), auth = FakeAuth()
        auth.answers = [.cancelled]
        let lock = AppLock(defaults: d, authenticate: auth.callAsFunction)
        let refused = await lock.setOn(true)
        XCTAssertFalse(refused); XCTAssertFalse(lock.on, "cancelled: the lock stays off")
        auth.answers = [.ok]
        let accepted = await lock.setOn(true)
        XCTAssertTrue(accepted); XCTAssertTrue(lock.on); XCTAssertFalse(lock.locked, "switching it on does not lock the open app")
        XCTAssertEqual(auth.asks, 2)
        let cold = AppLock(defaults: d, authenticate: auth.callAsFunction)
        XCTAssertTrue(cold.on); XCTAssertTrue(cold.locked); XCTAssertTrue(cold.covered, "a new start opens locked")
    }
    func testBackgroundLocksActiveAsksOnce() async {
        let d = defaults(); d.set(true, forKey: AppLock.key)
        let auth = FakeAuth(); auth.holding = true
        let lock = AppLock(defaults: d, authenticate: auth.callAsFunction)
        lock.phase(.active); await settle()
        lock.phase(.active); await settle() // a second active while Face ID runs: no second ask
        XCTAssertEqual(auth.asks, 1); XCTAssertTrue(lock.locked)
        auth.release(); await settle()
        XCTAssertFalse(lock.locked); XCTAssertFalse(lock.covered)
        lock.phase(.inactive); XCTAssertTrue(lock.covered, "inactive covers the screen"); XCTAssertFalse(lock.locked, "but does not lock")
        lock.phase(.active); await settle()
        XCTAssertEqual(auth.asks, 1, "the Face ID sheet (inactive → active) never asks again"); XCTAssertFalse(lock.covered)
        lock.phase(.background); XCTAssertTrue(lock.locked)
        lock.phase(.active); await settle()
        XCTAssertEqual(auth.asks, 2, "back from the background: asks again"); XCTAssertFalse(lock.locked)
    }
    func testCancelKeepsTheLockAndUnlockRetries() async {
        let d = defaults(); d.set(true, forKey: AppLock.key)
        let auth = FakeAuth(); auth.answers = [.cancelled, .failed("Face ID did not match."), .ok]
        let lock = AppLock(defaults: d, authenticate: auth.callAsFunction)
        lock.phase(.active); await settle()
        XCTAssertTrue(lock.locked); XCTAssertTrue(lock.covered); XCTAssertNil(lock.message)
        // The Face ID sheet makes the app inactive; when the user cancels it, the app is active again. That must not ask
        // again (seen on the simulator: Cancel → a new Face ID sheet, again and again). The Unlock button asks.
        lock.phase(.inactive); lock.phase(.active); await settle()
        XCTAssertEqual(auth.asks, 1, "a cancel never starts a new ask by itself")
        await lock.unlock()
        XCTAssertTrue(lock.locked); XCTAssertEqual(lock.message, "Face ID did not match.")
        await lock.unlock()
        XCTAssertFalse(lock.locked); XCTAssertNil(lock.message)
    }
    func testNoPasscodeTurnsTheLockOff() async {
        let d = defaults(); d.set(true, forKey: AppLock.key)
        let auth = FakeAuth(); auth.answers = [.noPasscode]
        let lock = AppLock(defaults: d, authenticate: auth.callAsFunction)
        lock.phase(.active); await settle()
        XCTAssertFalse(lock.on); XCTAssertFalse(lock.locked); XCTAssertFalse(d.bool(forKey: AppLock.key), "the user is never locked out")
        XCTAssertNotNil(lock.message)
        auth.answers = [.noPasscode]
        let on = await lock.setOn(true)
        XCTAssertFalse(on); XCTAssertFalse(lock.on)
    }
    func testSwitchOffNeedsNoFaceID() async {
        let d = defaults(); d.set(true, forKey: AppLock.key)
        let auth = FakeAuth(); auth.answers = [.ok]
        let lock = AppLock(defaults: d, authenticate: auth.callAsFunction)
        lock.phase(.active); await settle()
        XCTAssertFalse(lock.asking); XCTAssertFalse(lock.locked)
        let off = await lock.setOn(false)
        XCTAssertTrue(off); XCTAssertFalse(lock.on); XCTAssertEqual(auth.asks, 1, "only the unlock asked")
        lock.phase(.background); lock.phase(.active); await settle()
        XCTAssertFalse(lock.locked); XCTAssertEqual(auth.asks, 1)
    }
}
