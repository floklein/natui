import SwiftUI

/// Data-driven Table: columns/rows come from JSON specs, selection is the
/// standard controlled `value` (over row ids), and sorting is REQUEST
/// semantics: the host never reorders rows; a header click emits sortChange
/// and the app re-sorts `rows` and echoes `sort` (which moves the native
/// sort indicator via the sortOrder binding's getter).
struct TableNodeView: View {
    let node: Node

    var body: some View {
        if #available(macOS 14.4, *) {
            // TableColumnForEach (dynamic column count) is 14.4+.
            DynamicTableView(node: node)
        } else {
            // Platform floor stays .v14: a header row + List renders the
            // same wire contract without dynamic native columns.
            FallbackTableView(node: node)
        }
    }
}

// MARK: - Spec parsing

struct TableColumnSpec {
    let key: String
    let label: String
    let width: CGFloat?
    let sortable: Bool

    static func parseColumns(_ json: JSONValue?) -> [TableColumnSpec] {
        (json?.arrayValue ?? []).compactMap { entry in
            guard let obj = entry.objectValue, let key = obj["key"]?.stringValue else { return nil }
            return TableColumnSpec(
                key: key,
                label: obj["label"]?.stringValue ?? key,
                width: obj["width"]?.cgFloatValue,
                sortable: obj["sortable"]?.boolValue ?? true
            )
        }
    }
}

struct TableRowItem: Identifiable, Hashable {
    let id: String
    let cells: [String: String]

    static func parseRows(_ json: JSONValue?) -> [TableRowItem] {
        (json?.arrayValue ?? []).compactMap { entry in
            guard let obj = entry.objectValue, let id = obj["id"]?.stringValue else { return nil }
            let cells = (obj["cells"]?.objectValue ?? [:]).compactMapValues(\.stringValue)
            return TableRowItem(id: id, cells: cells)
        }
    }
}

/// The comparator type behind the sortOrder binding. Its compare result is
/// never used to actually order anything (the host never sorts); it exists
/// so SwiftUI's header-click machinery has a SortComparator to flip.
struct CellComparator: SortComparator, Hashable {
    var key: String
    var order: SortOrder = .forward

    func compare(_ lhs: TableRowItem, _ rhs: TableRowItem) -> ComparisonResult {
        let l = lhs.cells[key] ?? ""
        let r = rhs.cells[key] ?? ""
        let result: ComparisonResult = l == r ? .orderedSame : (l < r ? .orderedAscending : .orderedDescending)
        switch (order, result) {
        case (.reverse, .orderedAscending): return .orderedDescending
        case (.reverse, .orderedDescending): return .orderedAscending
        default: return result
        }
    }
}

// MARK: - Shared bindings

extension Node {
    fileprivate var tableColumns: [TableColumnSpec] { TableColumnSpec.parseColumns(props["columns"]) }
    fileprivate var tableRows: [TableRowItem] { TableRowItem.parseRows(props["rows"]) }

    fileprivate var sortOrderBinding: Binding<[CellComparator]> {
        Binding(
            get: {
                guard let sort = self.props["sort"]?.objectValue,
                      let key = sort["key"]?.stringValue else { return [] }
                let order: SortOrder = sort["order"]?.stringValue == "desc" ? .reverse : .forward
                return [CellComparator(key: key, order: order)]
            },
            set: { comparators in
                guard let first = comparators.first else { return }
                // Request semantics: emit only (no seq, no local state); the
                // app's echoed `sort` prop is what moves the indicator.
                // Non-sortable columns are silent.
                let column = self.tableColumns.first { $0.key == first.key }
                guard column?.sortable ?? false else { return }
                Emitter.event(self.id, "sortChange", payload: [
                    "value": [
                        "key": first.key,
                        "order": first.order == .reverse ? "desc" : "asc",
                    ],
                ])
            }
        )
    }
}

// MARK: - macOS 14.4+ dynamic-column table

@available(macOS 14.4, *)
private struct DynamicTableView: View {
    let node: Node

    var body: some View {
        let columns = node.tableColumns
        let rows = node.tableRows
        if node.props["value"] == nil {
            Table(of: TableRowItem.self, sortOrder: node.sortOrderBinding) {
                TableColumnForEach(columns, id: \.key) { column in
                    TableColumn(column.label, sortUsing: CellComparator(key: column.key)) { row in
                        Text(row.cells[column.key] ?? "")
                    }
                    .width(column.width)
                }
            } rows: {
                ForEach(rows) { TableRow($0) }
            }
        } else if node.str("selectionMode") == "multiple" {
            Table(of: TableRowItem.self, selection: node.stringSetBinding, sortOrder: node.sortOrderBinding) {
                TableColumnForEach(columns, id: \.key) { column in
                    TableColumn(column.label, sortUsing: CellComparator(key: column.key)) { row in
                        Text(row.cells[column.key] ?? "")
                    }
                    .width(column.width)
                }
            } rows: {
                ForEach(rows) { TableRow($0) }
            }
        } else {
            Table(of: TableRowItem.self, selection: node.optionalStringBinding, sortOrder: node.sortOrderBinding) {
                TableColumnForEach(columns, id: \.key) { column in
                    TableColumn(column.label, sortUsing: CellComparator(key: column.key)) { row in
                        Text(row.cells[column.key] ?? "")
                    }
                    .width(column.width)
                }
            } rows: {
                ForEach(rows) { TableRow($0) }
            }
        }
    }
}

// MARK: - macOS 14.0–14.3 fallback (header row + List)

private struct FallbackTableView: View {
    let node: Node

    var body: some View {
        let columns = node.tableColumns
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                ForEach(columns, id: \.key) { column in
                    Button {
                        headerClick(column)
                    } label: {
                        HStack(spacing: 2) {
                            Text(column.label).fontWeight(.semibold)
                            if let sort = node.props["sort"]?.objectValue,
                               sort["key"]?.stringValue == column.key {
                                Image(systemName: sort["order"]?.stringValue == "desc"
                                    ? "chevron.down" : "chevron.up")
                                    .font(.system(size: 9))
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .frame(width: column.width, alignment: .leading)
                    .frame(maxWidth: column.width == nil ? .infinity : nil, alignment: .leading)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            Divider()
            rowList(columns: columns)
        }
    }

    @ViewBuilder
    private func rowList(columns: [TableColumnSpec]) -> some View {
        if node.props["value"] == nil {
            List { rowsContent(columns: columns) }
        } else if node.str("selectionMode") == "multiple" {
            List(selection: node.stringSetBinding) { rowsContent(columns: columns) }
        } else {
            List(selection: node.optionalStringBinding) { rowsContent(columns: columns) }
        }
    }

    private func rowsContent(columns: [TableColumnSpec]) -> some View {
        ForEach(node.tableRows) { row in
            HStack(spacing: 8) {
                ForEach(columns, id: \.key) { column in
                    Text(row.cells[column.key] ?? "")
                        .frame(width: column.width, alignment: .leading)
                        .frame(maxWidth: column.width == nil ? .infinity : nil, alignment: .leading)
                }
            }
            .tag(row.id)
        }
    }

    private func headerClick(_ column: TableColumnSpec) {
        guard column.sortable else { return }
        let sort = node.props["sort"]?.objectValue
        let order = (sort?["key"]?.stringValue == column.key && sort?["order"]?.stringValue == "asc")
            ? "desc" : "asc"
        Emitter.event(node.id, "sortChange", payload: [
            "value": ["key": column.key, "order": order],
        ])
    }
}
