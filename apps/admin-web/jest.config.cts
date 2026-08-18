const nextJest = require('next/jest.js');

const createJestConfig = nextJest({
  dir: './',
});

const config = {
  displayName: '@plantops/admin-web',
  preset: '../../jest.preset.js',
  transform: {
    '^(?!.*\\.(js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: '../../coverage/apps/admin-web',
  testEnvironment: 'jsdom',
};

const jestConfig = createJestConfig(config);

module.exports = async () => {
  const resolved = await jestConfig();
  // Disable SWC path alias resolution — handled by Nx jest resolver.
  for (const value of Object.values(resolved.transform)) {
    if (Array.isArray(value) && value[1]?.resolvedBaseUrl) {
      value[1] = { ...value[1], resolvedBaseUrl: undefined };
    }
  }
  // antd 6 and its `@rc-component/*` parts ship ESM inside their CommonJS
  // builds, and the workspace libraries are consumed as TypeScript source
  // through a node_modules symlink. Both have to be transformed rather than
  // skipped — see the same note in libs/ui/jest.config.cts.
  resolved.transformIgnorePatterns = [
    '/node_modules/(?!(?:@ant-design|antd|@rc-component|rc-[a-z-]+|@plantops)/)',
    '^.+\\.module\\.(css|sass|scss)$',
  ];
  return resolved;
};
