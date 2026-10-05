import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const FORMAT = 'scrypt-v1';
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const INVALID_HEX = /[^0-9a-f]/;
const SCRYPT_OPTIONS = {
  N: 32768,
  r: 8,
  p: 3,
  maxmem: 64 * 1024 * 1024
};

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const key = await deriveKey(password, salt, KEY_BYTES, SCRYPT_OPTIONS);

  return `${FORMAT}:${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string') {
    return false;
  }

  const parts = storedHash.split(':');
  if (parts.length !== 3) {
    return false;
  }

  const [format, salt, keyHex] = parts;
  if (
    format !== FORMAT ||
    salt.length !== SALT_BYTES * 2 ||
    keyHex.length !== KEY_BYTES * 2 ||
    INVALID_HEX.test(salt) ||
    INVALID_HEX.test(keyHex)
  ) {
    return false;
  }

  const expectedKey = Buffer.from(keyHex, 'hex');
  const actualKey = await deriveKey(
    password, salt, KEY_BYTES, SCRYPT_OPTIONS
  );

  return timingSafeEqual(actualKey, expectedKey);
}
