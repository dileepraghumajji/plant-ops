'use client';

/**
 * Create a tenant, or rename the one you are looking at (Doc 06 §5, Doc 09 §2.2).
 *
 * One component for both, because they are one form minus a field — the same
 * arrangement as `application-form-modal.tsx`, and for a sharper version of the
 * same reason. `PATCH /iam/clients/:id` refuses `slug` on purpose
 * (`clients.dto.ts`): the slug is not merely a natural key, it is the half of
 * the login credential every user of the tenant types (Doc 03 §3). Changing it
 * would lock out an entire organisation at once, and nothing in the row would
 * look wrong afterwards. A form that offered the field and let the server drop
 * it silently would teach an operator the rename had worked.
 *
 * ## The slug is suggested, not imposed
 *
 * It is derived from the name as the operator types, and stops being derived the
 * moment they edit it themselves. A suggestion accepted is better than a value
 * invented under time pressure — and this is the only moment the value can be
 * chosen at all, so the form says that out loud rather than leaving it to be
 * discovered by someone trying to change it later.
 */

import type {
  ClientDTO,
  CreateClientRequest,
  UpdateClientRequest,
} from '@plantops/contracts';
import { useIam, useNotices } from '@plantops/web-kit';
import { Alert, Form, Input, Modal, Typography } from 'antd';
import { useEffect, useState, type ReactElement } from 'react';

import { applyFieldIssues, formFieldIssues } from '../../lib/form-errors';
import { suggestSlug } from '../../lib/clients';

interface FormValues {
  name: string;
  slug: string;
  config: string;
}

const FIELDS = ['name', 'slug', 'config'] as const;

export interface ClientFormModalProps {
  open: boolean;
  /** `null` creates a tenant; a row renames that one. */
  client: ClientDTO | null;
  onCancel: () => void;
  /** Where the caller goes afterwards — a new tenant opens its detail. */
  onSaved: (client: ClientDTO) => void;
}

export function ClientFormModal({
  open,
  client,
  onCancel,
  onSaved,
}: ClientFormModalProps): ReactElement {
  const [form] = Form.useForm<FormValues>();
  const iam = useIam();
  const notices = useNotices();
  const [submitting, setSubmitting] = useState(false);
  /** Stops the name→slug suggestion once the operator has an opinion. */
  const [slugTouched, setSlugTouched] = useState(false);
  const editing = client !== null;

  // Reset on every open, so a cancelled attempt does not come back pre-filled
  // with what the operator abandoned.
  useEffect(() => {
    if (!open) return;
    setSlugTouched(editing);
    form.setFieldsValue({
      name: client?.name ?? '',
      slug: client?.slug ?? '',
      config: formatConfig(client?.config),
    });
  }, [open, client, editing, form]);

  const handleOk = async (): Promise<void> => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // antd has already marked the offending fields.
    }

    const config = parseConfig(values.config);
    if (config === INVALID_JSON) {
      form.setFields([{ name: ['config'], errors: ['This is not valid JSON.'] }]);
      return;
    }

    setSubmitting(true);
    try {
      const name = values.name.trim();
      const saved =
        client === null
          ? await iam.clients.create({
              name,
              slug: values.slug.trim(),
              ...(Object.keys(config).length === 0 ? {} : { config }),
            } satisfies CreateClientRequest)
          : await iam.clients.update(client.id, {
              name,
              config,
            } satisfies UpdateClientRequest);

      notices.success(editing ? 'Tenant updated.' : `${saved.name} is provisioned.`);
      onSaved(saved);
    } catch (error) {
      // A 409 here is always the slug: it is the only unique column this form
      // writes (`unique(client.slug)`, Doc 01 §3.4).
      const handled = applyFieldIssues(
        form,
        formFieldIssues(error, { fields: [...FIELDS], conflictField: 'slug' }),
      );
      if (!handled) notices.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={editing ? `Edit ${client.name}` : 'Create tenant'}
      okText={editing ? 'Save' : 'Create'}
      confirmLoading={submitting}
      onOk={() => void handleOk()}
      onCancel={onCancel}
      destroyOnHidden
      width={560}
    >
      {!editing && (
        <Alert
          type="info"
          showIcon
          style={{ marginBlockEnd: 16 }}
          message="The slug is permanent"
          description="Every user of this tenant types it to sign in, alongside their email and password. It cannot be changed afterwards — a rename would lock the whole organisation out."
        />
      )}

      <Form<FormValues> form={form} layout="vertical" disabled={submitting}>
        <Form.Item
          name="name"
          label="Name"
          rules={[
            { required: true, message: 'A name is required.' },
            { max: 160, message: 'At most 160 characters.' },
          ]}
        >
          <Input
            placeholder="Acme Steel"
            autoComplete="off"
            onChange={(event) => {
              if (editing || slugTouched) return;
              form.setFieldsValue({ slug: suggestSlug(event.target.value) });
            }}
          />
        </Form.Item>

        {editing ? (
          <Form.Item label="Slug">
            <Input value={client.slug} disabled />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Permanent. This tenant’s users sign in with it.
            </Typography.Text>
          </Form.Item>
        ) : (
          <Form.Item
            name="slug"
            label="Slug"
            tooltip="What this tenant's users type on the login screen."
            rules={[
              { required: true, message: 'A slug is required.' },
              {
                pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
                message:
                  'Lowercase letters and digits in groups separated by single hyphens.',
              },
              { max: 64, message: 'At most 64 characters.' },
            ]}
          >
            <Input
              placeholder="acme-steel"
              autoComplete="off"
              onChange={() => setSlugTouched(true)}
            />
          </Form.Item>
        )}

        <Form.Item
          name="config"
          label="Configuration"
          tooltip="Opaque per-tenant settings. The IAM stores them and does not interpret them."
        >
          <Input.TextArea
            rows={4}
            placeholder="{}"
            style={{ fontFamily: 'var(--ant-font-family-code)' }}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** "The operator typed something that is not a JSON object." */
const INVALID_JSON = Symbol('invalid-json');

function formatConfig(config: Record<string, unknown> | undefined): string {
  if (config === undefined || Object.keys(config).length === 0) return '';
  return JSON.stringify(config, null, 2);
}

function parseConfig(raw: string): Record<string, unknown> | typeof INVALID_JSON {
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return INVALID_JSON;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return INVALID_JSON;
  }
}
