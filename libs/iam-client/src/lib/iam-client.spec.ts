import { iamClient } from './iam-client.js';

describe('iamClient', () => {
  it('should work', () => {
    expect(iamClient()).toEqual('iam-client');
  });
});
