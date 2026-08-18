'use client';

/**
 * Roles — the WHAT dimension (Doc 09 §3.2, Doc 06 §7, Doc 01 §4.2).
 *
 * A role is a bag of permissions with a name. It grants nothing on its own: a
 * grant is WHO × role × WHERE (Doc 01 §4.5), and until someone is bound to it at
 * a scope node this list is a set of definitions. The header says so, because a
 * tenant administrator who creates a role and expects access to change is asking
 * the wrong screen.
 *
 * ## The two counts are the reason the list is worth reading
 *
 * `permission_count` says how much a role carries and `bound_subject_count` how
 * many people carry it — Doc 09 §3.2's columns, and both on `RoleDTO` so the
 * list costs one request. The second is also the delete warning: deleting a role
 * cascades its bindings, so the number of subjects is the number of people whose
 * access changes.
 *
 * ## System roles
 *
 * `Client Admin` arrives with the tenant's first administrator and is marked
 * `is_system`: it cannot be renamed or deleted, because a tenant that could
 * delete the role granting it administration could lock itself out. Its
 * *permissions* are set through the ordinary editor, since a system role with no
 * way to be given permissions would be a role that can never do anything.
 */

import type { RoleDTO } from '@plantops/contracts';
import { DataTable, PageHeader, ScreenEmpty, StatusTag } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { PlusOutlined } from '@ant-design/icons';
import { Button, Space, Tag, Tooltip, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useCallback, useState, type ReactElement } from 'react';

import { RoleFormModal } from '../../../components/roles/role-form-modal';
import { ScreenFailure } from '../../../components/screen-failure';
import { CLIENT_PERMISSIONS as P } from '../../../lib/iam-permissions';
import { usePermission } from '../../../lib/use-permission';

export default function RolesPage(): ReactElement {
  const iam = useIam();
  const router = useRouter();
  const notices = useNotices();

  const canCreate = usePermission(P.ROLE_CREATE);
  const canDelete = usePermission(P.ROLE_DELETE);

  const [query, setQuery] = useState({ page: 1, limit: 25 });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<readonly string[]>([]);

  const roles = useAsync(() => iam.roles.list(query), [iam, query.page, query.limit]);

  const remove = useCallback(
    async (role: RoleDTO): Promise<void> => {
      const confirmed = await notices.confirm({
        title: `Delete “${role.name}”?`,
        content:
          role.bound_subject_count === 0
            ? 'Nobody holds this role, so nothing loses access. The role and its permission mappings go.'
            : `${role.bound_subject_count} subject${
                role.bound_subject_count === 1 ? '' : 's'
              } currently hold this role. Deleting it removes every one of those grants — each recorded in the audit trail — and they lose whatever this role carried, wherever they held it.`,
        okText: 'Delete role',
        danger: true,
      });
      if (!confirmed) return;

      setBusy((ids) => [...ids, role.id]);
      try {
        await iam.roles.remove(role.id);
        notices.success(`“${role.name}” deleted.`);
        if (role.bound_subject_count > 0) notices.accessChanged();
        roles.reload();
      } catch (error) {
        notices.error(error);
      } finally {
        setBusy((ids) => ids.filter((id) => id !== role.id));
      }
    },
    [iam, notices, roles],
  );

  const columns = [
    {
      title: 'Role',
      dataIndex: 'name',
      render: (name: string, row: RoleDTO) => (
        <Space direction="vertical" size={0}>
          <Space size="small" wrap>
            <Typography.Text strong>{name}</Typography.Text>
            {row.is_system && <StatusTag status="system" tone="neutral" label="System" />}
          </Space>
          {row.description !== null && row.description !== '' && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.description}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Permissions',
      dataIndex: 'permission_count',
      width: 140,
      render: (count: number) => (
        <Tooltip
          title={
            count === 0
              ? 'This role carries nothing, so holding it grants nothing.'
              : undefined
          }
        >
          <Tag color={count === 0 ? 'default' : 'blue'} style={{ marginInlineEnd: 0 }}>
            {count}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: 'Held by',
      dataIndex: 'bound_subject_count',
      width: 140,
      render: (count: number) => (
        <Tooltip title="People and machine identities bound to this role, anywhere in the org tree.">
          <Tag color={count === 0 ? 'default' : 'geekblue'} style={{ marginInlineEnd: 0 }}>
            {count}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: unknown, row: RoleDTO) => (
        <Tooltip
          title={
            row.is_system
              ? 'A system role cannot be deleted — it is what grants administration here.'
              : canDelete
                ? undefined
                : `You do not hold ${P.ROLE_DELETE}.`
          }
        >
          <Button
            size="small"
            danger
            disabled={row.is_system || !canDelete}
            loading={busy.includes(row.id)}
            onClick={(event) => {
              event.stopPropagation();
              void remove(row);
            }}
          >
            Delete
          </Button>
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Roles"
        description="What access looks like, before anyone has it. A role is a set of permissions; someone gains them only when they are bound to it at a node of the org tree."
        actions={
          canCreate && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreating(true)}
            >
              Create role
            </Button>
          )
        }
      />

      <DataTable<RoleDTO>
        result={roles.data}
        loading={roles.loading}
        columns={columns}
        rowKey={(row) => row.id}
        onQueryChange={setQuery}
        onRowClick={(row) => router.push(`/admin/roles/${row.id}`)}
        empty={
          <ScreenEmpty
            title="No roles yet"
            description="Create one for each job in your organisation — Gate Supervisor, Weighbridge Operator — then choose what it carries and who holds it."
            action={
              canCreate && (
                <Button type="primary" onClick={() => setCreating(true)}>
                  Create the first role
                </Button>
              )
            }
          />
        }
        error={
          roles.error === null || roles.loading ? undefined : (
            <ScreenFailure error={roles.error} onRetry={roles.reload} />
          )
        }
      />

      <RoleFormModal
        open={creating}
        role={null}
        onCancel={() => setCreating(false)}
        onSaved={(created) => {
          setCreating(false);
          // Straight into the editor: a role with no permissions carries
          // nothing, and choosing them is what the operator came to do.
          router.push(`/admin/roles/${created.id}`);
        }}
      />
    </>
  );
}
