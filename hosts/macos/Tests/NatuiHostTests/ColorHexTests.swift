import SwiftUI
import XCTest

@testable import natui_host

/// `Color(hexString:)` must reject exactly what the Windows host rejects
/// (NodeMapper.BrushFromHex), so a malformed color never renders differently
/// on the two platforms.
final class ColorHexTests: XCTestCase {
    func testAcceptsSixAndEightDigitHex() {
        XCTAssertNotNil(Color(hexString: "#123456"))
        XCTAssertNotNil(Color(hexString: "123456"))
        XCTAssertNotNil(Color(hexString: "#AABBCCDD"))
        XCTAssertNotNil(Color(hexString: "  #ff0000  "))
    }

    func testRejectsMalformedHex() {
        XCTAssertNil(Color(hexString: nil))
        XCTAssertNil(Color(hexString: ""))
        XCTAssertNil(Color(hexString: "#"))
        // Scanner stopped at the first non-hex character and still succeeded.
        XCTAssertNil(Color(hexString: "#12345Z"))
        XCTAssertNil(Color(hexString: "#ZZZZZZ"))
        // Scanner accepted the "0x" prefix and read this as an 8-digit RGBA.
        XCTAssertNil(Color(hexString: "0x123456"))
        XCTAssertNil(Color(hexString: "#12345"))
        XCTAssertNil(Color(hexString: "#1234567"))
        XCTAssertNil(Color(hexString: "#123456789"))
    }
}
