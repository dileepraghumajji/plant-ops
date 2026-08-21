# @plantops/web-kit

The React runtime a PlantOps console needs to talk to the IAM — the stateful
counterpart to [`@plantops/ui`](../ui).

Where that library renders, this one *knows things*: which client to call, where
the tokens live, who is signed in, what they may do, and what their menu is.
Between them they are everything a new console needs that is not its own
screens — which is the point, because gatepass and visitor management are next
(Doc 00 §9) and neither should reimplement sign-in.

## The whole of a console's setup

```tsx
'use client';
import { PlantOpsProvider } from '@plantops/web-kit';

export function Providers({ children }) {
  return (
    <PlantOpsProvider baseUrl={process.env.NEXT_PUBLIC_IAM_API_URL ?? '/api'}>
      {children}
    </PlantOpsProvider>
  );
}
```

The fallback is a *path*, not an origin. `/api` resolves against whatever origin
served the page, so one build of a console runs at any hostname with nothing
customer-specific inlined into its bundle (Doc 11 §3); the environment variable
is for the case where the console and the API are genuinely on different origins
— local development, or a console hosted separately from its API. Either way the
transport composes `baseUrl + path`, and nothing below the provider can tell
which form it was given.

`PlantOpsProvider` nests theme → antd's feedback hooks → IAM client → session →
grants, in the order they depend on each other. That ordering is the part that is
easy to get wrong and impossible to notice: mount the grants provider above the
client and every permission answers `false` with no error anywhere.

## What it gives you

| Hook / component | For |
|---|---|
| `useAuth()` | `status`, `subject`, `login`, `logout`, `endedReason`, `lastClientSlug` |
| `useIam()` | The typed `IamClient`, for anything the hooks do not cover |
| `useGrants()` | The resolved `ResolvedGrants`, fetched once per session |
| `usePermission(key)` / `usePermissions()` / `<Permitted>` | Permission-aware controls (Doc 09 §4) |
| `useNavigation()` | The pruned menu from `GET /iam/navigation` (Doc 05) |
| `useAsync(fn, deps)` | One endpoint, a skeleton, an error, a retry — without the race |
| `useNotices()` | Themed toasts, including the Doc 09 §4 "access updates may take a few seconds" notice |
| `<RequireAuth>` | The gate in front of authenticated screens |
| `describeError(e)` | Any thrown value → code, copy, request id, field details |
| `BrowserTokenStore` | `localStorage` + cross-tab session sync |
| `pathCovers` / `holdsPermissionAt` | The `ltree` coverage test, client-side |

## What it deliberately does not do

- **No router.** Redirects are callbacks. A `next/navigation` import would pin
  every future console to one framework and make the components untestable
  without it. `RequireAuth` takes `onUnauthenticated`; the app decides where the
  login screen is and how a deep link survives sign-in.
- **No authorisation.** `usePermission` hides controls the subject cannot use;
  the server decides (Doc 09 §4). `claims.ts` reads the access token *unverified*
  and says so at length — those values may be rendered and must never be used to
  decide.
- **No data-fetching framework.** `useAsync` is forty lines and covers what an
  admin console does. The two genuinely shared reads — grants and navigation —
  are fetched once by their own providers.

## Session handling, in one paragraph

Tokens live in `localStorage` (`BrowserTokenStore`; the reasoning, including the
XSS trade-off against a cross-origin cookie, is in that file's header).
`IamClient` renews an access token before it lapses and retries a `401` after a
*single* shared refresh; `IamProvider` adds a keepalive so a console left open on
a dashboard renews silently rather than failing on the next click. A session ends
in exactly one way — a `null` write to the token store — whether the user signed
out, a refresh was refused (Doc 03 §4.1), or another tab did either.

## Tests

```sh
npx nx test @plantops/web-kit
```

`iam-provider.spec.tsx` drives the real provider, the real `IamClient` and the
real token store, replacing only the socket: sign in, reload, sign out, another
tab, and a refused refresh.
