/**
 * `@plantops/web-kit` — the React runtime a PlantOps console needs to talk to
 * the IAM.
 *
 * The stateful counterpart to `@plantops/ui`. Where that library renders,
 * this one *knows things*: which client to call, where the tokens live, who is
 * signed in, what they may do, and what their menu is. Between them they are
 * everything a new console needs that is not its own screens — which is the
 * point, because gatepass and visitor management are next (Doc 00 §9) and
 * neither should reimplement sign-in.
 *
 * ```tsx
 * // The whole of a console's setup.
 * <PlantOpsProvider baseUrl={process.env.NEXT_PUBLIC_IAM_API_URL!}>
 *   <RequireAuth onUnauthenticated={(next) => router.replace(`/login?next=${next}`)}>
 *     <AppShell nav={<NavMenu tree={useNavigation().tree} … />}>…</AppShell>
 *   </RequireAuth>
 * </PlantOpsProvider>
 * ```
 *
 * ## What it deliberately does not do
 *
 * - **No router.** Redirects are callbacks. A `next/navigation` import would
 *   pin every future console to one framework and make the components
 *   untestable without it.
 * - **No authorisation.** `usePermission` hides controls the subject cannot
 *   use; the server decides (Doc 09 §4). Nothing here is a security boundary,
 *   and `claims.ts` says so at the one place that reads a token.
 * - **No data-fetching framework.** `useAsync` is forty lines and covers what an
 *   admin console does. The two genuinely shared reads — grants and navigation
 *   — are fetched once by their own providers.
 */

export * from './claims';
export * from './errors';
export * from './grants-provider';
export * from './iam-provider';
export * from './plantops-provider';
export * from './require-auth';
export * from './scope-coverage';
export * from './token-store';
export * from './use-async';
export * from './use-navigation';
export * from './use-notices';
export * from './use-permission';
