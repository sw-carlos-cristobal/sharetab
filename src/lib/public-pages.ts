// The pages the middleware lets through signed out (paths without the locale prefix): the home
// page and these. A page whose session ended stays on them (session-ended.ts). Some still use a
// session when there is one (the invite page needs one, and sends itself to sign-in when
// `SessionProvider` finds none, on a page load or when the tab becomes visible; a call failing on
// it while it's open shows the error instead).
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
  return pathname === '/' || publicPages.some((page) => pathname === page || pathname.startsWith(page + '/'));
}
