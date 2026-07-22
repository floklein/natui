// swift-tools-version: 6.0
import PackageDescription

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
            linkerSettings: [
                // Embed Info.plist into the bare executable: gives the process
                // bundle identity so an unbundled binary gets Retina rendering
                // and proper keyboard focus (TextField) without an .app bundle.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/NatuiHost/Info.plist",
                ])
            ]
        )
    ]
)
