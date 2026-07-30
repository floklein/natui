# Releasing NatUI

This checklist prepares and publishes a NatUI release. Run it from a clean
checkout of `main`.

## 1. Align release metadata

- Set the same NatUI release version in the root, `packages/natui`,
  `packages/natui-dev`, `packages/create-natui-app`, both examples, the docs,
  and both `natui.app.json` example configs.
- Keep the new application version at `0.1.0` in both `create-natui-app`
  templates. Set the template's `@natui/core` dependency to the matching
  compatible NatUI release version.
- When adding the CLI package for the first time, preserve its executable mode:

  ```bash
  git add --chmod=+x packages/create-natui-app/bin/create-natui-app.js
  ```

- Update artifact names that contain the version.
- Add the release notes to `CHANGELOG.md`.
- Run `pnpm release:check`. For a tag candidate, also run
  `pnpm release:check v0.2.1`.

The release check rebuilds the npm packages through their `prepack` hooks,
confirms version alignment, validates provenance metadata, checks both
executable modes, inspects all three npm tarballs, confirms that packing
rewrites the `@natui/dev` workspace peer range, and smokes the `natui` and
`create-natui-app` CLIs.

## 2. Run portable verification

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm typecheck
pnpm docs:check
pnpm docs:build
pnpm release:check v0.2.1
```

The latest `main` CI run must also be green. The Linux job uploads the
`@natui/core` and `create-natui-app` tarballs. Its macOS and Windows jobs build
the native hosts, inspect the platform package artifacts, and package the
prebuilt host release archives with `tools/package-host.mjs`, exactly as the
`Publish` workflow will.

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

Inspect npm's final output from the publishable package directories:

```bash
(cd packages/natui && npm pack --dry-run)
(cd packages/natui-dev && pnpm pack)
(cd packages/create-natui-app && npm pack --dry-run)
```

Confirm that `packages/create-natui-app/bin/create-natui-app.js` is mode
`100755` in `git ls-files --stage`. Confirm that the registry does not already
contain any target package version and that the Git tag and GitHub release do
not already exist.

## 5. Publish

Only after both platform checks and the exact release commit are approved:

1. Create the signed release tag on the approved commit and push the tag.
2. The tag push starts the `Publish` workflow, which runs in this order:
   1. Builds the prebuilt host release archives: a universal macOS binary and
      the self-contained x64 and arm64 Windows folders, each with a `.sha256`
      sibling.
   2. Verifies the tag matches every workspace package version before
      anything goes public (`tools/verify-release-tag.mjs`). A mismatched or
      prerelease tag fails here with nothing published; prerelease tags are
      not supported.
   3. Creates the GitHub release from the tag with the matching `CHANGELOG.md`
      section (the workflow fails when the section is missing) and attaches
      the host archives. This happens before npm so an installed package can
      always download its host.
   4. Re-runs the release check against the tag, then publishes
      `packages/natui`, `packages/natui-dev`, and `packages/create-natui-app`
      through npm trusted publishing.

   Confirm the run succeeds.
3. Attach the demo application artifacts produced from that commit to the
   release when desired; the host archives are already there.
4. Verify all three npm versions, `npx create-natui-app@<version> --version`,
   a generated project install that resolves `@natui/dev` from the registry,
   the remote tag, and the GitHub release. In a scratch directory outside any
   checkout, verify the download path end to end:

   ```bash
   npx --yes --package @natui/core@<version> natui host install
   ```

The `Publish` workflow authenticates with an OpenID Connect token, so no npm
account token exists in the repository, and npm generates provenance
attestations automatically. All three packages must name `publish.yml` in
this repository as their trusted publisher: on npmjs.com, open each package's
Settings, then Trusted Publisher, and select GitHub Actions with this
repository and that workflow filename. A version already on the registry
cannot be republished; a failed run after a partial publish needs a new
patch version.
