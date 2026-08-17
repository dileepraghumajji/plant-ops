/**
 * The three things every `tools/` script that talks to a running IAM needs:
 * an error it can print, a call it can make, and a token to make it with.
 *
 * Extracted from `upload-manifest.ts` when `seed-iam-manifest.ts` arrived
 * needing the identical three. Two copies of "how this tool authenticates and
 * how it renders a 400" would drift in the one place it matters — the validation
 * `details`, which name the path in the document the author has to fix, and
 * which are the whole value of a failed manifest upload.
 *
 * Like the tools it serves, this speaks **HTTP and never SQL**. A script with
 * its own database connection would bypass the validation, the permission gate
 * and the audit record the endpoint applies, so the row it wrote would be one no
 * API could have produced, in a catalog whose trail has a gap where the change
 * was.
 */

import type {
  ApplicationDTO,
  IamErrorResponse,
  Paginated,
} from '@plantops/contracts';

/**
 * The bootstrap service account of migration 0011.
 *
 * Written out rather than imported from `@plantops/db`: that package is the
 * TypeORM entity graph and the migration chain, and pulling all of it into an
 * HTTP client to read one string would give these tools a database dependency
 * they do not have. The value is a seeded account key — changing it would break
 * every existing deployment's credentials, so it is as frozen as the migration
 * that writes it.
 */
export const PLATFORM_SERVICE_ACCOUNT_KEY = 'platform-bootstrap';

/** Where a tool is pointed, and who it acts as. */
export interface ApiTarget {
  apiUrl: string;
  accountKey: string;
  accountSecret: string;
}

/** An API call that came back with the error envelope of Doc 06 §2. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: IamErrorResponse | string,
  ) {
    super(ApiError.describe(status, body));
    this.name = 'ApiError';
  }

  private static describe(status: number, body: IamErrorResponse | string): string {
    if (typeof body === 'string') return `HTTP ${status}: ${body}`;

    const { code, message, requestId, details } = body.error;
    const lines = [`HTTP ${status} ${code}: ${message}`, `request id: ${requestId}`];
    for (const detail of details ?? []) {
      lines.push(`  ${detail.field}: ${detail.message}`);
    }
    return lines.join('\n');
  }
}

export const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * The account secret from the environment, never from an argument.
 *
 * A secret in `argv` is a secret in the shell history and in every process
 * listing on the box.
 */
export function accountSecretFromEnv(): string {
  const secret =
    process.env['IAM_ACCOUNT_SECRET'] ?? process.env['PLATFORM_BOOTSTRAP_SECRET'];
  if (secret === undefined || secret.trim() === '') {
    throw new Error(
      'No account secret. Export PLATFORM_BOOTSTRAP_SECRET (or ' +
        'IAM_ACCOUNT_SECRET) for the environment you are talking to.',
    );
  }
  return secret;
}

/** `$IAM_API_URL`, or `http://localhost:$PORT`, or port 3000. */
export function defaultApiUrl(): string {
  return (
    process.env['IAM_API_URL'] ??
    `http://localhost:${process.env['PORT'] ?? '3000'}`
  );
}

export async function call<T>(
  target: ApiTarget,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${target.apiUrl}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, text.slice(0, 500));
    }
    throw new ApiError(response.status, parsed as IamErrorResponse);
  }

  return JSON.parse(text) as T;
}

export async function authenticate(target: ApiTarget): Promise<string> {
  const { access_token } = await call<{ access_token: string }>(
    target,
    null,
    'POST',
    '/auth/token',
    { account_key: target.accountKey, account_secret: target.accountSecret },
  );
  return access_token;
}

/**
 * The application with `key`, or `null`.
 *
 * Paged rather than filtered, because Doc 06 §4's list takes no `key` query
 * parameter and inventing one for a tool would be the wrong way round — the
 * catalog is small enough that walking it is cheap, and the API stays the one
 * the console uses.
 */
export async function findApplication(
  target: ApiTarget,
  token: string,
  key: string,
): Promise<ApplicationDTO | null> {
  const limit = 100;
  for (let page = 1; ; page += 1) {
    const result = await call<Paginated<ApplicationDTO>>(
      target,
      token,
      'GET',
      `/iam/applications?page=${page}&limit=${limit}`,
    );

    const found = result.data.find((application) => application.key === key);
    if (found !== undefined) return found;
    if (page * limit >= result.total || result.data.length === 0) return null;
  }
}
