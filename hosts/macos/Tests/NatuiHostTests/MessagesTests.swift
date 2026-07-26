import Foundation
import XCTest

@testable import natui_host

private func message(_ json: String) throws -> InMessage {
    try JSONDecoder().decode(InMessage.self, from: Data(json.utf8))
}

final class MessagesTests: XCTestCase {
    /// An explicit `"value": null` is a real edit (the Windows host applies
    /// it); only an ABSENT key means "no value".
    func testExplicitNullValueDecodesAsNull() throws {
        let explicit = try message(#"{"t":"edit","id":7,"value":null}"#)
        let value = try XCTUnwrap(explicit.value)
        XCTAssertEqual(value, JSONValue.null)

        let absent = try message(#"{"t":"edit","id":7}"#)
        XCTAssertNil(absent.value)
    }

    func testDecodesTheOtherValueShapes() throws {
        let string = try XCTUnwrap(message(#"{"t":"edit","value":"hi"}"#).value)
        XCTAssertEqual(string, JSONValue.string("hi"))
        let number = try XCTUnwrap(message(#"{"t":"edit","value":3}"#).value)
        XCTAssertEqual(number, JSONValue.number(3))
        let bool = try XCTUnwrap(message(#"{"t":"edit","value":true}"#).value)
        XCTAssertEqual(bool, JSONValue.bool(true))
    }

    func testDecodesCommitOpsAndWindowProps() throws {
        let commit = try message(#"{"t":"commit","ops":[{"op":"create","id":1,"kind":"Text"}]}"#)
        XCTAssertEqual(commit.t, "commit")
        XCTAssertEqual(commit.ops?.count, 1)
        XCTAssertEqual(commit.ops?.first?.kind, "Text")

        let window = try message(#"{"t":"window","props":{"title":"Demo","width":320}}"#)
        XCTAssertEqual(window.props?["title"]?.stringValue, "Demo")
        XCTAssertEqual(window.props?["width"]?.doubleValue, 320)
    }
}
