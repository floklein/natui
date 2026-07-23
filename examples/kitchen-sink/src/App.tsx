import { useMemo, useState } from 'react';
// 'natui/components' is engine-neutral (no Node built-ins), so this file
// works both under Node (main.tsx) and inside embedded JSC.
import {
  Alert,
  Button,
  ContextMenu,
  DatePicker,
  Detail,
  DisclosureGroup,
  Divider,
  HStack,
  Label,
  Link,
  List,
  MenuBar,
  Picker,
  Popover,
  PopoverContent,
  ProgressView,
  ScrollView,
  SearchField,
  Section,
  Sheet,
  Sidebar,
  Slider,
  Spacer,
  SplitView,
  Stepper,
  Tab,
  TabView,
  Table,
  Text,
  TextEditor,
  TextField,
  Toggle,
  Toolbar,
  VStack,
  type MenuSpec,
  type SortDescriptor,
  type TableRowSpec,
  type ToolbarItemSpec,
} from 'natui/components';

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface Item {
  id: string;
  name: string;
  status: string;
  qty: number;
}

const PROJECTS = [
  { id: 'proj-1', name: 'Launch prep', icon: 'folder' },
  { id: 'proj-2', name: 'Rigging', icon: 'wrench.and.screwdriver' },
];

const ARCHIVE = [{ id: 'proj-3', name: 'Old hull', icon: 'archivebox' }];

const INITIAL_ITEMS: Record<string, Item[]> = {
  'proj-1': [
    { id: 'r1', name: 'bolt', status: 'active', qty: 9 },
    { id: 'r2', name: 'anchor', status: 'done', qty: 3 },
    { id: 'r3', name: 'clamp', status: 'active', qty: 5 },
  ],
  'proj-2': [{ id: 'r4', name: 'winch', status: 'blocked', qty: 2 }],
  'proj-3': [],
};

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status', width: 90 },
  { key: 'qty', label: 'Qty', width: 60 },
];

const STATUS_OPTIONS = [
  { value: 'planning', label: 'Planning' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
];

const SIZE_OPTIONS = [
  { value: 's', label: 'Small' },
  { value: 'm', label: 'Medium' },
  { value: 'l', label: 'Large' },
];

const ASSIGNEE_OPTIONS = [
  { value: 'alice', label: 'Alice' },
  { value: 'bob', label: 'Bob' },
  { value: 'carol', label: 'Carol' },
];

let nextItemId = 1;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  // Navigation and chrome.
  const [project, setProject] = useState<string | null>('proj-1');
  const [tab, setTab] = useState('overview');
  const [sidebar, setSidebar] = useState<'all' | 'detailOnly'>('all');
  const [favorite, setFavorite] = useState(false);
  const [search, setSearch] = useState('');
  const [lastAction, setLastAction] = useState('none');

  // Data tab.
  const [items, setItems] = useState(INITIAL_ITEMS);
  const [sort, setSort] = useState<SortDescriptor>({ key: 'name', order: 'asc' });
  const [rowSelection, setRowSelection] = useState<string | string[] | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);

  // Overlays.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [alertOpen, setAlertOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);

  // Overview tab.
  const [descOpen, setDescOpen] = useState(true);
  const [activityOpen, setActivityOpen] = useState(false);

  // Form tab (every input kind, all controlled).
  const [name, setName] = useState('Aurora');
  const [secret, setSecret] = useState('');
  const [filter, setFilter] = useState('');
  const [due, setDue] = useState('2026-01-15');
  const [priority, setPriority] = useState(3);
  const [status, setStatus] = useState('active');
  const [size, setSize] = useState('m');
  const [assignee, setAssignee] = useState('alice');
  const [notify, setNotify] = useState(true);
  const [agree, setAgree] = useState(false);
  const [progress, setProgress] = useState(40);
  const [notes, setNotes] = useState('First draft.');

  // -- derived ---------------------------------------------------------------

  const projectName =
    [...PROJECTS, ...ARCHIVE].find((p) => p.id === project)?.name ?? 'No project';

  const currentItems = useMemo(() => (project ? (items[project] ?? []) : []), [items, project]);

  // The host never sorts or filters: rows are shipped pre-sorted/filtered.
  const rows = useMemo<TableRowSpec[]>(() => {
    const needle = search.trim().toLowerCase();
    const visible = needle
      ? currentItems.filter((i) => i.name.toLowerCase().includes(needle))
      : currentItems;
    const sorted = [...visible].sort((a, b) => {
      const av = String(a[sort.key as keyof Item] ?? '');
      const bv = String(b[sort.key as keyof Item] ?? '');
      const base = sort.key === 'qty' ? a.qty - b.qty : av.localeCompare(bv);
      return sort.order === 'desc' ? -base : base;
    });
    return sorted.map((i) => ({
      id: i.id,
      cells: { name: i.name, status: i.status, qty: String(i.qty) },
    }));
  }, [currentItems, search, sort]);

  const selectedItem =
    typeof rowSelection === 'string'
      ? currentItems.find((i) => i.id === rowSelection)
      : undefined;

  const summary = [
    name,
    String(secret.length),
    filter,
    due,
    String(priority),
    status,
    size,
    assignee,
    String(notify),
    String(agree),
    String(Math.round(progress)),
    notes,
  ].join('|');

  // -- actions ---------------------------------------------------------------

  const addItem = (label: string) => {
    if (!project) return;
    const item: Item = { id: `new-${nextItemId++}`, name: label, status: 'active', qty: 1 };
    setItems((prev) => ({ ...prev, [project]: [...(prev[project] ?? []), item] }));
  };

  const saveDraft = () => {
    const label = draft.trim();
    if (!label) return;
    addItem(label);
    setDraft('');
    setSheetOpen(false);
  };

  const menuSelect = (id: string) => {
    setLastAction(`menu:${id}`);
    if (id === 'new-item') setSheetOpen(true);
    if (id === 'toggle-sidebar') setSidebar((s) => (s === 'all' ? 'detailOnly' : 'all'));
    if (id === 'help-about') {
      setTab('overview');
      setPopoverOpen(true);
    }
  };

  const toolbarAction = (id: string) => {
    setLastAction(`toolbar:${id}`);
    if (id === 'add') setSheetOpen(true);
    if (id === 'fav') setFavorite((f) => !f);
  };

  const contextSelect = (id: string) => {
    setLastAction(`context:${id}`);
    if (id === 'duplicate' && selectedItem && project) {
      const copy: Item = { ...selectedItem, id: `new-${nextItemId++}`, name: `${selectedItem.name} copy` };
      setItems((prev) => ({ ...prev, [project]: [...(prev[project] ?? []), copy] }));
    }
    if (id === 'delete' && selectedItem) setAlertOpen(true);
  };

  const alertSelect = (buttonId: string) => {
    setLastAction(`alert:${buttonId}`);
    if (buttonId === 'delete' && project && typeof rowSelection === 'string') {
      setItems((prev) => ({
        ...prev,
        [project]: (prev[project] ?? []).filter((i) => i.id !== rowSelection),
      }));
      setRowSelection(null);
    }
    setAlertOpen(false);
  };

  // -- chrome specs ------------------------------------------------------------

  const menus: MenuSpec[] = [
    {
      id: 'file',
      label: 'File',
      items: [
        { id: 'new-item', label: 'New Item', systemImage: 'plus', shortcut: 'cmd+n' },
        {
          id: 'export',
          label: 'Export',
          children: [
            { id: 'export-png', label: 'As PNG' },
            { id: 'export-csv', label: 'As CSV' },
            { id: 'export-json', label: 'As JSON' },
          ],
        },
        { divider: true },
        { id: 'close-project', label: 'Close Project', disabled: true },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        { id: 'undo', label: 'Undo', role: 'undo' },
        { id: 'redo', label: 'Redo', role: 'redo' },
        { divider: true },
        { id: 'cut', label: 'Cut', role: 'cut' },
        { id: 'copy', label: 'Copy', role: 'copy' },
        { id: 'paste', label: 'Paste', role: 'paste' },
        { id: 'select-all', label: 'Select All', role: 'selectAll' },
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        {
          id: 'toggle-sidebar',
          label: 'Show Sidebar',
          systemImage: 'sidebar.left',
          checked: sidebar === 'all',
        },
      ],
    },
    {
      id: 'help',
      label: 'Help',
      items: [{ id: 'help-about', label: 'About Kitchen Sink' }],
    },
  ];

  const toolbarItems: ToolbarItemSpec[] = [
    { type: 'button', id: 'back', label: 'Back', systemImage: 'chevron.left', disabled: true },
    { type: 'button', id: 'add', label: 'New Item', systemImage: 'plus' },
    { type: 'toggle', id: 'fav', label: 'Favorite', systemImage: 'star', on: favorite },
    {
      type: 'menu',
      id: 'export',
      label: 'Export',
      systemImage: 'square.and.arrow.up',
      items: [
        { id: 'export-png', label: 'PNG' },
        { id: 'export-csv', label: 'CSV' },
        { id: 'export-json', label: 'JSON' },
      ],
    },
    { type: 'flexibleSpace' },
    { type: 'search', id: 'find', placeholder: 'Filter items' },
  ];

  // -- view ---------------------------------------------------------------------

  return (
    <>
      <MenuBar menus={menus} onSelect={menuSelect} />
      <Toolbar items={toolbarItems} onAction={toolbarAction} onSearch={setSearch} />

      <SplitView
        value={sidebar}
        onChange={setSidebar}
        sidebarWidth={210}
        minSidebarWidth={170}
        frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}
      >
        <Sidebar>
          <List
            style="sidebar"
            value={project}
            onChange={(v) => setProject(typeof v === 'string' ? v : null)}
            frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}
          >
            <Section header="Projects">
              {PROJECTS.map((p) => (
                <Label key={p.id} tag={p.id} systemImage={p.icon} badge={(items[p.id] ?? []).length}>
                  {p.name}
                </Label>
              ))}
            </Section>
            <Section header="Archive">
              {ARCHIVE.map((p) => (
                <Label key={p.id} tag={p.id} systemImage={p.icon}>
                  {p.name}
                </Label>
              ))}
            </Section>
          </List>
        </Sidebar>

        <Detail>
          <VStack
            spacing={10}
            padding={{ top: 12, leading: 16, trailing: 16, bottom: 12 }}
            alignment="leading"
            frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}
          >
            <HStack spacing={8} alignment="center" frame={{ maxWidth: 'infinity' }}>
              <Text font="title2" weight="bold" accessibilityIdentifier="project-title">
                {projectName}
              </Text>
              {favorite && <Text color="#e6a700">★</Text>}
              <Spacer />
              <Text font="caption" color="#888888" accessibilityIdentifier="last-action">
                {`last: ${lastAction}`}
              </Text>
            </HStack>

            <TabView value={tab} onChange={setTab} frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
              <Tab id="overview" title="Overview" systemImage="info.circle">
                <VStack spacing={10} padding={14} alignment="leading">
                  <Label systemImage="calendar">{`Due ${due}`}</Label>
                  <Label systemImage="person">{`Assignee: ${assignee}`}</Label>
                  <Link url="https://github.com/anthropics/natui">Project repository</Link>
                  <ProgressView value={progress / 100} frame={{ maxWidth: 300 }} />
                  <DisclosureGroup label="Description" value={descOpen} onChange={setDescOpen}>
                    <Text>{notes}</Text>
                  </DisclosureGroup>
                  <DisclosureGroup label="Activity" value={activityOpen} onChange={setActivityOpen}>
                    <Text font="caption" color="#888888">
                      Nothing new since yesterday.
                    </Text>
                  </DisclosureGroup>
                  <Popover value={popoverOpen} arrowEdge="bottom" onChange={setPopoverOpen}>
                    <Button variant="plain" onPress={() => setPopoverOpen(true)}>
                      What is this?
                    </Button>
                    <PopoverContent padding={12}>
                      <Text accessibilityIdentifier="popover-help">
                        This whole window is native UI driven by React.
                      </Text>
                    </PopoverContent>
                  </Popover>
                </VStack>
              </Tab>

              <Tab id="form" title="Form" systemImage="pencil">
                <ScrollView frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
                  <VStack spacing={12} padding={14} alignment="leading" frame={{ maxWidth: 'infinity' }}>
                    <Section header="Identity">
                      <TextField value={name} placeholder="Name" onChange={setName} frame={{ maxWidth: 320 }} />
                      <TextField value={secret} placeholder="Password" secure onChange={setSecret} frame={{ maxWidth: 320 }} />
                      <SearchField value={filter} placeholder="Filter fields" onChange={setFilter} frame={{ maxWidth: 320 }} />
                    </Section>
                    <Section header="Schedule">
                      <HStack spacing={10} alignment="center">
                        <DatePicker value={due} displayedComponents="date" onChange={setDue} />
                        <Stepper value={priority} min={1} max={5} step={1} onChange={setPriority} />
                        <Text font="caption">{`priority ${priority}`}</Text>
                      </HStack>
                    </Section>
                    <Section header="Classification">
                      <Picker style="segmented" value={status} options={STATUS_OPTIONS} onChange={setStatus} frame={{ maxWidth: 320 }} />
                      <Picker style="radioGroup" value={size} options={SIZE_OPTIONS} onChange={setSize} />
                      <Picker style="menu" label="Assignee" value={assignee} options={ASSIGNEE_OPTIONS} onChange={setAssignee} frame={{ maxWidth: 220 }} />
                    </Section>
                    <Section header="Options">
                      <Toggle style="switch" value={notify} onChange={setNotify}>
                        Notify watchers
                      </Toggle>
                      <Toggle style="checkbox" value={agree} onChange={setAgree}>
                        Agree to the terms
                      </Toggle>
                      <HStack spacing={10} alignment="center">
                        <Slider value={progress} min={0} max={100} onChange={setProgress} frame={{ width: 180 }} />
                        <Text font="caption" monospaced frame={{ width: 30 }}>
                          {String(Math.round(progress))}
                        </Text>
                      </HStack>
                    </Section>
                    <Section header="Notes" footer="Every control above is native.">
                      <TextEditor value={notes} onChange={setNotes} frame={{ height: 70, maxWidth: 'infinity' }} />
                    </Section>
                    <Divider />
                    <Text font="caption" monospaced accessibilityIdentifier="form-summary">
                      {summary}
                    </Text>
                  </VStack>
                </ScrollView>
              </Tab>

              <Tab id="data" title="Data" systemImage="list.bullet" badge={rows.length}>
                <VStack spacing={10} padding={14} alignment="leading" frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
                  <ContextMenu
                    items={[
                      { id: 'duplicate', label: 'Duplicate', systemImage: 'plus.square.on.square' },
                      { divider: true },
                      { id: 'delete', label: 'Delete', role: 'destructive', systemImage: 'trash' },
                    ]}
                    onSelect={contextSelect}
                    frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}
                  >
                    <Table
                      columns={COLUMNS}
                      rows={rows}
                      value={rowSelection}
                      sort={sort}
                      onChange={setRowSelection}
                      onSortChange={setSort}
                      frame={{ maxWidth: 'infinity', minHeight: 160, maxHeight: 'infinity' }}
                    />
                  </ContextMenu>
                  <HStack spacing={8}>
                    <Button onPress={() => setSheetOpen(true)}>Add Item</Button>
                    <Button role="destructive" disabled={!selectedItem} onPress={() => setAlertOpen(true)}>
                      Delete Selected
                    </Button>
                  </HStack>
                  <DisclosureGroup label="Selection detail" value={detailOpen} onChange={setDetailOpen}>
                    <Text font="caption" accessibilityIdentifier="selection-detail">
                      {selectedItem
                        ? `${selectedItem.name} (${selectedItem.status}, qty ${selectedItem.qty})`
                        : 'nothing selected'}
                    </Text>
                  </DisclosureGroup>
                </VStack>
              </Tab>
            </TabView>
          </VStack>
        </Detail>
      </SplitView>

      <Sheet value={sheetOpen} onChange={setSheetOpen}>
        <VStack spacing={12} padding={20} alignment="leading" frame={{ minWidth: 320 }}>
          <Text font="headline">New Item</Text>
          <TextField
            value={draft}
            placeholder="Item name"
            onChange={setDraft}
            onSubmit={saveDraft}
            frame={{ maxWidth: 'infinity' }}
          />
          <HStack spacing={8} frame={{ maxWidth: 'infinity' }}>
            <Spacer />
            <Button
              role="cancel"
              onPress={() => {
                setDraft('');
                setSheetOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="prominent" disabled={draft.trim() === ''} onPress={saveDraft}>
              Save
            </Button>
          </HStack>
        </VStack>
      </Sheet>

      <Alert
        value={alertOpen}
        title="Delete item?"
        message={selectedItem ? `"${selectedItem.name}" will be removed permanently.` : 'No selection.'}
        buttons={[
          { id: 'cancel', label: 'Cancel', role: 'cancel' },
          { id: 'delete', label: 'Delete', role: 'destructive' },
        ]}
        onSelect={alertSelect}
        onChange={setAlertOpen}
      />
    </>
  );
}
