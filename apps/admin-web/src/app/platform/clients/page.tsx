'use client';

/**
 * The tenant list (Doc 09 §2.2, Doc 06 §5).
 *
 * Every organisation the platform serves, what state each is in, and how much of
 * the product each has been given. Doc 09 §2.2 asks for exactly those three
 * columns, and `ClientDTO.enabled_application_count` exists so the third one
 * does not cost a request per row.
 *
 * ## Suspend is the off switch, and there is no delete
 *
 * Doc 01 §3.4 gives a tenant two states and neither is `deleted`. Suspension is
 * enforced where it matters — migration 0012's `auth_begin_session` re-checks
 * `client.status` at the moment a session is created, so a suspended tenant's
 * users cannot log in — while every scope node, role, binding and audit row it
 * owns stays exactly where it was. Deleting a client would take an
 * organisation's entire access history with it, and `on delete restrict` on
 * every child table makes sure nobody does it by accident.
 *
 * So the row action is a status toggle, and the confirmation says what it does
 * (stops logins now) and what it does not (touch anything they own).
 */

import type { ClientDTO } from '@plantops/contracts';
import { ClientStatus } from '@plantops/contracts';
import { DataTable, PageHeader, ScreenEmpty, StatusTag } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { PlusOutlined } from '@ant-design/icons';
import { Button, Tag, Tooltip, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useCallback, useState, type ReactElement } from 'react';

import { ClientFormModal } from '../../../components/clients/client-form-modal';
import { SUSPENSION_CONSEQUENCES } from '../../../components/clients/copy';
import { ScreenFailure } from '../../../components/screen-failure';
import { PLATFORM_PERMISSIONS as P } from '../../../lib/iam-permissions';
import { usePermission } from '../../../lib/use-permission';

export default function ClientsPage(): ReactElement {
  const iam = useIam();
  const router = useRouter();
  const notices = useNotices();

  const canCreate = usePermission(P.CLIENT_CREATE);
  const canUpdate = usePermission(P.CLIENT_UPDATE);

  const [query, setQuery] = useState({ page: 1, limit: 25 });
  const [creating, setCreating] = useState(false);
  /** Ids mid-flight, so two rows do not share one spinner. */
  const [busy, setBusy] = useState<readonly string[]>([]);

  const clients = useAsync(
    () => iam.clients.list(query),
    [iam, query.page, query.limit],
  );

  const setStatus = useCallback(
    async (client: ClientDTO, status: ClientStatus): Promise<void> => {
      if (status === ClientStatus.SUSPENDED) {
        const confirmed = await notices.confirm({
          title: `Suspend ${client.name}?`,
          content: SUSPENSION_CONSEQUENCES,
          okText: 'Suspend',
          danger: true,
        });
        if (!confirmed) return;
      }

      setBusy((ids) => [...ids, client.id]);
      try {
        await iam.clients.update(client.id, { status });
        notices.success(
          status === ClientStatus.ACTIVE
            ? `${client.name} is active. Its users can sign in again.`
            : `${client.name} is suspended. Its users can no longer sign in.`,
        );
        clients.reload();
      } catch (error) {
        notices.error(error);
      } finally {
        setBusy((ids) => ids.filter((id) => id !== client.id));
      }
    },
    [iam, notices, clients],
  );

  const columns = [
    {
      title: 'Slug',
      dataIndex: 'slug',
      width: 200,
      render: (slug: string) => (
        <Typography.Text style={{ fontFamily: 'var(--ant-font-family-code)' }}>
          {slug}
        </Typography.Text>
      ),
    },
    {
      title: 'Name',
      dataIndex: 'name',
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 130,
      render: (status: string) => <StatusTag status={status} />,
    },
    {
      title: 'Applications',
      dataIndex: 'enabled_application_count',
      width: 140,
      render: (count: number) => (
        <Tooltip
          title={
            count === 0
              ? 'This tenant has nothing enabled, so its users would see an empty console.'
              : undefined
          }
        >
          <Tag color={count === 0 ? 'default' : 'blue'} style={{ marginInlineEnd: 0 }}>
            {count} enabled
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '',
      key: 'status-action',
      width: 130,
      render: (_: unknown, row: ClientDTO) => {
        const suspended = row.status === ClientStatus.SUSPENDED;
        return (
          // Disabled rather than hidden: a column that vanishes for some rows
          // and not others is the layout case `usePermission` calls out.
          <Tooltip
            title={canUpdate ? undefined : `You do not hold ${P.CLIENT_UPDATE}.`}
          >
            <Button
              size="small"
              danger={!suspended}
              disabled={!canUpdate}
              loading={busy.includes(row.id)}
              onClick={(event) => {
                event.stopPropagation();
                void setStatus(
                  row,
                  suspended ? ClientStatus.ACTIVE : ClientStatus.SUSPENDED,
                );
              }}
            >
              {suspended ? 'Reactivate' : 'Suspend'}
            </Button>
          </Tooltip>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Clients"
        description="Every organisation the platform serves. Open one to choose which applications it may run and to create its first administrator."
        actions={
          canCreate && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreating(true)}
            >
              Create tenant
            </Button>
          )
        }
      />

      <DataTable<ClientDTO>
        result={clients.data}
        loading={clients.loading}
        columns={columns}
        rowKey={(row) => row.id}
        onQueryChange={setQuery}
        onRowClick={(row) => router.push(`/platform/clients/${row.id}`)}
        empty={
          <ScreenEmpty
            title="No tenants yet"
            description="A tenant is created, given the applications it may run, and handed its first administrator. After that it runs itself."
            action={
              canCreate && (
                <Button type="primary" onClick={() => setCreating(true)}>
                  Create the first tenant
                </Button>
              )
            }
          />
        }
        error={
          clients.error === null || clients.loading ? undefined : (
            <ScreenFailure error={clients.error} onRetry={clients.reload} />
          )
        }
      />

      <ClientFormModal
        open={creating}
        client={null}
        onCancel={() => setCreating(false)}
        onSaved={(created) => {
          setCreating(false);
          // Straight into the detail screen: a bare tenant has no applications
          // and no administrator, and neither of those is optional (Doc 02 §3
          // steps 2–3).
          router.push(`/platform/clients/${created.id}`);
        }}
      />
    </>
  );
}
