import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import axios from 'axios';
import {
  AxisApi,
  CoinigoApi,
  configuredVendorClient,
  createAxisAuthHeaders,
  createCoinigoPayloadDigest,
  encryptCoinigoPayload,
} from '@roco/vendor-client';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for this check`);
  return value;
};

const authorized = (request: IncomingMessage): boolean => {
  const expected = Buffer.from(required('GUARDIAN_CONTROL_TOKEN'));
  const header = request.headers.authorization ?? '';
  const supplied = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};

const json = (response: ServerResponse, status: number, body: object): void => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};

const safeError = (error: unknown): { ok: false; status?: number; errorClass: string } => {
  if (axios.isAxiosError(error)) {
    return { ok: false, ...(error.response?.status ? { status: error.response.status } : {}), errorClass: error.code ?? error.name };
  }
  return { ok: false, errorClass: error instanceof Error ? error.name : 'UnknownError' };
};

const checkAxisClient = async (): Promise<object> => {
  const client = configuredVendorClient('axis', createAxisAuthHeaders(required('AXIS_API_KEY')));
  const result = await new AxisApi(client).getClient(required('AXIS_TEST_CLIENT_ID'));
  return { ok: true, status: result.status };
};

const checkCoinigoWallets = async (): Promise<object> => {
  const digestSecret = required('COINIGO_DIGEST_SECRET');
  const authClient = configuredVendorClient('coinigo');
  const auth = await new CoinigoApi(authClient).signIn(
    required('COINIGO_CLIENT_ID'),
    required('COINIGO_CLIENT_SECRET'),
    digestSecret,
  );
  const token = auth.data.data.accessToken;
  const currencyCode = process.env.COINIGO_TEST_CURRENCY ?? 'USDT';
  const plaintext = JSON.stringify({ currencyCode });
  const encrypted = encryptCoinigoPayload(required('COINIGO_PUBLIC_KEY_PEM').replaceAll('\\n', '\n'), plaintext);
  const client = configuredVendorClient('coinigo', { Authorization: `Bearer ${token}` });
  const result = await new CoinigoApi(client).getWallets(
    encrypted,
    createCoinigoPayloadDigest(digestSecret, plaintext),
    currencyCode,
  );
  return { ok: true, status: result.status };
};

const routes: Record<string, () => Promise<object>> = {
  '/checks/axis/client': checkAxisClient,
  '/checks/coinigo/wallets': checkCoinigoWallets,
};

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    json(response, 200, { ok: true, mode: 'phase-0-standalone' });
    return;
  }
  const handler = request.url ? routes[request.url] : undefined;
  if (request.method !== 'POST' || !handler) {
    json(response, 404, { ok: false, error: 'not_found' });
    return;
  }
  try {
    if (!authorized(request)) {
      json(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    json(response, 200, await handler());
  } catch (error) {
    json(response, 502, safeError(error));
  }
});

const host = process.env.GUARDIAN_HOST ?? '127.0.0.1';
const port = Number(process.env.GUARDIAN_PORT ?? '3001');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('GUARDIAN_PORT must be a valid TCP port');
server.listen(port, host, () => {
  console.log(`Vendor Guardian Phase 0 standalone runner listening on http://${host}:${port}`);
});

const shutdown = (signal: string): void => {
  console.log(`Received ${signal}; shutting down`);
  server.close((error) => {
    if (error) {
      console.error('Standalone runner shutdown failed');
      process.exitCode = 1;
    }
  });
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
