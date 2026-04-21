import { redirect } from "next/navigation";
import { auth } from "@/server/auth";

export default async function Home({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await auth();
  if (session?.user) {
    redirect(`/${locale}/dashboard`);
  }
  redirect(`/${locale}/login`);
}
