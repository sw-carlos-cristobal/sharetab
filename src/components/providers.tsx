'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, httpLink, splitLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '@/lib/trpc';
import { SessionProvider } from 'next-auth/react';
import { ThemeProvider } from 'next-themes';

function getBaseUrl() {
  if (typeof window !== 'undefined') return '';
  return process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        // Claim saves go on their own, so the claim page can abandon one that hangs (a batched
        // request is aborted only when every call in it is; see src/lib/claim-save.ts)
        splitLink({
          condition: (op) => op.path === 'guest.claimItems',
          true: httpLink({ url: `${getBaseUrl()}/api/trpc`, transformer: superjson }),
          false: httpBatchLink({ url: `${getBaseUrl()}/api/trpc`, transformer: superjson }),
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <SessionProvider>{children}</SessionProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
