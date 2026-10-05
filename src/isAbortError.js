export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 20 || error?.code === 'ERR_CANCELED';
}
