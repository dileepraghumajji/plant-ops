'use client';

/**
 * One role, and the only thing there is to do to it: decide what it carries
 * (Doc 09 §3.2, Doc 06 §7).
 *
 * ## How the screen finds its role
 *
 * By walking the list. Doc 06 §7 has no `GET /iam/roles/:id` — the list row
 * already carries everything a detail header shows, including the two counts —
 * so `findInPages` reads pages until the id turns up, the bounded read
 * `lib/paging.ts` explains. A `null` result is a genuine 404 here: a role of
 * another tenant is invisible under RLS and is therefore the same answer as one
 * that never existed, which is the point (Doc 06 §2).
 *
 * ## Why the header reloads after a save
 *
 * `permission_count` lives on the role row, and the picker changes it. Rather
 * than adjust a number locally to match what was just sent, the row is re-read:
 * one cheap request, and no state that can disagree with the server about what
 * the role now carries.
 */

import type { RoleDTO } from '@plantops/contracts';
import { PageHeader, ScreenLoading, StatusTag } from '@plantops/ui';
import { useAsync, useIam } from '@plantops/web-kit';
import { Alert, Button, Result, Space, Tag, Typography } from 'antd';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useState, type ReactElement } from 'react';

import { PermissionPicker } from '../../../../components/roles/permission-picker';
import { RoleFormModal } from '../../../../components/roles/role-form-modal';
import { ScreenFailure } from '../../../../components/screen-failure';
import { CLIENT_PERMISSIONS as P } from '../../../../lib/iam-permissions';
import { findInPages } from '../../../../lib/paging';
import { usePermission } from '../../../../lib/use-permission';

export default function RoleDetailPage(): ReactElement {
  const params = useParams<{ id: string }>();
  const roleId = params.id;

  const iam = useIam();
  const router = useRouter();

  const canUpdate = usePermission(P.ROLE_UPDATE);

  const [version, setVersion] = useState(0);
  const onSaved = useCallback(() => setVersion((n) => n + 1), []);
  const [editing, setEditing] = useState(false);

  const role = useAsync(
    () =>
      findInPages<RoleDTO>(
        (query) => iam.roles.list(query),
        (row) => row.id === roleId,
      ),
    [iam, roleId, version],
  );

  const found = role.data ?? null;

  const backToList = (
    <Button onClick={() => router.push('/admin/roles')}>Back to roles</Button>
  );

  if (role.loading && role.data === undefined) return <ScreenLoading rows={5} />;

  if (role.error !== null) {
    return <ScreenFailure error={role.error} onRetry={role.reload} action={backToList} />;
  }

  if (found === null) {
    return (
      <Result
        status="404"
        title="No such role"
        subTitle="It is not one of your organisation’s roles. It may have been deleted, or the link may be stale."
        extra={backToList}
      />
    );
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ title: 'Roles', href: '/admin/roles' }, { title: found.name }]}
        title={
          <Space size="middle" wrap>
            <span>{found.name}</span>
            {found.is_system && (
              <StatusTag status="system" tone="neutral" label="System role" />
            )}
            <Tag color={found.bound_subject_count === 0 ? 'default' : 'geekblue'}>
              held by {found.bound_subject_count}
            </Tag>
          </Space>
        }
        description={
          found.description !== null && found.description !== '' ? (
            found.description
          ) : (
            <Typography.Text type="secondary">
              Choose what this role carries. Everyone bound to it gains exactly
              this, wherever they are bound.
            </Typography.Text>
          )
        }
        actions={
          canUpdate &&
          !found.is_system && <Button onClick={() => setEditing(true)}>Edit</Button>
        }
      />

      {found.bound_subject_count > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBlockEnd: 16 }}
          message={`${found.bound_subject_count} subject${
            found.bound_subject_count === 1 ? '' : 's'
          } hold this role right now`}
          description="Changing what it carries changes their access everywhere they hold it, within a few seconds."
        />
      )}

      <PermissionPicker role={found} onSaved={onSaved} />

      <RoleFormModal
        open={editing}
        role={found}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          role.reload();
        }}
      />
    </>
  );
}
