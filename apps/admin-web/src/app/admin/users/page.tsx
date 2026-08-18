'use client';

/**
 * The tenant's people (Doc 09 §3.3, Doc 06 §8).
 *
 * ## "Account Locked Users" is a tab, not a screen
 *
 * Doc 09 §3.3 names a locked-users view, and it is this list with `?status=locked`.
 * A separate route would be a second implementation of the search, the paging
 * and the row actions, kept in step with this one by hand — and the thing an
 * administrator does after finding a locked account is unlock it, which is the
 * same row action either way. The tab's own description says what locked means
 * and that unlocking takes nothing away, because that is the misreading the
 * screen exists to prevent.
 *
 * ## Search and filter go to the server
 *
 * `?q=` searches name and email and `?status=` narrows, both on the endpoint.
 * Filtering a page client-side would filter *the page*, which for a tenant of
 * four hundred people means a search that finds nobody on page three.
 *
 * ## There is no delete
 *
 * Offboarding is `disabled` (Doc 01 §3.6), so that the person's grants and every
 * audit row naming them survive them. The row action is therefore the profile,
 * where the state machine lives with its consequences spelled out.
 */

import type { UserDTO, UserStatus } from '@plantops/contracts';
import { DataTable, PageHeader, ScreenEmpty, StatusTag } from '@plantops/ui';
import { useAsync, useIam } from '@plantops/web-kit';
import {
  PlusOutlined,
  SearchOutlined,
  TeamOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { Button, Input, Space, Tabs, Tag, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { ScreenFailure } from '../../../components/screen-failure';
import { UserForm } from '../../../components/users/user-form';
import { CLIENT_PERMISSIONS as P } from '../../../lib/iam-permissions';
import { STATUS_TABS, tabFor } from '../../../lib/users';
import { usePermission } from '../../../lib/use-permission';

/** Long enough that typing a name is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;

export default function UsersPage(): ReactElement {
  const iam = useIam();
  const router = useRouter();

  const canCreate = usePermission(P.USER_CREATE);

  const [tabKey, setTabKey] = useState<string>(STATUS_TABS[0].key);
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState({ page: 1, limit: 25 });
  const [creating, setCreating] = useState(false);

  const tab = useMemo(() => tabFor(tabKey), [tabKey]);

  // Debounced, so a name typed at speed is one request rather than nine.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  // A narrowed list is a different list, and page four of the old one is
  // meaningless in it.
  useEffect(() => {
    setQuery((current) => ({ ...current, page: 1 }));
  }, [search, tabKey]);

  const users = useAsync(
    () =>
      iam.users.list({
        ...query,
        ...(tab.status === undefined ? {} : { status: tab.status }),
        ...(search === '' ? {} : { q: search }),
      }),
    [iam, query.page, query.limit, tab.status, search],
  );

  const columns = [
    {
      title: 'Name',
      dataIndex: 'full_name',
      render: (name: string, row: UserDTO) => (
        <Space direction="vertical" size={0}>
          <Space size="small" wrap>
            <Typography.Text strong>{name}</Typography.Text>
            {row.is_client_admin && (
              <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                Administrator
              </Tag>
            )}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.email}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Phone',
      dataIndex: 'phone',
      width: 180,
      render: (phone: string | null) =>
        phone === null || phone === '' ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          phone
        ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 130,
      render: (status: UserStatus) => <StatusTag status={status} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone in your organisation. Signing in is one thing and being able to do something is another — open a profile to see what a person actually holds."
        actions={
          <>
            {/*
              Ungated, like every other way into a screen: the two below make
              their own calls and render their own refusals, and a link that
              vanished would leave a menu entry with nothing behind it (Doc 09 §4).
            */}
            <Button
              icon={<TeamOutlined />}
              onClick={() => router.push('/admin/users/by-role')}
            >
              By role
            </Button>
            <Button
              icon={<UploadOutlined />}
              onClick={() => router.push('/admin/users/bulk')}
            >
              Bulk upload
            </Button>
            {canCreate && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setCreating(true)}
              >
                Add a person
              </Button>
            )}
          </>
        }
        footer={
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Tabs
              activeKey={tabKey}
              onChange={setTabKey}
              items={STATUS_TABS.map((entry) => ({
                key: entry.key,
                label: entry.label,
              }))}
              style={{ marginBlockEnd: 0 }}
            />
            <Space
              size="middle"
              wrap
              style={{ width: '100%', justifyContent: 'space-between' }}
            >
              <Typography.Text type="secondary">{tab.description}</Typography.Text>
              <Input
                allowClear
                prefix={<SearchOutlined />}
                placeholder="Search by name or email"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                style={{ width: 300 }}
              />
            </Space>
          </Space>
        }
      />

      <DataTable<UserDTO>
        result={users.data}
        loading={users.loading}
        columns={columns}
        rowKey={(row) => row.id}
        onQueryChange={setQuery}
        onRowClick={(row) => router.push(`/admin/users/${row.id}`)}
        empty={
          <ScreenEmpty
            title={search === '' ? emptyTitle(tab.status) : 'Nobody matches'}
            description={
              search === ''
                ? tab.description
                : 'No name or email in this view matches that search.'
            }
            action={
              search === '' &&
              tab.status === undefined && (
                <Space>
                  <Button onClick={() => router.push('/admin/users/bulk')}>
                    Upload a roster
                  </Button>
                  {canCreate && (
                    <Button type="primary" onClick={() => setCreating(true)}>
                      Add the first person
                    </Button>
                  )}
                </Space>
              )
            }
          />
        }
        error={
          users.error === null || users.loading ? undefined : (
            <ScreenFailure error={users.error} onRetry={users.reload} />
          )
        }
      />

      <UserForm
        open={creating}
        user={null}
        onCancel={() => setCreating(false)}
        onSaved={(created) => {
          setCreating(false);
          // Straight into the profile: an account that can sign in and do
          // nothing is half a person, and granting access is the next step.
          router.push(`/admin/users/${created.id}`);
        }}
      />
    </>
  );
}

function emptyTitle(status: UserStatus | undefined): string {
  switch (status) {
    case 'locked':
      return 'No locked accounts';
    case 'disabled':
      return 'No disabled accounts';
    case 'active':
      return 'No active accounts';
    default:
      return 'Nobody here yet';
  }
}
