'use client';

/**
 * *Applications* — which of the registered applications this tenant may use
 * (Doc 09 §2.2, Doc 02 §3 step 2, Doc 06 §5).
 *
 * The switch that decides whether a tenant's roles can carry an application's
 * permissions at all. Doc 04 §7 has a disabled `client_application` remove that
 * application's permissions from every resolve in the tenant, and Doc 05 §3 has
 * its menus disappear — so this is the widest-reaching control in the platform
 * console, and the confirmation says so.
 *
 * ## Two endpoints behind one switch
 *
 * An application the tenant has never had takes `POST /iam/clients/:id/applications`
 * (the bulk enablement of Doc 02 §3 step 2); one it has had before takes
 * `PATCH …/applications/:appId`, because the row is still there. Doc 02 §7 keeps
 * a disabled row rather than deleting it, precisely so that re-enabling is a
 * toggle rather than a re-setup: the per-application config survives, and so
 * does every `role_permission` a tenant admin built on top of it.
 *
 * `mergeEnablements` in `lib/clients.ts` is what decides which of the two a row
 * is, and it is tested there rather than here.
 *
 * ## Turning one off is not deleting it
 *
 * The confirmation is the same shape as the application-deactivation one, and
 * for the same reason: an operator who expects "remove" and finds "disable"
 * needs to be told the mappings are kept, or they will go looking for a delete
 * that does not exist and cannot exist.
 */

import type { ApplicationDTO, ClientDTO } from '@plantops/contracts';
import { PageHeader, ScreenEmpty, ScreenLoading, StatusTag } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { Space, Switch, Table, Tooltip, Typography } from 'antd';
import { useMemo, useState, type ReactElement } from 'react';

import { mergeEnablements, type AppEnablement } from '../../lib/clients';
import { PLATFORM_PERMISSIONS as P } from '../../lib/iam-permissions';
import { collectPages } from '../../lib/paging';
import { usePermission } from '../../lib/use-permission';
import { ScreenFailure } from '../screen-failure';

export const DISABLE_CONSEQUENCES =
  'Its permissions stop resolving for every user of this tenant and its menus ' +
  'disappear, within seconds. Nothing is deleted — the roles that map its ' +
  'permissions and this tenant’s settings for it are kept, and switching it ' +
  'back on restores them exactly.';

export interface AppTogglesProps {
  client: ClientDTO;
  /** Tells the detail screen the enabled count moved. */
  onChanged: () => void;
}

export function AppToggles({ client, onChanged }: AppTogglesProps): ReactElement {
  const iam = useIam();
  const notices = useNotices();
  const canEnable = usePermission(P.CLIENT_APP_ENABLE);
  const canUpdate = usePermission(P.CLIENT_APP_UPDATE);

  /** Application ids mid-flight, so two switches do not share one spinner. */
  const [busy, setBusy] = useState<readonly string[]>([]);

  const data = useAsync(
    async () => {
      // Both lists, together: the catalog is what there is to offer and the
      // rows are this tenant's stance on it. The catalog is walked rather than
      // paged — a toggle list with a pager would hide the application the
      // operator came to switch on (`lib/paging.ts` bounds the walk).
      const [catalog, rows] = await Promise.all([
        collectPages<ApplicationDTO>((query) => iam.applications.list(query)),
        iam.clients.listApplications(client.id),
      ]);
      return mergeEnablements(catalog, rows);
    },
    [iam, client.id],
  );

  const entries = useMemo(() => data.data ?? [], [data.data]);

  const setEnabled = async (entry: AppEnablement, enabled: boolean): Promise<void> => {
    const { application } = entry;

    if (!enabled) {
      const confirmed = await notices.confirm({
        title: `Disable ${application.name} for ${client.name}?`,
        content: DISABLE_CONSEQUENCES,
        okText: 'Disable',
        danger: true,
      });
      if (!confirmed) return;
    }

    setBusy((ids) => [...ids, application.id]);
    try {
      if (entry.row === null) {
        // Never enabled here before, so there is no row to patch. The bulk
        // endpoint takes one entry perfectly well; it is bulk so that a whole
        // product surface can be handed over at once (Doc 02 §3 step 2).
        await iam.clients.enableApplications(client.id, {
          applications: [{ application_id: application.id }],
        });
      } else {
        await iam.clients.updateApplication(client.id, application.id, { enabled });
      }

      notices.success(
        enabled
          ? `${application.name} is enabled for ${client.name}.`
          : `${application.name} is disabled for ${client.name}. Its mappings are kept.`,
      );
      // Doc 09 §4: a grant change takes a few seconds to reach every cache, and
      // an admin who checks immediately and sees the old access concludes the
      // change did not save.
      notices.accessChanged();
      data.reload();
      onChanged();
    } catch (error) {
      notices.error(error);
    } finally {
      setBusy((ids) => ids.filter((id) => id !== application.id));
    }
  };

  const columns = [
    {
      title: 'Key',
      key: 'key',
      width: 200,
      render: (_: unknown, entry: AppEnablement) => (
        <Typography.Text style={{ fontFamily: 'var(--ant-font-family-code)' }}>
          {entry.application.key}
        </Typography.Text>
      ),
    },
    {
      title: 'Application',
      key: 'name',
      render: (_: unknown, entry: AppEnablement) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{entry.application.name}</Typography.Text>
          {entry.application.description !== null &&
            entry.application.description !== '' && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {entry.application.description}
              </Typography.Text>
            )}
        </Space>
      ),
    },
    {
      title: 'State',
      key: 'state',
      width: 220,
      render: (_: unknown, entry: AppEnablement) => (
        <Space size="small" wrap>
          <StatusTag status={entry.enabled ? 'enabled' : 'inactive'} />
          {!entry.application.is_active && (
            <Tooltip title="This application is deactivated in the registry, so it is off for every tenant regardless of this switch.">
              <span>
                <StatusTag
                  status="retired"
                  tone="attention"
                  label="Retired in registry"
                />
              </span>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Enabled',
      key: 'toggle',
      width: 110,
      render: (_: unknown, entry: AppEnablement) => {
        // Enabling a never-enabled application and toggling an existing row are
        // two permissions, so which one gates the switch depends on the row.
        const allowed = entry.row === null ? canEnable : canUpdate;
        return (
          <Tooltip
            title={
              allowed
                ? undefined
                : `You do not hold ${
                    entry.row === null
                      ? P.CLIENT_APP_ENABLE
                      : P.CLIENT_APP_UPDATE
                  }.`
            }
          >
            <Switch
              checked={entry.enabled}
              loading={busy.includes(entry.application.id)}
              disabled={!allowed}
              onClick={(checked) => void setEnabled(entry, checked)}
            />
          </Tooltip>
        );
      },
    },
  ];

  if (data.loading && data.data === undefined) return <ScreenLoading rows={4} />;

  if (data.error !== null) {
    return <ScreenFailure error={data.error} onRetry={data.reload} />;
  }

  return (
    <>
      <PageHeader
        title="Applications"
        description="What this tenant may run. Turning one off removes its permissions from every resolve in the tenant and hides its menus — without deleting a single mapping."
      />

      {entries.length === 0 ? (
        <ScreenEmpty
          title="Nothing to enable yet"
          description="No application is registered with the IAM, so there is nothing this tenant could be given. Register one first."
        />
      ) : (
        <Table<AppEnablement>
          dataSource={entries}
          columns={columns}
          rowKey={(entry) => entry.application.id}
          pagination={false}
          size="small"
          loading={data.loading}
        />
      )}
    </>
  );
}
