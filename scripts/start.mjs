import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const packageJson = require('../package.json');
const cwd = process.cwd();
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const useShell = process.platform === 'win32';

function versionParts(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function supportedNode(version) {
  const parts = versionParts(version);
  if (!parts) return false;
  const [major, minor, patch] = parts;
  return (major === 22 && (minor > 16 || (minor === 16 && patch >= 0))) || major >= 24;
}

function checkNodeVersion() {
  if (!supportedNode(process.versions.node)) {
    console.error(
      `Unsupported Node.js version ${process.versions.node}. ` +
      `This project requires ${packageJson.engines.node}.`
    );
    process.exit(1);
  }
}

function createDevVars() {
  const path = join(cwd, '.dev.vars');
  if (existsSync(path)) {
    console.log('Using existing .dev.vars');
    return;
  }

  const adminPassword = randomBytes(24).toString('base64url');
  const framerPassword = randomBytes(24).toString('base64url');
  try {
    writeFileSync(
      path,
      `ADMIN_INITIAL_PASSWORD=${adminPassword}\nFRAMER_INITIAL_PASSWORD=${framerPassword}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
  } catch (error) {
    if (error.code === 'EEXIST') {
      console.log('Using existing .dev.vars');
      return;
    }
    throw error;
  }
  console.log('Created .dev.vars for this local database:');
  console.log(`  admin@example.test: ${adminPassword}`);
  console.log(`  framer@example.test: ${framerPassword}`);
  console.log('These passwords only seed a fresh local database.');
}

function availablePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

async function findPort() {
  const requested = process.env.PORT === undefined ? 8787 : Number(process.env.PORT);
  if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  for (let port = requested; port <= 65535; port++) {
    if (await availablePort(port)) return port;
  }
  throw new Error(`No free port found from ${requested} to 65535.`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: useShell });
    let stopping = false;
    const stop = (signal) => {
      if (!stopping) {
        stopping = true;
        child.kill(signal);
      }
    };
    const onInterrupt = () => stop('SIGINT');
    const onTerminate = () => stop('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    child.once('error', (error) => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      const signalCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
      resolve(signal ? signalCode : (code ?? 1));
    });
  });
}

async function main() {
  checkNodeVersion();
  createDevVars();
  const buildCode = await run(npmCommand, ['exec', '--', 'vite', 'build']);
  if (buildCode !== 0) process.exitCode = buildCode;
  if (buildCode !== 0) return;

  const port = await findPort();
  console.log(`Local app: http://127.0.0.1:${port}`);
  process.exitCode = await run(
    npmCommand,
    ['exec', '--', 'wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port)]
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
