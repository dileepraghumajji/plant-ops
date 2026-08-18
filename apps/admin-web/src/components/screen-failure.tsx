'use client';

/**
 * Whatever a screen's load threw, rendered where the content would have been.
 *
 * `@plantops/ui`'s `<ScreenError>` takes the *described* parts of a failure —
 * copy, detail, request id, field complaints — because the library may not
 * depend on the IAM client (`scope:ui` → `scope:contracts` only). Turning a
 * caught value into those parts is `describeError`'s job, and this is the
 * four-line adapter that sits between them. Every screen needs it, so it is
 * written once rather than copied per tab.
 *
 * Deliberately not a toast. A failed load has to replace the content: an empty
 * table with a notification floating over it reads as "there is nothing here",
 * which is the opposite of what a 403 means (Doc 09 §4).
 */

import { ScreenError } from '@plantops/ui';
import { describeError } from '@plantops/web-kit';
import type { ReactElement, ReactNode } from 'react';

export interface ScreenFailureProps {
  error: unknown;
  /** Offered only when the copy says the failure is plausibly transient. */
  onRetry?: () => void;
  /** An escape route — "Back to applications". */
  action?: ReactNode;
}

export function ScreenFailure({
  error,
  onRetry,
  action,
}: ScreenFailureProps): ReactElement {
  const described = describeError(error);
  return (
    <ScreenError
      copy={described.copy}
      detail={described.detail}
      requestId={described.requestId}
      details={described.details}
      onRetry={onRetry}
      action={action}
    />
  );
}
