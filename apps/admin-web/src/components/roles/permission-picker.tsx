'use client';

/**
 * What a role carries — the permission picker (Doc 09 §3.2, Doc 06 §7,
 * Doc 02 §6).
 *
 * ## Grouped by application because that is how a permission is named
 *
 * A key is `app.resource.action` and is unique only within its application
 * (`unique (application_id, key)`), so a flat list of two hundred dotted strings
 * asks the operator to do the grouping in their head. Doc 09 §3.2 asks for the
 * grouping explicitly, and the search narrows *within* it: typing an application
 * name keeps that whole group, because "show me Gate Pass" is a different
 * request from "show me rows containing the word".
 *
 * ## Only enabled applications, and the API decides which
 *
 * `GET /iam/roles/permission-catalog` returns exactly the set
 * `PUT /iam/roles/:id/permissions` accepts (Doc 02 §6): the permission active,
 * its application active, and that application enabled for this tenant. Filtering
 * client-side instead would put the rule in two places, and the console's copy
 * would be the one that was wrong.
 *
 * ## Inert rows are shown, checked, and explained
 *
 * A role may map a permission the catalog cannot offer: its application was
 * disabled after the mapping was made, or a manifest retired the key. Doc 02 §7
 * *preserves* those rows — they grant nothing today and grant again the moment
 * the application comes back — so hiding them would show the role as smaller
 * than it is, and saving would silently unmap what the operator never saw. They
 * are rendered last, greyed, with the reason.
 *
 * ## A save is the whole set
 *
 * `PUT`, not a diff: "which permissions does this role have" is one question
 * with one answer, and a checklist submits a set. `selectionChanged` keeps the
 * button disabled until it would do something, because a no-op save writes no
 * audit record and an operator who pressed it deserves to know nothing happened
 * before they press it.
 */

import type { RoleDTO, RolePermissionDTO } from '@plantops/contracts';
import { ScreenEmpty, ScreenLoading, spacing } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { SearchOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Input,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { CLIENT_PERMISSIONS as P } from '../../lib/iam-permissions';
import {
  INERT_EXPLANATION,
  buildPicker,
  filterPicker,
  selectionChanged,
  type PickerGroup,
} from '../../lib/role-permissions';
import { usePermission } from '../../lib/use-permission';
import { ScreenFailure } from '../screen-failure';

export interface PermissionPickerProps {
  role: RoleDTO;
  /** Tells the detail screen the permission count moved. */
  onSaved: () => void;
}

export function PermissionPicker({ role, onSaved }: PermissionPickerProps): ReactElement {
  const iam = useIam();
  const notices = useNotices();
  const canSet = usePermission(P.ROLE_PERMISSION_SET);

  const [term, setTerm] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const data = useAsync(
    async () => {
      const [catalog, mapping] = await Promise.all([
        iam.roles.permissionCatalog(),
        iam.roles.permissions(role.id),
      ]);
      return { catalog: catalog.permissions, mapped: mapping.permissions };
    },
    [iam, role.id],
  );

  const mapped = useMemo<RolePermissionDTO[]>(() => data.data?.mapped ?? [], [data.data]);

  // The checkboxes start from what the role holds, and re-sync whenever the
  // server's answer changes — after a save, and after a reload. Deriving them on
  // every render instead would throw away the operator's in-progress choices.
  useEffect(() => {
    setChosen(new Set(mapped.map((permission) => permission.id)));
  }, [mapped]);

  const groups = useMemo(
    () => buildPicker(data.data?.catalog ?? [], mapped),
    [data.data, mapped],
  );
  const visible = useMemo(() => filterPicker(groups, term), [groups, term]);

  const toggle = useCallback((id: string, checked: boolean): void => {
    setChosen((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((group: PickerGroup, checked: boolean): void => {
    setChosen((current) => {
      const next = new Set(current);
      for (const row of group.permissions) {
        if (checked) next.add(row.permission.id);
        else next.delete(row.permission.id);
      }
      return next;
    });
  }, []);

  const dirty = selectionChanged(mapped, chosen);

  const save = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      await iam.roles.setPermissions(role.id, { permission_ids: [...chosen] });
      notices.success(`“${role.name}” updated.`);
      // Doc 09 §4: everyone bound to this role has their grants recomputed, and
      // an admin who checks immediately would otherwise see the old access and
      // conclude the save failed.
      notices.accessChanged();
      data.reload();
      onSaved();
    } catch (error) {
      notices.error(error);
    } finally {
      setSaving(false);
    }
  }, [iam, role.id, role.name, chosen, notices, data, onSaved]);

  if (data.loading && data.data === undefined) return <ScreenLoading rows={6} />;
  if (data.error !== null) {
    return <ScreenFailure error={data.error} onRetry={data.reload} />;
  }

  if (groups.length === 0) {
    return (
      <ScreenEmpty
        title="Nothing to grant yet"
        description="No application is enabled for your organisation, so there are no permissions a role could carry. Ask the platform team to enable one."
      />
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space size="middle" wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search permissions or applications"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          style={{ width: 320 }}
        />

        <Space size="small">
          <Typography.Text type="secondary">
            {chosen.size} selected
            {dirty && mapped.length !== chosen.size
              ? ` (was ${mapped.length})`
              : ''}
          </Typography.Text>
          <Tooltip
            title={
              canSet
                ? dirty
                  ? undefined
                  : 'Nothing has changed.'
                : `You do not hold ${P.ROLE_PERMISSION_SET}.`
            }
          >
            <Button
              type="primary"
              loading={saving}
              disabled={!canSet || !dirty}
              onClick={() => void save()}
            >
              Save permissions
            </Button>
          </Tooltip>
        </Space>
      </Space>

      {visible.length === 0 ? (
        <ScreenEmpty
          title="Nothing matches"
          description="No permission or application matches that search."
        />
      ) : (
        <Collapse
          defaultActiveKey={visible.map((group) => group.applicationId)}
          items={visible.map((group) => ({
            key: group.applicationId,
            label: <GroupLabel group={group} chosen={chosen} />,
            extra: canSet && (
              <Button
                type="link"
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  const all = group.permissions.every((row) =>
                    chosen.has(row.permission.id),
                  );
                  toggleGroup(group, !all);
                }}
              >
                {group.permissions.every((row) => chosen.has(row.permission.id))
                  ? 'Clear'
                  : 'Select all'}
              </Button>
            ),
            children: (
              <Space direction="vertical" size={spacing.xs} style={{ width: '100%' }}>
                {group.inert && (
                  <Alert
                    type="info"
                    showIcon
                    message="Kept, but granting nothing right now"
                    description={INERT_EXPLANATION['application-disabled']}
                  />
                )}
                {group.permissions.map((row) => (
                  <Checkbox
                    key={row.permission.id}
                    checked={chosen.has(row.permission.id)}
                    disabled={!canSet}
                    onChange={(event) => toggle(row.permission.id, event.target.checked)}
                  >
                    <Space direction="vertical" size={0}>
                      <Space size="small" wrap>
                        <Typography.Text
                          style={{ fontFamily: 'var(--ant-font-family-code)' }}
                        >
                          {row.permission.key}
                        </Typography.Text>
                        {row.inert !== null && (
                          <Tooltip title={INERT_EXPLANATION[row.inert]}>
                            <Tag color="default" style={{ marginInlineEnd: 0 }}>
                              {row.inert === 'permission-retired'
                                ? 'Retired'
                                : 'App disabled'}
                            </Tag>
                          </Tooltip>
                        )}
                      </Space>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {row.permission.name}
                        {row.permission.description !== null &&
                          row.permission.description !== '' &&
                          ` — ${row.permission.description}`}
                      </Typography.Text>
                    </Space>
                  </Checkbox>
                ))}
              </Space>
            ),
          }))}
        />
      )}
    </Space>
  );
}

function GroupLabel({
  group,
  chosen,
}: {
  group: PickerGroup;
  chosen: ReadonlySet<string>;
}): ReactElement {
  const count = group.permissions.filter((row) => chosen.has(row.permission.id)).length;

  return (
    <Space size="small" wrap>
      <Typography.Text strong>{group.applicationName}</Typography.Text>
      <Typography.Text
        type="secondary"
        style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
      >
        {group.applicationKey}
      </Typography.Text>
      <Tag color={count === 0 ? 'default' : 'blue'} style={{ marginInlineEnd: 0 }}>
        {count} of {group.permissions.length}
      </Tag>
      {group.inert && (
        <Tag color="default" style={{ marginInlineEnd: 0 }}>
          Not enabled
        </Tag>
      )}
    </Space>
  );
}
