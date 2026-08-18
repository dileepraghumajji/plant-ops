import { IamErrorCode } from '@plantops/contracts';
import { IamApiError, IamClientError } from '@plantops/iam-client';

import { formFieldIssues } from '../src/lib/form-errors';

const apiError = (
  code: IamErrorCode,
  init: { message?: string; details?: { field: string; message: string }[] } = {},
) =>
  new IamApiError({
    status: code === IamErrorCode.CONFLICT ? 409 : 400,
    code,
    message: init.message ?? 'refused',
    requestId: 'req-1',
    details: init.details,
  });

describe('formFieldIssues', () => {
  it('puts each validation detail on its field', () => {
    const error = apiError(IamErrorCode.VALIDATION_FAILED, {
      details: [
        { field: 'key', message: 'key is required' },
        { field: 'name', message: 'name is required' },
      ],
    });

    expect(formFieldIssues(error, { fields: ['key', 'name'] })).toEqual([
      { name: ['key'], errors: ['key is required'] },
      { name: ['name'], errors: ['name is required'] },
    ]);
  });

  it('turns a dotted path into a numeric antd name path', () => {
    // `Form.List` indexes its children by number, so `['permissions', '0', …]`
    // would address nothing and the message would silently vanish.
    const error = apiError(IamErrorCode.VALIDATION_FAILED, {
      details: [{ field: 'permissions.0.key', message: 'bad key' }],
    });

    expect(formFieldIssues(error, { fields: ['permissions'] })).toEqual([
      { name: ['permissions', 0, 'key'], errors: ['bad key'] },
    ]);
  });

  it('accepts bracket notation for an index', () => {
    const error = apiError(IamErrorCode.VALIDATION_FAILED, {
      details: [{ field: 'permissions[2].name', message: 'bad name' }],
    });

    expect(formFieldIssues(error, { fields: ['permissions'] })).toEqual([
      { name: ['permissions', 2, 'name'], errors: ['bad name'] },
    ]);
  });

  describe('a single-item form posting into a bulk body', () => {
    /**
     * The regression this option exists for.
     *
     * The add-nav-node form edits one node but posts `{ nodes: [ … ] }`, because
     * that is the shape `POST /iam/applications/:id/nav` takes. The server
     * therefore complains about `nodes[0].route` while the form's field is
     * plain `route` — so before the prefix was stripped, every detail was
     * dropped, nothing was highlighted, and the operator got a
     * "check the highlighted fields" toast over an unmarked form.
     */
    it('strips the bulk prefix so the detail reaches the flat field', () => {
      const error = apiError(IamErrorCode.VALIDATION_FAILED, {
        details: [
          {
            field: 'nodes[0].route',
            message: 'route must be a relative path beginning with "/"',
          },
        ],
      });

      expect(
        formFieldIssues(error, {
          fields: ['kind', 'key', 'label', 'route'],
          stripPrefix: ['nodes', 0],
        }),
      ).toEqual([
        {
          name: ['route'],
          errors: ['route must be a relative path beginning with "/"'],
        },
      ]);
    });

    it('leaves a path that does not start with the prefix alone', () => {
      const error = apiError(IamErrorCode.VALIDATION_FAILED, {
        details: [{ field: 'route', message: 'bad route' }],
      });

      expect(
        formFieldIssues(error, { fields: ['route'], stripPrefix: ['nodes', 0] }),
      ).toEqual([{ name: ['route'], errors: ['bad route'] }]);
    });

    it('does not strip a complaint about the array itself', () => {
      // `nodes: at least one node is required` has no per-field home. Stripping
      // it would leave an empty path, which the caller would then try to attach
      // to a field it does not have.
      const error = apiError(IamErrorCode.VALIDATION_FAILED, {
        details: [{ field: 'nodes', message: 'at least one node is required' }],
      });

      expect(
        formFieldIssues(error, { fields: ['route'], stripPrefix: ['nodes', 0] }),
      ).toEqual([]);
    });
  });

  it('drops a detail about a field the form does not have', () => {
    // antd swallows a `setFields` for an unknown path, so an unfiltered detail
    // would leave the operator with no message at all rather than a misplaced
    // one — which is the failure mode worth preventing.
    const error = apiError(IamErrorCode.VALIDATION_FAILED, {
      details: [{ field: 'config.nested', message: 'nope' }],
    });

    expect(formFieldIssues(error, { fields: ['key', 'name'] })).toEqual([]);
  });

  it('pins a conflict to the field that owns the natural key', () => {
    const error = apiError(IamErrorCode.CONFLICT, {
      message: 'An application with key "gatepass" already exists.',
    });

    expect(formFieldIssues(error, { fields: ['key'], conflictField: 'key' })).toEqual([
      {
        name: ['key'],
        errors: ['An application with key "gatepass" already exists.'],
      },
    ]);
  });

  it('leaves a conflict to the caller when no field owns it', () => {
    // A bulk body's 409 names the duplicate but not which row, so pinning it
    // would be a guess — the caller shows it at form level instead.
    const error = apiError(IamErrorCode.CONFLICT, { message: 'duplicate' });
    expect(formFieldIssues(error, { fields: ['permissions'] })).toEqual([]);
  });

  it('claims nothing for a denial', () => {
    const error = new IamApiError({
      status: 403,
      code: IamErrorCode.PERMISSION_DENIED,
      message: 'You may not do that.',
    });
    expect(formFieldIssues(error, { fields: ['key'], conflictField: 'key' })).toEqual(
      [],
    );
  });

  it('claims nothing for a transport failure', () => {
    expect(
      formFieldIssues(new IamClientError('network down'), { fields: ['key'] }),
    ).toEqual([]);
  });

  it('claims nothing for a value that is not an error at all', () => {
    expect(formFieldIssues('boom', { fields: ['key'] })).toEqual([]);
  });
});
