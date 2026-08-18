# @plantops/ui

The shared React presentation layer for every PlantOps console (Doc 08 §2).

Ant Design 6 supplies the components; this library supplies the *product* — the
design language, the theme built from it, the shell every console renders
inside, the icon-key registry Doc 05 §7 requires, and the handful of patterns
that must not be reinvented per screen.

## The rule that keeps it reusable

**Nothing here calls the IAM.** It depends on `@plantops/contracts` for types and
on nothing else in the workspace, enforced by the `scope:ui` boundary in the root
ESLint config: every component takes data and callbacks and returns markup. The
stateful half — a client, tokens, grants, navigation fetching — is
[`@plantops/web-kit`](../web-kit), which depends on this.

That split is what makes the gatepass and visitor consoles cheap. They mount the
same provider and shell, render the same `<NavMenu>` from their own
`/iam/navigation` response, and inherit the product's appearance without
inheriting the IAM's screens.

## What is in it

| Area | Exports |
|---|---|
| `theme/` | `PlantOpsThemeProvider`, `plantOpsTheme`, `useColorMode`, and the raw tokens (`palette`, `neutral`, `spacing`, `radius`, `layout`, `typography`) |
| `layout/` | `AppShell`, `NavMenu`, `Brand`, `UserMenu`, and the pure `nav-tree` helpers (`firstNavRoute`, `navSelectionForPath`, `flattenNavRoutes`) |
| `icons/` | `NavIcon`, `iconForKey`, `knownIconKeys` — the `nav_node.icon` → icon-set map |
| `feedback/` | `PageHeader`, `ScreenLoading`, `ScreenEmpty`, `ScreenError`, and `errorCopyFor` — one sentence per `IamErrorCode` |
| `forms/` | `AuthLayout`, `CredentialsForm` |
| `data/` | `DataTable` (bound to the Doc 06 §1 pagination envelope), `StatusTag` |

## Using it

```tsx
import { AppShell, Brand, NavMenu, PageHeader, PlantOpsThemeProvider } from '@plantops/ui';

<PlantOpsThemeProvider>
  <AppShell brand={<Brand product="Gatepass" />} nav={<NavMenu tree={tree} … />}>
    <PageHeader title="Passes" />
  </AppShell>
</PlantOpsThemeProvider>
```

Consumed as TypeScript source: `package.json` points `main` at `src/index.ts`, so
a Next.js app lists it in `transpilePackages` and picks up changes without a
separate library build.

## Conventions worth knowing before adding a component

- **No hex literals in components.** Colours come from `theme/tokens.ts` or from
  antd's CSS variables (`var(--ant-color-primary)`). A literal that is right in
  light mode is wrong in dark mode and cannot know which is showing.
- **Red, amber and green are reserved for status.** PlantOps administers plants;
  those three already mean something on a plant floor, which is why the brand
  colour is a deep teal. See the header of `theme/tokens.ts`.
- **Copy is part of the design language.** What a `403` says to a person lives in
  `feedback/error-copy.ts`, not in each console, so the gatepass console cannot
  invent a second wording — and so Doc 06 §2's "a denial never reveals whether
  the target exists in another tenant" is enforceable by a test.
- **`'use client'` on anything with state or an event handler.** These libraries
  are consumed by Next.js App Router apps.

## Tests

```sh
npx nx test @plantops/ui
```

jsdom, with the antd-shaped browser APIs stubbed in `src/test-setup.ts`. antd 6
ships ESM inside its CommonJS build, so `transformIgnorePatterns` in
`jest.config.cts` transforms `antd`, `@ant-design/*` and `@rc-component/*` rather
than skipping them.
