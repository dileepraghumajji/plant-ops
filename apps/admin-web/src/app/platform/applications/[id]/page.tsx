'use client';

/**
 * One application, and the three things a platform admin does to it
 * (Doc 09 §2.1): declare its permissions, build its navigation, and map the two
 * together. Those are steps 2, 3 and 4 of Doc 02 §2's registration sequence,
 * which is why they are three tabs of one screen rather than three screens.
 *
 * ## How the screen finds its application
 *
 * By walking the list. Doc 06 §4 has no `GET /iam/applications/:id`, and
 * `applications.controller.ts` says why: it would return exactly what the list
 * returns. So `findInPages` reads pages until the id turns up — a bounded read
 * over a catalog of tens of rows, explained in `lib/paging.ts`. A `null` result
 * is a genuine 404 for this console: either the application was never
 * registered, or the caller is looking at a link someone else's browser made.
 *
 * ## One version counter, three tabs
 *
 * The tabs are not independent. Adding a permission changes what the mapping
 * picker can offer; adding a nav node changes what there is to map; saving a
 * mapping changes the `requires` the navigation tree shows per row. Rather than
 * give each tab a cache and a story about invalidating it, each one reloads
 * when `version` changes, and any tab that writes bumps it. Three cheap reads
 * against one application's catalog, and no state that can be stale.
 */

import type { ApplicationDTO } from '@plantops/contracts';
import { PageHeader, ScreenLoading, StatusTag } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { Button, Result, Space, Tabs, Tooltip, Typography } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useState, type ReactElement } from 'react';

import { ApplicationFormModal } from '../../../../components/applications/application-form-modal';
import { DEACTIVATION_CONSEQUENCES } from '../../../../components/applications/copy';
import { MenuPermissionsTab } from '../../../../components/applications/menu-permissions-tab';
import { NavTreeEditor } from '../../../../components/applications/nav-tree-editor';
import { PermissionsTab } from '../../../../components/applications/permissions-tab';
import { ScreenFailure } from '../../../../components/screen-failure';
import { PLATFORM_PERMISSIONS as P } from '../../../../lib/iam-permissions';
import { findInPages } from '../../../../lib/paging';
import { usePermission } from '../../../../lib/use-permission';

export default function ApplicationDetailPage(): ReactElement {
  const params = useParams<{ id: string }>();
  const applicationId = params.id;

  const iam = useIam();
  const router = useRouter();
  const notices = useNotices();

  const canUpdate = usePermission(P.APP_UPDATE);

  /** Bumped by any tab that writes, so the other two reload. */
  const [version, setVersion] = useState(0);
  const onChanged = useCallback(() => setVersion((n) => n + 1), []);

  const [editing, setEditing] = useState(false);
  const [toggling, setToggling] = useState(false);

  const application = useAsync(
    () =>
      findInPages<ApplicationDTO>(
        (query) => iam.applications.list(query),
        (row) => row.id === applicationId,
      ),
    [iam, applicationId],
  );

  const app = application.data ?? null;

  const setActive = useCallback(
    async (isActive: boolean): Promise<void> => {
      if (app === null) return;
      if (!isActive) {
        const confirmed = await notices.confirm({
          title: `Deactivate ${app.name}?`,
          content: DEACTIVATION_CONSEQUENCES,
          okText: 'Deactivate',
          danger: true,
        });
        if (!confirmed) return;
      }

      setToggling(true);
      try {
        await iam.applications.update(app.id, { is_active: isActive });
        notices.success(
          isActive
            ? `${app.name} is active.`
            : `${app.name} is deactivated. Its data is kept.`,
        );
        application.reload();
      } catch (error) {
        notices.error(error);
      } finally {
        setToggling(false);
      }
    },
    [app, iam, notices, application],
  );

  const backToList = (
    <Button onClick={() => router.push('/platform/applications')}>
      Back to applications
    </Button>
  );

  if (application.loading) return <ScreenLoading rows={5} />;

  if (application.error !== null) {
    return (
      <ScreenFailure
        error={application.error}
        onRetry={application.reload}
        action={backToList}
      />
    );
  }

  if (app === null) {
    return (
      <Result
        status="404"
        title="No such application"
        subTitle="It is not in the registry. It may never have been registered, or the link may be stale."
        extra={backToList}
      />
    );
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { title: 'Applications', href: '/platform/applications' },
          { title: app.name },
        ]}
        title={
          <Space size="middle" wrap>
            <span>{app.name}</span>
            <StatusTag status={app.is_active ? 'active' : 'inactive'} />
          </Space>
        }
        description={
          <Space direction="vertical" size={4}>
            <Typography.Text
              type="secondary"
              copyable={{ text: app.key }}
              style={{ fontFamily: 'var(--ant-font-family-code)' }}
            >
              {app.key}
            </Typography.Text>
            {app.description !== null && app.description !== '' && (
              <span>{app.description}</span>
            )}
          </Space>
        }
        actions={
          <>
            <Button
              icon={<UploadOutlined />}
              onClick={() => router.push('/platform/applications/manifest')}
            >
              Upload manifest
            </Button>
            {canUpdate && (
              <>
                <Button onClick={() => setEditing(true)}>Edit</Button>
                <Tooltip
                  title={
                    app.is_active
                      ? 'Hides it everywhere and stops its permissions resolving. Nothing is deleted.'
                      : 'Restores it exactly as it was.'
                  }
                >
                  <Button
                    danger={app.is_active}
                    loading={toggling}
                    onClick={() => void setActive(!app.is_active)}
                  >
                    {app.is_active ? 'Deactivate' : 'Activate'}
                  </Button>
                </Tooltip>
              </>
            )}
          </>
        }
      />

      <Tabs
        // Kept off the URL. The manifest screen turned out to be a sibling route
        // rather than a fourth tab — the document names its own application, so
        // it does not belong under one — which leaves nothing here that needs to
        // be linkable at tab granularity.
        defaultActiveKey="permissions"
        destroyOnHidden
        items={[
          {
            key: 'permissions',
            label: 'Permissions',
            children: (
              <PermissionsTab
                applicationId={app.id}
                applicationKey={app.key}
                version={version}
                onChanged={onChanged}
              />
            ),
          },
          {
            key: 'navigation',
            label: 'Navigation',
            children: (
              <NavTreeEditor
                applicationId={app.id}
                version={version}
                onChanged={onChanged}
              />
            ),
          },
          {
            key: 'menu-permissions',
            label: 'Menu permissions',
            children: (
              <MenuPermissionsTab
                applicationId={app.id}
                version={version}
                onChanged={onChanged}
              />
            ),
          },
        ]}
      />

      <ApplicationFormModal
        open={editing}
        application={app}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          application.reload();
        }}
      />
    </>
  );
}
