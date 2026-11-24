/**
 * Roles per route. The reader role may call every GET route the scheduler may and nothing
 * else; admin, scheduler and runner keep exactly the routes they had. The matrix test boots
 * the real app (database mocked) and calls every registered route with each role's key: a
 * role that may call a route gets anything but 403 (the mocked database answers 404, 400 or
 * 500), a role that may not gets 403 from the gate before any handler runs.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.hoisted(() => {
  process.env.API_TOKEN = 'admin-token';
  process.env.DATABASE_URL = 'postgresql://unused';
});

const { handlerCalls } = vi.hoisted(() => ({ handlerCalls: { count: 0 } }));

vi.mock('../../src/db/connection', () => {
  const query = async () => {
    handlerCalls.count += 1;
    return { rows: [], rowCount: 0 };
  };
  return {
    getPool: () => ({ query, connect: async () => ({ query, release: () => undefined }) }),
    getSchema: () => 'test',
    closePool: async () => undefined,
  };
});

vi.mock('../../src/services/apiKeyService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/apiKeyService')>();
  const keys: Record<string, string> = { 'scheduler-token': 'scheduler', 'runner-token': 'runner', 'reader-token': 'reader' };
  return {
    ...actual,
    authenticateKey: async (token: string) =>
      keys[token] ? { id: 1, name: keys[token], role: keys[token], created_at: new Date(), revoked_at: null, last_used_at: null } : null,
    touchApiKey: () => undefined,
  };
});

import app from '../../src/app';
import { requireRole, requireRoleByMethod } from '../../src/middleware/auth';
import { ROLES } from '../../src/services/apiKeyService';
import type { Role } from '../../src/types';

type Route = { method: string; path: string };

/** Every route registered on the app, in registration order. */
const routes = (): Route[] =>
  ((app as any)._router.stack as any[])
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => ({ method: method.toUpperCase(), path: layer.route.path as string })),
    );

/** A concrete URL for a route path. */
const urlFor = (path: string): string =>
  path
    .replace(':ids([0-9,]+,[0-9,]+)', '1,2')
    .replace(':id([0-9]+)', '1')
    .replace(/:[a-z_]+/g, '1');

const may = (role: Role | 'none', { method, path }: Route): boolean => {
  if (path === '/health') return true;
  if (role === 'admin') return true;
  if (path.startsWith('/runner/')) return role === 'runner';
  if (path.startsWith('/keys')) return false;
  if (path === '/jobs/:id([0-9]+)' && method === 'GET') return role !== 'none';
  if (role === 'scheduler') return true;
  if (role === 'reader') return method === 'GET';
  return false;
};

const tokens: Record<Role, string> = {
  admin: 'admin-token',
  scheduler: 'scheduler-token',
  runner: 'runner-token',
  reader: 'reader-token',
};

let server: Server;
let base: string;

beforeAll(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const call = async (role: Role, route: Route): Promise<number> => {
  const response = await fetch(base + urlFor(route.path), {
    method: route.method,
    headers: { authorization: `Bearer ${tokens[role]}`, 'content-type': 'application/json' },
    // The executor upsert has its own rule (a scheduler may upsert only runner "api"), so ask for that.
    body: route.method === 'GET' || route.method === 'HEAD' ? undefined : route.path.startsWith('/step-executors') ? '{"runner":"api"}' : '{}',
  });
  await response.arrayBuffer();
  return response.status;
};

describe('roles', () => {
  it('include reader for key creation', () => {
    expect(ROLES).toEqual(['admin', 'scheduler', 'runner', 'reader']);
  });

  it('cover the reads Ara needs and the new retention route', () => {
    const paths = routes().map((r) => `${r.method} ${r.path}`);
    for (const route of ['GET /jobs', 'GET /jobs/counts', 'GET /steps/counts', 'GET /steps/attempts', 'GET /steps/usage', 'DELETE /jobs/finished']) {
      expect(paths).toContain(route);
    }
  });

  for (const role of ['admin', 'scheduler', 'runner', 'reader'] as Role[]) {
    it(`${role}: may call exactly its routes`, async () => {
      for (const route of routes()) {
        const status = await call(role, route);
        const allowed = may(role, route);
        expect({ route: `${route.method} ${route.path}`, forbidden: status === 403 }).toEqual({
          route: `${route.method} ${route.path}`,
          forbidden: !allowed,
        });
      }
    });
  }

  it('reader: a write is refused before its handler touches the database', async () => {
    for (const route of routes().filter((r) => r.method !== 'GET' && r.path !== '/health')) {
      handlerCalls.count = 0;
      expect(await call('reader', route)).toBe(403);
      expect(handlerCalls.count).toBe(0);
    }
  });

  it('reader: HEAD on a read route passes, as Express answers it with the GET route', async () => {
    expect(await call('reader', { method: 'HEAD', path: '/jobs/counts' })).not.toBe(403);
  });

  it('an unknown key gets 401 and no key gets 401', async () => {
    const bad = await fetch(`${base}/jobs`, { headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    const none = await fetch(`${base}/jobs`);
    expect(none.status).toBe(401);
  });
});

describe('requireRoleByMethod', () => {
  const run = (gate: ReturnType<typeof requireRole>, method: string, role?: Role) => {
    const next = vi.fn();
    const status = vi.fn().mockReturnValue({ json: vi.fn() });
    gate({ method, auth: role ? { role, keyId: 1, keyName: 'k' } : undefined } as any, { status } as any, next);
    return next.mock.calls.length === 1 ? 'next' : status.mock.calls[0][0];
  };
  const gate = requireRoleByMethod(['scheduler', 'reader'], ['scheduler']);

  it('lets reads through for read roles and writes only for write roles', () => {
    expect(run(gate, 'GET', 'reader')).toBe('next');
    expect(run(gate, 'HEAD', 'reader')).toBe('next');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(run(gate, method, 'reader')).toBe(403);
      expect(run(gate, method, 'scheduler')).toBe('next');
      expect(run(gate, method, 'admin')).toBe('next');
    }
    expect(run(gate, 'GET', 'runner')).toBe(403);
    expect(run(gate, 'GET')).toBe(403);
  });
});
