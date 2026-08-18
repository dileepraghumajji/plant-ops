'use client';

/**
 * *Administrators* — the tenant's first administrator, in one action
 * (Doc 09 §2.2, Doc 02 §3 step 3, Doc 06 §5).
 *
 * ## Why this is a whole tab for one form
 *
 * It resolves the tenant's chicken-and-egg. A client admin runs their own
 * organisation entirely self-service (Doc 02 §4), but every self-service call is
 * authorized by a binding only a client admin could have created. Somebody
 * outside the tenant writes the first one, and "the first one" is four rows that
 * are worthless apart (`client-admin.service.ts`): the user, the tenant's root
 * scope node, the system client-admin role, and the binding tying them together
 * at the root.
 *
 * The endpoint creates all four in one transaction, and the screen shows all
 * four back. That is what "surfacing the result" has to mean here — an operator
 * who is told only "user created" has no way to tell whether the person can
 * actually administer anything, which is the entire point of the call.
 *
 * ## There is no list
 *
 * Doc 06 §5 has no `GET /iam/clients/:id/admins`, deliberately: once the first
 * administrator exists, the tenant's people are the tenant's own to manage
 * through Doc 06 §8, and a platform-side roster would be a second, weaker copy
 * of a screen the client console already owns. So this tab creates and reports,
 * and says where the rest of the story lives.
 *
 * Running it again is ordinary rather than exceptional: the root node and the
 * role are adopted rather than duplicated, so a second administrator joins the
 * same tree under the same role, and a repeated email is the 409 the per-client
 * unique index promises.
 */

import type { ClientAdminDTO, ClientDTO } from '@plantops/contracts';
import { PageHeader, spacing } from '@plantops/ui';
import { useIam, useNotices } from '@plantops/web-kit';
import { Alert, Button, Card, Descriptions, Form, Input, Space, Typography } from 'antd';
import { useState, type ReactElement } from 'react';

import { applyFieldIssues, formFieldIssues } from '../../lib/form-errors';
import { PLATFORM_PERMISSIONS as P } from '../../lib/iam-permissions';
import { usePermission } from '../../lib/use-permission';

/**
 * Doc 03 §7's floor, as `apps/iam-api/src/auth/password.util.ts` spells it.
 *
 * Restated for the same reason the permission keys are (`lib/iam-permissions.ts`):
 * the boundary forbids importing it, and a form that let a too-short password
 * through would trade an inline message for a round-trip and a toast. The
 * server is still the authority — a drift here shows up as a 400 the form pins
 * to the field, not as a weak password accepted.
 */
const PASSWORD_MIN_LENGTH = 12;

const FIELDS = ['email', 'full_name', 'password', 'phone', 'scope_name'] as const;

interface FormValues {
  email: string;
  full_name: string;
  password: string;
  phone: string;
  scope_name: string;
}

export interface AdminCreateProps {
  client: ClientDTO;
}

export function AdminCreate({ client }: AdminCreateProps): ReactElement {
  const [form] = Form.useForm<FormValues>();
  const iam = useIam();
  const notices = useNotices();
  const canCreate = usePermission(P.CLIENT_ADMIN_CREATE);

  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<ClientAdminDTO | null>(null);

  const submit = async (): Promise<void> => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    setSubmitting(true);
    try {
      const phone = values.phone.trim();
      const scopeName = values.scope_name.trim();

      const admin = await iam.clients.createAdmin(client.id, {
        email: values.email.trim(),
        full_name: values.full_name.trim(),
        password: values.password,
        ...(phone === '' ? {} : { phone }),
        ...(scopeName === '' ? {} : { scope_name: scopeName }),
      });

      setCreated(admin);
      // The password is never echoed, so the form is cleared rather than left
      // holding a credential on a screen someone may walk away from.
      form.resetFields();
      notices.success(`${admin.full_name} can now administer ${client.name}.`);
    } catch (error) {
      // A 409 is always the email: `unique(client_id, email)` is the only
      // uniqueness this form can violate (Doc 01 §6).
      const handled = applyFieldIssues(
        form,
        formFieldIssues(error, { fields: [...FIELDS], conflictField: 'email' }),
      );
      if (!handled) notices.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Administrators"
        description="One action creates the person, the root of this tenant’s organisation tree, the client-admin role, and the grant that ties them together. From then on the tenant runs itself."
      />

      <Space direction="vertical" size="large" style={{ width: '100%', maxWidth: 720 }}>
        {created !== null && <AdminCreated admin={created} client={client} />}

        <Card size="small" title="Create an administrator">
          {!canCreate && (
            <Alert
              type="info"
              showIcon
              style={{ marginBlockEnd: spacing.md }}
              message="You do not hold iam.platform.client.admin.create"
              description="The form below is left in place because the server decides, not this screen — but the call will be refused."
            />
          )}

          <Form<FormValues>
            form={form}
            layout="vertical"
            disabled={submitting}
            initialValues={{
              email: '',
              full_name: '',
              password: '',
              phone: '',
              scope_name: '',
            }}
          >
            <Form.Item
              name="full_name"
              label="Full name"
              rules={[
                { required: true, message: 'A name is required.' },
                { max: 160, message: 'At most 160 characters.' },
              ]}
            >
              <Input placeholder="Priya Raman" autoComplete="off" />
            </Form.Item>

            <Form.Item
              name="email"
              label="Email"
              tooltip="Half of this person's sign-in credential. Unique within this tenant — the same address may administer another one."
              rules={[
                { required: true, message: 'An email is required.' },
                { type: 'email', message: 'That is not a valid address.' },
              ]}
            >
              <Input placeholder="priya@acme-steel.test" autoComplete="off" />
            </Form.Item>

            <Form.Item
              name="password"
              label="Initial password"
              tooltip="Hand it over out of band. They can change it, and the tokenized reset works from the moment the account exists."
              rules={[
                { required: true, message: 'A password is required.' },
                {
                  min: PASSWORD_MIN_LENGTH,
                  message: `At least ${PASSWORD_MIN_LENGTH} characters.`,
                },
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>

            <Form.Item name="phone" label="Phone" rules={[{ max: 32 }]}>
              <Input placeholder="Optional" autoComplete="off" />
            </Form.Item>

            <Form.Item
              name="scope_name"
              label="Root of the organisation tree"
              tooltip="Display only. The tree's ltree labels are derived from ids, so no name ever reaches a path (Doc 01 §3.5)."
              rules={[{ max: 160 }]}
            >
              <Input placeholder={client.name} autoComplete="off" />
            </Form.Item>

            <Button type="primary" loading={submitting} onClick={() => void submit()}>
              Create administrator
            </Button>
          </Form>
        </Card>
      </Space>
    </>
  );
}

/**
 * The four rows the call created, and the two things the operator does next.
 *
 * Shown rather than summarised because the useful question after this call is
 * "can this person sign in and see their whole organisation", and the answer is
 * the root node plus the binding — not the user id.
 */
function AdminCreated({
  admin,
  client,
}: {
  admin: ClientAdminDTO;
  client: ClientDTO;
}): ReactElement {
  return (
    <Alert
      type="success"
      showIcon
      message={`${admin.full_name} can administer ${client.name}`}
      description={
        <Space direction="vertical" size={spacing.sm} style={{ width: '100%' }}>
          <span>
            They sign in with the tenant slug{' '}
            <Typography.Text
              copyable={{ text: client.slug }}
              style={{ fontFamily: 'var(--ant-font-family-code)' }}
            >
              {client.slug}
            </Typography.Text>
            , their email, and the password you chose. Hand the password over out
            of band — it was never stored in the clear and cannot be shown again.
          </span>

          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="User">
              {admin.full_name} · {admin.email}
            </Descriptions.Item>
            <Descriptions.Item label="Role">
              {admin.role_name} — the system role, which the tenant cannot rename
              or delete
            </Descriptions.Item>
            <Descriptions.Item label="Root scope node">
              <Space direction="vertical" size={0}>
                <span>{admin.scope_node_name}</span>
                <Typography.Text
                  type="secondary"
                  style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
                >
                  {admin.scope_node_path}
                </Typography.Text>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="Grant">
              Bound at the root, so it covers every node they add beneath it
            </Descriptions.Item>
          </Descriptions>

          {client.status !== 'active' && (
            <Typography.Text type="warning">
              This tenant is suspended, so they cannot sign in yet. Reactivate it
              first.
            </Typography.Text>
          )}
        </Space>
      }
    />
  );
}
