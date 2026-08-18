'use client';

/**
 * The one moment a service-account secret exists outside the caller's hands
 * (Doc 09 §2.4, §3.5, Doc 03 §5, Doc 06 §10).
 *
 * `POST /iam/service-accounts` and `…/rotate` are the only two routes that ever
 * return an `account_secret`, and there is deliberately no `GET /:id` that could
 * later "just add" it back: only the hash is stored, so the value in this modal
 * cannot be re-read by anyone, including the server. If it is lost, the account
 * is not — rotate issues a new one and invalidates this.
 *
 * ## The modal is shaped by that, not decorated with it
 *
 * The warning is above the value rather than below it, because a person who has
 * already copied and closed has not read anything below. Closing takes a
 * deliberate confirmation rather than a mask click or Escape: an accidental
 * dismissal costs a rotation and a redeployment of whatever was going to use the
 * credential, which is a bad thing to be one stray keystroke away from.
 *
 * Both halves of the credential are shown. The exchange takes `account_key` and
 * `account_secret` together (Doc 03 §5), and a modal that offered only the
 * secret would send the operator back to the table for the other half — with the
 * value they cannot re-read still on screen behind them.
 */

import type { ServiceAccountSecretDTO } from '@plantops/contracts';
import { spacing } from '@plantops/ui';
import { WarningOutlined } from '@ant-design/icons';
import { Alert, Descriptions, Modal, Space, Typography } from 'antd';
import { useState, type ReactElement } from 'react';

export interface SecretRevealModalProps {
  /** The create or rotate response. Rendered once and then gone. */
  account: ServiceAccountSecretDTO;
  /** Whether this secret replaced an older one. */
  rotated: boolean;
  onClose: () => void;
}

export function SecretRevealModal({
  account,
  rotated,
  onClose,
}: SecretRevealModalProps): ReactElement {
  /** Guards the close button until the operator has said they have it. */
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <Modal
      open
      title={
        <Space size="small">
          <WarningOutlined style={{ color: 'var(--ant-color-warning)' }} />
          <span>{rotated ? 'New secret for ' : 'Secret for '}{account.name}</span>
        </Space>
      }
      okText={acknowledged ? 'Close' : 'I have copied it'}
      onOk={() => (acknowledged ? onClose() : setAcknowledged(true))}
      // No mask click, no Escape, no cross: dismissing this by accident costs a
      // rotation and a redeployment of whatever was about to use it.
      maskClosable={false}
      keyboard={false}
      closable={false}
      cancelButtonProps={{ style: { display: 'none' } }}
      width={620}
    >
      <Space direction="vertical" size={spacing.md} style={{ width: '100%' }}>
        <Alert
          type="warning"
          showIcon
          message="You will not see this again"
          description={
            rotated
              ? 'The previous secret stopped working the moment this one was issued. Only a hash of this value is stored, so nobody — including this console — can show it to you a second time. Rotating again is the only way to get a new one.'
              : 'Only a hash of this value is stored, so nobody — including this console — can show it to you a second time. If it is lost, rotate the account: that issues a new secret and invalidates this one.'
          }
        />

        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="Account key">
            <Typography.Text
              copyable={{ text: account.account_key }}
              style={{ fontFamily: 'var(--ant-font-family-code)' }}
            >
              {account.account_key}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="Account secret">
            <Typography.Text
              copyable={{ text: account.account_secret }}
              style={{ fontFamily: 'var(--ant-font-family-code)', wordBreak: 'break-all' }}
            >
              {account.account_secret}
            </Typography.Text>
          </Descriptions.Item>
        </Descriptions>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          The two are exchanged together at <code>POST /auth/token</code> for a
          short-lived access token. Put them where the integration reads its
          configuration from — not in a chat message, and not in a ticket.
        </Typography.Text>

        {acknowledged && (
          <Alert
            type="info"
            showIcon
            message="Closing this dismisses the secret for good."
          />
        )}
      </Space>
    </Modal>
  );
}
