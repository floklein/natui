import Image from 'next/image';
import Link from 'next/link';

const capabilities = [
  {
    number: '01',
    title: 'Native by construction',
    text: 'React elements become SwiftUI and WinUI controls. Platform layout, focus, accessibility, and dark mode stay native.',
  },
  {
    number: '02',
    title: 'One typed component model',
    text: 'Use the same TypeScript props for layout, controls, menus, navigation, data, and presentation on both platforms.',
  },
  {
    number: '03',
    title: 'React state, native events',
    text: 'Hooks and reconciliation work as expected while protocol-level sequence acknowledgements keep controlled inputs stable.',
  },
  {
    number: '04',
    title: 'Two runtime shapes',
    text: 'Develop through the Node host bridge, or run an embedded JavaScriptCore bundle with no Node process at runtime on macOS.',
  },
];

const componentGroups = [
  'Layout',
  'Content',
  'Inputs',
  'App shell',
  'Menus',
  'Presentation',
  'Data',
];

export default function HomePage() {
  return (
    <div className="home-page">
      <header className="home-nav">
        <Link className="home-brand" href="/" aria-label="natui home">
          <span className="home-brand-mark" aria-hidden="true">
            N
          </span>
          <span>natui</span>
        </Link>
        <nav className="home-nav-links" aria-label="Primary navigation">
          <Link href="/docs">Documentation</Link>
          <a href="https://github.com/floklein/natui" rel="noreferrer" target="_blank">
            GitHub
          </a>
        </nav>
      </header>

      <main>
        <section className="hero-section">
          <div className="hero-copy">
            <p className="eyebrow">React 19 · SwiftUI · WinUI 3</p>
            <h1>
              Real native UI.
              <br />
              Written in React.
            </h1>
            <p className="hero-lede">
              Build desktop interfaces with React and TypeScript, then render the platform&apos;s
              real controls. No webview, no Electron, no second layout engine.
            </p>
            <div className="hero-actions">
              <Link className="primary-action" href="/docs/start">
                Start building
              </Link>
              <Link className="secondary-action" href="/docs/components">
                Explore 37 components
              </Link>
            </div>
            <div className="runtime-note">
              <span className="status-dot" aria-hidden="true" />
              Experimental proof of concept, verified in real native windows
            </div>
          </div>

          <div className="hero-showcase" aria-label="natui code and native output">
            <div className="code-card">
              <div className="code-card-top">
                <span>App.tsx</span>
                <span>React</span>
              </div>
              <pre>
                <code>{`function Counter() {
  const [count, setCount] = useState(0)

  return (
    <VStack spacing={12} padding={20}>
      <Text font="largeTitle">Hello, native</Text>
      <Button onPress={() => setCount(count + 1)}>
        Count: {count}
      </Button>
    </VStack>
  )
}`}</code>
              </pre>
            </div>

            <div className="native-card">
              <div className="native-titlebar" aria-hidden="true">
                <span className="window-dot window-dot-red" />
                <span className="window-dot window-dot-yellow" />
                <span className="window-dot window-dot-green" />
                <span className="native-title">natui kitchen sink</span>
              </div>
              <Image
                src="/images/kitchen-sink-initial.png"
                width={1800}
                height={1440}
                alt="The natui kitchen sink running as a native macOS application"
                priority
              />
            </div>
          </div>
        </section>

        <section className="component-rail" aria-label="Component groups">
          <span className="component-count">37 components</span>
          <div className="component-list">
            {componentGroups.map((group) => (
              <span key={group}>{group}</span>
            ))}
          </div>
        </section>

        <section className="capabilities-section">
          <div className="section-heading">
            <p className="eyebrow">A deliberately small bridge</p>
            <h2>React owns state. The platform owns the interface.</h2>
            <p>
              natui sends a compact tree of typed operations to a native host. It does not
              recreate a browser or impose web layout rules.
            </p>
          </div>
          <div className="capability-grid">
            {capabilities.map((capability) => (
              <article className="capability-card" key={capability.number}>
                <span>{capability.number}</span>
                <h3>{capability.title}</h3>
                <p>{capability.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="platform-section">
          <div className="section-heading platform-heading">
            <p className="eyebrow">One React tree, two honest platforms</p>
            <h2>Shared intent, native results.</h2>
            <p>
              The API stays consistent while SwiftUI and WinUI preserve their own typography,
              spacing, controls, and interaction language.
            </p>
          </div>

          <div className="platform-grid">
            <article className="platform-card">
              <div className="platform-card-header">
                <div>
                  <span className="platform-kicker">macOS</span>
                  <h3>SwiftUI</h3>
                </div>
                <span className="platform-proof">Real-window verified</span>
              </div>
              <div className="platform-image platform-image-macos">
                <Image
                  src="/images/macos-demo-final.png"
                  width={960}
                  height={1296}
                  alt="The natui demo rendered with SwiftUI on macOS"
                />
              </div>
            </article>

            <article className="platform-card">
              <div className="platform-card-header">
                <div>
                  <span className="platform-kicker">Windows</span>
                  <h3>WinUI 3</h3>
                </div>
                <span className="platform-proof">Node-mode verified</span>
              </div>
              <div className="platform-image platform-image-windows">
                <Image
                  src="/images/windows-demo-final.png"
                  width={480}
                  height={620}
                  alt="The natui demo rendered with WinUI 3 on Windows"
                />
              </div>
            </article>
          </div>
        </section>

        <section className="pipeline-section">
          <div className="pipeline-copy">
            <p className="eyebrow">How a commit travels</p>
            <h2>A thin protocol between React and the native tree.</h2>
          </div>
          <ol className="pipeline" aria-label="Rendering pipeline">
            <li>
              <span>01</span>
              <strong>React tree</strong>
              <small>Hooks, keys, effects</small>
            </li>
            <li>
              <span>02</span>
              <strong>Custom reconciler</strong>
              <small>Atomic operation batch</small>
            </li>
            <li>
              <span>03</span>
              <strong>NDJSON bridge</strong>
              <small>Operations and events</small>
            </li>
            <li>
              <span>04</span>
              <strong>Native host</strong>
              <small>SwiftUI or WinUI</small>
            </li>
          </ol>
        </section>

        <section className="closing-section">
          <div>
            <p className="eyebrow">Source checkout ready</p>
            <h2>Build your first native React window.</h2>
          </div>
          <Link className="primary-action" href="/docs/start">
            Read the quick start
          </Link>
        </section>
      </main>

      <footer className="home-footer">
        <span>natui</span>
        <span>React to SwiftUI and WinUI 3</span>
        <a href="https://github.com/floklein/natui/blob/main/LICENSE">MIT License</a>
      </footer>
    </div>
  );
}
