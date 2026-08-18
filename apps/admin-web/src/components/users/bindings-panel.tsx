'use client';

/**
 * What this person can actually do, and where (Doc 09 §3.3, Doc 01 §4.5).
 *
 * A binding is WHO × role × WHERE, and this panel is the WHO side of it: the
 * roles this user holds, each at a node of the org tree, each covering that node
 * and everything beneath it (Doc 04 §4). It is the only place in the console
 * that answers "why can this person see Plant B" without going to the grants
 * screen and filtering.
 *
 * ## Expired grants are listed, not hidden
 *
 * Resolution ignores a lapsed binding (Doc 04 §4) but the row stays in the
 * table, and "why did this stop working on Friday" is a question only the row
 * can answer. So they sort last, are marked, and are counted separately — the
 * difference between what someone *holds* and what *resolves* is exactly the
 * thing an administrator is debugging when they open this panel.
 *
 * ## It reads, and points at where writing happens
 *
 * Granting and revoking are Session 35's screen (`/admin/access`, Doc 09 §3.4),
 * because the scope picker belongs beside the choice of role and subject rather
 * than inside a profile. This panel links there instead of growing a second,
 * narrower version of the same form.
 */

import type { UserBindingDTO } from '@plantops/contracts';
import { ScreenEmpty, StatusTag, spacing } from '@plantops/ui';
import { Card, Space, Table, Tooltip, Typography } from 'antd';
import { useMemo, type ReactElement } from 'react';

import { sortBindings, summarizeBindings } from '../../lib/users';

export interface BindingsPanelProps {
  bindings: readonly UserBindingDTO[];
  /** Sent to the access screen — "grant this person something". */
  onAssignAccess?: () => void;
}

export function BindingsPanel({
  bindings,
  onAssignAccess,
}: BindingsPanelProps): ReactElement {
  const rows = useMemo(() => sortBindings(bindings), [bindings]);
  const summary = useMemo(() => summarizeBindings(bindings), [bindings]);

  const columns = [
    {
      title: 'Role',
      dataIndex: 'role_name',
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    {
      title: 'Where it applies',
      key: 'scope',
      render: (_: unknown, row: UserBindingDTO) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{row.scope_node_name}</Typography.Text>
          <Tooltip title="The materialised path. Its labels come from node ids, never from names — which is why renaming a node cannot move a grant.">
            <Typography.Text
              type="secondary"
              ellipsis
              style={{
                fontFamily: 'var(--ant-font-family-code)',
                fontSize: 11,
                maxWidth: 320,
              }}
            >
              {row.scope_node_path}
            </Typography.Text>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: 'Expiry',
      key: 'expiry',
      width: 220,
      render: (_: unknown, row: UserBindingDTO) => {
        if (row.expires_at === null) {
          return <Typography.Text type="secondary">No expiry</Typography.Text>;
        }
        return (
          <Space size="small" wrap>
            <StatusTag
              status={row.expired ? 'expired' : 'expiring'}
              label={row.expired ? 'Expired' : 'Expires'}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {new Date(row.expires_at).toLocaleString()}
            </Typography.Text>
          </Space>
        );
      },
    },
  ];

  return (
    <Card
      size="small"
      title={
        <Space size="small" wrap>
          <span>Access</span>
          <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
            {summary.live} grant{summary.live === 1 ? '' : 's'} in effect
            {summary.expired > 0 && `, ${summary.expired} lapsed`}
          </Typography.Text>
        </Space>
      }
      extra={
        onAssignAccess !== undefined && (
          <Typography.Link onClick={onAssignAccess}>Assign access</Typography.Link>
        )
      }
      styles={{ body: { paddingBlock: spacing.xs } }}
    >
      {rows.length === 0 ? (
        <ScreenEmpty
          title="No access yet"
          description="This person can sign in but can do nothing: a role grants something only once it is bound to them at a node of the org tree."
        />
      ) : (
        <Table<UserBindingDTO>
          dataSource={rows}
          columns={columns}
          rowKey={(row) => row.id}
          pagination={false}
          size="small"
          rowClassName={(row) => (row.expired ? 'plantops-row-muted' : '')}
        />
      )}
    </Card>
  );
}
