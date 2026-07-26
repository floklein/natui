// swift-tools-version: 6.0
import Foundation
import PackageDescription

let embedDevelopmentInfoPlist =
    ProcessInfo.processInfo.environment["NATUI_PACKAGE_APP"] != "1"

let package = Package(
    name: "natui-host",
    platforms: [.macOS(.v14)], // @Observable requires macOS 14+
    targets: [
        .executableTarget(
            name: "natui-host",
            path: "Sources/NatuiHost",
            exclude: ["Info.plist"],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ],
            linkerSettings: embedDevelopmentInfoPlist ? [
                // Embed Info.plist into the bare executable: gives the process
                // bundle identity so an unbundled binary gets Retina rendering
                // and proper keyboard focus (TextField) without an .app bundle.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/NatuiHost/Info.plist",
                ])
            ] : []
        ),
        // Tests link the executable target directly (supported since Swift
        // 5.5) so the pure logic — Store ops, seq/ack, hex colors, menu and
        // shortcut parsing — stays in one module with the code that uses it.
        // The test bundle inherits the linker flags above; NATUI_PACKAGE_APP=1
        // turns them off if that ever gets in the way of `swift test`.
        .testTarget(
            name: "NatuiHostTests",
            dependencies: ["natui-host"],
            path: "Tests/NatuiHostTests",
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        )
    ]
)
