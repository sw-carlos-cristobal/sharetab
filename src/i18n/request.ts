import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;

  if (!locale || !routing.locales.includes(locale as typeof routing.locales[number])) {
    locale = routing.defaultLocale;
  }

  const common = (await import(`../../messages/${locale}/common.json`)).default;
  const auth = (await import(`../../messages/${locale}/auth.json`)).default;
  const dashboard = (await import(`../../messages/${locale}/dashboard.json`)).default;
  const groups = (await import(`../../messages/${locale}/groups.json`)).default;
  const expenses = (await import(`../../messages/${locale}/expenses.json`)).default;
  const settings = (await import(`../../messages/${locale}/settings.json`)).default;
  const admin = (await import(`../../messages/${locale}/admin.json`)).default;

  return {
    locale,
    messages: {
      common,
      auth,
      dashboard,
      groups,
      expenses,
      settings,
      admin,
    },
  };
});
