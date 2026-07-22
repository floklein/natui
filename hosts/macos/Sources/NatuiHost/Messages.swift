import Foundation

/// One inbound NDJSON message from the JS renderer. A single struct with
/// optionals keeps decoding trivial; `t` discriminates.
struct InMessage: Decodable, Sendable {
    let t: String
    let props: [String: JSONValue]?
    let ops: [OpMsg]?
    // Debug messages (screenshot / emit / edit).
    let path: String?
    let id: Int?
    let name: String?
    let payload: [String: JSONValue]?
    let value: JSONValue?
}

struct OpMsg: Decodable, Sendable {
    let op: String
    let id: Int?
    let kind: String?
    let props: [String: JSONValue]?
    let text: String?
    let parent: Int?
    let child: Int?
    let before: Int?
    let ack: Int?
}
