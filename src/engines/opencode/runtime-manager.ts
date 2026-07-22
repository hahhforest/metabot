import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { OpenCodeBotConfig } from '../../config.js';
import type { Logger } from '../../utils/logger.js';

export const SUPPORTED_OPENCODE_VERSION = '1.17.14';
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_USERNAME = 'opencode';

export type OpenCodeRuntimeOwnership = 'managed' | 'external';

export interface OpenCodeRuntime {
  readonly url: string;
  readonly version: string;
  readonly ownership: OpenCodeRuntimeOwnership;
  client(directory: string): OpencodeClient;
  close(): Promise<void>;
}

type ManagedChild = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'stderr' | 'once' | 'kill'>;

interface RuntimeManagerDependencies {
  spawnServer?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ManagedChild;
  createClient?: typeof createOpencodeClient;
  findFreePort?: () => Promise<number>;
  probe?: (client: OpencodeClient) => Promise<{ healthy: true; version: string }>;
  startupTimeoutMs?: number;
}

interface RuntimeAuth {
  username: string;
  password?: string;
}

export class OpenCodeRuntimeManager {
  private startPromise?: Promise<OpenCodeRuntime>;
  private runtime?: OpenCodeRuntime;

  constructor(
    private readonly config: OpenCodeBotConfig,
    private readonly logger: Logger,
    private readonly dependencies: RuntimeManagerDependencies = {},
  ) {}

  start(): Promise<OpenCodeRuntime> {
    if (this.runtime) return Promise.resolve(this.runtime);
    if (!this.startPromise) {
      this.startPromise = this.startRuntime()
        .then((runtime) => {
          this.runtime = runtime;
          return runtime;
        })
        .finally(() => {
          this.startPromise = undefined;
        });
    }
    return this.startPromise;
  }

  async close(): Promise<void> {
    const runtime = this.runtime ?? (this.startPromise ? await this.startPromise.catch(() => undefined) : undefined);
    this.runtime = undefined;
    if (runtime) await runtime.close();
  }

  private async startRuntime(): Promise<OpenCodeRuntime> {
    if (this.config.serverUrl) return this.connectExternal(this.config.serverUrl);
    return this.startManaged();
  }

  private async connectExternal(serverUrl: string): Promise<OpenCodeRuntime> {
    const url = normalizeServerUrl(serverUrl);
    const auth = configuredAuth(this.config);
    const clientFactory = this.dependencies.createClient ?? createOpencodeClient;
    const clientFor = (directory: string) => createClient(clientFactory, url, auth, directory);
    const health = await this.probeWithTimeout(clientFor(process.cwd()), url);
    assertSupportedVersion(health.version);
    this.logger.info({ url, version: health.version, ownership: 'external' }, 'Connected to OpenCode server');
    return {
      url,
      version: health.version,
      ownership: 'external',
      client: clientFor,
      close: async () => undefined,
    };
  }

  private async startManaged(): Promise<OpenCodeRuntime> {
    const executable = resolveOpenCodePath(this.config.executable);
    const port = this.config.port ?? await (this.dependencies.findFreePort ?? findFreePort)();
    validatePort(port);
    const url = `http://127.0.0.1:${port}`;
    const auth: RuntimeAuth = {
      username: this.config.serverUsername || DEFAULT_USERNAME,
      password: this.config.serverPassword || randomBytes(24).toString('base64url'),
    };
    const args = [
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
      ...(this.config.pure ? ['--pure'] : []),
      ...(this.config.extraArgs ?? []),
    ];
    const spawnServer = this.dependencies.spawnServer ?? ((command, commandArgs, options) =>
      spawn(command, commandArgs, options));
    const child = spawnServer(executable, args, {
      env: {
        ...process.env,
        ...(this.config.env ?? {}),
        OPENCODE_SERVER_USERNAME: auth.username,
        OPENCODE_SERVER_PASSWORD: auth.password,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr: string[] = [];
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      if (stderr.join('').length < 8_192) stderr.push(String(chunk));
    });

    const clientFactory = this.dependencies.createClient ?? createOpencodeClient;
    const clientFor = (directory: string) => createClient(clientFactory, url, auth, directory);
    try {
      const health = await this.probeWithTimeout(clientFor(process.cwd()), url, child);
      assertSupportedVersion(health.version);
      this.logger.info({ url, version: health.version, ownership: 'managed' }, 'Started OpenCode server');
      return {
        url,
        version: health.version,
        ownership: 'managed',
        client: clientFor,
        close: () => stopChild(child),
      };
    } catch (error) {
      await stopChild(child);
      const detail = stderr.join('').trim();
      if (detail) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}: ${detail.slice(-2_000)}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async probeWithTimeout(
    client: OpencodeClient,
    url: string,
    child?: ManagedChild,
  ): Promise<{ healthy: true; version: string }> {
    const timeoutMs = this.dependencies.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`OpenCode server exited before becoming healthy (${child.exitCode ?? child.signalCode})`);
      }
      try {
        return await (this.dependencies.probe ?? probeHealth)(client);
      } catch (error) {
        lastError = error;
        await delay(100);
      }
    }
    throw new Error(`OpenCode server at ${url} did not become healthy within ${timeoutMs}ms${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`);
  }
}

function createClient(
  factory: typeof createOpencodeClient,
  url: string,
  auth: RuntimeAuth,
  directory: string,
): OpencodeClient {
  const authorization = auth.password
    ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
    : undefined;
  return factory({
    baseUrl: url,
    directory,
    ...(authorization ? { headers: { Authorization: authorization } } : {}),
  });
}

async function probeHealth(client: OpencodeClient): Promise<{ healthy: true; version: string }> {
  const result = await client.global.health({ throwOnError: true });
  return result.data;
}

function assertSupportedVersion(version: string): void {
  if (version !== SUPPORTED_OPENCODE_VERSION) {
    throw new Error(
      `Unsupported OpenCode server version ${version}; MetaBot requires ${SUPPORTED_OPENCODE_VERSION}`,
    );
  }
}

function configuredAuth(config: OpenCodeBotConfig): RuntimeAuth {
  return {
    username: config.serverUsername || DEFAULT_USERNAME,
    password: config.serverPassword,
  };
}

export function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`OpenCode server URL must use http or https: ${value}`);
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

export function resolveOpenCodePath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.OPENCODE_EXECUTABLE_PATH) return process.env.OPENCODE_EXECUTABLE_PATH;
  try {
    const command = process.platform === 'win32' ? 'where' : 'which';
    return execFileSync(command, ['opencode'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  } catch {
    return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  }
}

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate an OpenCode loopback port'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid OpenCode server port: ${port}`);
  }
}

async function stopChild(child: ManagedChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const graceful = await Promise.race([exited.then(() => true), delay(2_000).then(() => false)]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(1_000)]);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
