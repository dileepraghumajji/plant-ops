'use client';

/**
 * Create a role, or rename the one you are looking at (Doc 06 §7, Doc 09 §3.2).
 *
 * One form for both, and unlike the application and client forms there is no
 * asymmetry to explain: `POST` and `PATCH` take the same two fields. A role's
 * name is not a natural key anything is written against — `unique (client_id,
 * name)` makes it unique, not permanent — so renaming one is an ordinary edit.
 *
 * Permissions are not here. They are a `PUT` of their own on the detail screen,
 * because setting them replaces a set with cross-tenant validation attached
 * (Doc 02 §6) rather than editing a field of the role — and because a create
 * dialog that also asked "and what may it do?" would put the tenant's whole
 * permission catalog inside a modal.
 *
 * A system role — today the `Client Admin` seeded with the tenant's first
 * administrator — cannot be renamed. The server refuses it; this form does not
 * open for one.
 */

import type { CreateRoleRequest, RoleDTO, UpdateRoleRequest } from '@plantops/contracts';
import { useIam, useNotices } from '@plantops/web-kit';
import { Form, Input, Modal } from 'antd';
import { useEffect, useState, type ReactElement } from 'react';

import { applyFieldIssues, formFieldIssues } from '../../lib/form-errors';

interface FormValues {
  name: string;
  description: string;
}

const FIELDS = ['name', 'description'] as const;

export interface RoleFormModalProps {
  open: boolean;
  /** `null` creates a role; a row edits that one. */
  role: RoleDTO | null;
  onCancel: () => void;
  onSaved: (role: RoleDTO) => void;
}

export function RoleFormModal({
  open,
  role,
  onCancel,
  onSaved,
}: RoleFormModalProps): ReactElement {
  const [form] = Form.useForm<FormValues>();
  const iam = useIam();
  const notices = useNotices();
  const [submitting, setSubmitting] = useState(false);
  const editing = role !== null;

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      name: role?.name ?? '',
      description: role?.description ?? '',
    });
  }, [open, role, form]);

  const handleOk = async (): Promise<void> => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    setSubmitting(true);
    try {
      const name = values.name.trim();
      const description = values.description.trim();

      const saved =
        role === null
          ? await iam.roles.create({
              name,
              ...(description === '' ? {} : { description }),
            } satisfies CreateRoleRequest)
          : await iam.roles.update(role.id, {
              name,
              description,
            } satisfies UpdateRoleRequest);

      notices.success(editing ? 'Role updated.' : `“${saved.name}” created.`);
      onSaved(saved);
    } catch (error) {
      // A 409 is the name: `unique (client_id, name)` is the only uniqueness
      // this form can violate — or the refusal to rename a system role, which
      // is also about the name and reads correctly beside it.
      const handled = applyFieldIssues(
        form,
        formFieldIssues(error, { fields: [...FIELDS], conflictField: 'name' }),
      );
      if (!handled) notices.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={editing ? `Edit ${role.name}` : 'Create role'}
      okText={editing ? 'Save' : 'Create'}
      confirmLoading={submitting}
      onOk={() => void handleOk()}
      onCancel={onCancel}
      destroyOnHidden
      width={520}
    >
      <Form<FormValues> form={form} layout="vertical" disabled={submitting}>
        <Form.Item
          name="name"
          label="Name"
          tooltip="What this role is called in your organisation. Unique here, and renamable."
          rules={[
            { required: true, message: 'A name is required.' },
            { max: 160, message: 'At most 160 characters.' },
          ]}
        >
          <Input placeholder="Gate Supervisor" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="description"
          label="Description"
          rules={[{ max: 1000, message: 'At most 1000 characters.' }]}
        >
          <Input.TextArea rows={3} placeholder="What someone with this role does." />
        </Form.Item>
      </Form>
    </Modal>
  );
}
