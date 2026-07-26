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
    /// Request id on dump/screenshot; echoed on the tree/shot reply (host API v2).
    let rid: Int?

    private enum CodingKeys: String, CodingKey {
        case t, props, ops, path, id, name, payload, value, rid
    }

    /// Hand-written so an explicit `"value": null` decodes as `.null` instead
    /// of the "key absent" nil that decodeIfPresent would produce: editing a
    /// node's value to null is a real edit (the Windows host applies it too).
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        t = try container.decode(String.self, forKey: .t)
        props = try container.decodeIfPresent([String: JSONValue].self, forKey: .props)
        ops = try container.decodeIfPresent([OpMsg].self, forKey: .ops)
        path = try container.decodeIfPresent(String.self, forKey: .path)
        id = try container.decodeIfPresent(Int.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        payload = try container.decodeIfPresent([String: JSONValue].self, forKey: .payload)
        rid = try container.decodeIfPresent(Int.self, forKey: .rid)
        if !container.contains(.value) {
            value = nil
        } else if try container.decodeNil(forKey: .value) {
            value = .null
        } else {
            value = try container.decode(JSONValue.self, forKey: .value)
        }
    }
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
