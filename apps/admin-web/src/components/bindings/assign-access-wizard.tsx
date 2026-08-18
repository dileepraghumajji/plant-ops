'use client';

/**
 * Assign access — WHO × role(WHAT) × WHERE, in one guided action
 * (Doc 09 §3.4, Doc 06 §9, Doc 01 §4.5).
 *
 * The key screen of the client console, and the only place in it where a grant
 * is created. Everything else — roles, the org tree, users — defines the
 * vocabulary; this sentence is what actually gives somebody access.
 *
 * ## Scope is a step, not a field
 *
 * Doc 09 §3.4 requires that there be no grant without choosing where, and it
 * asks for a tree selector so the admin "sees exactly where they're granting".
 * Both follow from the same fact: a scope node is not a qualifier on a grant, it
 * is half of what the grant *means*. A grant at Plant B and the same grant at
 * the group root are different grants, and a form that defaulted the field to
 * the root would silently make every one of them tenant-wide.
 *
 * So the three choices are laid out as three steps with the coverage restated
 * beneath the picker, and `toCreateRequest` refuses a draft with no scope in the
 * same breath as one with no subject — no "optional" tier.
 *
 * ## One picker for people and machines
 *
 * `role_binding` carries a subject XOR (Doc 01 §4.5) and both kinds are equally
 * bindable, so they share a list. Two pickers would suggest two features, which
 * is the misreading that leads to a service account being granted access through
 * some other route.
 *
 * ## The 409 an operator can actually act on
 *
 * A duplicate `(subject, role, node)` is a conflict; the same role at an
 * *ancestor* of an existing grant is not, and is often what an operator means
 * (Doc 02 §6). The screen therefore shows the server's own message rather than
 * inventing "already exists", and leaves the draft intact so the node can be
 * changed and resubmitted.
 */

import type { RoleDTO, ScopeNodeDTO } from '@plantops/contracts';
import { ScopeTreeSelect, findScopeNode, spacing } from '@plantops/ui';
import { useIam, useNotices } from '@plantops/web-kit';
import { Alert, Button, Card, Input, Select, Space, Tag, Typography } from 'antd';
import { useCallback, useMemo, useState, type ReactElement } from 'react';

import { toCreateRequest, type AssignmentDraft, type SubjectOption } from '../../lib/bindings';
import { CLIENT_PERMISSIONS as P } from '../../lib/iam-permissions';
import { usePermission } from '../../lib/use-permission';

const EMPTY_DRAFT: AssignmentDraft = {
  subject: null,
  roleId: null,
  scopeNodeId: null,
  expiresAtLocal: '',
};

export interface AssignAccessWizardProps {
  /**
   * The three lists the pickers offer, owned by the page so that the wizard and
   * the table's filters cannot disagree about what exists.
   */
  subjects: readonly SubjectOption[];
  roles: readonly RoleDTO[];
  tree: readonly ScopeNodeDTO[];
  loading: boolean;
  /** Re-reads the grant list after a successful bind. */
  onGranted: () => void;
}

export function AssignAccessWizard({
  subjects,
  roles,
  tree,
  loading,
  onGranted,
}: AssignAccessWizardProps): ReactElement {
  const iam = useIam();
  const notices = useNotices();
  const canCreate = usePermission(P.BINDING_CREATE);

  const [draft, setDraft] = useState<AssignmentDraft>(EMPTY_DRAFT);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const chosenNode = useMemo(
    () => (draft.scopeNodeId === null ? null : findScopeNode(tree, draft.scopeNodeId)),
    [tree, draft.scopeNodeId],
  );

  const chosenSubject = subjects.find((option) => option.value === draft.subject) ?? null;

  const update = useCallback((patch: Partial<AssignmentDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    const built = toCreateRequest(draft);
    if (!built.ok) {
      setProblem(built.problem);
      return;
    }

    setSaving(true);
    setProblem(null);
    try {
      const created = await iam.roleBindings.create(built.request);
      notices.success(
        `${created.subject_name} now holds “${created.role_name}” at “${created.scope_node_name}”.`,
      );
      // Doc 09 §4, and the one notice this screen owes above all others: the
      // grant is written now and reaches every cache within seconds.
      notices.accessChanged();
      setDraft(EMPTY_DRAFT);
      onGranted();
    } catch (error) {
      const described = notices.error(error);
      // The server's own words. A duplicate `(subject, role, node)` is a
      // conflict; the same role at an ancestor is not, and telling the two apart
      // is exactly what its message does.
      if (described.status === 409 && described.detail !== null) {
        setProblem(described.detail);
      }
    } finally {
      setSaving(false);
    }
  }, [draft, iam, notices, onGranted]);

  return (
    <Card
      size="small"
      title="Assign access"
      extra={
        <Button
          type="primary"
          loading={saving}
          disabled={!canCreate || loading}
          onClick={() => void submit()}
        >
          Grant
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {!canCreate && (
          <Alert
            type="info"
            showIcon
            message={`You do not hold ${P.BINDING_CREATE}`}
            description="You can look at the form, but the grant will be refused."
          />
        )}

        <Space
          size="middle"
          align="start"
          wrap
          style={{ width: '100%' }}
        >
          <Field label="Who" hint="A person or a machine identity — both hold roles the same way.">
            <Select<string>
              showSearch
              optionFilterProp="label"
              placeholder="Choose a subject"
              loading={loading}
              value={draft.subject ?? undefined}
              onChange={(value) => update({ subject: value })}
              style={{ width: 280 }}
              options={subjects.map((option) => ({
                value: option.value,
                label: option.label,
                title: option.detail,
              }))}
              optionRender={(option) => {
                const found = subjects.find((entry) => entry.value === option.value);
                return (
                  <Space direction="vertical" size={0}>
                    <Space size="small">
                      <span>{found?.label}</span>
                      {found?.type === 'service' && <Tag>Machine</Tag>}
                      {found?.inert === true && <Tag color="default">Inactive</Tag>}
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {found?.detail}
                    </Typography.Text>
                  </Space>
                );
              }}
            />
          </Field>

          <Field label="What" hint="The role carries the permissions; this grant carries the role.">
            <Select<string>
              showSearch
              optionFilterProp="label"
              placeholder="Choose a role"
              loading={loading}
              value={draft.roleId ?? undefined}
              onChange={(value) => update({ roleId: value })}
              style={{ width: 240 }}
              options={roles.map((role) => ({
                value: role.id,
                label: role.name,
              }))}
            />
          </Field>

          <Field
            label="Until (optional)"
            hint="Leave empty for a grant that does not expire."
          >
            <Input
              type="datetime-local"
              value={draft.expiresAtLocal}
              onChange={(event) => update({ expiresAtLocal: event.target.value })}
              style={{ width: 240 }}
            />
          </Field>
        </Space>

        <div>
          <Space size="small" align="baseline">
            <Typography.Text strong>Where</Typography.Text>
            <Tag color="red" style={{ marginInlineEnd: 0 }}>
              Required
            </Tag>
          </Space>
          <Typography.Paragraph
            type="secondary"
            style={{ fontSize: 12, marginBlockEnd: spacing.xs }}
          >
            Access follows the tree: the grant covers the node you choose and
            everything beneath it. There is no such thing as a grant without a
            place.
          </Typography.Paragraph>
          <ScopeTreeSelect
            tree={tree}
            value={draft.scopeNodeId}
            onChange={(value) => update({ scopeNodeId: value })}
            disabled={loading}
            placeholder="Choose where this applies"
            notFoundContent="Your organisation has no tree yet — build it under Org structure first."
          />
        </div>

        {chosenSubject !== null &&
          draft.roleId !== null &&
          chosenNode !== null && (
            <Alert
              type="info"
              showIcon
              message="What you are about to grant"
              description={
                <>
                  <Typography.Text strong>{chosenSubject.label}</Typography.Text> will
                  hold{' '}
                  <Typography.Text strong>
                    {roles.find((role) => role.id === draft.roleId)?.name}
                  </Typography.Text>{' '}
                  at <Typography.Text strong>{chosenNode.name}</Typography.Text> and
                  everything beneath it
                  {draft.expiresAtLocal === ''
                    ? ', with no expiry.'
                    : `, until ${new Date(draft.expiresAtLocal).toLocaleString()}.`}
                  {chosenSubject.inert &&
                    ' This subject is not active, so the grant is recorded and takes effect when they are.'}
                </>
              }
            />
          )}

        {problem !== null && <Alert type="error" showIcon message={problem} />}
      </Space>
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactElement;
}): ReactElement {
  return (
    <Space direction="vertical" size={2}>
      <Typography.Text strong>{label}</Typography.Text>
      {children}
      <Typography.Text type="secondary" style={{ fontSize: 12, maxWidth: 280 }}>
        {hint}
      </Typography.Text>
    </Space>
  );
}
