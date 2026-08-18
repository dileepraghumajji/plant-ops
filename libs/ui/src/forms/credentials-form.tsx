'use client';

/**
 * The sign-in form: client, email, password (Doc 09 §1, Doc 06 §3).
 *
 * Presentational on purpose — it takes values in and hands values out, and
 * knows nothing about `IamClient`, tokens or routing. That is what makes it
 * reusable by the gatepass and visitor consoles, which sign in against the same
 * IAM with the same three fields but land somewhere else afterwards.
 *
 * ## Why the client field comes first
 *
 * `POST /auth/login` takes `client_slug` because the same email address can
 * exist in several tenants (Doc 06 §8), so the tenant is not a detail — it is
 * the first thing that has to be right, and a person who types their address
 * before realising they are signing in to the wrong plant has to start over.
 * It is remembered between visits for the same reason: almost nobody signs in
 * to two tenants, and the one who does is the one who will notice the field.
 *
 * ## Errors
 *
 * The form renders whatever copy it is given, and the caller decides which. The
 * distinction that must survive is 401 vs 423: Doc 03 §8 makes a locked account
 * a different state with a different remedy, and telling someone their password
 * was wrong when the account is locked sends them to reset a password that will
 * not help.
 */

import { LockOutlined, MailOutlined, ShopOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Typography } from 'antd';
import * as React from 'react';

import type { ErrorCopy } from '../feedback/error-copy';
import { spacing } from '../theme/tokens';

export interface CredentialsFormValues {
  client_slug: string;
  email: string;
  password: string;
}

export interface CredentialsFormProps {
  onSubmit: (values: CredentialsFormValues) => void | Promise<void>;
  submitting?: boolean;
  /** Shown above the fields. `null` clears it. */
  error?: ErrorCopy | null;
  /** The server's own sentence, under the copy, when it adds something. */
  errorDetail?: string | null;
  /** Pre-fills the tenant — from the last successful sign-in, or a subdomain. */
  defaultClientSlug?: string;
  /** e.g. a "Forgot password?" link. Rendered under the submit button. */
  footer?: React.ReactNode;
  submitLabel?: string;
}

export function CredentialsForm({
  onSubmit,
  submitting = false,
  error,
  errorDetail,
  defaultClientSlug = '',
  footer,
  submitLabel = 'Sign in',
}: CredentialsFormProps): React.ReactElement {
  const [form] = Form.useForm<CredentialsFormValues>();

  return (
    <Form
      form={form}
      layout="vertical"
      requiredMark={false}
      initialValues={{ client_slug: defaultClientSlug, email: '', password: '' }}
      onFinish={onSubmit}
      disabled={submitting}
      size="large"
    >
      {error != null && (
        <Form.Item>
          <Alert
            type={error.tone === 'info' ? 'info' : error.tone}
            showIcon
            message={error.title}
            description={
              <>
                <div>{error.description}</div>
                {errorDetail != null && errorDetail !== '' && (
                  <Typography.Text type="secondary" italic style={{ fontSize: 12 }}>
                    {errorDetail}
                  </Typography.Text>
                )}
              </>
            }
          />
        </Form.Item>
      )}

      <Form.Item
        name="client_slug"
        label="Client"
        rules={[{ required: true, message: 'Which client are you signing in to?' }]}
        extra="The short name of your organisation in PlantOps."
      >
        <Input
          prefix={<ShopOutlined />}
          placeholder="acme-industries"
          autoComplete="organization"
          autoCapitalize="none"
          spellCheck={false}
        />
      </Form.Item>

      <Form.Item
        name="email"
        label="Email"
        rules={[
          { required: true, message: 'Enter your email address.' },
          { type: 'email', message: 'That does not look like an email address.' },
        ]}
      >
        <Input
          prefix={<MailOutlined />}
          placeholder="you@company.com"
          autoComplete="username"
          inputMode="email"
          spellCheck={false}
        />
      </Form.Item>

      <Form.Item
        name="password"
        label="Password"
        rules={[{ required: true, message: 'Enter your password.' }]}
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="••••••••"
          autoComplete="current-password"
        />
      </Form.Item>

      <Form.Item style={{ marginBlockEnd: footer === undefined ? 0 : spacing.sm }}>
        <Button type="primary" htmlType="submit" block loading={submitting}>
          {submitLabel}
        </Button>
      </Form.Item>

      {footer}
    </Form>
  );
}
