'use client';

/**
 * Create a person, or edit the one you are looking at (Doc 06 §8, Doc 09 §3.3).
 *
 * ## No password field, at either end
 *
 * `POST /iam/users` does not take one and neither does `PATCH`. A tenant
 * administrator does not choose somebody else's credential: the account arrives
 * without one and the person sets it through the tokenized reset of Doc 06 §3,
 * which is single-use, time-boxed, and audited at both ends. The one place a
 * password is typed for someone else is the tenant's very first administrator
 * (Doc 02 §3 step 3), because until they exist there is nobody to send a reset
 * to.
 *
 * The detail screen offers "Send password reset" instead, which is the same flow
 * an administrator would otherwise be improvising badly.
 *
 * ## `status` is on the create form on purpose
 *
 * Doc 09 §3.3 calls it "initial status", and it is a real choice rather than a
 * fixed `active`: a tenant onboarding a plant ahead of its opening creates the
 * accounts now and turns them on later. The alternative — create active, then
 * immediately disable — is two audit records for one intention.
 *
 * It is *not* on the edit form. Changing state is a transition with
 * consequences — sessions revoked, grants emptied (Doc 03 §8, Doc 04 §7) — and
 * a select buried between "Full name" and "Phone" is the wrong shape for it. The
 * detail screen's status actions carry it, one confirmed decision at a time.
 */

import type { CreateUserRequest, UpdateUserRequest, UserDTO } from '@plantops/contracts';
import { USER_STATUS_VALUES, UserStatus } from '@plantops/contracts';
import { useIam, useNotices } from '@plantops/web-kit';
import { Alert, Form, Input, Modal, Select, Typography } from 'antd';
import { useEffect, useState, type ReactElement } from 'react';

import { applyFieldIssues, formFieldIssues } from '../../lib/form-errors';

interface FormValues {
  email: string;
  full_name: string;
  phone: string;
  status: UserStatus;
}

const FIELDS = ['email', 'full_name', 'phone', 'status'] as const;

export interface UserFormProps {
  open: boolean;
  /** `null` creates a user; a row edits that one. */
  user: UserDTO | null;
  onCancel: () => void;
  onSaved: (user: UserDTO) => void;
}

export function UserForm({ open, user, onCancel, onSaved }: UserFormProps): ReactElement {
  const [form] = Form.useForm<FormValues>();
  const iam = useIam();
  const notices = useNotices();
  const [submitting, setSubmitting] = useState(false);
  const editing = user !== null;

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      email: user?.email ?? '',
      full_name: user?.full_name ?? '',
      phone: user?.phone ?? '',
      status: user?.status ?? UserStatus.ACTIVE,
    });
  }, [open, user, form]);

  const handleOk = async (): Promise<void> => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    setSubmitting(true);
    try {
      const email = values.email.trim().toLowerCase();
      const fullName = values.full_name.trim();
      const phone = values.phone.trim();

      const saved =
        user === null
          ? await iam.users.create({
              email,
              full_name: fullName,
              ...(phone === '' ? {} : { phone }),
              ...(values.status === UserStatus.ACTIVE ? {} : { status: values.status }),
            } satisfies CreateUserRequest)
          : await iam.users.update(user.id, {
              email,
              full_name: fullName,
              ...(phone === '' ? {} : { phone }),
            } satisfies UpdateUserRequest);

      notices.success(editing ? 'Profile updated.' : `${saved.full_name} added.`);
      onSaved(saved);
    } catch (error) {
      // A 409 is always the email: `unique (client_id, email)` is the only
      // uniqueness this form can violate. The same address may exist under
      // another tenant, which is why the message says "in your organisation".
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
    <Modal
      open={open}
      title={editing ? `Edit ${user.full_name}` : 'Add a person'}
      okText={editing ? 'Save' : 'Add'}
      confirmLoading={submitting}
      onOk={() => void handleOk()}
      onCancel={onCancel}
      destroyOnHidden
      width={520}
    >
      {!editing && (
        <Alert
          type="info"
          showIcon
          style={{ marginBlockEnd: 16 }}
          message="No password here"
          description="The account arrives without one. Send them a password reset from their profile — the link is single-use and expires, and nobody has to hand a credential over in a message."
        />
      )}

      <Form<FormValues> form={form} layout="vertical" disabled={submitting}>
        <Form.Item
          name="full_name"
          label="Full name"
          rules={[
            { required: true, message: 'A name is required.' },
            { max: 160, message: 'At most 160 characters.' },
          ]}
        >
          <Input placeholder="Gita Rao" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="email"
          label="Email"
          tooltip="Half of their sign-in credential. Unique within your organisation — the same address may belong to a person in another tenant."
          rules={[
            { required: true, message: 'An email is required.' },
            { type: 'email', message: 'That is not a valid address.' },
          ]}
        >
          <Input placeholder="gita@acme-steel.test" autoComplete="off" />
        </Form.Item>

        <Form.Item name="phone" label="Phone" rules={[{ max: 32 }]}>
          <Input placeholder="Optional" autoComplete="off" />
        </Form.Item>

        {!editing && (
          <Form.Item
            name="status"
            label="Initial status"
            tooltip="Create the account now and turn it on later, if the person has not started yet."
          >
            <Select
              options={USER_STATUS_VALUES.map((status) => ({
                value: status,
                label: status.charAt(0).toUpperCase() + status.slice(1),
              }))}
            />
          </Form.Item>
        )}

        {editing && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Locking, disabling and reactivating are on the profile, one confirmed
            decision at a time — each of them does more than change a field.
          </Typography.Text>
        )}
      </Form>
    </Modal>
  );
}
