'use client';

/**
 * Manifest upload — paste or drop a document, see exactly what it would do,
 * then confirm it (Doc 09 §2.1, Doc 02 §2).
 *
 * ## This is the primary registration path, and the screen is shaped like it
 *
 * Doc 02 §2 registers an application by uploading the manifest it ships, and
 * Doc 09 §2.1 calls that "the primary path". Session 28's tabs are the other
 * one — imperative, one row at a time, for the change too small to regenerate a
 * document for. Everything an application's catalog can be is expressible here,
 * and only here can it be expressed *repeatably*: the same file, uploaded to
 * dev, staging and production, produces the same catalog (Doc 02 §7).
 *
 * ## The document names the application, not the URL
 *
 * The route carries no application id, which is why it is
 * `/platform/applications/manifest` rather than a fourth tab of one application.
 * A manifest declares its own `key`, the server refuses one addressed to any
 * other application (`manifest.service.ts`), and an operator arriving with a
 * file should not have to know which row it belongs to before they can look at
 * it. So the screen reads the key, finds the application, and says which one it
 * found — prominently, because "which catalog am I about to rewrite" is the one
 * question a wrong answer to would be expensive.
 *
 * When the key matches nothing, the upload has nowhere to go: the endpoint is
 * addressed by application id. Rather than a dead end, the screen offers to
 * register the row — which is Doc 02 §2 step 1, the only step the manifest
 * cannot perform on itself — and then previews as normal.
 *
 * ## Preview and confirm are the same computation, and the screen proves it
 *
 * The preview is `?dryRun=true` against the real endpoint: same validation, same
 * refusals, same `ManifestDiff`, nothing written. What it cannot promise on its
 * own is that the catalog held still in between — someone else's upload, or a
 * tab of Session 28's editor, could land between the two calls. So the confirm
 * compares the diff it applied with the diff it previewed and says so when they
 * differ, rather than letting the screen's promise quietly become false.
 *
 * ## Why there is no `usePermission` gate on the main action
 *
 * Every other platform screen hides the controls the subject cannot use. This
 * one has exactly one call, `iam.platform.app.manifest`, and hiding its button
 * would leave a deep link into a screen that does nothing and explains nothing.
 * Doc 09 §4 is explicit that client-side hiding is UX and the server is the
 * enforcement, so the preview is attempted and its 403 rendered where the diff
 * would have been. The one control that *is* gated is "Register application",
 * because it needs a different permission and appears only in a corner case.
 */

import type {
  ApplicationDTO,
  ApplicationManifest,
  ManifestDiff,
  ManifestUpsertResponse,
} from '@plantops/contracts';
import { IamErrorCode } from '@plantops/contracts';
import { PageHeader, spacing, StatusTag } from '@plantops/ui';
import { describeError, useIam, useNotices } from '@plantops/web-kit';
import { InboxOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Input,
  Result,
  Space,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import { useRouter } from 'next/navigation';
import { useCallback, useState, type ReactElement } from 'react';

import { ManifestDiffView } from '../../../../components/applications/manifest-diff';
import { PLATFORM_PERMISSIONS as P } from '../../../../lib/iam-permissions';
import {
  diffsMatch,
  hasDeactivations,
  indexManifest,
  parseManifestDocument,
  type ManifestIndex,
} from '../../../../lib/manifest-upload';
import { findInPages } from '../../../../lib/paging';
import { usePermission } from '../../../../lib/use-permission';

/**
 * A manifest is at most 200 permissions and 200 nav nodes (`manifest.dto.ts`),
 * which is tens of kilobytes. A megabyte is the wrong file, and finding that out
 * from a browser that froze pasting it into a textarea is a worse way to learn
 * it than being told.
 */
const MAX_DOCUMENT_BYTES = 1_000_000;

interface Preview {
  application: ApplicationDTO;
  /** The exact document previewed — the one the confirm will send. */
  manifest: ApplicationManifest;
  index: ManifestIndex;
  changed: boolean;
  diff: ManifestDiff;
}

interface Applied {
  response: ManifestUpsertResponse;
  /** False when the catalog moved between the preview and the confirm. */
  asPreviewed: boolean;
}

export default function ManifestUploadPage(): ReactElement {
  const iam = useIam();
  const router = useRouter();
  const notices = useNotices();

  const canRegister = usePermission(P.APP_CREATE);

  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  /** The manifest's key, when no application is registered under it. */
  const [unregistered, setUnregistered] = useState<string | null>(null);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);

  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [registering, setRegistering] = useState(false);

  /**
   * Any edit to the document invalidates everything derived from it.
   *
   * The single most damaging thing this screen could do is apply a manifest that
   * is not the one whose diff is on screen. Clearing here — rather than
   * comparing at confirm time — makes that unreachable: there is never a preview
   * belonging to text that is no longer in the box.
   */
  const replaceDocument = useCallback((value: string): void => {
    setText(value);
    setProblem(null);
    setFailure(null);
    setUnregistered(null);
    setPreview(null);
    setApplied(null);
  }, []);

  const previewFor = useCallback(
    async (manifest: ApplicationManifest, application: ApplicationDTO) => {
      const response = await iam.applications.previewManifest(
        application.id,
        manifest,
      );
      setPreview({
        application,
        manifest,
        index: indexManifest(manifest),
        changed: response.changed,
        diff: response.diff,
      });
    },
    [iam],
  );

  const runPreview = useCallback(async (): Promise<void> => {
    const parsed = parseManifestDocument(text);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      setPreview(null);
      return;
    }

    setProblem(null);
    setFailure(null);
    setUnregistered(null);
    setApplied(null);
    setPreviewing(true);

    try {
      // Doc 06 §4 has no lookup by key and no `GET /iam/applications/:id`, so
      // the list is walked — a bounded read over a catalog of tens of rows, for
      // the reasons `lib/paging.ts` sets out.
      const application = await findInPages<ApplicationDTO>(
        (query) => iam.applications.list(query),
        (row) => row.key === parsed.manifest.key,
      );

      if (application === null) {
        setUnregistered(parsed.manifest.key);
        setPreview(null);
        return;
      }

      await previewFor(parsed.manifest, application);
    } catch (error) {
      setPreview(null);
      setFailure(error);
    } finally {
      setPreviewing(false);
    }
  }, [iam, previewFor, text]);

  const registerAndPreview = useCallback(async (): Promise<void> => {
    const parsed = parseManifestDocument(text);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }

    setRegistering(true);
    try {
      const { key, name, description } = parsed.manifest;
      const application = await iam.applications.create({
        key,
        // `name` is required by the create endpoint and optional in the loose
        // parse this screen performs, so the key stands in rather than sending
        // an empty string the server would refuse with a field error about a
        // field the operator never filled in.
        name: typeof name === 'string' && name.trim() !== '' ? name : key,
        ...(typeof description === 'string' && description.trim() !== ''
          ? { description }
          : {}),
      });
      setUnregistered(null);
      notices.success(`${application.name} is registered. Nothing is uploaded yet.`);
      await previewFor(parsed.manifest, application);
    } catch (error) {
      setFailure(error);
    } finally {
      setRegistering(false);
    }
  }, [iam, notices, previewFor, text]);

  const apply = useCallback(async (): Promise<void> => {
    if (preview === null) return;

    if (hasDeactivations(preview.diff)) {
      const confirmed = await notices.confirm({
        title: `Apply this manifest to ${preview.application.name}?`,
        content:
          'Keys this manifest no longer declares will be deactivated. Nothing ' +
          'is deleted — the rows, their role mappings and their menu gates are ' +
          'kept — but the permissions stop resolving and the menus disappear ' +
          'for every tenant until a later upload declares them again.',
        okText: 'Apply manifest',
        danger: true,
      });
      if (!confirmed) return;
    }

    setApplying(true);
    setFailure(null);
    try {
      const response = await iam.applications.upsertManifest(
        preview.application.id,
        preview.manifest,
      );
      setApplied({
        response,
        asPreviewed: diffsMatch(preview.diff, response.diff),
      });
      notices.success(
        response.changed
          ? `${preview.application.name}'s catalog is updated.`
          : `${preview.application.name} already matched this manifest.`,
      );
    } catch (error) {
      setFailure(error);
    } finally {
      setApplying(false);
    }
  }, [iam, notices, preview]);

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { title: 'Applications', href: '/platform/applications' },
          { title: 'Upload manifest' },
        ]}
        title="Upload manifest"
        description="An application's permissions and menus, declared in one JSON document. Uploading it is how a catalog is registered and how it evolves — no deploy, no restart. You will see exactly what changes before anything is written."
        actions={
          <Button onClick={() => router.push('/platform/applications')}>
            Back to applications
          </Button>
        }
      />

      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card
          size="small"
          title="The document"
          extra={
            <Space>
              {preview !== null && (
                <Button onClick={() => replaceDocument('')}>Clear</Button>
              )}
              <Button
                type="primary"
                loading={previewing}
                disabled={text.trim() === '' || applying}
                onClick={() => void runPreview()}
              >
                {preview === null ? 'Preview changes' : 'Preview again'}
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Upload.Dragger
              accept=".json,application/json"
              multiple={false}
              showUploadList={false}
              beforeUpload={(file) => {
                if (file.size > MAX_DOCUMENT_BYTES) {
                  setProblem(
                    `${file.name} is ${Math.round(file.size / 1024)} KB. A manifest ` +
                      'declares at most 200 permissions and 200 nav nodes, so this ' +
                      'is very likely the wrong file.',
                  );
                  return Upload.LIST_IGNORE;
                }
                void file
                  .text()
                  .then(replaceDocument)
                  .catch(() => setProblem(`${file.name} could not be read.`));
                return Upload.LIST_IGNORE;
              }}
              style={{ paddingBlock: spacing.sm }}
            >
              <p className="ant-upload-drag-icon" style={{ marginBottom: spacing.xs }}>
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">Drop a manifest .json here, or click</p>
              <p className="ant-upload-hint">
                Or paste it below. The file is read in your browser and sent only
                when you preview.
              </p>
            </Upload.Dragger>

            <Input.TextArea
              value={text}
              onChange={(event) => replaceDocument(event.target.value)}
              autoSize={{ minRows: 8, maxRows: 24 }}
              spellCheck={false}
              placeholder={'{\n  "key": "gatepass",\n  "name": "Gate Pass",\n  "permissions": [],\n  "nav": []\n}'}
              style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
            />

            {problem !== null && (
              <Alert type="error" showIcon message="Unreadable manifest" description={problem} />
            )}
          </Space>
        </Card>

        {unregistered !== null && (
          <Alert
            type="warning"
            showIcon
            message={`No application is registered with the key “${unregistered}”`}
            description={
              <Space direction="vertical" size={spacing.xs}>
                <span>
                  A manifest is uploaded to an application that already exists —
                  that is Doc 02 §2 step 1, and it is the one step the document
                  cannot perform on itself. Registering creates the row and
                  nothing else; you will still see the diff before anything is
                  uploaded.
                </span>
                {canRegister ? (
                  <Button
                    type="primary"
                    loading={registering}
                    onClick={() => void registerAndPreview()}
                  >
                    Register “{unregistered}” and preview
                  </Button>
                ) : (
                  <Typography.Text type="secondary">
                    You do not hold iam.platform.app.create, so someone else has
                    to register it first.
                  </Typography.Text>
                )}
              </Space>
            }
          />
        )}

        {failure !== null && <UploadFailure error={failure} />}

        {preview !== null && (
          <Card
            size="small"
            title={
              <Space size="small" wrap>
                <span>{applied === null ? 'Preview' : 'Applied'}</span>
                <Typography.Text
                  type="secondary"
                  style={{ fontFamily: 'var(--ant-font-family-code)', fontWeight: 400 }}
                >
                  {preview.application.key}
                </Typography.Text>
                <StatusTag
                  status={preview.application.is_active ? 'active' : 'inactive'}
                />
              </Space>
            }
            extra={
              applied === null && (
                <Tooltip
                  title={
                    preview.changed
                      ? undefined
                      : 'There is nothing to apply — the catalog already matches.'
                  }
                >
                  <Button
                    type="primary"
                    loading={applying}
                    disabled={!preview.changed || previewing}
                    onClick={() => void apply()}
                  >
                    Apply this manifest
                  </Button>
                </Tooltip>
              )
            }
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                {applied === null ? 'Would be applied to ' : 'Applied to '}
                <Typography.Text strong>{preview.application.name}</Typography.Text>
                {applied === null && '. Nothing has been written yet.'}
              </Typography.Text>

              {applied !== null && !applied.asPreviewed && (
                <Alert
                  type="warning"
                  showIcon
                  message="The catalog moved between the preview and the upload"
                  description="Someone changed this application's catalog in between, so what was applied is not exactly what was previewed. What actually happened is shown below; the audit record holds the same diff."
                />
              )}

              <ManifestDiffView
                diff={applied?.response.diff ?? preview.diff}
                index={preview.index}
                changed={applied?.response.changed ?? preview.changed}
              />
            </Space>
          </Card>
        )}

        {applied !== null && (
          <Result
            status="success"
            title={
              applied.response.changed
                ? `${preview?.application.name ?? 'The application'} is up to date`
                : 'Nothing to do'
            }
            subTitle={
              applied.response.changed
                ? 'The change is live: every tenant with this application enabled sees the new menus and permissions on their next navigation call. The upload is recorded in the audit trail with this diff.'
                : 'The manifest described exactly what was already there, so no rows and no audit record were written.'
            }
            extra={[
              <Button
                key="open"
                type="primary"
                onClick={() =>
                  router.push(
                    `/platform/applications/${applied.response.application_id}`,
                  )
                }
              >
                Open the application
              </Button>,
              <Button key="another" onClick={() => replaceDocument('')}>
                Upload another
              </Button>,
            ]}
          />
        )}
      </Space>
    </>
  );
}

/**
 * A refused preview or upload, shown above the composer rather than instead of
 * it.
 *
 * The document is still on screen and still the thing to fix, so a full-screen
 * `<ScreenError>` — right for a load that produced no content — would be the
 * wrong shape here. A `VALIDATION_FAILED` is listed field by field, because
 * `manifest.dto.ts` addresses its complaints to real paths inside the document
 * (`nav[0].children[1].route`) and that path is how an operator finds the line
 * to change.
 */
function UploadFailure({ error }: { error: unknown }): ReactElement {
  const described = describeError(error);
  const isValidation = described.code === IamErrorCode.VALIDATION_FAILED;

  return (
    <Alert
      type="error"
      showIcon
      message={isValidation ? 'This manifest was rejected' : described.copy.title}
      description={
        <Space direction="vertical" size={spacing.xs} style={{ width: '100%' }}>
          <span>
            {isValidation
              ? 'Nothing was written. Fix these and preview again.'
              : described.copy.description}
          </span>

          {described.details.length > 0 && (
            <ul style={{ margin: 0, paddingInlineStart: spacing.md }}>
              {described.details.map((detail) => (
                <li key={`${detail.field}:${detail.message}`}>
                  <Typography.Text style={{ fontFamily: 'var(--ant-font-family-code)' }}>
                    {detail.field}
                  </Typography.Text>{' '}
                  — {detail.message}
                </li>
              ))}
            </ul>
          )}

          {described.details.length === 0 && described.detail !== null && (
            <Typography.Text type="secondary" italic>
              {described.detail}
            </Typography.Text>
          )}

          {described.requestId !== null && (
            <Typography.Text
              type="secondary"
              copyable={{ text: described.requestId }}
              style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
            >
              {described.requestId}
            </Typography.Text>
          )}
        </Space>
      }
    />
  );
}
