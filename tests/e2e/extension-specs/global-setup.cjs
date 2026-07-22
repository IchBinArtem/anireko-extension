const { startFixtureServer, stopFixtureServer } = require('./fixture-server.cjs');

module.exports = async function setupExtensionFixture() {
  await startFixtureServer();
  return async () => stopFixtureServer();
};
