// Fixed by the frontend build. Never select an API from a shared link,
// query string, storage value or a response sent by the backend.
declare const __NULLBIN_API_ORIGIN__: string;

const apiOrigin = typeof __NULLBIN_API_ORIGIN__ === 'undefined' ? '' : __NULLBIN_API_ORIGIN__;

export function apiURL(path: string): string {
  return apiOrigin + path;
}
