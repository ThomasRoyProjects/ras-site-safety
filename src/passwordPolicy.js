export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export function codePointLength(value) {
  return Array.from(value).length;
}

export function validatePassword({ currentPassword = '', newPassword, confirmPassword }) {
  const length = codePointLength(newPassword);

  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    return 'New password must be 12–128 characters.';
  }

  if (newPassword !== confirmPassword) {
    return 'New passwords do not match.';
  }

  if (newPassword === currentPassword) {
    return 'New password must be different from your current password.';
  }

  return '';
}
