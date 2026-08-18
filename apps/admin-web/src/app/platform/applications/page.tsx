'use client';

/**
 * The application catalog (Doc 09 §2.1, Doc 06 §4).
 *
 * The list every other platform screen hangs off: what is registered, what is
 * switched on, and the way in to a single application's permissions, navigation
 * and menu-permission mappings.
 *
 * ## There is no delete, and that is the screen's job to say
 *
 * Doc 02 §7 retires an application with `is_active = false`, and the API has no
 * `DELETE` at all — a delete would cascade away the permissions that live role
 * mappings and audit rows still refer to (`applications.service.ts`). So the row
 * action is a toggle, and the confirmation says what deactivating does and does
 * not do. An operator who expects "remove" and finds "deactivate" needs to be
 * told the data is kept, or they will go looking for the delete elsewhere.
 *
 * ## Registering by form is the secondary path
 *
 * Doc 02 §2 makes the manifest the primary way an application arrives, and
 * Session 29 builds that screen. The form here is what registers the
 * application *row* — which the manifest upload needs to exist first, since it
 * uploads to `/iam/applications/:id/manifest`.
 */

import type { ApplicationDTO } from '@plantops/contracts';
import { DataTable, PageHeader, ScreenEmpty, StatusTag } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { Button, Space, Switch, Tooltip, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import { useCallback, useState, type ReactElement } from 'react';

import { ApplicationFormModal } from '../../../components/applications/application-form-modal';
import { DEACTIVATION_CONSEQUENCES } from '../../../components/applications/copy';
import { ScreenFailure } from '../../../components/screen-failure';
import { PLATFORM_PERMISSIONS as P } from '../../../lib/iam-permissions';
import { usePermission } from '../../../lib/use-permission';

export default function ApplicationsPage(): ReactElement {
  const iam = useIam();
  const router = useRouter();
  const notices = useNotices();

  const canCreate = usePermission(P.APP_CREATE);
  const canUpdate = usePermission(P.APP_UPDATE);

  const [query, setQuery] = useState({ page: 1, limit: 25 });
  const [registering, setRegistering] = useState(false);
  // Ids currently mid-toggle, so two clicks on two rows do not fight over one
  // boolean and each row's own switch shows its own progress.
  const [toggling, setToggling] = useState<readonly string[]>([]);

  const applications = useAsync(
    () => iam.applications.list(query),
    [iam, query.page, query.limit],
  );

  const setActive = useCallback(
    async (application: ApplicationDTO, isActive: boolean): Promise<void> => {
      setToggling((ids) => [...ids, application.id]);
      try {
        await iam.applications.update(application.id, { is_active: isActive });
        notices.success(
          isActive
            ? `${application.name} is active.`
            : `${application.name} is deactivated. Its data is kept.`,
        );
        applications.reload();
      } catch (error) {
        notices.error(error);
      } finally {
        setToggling((ids) => ids.filter((id) => id !== application.id));
      }
    },
    [iam, notices, applications],
  );

  const confirmDeactivate = useCallback(
    async (application: ApplicationDTO): Promise<void> => {
      const confirmed = await notices.confirm({
        title: `Deactivate ${application.name}?`,
        content: DEACTIVATION_CONSEQUENCES,
        okText: 'Deactivate',
        danger: true,
      });
      if (confirmed) await setActive(application, false);
    },
    [notices, setActive],
  );

  const columns = [
    {
      title: 'Key',
      dataIndex: 'key',
      width: 200,
      render: (key: string) => (
        <Typography.Text style={{ fontFamily: 'var(--ant-font-family-code)' }}>
          {key}
        </Typography.Text>
      ),
    },
    {
      title: 'Name',
      dataIndex: 'name',
      render: (name: string, row: ApplicationDTO) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{name}</Typography.Text>
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
    {
      title: 'Active',
      key: 'toggle',
      width: 100,
      render: (_: unknown, row: ApplicationDTO) => (
        // Disabled rather than hidden: a table column that vanishes for some
        // rows and not others is the layout case `usePermission` calls out.
        <Tooltip
          title={
            canUpdate ? undefined : 'You do not hold iam.platform.app.update.'
          }
        >
          <Switch
            checked={row.is_active}
            loading={toggling.includes(row.id)}
            disabled={!canUpdate}
            onClick={(checked, event) => {
              event.stopPropagation();
              if (checked) void setActive(row, true);
              else void confirmDeactivate(row);
            }}
          />
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Applications"
        description="Every application registered with the IAM. Open one to edit its permissions, its navigation and the mapping between them."
        actions={
          canCreate && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setRegistering(true)}
            >
              Register application
            </Button>
          )
        }
      />

      <DataTable<ApplicationDTO>
        result={applications.data}
        loading={applications.loading}
        columns={columns}
        rowKey={(row) => row.id}
        onQueryChange={setQuery}
        onRowClick={(row) => router.push(`/platform/applications/${row.id}`)}
        empty={
          <ScreenEmpty
            title="No applications yet"
            description="An application is registered once, then evolves by manifest upload — permissions, menus and mappings, without a deploy."
            action={
              canCreate && (
                <Button type="primary" onClick={() => setRegistering(true)}>
                  Register the first application
                </Button>
              )
            }
          />
        }
        error={
          applications.error === null || applications.loading ? undefined : (
            <ScreenFailure error={applications.error} onRetry={applications.reload} />
          )
        }
      />

      <ApplicationFormModal
        open={registering}
        application={null}
        onCancel={() => setRegistering(false)}
        onSaved={(created) => {
          setRegistering(false);
          // Straight into the detail screen: a bare application row is not
          // useful until it has permissions and a menu, and that is the next
          // thing the operator came to do (Doc 02 §2 steps 2–4).
          router.push(`/platform/applications/${created.id}`);
        }}
      />
    </>
  );
}

