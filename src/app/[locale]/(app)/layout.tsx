import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { isAdmin } from '@/server/lib/admin-email';
import { AppSidebar } from '@/components/layout/sidebar';
import { MobileHeader } from '@/components/layout/mobile-header';
import { AnnouncementBanner } from '@/components/layout/announcement-banner';
import { ImpersonationBanner } from '@/components/layout/impersonation-banner';

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect(`/${locale}/login`);
  }

  const showAdmin = await isAdmin(db, { id: session.user.id, email: session.user.email });

  return (
    <div className="min-h-dvh lg:flex lg:h-dvh lg:flex-row">
      <MobileHeader isAdmin={showAdmin} />
      <AppSidebar user={session.user} isAdmin={showAdmin} />
      <main className="@container flex-1 min-w-0 lg:overflow-auto">
        <ImpersonationBanner />
        <AnnouncementBanner />
        <div className="w-full py-4 px-4 md:py-6 md:px-8 2xl:mx-auto 2xl:max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
