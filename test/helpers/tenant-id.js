const PREFIX = 'jest_';

function newTenantId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${PREFIX}${ts}_${rnd}`;
}

module.exports = { PREFIX, newTenantId };
