'use client';

/**
 * One tenant, and the two things a platform admin does to it (Doc 09 §2.2):
 * decide what it may run, and hand it its first administrator. Those are steps
 * 2 and 3 of Doc 02 §3's provisioning sequence, which is why they are two tabs
 * of one screen rather than two screens.
 *
 * ## How the screen finds its tenant
 *
 * By walking the list. Doc 06 §5 has no `GET /iam/clients/:id`, and
 * `clients.controller.ts` says why: it would return exactly what the list
 * returns. So `findInPages` reads pages until the id turns up — the bounded read
 * `lib/paging.ts` explains. A `null` result is a genuine 404 for this console.
 *
 * ## One version counter, two tabs
 *
 * Enabling an application changes the `enabled_application_count` in the header,
 * which comes from the client row rather than from the toggle list. Rather than
 * thread a count upward, the toggles bump a version and the header reloads —
 * one cheap read, and no state that can disagree with itself.
 *
 * ## Suspension is the whole of the off switch
 *
 * There is no delete, and the header's action says what suspension does instead
 * (`components/clients/copy.ts`). Worth reading before assuming it is total: it
 * is enforced at session creation, so it stops new logins immediately while
 * sessions already open run to their expiry.
 */

import type { ClientDTO } from '@plantops/contracts';
import { ClientStatus } from '@plantops/contracts';
import { PageHeader, ScreenLoading, StatusTag } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { Alert, Button, Result, Space, Tabs, Tooltip, Typography } from 'antd';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useState, type ReactElement } from 'react';

import { AdminCreate } from '../../../../components/clients/admin-create';
import { AppToggles } from '../../../../components/clients/app-toggles';
import { ClientFormModal } from '../../../../components/clients/client-form-modal';
import { SUSPENSION_CONSEQUENCES } from '../../../../components/clients/copy';
import { ScreenFailure } from '../../../../components/screen-failure';
import { PLATFORM_PERMISSIONS as P } from '../../../../lib/iam-permissions';
import { findInPages } from '../../../../lib/paging';
import { usePermission } from '../../../../lib/use-permission';

export default function ClientDetailPage(): ReactElement {
  const params = useParams<{ id: string }>();
  const clientId = params.id;

  const iam = useIam();
  const router = useRouter();
  const notices = useNotices();

  const canUpdate = usePermission(P.CLIENT_UPDATE);

  /** Bumped by the toggles, so the header's enabled count reloads. */
  const [version, setVersion] = useState(0);
  const onChanged = useCallback(() => setVersion((n) => n + 1), []);

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const client = useAsync(
    () =>
      findInPages<ClientDTO>(
        (query) => iam.clients.list(query),
        (row) => row.id === clientId,
      ),
    [iam, clientId, version],
  );

  const tenant = client.data ?? null;

  const setStatus = useCallback(
    async (status: ClientStatus): Promise<void> => {
      if (tenant === null) return;
      if (status === ClientStatus.SUSPENDED) {
        const confirmed = await notices.confirm({
          title: `Suspend ${tenant.name}?`,
          content: SUSPENSION_CONSEQUENCES,
          okText: 'Suspend',
          danger: true,
        });
        if (!confirmed) return;
      }

      setBusy(true);
      try {
        await iam.clients.update(tenant.id, { status });
        notices.success(
          status === ClientStatus.ACTIVE
            ? `${tenant.name} is active. Its users can sign in again.`
            : `${tenant.name} is suspended. Its users can no longer sign in.`,
        );
        client.reload();
      } catch (error) {
        notices.error(error);
      } finally {
        setBusy(false);
      }
    },
    [tenant, iam, notices, client],
  );

  const backToList = (
    <Button onClick={() => router.push('/platform/clients')}>Back to clients</Button>
  );

  if (client.loading && client.data === undefined) return <ScreenLoading rows={5} />;

  if (client.error !== null) {
    return (
      <ScreenFailure
        error={client.error}
        onRetry={client.reload}
        action={backToList}
      />
    );
  }

  if (tenant === null) {
    return (
      <Result
        status="404"
        title="No such tenant"
        subTitle="It is not in the registry. It may never have been created, or the link may be stale."
        extra={backToList}
      />
    );
  }

  const suspended = tenant.status === ClientStatus.SUSPENDED;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { title: 'Clients', href: '/platform/clients' },
          { title: tenant.name },
        ]}
        title={
          <Space size="middle" wrap>
            <span>{tenant.name}</span>
            <StatusTag status={tenant.status} />
          </Space>
        }
        description={
          <Space direction="vertical" size={4}>
            <Typography.Text
              type="secondary"
              copyable={{ text: tenant.slug }}
              style={{ fontFamily: 'var(--ant-font-family-code)' }}
            >
              {tenant.slug}
            </Typography.Text>
            <span>
              {tenant.enabled_application_count} application
              {tenant.enabled_application_count === 1 ? '' : 's'} enabled
            </span>
          </Space>
        }
        actions={
          canUpdate && (
            <>
              <Button onClick={() => setEditing(true)}>Edit</Button>
              <Tooltip
                title={
                  suspended
                    ? 'Restores sign-in for this tenant’s users.'
                    : 'Stops new sign-ins immediately. Nothing they own is deleted.'
                }
              >
                <Button
                  danger={!suspended}
                  loading={busy}
                  onClick={() =>
                    void setStatus(
                      suspended ? ClientStatus.ACTIVE : ClientStatus.SUSPENDED,
                    )
                  }
                >
                  {suspended ? 'Reactivate' : 'Suspend'}
                </Button>
              </Tooltip>
            </>
          )
        }
      />

      {suspended && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBlockEnd: 16 }}
          message="This tenant is suspended"
          description="Its users cannot sign in. Everything below still works — you can enable applications and create administrators — but none of it takes effect for them until the tenant is reactivated."
        />
      )}

      <Tabs
        defaultActiveKey="applications"
        destroyOnHidden
        items={[
          {
            key: 'applications',
            label: 'Applications',
            children: <AppToggles client={tenant} onChanged={onChanged} />,
          },
          {
            key: 'admins',
            label: 'Administrators',
            children: <AdminCreate client={tenant} />,
          },
        ]}
      />

      <ClientFormModal
        open={editing}
        client={tenant}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          client.reload();
        }}
      />
    </>
  );
}
