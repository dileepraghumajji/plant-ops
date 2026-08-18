/**
 * `@plantops/ui` — the shared React presentation layer for every PlantOps
 * console (Doc 08 §2).
 *
 * Ant Design 6 supplies the components; this library supplies the *product*:
 * the design tokens, the theme built from them, the shell every console renders
 * inside, the icon-key registry Doc 05 §7 requires, and the handful of patterns
 * that must not be reinvented per screen — page headers, list tables bound to
 * the pagination envelope, status tags, and the four not-showing-data states.
 *
 * ## The rule that keeps it reusable
 *
 * Nothing here calls the IAM. The library depends on `@plantops/contracts` for
 * types and on nothing else in the workspace — enforced by the `scope:ui`
 * boundary in the root ESLint config — so a component takes data and callbacks
 * and returns markup. The stateful half (a client, tokens, grants, navigation
 * fetching) lives in `@plantops/web-kit`, which depends on this.
 *
 * That split is what makes the gatepass and visitor consoles cheap: they mount
 * the same `<PlantOpsThemeProvider>` and `<AppShell>`, render the same
 * `<NavMenu>` from their own `/iam/navigation` response, and inherit the
 * product's appearance without inheriting the IAM's screens.
 *
 * ```tsx
 * <PlantOpsThemeProvider>
 *   <AppShell brand={<Brand product="Gatepass" />} nav={<NavMenu … />}>
 *     <PageHeader title="Passes" />
 *     <DataTable result={page} columns={columns} rowKey={(r) => r.id} />
 *   </AppShell>
 * </PlantOpsThemeProvider>
 * ```
 */

export * from './data/data-table';
export * from './data/scope-tree';
export * from './data/scope-tree-select';
export * from './data/status-tag';
export * from './feedback/error-copy';
export * from './feedback/page-header';
export * from './feedback/state-panels';
export * from './forms/auth-layout';
export * from './forms/credentials-form';
export * from './icons/icon-registry';
export * from './layout/app-shell';
export * from './layout/brand';
export * from './layout/nav-menu';
export * from './layout/nav-tree';
export * from './layout/user-menu';
export * from './theme/color-mode';
export * from './theme/theme';
export * from './theme/theme-provider';
export * from './theme/tokens';
