import { config } from './config.js';

describe('config', () => {
  it('should work', () => {
    expect(config()).toEqual('config');
  });
});
