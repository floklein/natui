import AppKit
import Foundation
import XCTest

@testable import natui_host

private func ops(_ json: String) throws -> [OpMsg] {
    try JSONDecoder().decode([OpMsg].self, from: Data(json.utf8))
}

final class StoreTests: XCTestCase {
    /// `Store.apply` ends in ChromeSync, which assigns `NSApp.mainMenu`;
    /// touching NSApplication.shared first creates that instance.
    @MainActor
    private func makeStore() -> Store {
        _ = NSApplication.shared
        return Store()
    }

    @MainActor
    func testRemoveDropsTheSubtreeFromByIdAndParentOf() throws {
        let store = makeStore()
        store.apply(ops: try ops("""
            [{"op":"create","id":1,"kind":"VStack"},
             {"op":"createText","id":2,"text":"hi"},
             {"op":"append","parent":1,"child":2},
             {"op":"append","parent":0,"child":1}]
            """))
        XCTAssertEqual(store.rootChildren.map(\.id), [1])
        XCTAssertEqual(store.parentOf[2], 1)

        store.apply(ops: try ops(#"[{"op":"remove","child":1}]"#))
        XCTAssertTrue(store.rootChildren.isEmpty)
        XCTAssertNil(store.byId[1])
        XCTAssertNil(store.byId[2])
        XCTAssertNil(store.parentOf[1])
        XCTAssertNil(store.parentOf[2])
    }

    @MainActor
    func testClearEmptiesTheWholeStore() throws {
        let store = makeStore()
        store.apply(ops: try ops("""
            [{"op":"create","id":1,"kind":"VStack"},
             {"op":"create","id":2,"kind":"Text"},
             {"op":"append","parent":1,"child":2},
             {"op":"append","parent":0,"child":1}]
            """))
        store.apply(ops: try ops(#"[{"op":"clear"}]"#))
        XCTAssertTrue(store.rootChildren.isEmpty)
        XCTAssertTrue(store.byId.isEmpty)
        XCTAssertTrue(store.parentOf.isEmpty)
    }

    /// Echo suppression (docs/protocol.md): an update whose ack predates the
    /// user's last edit keeps the local value; ack == lastSentSeq and a
    /// missing ack are both authoritative.
    @MainActor
    func testUpdateEchoSuppressionFollowsSeqAck() throws {
        let store = makeStore()
        store.apply(ops: try ops("""
            [{"op":"create","id":1,"kind":"TextField","props":{"value":"a"}},
             {"op":"append","parent":0,"child":1}]
            """))
        let node = try XCTUnwrap(store.byId[1])

        node.userEdit(.string("local"))
        XCTAssertEqual(node.lastSentSeq, 1)

        store.apply(ops: try ops(#"[{"op":"update","id":1,"props":{"value":"stale"},"ack":0}]"#))
        XCTAssertEqual(node.str("value"), "local")

        store.apply(ops: try ops(#"[{"op":"update","id":1,"props":{"value":"echoed"},"ack":1}]"#))
        XCTAssertEqual(node.str("value"), "echoed")

        store.apply(ops: try ops(#"[{"op":"update","id":1,"props":{"value":"server"}}]"#))
        XCTAssertEqual(node.str("value"), "server")
    }

    @MainActor
    func testUserEditIsANoOpWhenTheValueIsUnchanged() throws {
        let store = makeStore()
        store.apply(ops: try ops(#"[{"op":"create","id":1,"kind":"TextField","props":{"value":"a"}}]"#))
        let node = try XCTUnwrap(store.byId[1])

        node.userEdit(.string("a"))
        XCTAssertEqual(node.lastSentSeq, 0)

        node.userEdit(.string("b"))
        XCTAssertEqual(node.lastSentSeq, 1)
    }
}
