const { startServer } = require('./helpers/server');

module.exports = async () => {
  const url = await startServer();
  // Stash for teardown — Jest globalSetup/globalTeardown share via the global.
  process.env.TEST_BASE_URL = url;
};
