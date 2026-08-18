'use client';

/**
 * The org-structure editor — the WHERE dimension made visible (Doc 09 §3.1,
 * Doc 06 §6, Doc 01 §3.5).
 *
 * ## Why this screen carries so much explanation
 *
 * Every other screen in the client console edits a list. This one edits the
 * thing that decides how far every grant reaches: a binding at a node covers
 * that node and everything beneath it (Doc 04 §4), so moving a plant under a
 * different group silently changes who can see it. Doc 09 §3.1 asks the UI to
 * "emphasize it as where access applies", and the move dialog is where that
 * sentence has to actually appear — it is the one action whose consequence is
 * invisible in the tree it draws.
 *
 * The distinction the screen keeps making is rename-versus-move, because the two
 * look identical and are not:
 *
 * - a **rename** touches `name`. `path` is id-derived labels (Doc 01 §3.5), so
 *   no grant, no cached resolution and no coverage test is affected;
 * - a **move** rewrites `path` for the whole subtree, and every subject with a
 *   binding in it has their grants recomputed (Doc 04 §7.1).
 *
 * ## Delete is guarded by the server, and the server's words are the message
 *
 * `scopes.service.ts` refuses a node with children or with bindings, and its 409
 * names the count and says why — "deleting a node never deletes what is under
 * it", "those grants would be deleted with the node". Rewriting that here would
 * produce a second, vaguer explanation of a rule this screen does not own, so
 * the refusal is shown verbatim.
 *
 * ## Everything reloads the whole tree
 *
 * `GET /iam/scopes` returns one tenant's structure whole — tens of nodes, not
 * thousands — and every mutation here can change more of it than it names: a
 * move re-parents a subtree, a create shifts nothing but adds a row two levels
 * down. Patching a local tree to match would be a second implementation of what
 * the server just did. One read after each write is cheaper than being wrong.
 */

import type { ScopeNodeDTO, ScopeNodeKind } from '@plantops/contracts';
import { MAX_SCOPE_TREE_DEPTH, SCOPE_NODE_KIND_VALUES } from '@plantops/contracts';
import {
  PageHeader,
  SCOPE_KIND_LABEL,
  ScopeKindTag,
  ScopeTreeSelect,
  ScreenEmpty,
  ScreenLoading,
  allScopeNodeIds,
  defaultChildKind,
  descendantIds,
  scopeTreeData,
  scopeTreeSize,
  spacing,
  type ScopeTreeDataNode,
} from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { DeleteOutlined, EditOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Modal, Select, Space, Tooltip, Tree, Typography } from 'antd';
import { useCallback, useMemo, useState, type ReactElement } from 'react';

import { CLIENT_PERMISSIONS as P } from '../../lib/iam-permissions';
import { usePermission } from '../../lib/use-permission';
import { ScreenFailure } from '../screen-failure';

/** What a move does that a rename does not. Said wherever a move is offered. */
export const MOVE_CONSEQUENCES =
  'Access follows the tree. A grant made at a node covers everything beneath ' +
  'it, so moving this node moves its whole subtree — and everyone whose access ' +
  'was granted somewhere above it gains or loses this branch. The change takes ' +
  'a few seconds to reach every session.';

type Dialog =
  | { kind: 'add'; parent: ScopeNodeDTO | null }
  | { kind: 'rename'; node: ScopeNodeDTO }
  | { kind: 'move'; node: ScopeNodeDTO }
  | null;

export function ScopeTreeEditor(): ReactElement {
  const iam = useIam();
  const notices = useNotices();

  const canCreate = usePermission(P.SCOPE_CREATE);
  const canUpdate = usePermission(P.SCOPE_UPDATE);
  const canDelete = usePermission(P.SCOPE_DELETE);

  const [dialog, setDialog] = useState<Dialog>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  /**
   * The refusal a delete came back with, kept beside the tree rather than in a
   * toast. A 409 here is a piece of information about the structure — "this node
   * still has four grants on it" — and the operator needs it while they go and
   * look at those grants, not for the four seconds a toast lasts.
   */
  const [refusal, setRefusal] = useState<string | null>(null);

  const scopes = useAsync(() => iam.scopes.tree(), [iam]);
  const tree = useMemo(() => scopes.data?.tree ?? [], [scopes.data]);
  const size = useMemo(() => scopeTreeSize(tree), [tree]);

  const reload = useCallback(() => {
    setRefusal(null);
    scopes.reload();
  }, [scopes]);

  const remove = useCallback(
    async (node: ScopeNodeDTO): Promise<void> => {
      const confirmed = await notices.confirm({
        title: `Delete “${node.name}”?`,
        content:
          'It has to be empty first: a node with children or with grants anchored ' +
          'to it is refused, and nothing beneath it is ever deleted along with it.',
        okText: 'Delete',
        danger: true,
      });
      if (!confirmed) return;

      setDeleting(node.id);
      setRefusal(null);
      try {
        await iam.scopes.remove(node.id);
        notices.success(`“${node.name}” is deleted.`);
        scopes.reload();
      } catch (error) {
        const described = notices.error(error);
        // The server's own sentence, kept: it names the count and explains the
        // rule, which no rewording here would improve on.
        if (described.status === 409 && described.detail !== null) {
          setRefusal(described.detail);
        }
      } finally {
        setDeleting(null);
      }
    },
    [iam, notices, scopes],
  );

  const treeData = useMemo(
    () => scopeTreeData(tree),
    [tree],
  );

  const titleFor = (data: ScopeTreeDataNode): ReactElement => {
    const { node } = data;
    return (
      <Space size="small" style={{ paddingBlock: 2 }} wrap>
        <ScopeKindTag kind={node.kind} />
        <Typography.Text>{node.name}</Typography.Text>

        <Space size={4}>
          {canCreate && (
            <Tooltip title="Add a child">
              <Button
                type="text"
                size="small"
                icon={<PlusOutlined />}
                aria-label={`Add a child under ${node.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setDialog({ kind: 'add', parent: node });
                }}
              />
            </Tooltip>
          )}
          {canUpdate && (
            <>
              <Tooltip title="Rename — changes the label only, and no grant with it">
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  aria-label={`Rename ${node.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDialog({ kind: 'rename', node });
                  }}
                />
              </Tooltip>
              <Tooltip title="Move — takes the whole subtree, and the access that reaches it">
                <Button
                  type="text"
                  size="small"
                  icon={<SwapOutlined />}
                  aria-label={`Move ${node.name}`}
                  disabled={node.parent_id === null}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDialog({ kind: 'move', node });
                  }}
                />
              </Tooltip>
            </>
          )}
          {canDelete && (
            <Tooltip title="Delete — only when it is empty">
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label={`Delete ${node.name}`}
                loading={deleting === node.id}
                onClick={(event) => {
                  event.stopPropagation();
                  void remove(node);
                }}
              />
            </Tooltip>
          )}
        </Space>
      </Space>
    );
  };

  if (scopes.loading && scopes.data === undefined) return <ScreenLoading rows={6} />;

  if (scopes.error !== null) {
    return <ScreenFailure error={scopes.error} onRetry={scopes.reload} />;
  }

  return (
    <>
      <PageHeader
        title="Org structure"
        description="Where access applies. A grant made at a node covers that node and everything beneath it, so this tree is what decides how far every role reaches."
        actions={
          canCreate &&
          tree.length === 0 && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setDialog({ kind: 'add', parent: null })}
            >
              Create the root
            </Button>
          )
        }
      />

      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {refusal !== null && (
          <Alert
            type="warning"
            showIcon
            closable
            onClose={() => setRefusal(null)}
            message="That node could not be deleted"
            description={refusal}
          />
        )}

        {tree.length === 0 ? (
          <ScreenEmpty
            title="No organisation tree yet"
            description="Normally the root arrives with your first administrator. Create one, then add plants, departments and gates beneath it — every grant you make later will point at one of these nodes."
            action={
              canCreate && (
                <Button
                  type="primary"
                  onClick={() => setDialog({ kind: 'add', parent: null })}
                >
                  Create the root
                </Button>
              )
            }
          />
        ) : (
          <Card
            size="small"
            title={`${size.nodes} node${size.nodes === 1 ? '' : 's'}, ${size.depth} level${
              size.depth === 1 ? '' : 's'
            } deep`}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Maximum depth {MAX_SCOPE_TREE_DEPTH}
              </Typography.Text>
            }
          >
            <Tree<ScopeTreeDataNode>
              treeData={treeData}
              defaultExpandedKeys={allScopeNodeIds(tree)}
              selectable={false}
              blockNode
              titleRender={titleFor}
            />
          </Card>
        )}
      </Space>

      {dialog?.kind === 'add' && (
        <AddNodeDialog
          parent={dialog.parent}
          onCancel={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      )}

      {dialog?.kind === 'rename' && (
        <RenameNodeDialog
          node={dialog.node}
          onCancel={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      )}

      {dialog?.kind === 'move' && (
        <MoveNodeDialog
          node={dialog.node}
          tree={tree}
          onCancel={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
    </>
  );
}

// ── the three dialogs ────────────────────────────────────────────────────────

/**
 * Add a child, or the tenant's root.
 *
 * `kind` is pre-selected from the parent (Group → Plant → Department → Gate) and
 * left editable, because Doc 01 §3.5 pins no kind to a depth and an organisation
 * with a department straight under a group is modelling itself honestly. It
 * cannot be changed afterwards — `PATCH` takes `name` and `parent_id` only — so
 * the form says so where the choice is made.
 */
function AddNodeDialog({
  parent,
  onCancel,
  onDone,
}: {
  parent: ScopeNodeDTO | null;
  onCancel: () => void;
  onDone: () => void;
}): ReactElement {
  const [form] = Form.useForm<{ name: string; kind: ScopeNodeKind }>();
  const iam = useIam();
  const notices = useNotices();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (): Promise<void> => {
    let values: { name: string; kind: ScopeNodeKind };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    setSubmitting(true);
    try {
      const created = await iam.scopes.create({
        ...(parent === null ? {} : { parent_id: parent.id }),
        kind: values.kind,
        name: values.name.trim(),
      });
      notices.success(`“${created.name}” added.`);
      onDone();
    } catch (error) {
      const described = notices.error(error);
      if (described.status === 409 && described.detail !== null) {
        form.setFields([{ name: ['name'], errors: [described.detail] }]);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={parent === null ? 'Create the root node' : `Add under “${parent.name}”`}
      okText="Add"
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onCancel}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        disabled={submitting}
        initialValues={{ name: '', kind: defaultChildKind(parent) }}
      >
        <Form.Item
          name="name"
          label="Name"
          rules={[
            { required: true, message: 'A name is required.' },
            { max: 160, message: 'At most 160 characters.' },
          ]}
        >
          <Input placeholder="Plant B" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="kind"
          label="Kind"
          tooltip="What this node is. It cannot be changed later — changing what a node is means creating the right one and moving what belongs under it."
          rules={[{ required: true }]}
        >
          <Select
            options={SCOPE_NODE_KIND_VALUES.map((kind) => ({
              value: kind,
              label: SCOPE_KIND_LABEL[kind],
            }))}
          />
        </Form.Item>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          The name is display only. It never appears in the node’s path, which is
          why renaming it later cannot disturb a single grant.
        </Typography.Text>
      </Form>
    </Modal>
  );
}

/** Rename — one column, and deliberately reassuring about it. */
function RenameNodeDialog({
  node,
  onCancel,
  onDone,
}: {
  node: ScopeNodeDTO;
  onCancel: () => void;
  onDone: () => void;
}): ReactElement {
  const [form] = Form.useForm<{ name: string }>();
  const iam = useIam();
  const notices = useNotices();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (): Promise<void> => {
    let values: { name: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    const name = values.name.trim();
    if (name === node.name) {
      onCancel();
      return;
    }

    setSubmitting(true);
    try {
      await iam.scopes.update(node.id, { name });
      notices.success(`Renamed to “${name}”.`);
      onDone();
    } catch (error) {
      const described = notices.error(error);
      if (described.status === 409 && described.detail !== null) {
        form.setFields([{ name: ['name'], errors: [described.detail] }]);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={`Rename “${node.name}”`}
      okText="Rename"
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onCancel}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" disabled={submitting} initialValues={{ name: node.name }}>
        <Form.Item
          name="name"
          label="Name"
          rules={[
            { required: true, message: 'A name is required.' },
            { max: 160, message: 'At most 160 characters.' },
          ]}
        >
          <Input autoComplete="off" />
        </Form.Item>

        <Alert
          type="info"
          showIcon
          message="Nothing else changes"
          description="A node’s path is built from its id, never from its name, so a rename cannot move a grant or hide a branch from anyone."
        />
      </Form>
    </Modal>
  );
}

/**
 * Move — the one action whose consequence is not visible in the tree it edits.
 *
 * The picker greys out the node and its own subtree, because a node cannot
 * become its own ancestor; the server refuses it with a 409 the operator should
 * never have been able to reach. It stays *visible* rather than hidden, so the
 * tree still reads as the organisation.
 */
function MoveNodeDialog({
  node,
  tree,
  onCancel,
  onDone,
}: {
  node: ScopeNodeDTO;
  tree: readonly ScopeNodeDTO[];
  onCancel: () => void;
  onDone: () => void;
}): ReactElement {
  const iam = useIam();
  const notices = useNotices();
  const [parentId, setParentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const forbidden = useMemo(() => descendantIds(tree, node), [tree, node]);
  const isDisabled = useCallback(
    (candidate: ScopeNodeDTO) => forbidden.has(candidate.id),
    [forbidden],
  );

  const submit = async (): Promise<void> => {
    if (parentId === null) {
      setRefusal('Choose the node this should sit under.');
      return;
    }

    setSubmitting(true);
    setRefusal(null);
    try {
      await iam.scopes.update(node.id, { parent_id: parentId });
      notices.success(`“${node.name}” moved.`);
      notices.accessChanged();
      onDone();
    } catch (error) {
      const described = notices.error(error);
      if (described.status === 409 && described.detail !== null) {
        setRefusal(described.detail);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={`Move “${node.name}”`}
      okText="Move"
      okButtonProps={{ disabled: parentId === null }}
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onCancel}
      destroyOnHidden
      width={560}
    >
      <Space direction="vertical" size={spacing.md} style={{ width: '100%' }}>
        <Alert type="warning" showIcon message="Access follows the tree" description={MOVE_CONSEQUENCES} />

        <div>
          <Typography.Text strong>New parent</Typography.Text>
          <ScopeTreeSelect
            tree={tree}
            value={parentId}
            onChange={setParentId}
            isDisabled={isDisabled}
            disabled={submitting}
            placeholder="Choose where it should sit"
            style={{ marginBlockStart: spacing.xs }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            “{node.name}” and everything beneath it are greyed out: a node cannot
            sit under itself.
          </Typography.Text>
        </div>

        {refusal !== null && <Alert type="error" showIcon message={refusal} />}
      </Space>
    </Modal>
  );
}
