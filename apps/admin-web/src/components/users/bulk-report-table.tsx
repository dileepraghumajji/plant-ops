'use client';

/**
 * The per-row result report (Doc 09 §3.3, Doc 06 §8).
 *
 * ## Three outcomes, and only one of them is a defect
 *
 * `created` landed. `skipped` means the row was well-formed and describes
 * somebody who already exists — earlier in the same file, or already in the
 * tenant — which is not a problem: re-uploading a roster after adding three
 * people is the ordinary way this endpoint gets used, and every previously
 * loaded row skipping is what makes that safe. `errored` is the only status
 * whose rows an operator has to go and fix.
 *
 * The screen says so rather than colouring two failures the same, because an
 * operator who reads "37 skipped" as "37 failures" will go looking for a problem
 * that is not there.
 *
 * ## The report is the file, with a verdict column
 *
 * `results` covers every row in file order, including the created ones, so the
 * table is read beside the spreadsheet it came from. `row` counts **data** rows
 * from 1, which is the same number the operator's own file shows once its header
 * is discounted.
 *
 * The CSV export exists for the same reason: a hundred errored rows on a screen
 * is a hundred rows to retype, and the same rows in a file open beside the
 * original is a diff.
 */

import type { BulkUserRowResult, BulkUserUploadResponse } from '@plantops/contracts';
import { StatusTag, spacing } from '@plantops/ui';
import { DownloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Segmented, Space, Table, Tooltip, Typography } from 'antd';
import { useMemo, useState, type ReactElement } from 'react';

import { filterResults, resultsToCsv, type OutcomeFilter } from '../../lib/bulk-upload';

export interface BulkReportTableProps {
  report: BulkUserUploadResponse;
  /** Opens one created person's profile. */
  onOpenUser: (userId: string) => void;
}

export function BulkReportTable({
  report,
  onOpenUser,
}: BulkReportTableProps): ReactElement {
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');

  const rows = useMemo(
    () => filterResults(report.results, outcome),
    [report.results, outcome],
  );

  const columns = [
    {
      title: 'Row',
      dataIndex: 'row',
      width: 80,
      render: (row: number) => (
        <Typography.Text type="secondary" style={{ fontFamily: 'var(--ant-font-family-code)' }}>
          {row}
        </Typography.Text>
      ),
    },
    {
      title: 'Email',
      dataIndex: 'email',
      render: (email: string | null) =>
        email === null ? (
          <Tooltip title="The row could not be read far enough to find an address.">
            <Typography.Text type="secondary">—</Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text style={{ fontFamily: 'var(--ant-font-family-code)' }}>
            {email}
          </Typography.Text>
        ),
    },
    {
      title: 'Outcome',
      dataIndex: 'status',
      width: 130,
      render: (status: BulkUserRowResult['status']) => (
        <StatusTag
          status={status}
          tone={
            status === 'created' ? 'good' : status === 'skipped' ? 'neutral' : 'stopped'
          }
        />
      ),
    },
    {
      title: 'Reason',
      dataIndex: 'reason',
      render: (reason: string | undefined, row: BulkUserRowResult) =>
        row.status === 'created' ? (
          row.user_id === null ? null : (
            <Typography.Link onClick={() => onOpenUser(row.user_id as string)}>
              Open profile
            </Typography.Link>
          )
        ) : (
          <Typography.Text type="secondary">{reason}</Typography.Text>
        ),
    },
  ];

  return (
    <Card
      size="small"
      title={
        <Space size="small" wrap>
          <span>Result</span>
          <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
            {report.total} row{report.total === 1 ? '' : 's'} read
          </Typography.Text>
        </Space>
      }
      extra={
        <Button
          size="small"
          icon={<DownloadOutlined />}
          onClick={() => downloadCsv(resultsToCsv(report.results))}
        >
          Download report
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {report.errored > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`${report.errored} row${report.errored === 1 ? '' : 's'} could not be read`}
            description="Everything else was applied. Fix those rows in the original file and upload it again — the people already created will come back as skipped, which is what makes a re-upload safe."
          />
        )}

        {report.errored === 0 && report.skipped > 0 && report.created === 0 && (
          <Alert
            type="info"
            showIcon
            message="Everyone in this file was already here"
            description="Nothing was wrong with it. Every row describes somebody who already exists in your organisation."
          />
        )}

        <Segmented<OutcomeFilter>
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'all', label: `All ${report.total}` },
            { value: 'created', label: `Created ${report.created}` },
            { value: 'skipped', label: `Skipped ${report.skipped}` },
            { value: 'errored', label: `Errored ${report.errored}` },
          ]}
        />

        <Table<BulkUserRowResult>
          dataSource={rows}
          columns={columns}
          rowKey={(row) => row.row}
          size="small"
          pagination={rows.length > 50 ? { pageSize: 50, showSizeChanger: false } : false}
          scroll={{ y: 480 }}
          style={{ marginBlockStart: spacing.xs }}
        />
      </Space>
    </Card>
  );
}

/**
 * Hands the report to the browser as a file.
 *
 * A blob URL rather than a data URI: a five-hundred-row report is well past what
 * some browsers accept in an address bar, and the object URL is revoked as soon
 * as the click has been dispatched.
 */
function downloadCsv(csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'bulk-upload-report.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}
