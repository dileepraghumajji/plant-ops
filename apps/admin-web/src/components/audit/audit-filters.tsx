'use client';

/**
 * The audit filter bar (Doc 09 §2.3, §3.6, Doc 06 §12).
 *
 * Six fields, every one narrowing and all of them composable — which is what
 * makes the trail answerable rather than merely readable: "what did this person
 * do to that role last Tuesday" is one query, not a scroll.
 *
 * ## Applying is explicit
 *
 * Every other filter bar in this console reacts as you type. This one does not,
 * and the reason is the export beside it: the export takes *the same filter* and
 * is refused above ten thousand rows, so an operator narrowing a compliance
 * range needs to be able to finish typing a date before anything is sent. A
 * live-updating bar would also make each keystroke a page-1 reset on a table
 * somebody is reading.
 *
 * ## The action field is free text with suggestions
 *
 * `lib/audit.ts` explains why there is no dropdown of actions: a hardcoded list
 * would be a fourth copy of the writers' catalog, and a retired action still in
 * the trail has to stay filterable. The suggestions are the actions on screen;
 * anything else typed goes to the server, which validates against the real
 * catalog and answers 400 naming the spelling it rejected.
 */

import type { AuditActorType } from '@plantops/contracts';
import { AUDIT_ACTOR_TYPE_VALUES } from '@plantops/contracts';
import { spacing } from '@plantops/ui';
import { DownloadOutlined, SearchOutlined } from '@ant-design/icons';
import { AutoComplete, Button, Input, Select, Space, Typography } from 'antd';
import { useEffect, useState, type ReactElement } from 'react';

import {
  NO_AUDIT_FILTERS,
  hasAuditFilters,
  type AuditFilters,
} from '../../lib/audit';

const ACTOR_LABEL: Readonly<Record<AuditActorType, string>> = {
  user: 'User',
  service_account: 'Service account',
  platform: 'Platform',
};

export interface AuditFiltersBarProps {
  /** The filter currently in effect — what the table and the export both use. */
  applied: AuditFilters;
  onApply: (filters: AuditFilters) => void;
  /** Actions seen in the loaded rows, offered as suggestions. */
  actionSuggestions: readonly string[];
  onExport: () => void;
  exporting: boolean;
}

export function AuditFiltersBar({
  applied,
  onApply,
  actionSuggestions,
  onExport,
  exporting,
}: AuditFiltersBarProps): ReactElement {
  const [draft, setDraft] = useState<AuditFilters>(applied);

  // Keeps the boxes honest when the filter is cleared from outside — the empty
  // state's "clear filters" button, say.
  useEffect(() => setDraft(applied), [applied]);

  const set = (patch: Partial<AuditFilters>): void =>
    setDraft((current) => ({ ...current, ...patch }));

  return (
    <Space direction="vertical" size={spacing.sm} style={{ width: '100%' }}>
      <Space size="middle" wrap align="start">
        <Labelled label="Action">
          <AutoComplete
            allowClear
            value={draft.action}
            onChange={(value: string) => set({ action: value ?? '' })}
            options={actionSuggestions.map((action) => ({ value: action }))}
            filterOption={(input, option) =>
              (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
            }
            placeholder="auth.login.success"
            style={{ width: 240, fontFamily: 'var(--ant-font-family-code)' }}
          />
        </Labelled>

        <Labelled label="Actor type">
          <Select<AuditActorType>
            allowClear
            value={draft.actorType ?? undefined}
            onChange={(value) => set({ actorType: value ?? null })}
            placeholder="Anyone"
            style={{ width: 170 }}
            options={AUDIT_ACTOR_TYPE_VALUES.map((type) => ({
              value: type,
              label: ACTOR_LABEL[type],
            }))}
          />
        </Labelled>

        <Labelled label="Actor id">
          <Input
            allowClear
            value={draft.actorId}
            onChange={(event) => set({ actorId: event.target.value })}
            placeholder="uuid"
            style={{ width: 220 }}
          />
        </Labelled>

        <Labelled label="Target type">
          <Input
            allowClear
            value={draft.targetType}
            onChange={(event) => set({ targetType: event.target.value })}
            placeholder="role_binding"
            style={{ width: 180 }}
          />
        </Labelled>

        <Labelled label="Target id">
          <Input
            allowClear
            value={draft.targetId}
            onChange={(event) => set({ targetId: event.target.value })}
            placeholder="uuid"
            style={{ width: 220 }}
          />
        </Labelled>

        <Labelled label="From (inclusive)">
          <Input
            type="datetime-local"
            value={draft.fromLocal}
            onChange={(event) => set({ fromLocal: event.target.value })}
            style={{ width: 220 }}
          />
        </Labelled>

        <Labelled label="To (exclusive)">
          <Input
            type="datetime-local"
            value={draft.toLocal}
            onChange={(event) => set({ toLocal: event.target.value })}
            style={{ width: 220 }}
          />
        </Labelled>
      </Space>

      <Space size="small" wrap>
        <Button
          type="primary"
          icon={<SearchOutlined />}
          onClick={() => onApply(draft)}
        >
          Apply
        </Button>

        {hasAuditFilters(applied) && (
          <Button onClick={() => onApply(NO_AUDIT_FILTERS)}>Clear</Button>
        )}

        <Button icon={<DownloadOutlined />} loading={exporting} onClick={onExport}>
          Export CSV
        </Button>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          The export takes the filter you have applied, whole — no page — and is
          itself recorded in the trail.
        </Typography.Text>
      </Space>
    </Space>
  );
}

function Labelled({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}): ReactElement {
  return (
    <Space direction="vertical" size={2}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      {children}
    </Space>
  );
}
