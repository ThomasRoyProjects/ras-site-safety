import { SafetyApp } from '../server/index.js';
import { verifyPassword } from '../server/passwords.js';
import { createHash } from 'node:crypto';
import { env, exports as workerExports } from 'cloudflare:workers';
import {
  evictDurableObject,
  reset,
  runInDurableObject
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CHECKLIST = [
  'hard_hat',
  'high_visibility_vest',
  'safety_boots',
  'eye_protection',
  'fall_protection',
  'ladders_scaffolds_inspected',
  'tools_cords_checked',
  'hazards_identified'
];
const PNG = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
), (character) => character.charCodeAt(0));
const BASE = 'https://ras-test.invalid';
const PASSWORDS = {
  admin: 'Test-Admin-Password-2026',
  framer: 'Test-Framer-Password-2026'
};

function appStub() {
  return env.SAFETY_APP.getByName('ras-site-safety');
}

function request(path, options = {}) {
  const headers = new Headers(options.headers);
  return workerExports.default.fetch(new Request(`${BASE}${path}`, { ...options, headers }));
}

async function expectText(response, status) {
  const body = await response.text();
  expect({ status: response.status, body }).toMatchObject({ status });
  return body;
}

async function expectJson(response, status) {
  return JSON.parse(await expectText(response, status));
}

function tokenFromCookie(cookie) {
  return cookie.split(';', 1)[0].split('=', 2)[1];
}

function tokenHash(cookie) {
  return createHash('sha256').update(tokenFromCookie(cookie)).digest('hex');
}

async function login(role) {
  const response = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({
      email: role === 'admin' ? 'admin@example.test' : 'framer@example.test',
      password: PASSWORDS[role]
    })
  });
  const cookie = response.headers.get('set-cookie');
  await expectText(response, 200);
  return cookie;
}
async function loginWithCredentials(email, password) {
  const response = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email, password })
  });
  const cookie = response.headers.get('set-cookie');
  return { response, cookie };
}

function form(options = {}, bytes = null) {
  const data = new FormData();
  data.set('site_id', options.siteId ?? '1');
  data.set('work_date', options.workDate ?? '2099-01-02');
  data.set('notes', options.notes ?? 'Checked by the isolated Workers test.');
  for (const field of CHECKLIST) data.set(field, options[field] ?? '1');
  if (bytes !== null) data.append('photos', new File([bytes], 'photo.png', { type: options.mimeType ?? 'image/png' }));
  return data;
}

function failingImages() {
  return {
    async info(stream) {
      await new Response(stream).arrayBuffer();
      return {
        format: 'image/png',
        fileSize: PNG.byteLength,
        width: 1,
        height: 1
      };
    },
    input(source) {
      return {
        transform() {
          return {
            async output() {
              await new Response(source).arrayBuffer();
              throw new Error('controlled Images service failure');
            }
          };
        }
      };
    }
  };
}

async function withFailingImages(callback) {
  return runInDurableObject(appStub(), async (instance) => {
    // Only the controlled Images outage replaces this instance binding.
    // Ordinary decode and rejection coverage uses the offline Images service.
    const images = instance.env.IMAGES;
    instance.env.IMAGES = failingImages();
    try {
      return await callback(instance);
    } finally {
      instance.env.IMAGES = images;
    }
  });
}
async function withEnv(values, callback) {
  return runInDurableObject(appStub(), async (instance) => {
    const previous = new Map();
    for (const [key, value] of Object.entries(values)) {
      previous.set(key, {
        existed: Object.hasOwn(instance.env, key),
        value: instance.env[key]
      });
      instance.env[key] = String(value);
    }
    try {
      return await callback(instance);
    } finally {
      for (const [key, original] of previous) {
        if (original.existed) {
          instance.env[key] = original.value;
        } else {
          delete instance.env[key];
        }
      }
    }
  });
}

async function sql(callback) {
  return runInDurableObject(appStub(), (_instance, state) => callback(state.storage.sql));
}

async function counts() {
  return sql((storage) => ({
    submissions: Number([...storage.exec('SELECT COUNT(*) AS count FROM submissions')][0].count),
    photos: Number([...storage.exec('SELECT COUNT(*) AS count FROM photos')][0].count),
    chunks: Number([...storage.exec('SELECT COUNT(*) AS count FROM photo_chunks')][0].count),
    staging: Number([...storage.exec('SELECT COUNT(*) AS count FROM upload_staging_chunks')][0].count)
  }));
}

const BOOTSTRAP_TABLES = [
  'photo_thumbnails',
  'photo_chunks',
  'photos',
  'upload_staging_chunks',
  'sessions',
  'submissions',
  'sites',
  'users'
];

function clearBootstrapData(storage) {
  for (const table of BOOTSTRAP_TABLES) {
    storage.sql.exec(`DELETE FROM ${table}`);
  }
  storage.sql.exec(
    "DELETE FROM app_metadata WHERE key='bootstrap_complete'"
  );
}

function bootstrapCounts(storage) {
  return {
    users: Number([...storage.sql.exec(
      'SELECT COUNT(*) AS count FROM users'
    )][0].count),
    marker: Number([...storage.sql.exec(
      "SELECT COUNT(*) AS count FROM app_metadata WHERE key='bootstrap_complete'"
    )][0].count)
  };
}

function startSafetyApp(storage, initialEnv) {
  let startup;
  let transactionCalls = 0;
  const testStorage = {
    sql: storage.sql,
    transactionSync(callback) {
      transactionCalls++;
      return storage.transactionSync(callback);
    }
  };
  const state = {
    storage: testStorage,
    blockConcurrencyWhile(callback) {
      startup = callback();
      return startup;
    }
  };
  const app = new SafetyApp(state, initialEnv);
  return {
    app,
    startup,
    transactionCalls: () => transactionCalls
  };
}

function unreadableInitialPasswords() {
  const rejectRead = () => {
    throw new Error('Initial password secret was read');
  };
  return {
    get ADMIN_INITIAL_PASSWORD() {
      return rejectRead();
    },
    get FRAMER_INITIAL_PASSWORD() {
      return rejectRead();
    }
  };
}

beforeEach(async () => {
  // The default export and fixture helpers deliberately target the same stable
  // production object. Reset it so every test starts from a fresh SQL database.
  await reset();
  const initialized = await request('/api/health');
  await expectText(initialized, 200);
});

afterEach(async () => {
  await reset();
});

describe('SafetyApp on real workerd and SQLite Durable Object storage', () => {
  it('requires both valid initial passwords and recovers after failed bootstrap', async () => {
    await runInDurableObject(appStub(), async (instance) => {
      const storage = instance.state.storage;
      clearBootstrapData(storage);
      const invalidEnvironments = [
        { ADMIN_INITIAL_PASSWORD: PASSWORDS.admin },
        { FRAMER_INITIAL_PASSWORD: PASSWORDS.framer },
        {
          ADMIN_INITIAL_PASSWORD: 'short',
          FRAMER_INITIAL_PASSWORD: PASSWORDS.framer
        },
        {
          ADMIN_INITIAL_PASSWORD: PASSWORDS.admin,
          FRAMER_INITIAL_PASSWORD: 'x'.repeat(129)
        }
      ];

      for (const initialEnv of invalidEnvironments) {
        const failed = startSafetyApp(storage, initialEnv);
        await expect(failed.startup).rejects.toThrow(
          'Set ADMIN_INITIAL_PASSWORD and FRAMER_INITIAL_PASSWORD before first start'
        );
        expect(failed.transactionCalls()).toBe(0);
        expect(bootstrapCounts(storage)).toEqual({ users: 0, marker: 0 });
      }

      const successful = startSafetyApp(storage, {
        ADMIN_INITIAL_PASSWORD: PASSWORDS.admin,
        FRAMER_INITIAL_PASSWORD: PASSWORDS.framer
      });
      expect(successful.transactionCalls()).toBe(0);
      await successful.startup;
      expect(successful.transactionCalls()).toBe(1);
      expect(bootstrapCounts(storage)).toEqual({ users: 2, marker: 1 });

      const users = [...storage.sql.exec(
        'SELECT role,password_hash FROM users ORDER BY role'
      )];
      expect(users.map((user) => user.role)).toEqual(['admin', 'framer']);
      expect(await Promise.all([
        verifyPassword(PASSWORDS.admin, users[0].password_hash),
        verifyPassword(PASSWORDS.framer, users[0].password_hash),
        verifyPassword(PASSWORDS.admin, users[1].password_hash),
        verifyPassword(PASSWORDS.framer, users[1].password_hash)
      ])).toEqual([true, false, false, true]);
    });
  });

  it('never reads initial passwords when a marker or legacy users exist', async () => {
    await runInDurableObject(appStub(), async (instance) => {
      const storage = instance.state.storage;
      const usersBefore = [...storage.sql.exec(
        'SELECT id,password_hash FROM users ORDER BY id'
      )];

      const withMarker = startSafetyApp(storage, unreadableInitialPasswords());
      await withMarker.startup;
      expect((await withMarker.app.fetch(
        new Request(`${BASE}/api/health`)
      )).status).toBe(200);

      storage.sql.exec(
        "DELETE FROM app_metadata WHERE key='bootstrap_complete'"
      );
      const withLegacyUsers = startSafetyApp(
        storage,
        unreadableInitialPasswords()
      );
      await withLegacyUsers.startup;
      expect((await withLegacyUsers.app.fetch(
        new Request(`${BASE}/api/health`)
      )).status).toBe(200);
      expect(bootstrapCounts(storage)).toEqual({ users: 2, marker: 1 });
      expect([...storage.sql.exec(
        'SELECT id,password_hash FROM users ORDER BY id'
      )]).toEqual(usersBefore);
    });
  });

  it('keeps API responses private, requires exact Origin and drains rejected writes', async () => {
    const health = await request('/api/health');
    expect(await expectJson(health, 200)).toEqual({ status: 'ok' });
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');

    const loginBody = JSON.stringify({
      email: 'framer@example.test',
      password: PASSWORDS.framer
    });
    const missingOrigin = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: loginBody
    });
    await expectText(missingOrigin, 403);

    const deceptiveOrigin = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `${BASE}.attacker.invalid` },
      body: loginBody
    });
    await expectText(deceptiveOrigin, 403);

    const framer = await login('framer');
    expect(framer).toContain('ras_session=');
    const beforeWrites = await counts();

    const unauthorized = await request('/api/submissions', {
      method: 'POST',
      headers: { Origin: BASE },
      body: form({ workDate: '2099-01-10' }, PNG)
    });
    await expectText(unauthorized, 401);
    const afterUnauthorized = await request('/api/health');
    await expectText(afterUnauthorized, 200);

    const unknown = await request('/api/not-a-route', {
      method: 'POST',
      headers: { Origin: BASE },
      body: form({ workDate: '2099-01-11' }, PNG)
    });
    await expectText(unknown, 404);
    expect(unknown.headers.get('cache-control')).toBe('no-store');
    expect(unknown.headers.get('x-content-type-options')).toBe('nosniff');
    const afterUnknown = await request('/api/health');
    await expectText(afterUnknown, 200);

    const admin = await login('admin');
    const forbidden = await request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: admin, Origin: BASE },
      body: form({ workDate: '2099-01-12' }, PNG)
    });
    await expectText(forbidden, 403);
    const afterForbidden = await request('/api/session', {
      headers: { Cookie: admin }
    });
    expect((await expectJson(afterForbidden, 200)).user.role).toBe('admin');
    expect(await counts()).toEqual(beforeWrites);
  });

  it('shares the two-operation KDF capacity across all credential operations', async () => {
    const admin = await login('admin');
    const reservations = [];
    await runInDurableObject(appStub(), (instance) => {
      const now = Date.now();
      for (let index = 0; index < 2; index++) {
        const reservation = instance.reserveLogin(new Request(`${BASE}/api/login`, {
          headers: { 'x-ras-client-ip': `held-${index}` }
        }), now);
        if (reservation) reservations.push(reservation);
      }
    });

    try {
      expect(reservations).toHaveLength(2);
      const rejected = await request('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '192.0.2.3',
          Origin: BASE
        },
        body: JSON.stringify({
          email: 'framer@example.test',
          password: PASSWORDS.framer
        })
      });
      await expectText(rejected, 429);

      const blockedCreate = await request('/api/admin/users', {
        method: 'POST',
        headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Capacity Rejected',
          email: 'capacity@example.test',
          role: 'framer',
          password: 'Capacity-Test-2026!'
        })
      });
      await expectText(blockedCreate, 429);

      const blockedReset = await request('/api/admin/users/2/password', {
        method: 'POST',
        headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'Capacity-Reset-2026!' })
      });
      await expectText(blockedReset, 429);

      const blockedSelfChange = await request('/api/account/password', {
        method: 'POST',
        headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: PASSWORDS.admin,
          new_password: 'Capacity-Self-Change-2026!'
        })
      });
      await expectText(blockedSelfChange, 429);
    } finally {
      await runInDurableObject(appStub(), (instance) => {
        const now = Date.now();
        for (const reservation of reservations) {
          instance.finishLogin(reservation, 'neutral', now);
        }
      });
    }

    expect(await login('framer')).toContain('ras_session=');
  });

  it('stores only an opaque session hash with a Unix expiry and resolves the current role', async () => {
    const beforeLogin = Math.floor(Date.now() / 1000);
    const cookie = await login('admin');
    const afterLogin = Math.floor(Date.now() / 1000);
    const token = tokenFromCookie(cookie);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatch(/(?:^|; )Max-Age=43200(?:;|$)/);
    expect(cookie).toMatch(/(?:^|; )Path=\/api(?:;|$)/);
    expect(cookie).toMatch(/(?:^|; )HttpOnly(?:;|$)/);
    expect(cookie).toMatch(/(?:^|; )SameSite=Strict(?:;|$)/);
    expect(cookie).toMatch(/(?:^|; )Secure(?:;|$)/);

    const stored = await sql((storage) => [...storage.exec(
      'SELECT token_hash,expires_at FROM sessions WHERE token_hash=?',
      tokenHash(cookie)
    )][0]);
    expect(stored.token_hash).toBe(tokenHash(cookie));
    expect(stored.token_hash).not.toBe(token);
    expect(Number.isInteger(stored.expires_at)).toBe(true);
    expect(stored.expires_at).toBeGreaterThanOrEqual(beforeLogin + 43_200);
    expect(stored.expires_at).toBeLessThanOrEqual(afterLogin + 43_200);
    expect(stored.expires_at).toBeLessThan(100_000_000_000);

    await sql((storage) => storage.exec(
      'UPDATE sessions SET expires_at=? WHERE token_hash=?',
      Math.floor(Date.now() / 1000),
      tokenHash(cookie)
    ));
    const expired = await request('/api/session', { headers: { Cookie: cookie } });
    await expectText(expired, 401);
    expect(await sql((storage) => Number([...storage.exec(
      'SELECT COUNT(*) AS count FROM sessions WHERE token_hash=?',
      tokenHash(cookie)
    )][0].count))).toBe(0);

    const fresh = await login('admin');
    await sql((storage) => storage.exec("UPDATE users SET role='framer' WHERE id=1"));
    const session = await request('/api/session', { headers: { Cookie: fresh } });
    expect((await expectJson(session, 200)).user.role).toBe('framer');
    const workers = await request('/api/admin/workers', { headers: { Cookie: fresh } });
    await expectText(workers, 403);
  });

  it('manages temporary staff passwords, gates private state, and revokes every session', async () => {
    const admin = await login('admin');
    const adminSession = await request('/api/session', { headers: { Cookie: admin } });
    const adminUser = (await expectJson(adminSession, 200)).user;
    const selfReset = await request(`/api/admin/users/${adminUser.id}/password`, {
      method: 'POST',
      headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Admin-Self-Reset-2026!' })
    });
    await expectText(selfReset, 400);
    const missingReset = await request('/api/admin/users/999999/password', {
      method: 'POST',
      headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Missing-Staff-2026!' })
    });
    await expectText(missingReset, 404);

    const framer = await login('framer');
    await expectText(await request('/api/admin/users', { headers: { Cookie: framer } }), 403);
    const forbiddenCreate = await request('/api/admin/users', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Forbidden Account',
        email: 'forbidden@example.test',
        role: 'framer',
        password: 'Forbidden-Staff-2026!'
      })
    });
    await expectText(forbiddenCreate, 403);
    const forbiddenReset = await request(`/api/admin/users/${adminUser.id}/password`, {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Forbidden-Reset-2026!' })
    });
    await expectText(forbiddenReset, 403);

    const create = await request('/api/admin/users', {
      method: 'POST',
      headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Temporary Framer',
        email: '  New.Staff@Example.Test ',
        role: 'framer',
        password: 'Temporary-Staff-2026!'
      })
    });
    const created = await expectJson(create, 201);
    expect(created).toEqual({
      user: {
        id: expect.any(Number),
        email: 'new.staff@example.test',
        name: 'Temporary Framer',
        role: 'framer',
        must_change_password: true,
        created_at: expect.any(String)
      }
    });

    const staff = await request('/api/admin/users', { headers: { Cookie: admin } });
    const listed = (await expectJson(staff, 200)).users.find((item) => item.id === created.user.id);
    expect(listed).toEqual(created.user);
    expect(Object.keys(listed).sort()).toEqual(
      ['id', 'email', 'name', 'role', 'must_change_password', 'created_at'].sort()
    );

    const duplicate = await request('/api/admin/users', {
      method: 'POST',
      headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Duplicate',
        email: 'NEW.STAFF@EXAMPLE.TEST',
        role: 'admin',
        password: 'Another-Staff-2026!'
      })
    });
    await expectText(duplicate, 409);

    const temporary = await loginWithCredentials('new.staff@example.test', 'Temporary-Staff-2026!');
    await expectText(temporary.response, 200);
    const secondTemporary = await loginWithCredentials('new.staff@example.test', 'Temporary-Staff-2026!');
    await expectText(secondTemporary.response, 200);
    const session = await request('/api/session', { headers: { Cookie: temporary.cookie } });
    expect((await expectJson(session, 200)).user.must_change_password).toBe(true);
    const logout = await request('/api/logout', {
      method: 'POST',
      headers: { Cookie: secondTemporary.cookie, Origin: BASE }
    });
    await expectText(logout, 204);
    await expectText(await request('/api/session', { headers: { Cookie: secondTemporary.cookie } }), 401);
    const revocableTemporary = await loginWithCredentials(
      'new.staff@example.test',
      'Temporary-Staff-2026!'
    );
    await expectText(revocableTemporary.response, 200);
    for (const path of [
      '/api/sites',
      '/api/submissions',
      '/api/submissions/1',
      '/api/photos/1',
      '/api/photos/1/thumbnail',
      '/api/admin/workers',
      '/api/admin/users'
    ]) {
      const blocked = await request(path, { headers: { Cookie: temporary.cookie } });
      expect(await expectJson(blocked, 403)).toEqual({
        error: 'Change your temporary password before continuing',
        code: 'password_change_required'
      });
    }
    const blockedSubmission = await request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: temporary.cookie, Origin: BASE },
      body: form({ workDate: '2099-01-20' }, PNG)
    });
    expect(await expectJson(blockedSubmission, 403)).toEqual({
      error: 'Change your temporary password before continuing',
      code: 'password_change_required'
    });

    const changed = await request('/api/account/password', {
      method: 'POST',
      headers: { Cookie: temporary.cookie, Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current_password: 'Temporary-Staff-2026!',
        new_password: 'Permanent-Staff-2026!'
      })
    });
    await expectText(changed, 204);
    expect(changed.headers.get('set-cookie')).toMatch(/(?:^|; )Max-Age=0(?:;|$)/);
    await expectText(await request('/api/session', { headers: { Cookie: temporary.cookie } }), 401);
    await expectText(await request('/api/session', { headers: { Cookie: revocableTemporary.cookie } }), 401);

    const permanent = await loginWithCredentials('NEW.STAFF@EXAMPLE.TEST', 'Permanent-Staff-2026!');
    const permanentBody = await expectJson(permanent.response, 200);
    expect(permanentBody.user.must_change_password).toBe(false);
    const secondPermanent = await loginWithCredentials('new.staff@example.test', 'Permanent-Staff-2026!');
    await expectText(secondPermanent.response, 200);

    const reset = await request(`/api/admin/users/${created.user.id}/password`, {
      method: 'POST',
      headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Reset-Staff-2026!' })
    });
    expect(await expectJson(reset, 200)).toEqual({
      user: { ...created.user, must_change_password: true }
    });
    await expectText(await request('/api/session', { headers: { Cookie: permanent.cookie } }), 401);
    await expectText(await request('/api/session', { headers: { Cookie: secondPermanent.cookie } }), 401);
    const resetLogin = await loginWithCredentials('new.staff@example.test', 'Reset-Staff-2026!');
    expect((await expectJson(resetLogin.response, 200)).user.must_change_password).toBe(true);
  });

  it('returns 409 when a password changes while an admin reset is hashing', async () => {
    const admin = await login('admin');
    const targetSession = await login('framer');
    const result = await runInDurableObject(
      appStub(),
      async (instance, state) => {
        const resetRequest = new Request(
          `${BASE}/api/admin/users/2/password`,
          {
            method: 'POST',
            headers: {
              Cookie: admin,
              Origin: BASE,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              password: 'Concurrent-Reset-One-2026!'
            })
          }
        );
        const actor = instance.authenticate(resetRequest);
        const originalReserveKdf = instance.reserveKdf;
        let announceKdfReserve;
        const kdfReserved = new Promise((resolve) => {
          announceKdfReserve = resolve;
        });
        instance.reserveKdf = function reserveTestKdf() {
          const reserved = originalReserveKdf.call(this);
          if (reserved) {
            announceKdfReserve();
          }
          return reserved;
        };
        try {
          const pending = instance.handleAdminPasswordReset(
            resetRequest,
            actor,
            '2'
          );
          await kdfReserved;
          state.storage.transactionSync(() => {
            state.storage.sql.exec(
              `UPDATE users
               SET password_hash=(SELECT password_hash FROM users WHERE id=1)
               WHERE id=2`
            );
            state.storage.sql.exec('DELETE FROM sessions WHERE user_id=2');
          });
          const response = await pending;
          return {
            status: response.status,
            body: await response.json()
          };
        } finally {
          instance.reserveKdf = originalReserveKdf;
        }
      }
    );
    expect(result).toEqual({
      status: 409,
      body: {
        error: 'Password was changed by another request. Try again.'
      }
    });
    await expectText(
      await request('/api/session', { headers: { Cookie: targetSession } }),
      401
    );
  });

  it('rechecks temporary-password state after image decoding before upload commit', async () => {
    const framer = await login('framer');
    const session = await request('/api/session', { headers: { Cookie: framer } });
    const userId = (await expectJson(session, 200)).user.id;
    const before = await counts();
    const response = await runInDurableObject(appStub(), async (instance, state) => {
      const images = instance.env.IMAGES;
      let announceInfo;
      let resumeInfo;
      const infoStarted = new Promise((resolve) => { announceInfo = resolve; });
      const infoGate = new Promise((resolve) => { resumeInfo = resolve; });
      instance.env.IMAGES = {
        async info(stream) {
          announceInfo();
          await infoGate;
          return images.info(stream);
        },
        input(source) {
          return images.input(source);
        }
      };
      try {
        const pending = instance.fetch(new Request(`${BASE}/api/submissions`, {
          method: 'POST',
          headers: { Cookie: framer, Origin: BASE },
          body: form({ workDate: '2099-01-21' }, PNG)
        }));
        await infoStarted;
        state.storage.sql.exec(
          'UPDATE users SET must_change_password=1 WHERE id=?',
          userId
        );
        resumeInfo();
        return await pending;
      } finally {
        resumeInfo();
        instance.env.IMAGES = images;
      }
    });
    expect(await expectJson(response, 403)).toEqual({
      error: 'Change your temporary password before continuing',
      code: 'password_change_required'
    });
    expect(await counts()).toEqual(before);
  });

  it('bounds and validates staff account inputs without exposing a signup route', async () => {
    const admin = await login('admin');
    const valid = {
      name: 'Validation Target',
      email: 'validation@example.test',
      role: 'framer',
      password: 'Validation-Password-2026!'
    };
    const invalidBodies = [
      { ...valid, name: '   ' },
      { ...valid, name: '😀'.repeat(101) },
      { ...valid, email: 'control\u0000@example.test' },
      { ...valid, email: `person@${'a'.repeat(64)}.test` },
      { ...valid, role: 'owner' },
      { ...valid, password: '😀'.repeat(11) },
      { ...valid, password: '😀'.repeat(129) }
    ];
    for (const body of invalidBodies) {
      const response = await request('/api/admin/users', {
        method: 'POST',
        headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      await expectText(response, 400);
    }

    const oversized = await request('/api/admin/users', {
      method: 'POST',
      headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...valid, padding: 'x'.repeat(8192) })
    });
    await expectText(oversized, 413);

    const signup = await request('/api/signup', {
      method: 'POST',
      headers: { Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify(valid)
    });
    await expectText(signup, 404);
  });

  it('rate-limits wrong current-password attempts', async () => {
    const admin = await login('admin');
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request('/api/account/password', {
        method: 'POST',
        headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: 'Wrong-Current-Password!',
          new_password: 'Wrong-Current-Password!'
        })
      });
      await expectText(response, 400);
    }
    const limited = await request('/api/account/password', {
      method: 'POST',
      headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current_password: 'Wrong-Current-Password!',
        new_password: 'Wrong-Current-Password!'
      })
    });
    await expectText(limited, 429);
    await expectText(await request('/api/session', { headers: { Cookie: admin } }), 200);
  });

  it('rejects oversized login bodies before forwarding to the Durable Object', async () => {
    const body = JSON.stringify({
      email: 'framer@example.test',
      password: 'x'.repeat(9000)
    });
    const response = await request('/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(new TextEncoder().encode(body).byteLength)
      },
      body
    });
    expect(await expectJson(response, 413)).toEqual({
      error: 'Request is too large'
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await login('framer')).toContain('ras_session=');
  });

  it('requires Content-Length only for API POSTs that carry a body', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      }
    });
    const missingLength = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half'
    });
    expect(await expectJson(missingLength, 411)).toEqual({
      error: 'Content-Length required'
    });

    const cookie = await login('framer');
    const logout = await request('/api/logout', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: BASE }
    });
    await expectText(logout, 204);
  });

  it('keeps failed login limits per email when another account succeeds', async () => {
    const clientHeaders = {
      'Content-Type': 'application/json',
      Origin: BASE,
      'CF-Connecting-IP': '198.51.100.20'
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request('/api/login', {
        method: 'POST',
        headers: clientHeaders,
        body: JSON.stringify({
          email: 'target@example.test',
          password: 'Wrong-Password-2026!'
        })
      });
      await expectText(response, 401);
    }
    const other = await request('/api/login', {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({
        email: 'admin@example.test',
        password: PASSWORDS.admin
      })
    });
    await expectText(other, 200);
    const sixth = await request('/api/login', {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({
        email: 'target@example.test',
        password: 'Wrong-Password-2026!'
      })
    });
    await expectText(sixth, 429);

    const limitedEmailHeaders = {
      ...clientHeaders,
      'CF-Connecting-IP': '198.51.100.21'
    };
    for (let attempt = 0; attempt < 20; attempt++) {
      const blocked = await request('/api/login', {
        method: 'POST',
        headers: limitedEmailHeaders,
        body: JSON.stringify({
          email: 'target@example.test',
          password: 'Wrong-Password-2026!'
        })
      });
      await expectText(blocked, 429);
    }
    const validOtherEmail = await request('/api/login', {
      method: 'POST',
      headers: limitedEmailHeaders,
      body: JSON.stringify({
        email: 'admin@example.test',
        password: PASSWORDS.admin
      })
    });
    await expectText(validOtherEmail, 200);
  });

  it('limits login failures per IP without clearing that counter on success', async () => {
    const headers = {
      'Content-Type': 'application/json',
      Origin: BASE,
      'CF-Connecting-IP': '203.0.113.40'
    };
    const fail = (index) => request('/api/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: `missing-${index}@example.test`,
        password: 'Wrong-Password-2026!'
      })
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      await expectText(await fail(attempt), 401);
    }
    const success = await request('/api/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: 'admin@example.test',
        password: PASSWORDS.admin
      })
    });
    await expectText(success, 200);
    for (let attempt = 4; attempt < 20; attempt++) {
      await expectText(await fail(attempt), 401);
    }
    expect(await expectJson(await fail(20), 429)).toEqual({
      error: 'Too many login attempts'
    });

    const tracker = await runInDurableObject(appStub(), (instance) => {
      let allReserved = true;
      const now = Date.now();
      for (let index = 0; index < 600; index++) {
        const reservation = instance.reserveLogin(
          new Request(`${BASE}/api/login`, {
            headers: { 'x-ras-client-ip': `bounded-${index}` }
          }),
          now,
          `bounded-${index}@example.test`
        );
        if (!reservation) {
          allReserved = false;
          break;
        }
        instance.finishLogin(reservation, 'failure', now);
      }
      return { allReserved, size: instance.loginAttempts.size };
    });
    expect(tracker.allReserved).toBe(true);
    expect(tracker.size).toBeLessThanOrEqual(1024);
  });

  it('keeps the five newest active sessions when a sixth login succeeds', async () => {
    const sessions = [];
    for (let index = 0; index < 6; index++) {
      sessions.push(await login('framer'));
    }
    expect(await sql((storage) => Number([...storage.exec(
      'SELECT COUNT(*) AS count FROM sessions WHERE user_id=2'
    )][0].count))).toBe(5);
    await expectText(
      await request('/api/session', { headers: { Cookie: sessions[0] } }),
      401
    );
    for (const cookie of sessions.slice(1)) {
      await expectText(
        await request('/api/session', { headers: { Cookie: cookie } }),
        200
      );
    }
  });

  it('enforces per-user storage and rolling daily submission limits', async () => {
    const framer = await login('framer');
    const before = await counts();
    const userQuotaResponse = await withEnv({
      USER_PHOTO_QUOTA_BYTES: 1,
      APP_PHOTO_QUOTA_BYTES: 800 * 1024 * 1024
    }, () => request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE },
      body: form({ workDate: '2099-08-01' }, PNG)
    }));
    expect(await expectJson(userQuotaResponse, 413)).toEqual({
      error: 'Photo storage limit reached'
    });

    const appQuotaResponse = await withEnv({
      USER_PHOTO_QUOTA_BYTES: 200 * 1024 * 1024,
      APP_PHOTO_QUOTA_BYTES: 1
    }, () => request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE },
      body: form({ workDate: '2099-08-02' }, PNG)
    }));
    expect(await expectJson(appQuotaResponse, 413)).toEqual({
      error: 'Photo storage limit reached'
    });
    expect(await counts()).toEqual(before);
    expect(await runInDurableObject(
      appStub(),
      (instance) => instance.getLimit('USER_PHOTO_QUOTA_BYTES', 12345)
    )).toBe(12345);

    const transactionQuotaResponse = await withEnv({
      USER_PHOTO_QUOTA_BYTES: 5 * 1024 * 1024,
      APP_PHOTO_QUOTA_BYTES: 800 * 1024 * 1024
    }, async (instance) => {
      const images = instance.env.IMAGES;
      const storage = instance.state.storage.sql;
      let injectedSubmissionId = null;
      let injectedPhotoId = null;
      instance.env.IMAGES = {
        async info(source) {
          const inserted = [...storage.exec(
            `INSERT INTO submissions (
               worker_id,site_id,work_date,hard_hat,high_visibility_vest,
               safety_boots,eye_protection,fall_protection,
               ladders_scaffolds_inspected,tools_cords_checked,
               hazards_identified,notes,created_at
             ) VALUES (2,1,'2099-08-20',1,1,1,1,1,1,1,1,'',CURRENT_TIMESTAMP)
             RETURNING id`
          )][0];
          injectedSubmissionId = Number(inserted.id);
          injectedPhotoId = Number([...storage.exec(
            `INSERT INTO photos (submission_id,mime_type,size_bytes)
             VALUES (?,'image/png',?) RETURNING id`,
            injectedSubmissionId,
            5 * 1024 * 1024
          )][0].id);
          return images.info(source);
        },
        input(source) {
          return images.input(source);
        }
      };
      try {
        return await instance.fetch(new Request(`${BASE}/api/submissions`, {
          method: 'POST',
          headers: { Cookie: framer, Origin: BASE },
          body: form({ workDate: '2099-08-21' }, PNG)
        }));
      } finally {
        instance.env.IMAGES = images;
        if (injectedPhotoId !== null) {
          storage.exec('DELETE FROM photos WHERE id=?', injectedPhotoId);
        }
        if (injectedSubmissionId !== null) {
          storage.exec('DELETE FROM submissions WHERE id=?', injectedSubmissionId);
        }
      }
    });
    expect(await expectJson(transactionQuotaResponse, 413)).toEqual({
      error: 'Photo storage limit reached'
    });
    expect(await counts()).toEqual(before);

    await sql((storage) => storage.exec(
      `INSERT INTO submissions (
         worker_id,site_id,work_date,hard_hat,high_visibility_vest,
         safety_boots,eye_protection,fall_protection,ladders_scaffolds_inspected,
         tools_cords_checked,hazards_identified,notes,created_at
       ) VALUES (2,1,'2099-08-02',1,1,1,1,1,1,1,1,'',CURRENT_TIMESTAMP)`
    ));
    const dailyResponse = await withEnv({
      USER_PHOTO_QUOTA_BYTES: 200 * 1024 * 1024,
      APP_PHOTO_QUOTA_BYTES: 800 * 1024 * 1024,
      DAILY_SUBMISSION_LIMIT: 1
    }, () => request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE },
      body: form({ workDate: '2099-08-03' }, PNG)
    }));
    await expectText(dailyResponse, 429);
  });

  it('limits the upload queue to three and releases every queue slot', async () => {
    const framer = await login('framer');
    const responses = await runInDurableObject(appStub(), async (instance) => {
      const images = instance.env.IMAGES;
      let announceFirstInfo;
      let releaseFirstInfo;
      let firstInfo = true;
      const infoStarted = new Promise((resolve) => {
        announceFirstInfo = resolve;
      });
      const infoGate = new Promise((resolve) => {
        releaseFirstInfo = resolve;
      });
      instance.env.IMAGES = {
        async info(source) {
          if (firstInfo) {
            firstInfo = false;
            announceFirstInfo();
            await infoGate;
          }
          return images.info(source);
        },
        input(source) {
          return images.input(source);
        }
      };
      const upload = (workDate) => instance.fetch(new Request(
        `${BASE}/api/submissions`,
        {
          method: 'POST',
          headers: { Cookie: framer, Origin: BASE },
          body: form({ workDate }, PNG)
        }
      ));
      try {
        const first = upload('2099-08-10');
        await infoStarted;
        const second = upload('2099-08-11');
        const third = upload('2099-08-12');
        const busy = await upload('2099-08-13');
        releaseFirstInfo();
        const accepted = await Promise.all([first, second, third]);
        return {
          busy: {
            status: busy.status,
            body: await busy.json()
          },
          accepted: await Promise.all(accepted.map(async (response) => ({
            status: response.status,
            body: await response.text()
          })))
        };
      } finally {
        releaseFirstInfo();
        instance.env.IMAGES = images;
      }
    });
    expect(responses.busy).toEqual({
      status: 503,
      body: { error: 'Uploads are busy. Try again shortly.' }
    });
    for (const response of responses.accepted) {
      expect(response.status).toBe(201);
      expect(JSON.parse(response.body)).toHaveProperty('submission');
    }
    expect(await runInDurableObject(appStub(), async (instance) => {
      try {
        await instance.withUploadLock(async () => {
          throw new Error('controlled queue failure');
        });
      } catch {
        // The queue counter must be released even when the operation throws.
      }
      return instance.pendingUploads;
    })).toBe(0);
  });

  it('migrates a populated v2 database to v3 additively and idempotently', async () => {
    const legacySession = await login('framer');
    const beforeDetail = await request('/api/submissions/1', {
      headers: { Cookie: legacySession }
    });
    const expectedDetail = await expectJson(beforeDetail, 200);
    const beforePhoto = await request('/api/photos/1', {
      headers: { Cookie: legacySession }
    });
    const expectedPhoto = new Uint8Array(await beforePhoto.arrayBuffer());
    expect(beforePhoto.status).toBe(200);

    const rowCounts = (storage) => ({
      users: Number([...storage.exec('SELECT COUNT(*) AS count FROM users')][0].count),
      submissions: Number([
        ...storage.exec('SELECT COUNT(*) AS count FROM submissions')
      ][0].count),
      photos: Number([...storage.exec('SELECT COUNT(*) AS count FROM photos')][0].count),
      chunks: Number([
        ...storage.exec('SELECT COUNT(*) AS count FROM photo_chunks')
      ][0].count),
      sessions: Number([
        ...storage.exec('SELECT COUNT(*) AS count FROM sessions')
      ][0].count)
    });
    const expectedCounts = await sql(rowCounts);

    await sql((storage) => {
      storage.exec('DROP TABLE photo_thumbnails');
      storage.exec('DROP INDEX sessions_user_id_idx');
      storage.exec('DROP INDEX sessions_expires_at_idx');
      storage.exec("UPDATE app_metadata SET value='2' WHERE key='schema_version'");
    });
    await evictDurableObject(appStub());

    const preservedSession = await request('/api/session', {
      headers: { Cookie: legacySession }
    });
    expect((await expectJson(preservedSession, 200)).user.must_change_password)
      .toBe(false);
    expect(await sql(rowCounts)).toEqual(expectedCounts);

    const schemaObjects = await sql((storage) => [...storage.exec(
      `SELECT type,name FROM sqlite_master
       WHERE name IN (
         'photo_thumbnails',
         'sessions_user_id_idx',
         'sessions_expires_at_idx'
       )
       ORDER BY name`
    )]);
    expect(schemaObjects).toEqual([
      { type: 'table', name: 'photo_thumbnails' },
      { type: 'index', name: 'sessions_expires_at_idx' },
      { type: 'index', name: 'sessions_user_id_idx' }
    ]);
    expect(await sql((storage) => [...storage.exec(
      "SELECT value FROM app_metadata WHERE key='schema_version'"
    )][0].value)).toBe('3');

    const migratedLogin = await loginWithCredentials(
      'framer@example.test',
      PASSWORDS.framer
    );
    expect((await expectJson(migratedLogin.response, 200)).user.must_change_password)
      .toBe(false);
    const migratedDetail = await request('/api/submissions/1', {
      headers: { Cookie: migratedLogin.cookie }
    });
    expect(await expectJson(migratedDetail, 200)).toEqual(expectedDetail);
    const migratedPhoto = await request('/api/photos/1', {
      headers: { Cookie: migratedLogin.cookie }
    });
    expect(migratedPhoto.status).toBe(200);
    expect(new Uint8Array(await migratedPhoto.arrayBuffer())).toEqual(expectedPhoto);

    const countsAfterLogin = await sql(rowCounts);
    await evictDurableObject(appStub());
    await expectText(await request('/api/health'), 200);
    expect(await sql(rowCounts)).toEqual(countsAfterLogin);
    expect(await sql((storage) => [...storage.exec(
      "SELECT value FROM app_metadata WHERE key='schema_version'"
    )][0].value)).toBe('3');
  });

  it('enforces ownership and reconstructs authenticated original chunks byte-for-byte', async () => {
    const fixture = await sql((storage) => {
      const submissionId = Number([...storage.exec(`
        INSERT INTO submissions (
          worker_id, site_id, work_date, hard_hat, high_visibility_vest,
          safety_boots, eye_protection, fall_protection, ladders_scaffolds_inspected,
          tools_cords_checked, hazards_identified, notes
        ) VALUES (1, 1, '2098-12-31', 1, 1, 1, 1, 1, 1, 1, 1, '')
        RETURNING id
      `)][0].id);
      const photoId = Number([...storage.exec(
        'INSERT INTO photos (submission_id,mime_type,size_bytes) VALUES (?,?,?) RETURNING id',
        submissionId,
        'image/png',
        PNG.byteLength
      )][0].id);
      const chunks = [PNG.slice(0, 11), PNG.slice(11, 37), PNG.slice(37)];
      for (let index = 0; index < chunks.length; index++) {
        storage.exec(
          'INSERT INTO photo_chunks (photo_id,chunk_index,bytes) VALUES (?,?,?)',
          photoId,
          index,
          chunks[index].buffer
        );
      }
      return { submissionId, photoId };
    });

    const framer = await login('framer');
    const own = await request('/api/submissions', { headers: { Cookie: framer } });
    const ownBody = await expectJson(own, 200);
    expect(ownBody.submissions.length).toBeGreaterThan(0);
    expect(ownBody.submissions.every((row) => row.worker_id === 2)).toBe(true);
    const attemptedBroaden = await request('/api/submissions?worker_id=1', {
      headers: { Cookie: framer }
    });
    expect((await expectJson(attemptedBroaden, 200)).submissions.every(
      (row) => row.worker_id === 2
    )).toBe(true);
    const ownDetail = await request('/api/submissions/1', {
      headers: { Cookie: framer }
    });
    await expectText(ownDetail, 200);
    const ownPhoto = await request('/api/photos/1', {
      headers: { Cookie: framer }
    });
    const ownPhotoBytes = new Uint8Array(await ownPhoto.arrayBuffer());
    expect({ status: ownPhoto.status, bodyBytes: ownPhotoBytes.byteLength })
      .toMatchObject({ status: 200 });
    expect(ownPhoto.headers.get('content-type')).toBe('image/png');
    expect(ownPhoto.headers.get('cache-control')).toBe('no-store');
    expect(ownPhotoBytes.slice(0, 8)).toEqual(
      Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
    );
    const ownThumbnail = await request('/api/photos/1/thumbnail', {
      headers: { Cookie: framer }
    });
    const ownThumbnailBytes = new Uint8Array(await ownThumbnail.arrayBuffer());
    expect(ownThumbnail.status).toBe(200);
    expect(ownThumbnail.headers.get('content-type')).toBe('image/webp');
    expect(ownThumbnail.headers.get('cache-control')).toBe('no-store');
    expect(ownThumbnailBytes.byteLength).toBeGreaterThan(0);
    expect(await sql((storage) => Number([...storage.exec(
      'SELECT COUNT(*) AS count FROM photo_thumbnails WHERE photo_id=1'
    )][0].count))).toBe(1);

    const hiddenDetail = await request(`/api/submissions/${fixture.submissionId}`, {
      headers: { Cookie: framer }
    });
    await expectText(hiddenDetail, 404);
    const hiddenPhoto = await request(`/api/photos/${fixture.photoId}`, {
      headers: { Cookie: framer }
    });
    await expectText(hiddenPhoto, 404);

    const admin = await login('admin');
    const fullHistory = await request('/api/submissions', { headers: { Cookie: admin } });
    expect((await expectJson(fullHistory, 200)).submissions.some(
      (row) => row.id === fixture.submissionId && row.worker_id === 1
    )).toBe(true);

    const visible = await request(`/api/submissions/${fixture.submissionId}`, {
      headers: { Cookie: admin }
    });
    expect((await expectJson(visible, 200)).submission.worker_id).toBe(1);

    const photo = await request(`/api/photos/${fixture.photoId}`, {
      headers: { Cookie: admin }
    });
    const photoBytes = new Uint8Array(await photo.arrayBuffer());
    expect({ status: photo.status, bodyBytes: photoBytes.byteLength })
      .toMatchObject({ status: 200 });
    expect(photo.headers.get('content-type')).toBe('image/png');
    expect(photo.headers.get('content-length')).toBe(String(PNG.byteLength));
    expect(photo.headers.get('cache-control')).toBe('no-store');
    expect(photo.headers.get('x-content-type-options')).toBe('nosniff');
    expect(photoBytes).toEqual(PNG);
    const adminThumbnail = await request(`/api/photos/${fixture.photoId}/thumbnail`, {
      headers: { Cookie: admin }
    });
    expect(adminThumbnail.status).toBe(200);
    expect(adminThumbnail.headers.get('content-type')).toBe('image/webp');

    await sql((storage) => {
      const passwordHash = [...storage.exec(
        'SELECT password_hash FROM users WHERE id=2'
      )][0].password_hash;
      storage.exec(
        'INSERT INTO users (email,name,password_hash,role) VALUES (?,?,?,?)',
        'other.framer@example.test',
        'Other Framer',
        passwordHash,
        'framer'
      );
    });
    const other = await loginWithCredentials(
      'other.framer@example.test',
      PASSWORDS.framer
    );
    await expectText(other.response, 200);
    await expectText(
      await request(`/api/photos/${fixture.photoId}/thumbnail`, {
        headers: { Cookie: other.cookie }
      }),
      404
    );
  });

  it('deletes an admin submission and all photo storage atomically', async () => {
    const fixture = await sql((storage) => {
      const submissionId = Number([...storage.exec(`
        INSERT INTO submissions (
          worker_id, site_id, work_date, hard_hat, high_visibility_vest,
          safety_boots, eye_protection, fall_protection, ladders_scaffolds_inspected,
          tools_cords_checked, hazards_identified, notes
        ) VALUES (2, 1, '2098-01-01', 1, 1, 1, 1, 1, 1, 1, 1, 'delete me')
        RETURNING id
      `)][0].id);
      const untouchedSubmissionId = Number([...storage.exec(`
        INSERT INTO submissions (
          worker_id, site_id, work_date, hard_hat, high_visibility_vest,
          safety_boots, eye_protection, fall_protection, ladders_scaffolds_inspected,
          tools_cords_checked, hazards_identified, notes
        ) VALUES (2, 1, '2098-01-02', 1, 1, 1, 1, 1, 1, 1, 1, 'keep me')
        RETURNING id
      `)][0].id);
      const photoId = Number([...storage.exec(
        'INSERT INTO photos (submission_id,mime_type,size_bytes) VALUES (?,?,?) RETURNING id',
        submissionId,
        'image/png',
        PNG.byteLength
      )][0].id);
      storage.exec(
        'INSERT INTO photo_chunks (photo_id,chunk_index,bytes) VALUES (?,?,?)',
        photoId,
        0,
        PNG.buffer
      );
      storage.exec(
        'INSERT INTO photo_thumbnails (photo_id,bytes) VALUES (?,?)',
        photoId,
        PNG.buffer
      );
      return { submissionId, photoId, untouchedSubmissionId };
    });
    const admin = await login('admin');
    const before = await expectJson(await request('/api/submissions', {
      headers: { Cookie: admin }
    }), 200);
    expect(before.submissions.some((row) => row.id === fixture.submissionId)).toBe(true);

    await sql((storage) => storage.exec(`
      CREATE TRIGGER reject_controlled_submission_delete
      BEFORE DELETE ON photos
      WHEN OLD.submission_id = ${fixture.submissionId}
      BEGIN
        SELECT RAISE(ABORT, 'controlled delete failure');
      END
    `));
    try {
      await expectText(await request(`/api/submissions/${fixture.submissionId}`, {
        method: 'DELETE',
        headers: { Cookie: admin, Origin: BASE }
      }), 500);
      expect(await sql((storage) => ({
        submission: Number([...storage.exec(
          'SELECT COUNT(*) AS count FROM submissions WHERE id=?',
          fixture.submissionId
        )][0].count),
        photo: Number([...storage.exec(
          'SELECT COUNT(*) AS count FROM photos WHERE id=?',
          fixture.photoId
        )][0].count),
        chunks: Number([...storage.exec(
          'SELECT COUNT(*) AS count FROM photo_chunks WHERE photo_id=?',
          fixture.photoId
        )][0].count),
        thumbnail: Number([...storage.exec(
          'SELECT COUNT(*) AS count FROM photo_thumbnails WHERE photo_id=?',
          fixture.photoId
        )][0].count)
      }))).toEqual({
        submission: 1,
        photo: 1,
        chunks: 1,
        thumbnail: 1
      });
    } finally {
      await sql((storage) =>
        storage.exec('DROP TRIGGER reject_controlled_submission_delete')
      );
    }

    const deleted = await request(`/api/submissions/${fixture.submissionId}`, {
      method: 'DELETE',
      headers: { Cookie: admin, Origin: BASE }
    });
    await expectText(deleted, 204);
    expect(deleted.headers.get('cache-control')).toBe('no-store');
    expect(deleted.headers.get('x-content-type-options')).toBe('nosniff');

    for (const path of [
      `/api/submissions/${fixture.submissionId}`,
      `/api/photos/${fixture.photoId}`,
      `/api/photos/${fixture.photoId}/thumbnail`
    ]) {
      await expectText(await request(path, { headers: { Cookie: admin } }), 404);
    }
    const after = await expectJson(await request('/api/submissions', {
      headers: { Cookie: admin }
    }), 200);
    expect(after.submissions.some((row) => row.id === fixture.submissionId)).toBe(false);
    expect(after.submissions.some((row) => row.id === fixture.untouchedSubmissionId)).toBe(true);
    expect(await sql((storage) => ({
      submission: Number([...storage.exec(
        'SELECT COUNT(*) AS count FROM submissions WHERE id=?',
        fixture.submissionId
      )][0].count),
      photo: Number([...storage.exec(
        'SELECT COUNT(*) AS count FROM photos WHERE id=?',
        fixture.photoId
      )][0].count),
      chunks: Number([...storage.exec(
        'SELECT COUNT(*) AS count FROM photo_chunks WHERE photo_id=?',
        fixture.photoId
      )][0].count),
      thumbnail: Number([...storage.exec(
        'SELECT COUNT(*) AS count FROM photo_thumbnails WHERE photo_id=?',
        fixture.photoId
      )][0].count),
      untouched: Number([...storage.exec(
        'SELECT COUNT(*) AS count FROM submissions WHERE id=?',
        fixture.untouchedSubmissionId
      )][0].count)
    }))).toEqual({
      submission: 0,
      photo: 0,
      chunks: 0,
      thumbnail: 0,
      untouched: 1
    });


    await expectText(await request(
      `/api/submissions/${fixture.untouchedSubmissionId}`,
      {
        method: 'DELETE',
        headers: { Cookie: admin }
      }
    ), 403);
    await expectText(await request(
      `/api/submissions/${fixture.untouchedSubmissionId}`,
      {
        method: 'DELETE',
        headers: { Origin: BASE }
      }
    ), 401);
    const framer = await login('framer');
    const forbidden = await request(`/api/submissions/${fixture.untouchedSubmissionId}`, {
      method: 'DELETE',
      headers: { Cookie: framer, Origin: BASE }
    });
    await expectText(forbidden, 403);
    const foreign = await request(`/api/submissions/${fixture.untouchedSubmissionId}`, {
      method: 'DELETE',
      headers: { Cookie: admin, Origin: 'https://foreign.invalid' }
    });
    await expectText(foreign, 403);
    await expectText(await request('/api/submissions/999999', {
      method: 'DELETE',
      headers: { Cookie: admin, Origin: BASE }
    }), 404);
    await expectText(await request('/api/submissions/not-an-id', {
      method: 'DELETE',
      headers: { Cookie: admin, Origin: BASE }
    }), 400);
    await expectText(await request(`/api/submissions/${fixture.untouchedSubmissionId}`, {
      method: 'DELETE',
      headers: { Cookie: admin, Origin: BASE, 'Content-Length': '1' },
      body: 'x'
    }), 400);
    await expectText(await request(
      `/api/submissions/${fixture.untouchedSubmissionId}`,
      {
        method: 'DELETE',
        headers: {
          Cookie: admin,
          Origin: BASE,
          'Content-Length': '0'
        },
        body: 'x'
      }
    ), 400);

    const createTemporary = await request('/api/admin/users', {
      method: 'POST',
      headers: { Cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Temporary Admin',
        email: 'temporary.delete.admin@example.test',
        role: 'admin',
        password: 'Temporary-Delete-Admin-2026!'
      })
    });
    await expectText(createTemporary, 201);
    const temporary = await loginWithCredentials(
      'temporary.delete.admin@example.test',
      'Temporary-Delete-Admin-2026!'
    );
    await expectText(temporary.response, 200);
    const temporaryDelete = await request(`/api/submissions/${fixture.untouchedSubmissionId}`, {
      method: 'DELETE',
      headers: { Cookie: temporary.cookie, Origin: BASE }
    });
    expect(await expectJson(temporaryDelete, 403)).toEqual({
      error: 'Change your temporary password before continuing',
      code: 'password_change_required'
    });
  });

  it('accepts a browser DELETE that carries an empty body stream', async () => {
    const targetId = await sql((storage) => Number([...storage.exec(`
      INSERT INTO submissions (
        worker_id, site_id, work_date, hard_hat, high_visibility_vest,
        safety_boots, eye_protection, fall_protection, ladders_scaffolds_inspected,
        tools_cords_checked, hazards_identified, notes
      ) VALUES (2, 1, '2097-12-29', 1, 1, 1, 1, 1, 1, 1, 1, 'empty body delete')
      RETURNING id
    `)][0].id));
    const admin = await login('admin');
    const emptyBody = new ReadableStream({
      start(controller) {
        controller.close();
      }
    });
    const deleted = await request(`/api/submissions/${targetId}`, {
      method: 'DELETE',
      headers: { Cookie: admin, Origin: BASE },
      body: emptyBody
    });
    await expectText(deleted, 204);
    expect(await sql((storage) => [...storage.exec(
      'SELECT id FROM submissions WHERE id=?',
      targetId
    )].length)).toBe(0);
  });

  it('serializes deletion behind an in-flight upload commit', async () => {
    const targetId = await sql((storage) => Number([...storage.exec(`
      INSERT INTO submissions (
        worker_id, site_id, work_date, hard_hat, high_visibility_vest,
        safety_boots, eye_protection, fall_protection, ladders_scaffolds_inspected,
        tools_cords_checked, hazards_identified, notes
      ) VALUES (2, 1, '2097-12-30', 1, 1, 1, 1, 1, 1, 1, 1, 'delete during upload')
      RETURNING id
    `)][0].id));
    const admin = await login('admin');
    const framer = await login('framer');

    const result = await runInDurableObject(appStub(), async (instance, state) => {
      const images = instance.env.IMAGES;
      let announceInfo;
      let resumeInfo;
      const infoStarted = new Promise((resolve) => {
        announceInfo = resolve;
      });
      const infoGate = new Promise((resolve) => {
        resumeInfo = resolve;
      });
      instance.env.IMAGES = {
        async info(stream) {
          announceInfo();
          await infoGate;
          return images.info(stream);
        },
        input(source) {
          return images.input(source);
        }
      };

      try {
        const uploadPromise = instance.fetch(new Request(
          `${BASE}/api/submissions`,
          {
            method: 'POST',
            headers: { Cookie: framer, Origin: BASE },
            body: form({ workDate: '2097-12-31' }, PNG)
          }
        ));
        await infoStarted;

        const deleteRequest = new Request(
          `${BASE}/api/submissions/${targetId}`,
          {
            method: 'DELETE',
            headers: { Cookie: admin, Origin: BASE }
          }
        );
        const deletePromise = instance.handleDeleteSubmission(
          deleteRequest,
          instance.authenticate(deleteRequest),
          targetId
        );
        await Promise.resolve();
        const targetWhileUploadPending = Number([...state.storage.sql.exec(
          'SELECT COUNT(*) AS count FROM submissions WHERE id=?',
          targetId
        )][0].count);

        resumeInfo();
        const [uploadResponse, deleteResponse] = await Promise.all([
          uploadPromise,
          deletePromise
        ]);
        const uploadedId = (await uploadResponse.json()).submission.id;
        return {
          uploadStatus: uploadResponse.status,
          deleteStatus: deleteResponse.status,
          targetWhileUploadPending,
          targetAfter: Number([...state.storage.sql.exec(
            'SELECT COUNT(*) AS count FROM submissions WHERE id=?',
            targetId
          )][0].count),
          uploadedId,
          uploadedAfter: Number([...state.storage.sql.exec(
            'SELECT COUNT(*) AS count FROM submissions WHERE id=?',
            uploadedId
          )][0].count)
        };
      } finally {
        resumeInfo();
        instance.env.IMAGES = images;
      }
    });

    expect(result).toMatchObject({
      uploadStatus: 201,
      deleteStatus: 204,
      targetWhileUploadPending: 1,
      targetAfter: 0,
      uploadedAfter: 1
    });
    expect(result.uploadedId).not.toBe(targetId);
  });

  it('stores one lazy thumbnail under a race and reports generation failures', async () => {
    const framer = await login('framer');
    const responses = await runInDurableObject(appStub(), async (instance) => {
      const images = instance.env.IMAGES;
      let outputCount = 0;
      let allowOutputs;
      const bothOutputsStarted = new Promise((resolve) => {
        allowOutputs = resolve;
      });
      instance.env.IMAGES = {
        info(source) {
          return images.info(source);
        },
        input(source) {
          const input = images.input(source);
          return {
            transform(options) {
              const transformed = input.transform(options);
              return {
                async output(outputOptions) {
                  outputCount++;
                  if (outputCount === 2) {
                    allowOutputs();
                  }
                  await bothOutputsStarted;
                  return transformed.output(outputOptions);
                }
              };
            }
          };
        }
      };
      try {
        const fetched = await Promise.all([
          instance.fetch(new Request(`${BASE}/api/photos/1/thumbnail`, {
            headers: { Cookie: framer }
          })),
          instance.fetch(new Request(`${BASE}/api/photos/1/thumbnail`, {
            headers: { Cookie: framer }
          }))
        ]);
        return await Promise.all(fetched.map(async (response) => {
          const byteLength = (await response.arrayBuffer()).byteLength;
          return {
            status: response.status,
            contentType: response.headers.get('content-type'),
            contentLength: response.headers.get('content-length'),
            byteLength
          };
        }));
      } finally {
        allowOutputs();
        instance.env.IMAGES = images;
      }
    });
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.contentType).toBe('image/webp');
      expect(response.contentLength).toBe(String(response.byteLength));
      expect(response.byteLength).toBeGreaterThan(0);
    }
    expect(await sql((storage) => Number([...storage.exec(
      'SELECT COUNT(*) AS count FROM photo_thumbnails WHERE photo_id=1'
    )][0].count))).toBe(1);

    await sql((storage) => storage.exec(
      'DELETE FROM photo_thumbnails WHERE photo_id=1'
    ));
    const unavailable = await withFailingImages(
      (instance) => instance.fetch(new Request(`${BASE}/api/photos/1/thumbnail`, {
        headers: { Cookie: framer }
      }))
    );
    expect(await expectJson(unavailable, 500)).toEqual({
      error: 'Thumbnail unavailable'
    });
    expect(await sql((storage) => Number([...storage.exec(
      'SELECT COUNT(*) AS count FROM photo_thumbnails WHERE photo_id=1'
    )][0].count))).toBe(0);
  });

  it('composes Admin filters and retains every site in zero-count summaries', async () => {
    const admin = await login('admin');
    const response = await request(
      '/api/submissions?site_id=2&worker_id=2&date_from=2026-06-02&date_to=2026-06-02',
      { headers: { Cookie: admin } }
    );
    const body = await expectJson(response, 200);
    expect(body.submissions).toHaveLength(1);
    expect(body.submissions[0]).toMatchObject({
      id: 2,
      worker_id: 2,
      site_id: 2,
      work_date: '2026-06-02'
    });
    const countBySite = new Map(body.summary.map(
      (row) => [row.site_id, row.submission_count]
    ));
    expect(countBySite.size).toBe(2);
    expect(countBySite.get(1)).toBe(0);
    expect(countBySite.get(2)).toBe(1);

    const invalid = await request(
      '/api/submissions?date_from=2026-06-03&date_to=2026-06-02',
      { headers: { Cookie: admin } }
    );
    await expectText(invalid, 400);
  });

  it('cleans final and staged rows after file-count and byte-limit failures', async () => {
    const framer = await login('framer');
    const before = await counts();

    const tooMany = form({ workDate: '2099-02-27' });
    for (let index = 0; index < 6; index++) {
      tooMany.append(
        'photos',
        new File([PNG], `photo-${index}.png`, { type: 'image/png' })
      );
    }
    const tooManyResponse = await request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE },
      body: tooMany
    });
    await expectText(tooManyResponse, 413);
    expect(await counts()).toEqual(before);

    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized.set(PNG);
    const oversizedResponse = await request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE },
      body: form({ workDate: '2099-02-28' }, oversized)
    });
    await expectText(oversizedResponse, 413);
    expect(await counts()).toEqual(before);
  });

  it('rejects Unicode, date, field and file failures without creating rows', async () => {
    const framer = await login('framer');
    const before = await counts();
    const boundary = 'ras-malformed-test-boundary';
    const malformed = await request('/api/submissions', {
      method: 'POST',
      headers: {
        Cookie: framer,
        Origin: BASE,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: new Blob([
        `--${boundary}\r\n`,
        'Content-Disposition: form-data; name="photos"; filename="photo.png"\r\n',
        'Content-Type: image/png\r\n\r\n',
        new Uint8Array(1024 * 1024),
        `\r\n--${boundary}\r\n`,
        'not-a-valid-part-header\r\n\r\n'
      ])
    });
    await expectText(malformed, 400);

    const cases = [
      form({ workDate: '2099-03-01' }),
      form({ workDate: '2100-02-29' }, PNG),
      form({ workDate: '2099-03-03', notes: 'é'.repeat(5001) }, PNG),
      form({ workDate: '2099-03-04', hard_hat: '2' }, PNG)
    ];
    const duplicateField = form({ workDate: '2099-03-05' }, PNG);
    duplicateField.delete('hard_hat');
    duplicateField.append('notes', 'second value');
    cases.push(duplicateField);
    const unexpectedField = form({ workDate: '2099-03-06' }, PNG);
    unexpectedField.delete('hard_hat');
    unexpectedField.append('unexpected', 'value');
    cases.push(unexpectedField);

    for (const body of cases) {
      const response = await request('/api/submissions', {
        method: 'POST',
        headers: { Cookie: framer, Origin: BASE },
        body
      });
      await expectText(response, 400);
    }
    const oversizedField = await request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE },
      body: form({
        workDate: '2099-03-10',
        notes: '😀'.repeat(5001)
      }, PNG)
    });
    await expectText(oversizedField, 413);
    expect(await counts()).toEqual(before);

    const invalidImage = await request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE },
      body: form(
        { workDate: '2099-03-07' },
        new TextEncoder().encode('not an image')
      )
    });
    await expectText(invalidImage, 400);
    const mismatchedImage = await request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE },
      body: form({ workDate: '2099-03-09', mimeType: 'image/jpeg' }, PNG)
    });
    await expectText(mismatchedImage, 400);

    const unavailableImages = await withFailingImages(
      (instance) => instance.fetch(new Request(`${BASE}/api/submissions`, {
        method: 'POST',
        headers: { Cookie: framer, Origin: BASE },
        body: form({ workDate: '2099-03-08' }, PNG)
      }))
    );
    await expectText(unavailableImages, 400);
    expect(await counts()).toEqual(before);
  });


  it('commits decoded uploads and original bytes, then rejects duplicates without changes', async () => {
    const framer = await login('framer');
    const before = await counts();
    const options = {
      siteId: '2',
      workDate: '2099-04-01',
      notes: '😀'.repeat(5000),
      fall_protection: '0'
    };
    const created = await request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE },
      body: form(options, PNG)
    });
    const createdBody = await expectJson(created, 201);
    expect(createdBody.submission).toMatchObject({
      worker_id: 2,
      site_id: 2,
      work_date: options.workDate,
      notes: options.notes,
      hard_hat: 1,
      fall_protection: 0
    });
    expect(createdBody.submission.photos).toHaveLength(1);
    expect(createdBody.submission.photos[0]).toMatchObject({
      mime_type: 'image/png',
      size_bytes: PNG.byteLength
    });
    expect(createdBody.submission.photos[0].thumbnail_url).toBe(
      `/api/photos/${createdBody.submission.photos[0].id}/thumbnail`
    );
    const createdPhotoId = createdBody.submission.photos[0].id;
    expect(await sql((storage) => Number([...storage.exec(
      'SELECT COUNT(*) AS count FROM photo_thumbnails WHERE photo_id=?',
      createdPhotoId
    )][0].count))).toBe(1);
    const thumbnail = await request(
      createdBody.submission.photos[0].thumbnail_url,
      { headers: { Cookie: framer } }
    );
    const thumbnailBytes = new Uint8Array(await thumbnail.arrayBuffer());
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/webp');
    expect(thumbnail.headers.get('content-length')).toBe(
      String(thumbnailBytes.byteLength)
    );
    expect(thumbnail.headers.get('cache-control')).toBe('no-store');
    expect(thumbnail.headers.get('x-content-type-options')).toBe('nosniff');
    expect(thumbnailBytes.byteLength).toBeGreaterThan(0);
    expect(thumbnailBytes.byteLength).toBeLessThanOrEqual(1024 * 1024);

    const afterCreate = await counts();
    expect(afterCreate).toEqual({
      submissions: before.submissions + 1,
      photos: before.photos + 1,
      chunks: before.chunks + 1,
      staging: before.staging
    });

    const duplicate = await request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE },
      body: form({ ...options, notes: 'duplicate' }, PNG)
    });
    await expectText(duplicate, 409);
    expect(await counts()).toEqual(afterCreate);

    const photo = await request(createdBody.submission.photos[0].url, {
      headers: { Cookie: framer }
    });
    const original = new Uint8Array(await photo.arrayBuffer());
    expect({ status: photo.status, bodyBytes: original.byteLength })
      .toMatchObject({ status: 200 });
    expect(photo.headers.get('content-type')).toBe('image/png');
    expect(photo.headers.get('content-length')).toBe(String(PNG.byteLength));
    expect(photo.headers.get('cache-control')).toBe('no-store');
    expect(photo.headers.get('x-content-type-options')).toBe('nosniff');
    expect(original).toEqual(PNG);
  });

  it('rolls back the complete SQL transaction when a chunk insert fails', async () => {
    const framer = await login('framer');
    const before = await counts();
    await sql((storage) => storage.exec(`
      CREATE TRIGGER reject_test_chunk
      BEFORE INSERT ON photo_chunks
      BEGIN
        SELECT RAISE(ABORT, 'controlled chunk failure');
      END
    `));

    const response = await request('/api/submissions', {
      method: 'POST',
      headers: { Cookie: framer, Origin: BASE },
      body: form({ workDate: '2099-04-02' }, PNG)
    });
    await expectText(response, 500);
    expect(await counts()).toEqual(before);
  });
});
