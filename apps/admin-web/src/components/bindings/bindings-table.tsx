'use client';

/**
 * Every grant in the tenant, filterable, with unbind (Doc 09 §3.4, Doc 06 §9).
 *
 * The review half of the access screen. A row is one complete sentence — this
 * subject holds this role at this node — so the table renders all three and
 * never a bare uuid; `RoleBindingDTO` joins the names in for exactly that reason.
 *
 * ## What the scope filter means, and what it does not
 *
 * `?scope_node_id=` matches the node a grant is **anchored to**, not the subtree
 * it covers. "What was granted here" and "who can act here" are different
 * questions and only the first is a list of rows — the second is
 * `POST /iam/permissions/check`, which answers it for one subject rather than by
 * enumerating. The hint under the filter says so, because a screen that let the
 * filter be read as the second question would quietly under-report access.
 *
 * ## Expired grants stay
 *
 * They grant nothing (Doc 04 §4) and they are still the answer to "why did this
 * stop working on Friday". Dimmed, flagged, and still unbindable — removing a
 * lapsed row is tidying rather than revoking, and the confirmation says which of
 * the two the operator is doing.
 */

import type { RoleBindingDTO, RoleDTO, ScopeNodeDTO } from '@plantops/contracts';
import { DataTable, ScopeTreeSelect, ScreenEmpty, StatusTag } from '@plantops/ui';
import { useIam, useNotices } from '@plantops/web-kit';
import { Button, Card, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useState, type ReactElement } from 'react';

import {
  NO_FILTERS,
  hasFilters,
  unbindConsequences,
  type BindingFilters,
  type SubjectOption,
} from '../../lib/bindings';
import { CLIENT_PERMISSIONS as P } from '../../lib/iam-permissions';
import { usePermission } from '../../lib/use-permission';
import { ScreenFailure } from '../screen-failure';
import type { AsyncState } from '@plantops/web-kit';
import type { Paginated } from '@plantops/contracts';

export interface BindingsTableProps {
  bindings: AsyncState<Paginated<RoleBindingDTO>>;
  filters: BindingFilters;
  onFiltersChange: (filters: BindingFilters) => void;
  onQueryChange: (query: { page: number; limit: number }) => void;
  /** The same subject list the wizard offers, so the two filters agree. */
  subjects: readonly SubjectOption[];
  roles: readonly RoleDTO[];
  tree: readonly ScopeNodeDTO[];
  /** Re-reads after an unbind. */
  onChanged: () => void;
}

export function BindingsTable({
  bindings,
  filters,
  onFiltersChange,
  onQueryChange,
  subjects,
  roles,
  tree,
  onChanged,
}: BindingsTableProps): ReactElement {
  const iam = useIam();
  const notices = useNotices();
  const canDelete = usePermission(P.BINDING_DELETE);

  const [busy, setBusy] = useState<readonly string[]>([]);

  const unbind = useCallback(
    async (binding: RoleBindingDTO): Promise<void> => {
      const confirmed = await notices.confirm({
        title: binding.expired ? 'Remove this lapsed grant?' : 'Remove this access?',
        content: unbindConsequences(binding),
        okText: binding.expired ? 'Remove' : 'Revoke access',
        danger: !binding.expired,
      });
      if (!confirmed) return;

      setBusy((ids) => [...ids, binding.id]);
      try {
        await iam.roleBindings.remove(binding.id);
        notices.success('Access removed.');
        if (!binding.expired) notices.accessChanged();
        onChanged();
      } catch (error) {
        notices.error(error);
      } finally {
        setBusy((ids) => ids.filter((id) => id !== binding.id));
      }
    },
    [iam, notices, onChanged],
  );

  const columns = [
    {
      title: 'Who',
      key: 'subject',
      render: (_: unknown, row: RoleBindingDTO) => (
        <Space direction="vertical" size={0}>
          <Space size="small" wrap>
            <Typography.Text strong>{row.subject_name}</Typography.Text>
            {row.subject_type === 'service' && (
              <Tag style={{ marginInlineEnd: 0 }}>Machine</Tag>
            )}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.subject_email ?? 'Machine identity'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Holds',
      dataIndex: 'role_name',
      render: (name: string) => <Typography.Text>{name}</Typography.Text>,
    },
    {
      title: 'Where',
      key: 'scope',
      render: (_: unknown, row: RoleBindingDTO) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{row.scope_node_name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            and everything beneath it
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Until',
      key: 'expiry',
      width: 210,
      render: (_: unknown, row: RoleBindingDTO) =>
        row.expires_at === null ? (
          <Typography.Text type="secondary">No expiry</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            <StatusTag
              status={row.expired ? 'expired' : 'expiring'}
              label={row.expired ? 'Lapsed' : 'Expires'}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {new Date(row.expires_at).toLocaleString()}
            </Typography.Text>
          </Space>
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_: unknown, row: RoleBindingDTO) => (
        <Tooltip title={canDelete ? undefined : `You do not hold ${P.BINDING_DELETE}.`}>
          <Button
            size="small"
            danger={!row.expired}
            disabled={!canDelete}
            loading={busy.includes(row.id)}
            onClick={() => void unbind(row)}
          >
            {row.expired ? 'Remove' : 'Unbind'}
          </Button>
        </Tooltip>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title="Who holds what, and where"
      extra={
        hasFilters(filters) && (
          <Button size="small" onClick={() => onFiltersChange(NO_FILTERS)}>
            Clear filters
          </Button>
        )
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space size="middle" align="start" wrap>
          <Select<string>
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Any subject"
            value={filters.subject ?? undefined}
            onChange={(value) => onFiltersChange({ ...filters, subject: value ?? null })}
            style={{ width: 240 }}
            options={subjects.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          />

          <Select<string>
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Any role"
            value={filters.roleId ?? undefined}
            onChange={(value) => onFiltersChange({ ...filters, roleId: value ?? null })}
            style={{ width: 220 }}
            options={roles.map((role) => ({ value: role.id, label: role.name }))}
          />

          <Space direction="vertical" size={2}>
            <div style={{ width: 280 }}>
              <ScopeTreeSelect
                tree={tree}
                value={filters.scopeNodeId}
                onChange={(value) => onFiltersChange({ ...filters, scopeNodeId: value })}
                placeholder="Any scope node"
              />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 11, maxWidth: 280 }}>
              Matches grants made <em>at</em> that node — not everyone whose access
              reaches it.
            </Typography.Text>
          </Space>
        </Space>

        <DataTable<RoleBindingDTO>
          result={bindings.data}
          loading={bindings.loading}
          columns={columns}
          rowKey={(row) => row.id}
          onQueryChange={onQueryChange}
          size="small"
          tableProps={{
            rowClassName: (row) => (row.expired ? 'plantops-row-muted' : ''),
          }}
          empty={
            <ScreenEmpty
              title={hasFilters(filters) ? 'Nothing matches' : 'Nobody has access yet'}
              description={
                hasFilters(filters)
                  ? 'No grant matches every filter. Clear one and look again.'
                  : 'Until somebody is bound to a role at a node of the org tree, everyone in this organisation can sign in and do nothing.'
              }
            />
          }
          error={
            bindings.error === null || bindings.loading ? undefined : (
              <ScreenFailure error={bindings.error} onRetry={bindings.reload} />
            )
          }
        />
      </Space>
    </Card>
  );
}
