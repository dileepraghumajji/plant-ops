'use client';

/**
 * `/` — a redirect nobody hardcoded.
 *
 * There is no "dashboard" to land on, and picking one would immediately be
 * wrong for somebody: a platform admin belongs in the applications catalog, a
 * tenant admin in their users, a subject with one narrow grant on the single
 * screen they hold it for. So the destination is the first routable node of the
 * menu the server returned — the first screen *this* subject may see, in the
 * order the catalog puts it (Doc 05 §5 sorts by `sort_order`).
 *
 * The empty case is real and is not an error. Deny-by-default (Doc 05 §3) means
 * a user with no role bindings has an empty menu, and they need to be told that
 * in a sentence rather than bounced between routes that all refuse them.
 */

import { firstNavRoute, PageHeader, ScreenEmpty, ScreenError } from '@plantops/ui';
import { describeError, useNavigation } from '@plantops/web-kit';
import { Button, Card, Skeleton } from 'antd';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactElement } from 'react';

import { RequireSession, useAuth } from '../lib/auth-context';

export default function HomePage(): ReactElement {
  return (
    <RequireSession>
      <HomeRedirect />
    </RequireSession>
  );
}

function HomeRedirect(): ReactElement {
  const router = useRouter();
  const { subject, logout } = useAuth();
  const { tree, loading, error, reload } = useNavigation();

  const destination = firstNavRoute(tree);

  useEffect(() => {
    if (destination !== null) router.replace(destination);
  }, [destination, router]);

  if (loading || destination !== null) {
    return <Skeleton active style={{ padding: 32, maxWidth: 720, margin: '48px auto' }} />;
  }

  const centred = { maxWidth: 720, margin: '48px auto' };

  if (error !== null) {
    const described = describeError(error);
    return (
      <Card style={centred}>
        <ScreenError
          copy={described.copy}
          detail={described.detail}
          requestId={described.requestId}
          onRetry={reload}
        />
      </Card>
    );
  }

  return (
    <Card style={centred}>
      <PageHeader
        title="Nothing has been granted to you yet"
        description={
          <>
            You are signed in
            {subject?.clientSlug === null || subject?.clientSlug === undefined
              ? ''
              : ` to ${subject.clientSlug}`}
            , but no role has been bound to you, so there are no screens to show.
            An administrator assigns access by binding you to a role at a place
            in the organisation tree.
          </>
        }
      />
      <ScreenEmpty
        title="No screens available"
        description="This is what an account with no access looks like — not an error."
        action={
          <Button onClick={() => void logout()}>Sign out</Button>
        }
      />
    </Card>
  );
}
