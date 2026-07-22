# natui wire protocol v1

The natui renderer (Node/React process) and a native host (SwiftUI on macOS, WinUI 3 on
Windows) communicate over **NDJSON**: one JSON object per line, UTF-8. Default transport is
the host process's stdin/stdout (JS spawns the host, writes to its stdin, reads its stdout).
A TCP transport (`--tcp <port>`) exists as a fallback for platforms where GUI-subsystem
stdio is unreliable. The host must never write anything to the protocol channel except
protocol messages; diagnostics go to stderr.

## Handshake

1. Host starts, prints `{"t":"ready","platform":"macos","protocol":1}`.
2. JS sends `{"t":"window","props":{...}}` to configure the main window, then commits.

## JS → Host messages

| message | shape | meaning |
|---|---|---|
| window | `{"t":"window","props":{"title":string,"width":number,"height":number,"minWidth"?,"minHeight"?}}` | Configure/show the main window. |
| commit | `{"t":"commit","ops":[Op,...]}` | Atomic batch of tree mutations, applied on the UI thread in order, then one render pass. |
| dump | `{"t":"dump"}` | Debug: host replies with a `tree` message describing its current node tree. |
| screenshot | `{"t":"screenshot","path":string}` | Debug: host renders its own window to a PNG at `path` and replies with a `shot` message (with an `error` field on failure, it must always reply). |
| emit | `{"t":"emit","id":n,"name":string,"payload"?:object}` | Debug: host synthesizes a user event on node `id` (sent back as a normal `event`, without optimistic local state or `seq`). |
| quit | `{"t":"quit"}` | Host exits cleanly. |

Debug messages (`dump`, `screenshot`, `emit`) exist for automated verification;
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
| shot | `{"t":"shot","path":string,"error"?:string}` | Reply to `screenshot`. |
| log | `{"t":"log","level":"info"\|"warn"\|"error","message":string}` | Host diagnostic (JS forwards to console). |

### Events

| kind | event name | payload |
|---|---|---|
| Button | `press` | `{}` |
| TextField | `change` | `{"value":string}` |
| TextField | `submit` | `{"value":string}` |
| Toggle | `change` | `{"value":boolean}` |
| Slider | `change` | `{"value":number}` |
| Picker | `change` | `{"value":string}` |

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
discrete change event, whether the node's committed `value` still differs from
the event's value, and if so synthesizes a corrective
`{"op":"update","id":n,"props":<committed>,"ack":<event seq>}`. Sliders
(continuous) are exempt.

## Node kinds and props

All coordinates/dimensions are logical points. Colors are `#RRGGBB` or `#RRGGBBAA` strings.

Common props on every kind (all optional):
`padding` (number | `{top,bottom,leading,trailing}`), `background` (color),
`cornerRadius` (number), `frame` (`{width,height,minWidth,maxWidth,minHeight,maxHeight}`
where `maxWidth`/`maxHeight` may be the string `"infinity"`), `opacity` (0..1),
`disabled` (bool), `hidden` (bool), `color` (foreground color), `help` (tooltip string).

| kind | props | SwiftUI | WinUI |
|---|---|---|---|
| VStack | `spacing`, `alignment` (`"leading"\|"center"\|"trailing"`) | VStack | StackPanel vertical |
| HStack | `spacing`, `alignment` (`"top"\|"center"\|"bottom"`) | HStack | StackPanel horizontal |
| ZStack | (none) | ZStack | Grid (overlay) |
| Text | `font` (`"largeTitle"\|"title"\|"title2"\|"title3"\|"headline"\|"body"\|"callout"\|"caption"`), `size`, `weight` (`"regular"\|"medium"\|"semibold"\|"bold"`), `italic`, `strikethrough`, `monospaced`, `lineLimit` | Text | TextBlock |
| Button | `variant` (`"automatic"\|"bordered"\|"prominent"\|"plain"\|"link"`), `role` (`"destructive"\|"cancel"`) | Button | Button (AccentButtonStyle for prominent) |
| TextField | `value`, `placeholder`, `secure` | TextField / SecureField | TextBox / PasswordBox |
| Toggle | `value` | Toggle (checkbox style) | CheckBox |
| Slider | `value`, `min`, `max`, `step` | Slider | Slider |
| Picker | `value`, `options: [{value,label}]`, `label` | Picker (menu) | ComboBox |
| ScrollView | `axis` (`"vertical"\|"horizontal"`) | ScrollView | ScrollViewer |
| List | (none) | List + ForEach | ListView |
| Image | `systemName`, `size` | Image(systemName:) SF Symbols | FontIcon (Segoe Fluent, mapped subset) |
| Spacer | `minLength` | Spacer | greedy filler |
| Divider | (none) | Divider | 1px Border |
| ProgressView | `value` (0..1, absent = indeterminate) | ProgressView | ProgressBar/ProgressRing |
| #text | (created via createText) | joined into parent Text/Button label | joined into parent |

Children of `Text`, `Button`, and `Toggle` that are `#text` nodes form the label by
concatenation; when text and element children are mixed, hosts render all children in
order with `#text` nodes as inline text.
Event handler props (`onPress`, `onChange`, `onSubmit`) exist only on the JS side; the
renderer strips functions before serializing. Hosts always emit events for interactive
controls; JS dispatches to the handler if one is registered.
