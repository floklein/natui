import CryptoKit
import Foundation

struct PackagedApp {
    let id: String
    let name: String
    let version: String
    let sourceName: String
    let source: String
}

private struct AppManifest: Decodable {
    let schemaVersion: Int
    let id: String
    let name: String
    let version: String
    let buildNumber: String
    let entry: String
    let entrySha256: String
    let protocolVersion: Int
    let minHostApi: Int
    let platform: String
    let architecture: String
}

enum AppBundleError: LocalizedError {
    case invalid(String)

    var errorDescription: String? {
        switch self {
        case .invalid(let message): message
        }
    }
}

/// Resolves and validates Contents/Resources/NatUI for a packaged .app.
/// Explicit --bundle launches are available only to the bare development host.
enum AppBundleLoader {
    private static let schemaVersion = 1
    private static let protocolVersion = 1
    private static let hostApiVersion = 2

    /// Nil means the process is a bare development host, not an .app bundle.
    static func loadIfPackaged() -> Result<PackagedApp, Error>? {
        guard Bundle.main.bundleURL.pathExtension == "app" else { return nil }

        do {
            guard let resources = Bundle.main.resourceURL else {
                throw AppBundleError.invalid("The application has no Resources directory.")
            }
            let appDirectory = resources.appendingPathComponent("NatUI", isDirectory: true)
            let manifestURL = appDirectory.appendingPathComponent("manifest.json")
            let data: Data
            do {
                data = try Data(contentsOf: manifestURL)
            } catch {
                throw AppBundleError.invalid(
                    "Cannot read app manifest at \(manifestURL.path): \(error.localizedDescription)"
                )
            }

            let manifest: AppManifest
            do {
                manifest = try JSONDecoder().decode(AppManifest.self, from: data)
            } catch {
                throw AppBundleError.invalid("Invalid app manifest: \(error.localizedDescription)")
            }

            guard manifest.schemaVersion == schemaVersion else {
                throw AppBundleError.invalid(
                    "Unsupported app bundle schema \(manifest.schemaVersion); "
                    + "this host supports schema \(schemaVersion)."
                )
            }
            guard manifest.protocolVersion == protocolVersion else {
                throw AppBundleError.invalid(
                    "App requires protocol \(manifest.protocolVersion); "
                    + "this host implements protocol \(protocolVersion)."
                )
            }
            guard manifest.minHostApi > 0, manifest.minHostApi <= hostApiVersion else {
                throw AppBundleError.invalid(
                    "App requires host API \(manifest.minHostApi); "
                    + "this host implements API \(hostApiVersion)."
                )
            }
            guard manifest.platform == "macos" else {
                throw AppBundleError.invalid(
                    "App bundle targets \(manifest.platform), not macos."
                )
            }
            guard manifest.architecture == currentArchitecture else {
                throw AppBundleError.invalid(
                    "App bundle targets \(manifest.architecture); "
                    + "this host is \(currentArchitecture)."
                )
            }
            guard !manifest.id.isEmpty, !manifest.name.isEmpty, !manifest.version.isEmpty else {
                throw AppBundleError.invalid("App manifest identity fields cannot be empty.")
            }
            guard !manifest.entry.isEmpty, !manifest.entry.hasPrefix("/") else {
                throw AppBundleError.invalid("App entry must be a non-empty relative path.")
            }

            guard let bundleIdentifier = Bundle.main.bundleIdentifier,
                  !bundleIdentifier.isEmpty else {
                throw AppBundleError.invalid("Info.plist has no application identifier.")
            }
            guard manifest.id == bundleIdentifier else {
                throw AppBundleError.invalid(
                    "App manifest identifier \(manifest.id) does not match "
                    + "Info.plist identifier \(bundleIdentifier)."
                )
            }
            guard let bundleVersion = Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String, !bundleVersion.isEmpty else {
                throw AppBundleError.invalid("Info.plist has no application version.")
            }
            guard manifest.version == bundleVersion else {
                throw AppBundleError.invalid(
                    "App manifest version \(manifest.version) does not match "
                    + "Info.plist version \(bundleVersion)."
                )
            }
            guard let bundleBuild = Bundle.main.object(
                forInfoDictionaryKey: "CFBundleVersion"
            ) as? String, !bundleBuild.isEmpty else {
                throw AppBundleError.invalid("Info.plist has no application build number.")
            }
            guard manifest.buildNumber == bundleBuild else {
                throw AppBundleError.invalid(
                    "App manifest build \(manifest.buildNumber) does not match "
                    + "Info.plist build \(bundleBuild)."
                )
            }

            let root = appDirectory.resolvingSymlinksInPath().standardizedFileURL
            let entry = root
                .appendingPathComponent(manifest.entry)
                .resolvingSymlinksInPath()
                .standardizedFileURL
            let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
            guard entry.path.hasPrefix(rootPath) else {
                throw AppBundleError.invalid("App entry leaves the NatUI resource directory.")
            }

            let script: Data
            do {
                script = try Data(contentsOf: entry)
            } catch {
                throw AppBundleError.invalid(
                    "Cannot read app entry at \(entry.path): \(error.localizedDescription)"
                )
            }
            let digest = SHA256.hash(data: script).map { String(format: "%02x", $0) }.joined()
            guard digest == manifest.entrySha256.lowercased() else {
                throw AppBundleError.invalid(
                    "App entry integrity check failed for \(entry.path)."
                )
            }
            guard let source = String(data: script, encoding: .utf8) else {
                throw AppBundleError.invalid("App entry \(entry.path) is not valid UTF-8.")
            }

            return .success(PackagedApp(
                id: manifest.id,
                name: manifest.name,
                version: manifest.version,
                sourceName: entry.path,
                source: source
            ))
        } catch {
            return .failure(error)
        }
    }

    private static var currentArchitecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x64"
        #else
        return "unsupported"
        #endif
    }
}
