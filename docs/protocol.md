# natui wire protocol v1

The natui renderer (Node/React process) and a native host (SwiftUI on macOS, WinUI 3 on
Windows) communicate over **NDJSON**: one JSON object per line, UTF-8, over the host
process's stdin/stdout (JS spawns the host, writes to its stdin, reads its stdout). This is
the only transport. The host must never write anything to the protocol channel except
protocol messages; diagnostics go to stderr. Receivers must ignore message types they do
not recognize (forward compatibility).

## Handshake

1. Host starts, prints `{"t":"ready","platform":"macos","protocol":1}`.
2. JS validates the handshake before rendering anything: `protocol` must equal the
   renderer's protocol version and `platform` must be a known value matching the current
   OS. On a mismatch the renderer reports a startup error and terminates the host.
3. JS sends `{"t":"window","props":{...}}` to configure the main window, then commits.

## JS → Host messages

| message | shape | meaning |
|---|---|---|
| window | `{"t":"window","props":{"title":string,"width":number,"height":number,"minWidth"?,"minHeight"?}}` | Configure/show the main window. |
| commit | `{"t":"commit","ops":[Op,...]}` | Atomic batch of tree mutations, applied on the UI thread in order, then one render pass. |
| dump | `{"t":"dump"}` | Debug: host replies with a `tree` message describing its current node tree. |
| screenshot | `{"t":"screenshot","path":string}` | Debug: host renders its own window to a PNG at `path` and replies with a `shot` message (with an `error` field on failure, it must always reply). |
| emit | `{"t":"emit","id":n,"name":string,"payload"?:object}` | Debug: host synthesizes a user event on node `id` (sent back as a normal `event`, without optimistic local state or `seq`). |
| edit | `{"t":"edit","id":n,"value":any}` | Debug: host performs a **real optimistic user edit** on node `id`, through the same code path as typing/dragging: local `value` write, per-node seq increment, then a `change` event carrying `seq`. Unlike `emit`, this exercises the seq/ack machinery end to end. Only meaningful on controlled kinds (see the Controlled kinds table) with a value matching the kind's documented type (`null` is valid only where selection allows it); other targets are a probe error. |
| quit | `{"t":"quit"}` | Host exits cleanly. |

Debug messages (`dump`, `screenshot`, `emit`, `edit`) exist for automated verification;
hosts may compile them out of production builds.

### Ops

Node ids are positive integers assigned by JS. Id `0` is the window's root container.

| op | shape | meaning |
|---|---|---|
| create | `{"op":"create","id":n,"kind":Kind,"props":{...}}` | Create a detached node. |
| createText | `{"op":"createText","id":n,"text":string}` | Create a detached raw text node (kind `#text`). |
| append | `{"op":"append","parent":n,"child":n}` | Append child to end of parent's children. If the child already has a parent, it is moved. |
| insert | `{"op":"insert","parent":n,"child":n,"before":n}` | Insert child before sibling `before`. If the child already has a parent, it is moved. |
| remove | `{"op":"remove","parent":n,"child":n}` | Detach and destroy child and its whole subtree (ids are freed). |
| update | `{"op":"update","id":n,"props":{...}}` | Replace node's props entirely with the given props. |
| text | `{"op":"text","id":n,"text":string}` | Replace a text node's content. |
| clear | `{"op":"clear"}` | Remove and destroy all children of the root container. |

Hosts must apply an entire `commit` batch before updating the visible UI (single
transaction per commit) to avoid intermediate flicker.

## Host → JS messages

| message | shape | meaning |
|---|---|---|
| ready | `{"t":"ready","platform":"macos"\|"windows","protocol":1}` | Host is up. |
| event | `{"t":"event","id":n,"name":string,"payload":object,"seq"?:n}` | User interaction on node `id`. |
| window | `{"t":"window","name":"close"}` | The main window was closed by the user. |
| tree | `{"t":"tree","root":TreeNode}` | Reply to `dump`. `TreeNode = {"id":n,"kind":string,"props":{...},"text"?:string,"children":[TreeNode]}` |
| shot | `{"t":"shot","path":string,"error"?:string}` | Reply to `screenshot`. Hosts must **always** reply; on failure `error` describes why and no usable file is produced. JS rejects the pending screenshot promise when `error` is set, and times out if no reply arrives. |

### Events

| kind | event name | payload |
|---|---|---|
| Button | `press` | `{}` |
| TextField | `change` | `{"value":string}` |
| TextField | `submit` | `{"value":string}` |
| Toggle | `change` | `{"value":boolean}` |
| Slider | `change` | `{"value":number}` |
| Picker | `change` | `{"value":string}` |
| SearchField | `change` / `submit` | `{"value":string}` |
| DatePicker | `change` | `{"value":string}` (local ISO, see kind table) |
| Stepper | `change` | `{"value":number}` |
| TextEditor | `change` | `{"value":string}` |
| TabView | `change` | `{"value":string}` (selected Tab id) |
| Sheet / Alert / Popover | `change` | `{"value":boolean}` (presented) |
| Alert | `select` | `{"value":string}` (button id; emitted BEFORE the dismissal change) |
| SplitView | `change` | `{"value":"all"\|"detailOnly"}` |
| DisclosureGroup | `change` | `{"value":boolean}` (expanded) |
| List / Table | `change` | `{"value":string\|[string]\|null}` (selection) |
| Table | `sortChange` | `{"value":{"key":string,"order":"asc"\|"desc"}}` |
| MenuBar / Menu / ContextMenu | `select` | `{"value":string}` (item id) |
| Toolbar | `action` | `{"value":string}` (item id, incl. nested menu item ids) |
| Toolbar | `search` | `{"value":string}` (search item text, fire-and-forget) |
| Link | `press` | `{}` (informative; the host opens the URL itself) |

**`seq` rides `change` events only.** Every other event (`press`, `submit`,
`select`, `action`, `search`, `sortChange`) is fire-and-forget: no optimistic
local state, no `seq`, and the JS renderer never synthesizes corrective
updates for it.

Interactive hosts apply **optimistic local state** (e.g. a Toggle flips immediately,
a TextField shows the typed character) and then treat the next `update` op from JS as
authoritative. When applying `update`, hosts must skip assignment if the incoming
props are structurally equal to current props (prevents TextField cursor jumps and
feedback loops).

### Echo suppression (`seq` / `ack`)

Controlled inputs round-trip through JS, which lags user input. Without care, a fast
typist's TextField briefly reverts to a stale value when an old echo arrives. The
protocol solves this with per-node sequence numbers:

1. On every optimistic local edit, the host increments a per-node counter and sends it
   on the change event: `{"t":"event","id":7,"name":"change","payload":{"value":"ab"},"seq":2}`.
2. The JS renderer records the highest `seq` processed per node and attaches it to
   subsequent `update` ops for that node as `ack`.
3. When the host applies an `update` carrying `ack` on a node whose local counter is
   **greater** than `ack`, the user has edited since, so the host keeps its local `value`
   prop and applies only the remaining props. If `ack` equals the counter, the update is
   fully authoritative (this is how controlled transforms, e.g. uppercasing input,
   still win).

Updates with no `ack` are always fully authoritative.

**Controlled-value enforcement:** if React does *not* adopt a change (the handler
bails out, clamps to the previous state, or there is no handler), no commit
happens and no update op would be produced, and the host would keep its optimistic
value forever. The renderer therefore checks, after synchronously flushing each
change event, whether the node's committed `value` still differs from
the event's value, and if so synthesizes a corrective
`{"op":"update","id":n,"props":<committed>,"ack":<event seq>}`. This applies to
every controlled kind, including Slider: during a rapid drag the corrective
update's `ack` lags the host's counter, so the host ignores it and stays
responsive; the final event's correction (or adoption) is authoritative once the
drag settles. One consequence of enforcement: a handler that adopts a value
*asynchronously* (after the synchronous flush) is first corrected, then updated
when its state change eventually commits, exactly like React DOM's controlled
inputs.

### Controlled kinds

Every controlled kind has exactly ONE controlled prop, literally named `value`,
echoed exclusively via a `change` event carrying `seq`. The optimistic local
edit (what the host writes before JS confirms) means:

| kind | `value` type | optimistic edit means |
|---|---|---|
| TextField | string | the field shows the typed text |
| Toggle | boolean | the control flips |
| Slider | number | the thumb follows the drag |
| Picker | string | the new option shows selected |
| SearchField | string | the field shows the typed text |
| DatePicker | string (local ISO) | the picker shows the chosen date/time |
| Stepper | number | the value steps immediately |
| TextEditor | string | the editor shows the typed text |
| TabView | string (Tab id) | the clicked tab activates |
| Sheet | boolean | the sheet dismisses (host can only set false) |
| Alert | boolean | the alert dismisses (host can only set false) |
| Popover | boolean | the popover dismisses (host can only set false) |
| SplitView | `"all"`/`"detailOnly"` | the sidebar shows/hides |
| List (with `value`) | string / [string] / null | the clicked row highlights |
| Table (with `value`) | string / [string] / null | the clicked row highlights |
| DisclosureGroup | boolean | the group expands/collapses |

If the app does not adopt the edit, the standard corrective update snaps the
control back (see enforcement above). For presentation kinds this is how
"prevent dismissal" works: keep `value` true and the overlay re-presents.

### Presentation kinds (Sheet, Alert, Popover)

`value` is the controlled *presented* state. Hosts present/dismiss natively as
`value` changes; a user-initiated dismissal (close button, Esc, click-outside)
is an optimistic `change {value:false}` with `seq`. Hosts never set `value`
to true on their own.

Children of a Sheet (and a Popover's `PopoverContent` child) materialize
eagerly like all children, whether or not the overlay is presented; apps
wanting lazy content conditionally render it (`{open && <Content/>}`).

**Alert is fully data-driven** (`title`, `message`, `buttons`; children are
ignored). Pressing a button emits `select {value:buttonId}` FIRST and the
dismissal `change {value:false}` SECOND. This order is normative: change
events are flushed synchronously by JS, so select-first lets an app close
state in the select handler without the alert flickering back. Buttons with
`role:"cancel"` map to the platform cancel affordance (Esc), `"destructive"`
to destructive styling.

A Popover's ordinary children render inline as the anchor; its single
`PopoverContent` child is the presented content (first match wins, extras are
ignored with a stderr warning).

### Data-driven item trees (menus, toolbars)

Menus are JSON specs, not child nodes, because native menus (NSMenu,
MenuFlyout) are not view hierarchies. The shared recursive item shape:

```
MenuItemSpec = {"id":string,"label":string,"systemImage"?:string,
                "role"?:Role,"shortcut"?:string,"disabled"?:bool,
                "checked"?:bool,"children"?:[MenuItemSpec]}
             | {"divider":true}
Role = "destructive" | "cut" | "copy" | "paste" | "selectAll"
     | "undo" | "redo" | "quit" | "about"
```

Hosts emit `select` (or `action` for toolbar menus) with the item `id` for
leaf items only, and never for disabled items, dividers, or submenu parents.
`checked` renders a checkmark and is prop-driven: hosts do not flip it
optimistically. `shortcut` (`"cmd+n"`, `"cmd+shift+s"`; tokens `cmd`, `shift`,
`alt`, `ctrl` plus a key) maps to keyEquivalent / KeyboardAccelerator.

**Command roles are native**: every role except `destructive` maps to the
platform command (macOS: responder-chain selectors with nil target, which is
what makes Cmd+C/V work; Windows: app exit for `quit`, best-effort clipboard
APIs on the focused text box for edit roles) and NEVER emits `select`.
`destructive` only styles the item; it still emits.

Toolbar items are a flat typed list:

```
ToolbarItemSpec = {"type":"spacer"} | {"type":"flexibleSpace"}
  | {"type":"button","id","label"?,"systemImage"?,"disabled"?}
  | {"type":"toggle","id","label"?,"systemImage"?,"on"?,"disabled"?}
  | {"type":"menu","id","label"?,"systemImage"?,"items":[MenuItemSpec],"disabled"?}
  | {"type":"search","id","placeholder"?}
```

Buttons and toggles emit `action {value:id}`; a toggle's pressed state is the
`on` field, prop-driven (echo it from the action handler), never optimistic.
Menu items emit `action` with the chosen leaf's id. Search items are
uncontrolled on the wire: text changes emit fire-and-forget
`search {value}` (Enter folds into the same event) and the text is never
echoed back into `items` (avoids focus races).

### Selection (List, Table)

A List becomes selectable when its props contain a `value` key (even null).
Rows identify themselves with the `tag` common prop; selection round-trips as
tags: a string or null in `selectionMode:"single"` (the default), a SORTED
array of strings in `"multiple"`. Deselection is a real optimistic edit:
`change {value:null}` in single mode; in multiple mode the empty selection is
spelled `change {value:[]}` (never null). Rows without a `tag` should not be
used in selectable lists; hosts render no selection for values that match no
row and never synthesize events for rows that no longer exist. Table selection
works the same way over row ids from the `rows` spec.

Table sorting is request-semantics: the host never reorders rows. A header
click emits `sortChange {value:{key,order}}` (no seq, no local state); the
app re-sorts `rows` and echoes the new `sort` prop, which is what moves the
native sort indicator.

### Root-attached kinds (MenuBar, Toolbar)

MenuBar and Toolbar are ordinary protocol nodes (they appear in `dump`, they
receive events by node id) but render no in-window content: hosts hoist the
FIRST root-level MenuBar to the application menu bar (NSApp.mainMenu / a
WinUI MenuBar row) and the first root-level Toolbar to the window toolbar
(NSToolbar unified style / a CommandBar row). Anywhere else in the tree they
render nothing and are ignored (hosts may warn on stderr). Hosts must diff their
props (skip rebuilds when structurally equal) so an open menu is not torn
down by an unrelated commit; macOS additionally prepends the standard app
menu (About/Quit) before the spec'd menus.

## Node kinds and props

All coordinates/dimensions are logical points. Colors are `#RRGGBB` or `#RRGGBBAA` strings.

Common props on every kind (all optional):
`padding` (number | `{top,bottom,leading,trailing}`), `background` (color),
`cornerRadius` (number), `frame` (`{width,height,minWidth,maxWidth,minHeight,maxHeight}`
where `maxWidth`/`maxHeight` may be the string `"infinity"`), `opacity` (0..1),
`disabled` (bool), `hidden` (bool), `color` (foreground color), `help` (tooltip string),
`tag` (string; row identity for selectable List rows, see Selection),
`badge` (string | number; rendered on Tab items and List rows),
`accessibilityLabel` (assistive-tech label), `accessibilityHint` (assistive-tech hint),
`accessibilityIdentifier` (stable id for UI automation; AX identifier on macOS,
AutomationId on Windows).

Prop values are restricted to JSON: strings, finite numbers, booleans, null, and
arrays/plain objects of the same. The renderer validates every prop before
serialization; anything else (BigInt, non-finite numbers, circular structures,
class instances, nested functions) is reported with its node kind and prop path
and omitted, never sent.

| kind | props | SwiftUI | WinUI |
|---|---|---|---|
| VStack | `spacing`, `alignment` (`"leading"\|"center"\|"trailing"`) | VStack | StackPanel vertical |
| HStack | `spacing`, `alignment` (`"top"\|"center"\|"bottom"`) | HStack | StackPanel horizontal |
| ZStack | (none) | ZStack | Grid (overlay) |
| Text | `font` (`"largeTitle"\|"title"\|"title2"\|"title3"\|"headline"\|"body"\|"callout"\|"caption"`), `size`, `weight` (`"regular"\|"medium"\|"semibold"\|"bold"`), `italic`, `strikethrough`, `monospaced`, `lineLimit` | Text | TextBlock |
| Button | `variant` (`"automatic"\|"bordered"\|"prominent"\|"plain"\|"link"`), `role` (`"destructive"\|"cancel"`) | Button | Button (AccentButtonStyle for prominent) |
| TextField | `value`, `placeholder`, `secure` | TextField / SecureField | TextBox / PasswordBox |
| Toggle | `value`, `style` (`"automatic"\|"checkbox"\|"switch"`) | Toggle (.checkbox/.switch) | CheckBox / ToggleSwitch |
| Slider | `value`, `min`, `max`, `step` | Slider | Slider |
| Picker | `value`, `options: [{value,label}]`, `label`, `style` (`"automatic"\|"menu"\|"segmented"\|"radioGroup"`) | Picker (.menu/.segmented/.radioGroup) | ComboBox / SelectorBar / RadioButtons |
| ScrollView | `axis` (`"vertical"\|"horizontal"`) | ScrollView | ScrollViewer |
| List | `value`?, `selectionMode` (`"single"\|"multiple"`), `style` (`"automatic"\|"sidebar"`) | List + ForEach (+selection, .sidebar) | ListView |
| Image | `systemName`, `size` | Image(systemName:) SF Symbols | FontIcon (Segoe Fluent, mapped subset) |
| Spacer | `minLength` | Spacer | greedy filler |
| Divider | (none) | Divider | 1px Border |
| ProgressView | `value` (0..1, absent = indeterminate) | ProgressView | ProgressBar/ProgressRing |
| #text | (created via createText) | joined into parent Text/Button label | joined into parent |
| MenuBar | `menus: [{id,label,items:[MenuItemSpec]}]` | NSApp.mainMenu (NSMenu) | MenuBar row |
| Toolbar | `items: [ToolbarItemSpec]` | NSToolbar (unified) | CommandBar row |
| Menu | `items: [MenuItemSpec]`, `systemImage`; children = label | Menu | DropDownButton + MenuFlyout |
| ContextMenu | `items: [MenuItemSpec]`; children = right-click target | .contextMenu | UIElement.ContextFlyout |
| SplitView | `value`? (`"all"\|"detailOnly"`), `sidebarWidth`, `minSidebarWidth`, `maxSidebarWidth`; slot children Sidebar/Detail | NavigationSplitView | SplitView (Inline) |
| Sidebar | (container; SplitView sidebar slot) | sidebar column | SplitView.Pane |
| Detail | (container; SplitView detail slot) | detail column | SplitView.Content |
| TabView | `value` (selected Tab id); children = Tab | TabView + .tabItem/.tag | TabView (no add/reorder) |
| Tab | `id`, `title`, `systemImage` (+ `badge` common prop) | .tabItem (plain Text; no icon/badge on macOS) | TabViewItem |
| Sheet | `value` (presented); children = content | .sheet on a hidden anchor | in-tree overlay (scrim + card) |
| Alert | `value`, `title`, `message`, `buttons: [{id,label,role?}]` | .alert on a hidden anchor | ContentDialog |
| Popover | `value`, `arrowEdge` (`"top"\|"bottom"\|"leading"\|"trailing"`); children = anchor + one PopoverContent | .popover on the anchor | Flyout |
| PopoverContent | (container; Popover content slot) | popover content | Flyout content |
| Section | `header`, `footer` | Section (in List) / labeled group | header/footer TextBlocks |
| Table | `columns: [{key,label,width?,sortable?}]`, `rows: [{id,cells}]`, `value`?, `selectionMode`, `sort: {key,order}` | Table (TableColumnForEach, macOS 14.4+; List fallback below) | header Grid + ListView rows |
| DisclosureGroup | `label`, `value` (expanded) | DisclosureGroup | Expander |
| SearchField | `value`, `placeholder` | NSSearchField (NSViewRepresentable) | AutoSuggestBox |
| DatePicker | `value` (local ISO: `YYYY-MM-DD` / `HH:mm` / `YYYY-MM-DDTHH:mm`), `displayedComponents` (`"date"\|"time"\|"dateTime"`) | DatePicker | CalendarDatePicker (date part) |
| Stepper | `value`, `min`, `max`, `step` | Stepper | NumberBox (inline spin) |
| TextEditor | `value` | TextEditor | TextBox (AcceptsReturn) |
| Link | `url`; children = label | Link (+ press via OpenURLAction) | HyperlinkButton + Launcher |
| Label | `systemImage`; children = title | Label | FontIcon + TextBlock |

DatePicker `value` is a LOCAL wall-clock ISO string without a zone; hosts
parse and re-serialize it with fixed-format formatters so an unchanged
round-trip is byte-identical (the props-equality guard then settles).
`displayedComponents` picks the shape: `"date"` → `YYYY-MM-DD`, `"time"` →
`HH:mm`, `"dateTime"` → `YYYY-MM-DDTHH:mm`.

On macOS 14.0–14.3 the Table kind falls back to a header row + List (
`TableColumnForEach` requires 14.4); the wire contract is identical.

SplitView is always controlled: hosts install the sidebar-visibility binding
whether or not `value` is present, so omitting `value` means user collapses
still emit change events but revert on the app's next update of the node.
There is no host-local visibility state.

Children of `Text`, `Button`, and `Toggle` that are `#text` nodes form the label by
concatenation; when text and element children are mixed, hosts render all children in
order with `#text` nodes as inline text.
Event handler props (`onPress`, `onChange`, `onSubmit`) exist only on the JS side; the
renderer strips functions before serializing. Hosts always emit events for interactive
controls; JS dispatches to the handler if one is registered.
