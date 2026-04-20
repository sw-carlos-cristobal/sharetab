import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Mail } from "lucide-react";
import { Link } from "@/i18n/navigation";

export default async function VerifyRequestPage() {
  const t = await getTranslations("auth.verifyRequest");

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Mail className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-2xl">{t("title")}</CardTitle>
        <CardDescription>
          {t("description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="text-center space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("instructions")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("spamHint")}
        </p>
        <Link href="/login" className="text-sm font-medium text-primary hover:underline">
          {t("backToLogin")}
        </Link>
      </CardContent>
    </Card>
  );
}
