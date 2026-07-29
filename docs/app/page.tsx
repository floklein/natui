import { highlight } from 'fumadocs-core/highlight';
import Image from 'next/image';
import Link from 'next/link';
import { CopyCommand } from '@/components/copy-command';
import { NatuiMark } from '@/components/natui-mark';

const heroCode = `<VStack spacing={14} padding={20} alignment="leading">
  <HStack spacing={8} alignment="center">
    <Image systemName="atom" color="#e94f37" />
    <Text font="largeTitle" weight="bold">NatUI</Text>
  </HStack>
  <HStack spacing={10} alignment="center">
    <Button onPress={() => setCount((c) => c - 1)}>−</Button>
    <Text font="title2" monospaced>{String(count)}</Text>
    <Button onPress={() => setCount((c) => c + 1)}>+</Button>
  </HStack>
  <List>
    {todos.map((todo) => (
      <Toggle key={todo.id} value={todo.done}>{todo.label}</Toggle>
    ))}
  </List>
  <Slider value={volume} onChange={setVolume} />
  <ProgressView value={volume / 100} />
</VStack>`;

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
    text: 'Develop through the Node host bridge, or run an embedded JavaScript bundle in-process with JavaScriptCore on macOS and V8 on Windows.',
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

export default async function HomePage() {
  const highlightedHeroCode = await highlight(heroCode, {
    lang: 'tsx',
    theme: 'github-dark',
  });

  return (
    <div className="home-page">
      <header className="home-nav">
        <Link className="home-brand" href="/" aria-label="NatUI home">
          <span className="home-brand-mark" aria-hidden="true">
            <NatuiMark size={17} />
          </span>
          <span>NatUI</span>
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
            <CopyCommand command="npx create-natui-app@latest" />
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
              NatUI is still in alpha release, and might be subject to breaking changes.
            </div>
          </div>

          <div
            className="hero-showcase"
            aria-label="NatUI code and native outputs"
            role="group"
          >
            <div className="code-card">
              <div className="code-card-top">
                <span>App.tsx</span>
                <span>TSX</span>
              </div>
              {highlightedHeroCode}
            </div>

            <div className="native-card native-card-macos">
              <div className="native-card-label" aria-hidden="true">
                <span>Native output</span>
                <span>SwiftUI</span>
              </div>
              <Image
                src="/images/macos-demo-final.png"
                width={960}
                height={1296}
                alt="The matching NatUI demo rendered with SwiftUI on macOS"
                loading="eager"
              />
            </div>

            <div className="native-card native-card-windows">
              <div className="native-card-label" aria-hidden="true">
                <span>Native output</span>
                <span>WinUI 3</span>
              </div>
              <Image
                src="/images/windows-demo-final.png"
                width={480}
                height={620}
                alt="The matching NatUI demo rendered with WinUI 3 on Windows"
                loading="eager"
              />
            </div>
          </div>
        </section>

        <section className="component-rail" aria-label="Component groups">
          <div className="component-list">
            <span className="component-count">37 components</span>
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
              NatUI sends a compact tree of typed operations to a native host. It does not
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
              </div>
              <div className="platform-image platform-image-macos">
                <Image
                  src="/images/macos-demo-final.png"
                  width={960}
                  height={1296}
                  alt="The NatUI demo rendered with SwiftUI on macOS"
                />
              </div>
            </article>

            <article className="platform-card">
              <div className="platform-card-header">
                <div>
                  <span className="platform-kicker">Windows</span>
                  <h3>WinUI 3</h3>
                </div>
              </div>
              <div className="platform-image platform-image-windows">
                <Image
                  src="/images/windows-demo-final.png"
                  width={480}
                  height={620}
                  alt="The NatUI demo rendered with WinUI 3 on Windows"
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
            <p className="eyebrow">Project generator ready</p>
            <h2>Build your first native React window.</h2>
          </div>
          <Link className="primary-action" href="/docs/start">
            Read the quick start
          </Link>
        </section>
      </main>

      <footer className="home-footer">
        <span>NatUI</span>
        <a href="https://github.com/floklein/natui/blob/main/LICENSE">MIT License</a>
      </footer>
    </div>
  );
}
