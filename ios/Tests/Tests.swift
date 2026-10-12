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
        for ok in ["10.0.0.1", "172.16.4.2", "172.31.255.255", "192.168.1.44", "169.254.10.3"] { XCTAssertTrue(isLANv4(ok), ok) }
        for bad in ["8.8.8.8", "172.32.0.1", "192.169.0.1", "127.0.0.1", "0.0.0.0", "10.0.0", "10.0.0.256", "evil.com", "10.0.0.1.nip.io", "::1", " 10.0.0.1", "１0.0.0.1"] {
            XCTAssertFalse(isLANv4(bad), bad)
        }
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
    }

    func testMarkdownBlocks() {
        let b = mdBlocks("Intro **bold**\n```swift\nlet x = 1\n```\nAfter")
        XCTAssertEqual(b.map(\.code), [false, true, false])
        XCTAssertEqual(b[1].text, "let x = 1")
        XCTAssertEqual(b[2].text, "After")
        XCTAssertEqual(mdBlocks("plain").count, 1)
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
}

