import type {
  AuditEntry,
  MeResponse,
  PlatformTenant,
  TeamMember,
  TenantProfile,
} from '@app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  arrangeDb,
  call,
  createPlatformAdmin,
  createTestTenant,
  signIn,
  startApi,
  type RunningApi,
  type TestTenant,
} from '../test/harness.js';

// Tenant isolation through the HTTP API, with real sessions, the real guard
// and real row-level security. Brief §4: tenant A cannot read or change
// tenant B's data through the API.

let api: RunningApi;
let a: TestTenant;
let b: TestTenant;
let ownerA: string;
let agentA: string;
let ownerB: string;
let admin: string;

beforeAll(async () => {
  const db = arrangeDb();
  try {
    a = await createTestTenant(db, 'a');
    b = await createTestTenant(db, 'b');
    const adminEmail = await createPlatformAdmin(db);
    api = await startApi();
    [ownerA, agentA, ownerB, admin] = await Promise.all([
      signIn(api, a.ownerEmail),
      signIn(api, a.agentEmail),
      signIn(api, b.ownerEmail),
      signIn(api, adminEmail),
    ]);
  } finally {
    await db.close();
  }
});

afterAll(async () => {
  await api.close();
});

describe('reading', () => {
  it('GET /api/me names the caller and their own tenant', async () => {
    const { status, json } = await call(api, '/api/me', { cookie: agentA });
    expect(status).toBe(200);
    const me = json as MeResponse;
    expect(me.membership).toEqual({ tenantId: a.id, tenantName: 'Tenant A', role: 'agent' });
  });

  it("GET /api/team lists only the caller's tenant", async () => {
    const team = (await call(api, '/api/team', { cookie: ownerA })).json as TeamMember[];
    expect(team.map((m) => m.email).sort()).toEqual([a.agentEmail, a.ownerEmail].sort());

    const teamB = (await call(api, '/api/team', { cookie: ownerB })).json as TeamMember[];
    expect(teamB.map((m) => m.email)).not.toContain(a.ownerEmail);
  });

  it("GET /api/tenant returns the caller's tenant, never another", async () => {
    const profile = (await call(api, '/api/tenant', { cookie: ownerB })).json as TenantProfile;
    expect(profile.id).toBe(b.id);
  });
});

describe('changing', () => {
  it("an owner's update changes only their own tenant and is audited", async () => {
    const { status, json } = await call(api, '/api/tenant', {
      method: 'PATCH',
      cookie: ownerA,
      body: { name: 'Tenant A renamed' },
    });
    expect(status).toBe(200);
    expect((json as TenantProfile).id).toBe(a.id);

    const profileB = (await call(api, '/api/tenant', { cookie: ownerB })).json as TenantProfile;
    expect(profileB.name).toBe('Tenant B');

    const auditA = (await call(api, '/api/audit-log', { cookie: ownerA })).json as AuditEntry[];
    expect(auditA[0]).toMatchObject({
      action: 'tenant.profile.updated',
      targetId: a.id,
      before: { name: 'Tenant A' },
      after: { name: 'Tenant A renamed' },
    });
    expect(auditA[0]?.requestId).toEqual(expect.any(String));

    const auditB = (await call(api, '/api/audit-log', { cookie: ownerB })).json as AuditEntry[];
    expect(auditB.some((entry) => entry.targetId === a.id)).toBe(false);
  });

  it("a body naming tenant B's id is rejected, and B is unchanged", async () => {
    const { status, json } = await call(api, '/api/tenant', {
      method: 'PATCH',
      cookie: ownerA,
      body: { id: b.id, name: 'Hijacked' },
    });
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain('Unrecognized key');

    const profileB = (await call(api, '/api/tenant', { cookie: ownerB })).json as TenantProfile;
    expect(profileB.name).toBe('Tenant B');
  });

  it('an agent cannot change the tenant profile', async () => {
    const { status } = await call(api, '/api/tenant', {
      method: 'PATCH',
      cookie: agentA,
      body: { name: 'Agent rename' },
    });
    expect(status).toBe(403);
  });

  it('invalid input is rejected with a list of issues', async () => {
    const { status, json } = await call(api, '/api/tenant', {
      method: 'PATCH',
      cookie: ownerA,
      body: { timezone: 'Mars/Olympus' },
    });
    expect(status).toBe(400);
    expect((json as { issues: string[] }).issues[0]).toContain('IANA time zone');
  });
});

describe('access control', () => {
  it('rejects requests without a session', async () => {
    expect((await call(api, '/api/team')).status).toBe(401);
    expect((await call(api, '/api/me')).status).toBe(401);
  });

  it('rejects a forged session cookie', async () => {
    const forged = 'desk.session_token=forged.value';
    expect((await call(api, '/api/team', { cookie: forged })).status).toBe(401);
  });

  it('only owners can read the audit log', async () => {
    expect((await call(api, '/api/audit-log', { cookie: agentA })).status).toBe(403);
  });

  it('only platform admins can list tenants, and they see every tenant', async () => {
    expect((await call(api, '/api/admin/tenants', { cookie: ownerA })).status).toBe(403);
    const { status, json } = await call(api, '/api/admin/tenants', { cookie: admin });
    expect(status).toBe(200);
    const ids = (json as PlatformTenant[]).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('a platform admin without a membership cannot read tenant data', async () => {
    expect((await call(api, '/api/team', { cookie: admin })).status).toBe(403);
  });
});

describe('CSRF', () => {
  it('blocks a state-changing request with no Origin header', async () => {
    const { status } = await call(api, '/api/tenant', {
      method: 'PATCH',
      cookie: ownerA,
      origin: null,
      body: { name: 'No origin' },
    });
    expect(status).toBe(403);
  });

  it('blocks a state-changing request from another origin', async () => {
    const { status } = await call(api, '/api/tenant', {
      method: 'PATCH',
      cookie: ownerA,
      origin: 'https://evil.example',
      body: { name: 'Cross-site' },
    });
    expect(status).toBe(403);
  });
});
