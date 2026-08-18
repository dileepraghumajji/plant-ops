'use client';

/**
 * One person: their profile, what they can do, and the account state machine
 * (Doc 09 §3.3, Doc 06 §8, Doc 03 §8).
 *
 * Unlike the role and client detail screens, this one has a real
 * `GET /iam/users/:id` — Doc 06 §8 gives it because the detail carries something
 * the list cannot: the bindings. So no page walking here; one request answers
 * the whole screen.
 *
 * ## Two questions, in this order
 *
 * "Can they sign in?" and "what can they do?" are independent, and confusing
 * them is the most common misreading of this system. An active account with no
 * bindings signs in and sees an empty console; a disabled account with a dozen
 * grants holds every one of them and resolves to nothing (Doc 04 §7). The header
 * answers the first and the panel answers the second, and neither pretends to
 * answer the other.
 */

import type { UserDetailDTO } from '@plantops/contracts';
import { PageHeader, ScreenLoading, StatusTag } from '@plantops/ui';
import { useAsync, useIam } from '@plantops/web-kit';
import { Alert, Button, Descriptions, Result, Space, Tag, Typography } from 'antd';
import { useParams, useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';

import { ScreenFailure } from '../../../../components/screen-failure';
import { BindingsPanel } from '../../../../components/users/bindings-panel';
import { StatusActions } from '../../../../components/users/status-actions';
import { UserForm } from '../../../../components/users/user-form';
import { CLIENT_PERMISSIONS as P } from '../../../../lib/iam-permissions';
import { canSignIn } from '../../../../lib/users';
import { usePermission } from '../../../../lib/use-permission';

export default function UserDetailPage(): ReactElement {
  const params = useParams<{ id: string }>();
  const userId = params.id;

  const iam = useIam();
  const router = useRouter();

  const canUpdate = usePermission(P.USER_UPDATE);
  const [editing, setEditing] = useState(false);

  const user = useAsync<UserDetailDTO>(() => iam.users.detail(userId), [iam, userId]);

  const found = user.data ?? null;

  const backToList = (
    <Button onClick={() => router.push('/admin/users')}>Back to users</Button>
  );

  if (user.loading && user.data === undefined) return <ScreenLoading rows={6} />;

  if (user.error !== null) {
    return <ScreenFailure error={user.error} onRetry={user.reload} action={backToList} />;
  }

  if (found === null) {
    return (
      <Result
        status="404"
        title="No such person"
        subTitle="They are not in your organisation. The account may have been created elsewhere, or the link may be stale."
        extra={backToList}
      />
    );
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ title: 'Users', href: '/admin/users' }, { title: found.full_name }]}
        title={
          <Space size="middle" wrap>
            <span>{found.full_name}</span>
            <StatusTag status={found.status} />
            {found.is_client_admin && <Tag color="purple">Administrator</Tag>}
          </Space>
        }
        description={
          <Typography.Text
            type="secondary"
            copyable={{ text: found.email }}
            style={{ fontFamily: 'var(--ant-font-family-code)' }}
          >
            {found.email}
          </Typography.Text>
        }
        actions={
          <Space wrap>
            {canUpdate && <Button onClick={() => setEditing(true)}>Edit profile</Button>}
            <StatusActions user={found} onChanged={user.reload} />
          </Space>
        }
      />

      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {!canSignIn(found) && (
          <Alert
            type={found.status === 'locked' ? 'warning' : 'error'}
            showIcon
            message={
              found.status === 'locked'
                ? 'This account is locked'
                : 'This account is disabled'
            }
            description={
              found.status === 'locked'
                ? 'They cannot sign in. Everything below is still held and takes effect again the moment the account is unlocked — nothing was taken away.'
                : 'They cannot sign in and their permissions resolve to nothing. Everything below is still recorded, and takes effect again if the account is reactivated.'
            }
          />
        )}

        {canSignIn(found) && found.bindings.length === 0 && (
          <Alert
            type="info"
            showIcon
            message="They can sign in, and can do nothing"
            description="Signing in and having access are two different things. Until this person is bound to a role at a node of the org tree, their console will be empty."
          />
        )}

        <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered>
          <Descriptions.Item label="Phone">
            {found.phone === null || found.phone === '' ? (
              <Typography.Text type="secondary">Not given</Typography.Text>
            ) : (
              found.phone
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Added">
            {new Date(found.created_at).toLocaleString()}
          </Descriptions.Item>
        </Descriptions>

        <BindingsPanel
          bindings={found.bindings}
          onAssignAccess={() => router.push('/admin/access')}
        />
      </Space>

      <UserForm
        open={editing}
        user={found}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          user.reload();
        }}
      />
    </>
  );
}
