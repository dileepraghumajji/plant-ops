'use client';

/**
 * Machine identities — create, rotate, revoke (Doc 09 §2.4 and §3.5, Doc 06 §10,
 * Doc 03 §5).
 *
 * ## One component, two tiers
 *
 * The platform console and the client console render this same screen. They have
 * to: `/iam/service-accounts` is one surface gated on `iam.client.svc.*`, and
 * which tenant's accounts a caller sees is decided by their token's `cid` and by
 * RLS — never by a parameter. A platform admin managing platform-level machine
 * identities is administering the *platform tenant*, which migration 0011 makes
 * a tenant like any other (`service-accounts.controller.ts`).
 *
 * So the two routes differ only in the words around the table, which is what
 * `tier` selects. Two copies of this file would be two implementations of the
 * secret-shown-once flow, and the one that drifted would be the one that showed
 * a secret twice or not at all.
 *
 * ## There is no delete, and no way back to a secret
 *
 * Doc 06 §10 has create, list, rotate and PATCH. Revoking is the off switch and
 * keeps the row — `role_binding` references it and `audit_trail` names it, and an
 * account that vanished would take the explanation of everything it ever did with
 * it. The secret is returned by exactly two routes and stored only as a hash, so
 * "show it again" is not a feature this screen is missing; it is a thing that
 * cannot exist.
 */

import type {
  Paginated,
  ServiceAccountDTO,
  ServiceAccountSecretDTO,
} from '@plantops/contracts';
import { ServiceAccountStatus } from '@plantops/contracts';
import { DataTable, PageHeader, ScreenEmpty, StatusTag } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Modal, Space, Tooltip, Typography } from 'antd';
import { useCallback, useState, type ReactElement } from 'react';

import { applyFieldIssues, formFieldIssues } from '../../lib/form-errors';
import { CLIENT_PERMISSIONS as P } from '../../lib/iam-permissions';
import { usePermission } from '../../lib/use-permission';
import { ScreenFailure } from '../screen-failure';
import { SecretRevealModal } from './secret-reveal-modal';

export type ServiceAccountTier = 'platform' | 'client';

const COPY: Readonly<Record<ServiceAccountTier, { title: string; description: string }>> = {
  platform: {
    title: 'Service accounts',
    description:
      'Machine identities at the platform tier — the ones that run migrations, upload manifests and provision tenants. They authenticate with a key and a secret and get a short-lived token in return.',
  },
  client: {
    title: 'Service accounts',
    description:
      'Machine identities for your integrations. They hold roles at nodes of the org tree exactly as people do, so give one access from Access assignment once it exists.',
  },
};

export interface AccountsTableProps {
  tier: ServiceAccountTier;
}

export function AccountsTable({ tier }: AccountsTableProps): ReactElement {
  const iam = useIam();
  const notices = useNotices();

  const canCreate = usePermission(P.SVC_CREATE);
  const canRotate = usePermission(P.SVC_ROTATE);
  const canUpdate = usePermission(P.SVC_UPDATE);

  const [query, setQuery] = useState({ page: 1, limit: 25 });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<readonly string[]>([]);
  /** The one screen-lifetime moment a secret exists here. */
  const [revealed, setRevealed] = useState<
    { account: ServiceAccountSecretDTO; rotated: boolean } | null
  >(null);

  const accounts = useAsync<Paginated<ServiceAccountDTO>>(
    () => iam.serviceAccounts.list(query),
    [iam, query.page, query.limit],
  );

  const rotate = useCallback(
    async (account: ServiceAccountDTO): Promise<void> => {
      const confirmed = await notices.confirm({
        title: `Rotate the secret for ${account.name}?`,
        content:
          'The current secret stops working immediately, so anything still ' +
          'configured with it starts failing its token exchange until you ' +
          'redeploy the new one. The account, its key and every grant it holds ' +
          'are untouched.',
        okText: 'Rotate',
        danger: true,
      });
      if (!confirmed) return;

      setBusy((ids) => [...ids, account.id]);
      try {
        const rotated = await iam.serviceAccounts.rotate(account.id);
        setRevealed({ account: rotated, rotated: true });
        accounts.reload();
      } catch (error) {
        notices.error(error);
      } finally {
        setBusy((ids) => ids.filter((id) => id !== account.id));
      }
    },
    [iam, notices, accounts],
  );

  const setStatus = useCallback(
    async (account: ServiceAccountDTO, status: ServiceAccountStatus): Promise<void> => {
      if (status === ServiceAccountStatus.REVOKED) {
        const confirmed = await notices.confirm({
          title: `Revoke ${account.name}?`,
          content:
            'Its next token exchange fails, and tokens it already holds run to ' +
            'their expiry — at most five minutes. Nothing is deleted: the ' +
            'account, its grants and every audit record naming it are kept, ' +
            'which is why revoking is how a machine identity is retired rather ' +
            'than removed.',
          okText: 'Revoke',
          danger: true,
        });
        if (!confirmed) return;
      }

      setBusy((ids) => [...ids, account.id]);
      try {
        await iam.serviceAccounts.update(account.id, { status });
        notices.success(
          status === ServiceAccountStatus.ACTIVE
            ? `${account.name} is active again.`
            : `${account.name} is revoked.`,
        );
        accounts.reload();
      } catch (error) {
        notices.error(error);
      } finally {
        setBusy((ids) => ids.filter((id) => id !== account.id));
      }
    },
    [iam, notices, accounts],
  );

  const columns = [
    {
      title: 'Key',
      dataIndex: 'account_key',
      width: 260,
      render: (key: string) => (
        <Typography.Text
          copyable={{ text: key }}
          style={{ fontFamily: 'var(--ant-font-family-code)' }}
        >
          {key}
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
      width: 120,
      render: (status: string) => <StatusTag status={status} />,
    },
    {
      title: '',
      key: 'actions',
      width: 200,
      render: (_: unknown, row: ServiceAccountDTO) => {
        const revoked = row.status === ServiceAccountStatus.REVOKED;
        return (
          <Space size="small">
            <Tooltip
              title={
                revoked
                  ? 'A revoked account cannot exchange a token, so a new secret would do nothing. Reactivate it first.'
                  : canRotate
                    ? 'Issues a new secret and invalidates the current one.'
                    : `You do not hold ${P.SVC_ROTATE}.`
              }
            >
              <Button
                size="small"
                disabled={revoked || !canRotate}
                loading={busy.includes(row.id)}
                onClick={() => void rotate(row)}
              >
                Rotate
              </Button>
            </Tooltip>

            <Tooltip title={canUpdate ? undefined : `You do not hold ${P.SVC_UPDATE}.`}>
              <Button
                size="small"
                danger={!revoked}
                disabled={!canUpdate}
                loading={busy.includes(row.id)}
                onClick={() =>
                  void setStatus(
                    row,
                    revoked ? ServiceAccountStatus.ACTIVE : ServiceAccountStatus.REVOKED,
                  )
                }
              >
                {revoked ? 'Reactivate' : 'Revoke'}
              </Button>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title={COPY[tier].title}
        description={COPY[tier].description}
        actions={
          canCreate && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreating(true)}
            >
              Create account
            </Button>
          )
        }
      />

      <DataTable<ServiceAccountDTO>
        result={accounts.data}
        loading={accounts.loading}
        columns={columns}
        rowKey={(row) => row.id}
        onQueryChange={setQuery}
        empty={
          <ScreenEmpty
            title="No machine identities yet"
            description={
              tier === 'client'
                ? 'An integration that talks to PlantOps needs one of these. It authenticates with a key and secret, and holds roles at scope nodes exactly as a person does.'
                : 'Platform tooling — manifest uploads, tenant provisioning, migrations — authenticates as one of these rather than as a person.'
            }
            action={
              canCreate && (
                <Button type="primary" onClick={() => setCreating(true)}>
                  Create the first account
                </Button>
              )
            }
          />
        }
        error={
          accounts.error === null || accounts.loading ? undefined : (
            <ScreenFailure error={accounts.error} onRetry={accounts.reload} />
          )
        }
      />

      {creating && (
        <CreateAccountModal
          onCancel={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setRevealed({ account: created, rotated: false });
            accounts.reload();
          }}
        />
      )}

      {revealed !== null && (
        <SecretRevealModal
          account={revealed.account}
          rotated={revealed.rotated}
          onClose={() => setRevealed(null)}
        />
      )}
    </>
  );
}

/**
 * Name in, credential out.
 *
 * One field, because that is the whole of `CreateServiceAccountRequest`: the
 * `account_key` is derived and permanent — it is the identifier a deployed
 * consumer is configured with — and the status begins active.
 */
function CreateAccountModal({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (account: ServiceAccountSecretDTO) => void;
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

    setSubmitting(true);
    try {
      onCreated(await iam.serviceAccounts.create({ name: values.name.trim() }));
    } catch (error) {
      const handled = applyFieldIssues(
        form,
        formFieldIssues(error, { fields: ['name'], conflictField: 'name' }),
      );
      if (!handled) notices.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title="Create a service account"
      okText="Create"
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onCancel}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBlockEnd: 16 }}
        message="The secret is shown once"
        description="It appears as soon as the account exists, and never again — only a hash is kept. Have somewhere to paste it before you press Create."
      />

      <Form form={form} layout="vertical" disabled={submitting} initialValues={{ name: '' }}>
        <Form.Item
          name="name"
          label="Name"
          tooltip="What this identity is for. It appears in the audit trail beside everything the account does."
          rules={[
            { required: true, message: 'A name is required.' },
            { max: 160, message: 'At most 160 characters.' },
          ]}
        >
          <Input placeholder="Gatepass nightly sync" autoComplete="off" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
