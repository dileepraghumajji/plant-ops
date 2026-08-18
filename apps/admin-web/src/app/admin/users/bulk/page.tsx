'use client';

/**
 * Bulk user upload (Doc 09 §3.3, Doc 06 §8).
 *
 * A roster in, a per-row verdict out. The endpoint is deliberately
 * partial-success — valid rows commit even when others do not — so the response
 * *is* the deliverable of this screen, not a confirmation of it: an operator who
 * only learns "200 OK" has no idea which forty of their four hundred people
 * landed.
 *
 * ## The file is read here and sent as text
 *
 * Both formats travel inside the JSON envelope (Doc 06 §8): a CSV as a string
 * field, a JSON list as itself. That keeps one body parser, one ceiling and one
 * error shape on a surface that would otherwise grow a second of each — and it
 * costs this screen nothing, because a browser has already read the file into
 * memory to show it.
 *
 * The CSV is passed through **untouched**. Column matching is by header name,
 * case- and whitespace-insensitively, and reimplementing that here would put the
 * rule in two places with the console's copy being the one that was wrong.
 *
 * ## Re-uploading is the normal case, not an accident
 *
 * A row describing somebody who already exists comes back `skipped`, and that is
 * what makes "add three people to the roster and upload it again" a safe thing
 * to do. The screen says so, because an operator who reads "397 skipped" as "397
 * failures" will go looking for a problem that is not there.
 */

import type { BulkUserUploadResponse } from '@plantops/contracts';
import { MAX_BULK_USER_ROWS } from '@plantops/contracts';
import { PageHeader, spacing } from '@plantops/ui';
import { useIam, useNotices } from '@plantops/web-kit';
import { DownloadOutlined, InboxOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Input, Segmented, Space, Tag, Typography, Upload } from 'antd';
import { useRouter } from 'next/navigation';
import { useCallback, useState, type ReactElement } from 'react';

import { BulkReportTable } from '../../../../components/users/bulk-report-table';
import {
  CSV_TEMPLATE,
  buildBulkRequest,
  detectFormat,
  type BulkFormat,
} from '../../../../lib/bulk-upload';
import { CLIENT_PERMISSIONS as P } from '../../../../lib/iam-permissions';
import { usePermission } from '../../../../lib/use-permission';

/** A 500-row roster is tens of kilobytes; a megabyte is the wrong file. */
const MAX_DOCUMENT_BYTES = 1_000_000;

export default function BulkUploadPage(): ReactElement {
  const iam = useIam();
  const router = useRouter();
  const notices = useNotices();
  const canUpload = usePermission(P.USER_BULK_UPLOAD);

  const [text, setText] = useState('');
  const [format, setFormat] = useState<BulkFormat>('csv');
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [report, setReport] = useState<BulkUserUploadResponse | null>(null);

  /**
   * A new roster invalidates the report of the old one.
   *
   * The report is a verdict on a specific file, and leaving last upload's table
   * beneath this upload's text is the one way this screen could mislead badly.
   */
  const replaceDocument = useCallback((value: string, next?: BulkFormat): void => {
    setText(value);
    if (next !== undefined) setFormat(next);
    setProblem(null);
    setReport(null);
  }, []);

  const upload = useCallback(async (): Promise<void> => {
    const built = buildBulkRequest(format, text);
    if (!built.ok) {
      setProblem(built.problem);
      return;
    }

    setProblem(null);
    setUploading(true);
    try {
      const result = await iam.users.bulk(built.request);
      setReport(result);
      notices.success(
        `${result.created} created, ${result.skipped} skipped, ${result.errored} errored.`,
      );
    } catch (error) {
      setReport(null);
      notices.error(error);
    } finally {
      setUploading(false);
    }
  }, [format, text, iam, notices]);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ title: 'Users', href: '/admin/users' }, { title: 'Bulk upload' }]}
        title="Bulk upload"
        description="A roster in, a verdict per row out. Valid rows are created even when others cannot be read, so this is safe to run on a file you are still fixing."
        actions={
          <Button onClick={() => router.push('/admin/users')}>Back to users</Button>
        }
      />

      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card
          size="small"
          title="The roster"
          extra={
            <Space>
              <Button
                size="small"
                icon={<DownloadOutlined />}
                onClick={() => downloadTemplate()}
              >
                CSV template
              </Button>
              <Button
                type="primary"
                loading={uploading}
                disabled={text.trim() === '' || !canUpload}
                onClick={() => void upload()}
              >
                Upload
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {!canUpload && (
              <Alert
                type="info"
                showIcon
                message={`You do not hold ${P.USER_BULK_UPLOAD}`}
                description="You can prepare a file here, but the upload will be refused."
              />
            )}

            <Upload.Dragger
              accept=".csv,.json,text/csv,application/json"
              multiple={false}
              showUploadList={false}
              beforeUpload={(file) => {
                if (file.size > MAX_DOCUMENT_BYTES) {
                  setProblem(
                    `${file.name} is ${Math.round(file.size / 1024)} KB. An upload is ` +
                      `at most ${MAX_BULK_USER_ROWS} people, which is a far smaller file — ` +
                      'this is very likely the wrong one.',
                  );
                  return Upload.LIST_IGNORE;
                }
                void file
                  .text()
                  .then((content) =>
                    replaceDocument(content, detectFormat(file.name, content)),
                  )
                  .catch(() => setProblem(`${file.name} could not be read.`));
                return Upload.LIST_IGNORE;
              }}
              style={{ paddingBlock: spacing.sm }}
            >
              <p className="ant-upload-drag-icon" style={{ marginBottom: spacing.xs }}>
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">Drop a .csv or .json roster here, or click</p>
              <p className="ant-upload-hint">
                Columns are matched by header name — <code>email</code> and{' '}
                <code>full_name</code> are required, <code>phone</code> and{' '}
                <code>status</code> optional. At most {MAX_BULK_USER_ROWS} people
                per upload.
              </p>
            </Upload.Dragger>

            <Space size="middle" wrap>
              <Segmented<BulkFormat>
                value={format}
                onChange={(next) => {
                  setFormat(next);
                  setReport(null);
                }}
                options={[
                  { value: 'csv', label: 'CSV' },
                  { value: 'json', label: 'JSON' },
                ]}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Set from the file you dropped. Change it if it guessed wrong.
              </Typography.Text>
              {text.trim() !== '' && (
                <Tag color="default" style={{ marginInlineEnd: 0 }}>
                  {Math.round(text.length / 1024)} KB
                </Tag>
              )}
            </Space>

            <Input.TextArea
              value={text}
              onChange={(event) => replaceDocument(event.target.value)}
              autoSize={{ minRows: 8, maxRows: 20 }}
              spellCheck={false}
              placeholder={CSV_TEMPLATE}
              style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
            />

            {problem !== null && (
              <Alert type="error" showIcon message="That file cannot be sent" description={problem} />
            )}
          </Space>
        </Card>

        {report !== null && (
          <BulkReportTable
            report={report}
            onOpenUser={(userId) => router.push(`/admin/users/${userId}`)}
          />
        )}
      </Space>
    </>
  );
}

function downloadTemplate(): void {
  const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'users-template.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}
