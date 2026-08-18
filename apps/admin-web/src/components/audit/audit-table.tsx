'use client';

/**
 * The audit browser (Doc 09 §2.3 and §3.6, Doc 06 §12, Doc 10 §7).
 *
 * ## One component, two consoles, and no tier parameter
 *
 * `GET /iam/audit` is one route that either tier's key admits, and which one the
 * caller holds decides nothing about the request. What a reader sees is decided
 * by the `audit_trail_read` policy alone: a client admin their own tenant's
 * rows, a platform admin everything including the `client_id IS NULL` rows that
 * record platform-level acts.
 *
 * So this is the same screen twice, and the difference is a sentence and a
 * column. The alternative — a `?tier=` or a client-side filter — would be the
 * console *asserting* the isolation instead of the database enforcing it, which
 * is precisely backwards for the screen whose subject is governance.
 *
 * ## The export is a document, not a page
 *
 * It takes the applied filter whole and is refused above ten thousand rows with
 * the count, because a compliance reader who asked for a quarter and silently
 * received its first ten thousand events has a file that looks complete and is
 * not. That refusal is a `VALIDATION_FAILED` naming the number, so it is shown
 * as it arrives rather than translated.
 *
 * The export is itself audited (`audit.exported`, Doc 10 §7) — which means the
 * act of reading the trail is in the trail, and the filter bar says so.
 */

import type { AuditRecordDTO, Paginated } from '@plantops/contracts';
import { AUDIT_EXPORT_FILENAME } from '@plantops/contracts';
import { DataTable, PageHeader, ScreenEmpty, StatusTag } from '@plantops/ui';
import { useAsync, useIam, useNotices } from '@plantops/web-kit';
import { Space, Tag, Typography } from 'antd';
import { useCallback, useMemo, useState, type ReactElement } from 'react';

import {
  NO_AUDIT_FILTERS,
  actionOptions,
  describeActor,
  hasAuditFilters,
  hasPayload,
  isPlatformLevel,
  toAuditQuery,
  type AuditFilters,
} from '../../lib/audit';
import { ScreenFailure } from '../screen-failure';
import { AuditFiltersBar } from './audit-filters';
import { PayloadDrawer } from './payload-drawer';

export type AuditTier = 'platform' | 'client';

const COPY: Readonly<Record<AuditTier, { title: string; description: string }>> = {
  platform: {
    title: 'Platform audit',
    description:
      'Every recorded action, across every tenant — including the platform-level ones that belong to no tenant at all. The trail is append-only: there is no endpoint that edits or deletes a row, by design.',
  },
  client: {
    title: 'Audit',
    description:
      'Every recorded action in your organisation: sign-ins, grants, locks and unlocks, role changes. You see your own tenant’s rows and nothing else — the database decides that, not this screen.',
  },
};

export interface AuditTableProps {
  tier: AuditTier;
}

export function AuditTable({ tier }: AuditTableProps): ReactElement {
  const iam = useIam();
  const notices = useNotices();

  const [filters, setFilters] = useState<AuditFilters>(NO_AUDIT_FILTERS);
  const [query, setQuery] = useState({ page: 1, limit: 25 });
  const [opened, setOpened] = useState<AuditRecordDTO | null>(null);
  const [exporting, setExporting] = useState(false);

  const records = useAsync<Paginated<AuditRecordDTO>>(
    () => iam.audit.list({ ...query, ...toAuditQuery(filters) }),
    [
      iam,
      query.page,
      query.limit,
      filters.actorId,
      filters.actorType,
      filters.action,
      filters.targetType,
      filters.targetId,
      filters.fromLocal,
      filters.toLocal,
    ],
  );

  const rows = useMemo(() => records.data?.data ?? [], [records.data]);
  const suggestions = useMemo(() => actionOptions(rows), [rows]);

  // A narrowed trail is a different trail, and page four of the old one is
  // meaningless in it.
  const apply = useCallback((next: AuditFilters): void => {
    setFilters(next);
    setQuery((current) => ({ ...current, page: 1 }));
  }, []);

  const exportCsv = useCallback(async (): Promise<void> => {
    setExporting(true);
    try {
      const csv = await iam.audit.export(toAuditQuery(filters));
      download(csv);
      notices.success('Export downloaded. The export is itself in the trail.');
    } catch (error) {
      // A filter matching more than the ceiling comes back as a
      // `VALIDATION_FAILED` naming the count — shown as it arrives, because the
      // number is the whole of the advice.
      notices.error(error, { title: 'That export was refused' });
    } finally {
      setExporting(false);
    }
  }, [iam, filters, notices]);

  const columns = [
    {
      title: 'When',
      dataIndex: 'created_at',
      width: 190,
      render: (value: string) => (
        <Typography.Text style={{ fontSize: 12 }}>
          {new Date(value).toLocaleString()}
        </Typography.Text>
      ),
    },
    {
      title: 'Action',
      dataIndex: 'action',
      width: 260,
      render: (action: string, row: AuditRecordDTO) => (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontFamily: 'var(--ant-font-family-code)' }}>
            {action}
          </Typography.Text>
          {tier === 'platform' && isPlatformLevel(row) && (
            <Tag color="purple" style={{ marginInlineEnd: 0, marginBlockStart: 2 }}>
              Platform-level
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Actor',
      key: 'actor',
      width: 220,
      render: (_: unknown, row: AuditRecordDTO) => {
        const actor = describeActor(row);
        return (
          <Space direction="vertical" size={0}>
            <StatusTag status={row.actor_type} tone="neutral" label={actor.label} />
            <Typography.Text
              type="secondary"
              ellipsis
              style={{
                fontFamily: 'var(--ant-font-family-code)',
                fontSize: 11,
                maxWidth: 200,
              }}
            >
              {actor.id ?? 'no subject'}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: 'Target',
      key: 'target',
      render: (_: unknown, row: AuditRecordDTO) =>
        row.target_type === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            <Typography.Text>{row.target_type}</Typography.Text>
            {row.target_id !== null && (
              <Typography.Text
                type="secondary"
                ellipsis
                style={{
                  fontFamily: 'var(--ant-font-family-code)',
                  fontSize: 11,
                  maxWidth: 240,
                }}
              >
                {row.target_id}
              </Typography.Text>
            )}
          </Space>
        ),
    },
    {
      title: '',
      key: 'payload',
      width: 90,
      render: (_: unknown, row: AuditRecordDTO) =>
        hasPayload(row) ? (
          <Typography.Link onClick={() => setOpened(row)}>Details</Typography.Link>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={COPY[tier].title}
        description={COPY[tier].description}
        footer={
          <AuditFiltersBar
            applied={filters}
            onApply={apply}
            actionSuggestions={suggestions}
            onExport={() => void exportCsv()}
            exporting={exporting}
          />
        }
      />

      <DataTable<AuditRecordDTO>
        result={records.data}
        loading={records.loading}
        columns={columns}
        rowKey={(row) => row.id}
        onQueryChange={setQuery}
        size="small"
        onRowClick={(row) => setOpened(row)}
        empty={
          <ScreenEmpty
            title={hasAuditFilters(filters) ? 'Nothing matches' : 'Nothing recorded yet'}
            description={
              hasAuditFilters(filters)
                ? 'No record matches every filter. Widen the date range, or clear a field.'
                : 'The trail fills itself: every sign-in, grant and change writes a record in the same transaction as the change.'
            }
          />
        }
        error={
          records.error === null || records.loading ? undefined : (
            <ScreenFailure error={records.error} onRetry={records.reload} />
          )
        }
      />

      <PayloadDrawer record={opened} onClose={() => setOpened(null)} />
    </>
  );
}

/**
 * Hands the CSV to the browser as a file.
 *
 * The client returns the text rather than a download because it runs in Node
 * too, where there is nothing to download to — so turning it into a file is the
 * console's job, and it is these seven lines.
 */
function download(csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = AUDIT_EXPORT_FILENAME;
  anchor.click();
  URL.revokeObjectURL(url);
}
