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
        // office Wi‑Fi with a tailnet address must not say "same Wi‑Fi" only
        XCTAssertTrue(lostHint(onWiFi: true, hasTailnet: true).contains("Tailscale"))
        XCTAssertTrue(lostHint(onWiFi: false, hasTailnet: false).contains("Install Tailscale"))
        XCTAssertFalse(lostHint(onWiFi: true, hasTailnet: false).contains("Tailscale"))
        for ok in ["10.0.0.1", "172.16.4.2", "172.31.255.255", "192.168.1.44", "169.254.10.3"] { XCTAssertTrue(isLANv4(ok), ok) }
        for bad in ["8.8.8.8", "172.32.0.1", "192.169.0.1", "127.0.0.1", "0.0.0.0", "10.0.0", "10.0.0.256", "evil.com", "10.0.0.1.nip.io", "::1", " 10.0.0.1", "１0.0.0.1"] {
            XCTAssertFalse(isLANv4(bad), bad)
        }
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

    func testTailnet() {
        for ok in ["100.64.0.1", "100.127.255.255", "mac.tail1.ts.net"] { XCTAssertTrue(isTailnet(ok), ok) }
        for bad in ["100.63.0.1", "100.128.0.1", "MAC.ts.net", "evil.com", "ts.net.evil.com", ".ts.net", "8.8.8.8", "192.168.1.2", "a b.ts.net"] {
            XCTAssertFalse(isTailnet(bad), bad)
        }
        let old = #"{"host":"192.168.1.44","port":19390,"fp":"x","token":"t","deviceId":"d","name":"n","expiresAt":""}"#
        XCTAssertNotNil(try? JSONDecoder().decode(Pairing.self, from: Data(old.utf8)), "Keychain pairing from before Tailscale")
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
        let kid = Sess(["sessionId": "k", "parentSessionId": "p", "projections": ["values": ["title": "k"]]])!
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
        c.transcript = [Line(kind: .user, text: "new")]; c.running = true; c.model = "deepseek-v4"
        c.prependHistory([
            ["type": "turn/start", "seq": 3, "data": J()],
            ["type": "user/message", "seq": 4, "data": ["content": "old"]],
            ["type": "request/context", "seq": 5, "data": ["model": "other"]],
            ["type": "turn/end", "seq": 6, "data": J()],
        ])
        XCTAssertEqual(c.transcript.map(\.text), ["old", "new"])
        XCTAssertTrue(c.running)
        XCTAssertEqual(c.model, "deepseek-v4")
        let r = Client.pageRequest("s", through: 9, before: 3)["request"] as? J
        XCTAssertEqual(r?["beforeSeq"] as? Int, 3)
        XCTAssertEqual(r?["throughSeq"] as? Int, 9)
    }

    @MainActor func testReasoningSessionModelAndGroups() {
        let md = transcriptMarkdown([Line(kind: .user, text: "hi"), Line(kind: .tool, text: "ls"), Line(kind: .assistant, text: "hello")], title: "T")
        XCTAssertEqual(md, "# T\n\n**You:** hi\n\nhello")
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
        c.apply(["type": "request/context", "data": ["model": "m", "contextWindow": 2000]]); XCTAssertEqual(c.contextWindow, 2000)
        XCTAssertNil(a.permission)
        XCTAssertEqual(Sess(["sessionId": "p", "projections": ["values": ["permissions": ["currentValue": "read-only"]]]])?.permission, "read-only")
        c.sessions = [a, mk("b"), mk("c"), mk("d")]
        c.onWorkspace(["type": "baseline", "value": ["items": [["workspaceId": "w", "path": "/p/proj", "sessionIds": ["b"]]], "pinnedSessionIds": ["c"], "archivedSessionIds": ["d"]]])
        XCTAssertEqual(c.sessionGroups().map(\.title), ["Pinned", "proj", "Other", "Archived"])
        XCTAssertEqual(c.sessionGroups().map { $0.items.map(\.id) }, [["c"], ["b"], ["a"], ["d"]])
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
    }

    func testZoomClamp() {
        XCTAssertEqual(zoomClamp(0.3), 1)
        XCTAssertEqual(zoomClamp(2), 2)
        XCTAssertEqual(zoomClamp(9), 5)
    }
}

