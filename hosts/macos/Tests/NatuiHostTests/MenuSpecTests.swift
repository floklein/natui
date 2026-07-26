import AppKit
import Foundation
import XCTest

@testable import natui_host

private func decodedJSON(_ json: String) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
}

final class MenuSpecTests: XCTestCase {
    func testParseListReadsDividersItemsAndDefaults() throws {
        let items = MenuItemSpec.parseList(try decodedJSON("""
            [{"divider":true},
             {"id":"save","label":"Save","shortcut":"cmd+s","systemImage":"tray","disabled":true,"checked":false},
             {"id":"plain"},
             {"label":"no id"}]
            """))

        XCTAssertEqual(items.count, 3) // the id-less entry is dropped
        XCTAssertTrue(items[0].isDivider)
        XCTAssertEqual(items[1].id, "save")
        XCTAssertEqual(items[1].label, "Save")
        XCTAssertEqual(items[1].shortcut, "cmd+s")
        XCTAssertEqual(items[1].systemImage, "tray")
        XCTAssertTrue(items[1].disabled)
        XCTAssertFalse(try XCTUnwrap(items[1].checked))
        // label defaults to id; checked stays nil for non-checkable rows.
        XCTAssertEqual(items[2].label, "plain")
        XCTAssertNil(items[2].checked)
        XCTAssertFalse(items[2].disabled)
        XCTAssertNil(items[2].children)
    }

    func testParseKeepsNestedChildren() throws {
        let items = MenuItemSpec.parseList(try decodedJSON("""
            [{"id":"file","children":[{"id":"open"},{"divider":true}]}]
            """))
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].children?.count, 2)
        XCTAssertEqual(items[0].children?.first?.id, "open")
    }

    func testParseMenusRequiresAnId() throws {
        let menus = MenuSpec.parseMenus(try decodedJSON("""
            [{"id":"file","items":[{"id":"open"}]},{"label":"orphan"}]
            """))
        XCTAssertEqual(menus.count, 1)
        XCTAssertEqual(menus[0].label, "file") // label defaults to id
        XCTAssertEqual(menus[0].items.count, 1)
    }
}

final class ShortcutParserTests: XCTestCase {
    func testAppKitLowercasesTheKeyAndCollectsModifiers() throws {
        let (key, flags) = try XCTUnwrap(ShortcutParser.appKit("Cmd+Shift+S"))
        XCTAssertEqual(key, "s")
        XCTAssertEqual(flags, [.command, .shift])

        let (altKey, altFlags) = try XCTUnwrap(ShortcutParser.appKit("option+control+a"))
        XCTAssertEqual(altKey, "a")
        XCTAssertEqual(altFlags, [.option, .control])
    }

    func testAppKitRejectsEmptyInput() {
        XCTAssertNil(ShortcutParser.appKit(nil))
        XCTAssertNil(ShortcutParser.appKit(""))
    }

    func testSwiftUIOnlyAcceptsSingleCharacterKeys() throws {
        let shortcut = try XCTUnwrap(ShortcutParser.swiftUI("cmd+n"))
        XCTAssertEqual(shortcut.key.character, "n")
        XCTAssertEqual(shortcut.modifiers, .command)

        XCTAssertNil(ShortcutParser.swiftUI("cmd+enter"))
        XCTAssertNil(ShortcutParser.swiftUI(nil))
        XCTAssertNil(ShortcutParser.swiftUI(""))
    }

    func testCommandRolesMapToNativeSelectorsAndShortcuts() throws {
        XCTAssertNotNil(MenuCommandRole.selector(for: "copy"))
        XCTAssertNil(MenuCommandRole.selector(for: "destructive"))
        XCTAssertNil(MenuCommandRole.selector(for: nil))

        let (key, flags) = try XCTUnwrap(MenuCommandRole.defaultShortcut(for: "redo"))
        XCTAssertEqual(key, "z")
        XCTAssertEqual(flags, [.command, .shift])
        XCTAssertNil(MenuCommandRole.defaultShortcut(for: "about"))
    }
}
