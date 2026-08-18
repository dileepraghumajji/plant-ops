'use client';

/**
 * *Menu permissions* — the gate (Doc 09 §2.1, Doc 01 §4.4, Doc 05 §3).
 *
 * The table that joins the other two tabs. A nav node with no mapped permission
 * is invisible to everyone unless it opted in with `is_public`; a node with
 * several is visible to anyone holding **any** of them, because
 * `menu_permission` is an OR (Doc 01 §4.4). That OR is the whole reason this is
 * a multi-select rather than a single choice: "Passes" should appear for the
 * clerk who may create one *and* the supervisor who may only approve.
 *
 * ## Why the whole permission list is loaded, not a page of it
 *
 * The picker's job is to let an operator find the permission they mean. A
 * paginated picker makes that a search through pages for a name they can
 * already recite, so the tab walks the list once (`lib/paging.ts` explains the
 * bound). One application's permission set is tens of rows.
 *
 * ## A save is a diff, in two calls
 *
 * `POST /…/nav-permissions` adds and `DELETE` removes, both idempotent and both
 * taking the same body. An unmap is not expressible as a map, so the removals
 * genuinely have to be computed — and since both endpoints audit only what
 * actually changed (`nav.service.ts`), sending the untouched pairs as well would
 * be asking the server to work out something this screen already knows.
 * `mappingChange` in `lib/nav-catalog.ts` is that calculation, tested on its own.
 */

import type { NavNodeCatalogDTO, PermissionDTO } from '@plantops/contracts';
import { PageHeader, ScreenEmpty, ScreenLoading, StatusTag } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import {
  Alert,
  Button,
  Card,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useMemo, useState, type ReactElement } from 'react';

import {
  flattenCatalog,
  isNoOpChange,
  mappingChange,
  reachabilityOf,
  type FlatNavNode,
} from '../../lib/nav-catalog';
import { PLATFORM_PERMISSIONS as P } from '../../lib/iam-permissions';
import { collectPages } from '../../lib/paging';
import { usePermission } from '../../lib/use-permission';
import { ScreenFailure } from '../screen-failure';

export interface MenuPermissionsTabProps {
  applicationId: string;
  version: number;
  onChanged: () => void;
}

export function MenuPermissionsTab({
  applicationId,
  version,
  onChanged,
}: MenuPermissionsTabProps): ReactElement {
  const iam = useIam();
  const canMap = usePermission(P.NAV_MAP);

  const [editing, setEditing] = useState<NavNodeCatalogDTO | null>(null);

  // Both halves in one request cycle: the table needs the tree and the picker
  // needs the permissions, and showing the table before the picker's options
  // exist would let an operator open a modal with an empty list.
  const catalog = useAsync(
    async () => {
      const [nav, permissions] = await Promise.all([
        iam.applications.navTree(applicationId),
        collectPages<PermissionDTO>((query) =>
          iam.applications.listPermissions(applicationId, query),
        ),
      ]);
      return { tree: nav.tree, permissions };
    },
    [iam, applicationId, version],
  );

  const rows = useMemo(
    () => flattenCatalog(catalog.data?.tree ?? []),
    [catalog.data],
  );

  const permissions = catalog.data?.permissions ?? [];

  const columns = [
    {
      title: 'Node',
      key: 'node',
      render: (_: unknown, row: FlatNavNode) => (
        <Space
          direction="vertical"
          size={0}
          style={{ paddingInlineStart: row.depth * 20 }}
        >
          <Space size="small">
            <Typography.Text>{row.node.label}</Typography.Text>
            {!row.node.is_active && <StatusTag status="inactive" />}
          </Space>
          <Typography.Text
            type="secondary"
            style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
          >
            {row.node.key}
            {row.node.route !== null && row.node.route !== ''
              ? ` · ${row.node.route}`
              : ''}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Requires',
      key: 'requires',
      render: (_: unknown, row: FlatNavNode) => (
        <RequiresCell node={row.node} />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_: unknown, row: FlatNavNode) =>
        canMap && (
          <Button size="small" onClick={() => setEditing(row.node)}>
            Edit mapping
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Menu permissions"
        description="Which permissions make each menu visible. Holding any one of them is enough — the mapping is an OR."
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBlockEnd: 16 }}
        message="Containers are not mapped"
        description="A node with children is shown when any of its descendants is, and hidden when none are. Mapping applies to the leaves — the screens people actually open."
      />

      {catalog.loading && <ScreenLoading rows={4} />}

      {!catalog.loading && catalog.error !== null && (
        <ScreenFailure error={catalog.error} onRetry={catalog.reload} />
      )}

      {!catalog.loading && catalog.error === null && (
        <Card styles={{ body: { padding: 0 } }}>
          {/*
            antd's `Table` directly rather than `@plantops/ui`'s `DataTable`.
            That component exists to bind the Doc 06 §1 pagination envelope to a
            pager, and `GET /…/nav` is not paginated — it returns one
            application's whole tree, because a menu split across pages is not a
            menu. Synthesising an envelope to reuse the wrapper would be
            inventing a contract the endpoint does not have.
          */}
          <Table<FlatNavNode>
            dataSource={rows}
            columns={columns}
            rowKey={(row) => row.node.id}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <ScreenEmpty
                  title="No navigation to gate"
                  description="Add nodes on the Navigation tab first — a mapping needs something to map onto."
                />
              ),
            }}
          />
        </Card>
      )}

      {/*
        Keyed on the node, so opening a different row mounts a fresh form
        starting from *that* row's mapping. Without it the selection would have
        to be re-derived from props on every change of `editing`, which is the
        classic place a picker ends up showing the previous row's permissions.
      */}
      <EditMappingModal
        key={editing?.id ?? 'none'}
        applicationId={applicationId}
        node={editing}
        permissions={permissions}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          catalog.reload();
          onChanged();
        }}
      />
    </>
  );
}

/** The permissions gating one node, or the reason it is not gated. */
function RequiresCell({ node }: { node: NavNodeCatalogDTO }): ReactElement {
  const reachability = reachabilityOf(node);

  if (reachability === 'container') {
    return (
      <Typography.Text type="secondary">
        Derived from its children
      </Typography.Text>
    );
  }

  if (reachability === 'public') {
    return (
      <Tooltip title="Marked public, so it is visible to every authenticated subject without a permission (Doc 05 §3).">
        <Tag color="blue">Public</Tag>
      </Tooltip>
    );
  }

  if (reachability === 'unreachable') {
    return (
      <Tooltip title="No permission maps to it and it is not public, so no subject will ever see it.">
        <Tag color="gold">Not visible to anyone</Tag>
      </Tooltip>
    );
  }

  return (
    <Space size={[4, 4]} wrap>
      {node.requires.map((key) => (
        <Tag key={key} style={{ fontFamily: 'var(--ant-font-family-code)' }}>
          {key}
        </Tag>
      ))}
    </Space>
  );
}

function EditMappingModal({
  applicationId,
  node,
  permissions,
  onCancel,
  onSaved,
}: {
  applicationId: string;
  /** `null` closes it — the parent keys this component on the node's id. */
  node: NavNodeCatalogDTO | null;
  permissions: readonly PermissionDTO[];
  onCancel: () => void;
  onSaved: () => void;
}): ReactElement | null {
  const iam = useIam();
  const notices = useNotices();
  const [selected, setSelected] = useState<string[]>(node?.requires ?? []);
  const [submitting, setSubmitting] = useState(false);

  if (node === null) return null;

  const change = mappingChange(node.requires, selected);

  const options = permissions.map((permission) => ({
    value: permission.key,
    label: `${permission.key} — ${permission.name}`,
    // A deactivated permission still gates whatever it is mapped to, so it is
    // shown rather than hidden; it is just not something to reach for.
    disabled: !permission.is_active && !node.requires.includes(permission.key),
  }));

  const handleOk = async (): Promise<void> => {
    if (isNoOpChange(change)) {
      onCancel();
      return;
    }

    setSubmitting(true);
    try {
      // Removals first. If the second call fails, the node is left under-gated
      // rather than over-gated — a menu that disappeared is a visible,
      // reversible mistake, where one that stayed visible to people who should
      // not see it is a silent one.
      if (change.unmap.length > 0) {
        await iam.applications.unmapNavPermissions(applicationId, {
          mappings: [{ nav_key: node.key, permission_keys: change.unmap }],
        });
      }
      if (change.map.length > 0) {
        await iam.applications.mapNavPermissions(applicationId, {
          mappings: [{ nav_key: node.key, permission_keys: change.map }],
        });
      }

      // Doc 05 §6: a catalog edit bumps `app_nav_version`, and a subject's
      // cached tree is only rebuilt on their next navigation call — so the
      // change is real immediately but not necessarily on screen immediately.
      notices.accessChanged(
        'Mapping saved. Menus can take a few seconds to update for people already signed in.',
      );
      onSaved();
    } catch (error) {
      notices.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={`Permissions for ${node.label}`}
      okText="Save mapping"
      okButtonProps={{ disabled: isNoOpChange(change) }}
      confirmLoading={submitting}
      onOk={() => void handleOk()}
      onCancel={onCancel}
      destroyOnHidden
      width={640}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          A subject sees this menu if they hold <strong>any</strong> of the
          permissions below, anywhere in the org tree. Visibility is
          permission-based, not scope-based — where the permission applies
          filters the data inside the screen, not whether the menu appears.
        </Typography.Text>

        <Select
          mode="multiple"
          allowClear
          showSearch
          style={{ width: '100%' }}
          value={selected}
          onChange={setSelected}
          options={options}
          placeholder="Choose the permissions that reveal this menu"
          optionFilterProp="label"
        />

        {selected.length === 0 && !node.is_public && (
          <Alert
            type="warning"
            showIcon
            message="Nobody will see this menu"
            description="With no permission mapped and the node not public, it is hidden from every subject."
          />
        )}

        {node.is_public && (
          <Alert
            type="info"
            showIcon
            message="This node is public"
            description="It is visible to every authenticated subject regardless of the mapping below. Mapping still records the intent, but it does not gate anything while the node stays public."
          />
        )}

        {!isNoOpChange(change) && (
          <Space direction="vertical" size={4}>
            {change.map.length > 0 && (
              <Typography.Text type="secondary">
                Adding: {change.map.join(', ')}
              </Typography.Text>
            )}
            {change.unmap.length > 0 && (
              <Typography.Text type="secondary">
                Removing: {change.unmap.join(', ')}
              </Typography.Text>
            )}
          </Space>
        )}
      </Space>
    </Modal>
  );
}
