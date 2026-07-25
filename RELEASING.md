# Releasing NatUI

This checklist prepares and publishes a NatUI release. Run it from a clean
checkout of `main`.

## 1. Align release metadata

- Set the same version in the root, `packages/natui`, both examples, the docs,
  and `examples/demo/natui.app.json`.
- Update artifact names that contain the version.
- Add the release notes to `CHANGELOG.md`.
- Run `pnpm release:check`. For a tag candidate, also run
  `pnpm release:check v0.1.0`.

The release check rebuilds the npm package through its `prepack` hook, confirms
version alignment, validates provenance metadata, and inspects the exact npm
tarball file list.

## 2. Run portable verification

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm typecheck
pnpm docs:check
pnpm docs:build
pnpm release:check v0.1.0
```

The latest `main` CI run must also be green. Its macOS and Windows jobs build
the native hosts and inspect the platform package artifacts.

## 3. Run native verification

On Windows, build a fresh release host and point every real-window check at
that exact executable:

```powershell
dotnet build hosts\windows\NatuiHost -c Release -p:Platform=x64
$env:NATUI_HOST = (Resolve-Path 'hosts\windows\NatuiHost\bin\x64\Release\net8.0-windows10.0.19041.0\win-x64\NatuiHost.exe').Path
pnpm verify
pnpm verify:kitchen
pnpm verify:embedded
pnpm verify:package
```

On macOS:

```bash
pnpm build:host:macos
export NATUI_HOST="$PWD/hosts/macos/.build/release/natui-host"
pnpm verify
pnpm verify:kitchen
pnpm verify:embedded
pnpm verify:package
```

These checks require a normal desktop window session.

## 4. Inspect publication inputs

From `packages/natui`, inspect npm's final output:

```bash
npm pack --dry-run
```

Confirm that the registry does not already contain the target version and that
the Git tag and GitHub release do not already exist.

## 5. Publish

Only after both platform checks and the exact release commit are approved:

1. Create the signed `v0.1.0` tag on the approved commit and push the tag.
2. Publish `packages/natui` to npm with public access.
3. Create the GitHub release from the same tag using the matching changelog
   section.
4. Attach the macOS archive and Windows executable produced from that commit.
5. Verify the npm version, remote tag, GitHub release, and both downloaded
   native artifacts independently.

The first npm publication needs an account authorized for the `natui` package.
After the package exists, configure npm trusted publishing for a dedicated
GitHub Actions workflow before automating later releases.
