'use client';

/**
 * *Navigation* — the tree editor for an application's menus (Doc 09 §2.1,
 * Doc 01 §3.3, Doc 02 §2 step 3).
 *
 * This is the screen that makes Doc 02 §8 literal: "navigation is never a
 * static file — it is always resolved from `nav_node` + `menu_permission`". An
 * operator adds a node here and a subject who holds a mapped permission sees it
 * on their next navigation call. No deploy, no restart, no frontend release.
 *
 * ## Add only, and the tab says so
 *
 * Doc 06 §4 gives the nav catalog `POST` and `GET` and nothing else. There is no
 * `PATCH` and no `DELETE`, for the reason Doc 02 §7 gives: a catalog *changes*
 * by manifest upsert, which relabels in place and soft-deactivates what a
 * re-upload dropped — repeatable across environments and idempotent, which a
 * console's one-off edit is not. The manifest screen is Session 29. Until then
 * the honest thing is a form that adds, and a sentence saying where relabelling
 * and retirement live.
 *
 * ## What the tree shows that a plain label would not
 *
 * The three things that decide whether a node is reachable, per row: its kind,
 * whether it has a route at all, and how many permissions gate it. A menu built
 * correctly and mapped to nothing is invisible to everyone including its
 * author (Doc 05 §3), and that is the single most confusing state the catalog
 * has — so it is called out on the row rather than left to be discovered on the
 * mapping tab.
 */

import type { NavNodeCatalogDTO, NavNodeKind } from '@plantops/contracts';
import { NAV_NODE_KIND_VALUES, NavNodeKind as Kind } from '@plantops/contracts';
import { NavIcon, PageHeader, ScreenEmpty, ScreenLoading, knownIconKeys } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Tree,
  Typography,
} from 'antd';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';

import {
  defaultKindUnder,
  findCatalogNode,
  nextSortOrder,
  reachabilityOf,
  siblingsOf,
} from '../../lib/nav-catalog';
import { applyFieldIssues, formFieldIssues } from '../../lib/form-errors';
import { PLATFORM_PERMISSIONS as P } from '../../lib/iam-permissions';
import { usePermission } from '../../lib/use-permission';
import { ScreenFailure } from '../screen-failure';

/** How each kind reads in a tag. The enum values are snake_case. */
const KIND_LABEL: Readonly<Record<NavNodeKind, string>> = {
  [Kind.MODULE]: 'Module',
  [Kind.MENU]: 'Menu',
  [Kind.SUB_MENU]: 'Sub-menu',
};

export interface NavTreeEditorProps {
  applicationId: string;
  version: number;
  onChanged: () => void;
}

export function NavTreeEditor({
  applicationId,
  version,
  onChanged,
}: NavTreeEditorProps): ReactElement {
  const iam = useIam();
  const canCreate = usePermission(P.NAV_CREATE);

  /** The node a new child is being added under — `null` means top level. */
  const [addingUnder, setAddingUnder] = useState<{ parentId: string | null } | null>(
    null,
  );

  const catalog = useAsync(
    () => iam.applications.navTree(applicationId),
    [iam, applicationId, version],
  );

  const tree = useMemo(() => catalog.data?.tree ?? [], [catalog.data]);

  const treeData = useMemo(
    () => toTreeData(tree, canCreate ? (id) => setAddingUnder({ parentId: id }) : null),
    [tree, canCreate],
  );

  return (
    <>
      <PageHeader
        title="Navigation"
        description="The menus this application offers. What a given subject actually sees is this tree pruned to what their permissions reach."
        actions={
          canCreate && (
            <Button
              icon={<PlusOutlined />}
              onClick={() => setAddingUnder({ parentId: null })}
            >
              Add top-level node
            </Button>
          )
        }
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBlockEnd: 16 }}
        message="Nodes are added here and changed by manifest"
        description="Relabelling a node, changing its route, or retiring it is a manifest upsert — repeatable across environments and idempotent on re-upload. Adding one directly is for extending an application that is already live."
      />

      <Card>
        {catalog.loading && <ScreenLoading rows={4} />}

        {!catalog.loading && catalog.error !== null && (
          <ScreenFailure error={catalog.error} onRetry={catalog.reload} />
        )}

        {!catalog.loading && catalog.error === null && tree.length === 0 && (
          <ScreenEmpty
            title="No navigation yet"
            description="This application declares no menus, so it contributes nothing to anyone's sidebar."
            action={
              canCreate && (
                <Button
                  type="primary"
                  onClick={() => setAddingUnder({ parentId: null })}
                >
                  Add the first node
                </Button>
              )
            }
          />
        )}

        {!catalog.loading && catalog.error === null && tree.length > 0 && (
          <Tree
            treeData={treeData}
            defaultExpandAll
            selectable={false}
            blockNode
            // The catalog tree is remounted whenever it reloads, so
            // `defaultExpandAll` applies to the new shape rather than leaving a
            // freshly added child collapsed under a parent that was expanded
            // before it existed.
            key={`${applicationId}:${version}:${tree.length}`}
          />
        )}
      </Card>

      {/*
        Mounted only while it is open, rather than kept around with `open=false`.
        antd applies a `Form`'s `initialValues` to the store when the form
        instance is first initialised, so a modal that survives being closed
        would offer the *previous* parent's suggested kind and sort order the
        second time it was opened — which is exactly the field an operator
        would not think to re-check.
      */}
      {addingUnder !== null && (
        <AddNavNodeModal
          applicationId={applicationId}
          tree={tree}
          parentId={addingUnder.parentId}
          onCancel={() => setAddingUnder(null)}
          onAdded={() => {
            setAddingUnder(null);
            catalog.reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}

interface TreeDataNode {
  key: string;
  title: ReactNode;
  children?: TreeDataNode[];
}

function toTreeData(
  nodes: readonly NavNodeCatalogDTO[],
  onAddChild: ((parentId: string) => void) | null,
): TreeDataNode[] {
  return nodes.map((node) => ({
    key: node.id,
    title: <NavRowTitle node={node} onAddChild={onAddChild} />,
    ...(node.children.length > 0
      ? { children: toTreeData(node.children, onAddChild) }
      : {}),
  }));
}

function NavRowTitle({
  node,
  onAddChild,
}: {
  node: NavNodeCatalogDTO;
  onAddChild: ((parentId: string) => void) | null;
}): ReactElement {
  const reachability = reachabilityOf(node);

  return (
    <Space size="small" wrap style={{ paddingBlock: 2 }}>
      <NavIcon iconKey={node.icon} />
      <Typography.Text strong={node.kind === Kind.MODULE}>{node.label}</Typography.Text>
      <Tag>{KIND_LABEL[node.kind]}</Tag>
      <Typography.Text
        type="secondary"
        style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
      >
        {node.key}
      </Typography.Text>
      {node.route !== null && node.route !== '' && (
        <Typography.Text
          type="secondary"
          style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
        >
          {node.route}
        </Typography.Text>
      )}
      {!node.is_active && <Tag color="default">Inactive</Tag>}
      {reachability === 'gated' && (
        <Tooltip title={node.requires.join(', ')}>
          <Tag color="green">
            {node.requires.length} permission{node.requires.length === 1 ? '' : 's'}
          </Tag>
        </Tooltip>
      )}
      {reachability === 'public' && (
        <Tooltip title="Opted out of gating: visible to every authenticated subject (Doc 05 §3).">
          <Tag color="blue">Public</Tag>
        </Tooltip>
      )}
      {reachability === 'unreachable' && (
        <Tooltip title="No permission is mapped to it and it is not public, so nobody can see it. Map one on the Menu permissions tab.">
          <Tag color="gold">Not visible to anyone</Tag>
        </Tooltip>
      )}
      {onAddChild !== null && (
        <Button
          size="small"
          type="link"
          icon={<PlusOutlined />}
          onClick={() => onAddChild(node.id)}
        >
          Add child
        </Button>
      )}
    </Space>
  );
}

interface NavFormValues {
  parent_id: string | null;
  kind: NavNodeKind;
  key: string;
  label: string;
  route: string;
  icon: string | undefined;
  sort_order: number;
  is_public: boolean;
}

const NAV_FIELDS = [
  'parent_id',
  'kind',
  'key',
  'label',
  'route',
  'icon',
  'sort_order',
  'is_public',
] as const;

function AddNavNodeModal({
  applicationId,
  tree,
  parentId,
  onCancel,
  onAdded,
}: {
  applicationId: string;
  tree: readonly NavNodeCatalogDTO[];
  parentId: string | null;
  onCancel: () => void;
  onAdded: () => void;
}): ReactElement {
  const [form] = Form.useForm<NavFormValues>();
  const iam = useIam();
  const notices = useNotices();
  const [submitting, setSubmitting] = useState(false);

  const parent = parentId === null ? null : findCatalogNode(tree, parentId);

  const initialValues: NavFormValues = {
    parent_id: parentId,
    kind: defaultKindUnder(parent),
    key: '',
    label: '',
    route: '',
    icon: undefined,
    sort_order: nextSortOrder(siblingsOf(tree, parentId)),
    is_public: false,
  };

  const handleOk = async (): Promise<void> => {
    let values: NavFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    setSubmitting(true);
    try {
      const route = values.route.trim();
      const icon = values.icon?.trim() ?? '';

      await iam.applications.addNavNodes(applicationId, {
        nodes: [
          {
            kind: values.kind,
            key: values.key.trim(),
            label: values.label.trim(),
            sort_order: values.sort_order,
            is_public: values.is_public,
            ...(route === '' ? {} : { route }),
            ...(icon === '' ? {} : { icon }),
            ...(parentId === null ? {} : { parent_id: parentId }),
          },
        ],
      });
      notices.success('Navigation node added.');
      onAdded();
    } catch (error) {
      // 409 on this form is the `unique(application_id, key)` index — the only
      // thing here that can collide, since the parent is picked rather than
      // typed and so cannot name another application's node.
      const handled = applyFieldIssues(
        form,
        formFieldIssues(error, {
          fields: [...NAV_FIELDS],
          conflictField: 'key',
          // The endpoint is bulk, so the server addresses its complaints to
          // `nodes[0].route` while this form's field is plain `route`.
          stripPrefix: ['nodes', 0],
        }),
      );
      if (!handled) notices.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  const iconOptions = useMemo(
    () =>
      knownIconKeys().map((key) => ({
        value: key,
        label: (
          <Space size="small">
            <NavIcon iconKey={key} />
            <span>{key}</span>
          </Space>
        ),
      })),
    [],
  );

  /**
   * `AutoComplete` rather than a `Select`, because the registry is a *frontend*
   * map and the catalog is data (Doc 05 §7). An operator may legitimately write
   * an icon key this build does not know — a manifest written ahead of its
   * console does exactly that — and it renders a neutral glyph rather than
   * breaking. A closed `Select` would make the console's icon set a constraint
   * on what the database may contain, which is backwards.
   */

  return (
    <Modal
      open
      title={parent === null ? 'Add top-level node' : `Add a child of ${parent.label}`}
      okText="Add"
      confirmLoading={submitting}
      onOk={() => void handleOk()}
      onCancel={onCancel}
      destroyOnHidden
      width={560}
    >
      <Form<NavFormValues>
        form={form}
        layout="vertical"
        disabled={submitting}
        // Sound because the component itself is mounted per open — see the
        // caller. The suggested kind and sort order therefore track whichever
        // parent the operator clicked "Add child" on.
        initialValues={initialValues}
      >
        <Form.Item
          name="kind"
          label="Kind"
          tooltip="A depth discriminator, not a rule — the catalog does not enforce it."
          rules={[{ required: true }]}
        >
          <Select
            options={NAV_NODE_KIND_VALUES.map((kind) => ({
              value: kind,
              label: KIND_LABEL[kind],
            }))}
          />
        </Form.Item>

        <Form.Item
          name="key"
          label="Key"
          tooltip="Unique within this application. The natural key a manifest upsert matches on."
          rules={[
            { required: true, message: 'A key is required.' },
            {
              // `navKey` in `nav.dto.ts` — looser than a permission key,
              // because a nav key is already scoped by its application and its
              // place in the tree.
              pattern: /^[a-z0-9][a-z0-9._-]*$/,
              message:
                'Lowercase alphanumeric, optionally separated by ".", "-" or "_".',
            },
            { max: 160, message: 'At most 160 characters.' },
          ]}
        >
          <Input placeholder="passes.issue" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="label"
          label="Label"
          tooltip="What appears in the sidebar."
          rules={[
            { required: true, message: 'A label is required.' },
            { max: 160, message: 'At most 160 characters.' },
          ]}
        >
          <Input placeholder="Issue a pass" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="route"
          label="Route"
          tooltip="The frontend path. Leave empty for a container — a node with children is opened, not navigated to."
          rules={[
            {
              // The server's own rule (`navRoute` in `nav.dto.ts`), restated so
              // the leading slash is caught before a round trip. Rejecting an
              // absolute URL is the substance of it: a route is rendered into
              // the console's router, and `https://…` would turn a menu entry
              // into an off-site redirect chosen by whoever added the node
              // rather than by whoever clicks it.
              pattern: /^\/[^\s]*$/,
              message: 'A relative path beginning with "/", e.g. /gatepass/passes.',
            },
            { max: 512, message: 'At most 512 characters.' },
          ]}
        >
          <Input placeholder="/gatepass/passes/new" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="icon"
          label="Icon"
          tooltip="A key, not a component name — each console maps it to its own icon set (Doc 05 §7)."
        >
          <AutoComplete
            allowClear
            options={iconOptions}
            placeholder="key"
            filterOption={(input, option) =>
              String(option?.value ?? '').includes(input.trim().toLowerCase())
            }
          />
        </Form.Item>

        <Space size="large" align="start">
          <Form.Item
            name="sort_order"
            label="Sort order"
            tooltip="Ascending, among siblings."
          >
            <InputNumber min={0} step={10} />
          </Form.Item>

          <Form.Item
            name="is_public"
            label="Public"
            valuePropName="checked"
            tooltip="A leaf with no mapped permission is hidden from everyone unless it opts in here."
          >
            <Switch />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}
