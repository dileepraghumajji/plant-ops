'use client';

/**
 * Register an application, or edit the one you are looking at (Doc 06 §4,
 * Doc 09 §2.1).
 *
 * One component for both, because they are one form minus a field. The `key` is
 * present at create and absent at edit, and that asymmetry is the interesting
 * part: `PATCH /iam/applications/:id` refuses `key` on purpose
 * (`applications.dto.ts`), because it is the natural key every manifest upload
 * and every permission address is written against — renaming it would re-point
 * a whole catalog while every foreign key kept pointing at the same uuid. A
 * form that offered the field and let the server drop it silently would teach
 * an operator that the rename had worked.
 *
 * ## `config` is a JSON textarea, not a form
 *
 * Doc 01 §3.1 makes `config` an opaque per-application blob the IAM does not
 * interpret, and `applications.dto.ts` validates it no further than "is an
 * object" — deliberately, because a schema there would need a deploy every time
 * a module added a setting, which is what the registry exists to avoid. So the
 * console offers the same contract: free JSON, parsed here only far enough to
 * refuse a body the server would reject anyway.
 */

import type {
  ApplicationDTO,
  CreateApplicationRequest,
  UpdateApplicationRequest,
} from '@plantops/contracts';
import { useIam, useNotices } from '@plantops/web-kit';
import { Form, Input, Modal, Typography } from 'antd';
import { useEffect, useState, type ReactElement } from 'react';

import { applyFieldIssues, formFieldIssues } from '../../lib/form-errors';

interface FormValues {
  key: string;
  name: string;
  description: string;
  config: string;
}

const FIELDS = ['key', 'name', 'description', 'config'] as const;

export interface ApplicationFormModalProps {
  open: boolean;
  /** `null` registers a new application; a row edits that one. */
  application: ApplicationDTO | null;
  onCancel: () => void;
  /** Where the caller goes afterwards — a new registration opens its detail. */
  onSaved: (application: ApplicationDTO) => void;
}

/**
 * The call is made here rather than handed in as a callback.
 *
 * A single `onSubmit` prop would have to take `CreateApplicationRequest |
 * UpdateApplicationRequest`, and every caller would then need a cast to pick
 * the endpoint — which is a type hole around the one asymmetry (`key`) this
 * component exists to get right. The component already knows which of the two
 * it is building, so it is also the thing that should know which endpoint that
 * body belongs to.
 */
export function ApplicationFormModal({
  open,
  application,
  onCancel,
  onSaved,
}: ApplicationFormModalProps): ReactElement {
  const [form] = Form.useForm<FormValues>();
  const iam = useIam();
  const notices = useNotices();
  const [submitting, setSubmitting] = useState(false);
  const editing = application !== null;

  // Reset on every open, so a cancelled attempt does not come back pre-filled
  // with what the operator abandoned.
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      key: application?.key ?? '',
      name: application?.name ?? '',
      description: application?.description ?? '',
      config: formatConfig(application?.config),
    });
  }, [open, application, form]);

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
      const description = values.description.trim();
      const name = values.name.trim();

      const saved = application === null
        ? await iam.applications.create({
            key: values.key.trim(),
            name,
            ...(description === '' ? {} : { description }),
            ...(Object.keys(config).length === 0 ? {} : { config }),
          } satisfies CreateApplicationRequest)
        : await iam.applications.update(application.id, {
            name,
            // `null` clears it; `undefined` cannot, because that is how "leave
            // it alone" is spelled — an operator emptying the box would
            // otherwise find the old text still there.
            description: description === '' ? null : description,
            config,
          } satisfies UpdateApplicationRequest);

      notices.success(editing ? 'Application updated.' : 'Application registered.');
      onSaved(saved);
    } catch (error) {
      // A 409 here is always the key: it is the only unique column this form
      // writes (`unique(application.key)`, Doc 01 §3.1).
      const handled = applyFieldIssues(
        form,
        formFieldIssues(error, { fields: [...FIELDS], conflictField: 'key' }),
      );
      if (!handled) notices.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={editing ? `Edit ${application.name}` : 'Register application'}
      okText={editing ? 'Save' : 'Register'}
      confirmLoading={submitting}
      onOk={() => void handleOk()}
      onCancel={onCancel}
      destroyOnHidden
      width={560}
    >
      <Form<FormValues> form={form} layout="vertical" disabled={submitting}>
        {editing ? (
          <Form.Item label="Key">
            <Input value={application.key} disabled />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              The key is permanent. Manifests, permission keys and deployed
              consumers are all written against it.
            </Typography.Text>
          </Form.Item>
        ) : (
          <Form.Item
            name="key"
            label="Key"
            tooltip="The namespace for this application's permissions — gatepass.pass.create."
            rules={[
              { required: true, message: 'A key is required.' },
              {
                pattern: /^[a-z][a-z0-9_-]*$/,
                message:
                  'Lowercase letters, digits, "-" and "_", starting with a letter.',
              },
              { max: 64, message: 'At most 64 characters.' },
            ]}
          >
            <Input placeholder="gatepass" autoComplete="off" />
          </Form.Item>
        )}

        <Form.Item
          name="name"
          label="Name"
          rules={[
            { required: true, message: 'A name is required.' },
            { max: 160, message: 'At most 160 characters.' },
          ]}
        >
          <Input placeholder="Gate Pass Management" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="description"
          label="Description"
          rules={[{ max: 1000, message: 'At most 1000 characters.' }]}
        >
          <Input.TextArea rows={2} placeholder="What this application is for." />
        </Form.Item>

        <Form.Item
          name="config"
          label="Configuration"
          tooltip="Opaque per-application settings. The IAM stores them and does not interpret them."
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
