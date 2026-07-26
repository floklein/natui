# NatUI

NatUI lets React and TypeScript render real native desktop UI through SwiftUI
on macOS and WinUI 3 on Windows. It does not use a webview, Electron, or a
browser layout engine.

Version 0.2.0 is an alpha release. The npm package contains the JavaScript
renderer, typed components, embedded runtime entry point, development server,
and `natui` CLI. The native host is not bundled with the npm package yet. Build
it from the [NatUI repository](https://github.com/floklein/natui) and set
`NATUI_HOST` when the application is outside that checkout.

## Install

Create a configured project:

```bash
npx create-natui-app@latest
```

Or install the runtime into an existing React 19 project:

```bash
npm install @natui/core react
```

NatUI requires Node.js 22 or newer and React 19.2.

```tsx
import { useState } from 'react';
import { Button, Text, VStack, run } from '@natui/core';

function App() {
  const [count, setCount] = useState(0);

  return (
    <VStack spacing={12} padding={20}>
      <Text font="title2">{String(count)}</Text>
      <Button onPress={() => setCount((value) => value + 1)}>
        Increment
      </Button>
    </VStack>
  );
}

await run(<App />, { title: 'My app', width: 480, height: 320 });
```

Use `natui dev` for state-preserving native development with React Fast
Refresh. It reads `entry` from `natui.app.json`, with a positional entry as an
override and `src/main.tsx` as the fallback.

The project generator creates one entry for development and repository-local
packaging, plus platform-native icon containers:

```json
{
  "entry": "src/main.tsx",
  "icons": {
    "macos": "assets/AppIcon.icns",
    "windows": "assets/AppIcon.ico"
  }
}
```

See [natui.dev](https://natui.dev) for setup, components, runtime modes,
platform support, and packaging documentation.

## License

MIT
