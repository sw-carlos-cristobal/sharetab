// Pages that need no session (paths without the locale prefix). The middleware lets them
// through signed out, and a page whose session ended stays on them (session-ended.ts).
const publicPages = [
  '/login',
  '/register',
  '/verify-request',
  '/forgot-password',
  '/reset-password',
  '/invite',
  '/split',
];

export function isPublicPage(pathname: string): boolean {
  return publicPages.some((page) => pathname === page || pathname.startsWith(page + '/'));
}
