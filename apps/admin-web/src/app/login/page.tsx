'use client';

/**
 * Sign in (Doc 09 §1, Doc 06 §3).
 *
 * The form itself is `@plantops/ui`'s `<CredentialsForm>`; this page is the
 * wiring — call the API, decide what the failure means, and go somewhere
 * afterwards.
 *
 * ## The failure that has to be its own message
 *
 * A 423 is not a wrong password. Doc 03 §8 makes a locked account a distinct
 * state that an administrator clears, so telling that user "check your
 * password" sends them to a reset that cannot help and, after a few more
 * attempts, deeper into the lockout. `errorCopyFor(ACCOUNT_LOCKED)` says so
 * explicitly, and this page's only job is not to flatten it into a generic
 * "sign-in failed" — which is exactly what a `catch` that renders
 * `error.message` would do.
 *
 * The 401 stays generic in the other direction, and deliberately: Doc 03 §3
 * requires an unknown user and a bad password to be indistinguishable, so the
 * console must not add a hint the server was careful not to give.
 *
 * ## Where the user lands
 *
 * `?next=` when they were deep-linking, `/` otherwise — which itself resolves
 * to the first screen their own menu offers. Neither is a hardcoded console
 * route: a platform admin and a gate supervisor land in different places from
 * the same code.
 */

import { AuthLayout, CredentialsForm, type CredentialsFormValues } from '@plantops/ui';
import { describeError, useAuth, type DescribedError } from '@plantops/web-kit';
import { Alert, Skeleton, Typography } from 'antd';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactElement } from 'react';

import { IAM_API_LABEL } from '../../lib/api-config';
import { RETURN_TO_PARAM, safeReturnTo } from '../../lib/auth-context';

export default function LoginPage(): ReactElement {
  // `useSearchParams` opts the subtree into client-side rendering; the boundary
  // keeps that from de-optimising the whole route.
  return (
    <Suspense
      fallback={
        <AuthLayout product="IAM" title="Sign in">
          <Skeleton active paragraph={{ rows: 4 }} title={false} />
        </AuthLayout>
      }
    >
      <LoginScreen />
    </Suspense>
  );
}

function LoginScreen(): ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const { status, login, endedReason, lastClientSlug } = useAuth();

  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<DescribedError | null>(null);

  const returnTo = safeReturnTo(params.get(RETURN_TO_PARAM));

  // Someone who is already signed in has no business on this page — they
  // arrived by bookmark or by pressing back after signing in.
  useEffect(() => {
    if (status === 'authenticated') router.replace(returnTo);
  }, [status, router, returnTo]);

  const onSubmit = async (values: CredentialsFormValues): Promise<void> => {
    setSubmitting(true);
    setFailure(null);
    try {
      await login(values);
      router.replace(returnTo);
    } catch (cause) {
      setFailure(describeError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      product="IAM"
      title="Sign in"
      subtitle="Administer identities, roles and access for your organisation."
      footer={IAM_API_LABEL}
    >
      {endedReason === 'refresh_failed' && failure === null && (
        <Alert
          type="info"
          showIcon
          style={{ marginBlockEnd: 16 }}
          message="Your session ended"
          description="It expired, or it was signed out from elsewhere. Sign in again to continue."
        />
      )}

      <CredentialsForm
        onSubmit={onSubmit}
        submitting={submitting}
        error={failure?.copy ?? null}
        // The server's own sentence, under the copy. Never shown *instead* of
        // it — that is how a 423 turns back into "sign-in failed".
        errorDetail={failure?.detail ?? null}
        defaultClientSlug={lastClientSlug ?? ''}
        footer={
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
            Forgotten your password, or locked out? Your organisation&rsquo;s
            administrator can reset or unlock your account.
          </Typography.Paragraph>
        }
      />
    </AuthLayout>
  );
}
