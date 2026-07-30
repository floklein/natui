# create-natui-app

Create a TypeScript NatUI application with one configured entry and native
icon assets for macOS and Windows.

```bash
npx create-natui-app@latest my-app
cd my-app
npm run dev
```

The generator detects npm, pnpm, Yarn, or Bun from the invoking process. Pass
`--package-manager <name>` to choose explicitly, or `--no-install` to scaffold
without installing dependencies.

```text
Usage: create-natui-app [project-directory] [options]

Options:
  -y, --yes                       Use natui-app when no directory is provided
      --no-install                Skip dependency installation
      --package-manager <name>    npm, pnpm, yarn, or bun
  -h, --help                      Show help
  -v, --version                   Show the package version
```

The generated `natui.app.json` uses `src/main.tsx` for development and native
application packaging. Replace the generated `assets/AppIcon.icns` and
`assets/AppIcon.ico` when the application has its own artwork.

On first launch, `@natui/core` downloads the prebuilt native host for this
release and caches it per user, so no separate build or checkout is needed.
Run `npx natui host install` to download it ahead of time, or set the
`NATUI_HOST` environment variable to use a self-built host instead. See
[natui.dev](https://natui.dev) for details. Native application packaging
remains a reference workflow in a NatUI framework repository checkout.

## License

MIT
