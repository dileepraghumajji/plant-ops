'use client';

/**
 * *Permissions* — the atomic things an application can be granted (Doc 09 §2.1,
 * Doc 01 §3.2).
 *
 * ## Add is here; edit is not, and the tab says why
 *
 * Doc 09 §2.1 asks for "add/edit". Doc 06 §4 gives this surface exactly two
 * routes — `POST` and `GET /iam/applications/:id/permissions` — and there is no
 * `PATCH`. That is not an omission: Doc 02 §7 makes the manifest the way a
 * catalog *changes*, precisely because an edit has to be repeatable across
 * environments and idempotent on re-upload, and a one-off `PATCH` from a
 * console is neither. Renaming a permission is therefore a manifest upload
 * (Session 29), and the tab points at it rather than offering a button that
 * would have to call an endpoint that does not exist.
 *
 * What the form path is for is the case the manifest cannot serve: adding a
 * permission to an application that is already live, immediately, without
 * regenerating and re-uploading its whole manifest. That is what Doc 02 §2 step
 * 2 describes, and it is why the bulk `POST` exists.
 *
 * ## Why the add form takes several rows at once
 *
 * The endpoint is bulk (`{ permissions: [...] }`) and its service inserts the
 * entries individually so a duplicate names itself. Permissions arrive in sets
 * — `create`, `read`, `update`, `delete` for one resource — and a modal that
 * took one at a time would make the operator open it four times to express one
 * thought.
 */

import type { PermissionDTO } from '@plantops/contracts';
import { DataTable, PageHeader, ScreenEmpty, StatusTag } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Modal, Space, Typography } from 'antd';
import { useState, type ReactElement } from 'react';

import { ScreenFailure } from '../screen-failure';
import { applyFieldIssues, formFieldIssues } from '../../lib/form-errors';
import { PLATFORM_PERMISSIONS as P } from '../../lib/iam-permissions';
import { usePermission } from '../../lib/use-permission';

export interface PermissionsTabProps {
  applicationId: string;
  /** The application's key, so the form can suggest the right prefix. */
  applicationKey: string;
  /** Bumped by a sibling tab; a change here means "reload". */
  version: number;
  /** Tells the detail screen the catalog moved, so the other tabs reload too. */
  onChanged: () => void;
}

export function PermissionsTab({
  applicationId,
  applicationKey,
  version,
  onChanged,
}: PermissionsTabProps): ReactElement {
  const iam = useIam();
  const canCreate = usePermission(P.PERMISSION_CREATE);

  const [query, setQuery] = useState({ page: 1, limit: 25 });
  const [adding, setAdding] = useState(false);

  const permissions = useAsync(
    () => iam.applications.listPermissions(applicationId, query),
    [iam, applicationId, query.page, query.limit, version],
  );

  const columns = [
    {
      title: 'Key',
      dataIndex: 'key',
      width: 300,
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
      render: (name: string, row: PermissionDTO) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{name}</Typography.Text>
          {row.description !== null && row.description !== '' && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.description}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'is_active',
      width: 120,
      render: (isActive: boolean) => (
        <StatusTag status={isActive ? 'active' : 'inactive'} />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Permissions"
        description="What a role can carry for this application. Keys are permanent — a role mapping, a manifest and every audit record refer to them."
        actions={
          canCreate && (
            <Button icon={<PlusOutlined />} onClick={() => setAdding(true)}>
              Add permissions
            </Button>
          )
        }
      />

      <DataTable<PermissionDTO>
        result={permissions.data}
        loading={permissions.loading}
        columns={columns}
        rowKey={(row) => row.id}
        onQueryChange={setQuery}
        size="small"
        empty={
          <ScreenEmpty
            title="No permissions yet"
            description="Until this application declares a permission, no role can carry it and none of its menus can be gated."
            action={
              canCreate && (
                <Button type="primary" onClick={() => setAdding(true)}>
                  Add the first permissions
                </Button>
              )
            }
          />
        }
        error={
          permissions.error === null || permissions.loading ? undefined : (
            <ScreenFailure error={permissions.error} onRetry={permissions.reload} />
          )
        }
      />

      {/*
        Mounted per open, so the row list starts empty each time. A modal kept
        alive with `open=false` keeps its `Form.List` rows, and the operator
        would reopen it holding the permissions they just added.
      */}
      {adding && (
        <AddPermissionsModal
          applicationId={applicationId}
          applicationKey={applicationKey}
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            permissions.reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}

interface PermissionRow {
  key: string;
  name: string;
  description: string;
}

interface AddFormValues {
  permissions: PermissionRow[];
}

function AddPermissionsModal({
  applicationId,
  applicationKey,
  onCancel,
  onAdded,
}: {
  applicationId: string;
  applicationKey: string;
  onCancel: () => void;
  onAdded: () => void;
}): ReactElement {
  const [form] = Form.useForm<AddFormValues>();
  const iam = useIam();
  const notices = useNotices();
  const [submitting, setSubmitting] = useState(false);

  const handleOk = async (): Promise<void> => {
    let values: AddFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    setSubmitting(true);
    try {
      const created = await iam.applications.addPermissions(applicationId, {
        permissions: values.permissions.map((row) => {
          const description = row.description?.trim() ?? '';
          return {
            key: row.key.trim(),
            name: row.name.trim(),
            ...(description === '' ? {} : { description }),
          };
        }),
      });
      notices.success(
        `${created.length} permission${created.length === 1 ? '' : 's'} added.`,
      );
      onAdded();
    } catch (error) {
      // The server names the duplicate key in its 409 message, but it cannot
      // say *which row* of a bulk body it was — so the conflict goes to the
      // whole form rather than being pinned to a row that might be the wrong
      // one. `VALIDATION_FAILED` does carry the index, and lands on its row:
      // the form's `Form.List` is called `permissions` and the body's array is
      // too, so `permissions[0].key` needs no prefix stripping here.
      const handled = applyFieldIssues(
        form,
        formFieldIssues(error, { fields: ['permissions'] }),
      );
      if (!handled) notices.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title="Add permissions"
      okText="Add"
      confirmLoading={submitting}
      onOk={() => void handleOk()}
      onCancel={onCancel}
      destroyOnHidden
      width={720}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBlockEnd: 16 }}
        message="Keys are permanent"
        description={
          <>
            Use the dotted <code>{applicationKey}.resource.action</code> form. A
            key cannot be renamed afterwards: roles, menu mappings and audit
            records all address permissions by it.
          </>
        }
      />

      <Form<AddFormValues>
        form={form}
        layout="vertical"
        disabled={submitting}
        initialValues={{ permissions: [{ key: '', name: '', description: '' }] }}
      >
        <Form.List name="permissions">
          {(fields, { add, remove }) => (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {fields.map((field) => (
                <div
                  key={field.key}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    width: '100%',
                  }}
                >
                  <Form.Item
                    name={[field.name, 'key']}
                    label="Key"
                    rules={[
                      { required: true, message: 'A key is required.' },
                      {
                        pattern: /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/,
                        message: 'Dotted lowercase, e.g. gatepass.pass.create.',
                      },
                    ]}
                    style={{ marginBottom: 0, flex: 2 }}
                  >
                    <Input placeholder={`${applicationKey}.pass.create`} />
                  </Form.Item>

                  <Form.Item
                    name={[field.name, 'name']}
                    label="Name"
                    rules={[{ required: true, message: 'A name is required.' }]}
                    style={{ marginBottom: 0, flex: 2 }}
                  >
                    <Input placeholder="Create a pass" />
                  </Form.Item>

                  <Form.Item
                    name={[field.name, 'description']}
                    label="Description"
                    style={{ marginBottom: 0, flex: 3 }}
                  >
                    <Input placeholder="Optional" />
                  </Form.Item>

                  <Form.Item label=" " style={{ marginBottom: 0 }}>
                    <Button
                      icon={<DeleteOutlined />}
                      aria-label="Remove this permission"
                      // Never below one row: an empty list submits an empty
                      // array, which the server refuses with a validation error
                      // that says nothing useful about what the operator did.
                      disabled={fields.length === 1}
                      onClick={() => remove(field.name)}
                    />
                  </Form.Item>
                </div>
              ))}

              <Button
                type="dashed"
                block
                icon={<PlusOutlined />}
                onClick={() => add({ key: '', name: '', description: '' })}
              >
                Add another
              </Button>
            </Space>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}

