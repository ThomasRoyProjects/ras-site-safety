export async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  let body = options.body;

  if (body !== undefined && !(body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }

  const response = await fetch(`/api${path}`, {
    ...options,
    body,
    headers,
    credentials: 'same-origin',
    cache: 'no-store'
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      data?.error ?? `Request failed (HTTP ${response.status}).`
    );
    error.status = response.status;
    throw error;
  }

  if (data === null) {
    throw new Error('The server returned an invalid response.');
  }

  return data;
}
