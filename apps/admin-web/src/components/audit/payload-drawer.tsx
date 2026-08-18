'use client';

/**
 * One audit record, opened (Doc 09 §2.3, §3.6, Doc 10 §2, §8).
 *
 * The table answers who, what and when; the payload answers *what exactly*, and
 * its shape varies by action — a manifest upsert carries a diff, a role change
 * carries the added and removed keys, a denial carries the permission that was
 * attempted. There is no schema that covers all of them and there should not be:
 * the trail outlives the code that wrote each row (Doc 10 §1).
 *
 * So the drawer renders the payload as JSON rather than as fields. That is the
 * honest rendering of a value whose shape is not known, and it is copyable,
 * which is what somebody assembling an incident timeline actually needs.
 *
 * ## What is not in it
 *
 * Passwords, hashes, tokens and secrets — structurally, not by omission here.
 * `redact.ts` strips them at the writer (Doc 10 §8), so this drawer cannot leak
 * one however it renders. It says so, because an auditor looking at a
 * `service_account.rotated` record needs to know the absence of a secret is the
 * design rather than a gap in the record.
 */

import type { AuditRecordDTO } from '@plantops/contracts';
import { StatusTag, spacing } from '@plantops/ui';
import { Descriptions, Drawer, Space, Typography } from 'antd';
import type { ReactElement } from 'react';

import { describeActor, isPlatformLevel } from '../../lib/audit';

export interface PayloadDrawerProps {
  record: AuditRecordDTO | null;
  onClose: () => void;
}

export function PayloadDrawer({ record, onClose }: PayloadDrawerProps): ReactElement {
  const actor = record === null ? null : describeActor(record);
  const payload = record === null ? '' : JSON.stringify(record.payload ?? {}, null, 2);

  return (
    <Drawer
      open={record !== null}
      onClose={onClose}
      width={560}
      title={
        record === null ? null : (
          <Space direction="vertical" size={0}>
            <Typography.Text
              strong
              style={{ fontFamily: 'var(--ant-font-family-code)' }}
            >
              {record.action}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {new Date(record.created_at).toLocaleString()}
            </Typography.Text>
          </Space>
        )
      }
    >
      {record !== null && actor !== null && (
        <Space direction="vertical" size={spacing.md} style={{ width: '100%' }}>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Actor">
              <Space direction="vertical" size={0}>
                <span>{actor.label}</span>
                {actor.id === null ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    No subject — this ran before one existed, or none matched.
                  </Typography.Text>
                ) : (
                  <Typography.Text
                    copyable={{ text: actor.id }}
                    type="secondary"
                    style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
                  >
                    {actor.id}
                  </Typography.Text>
                )}
              </Space>
            </Descriptions.Item>

            <Descriptions.Item label="Target">
              {record.target_type === null ? (
                <Typography.Text type="secondary">
                  No row — this event reports counts or a decision rather than a
                  change to one record.
                </Typography.Text>
              ) : (
                <Space direction="vertical" size={0}>
                  <span>{record.target_type}</span>
                  {record.target_id !== null && (
                    <Typography.Text
                      copyable={{ text: record.target_id }}
                      type="secondary"
                      style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
                    >
                      {record.target_id}
                    </Typography.Text>
                  )}
                </Space>
              )}
            </Descriptions.Item>

            <Descriptions.Item label="Tenant">
              {isPlatformLevel(record) ? (
                <StatusTag status="platform" tone="neutral" label="Platform-level" />
              ) : (
                <Typography.Text
                  copyable={{ text: record.client_id as string }}
                  style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
                >
                  {record.client_id}
                </Typography.Text>
              )}
            </Descriptions.Item>

            <Descriptions.Item label="Record">
              <Typography.Text
                copyable={{ text: record.id }}
                style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
              >
                {record.id}
              </Typography.Text>
            </Descriptions.Item>
          </Descriptions>

          <div>
            <Space
              size="small"
              align="baseline"
              style={{ width: '100%', justifyContent: 'space-between' }}
            >
              <Typography.Text strong>Payload</Typography.Text>
              <Typography.Text copyable={{ text: payload }} />
            </Space>
            <pre
              style={{
                marginBlock: spacing.xs,
                padding: spacing.sm,
                borderRadius: 6,
                background: 'var(--ant-color-fill-quaternary)',
                fontFamily: 'var(--ant-font-family-code)',
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 420,
                overflow: 'auto',
              }}
            >
              {payload}
            </pre>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Passwords, hashes, tokens and secrets are stripped where the record
              is written, not where it is shown — so their absence here is the
              design rather than a gap in the record.
            </Typography.Text>
          </div>
        </Space>
      )}
    </Drawer>
  );
}
