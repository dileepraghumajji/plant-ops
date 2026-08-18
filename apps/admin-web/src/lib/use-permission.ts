'use client';

/**
 * The permission-aware-control hook every screen session from Session 28 onward
 * imports (Doc 09 §4).
 *
 * The implementation is in `@plantops/web-kit` — it reads the grants resolved
 * once per session and answers from them, and it is identical for the gatepass
 * and visitor consoles. This module exists so that screens in *this* app import
 * it from one place, and so the roadmap's `lib/use-permission.ts` is where a
 * reader looking for it expects it to be.
 *
 * ```tsx
 * const canAssign = usePermission('iam.client.binding.create');
 * {canAssign && <Button type="primary">Assign access</Button>}
 * ```
 *
 * Hiding a control is UX, not security. The server checks again on every call,
 * and a deep link into a screen the menu hid still returns 403 — which the
 * console renders through `<ScreenError>` rather than swallowing.
 */

export {
  Permitted,
  usePermission,
  usePermissions,
  type PermissionApi,
  type PermissionQuery,
} from '@plantops/web-kit';
