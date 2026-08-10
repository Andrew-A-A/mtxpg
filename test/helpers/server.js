/* eslint-disable no-console */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PORT = Number(process.env.TEST_PORT || 4044); // off the dev port to avoid conflicts
const BASE_URL = `http://localhost:${PORT}`;
const PID_FILE = path.join(__dirname, '..', '.server.pid');

// TenantService is annotated `@requires: 'mtxpg-admin'`, so the suite needs a
// caller holding that role. Injected into the spawned server's mocked-auth users
// via a CDS_* env override rather than committed to the host project's config.
const ADMIN = { user: 'mtxpg_test_admin', password: 'mtxpg_test_admin' };
const ADMIN_ROLE = 'mtxpg-admin';
const AUTH = {
  Authorization: `Basic ${Buffer.from(`${ADMIN.user}:${ADMIN.password}`).toString('base64')}`,
};

function waitForHealth(timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${BASE_URL}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error(`server not healthy after ${timeoutMs}ms`));
        setTimeout(tick, 500);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error(`server not reachable after ${timeoutMs}ms`));
        setTimeout(tick, 500);
      });
    };
    tick();
  });
}

async function startServer() {
  const child = spawn('npx', ['cds-serve', '--port', String(PORT)], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      // Merges with CAP's default mocked users rather than replacing them.
      CDS_REQUIRES_AUTH_USERS: JSON.stringify({
        [ADMIN.user]: { password: ADMIN.password, roles: [ADMIN_ROLE] },
      }),
    },
    stdio: process.env.TEST_SERVER_LOG ? 'inherit' : ['ignore', 'ignore', 'ignore'],
    shell: true,
    detached: process.platform !== 'win32', // detach on POSIX so SIGTERM kills the group
  });

  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  try {
    await waitForHealth();
  } catch (err) {
    stopServer();
    throw err;
  }
  return BASE_URL;
}

function stopServer() {
  let pid;
  try {
    pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return;
  }
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM'); // negative pid → process group
    }
  } catch {
    /* already gone */
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* no pid file to clean up */
  }
}

module.exports = { startServer, stopServer, BASE_URL, PORT, AUTH, ADMIN, ADMIN_ROLE };
