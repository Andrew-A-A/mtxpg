/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 60000,
  verbose: true,
  testPathIgnorePatterns: ['/node_modules/', '/test/helpers/', '/test/fixture/'],
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/unit/**/*.test.js'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/integration/**/*.test.js'],
      globalSetup: '<rootDir>/test/global-setup.js',
      globalTeardown: '<rootDir>/test/global-teardown.js',
    },
  ],
};
