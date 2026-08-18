'use client';

/**
 * Users by Role — who holds a role, and where (Doc 09 §3.3, Doc 06 §8).
 *
 * The mirror of the profile's bindings panel. That one asks "what can this
 * person do"; this asks "who can do this", and the answer is only useful with
 * the *where* attached: a role held at Plant B is a different fact from the same
 * role held at the group root, and a list of names without scopes would flatten
 * the whole WHERE dimension out of the answer.
 *
 * ## One row per person, not per binding
 *
 * `GET /iam/users/by-role/:roleId` gathers every scope a holder has the role at
 * into `scopes`, so somebody granted it at four plants is one row of the answer
 * and not four — and the pagination total counts people, which is what a number
 * under a role picker has to mean.
 *
 * ## Expired grants are shown, flagged
 *
 * A holder all of whose grants have lapsed still appears, every entry marked.
 * Resolution ignores them (Doc 04 §4), so the row is the difference between
 * "held" and "in effect" — which is exactly what somebody auditing a role is
 * looking for.
 */

import type { RoleDTO, UserByRoleDTO } from '@plantops/contracts';
import { DataTable, PageHeader, ScreenEmpty, StatusTag } from '@plantops/ui';
import { useAsync, useIam } from '@plantops/web-kit';
import { Alert, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';

import { collectPages } from '../../lib/paging';
import { ScreenFailure } from '../screen-failure';

export function UsersByRole(): ReactElement {
  const iam = useIam();
  const router = useRouter();

  const [roleId, setRoleId] = useState<string | null>(null);
  const [query, setQuery] = useState({ page: 1, limit: 25 });

  // Every role, not a page of them: the picker's job is to let an administrator
  // choose the role they can already name, and a tenant has tens of roles.
  const roles = useAsync(
    () => collectPages<RoleDTO>((page) => iam.roles.list(page)),
    [iam],
  );

  const holders = useAsync(
    () => (roleId === null ? Promise.resolve(undefined) : iam.users.byRole(roleId, query)),
    [iam, roleId, query.page, query.limit],
    { enabled: roleId !== null },
  );

  const role = roles.data?.find((entry) => entry.id === roleId) ?? null;

  const columns = [
    {
      title: 'Person',
      dataIndex: 'full_name',
      render: (name: string, row: UserByRoleDTO) => (
        <Space direction="vertical" size={0}>
          <Space size="small" wrap>
            <Typography.Text strong>{name}</Typography.Text>
            <StatusTag status={row.status} />
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.email}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Where they hold it',
      key: 'scopes',
      render: (_: unknown, row: UserByRoleDTO) => (
        <Space size={[4, 4]} wrap>
          {row.scopes.map((scope) => (
            <Tooltip
              key={scope.binding_id}
              title={
                scope.expired
                  ? `Lapsed ${new Date(scope.expires_at as string).toLocaleString()} — held, but granting nothing.`
                  : scope.expires_at === null
                    ? 'No expiry. Covers this node and everything beneath it.'
                    : `Expires ${new Date(scope.expires_at).toLocaleString()}.`
              }
            >
              <Tag
                color={scope.expired ? 'default' : 'geekblue'}
                style={{ marginInlineEnd: 0, opacity: scope.expired ? 0.6 : 1 }}
              >
                {scope.scope_node_name}
                {scope.expired && ' · lapsed'}
              </Tag>
            </Tooltip>
          ))}
        </Space>
      ),
    },
  ];

  if (roles.error !== null) {
    return <ScreenFailure error={roles.error} onRetry={roles.reload} />;
  }

  return (
    <>
      <PageHeader
        title="Users by role"
        description="Who holds a role, and at which part of the organisation. A grant covers the node it was made at and everything beneath it, so where it was made is half the answer."
        footer={
          <Select<string>
            showSearch
            optionFilterProp="label"
            placeholder="Choose a role"
            loading={roles.loading}
            value={roleId ?? undefined}
            onChange={(next) => {
              setRoleId(next);
              setQuery((current) => ({ ...current, page: 1 }));
            }}
            style={{ width: 360 }}
            options={(roles.data ?? []).map((entry) => ({
              value: entry.id,
              label: entry.name,
            }))}
          />
        }
      />

      {roleId === null ? (
        <ScreenEmpty
          title="Pick a role"
          description="Choose one above to see everyone who holds it and where."
        />
      ) : holders.error !== null ? (
        <ScreenFailure error={holders.error} onRetry={holders.reload} />
      ) : (
        <>
          {role !== null && role.permission_count === 0 && (
            <Alert
              type="info"
              showIcon
              style={{ marginBlockEnd: 16 }}
              message={`“${role.name}” carries no permissions`}
              description="Everyone below holds it, and holding it grants nothing until the role is given something to carry."
            />
          )}

          <DataTable<UserByRoleDTO>
            result={holders.data}
            loading={holders.loading}
            columns={columns}
            rowKey={(row) => row.id}
            onQueryChange={setQuery}
            onRowClick={(row) => router.push(`/admin/users/${row.id}`)}
            empty={
              <ScreenEmpty
                title="Nobody holds this role"
                description="It exists and carries whatever it carries, but nobody has been bound to it yet — so it grants nothing to anyone."
              />
            }
          />
        </>
      )}
    </>
  );
}
