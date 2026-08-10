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
    {
      // Audit suite: asserts the behaviour mtxpg must have before publishing.
      // Gets its own server so a failure here cannot poison the other projects.
      displayName: 'hardening',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/hardening/**/*.test.js'],
      globalSetup: '<rootDir>/test/global-setup.js',
      globalTeardown: '<rootDir>/test/global-teardown.js',
    },
    {
      // Kills the server process — never run alongside the others.
      displayName: 'destructive',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/destructive/**/*.test.js'],
      globalSetup: '<rootDir>/test/global-setup.js',
      globalTeardown: '<rootDir>/test/global-teardown.js',
    },
  ],
};
