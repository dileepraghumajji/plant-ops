'use client';

/**
 * What stands behind a nav route whose screen has not been built yet.
 *
 * Temporary — see `lib/pending-screens.ts` — but not inert. It performs the
 * read the finished screen will perform, which makes it the thing that proves
 * two of Session 27's acceptance criteria before any of the screens exist:
 *
 * - **A deep link into a hidden route still calls the API and renders the 403
 *   cleanly** (Doc 09 §4). A client admin opening `/platform/clients` gets a
 *   real `PERMISSION_DENIED` from a real request, rendered as an explanation
 *   rather than as a blank page or a thrown exception.
 * - **The shell works end to end.** Sidebar → route → authenticated request →
 *   response, with the token attached and the error mapped, on every one of the
 *   twelve routes the catalog offers.
 *
 * A route with no entry at all renders "not found" rather than 404-ing, because
 * a nav catalog can legitimately point at a screen this build does not have —
 * an application registered ahead of its console.
 */

import { PageHeader, ScreenError, ScreenLoading } from '@plantops/ui';
import { describeError, useAsync, useIam } from '@plantops/web-kit';
import { Alert, Card, Result, Space, Statistic, Typography } from 'antd';
import { usePathname } from 'next/navigation';
import type { ReactElement } from 'react';

import { pendingScreenFor } from '../lib/pending-screens';

export function PendingScreenPage(): ReactElement {
  const pathname = usePathname();
  const iam = useIam();
  const screen = pendingScreenFor(pathname);

  const probe = useAsync(
    async () => (screen === null ? null : screen.probe(iam)),
    [iam, pathname],
    { enabled: screen !== null },
  );

  if (screen === null) {
    return (
      <Result
        status="404"
        title="No screen here"
        subTitle={
          <>
            The navigation catalog points at <code>{pathname}</code>, but this
            build of the console has no screen for it.
          </>
        }
      />
    );
  }

  return (
    <>
      <PageHeader title={screen.title} description={screen.description} />

      <Card>
        {probe.loading && <ScreenLoading rows={2} />}

        {!probe.loading && probe.error !== null && (
          // The real refusal, rendered. This is the 403 path.
          <ProbeFailure error={probe.error} onRetry={probe.reload} />
        )}

        {!probe.loading && probe.error === null && (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Alert
              type="success"
              showIcon
              message="You have access to this screen"
              description="The console called the API this screen will use, with your token, and the server allowed it."
            />
            <Statistic title="Currently in the API" value={probe.data ?? '—'} />
            <Typography.Text type="secondary">
              The screen itself is built in {screen.session}.
            </Typography.Text>
          </Space>
        )}
      </Card>
    </>
  );
}

/**
 * Whatever the request threw, explained.
 *
 * `describeError` flattens the three cases a `catch` here can see — the IAM
 * refused, the request never arrived, or something in this code went wrong —
 * into one shape, so the panel does not need an `instanceof` ladder.
 */
function ProbeFailure({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): ReactElement {
  const described = describeError(error);
  return (
    <ScreenError
      copy={described.copy}
      detail={described.detail}
      requestId={described.requestId}
      details={described.details}
      onRetry={onRetry}
    />
  );
}
