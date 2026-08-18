module.exports = {
  displayName: '@plantops/web-kit',
  preset: '../../jest.preset.js',
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  transform: {
    '^(?!.*\\.(js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
    '^.+\\.[tj]sx?$': ['babel-jest', { presets: ['@nx/react/babel'] }],
  },
  // See the note in libs/ui/jest.config.cts — antd 6 ships ESM inside its
  // CommonJS build, so its packages have to be transformed rather than skipped.
  transformIgnorePatterns: [
    '/node_modules/(?!(?:@ant-design|antd|@rc-component|rc-[a-z-]+)/)',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: 'test-output/jest/coverage',
};
