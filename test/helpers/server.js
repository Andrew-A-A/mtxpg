/* eslint-disable no-console */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PORT = Number(process.env.TEST_PORT || 4044); // off the dev port to avoid conflicts
const BASE_URL = `http://localhost:${PORT}`;
const PID_FILE = path.join(__dirname, '..', '.server.pid');

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
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
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
  try { fs.unlinkSync(PID_FILE); } catch {}
}

module.exports = { startServer, stopServer, BASE_URL, PORT };
