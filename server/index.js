import { createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import Busboy from 'busboy';
import { hashPassword, verifyPassword } from './passwords.js';
import schema from './schema.sql';
import demoData from './demo-data.json';

const SESSION_COOKIE = 'ras_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const PHOTO_LIMIT = 10 * 1024 * 1024;
const THUMBNAIL_LIMIT = 1024 * 1024;
const CHUNK_SIZE = 1024 * 1024;
const MAX_PHOTOS = 5;
const MAX_PIXELS = 60_000_000;
const MAX_DIMENSION = 12_000;
const NOTES_MAX_CHARACTERS = 5_000;
const LOGIN_JSON_LIMIT = 8 * 1024;
const PASSWORD_MIN_CODE_POINTS = 12;
const PASSWORD_MAX_CODE_POINTS = 128;
const NAME_MAX_CODE_POINTS = 100;
const KDF_CAPACITY = 2;
const FIELD_BYTE_LIMIT = NOTES_MAX_CHARACTERS * 4 + 1;
const MULTIPART_BYTE_LIMIT = MAX_PHOTOS * PHOTO_LIMIT + 512 * 1024;
const COMMON_YEAR_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const CHECKLIST_FIELDS = [
  'hard_hat', 'high_visibility_vest', 'safety_boots', 'eye_protection',
  'fall_protection', 'ladders_scaffolds_inspected', 'tools_cords_checked',
  'hazards_identified'
];
const SUBMISSION_FIELDS = new Set(['site_id', 'work_date', 'notes', ...CHECKLIST_FIELDS]);
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IP_FAILURE_LIMIT = 20;
const LOGIN_EMAIL_FAILURE_LIMIT = 5;
const LOGIN_TRACKER_LIMIT = 1024;
const LOGIN_VERIFICATION_LIMIT = 2;
const DUMMY_PASSWORD_HASH = demoData.dummy_password_hash;
if (!/^scrypt-v1:[0-9a-f]{32}:[0-9a-f]{128}$/.test(DUMMY_PASSWORD_HASH)) {
  throw new Error('Invalid dummy password hash fixture');
}

function privateHeaders(headers = {}) {
  return new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: privateHeaders({ ...JSON_HEADERS, ...headers })
  });
}
function error(status, message) {
  return json({ error: message }, status);
}
function validId(value) {
  return (
    typeof value === 'string' &&
    /^[1-9]\d*$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}
function validDate(value) {
  if (
    typeof value !== 'string' ||
    /^\d{4}-\d{2}-\d{2}$/.test(value) === false
  ) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 && leap ? 29 : COMMON_YEAR_DAYS[month - 1];
  return day <= daysInMonth;
}
function tooManyCodePoints(value, limit) {
  let count = 0;
  for (const _character of value) {
    if (++count > limit) {
      return true;
    }
  }
  return false;
}
function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    must_change_password: Boolean(Number(user.must_change_password))
  };
}
function publicStaffUser(user) {
  return { ...publicUser(user), created_at: user.created_at };
}
function validEmail(value) {
  if (typeof value !== 'string' || value.length > 254) {
    return false;
  }
  const at = value.indexOf('@');
  if (
    at < 1 ||
    at !== value.lastIndexOf('@') ||
    at > 64 ||
    at === value.length - 1
  ) {
    return false;
  }
  const local = value.slice(0, at);
  if (
    !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  ) {
    return false;
  }
  const labels = value.slice(at + 1).split('.');
  return labels.length >= 2 && labels.every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
  );
}
function validPassword(value) {
  if (typeof value !== 'string') {
    return false;
  }
  let codePoints = 0;
  for (const _character of value) {
    if (++codePoints > PASSWORD_MAX_CODE_POINTS) {
      return false;
    }
  }
  return codePoints >= PASSWORD_MIN_CODE_POINTS;
}
function parseJsonBody(request) {
  return readLimitedText(request, LOGIN_JSON_LIMIT).then((text) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('MALFORMED_JSON');
    }
  });
}
function parseCookies(header) {
  const cookies = Object.create(null);
  if (typeof header !== 'string') {
    return cookies;
  }
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) {
      continue;
    }
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key && value && cookies[key] === undefined) {
      cookies[key] = value;
    }
  }
  return cookies;
}
function cookieHeader(request, token, maxAge = SESSION_TTL_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/api; HttpOnly; SameSite=Strict${secure}`;
}
function originAllowed(request) {
  const origin = request.headers.get('Origin');
  return typeof origin === 'string' && origin === new URL(request.url).origin;
}
function clientAddress(request) {
  return request.headers.get('x-ras-client-ip') || 'unknown';
}
function queryRows(sql, statement, ...params) {
  return [...sql.exec(statement, ...params)];
}
function firstRow(sql, statement, ...params) {
  const result = sql.exec(statement, ...params).next();
  return result.done ? null : result.value;
}

function submissionListRow(row) {
  return {
    id: row.id,
    worker_id: row.worker_id,
    worker_name: row.worker_name,
    site_id: row.site_id,
    site_name: row.site_name,
    work_date: row.work_date,
    created_at: row.created_at,
    status: 'Submitted',
    photo_count: row.photo_count
  };
}
function detailRow(row, photos) {
  return {
    id: row.id,
    worker_id: row.worker_id,
    worker_name: row.worker_name,
    site_id: row.site_id,
    site_name: row.site_name,
    work_date: row.work_date,
    created_at: row.created_at,
    status: 'Submitted',
    hard_hat: row.hard_hat,
    high_visibility_vest: row.high_visibility_vest,
    safety_boots: row.safety_boots,
    eye_protection: row.eye_protection,
    fall_protection: row.fall_protection,
    ladders_scaffolds_inspected: row.ladders_scaffolds_inspected,
    tools_cords_checked: row.tools_cords_checked,
    hazards_identified: row.hazards_identified,
    notes: row.notes,
    photos: photos.map((photo) => ({
      id: photo.id,
      mime_type: photo.mime_type,
      size_bytes: photo.size_bytes,
      url: `/api/photos/${photo.id}`,
      thumbnail_url: `/api/photos/${photo.id}/thumbnail`
    }))
  };
}

function temporaryPasswordError() {
  return json({
    error: 'Change your temporary password before continuing',
    code: 'password_change_required'
  }, 403);
}

class StagingWriter {
  constructor(sql, uploadId, photoIndex) {
    this.sql = sql;
    this.uploadId = uploadId;
    this.photoIndex = photoIndex;
    this.chunkIndex = 0;
    this.buffer = null;
    this.used = 0;
    this.size = 0;
  }

  write(input) {
    if (this.size + input.byteLength > PHOTO_LIMIT) {
      throw new Error('PHOTO_SIZE');
    }
    this.size += input.byteLength;
    let offset = 0;
    while (offset < input.byteLength) {
      if (!this.buffer) this.buffer = new Uint8Array(CHUNK_SIZE);
      const length = Math.min(CHUNK_SIZE - this.used, input.byteLength - offset);
      this.buffer.set(input.subarray(offset, offset + length), this.used);
      this.used += length;
      offset += length;
      if (this.used === CHUNK_SIZE) this.flush(false);
    }
  }

  flush(partial) {
    if (!this.buffer || this.used === 0) {
      return;
    }
    const bytes = partial ? this.buffer.buffer.slice(0, this.used) : this.buffer.buffer;
    this.sql.exec(
      'INSERT INTO upload_staging_chunks (upload_id,photo_index,chunk_index,bytes) VALUES (?,?,?,?)',
      this.uploadId, this.photoIndex, this.chunkIndex++, bytes
    );
    this.buffer = null;
    this.used = 0;
  }

  finish() {
    this.flush(true);
    return this.size;
  }
}

function parseMultipart(request, sql, uploadId) {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MULTIPART_BYTE_LIMIT) {
    throw new Error('REQUEST_SIZE');
  }
  const values = Object.create(null);
  const files = [];
  let parser;
  try {
    parser = Busboy({
      headers: Object.fromEntries(request.headers),
      limits: {
        fileSize: PHOTO_LIMIT + 1,
        files: MAX_PHOTOS,
        fields: SUBMISSION_FIELDS.size,
        // Busboy emits partsLimit when equality is reached, so configure one
        // beyond the 16 allowed parts and enforce field/file counts separately.
        parts: SUBMISSION_FIELDS.size + MAX_PHOTOS + 1,
        fieldSize: FIELD_BYTE_LIMIT
      }
    });
  } catch {
    throw new Error('MULTIPART_MALFORMED');
  }
  if (!request.body) {
    throw new Error('MULTIPART_MALFORMED');
  }

  return new Promise((resolve, reject) => {
    let fatal = null;
    let settled = false;
    let fileCount = 0;
    const source = Readable.fromWeb(request.body);
    let bodyBytes = 0;
    let parserFailed = false;
    const fail = (cause) => {
      if (!fatal) fatal = cause instanceof Error ? cause : new Error(String(cause));
    };
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bodyBytes += chunk.byteLength;
        if (bodyBytes > MULTIPART_BYTE_LIMIT) {
          fail(new Error('REQUEST_SIZE'));
        }
        callback(null, chunk);
      }
    });
    const finish = (cause) => {
      if (settled) {
        return;
      }
      settled = true;
      if (cause) {
        reject(cause);
      } else if (fatal) {
        reject(fatal);
      } else {
        resolve({ values, files });
      }
    };
    const drainSourceThenFinish = (cause) => {
      if (parserFailed) {
        return;
      }
      parserFailed = true;
      source.unpipe(limiter);
      limiter.unpipe(parser);
      limiter.resume();
      source.resume();
      if (source.readableEnded) {
        finish(cause);
      } else {
        source.once('end', () => finish(cause));
      }
    };

    parser.on('field', (name, value, info) => {
      if (fatal) {
        return;
      }
      if (info.nameTruncated || info.valueTruncated) {
        fail(new Error('REQUEST_SIZE'));
      } else if (!SUBMISSION_FIELDS.has(name) || values[name] !== undefined) {
        fail(new Error('UNEXPECTED_FIELD'));
      } else {
        values[name] = value;
      }
    });
    parser.on('file', (name, stream, info) => {
      const photoIndex = fileCount++;
      if (fatal || name !== 'photos') {
        if (!fatal) {
          fail(new Error('UNEXPECTED_FIELD'));
        }
        stream.resume();
        return;
      }
      const mimeType = String(info.mimeType || '').toLowerCase();
      if (!MIME_TYPES.has(mimeType)) {
        fail(new Error('PHOTO_TYPE'));
        stream.resume();
        return;
      }
      const writer = new StagingWriter(sql, uploadId, photoIndex);
      stream.on('limit', () => fail(new Error('PHOTO_SIZE')));
      stream.on('data', (chunk) => {
        if (fatal) {
          return;
        }
        try {
          writer.write(chunk);
        } catch (cause) {
          fail(cause);
        }
      });
      stream.on('error', () => fail(new Error('MULTIPART_MALFORMED')));
      stream.on('end', () => {
        if (fatal) {
          return;
        }
        try {
          const sizeBytes = writer.finish();
          if (sizeBytes < 1) {
            fail(new Error('PHOTO_EMPTY'));
          } else {
            files[photoIndex] = { photoIndex, mimeType, sizeBytes };
          }
        } catch (cause) {
          fail(cause);
        }
      });
    });
    parser.on('filesLimit', () => fail(new Error('REQUEST_SIZE')));
    parser.on('fieldsLimit', () => fail(new Error('REQUEST_SIZE')));
    parser.on('partsLimit', () => fail(new Error('REQUEST_SIZE')));
    parser.on('error', () => {
      drainSourceThenFinish(new Error('MULTIPART_MALFORMED'));
    });
    parser.on('close', () => {
      if (!parserFailed) {
        finish();
      }
    });
    source.on('error', () => {
      parserFailed = true;
      limiter.destroy();
      parser.destroy();
      finish(new Error('MULTIPART_MALFORMED'));
    });
    limiter.on('error', () => {
      drainSourceThenFinish(new Error('MULTIPART_MALFORMED'));
    });
    source.pipe(limiter).pipe(parser);
  });
}

function stagedPhotoStream(sql, uploadId, photoIndex) {
  const cursor = sql.exec(
    'SELECT bytes FROM upload_staging_chunks WHERE upload_id=? AND photo_index=? ORDER BY chunk_index',
    uploadId, photoIndex
  );
  let done = false;
  return new ReadableStream({
    pull(controller) {
      if (done) {
        return;
      }
      const next = cursor.next();
      if (next.done) {
        done = true;
        controller.close();
      } else {
        controller.enqueue(new Uint8Array(next.value.bytes));
      }
    },
    cancel() {
      done = true;
    }
  });
}


function storedPhotoStream(sql, photoId) {
  const cursor = sql.exec(
    'SELECT bytes FROM photo_chunks WHERE photo_id=? ORDER BY chunk_index',
    photoId
  );
  let done = false;
  return new ReadableStream({
    pull(controller) {
      if (done) {
        return;
      }
      const next = cursor.next();
      if (next.done) {
        done = true;
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(next.value.bytes));
    },
    cancel() {
      done = true;
    }
  });
}

async function createThumbnail(images, source) {
  const output = await images
    .input(source)
    .transform({ width: 480, height: 480, fit: 'scale-down' })
    .output({ format: 'image/webp', quality: 80 });
  const response = output.response();
  if (!response.ok || !response.body) {
    throw new Error('PHOTO_INVALID');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > THUMBNAIL_LIMIT) {
        try {
          await reader.cancel();
        } catch {
          // The size failure below is the response that matters.
        }
        throw new Error('PHOTO_INVALID');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength < 1) {
    throw new Error('PHOTO_INVALID');
  }
  return bytes;
}
async function readLimitedText(request, limit) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error('REQUEST_SIZE');
  }
  if (!request.body) {
    return '';
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        throw new Error('REQUEST_SIZE');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A disturbed stream may already have released its reader.
    }
  }
}

async function drainUnreadRequestBody(request) {
  const body = request.body;
  if (!body || body.locked) {
    return;
  }
  const reader = body.getReader();
  try {
    while (!(await reader.read()).done) {
      // Drain incrementally so a forwarded response cannot overtake its body.
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // A disconnected or already-disturbed request has nothing left to drain.
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A disturbed stream may already have released its reader.
    }
  }
}

// Browsers can deliver an empty body stream on DELETE, so check for actual bytes.
// Reads at most one chunk, so a large body is never consumed.
async function deleteRequestHasBody(request) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && !/^0+$/.test(declared)) {
    return true;
  }
  if (!request.body || request.body.locked) {
    return false;
  }
  const reader = request.body.getReader();
  try {
    const { done } = await reader.read();
    if (!done) {
      await reader.cancel();
    }
    return !done;
  } catch {
    return true;
  } finally {
    reader.releaseLock();
  }
}

async function cancelUnreadRequestBody(request) {
  if (!request.body || request.body.locked) {
    return;
  }
  try {
    await request.body.cancel();
  } catch {
    // A disconnected or already-disturbed request has nothing left to cancel.
  }
}

export class SafetyApp {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.loginAttempts = new Map();
    this.activeLoginVerifications = 0;
    this.activeKdfOperations = 0;
    this.submissionMutationQueue = Promise.resolve();
    this.pendingUploads = 0;
    state.blockConcurrencyWhile(async () => {
      const sql = state.storage.sql;
      sql.exec(schema);
      this.migrateSchema(sql);

      const hasBootstrapMarker = Boolean(
        firstRow(sql, "SELECT 1 FROM app_metadata WHERE key='bootstrap_complete'")
      );
      const needsBootstrap = !hasBootstrapMarker && Number(
        firstRow(sql, 'SELECT COUNT(*) AS count FROM users')?.count ?? 0
      ) === 0;
      let passwordHashes;
      if (needsBootstrap) {
        const passwords = {
          admin: this.env.ADMIN_INITIAL_PASSWORD,
          framer: this.env.FRAMER_INITIAL_PASSWORD
        };
        if (!validPassword(passwords.admin) || !validPassword(passwords.framer)) {
          throw new Error(
            'Set ADMIN_INITIAL_PASSWORD and FRAMER_INITIAL_PASSWORD before first start'
          );
        }
        const [adminHash, framerHash] = await Promise.all([
          hashPassword(passwords.admin),
          hashPassword(passwords.framer)
        ]);
        passwordHashes = { admin: adminHash, framer: framerHash };
      }

      state.storage.transactionSync(() => {
        if (firstRow(sql, "SELECT 1 FROM app_metadata WHERE key='bootstrap_complete'")) {
          return;
        }
        const count = firstRow(sql, 'SELECT COUNT(*) AS count FROM users');
        if (Number(count?.count ?? 0) === 0) {
          if (!Array.isArray(demoData?.users) || !Array.isArray(demoData?.sites)) {
            throw new Error('Invalid bootstrap data');
          }
          this.bootstrap(passwordHashes);
        }
        sql.exec("INSERT INTO app_metadata (key,value) VALUES ('bootstrap_complete','1')");
      });
      // A new object instance cannot overlap the abandoned request that created these rows.
      sql.exec('DELETE FROM upload_staging_chunks');
    });
  }
  migrateSchema(sql) {
    const columns = queryRows(sql, 'PRAGMA table_info(users)');
    if (!columns.some((column) => column.name === 'must_change_password')) {
      sql.exec(
        `ALTER TABLE users
         ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
         CHECK (must_change_password IN (0, 1))`
      );
    }
    sql.exec(
      "INSERT INTO app_metadata (key,value) VALUES ('schema_version','3') " +
      "ON CONFLICT(key) DO UPDATE SET value='3'"
    );
  }

  async withSubmissionMutationLock(operation) {
    const previous = this.submissionMutationQueue;
    let release;
    this.submissionMutationQueue = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await operation();
    } finally {
      release();
    }
  }

  async withUploadLock(operation) {
    if (this.pendingUploads >= 3) {
      return error(503, 'Uploads are busy. Try again shortly.');
    }
    this.pendingUploads++;
    try {
      return await this.withSubmissionMutationLock(operation);
    } finally {
      this.pendingUploads--;
    }
  }

  bootstrap(passwordHashes) {
    const sql = this.state.storage.sql;
    for (const user of demoData.users) {
      sql.exec(
        'INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
        user.id,
        user.email,
        user.name,
        passwordHashes[user.role],
        user.role,
        user.created_at || new Date().toISOString()
      );
    }
    for (const site of demoData.sites) {
      sql.exec('INSERT INTO sites (id,name) VALUES (?,?)', site.id, site.name);
    }
    for (const submission of demoData.submissions || []) {
      sql.exec(
        `INSERT INTO submissions (
           id,worker_id,site_id,work_date,hard_hat,high_visibility_vest,
           safety_boots,eye_protection,fall_protection,ladders_scaffolds_inspected,
           tools_cords_checked,hazards_identified,notes,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        submission.id,
        submission.worker_id,
        submission.site_id,
        submission.work_date,
        submission.hard_hat,
        submission.high_visibility_vest,
        submission.safety_boots,
        submission.eye_protection,
        submission.fall_protection,
        submission.ladders_scaffolds_inspected,
        submission.tools_cords_checked,
        submission.hazards_identified,
        submission.notes,
        submission.created_at || new Date().toISOString()
      );
    }
    for (const photo of demoData.photos || []) {
      sql.exec(
        'INSERT INTO photos (id,submission_id,mime_type,size_bytes) VALUES (?,?,?,?)',
        photo.id,
        photo.submission_id,
        photo.mime_type,
        photo.size_bytes
      );
      let sizeBytes = 0;
      for (let index = 0; index < (photo.chunks || []).length; index++) {
        const binary = atob(photo.chunks[index]);
        const bytes = new Uint8Array(binary.length);
        for (let offset = 0; offset < binary.length; offset++) {
          bytes[offset] = binary.charCodeAt(offset);
        }
        sizeBytes += bytes.byteLength;
        sql.exec(
          'INSERT INTO photo_chunks (photo_id,chunk_index,bytes) VALUES (?,?,?)',
          photo.id,
          index,
          bytes.buffer
        );
      }
      if (sizeBytes !== photo.size_bytes) {
        throw new Error('Invalid bootstrap photo size');
      }
    }
  }

  reserveLogin(request, now, email = null) {
    for (const [key, entry] of this.loginAttempts) {
      const expired = entry.lastFailure + LOGIN_WINDOW_MS <= now;
      if (entry.inFlight === 0 && (!entry.failures || expired)) {
        this.loginAttempts.delete(key);
      }
    }
    if (
      this.activeKdfOperations >= KDF_CAPACITY ||
      this.activeLoginVerifications >= LOGIN_VERIFICATION_LIMIT
    ) {
      return null;
    }

    const ipKey = `ip:${createHash('sha256').update(clientAddress(request)).digest('hex')}`;
    const keys = [ipKey];
    if (email) {
      keys.push(`email:${createHash('sha256').update(email).digest('hex')}`);
    }
    const limits = [LOGIN_IP_FAILURE_LIMIT, LOGIN_EMAIL_FAILURE_LIMIT];
    const entries = keys.map((key, index) => {
      const entry = this.loginAttempts.get(key);
      if (entry && entry.lastFailure + LOGIN_WINDOW_MS <= now) {
        entry.failures = 0;
        entry.lastFailure = 0;
      }
      return { key, entry, limit: limits[index] };
    });

    if (entries.some(({ entry, limit }) =>
      entry && entry.failures + entry.inFlight >= limit
    )) {
      return null;
    }

    const selectedKeys = new Set(keys);
    const missingEntries = entries.filter(({ entry }) => !entry).length;
    while (this.loginAttempts.size + missingEntries > LOGIN_TRACKER_LIMIT) {
      let removableKey = null;
      for (const [key, entry] of this.loginAttempts) {
        if (!selectedKeys.has(key) && entry.inFlight === 0) {
          removableKey = key;
          break;
        }
      }
      if (removableKey === null) {
        return null;
      }
      this.loginAttempts.delete(removableKey);
    }

    for (const item of entries) {
      if (!item.entry) {
        item.entry = { failures: 0, lastFailure: 0, inFlight: 0 };
        this.loginAttempts.set(item.key, item.entry);
      }
      item.entry.inFlight++;
    }
    this.activeLoginVerifications++;
    this.activeKdfOperations++;
    return {
      entries: entries.map(({ key, entry }) => ({ key, entry })),
      emailKey: email ? keys[1] : null
    };
  }

  finishLogin(reservation, outcome, now) {
    this.activeLoginVerifications--;
    this.activeKdfOperations--;
    for (const { key, entry } of reservation.entries) {
      entry.inFlight--;
      if (outcome === 'failure') {
        entry.failures++;
        entry.lastFailure = now;
      }
      if (outcome === 'success' && key === reservation.emailKey) {
        entry.failures = 0;
        entry.lastFailure = 0;
      }
      if (entry.inFlight === 0 && entry.failures === 0) {
        this.loginAttempts.delete(key);
      } else {
        this.loginAttempts.delete(key);
        this.loginAttempts.set(key, entry);
      }
    }
  }
  reserveKdf() {
    if (this.activeKdfOperations >= KDF_CAPACITY) {
      return false;
    }
    this.activeKdfOperations++;
    return true;
  }
  releaseKdf() {
    this.activeKdfOperations--;
  }

  authenticate(request) {
    const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return null;
    }
    const hash = tokenHash(token);
    const row = firstRow(
      this.state.storage.sql,
      `SELECT s.expires_at,u.id,u.email,u.name,u.role,u.must_change_password
       FROM sessions s
       JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=?`,
      hash
    );
    const now = Math.floor(Date.now() / 1000);
    const invalidSession = (
      !row ||
      row.expires_at <= now ||
      row.expires_at > now + SESSION_TTL_SECONDS ||
      (row.role !== 'framer' && row.role !== 'admin')
    );
    if (invalidSession) {
      this.state.storage.sql.exec('DELETE FROM sessions WHERE token_hash=?', hash);
      return null;
    }
    return publicUser(row);
  }

  async handleLogin(request) {
    const contentType = request.headers.get('Content-Type')
      ?.split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      return error(400, 'Email and password are required');
    }
    let body;
    try {
      body = JSON.parse(await readLimitedText(request, LOGIN_JSON_LIMIT));
    } catch (cause) {
      if (cause?.message === 'REQUEST_SIZE') {
        return error(413, 'Request is too large');
      }
      return error(400, 'Malformed JSON request');
    }
    if (
      !body ||
      typeof body.email !== 'string' ||
      typeof body.password !== 'string'
    ) {
      return error(400, 'Email and password are required');
    }
    const email = body.email.trim().toLowerCase();
    if (!email || email.length > 320 || body.password.length > 4096) {
      return error(400, 'Email and password are required');
    }
    const now = Math.floor(Date.now() / 1000);
    this.state.storage.sql.exec(
      'DELETE FROM sessions WHERE expires_at<=? OR expires_at>?',
      now,
      now + SESSION_TTL_SECONDS
    );
    const reservation = this.reserveLogin(request, Date.now(), email);
    if (!reservation) {
      return error(429, 'Too many login attempts');
    }
    let accepted = false;
    let user = null;
    let completed = false;
    try {
      user = firstRow(
        this.state.storage.sql,
        `SELECT id,email,name,role,must_change_password,password_hash
         FROM users WHERE email=?`,
        email
      );
      let valid = false;
      try {
        valid = await verifyPassword(
          body.password,
          user?.password_hash ?? DUMMY_PASSWORD_HASH
        );
      } catch {
        valid = false;
      }
      if (user && valid) {
        const current = firstRow(
          this.state.storage.sql,
          'SELECT id,email,name,role,must_change_password FROM users WHERE id=? AND password_hash=?',
          user.id,
          user.password_hash
        );
        valid = Boolean(current && (current.role === 'framer' || current.role === 'admin'));
        if (valid) {
          user = current;
        }
      }
      accepted = Boolean(user && valid && (user.role === 'framer' || user.role === 'admin'));
      completed = true;
    } finally {
      const outcome = !completed ? 'neutral' : accepted ? 'success' : 'failure';
      this.finishLogin(reservation, outcome, Date.now());
    }
    if (!accepted) {
      return error(401, 'Invalid email or password');
    }
    const token = randomBytes(32).toString('base64url');
    const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        'INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)',
        tokenHash(token),
        user.id,
        expires
      );
      this.state.storage.sql.exec(
        `DELETE FROM sessions
         WHERE user_id=?
           AND token_hash NOT IN (
             SELECT token_hash FROM sessions
             WHERE user_id=? ORDER BY expires_at DESC, rowid DESC LIMIT 5
           )`,
        user.id,
        user.id
      );
    });
    return json({ user: publicUser(user) }, 200, { 'Set-Cookie': cookieHeader(request, token) });
  }

  async parseJsonRequest(request) {
    const contentType = request.headers.get('Content-Type')
      ?.split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      throw new Error('MALFORMED_JSON');
    }
    try {
      return await parseJsonBody(request);
    } catch (cause) {
      if (cause?.message === 'REQUEST_SIZE') {
        throw cause;
      }
      throw new Error('MALFORMED_JSON');
    }
  }
  async handleAdminUsers(request, user) {
    const sql = this.state.storage.sql;
    if (request.method === 'GET') {
      if (user.role !== 'admin') {
        return error(403, 'Forbidden');
      }
      const users = queryRows(
        sql,
        `SELECT id,email,name,role,must_change_password,created_at
         FROM users ORDER BY name COLLATE NOCASE`
      ).map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        must_change_password: Boolean(Number(row.must_change_password)),
        created_at: row.created_at
      }));
      return json({ users });
    }
    if (user.role !== 'admin') {
      return error(403, 'Forbidden');
    }

    let body;
    try {
      body = await this.parseJsonRequest(request);
    } catch (cause) {
      const tooLarge = cause?.message === 'REQUEST_SIZE';
      return error(
        tooLarge ? 413 : 400,
        tooLarge ? 'Request is too large' : 'Malformed JSON request'
      );
    }
    if (
      !body ||
      typeof body.name !== 'string' ||
      typeof body.email !== 'string' ||
      !validEmail(body.email.trim().toLowerCase()) ||
      !validPassword(body.password) ||
      (body.role !== 'framer' && body.role !== 'admin')
    ) {
      return error(400, 'Invalid account details');
    }
    const name = body.name.trim();
    const email = body.email.trim().toLowerCase();
    if (!name || tooManyCodePoints(name, NAME_MAX_CODE_POINTS)) {
      return error(400, 'Invalid account details');
    }
    if (firstRow(sql, 'SELECT 1 FROM users WHERE email=?', email)) {
      return error(409, 'An account with that email already exists');
    }
    if (!this.reserveKdf()) {
      return error(429, 'Password service is busy');
    }

    let passwordHash;
    try {
      passwordHash = await hashPassword(body.password);
    } catch {
      return error(500, 'Unable to save account');
    } finally {
      this.releaseKdf();
    }
    const actor = this.authenticate(request);
    if (!actor) {
      return error(401, 'Authentication required');
    }
    const temporaryError = this.handleTemporaryPassword(actor);
    if (temporaryError) {
      return temporaryError;
    }
    if (actor.role !== 'admin') {
      return error(403, 'Forbidden');
    }

    try {
      let created;
      this.state.storage.transactionSync(() => {
        created = firstRow(
          sql,
          `INSERT INTO users (
             name,email,role,password_hash,must_change_password
           ) VALUES (?,?,?,?,1)
           RETURNING id,email,name,role,must_change_password,created_at`,
          name,
          email,
          body.role,
          passwordHash
        );
      });
      return json({ user: publicStaffUser(created) }, 201);
    } catch (cause) {
      if (String(cause?.message).includes('UNIQUE')) {
        return error(409, 'An account with that email already exists');
      }
      return error(500, 'Unable to save account');
    }
  }
  async handleAdminPasswordReset(request, user, targetId) {
    if (user.role !== 'admin') {
      return error(403, 'Forbidden');
    }
    if (!validId(targetId)) {
      return error(400, 'Invalid user id');
    }

    let body;
    try {
      body = await this.parseJsonRequest(request);
    } catch (cause) {
      const tooLarge = cause?.message === 'REQUEST_SIZE';
      return error(
        tooLarge ? 413 : 400,
        tooLarge ? 'Request is too large' : 'Malformed JSON request'
      );
    }
    if (!body || !validPassword(body.password)) {
      return error(400, 'Password must be 12 to 128 characters');
    }

    const sql = this.state.storage.sql;
    const target = firstRow(
      sql,
      `SELECT id,email,name,role,password_hash,created_at
       FROM users WHERE id=?`,
      Number(targetId)
    );
    if (!target) {
      return error(404, 'User not found');
    }
    if (target.id === user.id) {
      return error(400, 'Use self-service password change');
    }
    if (!this.reserveKdf()) {
      return error(429, 'Password service is busy');
    }

    let passwordHash;
    try {
      passwordHash = await hashPassword(body.password);
    } catch {
      return error(500, 'Unable to reset password');
    } finally {
      this.releaseKdf();
    }
    const actor = this.authenticate(request);
    if (!actor) {
      return error(401, 'Authentication required');
    }
    const temporaryError = this.handleTemporaryPassword(actor);
    if (temporaryError) {
      return temporaryError;
    }
    if (actor.role !== 'admin') {
      return error(403, 'Forbidden');
    }

    try {
      let changed;
      this.state.storage.transactionSync(() => {
        changed = firstRow(
          sql,
          `UPDATE users
           SET password_hash=?,must_change_password=1
           WHERE id=? AND password_hash=?
           RETURNING id,email,name,role,must_change_password,created_at`,
          passwordHash,
          target.id,
          target.password_hash
        );
        if (!changed) {
          if (firstRow(sql, 'SELECT 1 FROM users WHERE id=?', target.id)) {
            throw new Error('PASSWORD_CHANGED');
          }
          throw new Error('USER_NOT_FOUND');
        }
        sql.exec('DELETE FROM sessions WHERE user_id=?', target.id);
      });
      return json({ user: publicStaffUser(changed) });
    } catch (cause) {
      if (cause?.message === 'USER_NOT_FOUND') {
        return error(404, 'User not found');
      }
      if (cause?.message === 'PASSWORD_CHANGED') {
        return error(409, 'Password was changed by another request. Try again.');
      }
      return error(500, 'Unable to reset password');
    }
  }
  async handleAccountPassword(request, user) {
    let body;
    try {
      body = await this.parseJsonRequest(request);
    } catch (cause) {
      const tooLarge = cause?.message === 'REQUEST_SIZE';
      return error(
        tooLarge ? 413 : 400,
        tooLarge ? 'Request is too large' : 'Malformed JSON request'
      );
    }
    if (
      !body ||
      typeof body.current_password !== 'string' ||
      typeof body.new_password !== 'string'
    ) {
      return error(400, 'Current and new passwords are required');
    }
    if (!validPassword(body.new_password)) {
      return error(400, 'Password must be 12 to 128 characters');
    }

    const reservation = this.reserveLogin(request, Date.now(), user.email);
    if (!reservation) {
      return error(429, 'Too many login attempts');
    }
    let completed = false;
    let accepted = false;
    try {
      const current = this.state.storage.sql.exec(
        'SELECT id,password_hash FROM users WHERE id=?',
        user.id
      ).next();
      const row = current.done ? null : current.value;
      let valid = false;
      try {
        valid = Boolean(
          row && await verifyPassword(body.current_password, row.password_hash)
        );
      } catch {
        valid = false;
      }
      if (!valid) {
        completed = true;
        return error(400, 'Current password is incorrect');
      }
      if (body.current_password === body.new_password) {
        accepted = true;
        completed = true;
        return error(400, 'New password must differ from current password');
      }

      const currentHash = row.password_hash;
      const newHash = await hashPassword(body.new_password);
      let changed = false;
      try {
        this.state.storage.transactionSync(() => {
          const token = parseCookies(
            request.headers.get('Cookie')
          )[SESSION_COOKIE];
          const sessionHash = token && /^[A-Za-z0-9_-]{43}$/.test(token)
            ? tokenHash(token)
            : '';
          const latest = firstRow(
            this.state.storage.sql,
            `SELECT s.expires_at,u.id,u.role,u.password_hash
             FROM sessions s
             JOIN users u ON u.id=s.user_id
             WHERE s.token_hash=?`,
            sessionHash
          );
          const now = Math.floor(Date.now() / 1000);
          const sessionIsCurrent = (
            latest &&
            latest.id === user.id &&
            latest.expires_at > now &&
            latest.expires_at <= now + SESSION_TTL_SECONDS &&
            latest.password_hash === currentHash &&
            (latest.role === 'framer' || latest.role === 'admin')
          );
          if (!sessionIsCurrent) {
            throw new Error('STALE_AUTH');
          }
          this.state.storage.sql.exec(
            `UPDATE users
             SET password_hash=?,must_change_password=0
             WHERE id=?`,
            newHash,
            user.id
          );
          this.state.storage.sql.exec(
            'DELETE FROM sessions WHERE user_id=?',
            user.id
          );
          changed = true;
        });
      } catch (cause) {
        if (cause?.message === 'STALE_AUTH') {
          return error(401, 'Authentication required');
        }
        return error(500, 'Unable to change password');
      }
      accepted = changed;
      completed = true;
      if (!changed) {
        return error(401, 'Authentication required');
      }
      return new Response(null, {
        status: 204,
        headers: privateHeaders({
          'Set-Cookie': cookieHeader(request, '', 0)
        })
      });
    } finally {
      const outcome = !completed ? 'neutral' : accepted ? 'success' : 'failure';
      this.finishLogin(reservation, outcome, Date.now());
    }
  }

  getLimit(name, fallback) {
    const value = Number(this.env[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  submissionLimitCheck(user, declaredLength) {
    const sql = this.state.storage.sql;
    const userQuota = this.getLimit('USER_PHOTO_QUOTA_BYTES', 200 * 1024 * 1024);
    const appQuota = this.getLimit('APP_PHOTO_QUOTA_BYTES', 800 * 1024 * 1024);
    const dailyLimit = this.getLimit('DAILY_SUBMISSION_LIMIT', 20);
    const userBytes = Number(firstRow(
      sql,
      `SELECT COALESCE(SUM(p.size_bytes),0) AS bytes
       FROM photos p
       JOIN submissions s ON s.id=p.submission_id
       WHERE s.worker_id=?`,
      user.id
    )?.bytes);
    const appBytes = Number(firstRow(
      sql,
      'SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM photos'
    )?.bytes);
    if (
      userBytes + declaredLength > userQuota ||
      appBytes + declaredLength > appQuota
    ) {
      return error(413, 'Photo storage limit reached');
    }
    const daily = Number(firstRow(
      sql,
      "SELECT COUNT(*) AS count FROM submissions WHERE worker_id=? AND created_at >= datetime('now','-24 hours')",
      user.id
    )?.count);
    if (daily >= dailyLimit) {
      return error(429, 'Daily submission limit reached. Try again tomorrow.');
    }
    return null;
  }

  handleTemporaryPassword(user) {
    return user.must_change_password ? temporaryPasswordError() : null;
  }
  async handleSubmission(request, user) {
    const sql = this.state.storage.sql;
    const declaredLength = Number(request.headers.get('Content-Length'));
    const limitError = this.submissionLimitCheck(
      user,
      Number.isFinite(declaredLength) ? declaredLength : 0
    );
    if (limitError) {
      return limitError;
    }
    const uploadId = randomBytes(32).toString('base64url');

    try {
      let values;
      let files;
      try {
        ({ values, files } = await parseMultipart(request, sql, uploadId));
      } catch (cause) {
        const code = cause?.message;
        if (code === 'UNEXPECTED_FIELD') {
          return error(400, 'Unexpected submission field');
        }
        if (code === 'REQUEST_SIZE') {
          return error(413, 'Request is too large');
        }
        if (code === 'PHOTO_EMPTY') {
          return error(400, 'Photo must not be empty');
        }
        if (code === 'PHOTO_SIZE') {
          return error(413, 'Photo must not exceed 10 MiB');
        }
        if (code === 'PHOTO_TYPE') {
          return error(400, 'Photo content and declared type do not match');
        }
        if (code === 'MULTIPART_MALFORMED') {
          return error(400, 'Malformed multipart request');
        }
        return error(500, 'Unable to save submission');
      }
      if (!validId(values.site_id) || !validDate(values.work_date)) {
        return error(400, 'A valid site and work date are required');
      }
      if (
        typeof values.notes !== 'string' ||
        tooManyCodePoints(values.notes, NOTES_MAX_CHARACTERS)
      ) {
        return error(400, 'Notes must be at most 5000 characters');
      }
      for (const field of CHECKLIST_FIELDS) {
        if (values[field] !== '0' && values[field] !== '1') {
          return error(400, 'All checklist answers are required');
        }
      }
      if (files.length < 1) {
        return error(400, 'At least one photo is required');
      }
      const siteId = Number(values.site_id);
      if (!firstRow(sql, 'SELECT 1 FROM sites WHERE id=?', siteId)) {
        return error(400, 'Site not found');
      }
      const duplicate = firstRow(
        sql,
        `SELECT 1 FROM submissions
         WHERE worker_id=? AND site_id=? AND work_date=?`,
        user.id,
        siteId,
        values.work_date
      );
      if (duplicate) {
        return error(409, 'A submission already exists for this worker, site, and date');
      }

      const verified = [];
      try {
        for (const file of files) {
          if (!this.env.IMAGES) {
            throw new Error('PHOTO_INVALID');
          }
          const info = await this.env.IMAGES.info(
            stagedPhotoStream(sql, uploadId, file.photoIndex)
          );
          const actual = String(info?.format || '').toLowerCase();
          if (!MIME_TYPES.has(actual) || actual !== file.mimeType) {
            throw new Error('PHOTO_TYPE');
          }
          const decodedSize = Number(info?.fileSize);
          if (!Number.isSafeInteger(decodedSize) || decodedSize !== file.sizeBytes) {
            throw new Error('PHOTO_INVALID');
          }
          const width = Number(info?.width);
          const height = Number(info?.height);
          if (
            !Number.isSafeInteger(width) ||
            width < 1 ||
            !Number.isSafeInteger(height) ||
            height < 1
          ) {
            throw new Error('PHOTO_PIXELS');
          }
          if (
            file.mimeType !== 'image/webp' &&
            (width > MAX_DIMENSION || height > MAX_DIMENSION)
          ) {
            throw new Error('PHOTO_DIMENSIONS');
          }
          if (width > MAX_PIXELS / height) {
            throw new Error('PHOTO_PIXELS');
          }
          const thumbnailBytes = await createThumbnail(
            this.env.IMAGES,
            stagedPhotoStream(sql, uploadId, file.photoIndex)
          );
          verified.push({ ...file, thumbnailBytes });
        }
      } catch (cause) {
        const code = cause?.message;
        if (code === 'PHOTO_PIXELS') {
          return error(400, 'Photo exceeds the 60 megapixel limit');
        }
        if (code === 'PHOTO_DIMENSIONS') {
          return error(400, 'JPEG and PNG dimensions must not exceed 12000 pixels');
        }
        if (code === 'PHOTO_TYPE') {
          return error(400, 'Photo content and declared type do not match');
        }
        return error(400, 'Photo is not a valid JPEG, PNG, or WebP image');
      }

      const currentUser = this.authenticate(request);
      if (!currentUser) {
        return error(401, 'Authentication required');
      }
      const temporaryError = this.handleTemporaryPassword(currentUser);
      if (temporaryError) {
        return temporaryError;
      }
      if (currentUser.role !== 'framer') {
        return error(403, 'Forbidden');
      }
      try {
        let submission;
        this.state.storage.transactionSync(() => {
          const userQuota = this.getLimit('USER_PHOTO_QUOTA_BYTES', 200 * 1024 * 1024);
          const appQuota = this.getLimit('APP_PHOTO_QUOTA_BYTES', 800 * 1024 * 1024);
          const dailyLimit = this.getLimit('DAILY_SUBMISSION_LIMIT', 20);
          const userBytes = Number(firstRow(
            sql,
            `SELECT COALESCE(SUM(p.size_bytes),0) AS bytes
             FROM photos p
             JOIN submissions s ON s.id=p.submission_id
             WHERE s.worker_id=?`,
            currentUser.id
          )?.bytes);
          const appBytes = Number(firstRow(
            sql,
            'SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM photos'
          )?.bytes);
          const daily = Number(firstRow(
            sql,
            "SELECT COUNT(*) AS count FROM submissions WHERE worker_id=? AND created_at >= datetime('now','-24 hours')",
            currentUser.id
          )?.count);
          const uploadBytes = verified.reduce(
            (sum, photo) => sum + photo.sizeBytes,
            0
          );
          if (
            userBytes + uploadBytes > userQuota ||
            appBytes + uploadBytes > appQuota
          ) {
            throw new Error('PHOTO_QUOTA');
          }
          if (daily >= dailyLimit) {
            throw new Error('DAILY_LIMIT');
          }
          const result = firstRow(
            sql,
            `INSERT INTO submissions (
               worker_id,site_id,work_date,hard_hat,high_visibility_vest,
               safety_boots,eye_protection,fall_protection,
               ladders_scaffolds_inspected,tools_cords_checked,
               hazards_identified,notes
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
            currentUser.id,
            siteId,
            values.work_date,
            Number(values.hard_hat),
            Number(values.high_visibility_vest),
            Number(values.safety_boots),
            Number(values.eye_protection),
            Number(values.fall_protection),
            Number(values.ladders_scaffolds_inspected),
            Number(values.tools_cords_checked),
            Number(values.hazards_identified),
            values.notes
          );
          const submissionId = Number(result.id);
          for (const photo of verified) {
            const inserted = firstRow(
              sql,
              `INSERT INTO photos (submission_id,mime_type,size_bytes)
               VALUES (?,?,?) RETURNING id`,
              submissionId,
              photo.mimeType,
              photo.sizeBytes
            );
            const photoId = Number(inserted.id);
            sql.exec(
              `INSERT INTO photo_chunks (photo_id,chunk_index,bytes)
               SELECT ?,chunk_index,bytes FROM upload_staging_chunks
               WHERE upload_id=? AND photo_index=? ORDER BY chunk_index`,
              photoId, uploadId, photo.photoIndex
            );
            const integrity = firstRow(
              sql,
              `SELECT COUNT(*) AS chunks,
                      COALESCE(SUM(length(bytes)),0) AS size
               FROM photo_chunks WHERE photo_id=?`,
              photoId
            );
            if (
              Number(integrity?.chunks) !== Math.ceil(photo.sizeBytes / CHUNK_SIZE) ||
              Number(integrity?.size) !== photo.sizeBytes
            ) {
              throw new Error('staged photo unavailable');
            }
            sql.exec(
              'INSERT INTO photo_thumbnails (photo_id,bytes) VALUES (?,?)',
              photoId,
              photo.thumbnailBytes.buffer
            );
          }
          sql.exec('DELETE FROM upload_staging_chunks WHERE upload_id=?', uploadId);
          submission = this.findFullSubmission(currentUser, submissionId);
          if (!submission) {
            throw new Error('created submission unavailable');
          }
        });
        return json({ submission }, 201);
      } catch (cause) {
        const message = String(cause?.message);
        if (message.includes('UNIQUE') && message.includes('submissions')) {
          return error(409, 'A submission already exists for this worker, site, and date');
        }
        if (message === 'PHOTO_QUOTA') {
          return error(413, 'Photo storage limit reached');
        }
        if (message === 'DAILY_LIMIT') {
          return error(429, 'Daily submission limit reached. Try again tomorrow.');
        }
        if (message.includes('FOREIGN KEY')) {
          return error(400, 'Invalid submission data');
        }
        return error(500, 'Unable to save submission');
      }
    } finally {
      sql.exec('DELETE FROM upload_staging_chunks WHERE upload_id=?', uploadId);
    }
  }

  findPhoto(user, id) {
    const sql = this.state.storage.sql;
    if (user.role === 'framer') {
      return firstRow(
        sql,
        `SELECT p.id,p.mime_type,p.size_bytes
         FROM photos p JOIN submissions s ON s.id=p.submission_id
         WHERE p.id=? AND s.worker_id=?`,
        id,
        user.id
      );
    }
    return firstRow(sql, 'SELECT id,mime_type,size_bytes FROM photos WHERE id=?', id);
  }

  async handleThumbnail(user, id) {
    const sql = this.state.storage.sql;
    const photo = this.findPhoto(user, id);
    if (!photo) {
      return error(404, 'Photo not found');
    }
    let thumbnail = firstRow(
      sql,
      'SELECT bytes FROM photo_thumbnails WHERE photo_id=?',
      id
    );
    if (!thumbnail) {
      if (!this.env.IMAGES) {
        return error(500, 'Thumbnail unavailable');
      }
      try {
        const bytes = await createThumbnail(
          this.env.IMAGES,
          storedPhotoStream(sql, id)
        );
        this.state.storage.transactionSync(() => {
          sql.exec(
            'INSERT OR IGNORE INTO photo_thumbnails (photo_id,bytes) VALUES (?,?)',
            id,
            bytes.buffer
          );
        });
        thumbnail = firstRow(
          sql,
          'SELECT bytes FROM photo_thumbnails WHERE photo_id=?',
          id
        );
      } catch {
        return error(500, 'Thumbnail unavailable');
      }
    }
    if (!thumbnail?.bytes) {
      return error(500, 'Thumbnail unavailable');
    }
    const bytes = new Uint8Array(thumbnail.bytes);
    return new Response(bytes, {
      status: 200,
      headers: privateHeaders({
        'Content-Type': 'image/webp',
        'Content-Length': String(bytes.byteLength)
      })
    });
  }

  handlePhoto(user, id) {
    const sql = this.state.storage.sql;
    const photo = this.findPhoto(user, id);
    if (!photo) {
      return error(404, 'Photo not found');
    }
    const integrity = firstRow(
      sql,
      `SELECT COUNT(*) AS chunks,COALESCE(SUM(length(bytes)),0) AS size,
              MIN(chunk_index) AS first_chunk,MAX(chunk_index) AS last_chunk
       FROM photo_chunks WHERE photo_id=?`,
      id
    );
    const chunkCount = Number(integrity?.chunks);
    if (
      chunkCount < 1 ||
      Number(integrity?.size) !== Number(photo.size_bytes) ||
      Number(integrity?.first_chunk) !== 0 ||
      Number(integrity?.last_chunk) !== chunkCount - 1
    ) {
      return error(404, 'Photo unavailable');
    }
    const stream = storedPhotoStream(sql, id);
    return new Response(stream, {
      status: 200,
      headers: privateHeaders({
        'Content-Type': photo.mime_type,
        'Content-Length': String(photo.size_bytes),
        'Content-Disposition': 'inline'
      })
    });
  }

  parseFilters(url) {
    const filters = {};
    const params = url.searchParams;
    for (const key of ['site_id', 'worker_id']) {
      const values = params.getAll(key);
      if (
        values.length > 1 ||
        (values.length === 1 && !validId(values[0]))
      ) {
        return [null, `Invalid ${key}`];
      }
      if (values.length === 1) {
        filters[key] = Number(values[0]);
      }
    }
    for (const key of ['date_from', 'date_to']) {
      const values = params.getAll(key);
      if (
        values.length > 1 ||
        (values.length === 1 && !validDate(values[0]))
      ) {
        return [null, `Invalid ${key}`];
      }
      if (values.length === 1) {
        filters[key] = values[0];
      }
    }
    if (
      filters.date_from &&
      filters.date_to &&
      filters.date_from > filters.date_to
    ) {
      return [null, 'date_from must not be after date_to'];
    }
    return [filters, null];
  }
  scoped(user, filters) {
    const clauses = [];
    const params = [];
    if (user.role === 'framer') {
      clauses.push('s.worker_id=?');
      params.push(user.id);
    } else if (filters.worker_id !== undefined) {
      clauses.push('s.worker_id=?');
      params.push(filters.worker_id);
    }
    if (filters.site_id !== undefined) {
      clauses.push('s.site_id=?');
      params.push(filters.site_id);
    }
    if (filters.date_from) {
      clauses.push('s.work_date>=?');
      params.push(filters.date_from);
    }
    if (filters.date_to) {
      clauses.push('s.work_date<=?');
      params.push(filters.date_to);
    }
    return {
      where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
      params
    };
  }
  findFullSubmission(user, id) {
    const condition = user.role === 'framer' ? 'AND s.worker_id=?' : '';
    const params = user.role === 'framer' ? [id, user.id] : [id];
    const row = firstRow(
      this.state.storage.sql,
      `SELECT s.*,u.name AS worker_name,st.name AS site_name
       FROM submissions s
       JOIN users u ON u.id=s.worker_id
       JOIN sites st ON st.id=s.site_id
       WHERE s.id=? ${condition}`,
      ...params
    );
    if (!row) {
      return null;
    }
    const photos = queryRows(
      this.state.storage.sql,
      `SELECT id,mime_type,size_bytes
       FROM photos WHERE submission_id=? ORDER BY id`,
      id
    );
    return detailRow(row, photos);
  }

  async handleDeleteSubmission(request, user, id) {
    if (user.role !== 'admin') {
      return error(403, 'Forbidden');
    }
    return this.withSubmissionMutationLock(() => {
      const currentUser = this.authenticate(request);
      if (!currentUser) {
        return error(401, 'Authentication required');
      }
      const temporaryError = this.handleTemporaryPassword(currentUser);
      if (temporaryError) {
        return temporaryError;
      }
      if (currentUser.role !== 'admin') {
        return error(403, 'Forbidden');
      }

      const sql = this.state.storage.sql;
      let deleted = false;
      this.state.storage.transactionSync(() => {
        const submission = firstRow(
          sql,
          'SELECT id FROM submissions WHERE id=?',
          id
        );
        if (!submission) {
          return;
        }
        sql.exec(
          `DELETE FROM photo_thumbnails
           WHERE photo_id IN (SELECT id FROM photos WHERE submission_id=?)`,
          id
        );
        sql.exec(
          `DELETE FROM photo_chunks
           WHERE photo_id IN (SELECT id FROM photos WHERE submission_id=?)`,
          id
        );
        sql.exec('DELETE FROM photos WHERE submission_id=?', id);
        sql.exec('DELETE FROM submissions WHERE id=?', id);
        deleted = true;
      });
      if (!deleted) {
        return error(404, 'Submission not found');
      }
      return new Response(null, {
        status: 204,
        headers: privateHeaders()
      });
    });
  }

  handleListSubmissions(user, url) {
    const [filters, filterError] = this.parseFilters(url);
    if (filterError) {
      return error(400, filterError);
    }
    const scoped = this.scoped(user, filters);
    const rows = queryRows(
      this.state.storage.sql,
      `SELECT s.id,s.worker_id,u.name AS worker_name,s.site_id,
              st.name AS site_name,s.work_date,s.created_at,
              COUNT(p.id) AS photo_count
       FROM submissions s
       JOIN users u ON u.id=s.worker_id
       JOIN sites st ON st.id=s.site_id
       LEFT JOIN photos p ON p.submission_id=s.id
       ${scoped.where}
       GROUP BY s.id
       ORDER BY s.work_date DESC,s.id DESC`,
      ...scoped.params
    );
    const counts = queryRows(
      this.state.storage.sql,
      `SELECT s.site_id,COUNT(*) AS submission_count
       FROM submissions s
       ${scoped.where}
       GROUP BY s.site_id`,
      ...scoped.params
    );
    const countBySite = new Map(
      counts.map((row) => [row.site_id, row.submission_count])
    );
    const summary = queryRows(
      this.state.storage.sql,
      'SELECT id,name FROM sites ORDER BY name COLLATE NOCASE'
    ).map((site) => ({
      site_id: site.id,
      site_name: site.name,
      submission_count: countBySite.get(site.id) ?? 0
    }));
    return json({
      submissions: rows.map(submissionListRow),
      summary
    });
  }

  handleLogout(request) {
    const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      this.state.storage.sql.exec(
        'DELETE FROM sessions WHERE token_hash=?',
        tokenHash(token)
      );
    }
    return new Response(null, {
      status: 204,
      headers: privateHeaders({ 'Set-Cookie': cookieHeader(request, '', 0) })
    });
  }

  handleAdminWorkers(user) {
    if (user.role !== 'admin') {
      return error(403, 'Forbidden');
    }
    const workers = queryRows(
      this.state.storage.sql,
      `SELECT u.id,u.name
       FROM users u
       WHERE u.role='framer'
          OR EXISTS (SELECT 1 FROM submissions s WHERE s.worker_id=u.id)
       ORDER BY u.name COLLATE NOCASE`
    );
    return json({ workers });
  }

  handleSubmissionUpload(request, user) {
    if (user.role !== 'framer') {
      return error(403, 'Forbidden');
    }
    return this.withUploadLock(async () => {
      const currentUser = this.authenticate(request);
      if (!currentUser) {
        return error(401, 'Authentication required');
      }
      const temporaryError = this.handleTemporaryPassword(currentUser);
      if (temporaryError) {
        return temporaryError;
      }
      if (currentUser.role !== 'framer') {
        return error(403, 'Forbidden');
      }
      return this.handleSubmission(request, currentUser);
    });
  }

  async route(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const deleteSubmissionPath = (
      request.method === 'DELETE' &&
      /^\/api\/submissions\/[^/]+$/.test(path)
    );
    if (
      (request.method === 'POST' || deleteSubmissionPath) &&
      !originAllowed(request)
    ) {
      if (deleteSubmissionPath) {
        await cancelUnreadRequestBody(request);
      }
      return error(403, 'Origin is not allowed');
    }
    if (deleteSubmissionPath && await deleteRequestHasBody(request)) {
      await cancelUnreadRequestBody(request);
      return error(400, 'DELETE requests must not have a body');
    }
    if (request.method === 'GET' && path === '/api/health') {
      return json({ status: 'ok' });
    }
    if (request.method === 'POST' && path === '/api/login') {
      return this.handleLogin(request);
    }
    if (request.method === 'POST' && path === '/api/logout') {
      return this.handleLogout(request);
    }

    const adminUsersPath = path === '/api/admin/users';
    const adminPasswordMatch = path.match(
      /^\/api\/admin\/users\/([^/]+)\/password$/
    );
    const accountPasswordPath = path === '/api/account/password';
    const knownProtected = (
      request.method === 'GET' &&
      (
        path === '/api/session' ||
        path === '/api/sites' ||
        path === '/api/admin/workers' ||
        adminUsersPath ||
        path === '/api/submissions' ||
        /^\/api\/submissions\/[^/]+$/.test(path) ||
        /^\/api\/photos\/[^/]+(?:\/thumbnail)?$/.test(path)
      )
    ) || (
      request.method === 'POST' &&
      (
        path === '/api/submissions' ||
        adminUsersPath ||
        Boolean(adminPasswordMatch) ||
        accountPasswordPath
      )
    ) || deleteSubmissionPath;
    if (!knownProtected) {
      return error(404, 'Not found');
    }

    const now = Math.floor(Date.now() / 1000);
    this.state.storage.sql.exec(
      'DELETE FROM sessions WHERE expires_at<=? OR expires_at>?',
      now,
      now + SESSION_TTL_SECONDS
    );
    const user = this.authenticate(request);
    if (!user) {
      return error(401, 'Authentication required');
    }
    if (request.method === 'GET' && path === '/api/session') {
      return json({ user });
    }
    if (user.must_change_password && !accountPasswordPath) {
      return temporaryPasswordError();
    }
    if (accountPasswordPath && request.method === 'POST') {
      return this.handleAccountPassword(request, user);
    }
    if (
      adminUsersPath &&
      (request.method === 'GET' || request.method === 'POST')
    ) {
      return this.handleAdminUsers(request, user);
    }
    if (adminPasswordMatch && request.method === 'POST') {
      return this.handleAdminPasswordReset(request, user, adminPasswordMatch[1]);
    }
    if (request.method === 'GET' && path === '/api/sites') {
      const sites = queryRows(
        this.state.storage.sql,
        'SELECT id,name FROM sites ORDER BY name COLLATE NOCASE'
      );
      return json({ sites });
    }
    if (request.method === 'GET' && path === '/api/admin/workers') {
      return this.handleAdminWorkers(user);
    }
    if (request.method === 'GET' && path === '/api/submissions') {
      return this.handleListSubmissions(user, url);
    }

    const detailMatch = path.match(/^\/api\/submissions\/([^/]+)$/);
    if (request.method === 'GET' && detailMatch) {
      if (!validId(detailMatch[1])) {
        return error(400, 'Invalid submission id');
      }
      const submission = this.findFullSubmission(
        user,
        Number(detailMatch[1])
      );
      if (!submission) {
        return error(404, 'Submission not found');
      }
      return json({ submission });
    }

    if (request.method === 'DELETE' && detailMatch) {
      if (!validId(detailMatch[1])) {
        return error(400, 'Invalid submission id');
      }
      return this.handleDeleteSubmission(request, user, Number(detailMatch[1]));
    }

    const thumbnailMatch = path.match(/^\/api\/photos\/([^/]+)\/thumbnail$/);
    if (request.method === 'GET' && thumbnailMatch) {
      if (!validId(thumbnailMatch[1])) {
        return error(400, 'Invalid photo id');
      }
      return this.handleThumbnail(user, Number(thumbnailMatch[1]));
    }

    const photoMatch = path.match(/^\/api\/photos\/([^/]+)$/);
    if (request.method === 'GET' && photoMatch) {
      if (!validId(photoMatch[1])) {
        return error(400, 'Invalid photo id');
      }
      return this.handlePhoto(user, Number(photoMatch[1]));
    }

    if (request.method === 'POST' && path === '/api/submissions') {
      return this.handleSubmissionUpload(request, user);
    }
    return error(404, 'Not found');
  }
  async fetch(request) {
    try {
      return await this.route(request);
    } catch {
      return error(500, 'Internal server error');
    } finally {
      // A Durable Object response must not overtake an unread forwarded body.
      await drainUnreadRequestBody(request);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const deleteSubmissionPath = (
        request.method === 'DELETE' &&
        /^\/api\/submissions\/[^/]+$/.test(url.pathname)
      );
      if (deleteSubmissionPath && !originAllowed(request)) {
        await cancelUnreadRequestBody(request);
        return error(403, 'Origin is not allowed');
      }
      if (deleteSubmissionPath && await deleteRequestHasBody(request)) {
        await cancelUnreadRequestBody(request);
        return error(400, 'DELETE requests must not have a body');
      }
      if (request.method === 'POST') {
        const declared = request.headers.get('Content-Length');
        if (request.body && declared === null) {
          return error(411, 'Content-Length required');
        }
        const length = Number(declared);
        const limit = url.pathname === '/api/submissions'
          ? MULTIPART_BYTE_LIMIT
          : LOGIN_JSON_LIMIT;
        if (Number.isFinite(length) && length > limit) {
          return error(413, 'Request is too large');
        }
      }
      const stub = env.SAFETY_APP.getByName('ras-site-safety');
      const headers = new Headers(request.headers);
      headers.set('x-ras-client-ip', request.headers.get('CF-Connecting-IP') || 'unknown');
      try {
        // DELETE never forwards a body. Its empty stream was already read above.
        const forwarded = deleteSubmissionPath
          ? new Request(request.url, { method: 'DELETE', headers })
          : new Request(request, { headers });
        return await stub.fetch(forwarded);
      } finally {
        await drainUnreadRequestBody(request);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
