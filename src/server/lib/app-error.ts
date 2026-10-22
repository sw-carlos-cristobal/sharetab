import { TRPCError } from '@trpc/server';
import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import type { Locale } from '@/i18n/routing';
import en from '../../../messages/en/errors.json';
import es from '../../../messages/es/errors.json';
import sv from '../../../messages/sv/errors.json';
import fr from '../../../messages/fr/errors.json';
import de from '../../../messages/de/errors.json';
import ptBR from '../../../messages/pt-BR/errors.json';
import ja from '../../../messages/ja/errors.json';
import zhCN from '../../../messages/zh-CN/errors.json';
import ko from '../../../messages/ko/errors.json';

type ErrorCode = TRPCError['code'];
// `generic` holds the messages for errors without a key
export type ErrorKey = Exclude<keyof typeof en, 'generic'>;
export type ErrorValues = Record<string, string | number>;

const catalogs: Record<Locale, AbstractIntlMessages> = {
  en,
  es,
  sv,
  fr,
  de,
  'pt-BR': ptBR,
  ja,
  'zh-CN': zhCN,
  ko,
};

function translate(locale: Locale, key: string, values?: ErrorValues): string {
  // Typed loosely: the keys are checked by ErrorKey, and the catalogs aren't the app's Messages
  const t = createTranslator({ locale, messages: catalogs[locale] }) as unknown as (
    key: string,
    values?: ErrorValues,
  ) => string;
  return t(key, values);
}

/**
 * The error every procedure throws, so the person sees it in their language (#266): the
 * key names its text in messages/{locale}/errors.json, and the API's error formatter
 * (`errorShape`) sends that text in the language of the page that called. `message` stays
 * the English text, for logs, tests and API callers that send no language. Without a key,
 * the person gets the general message for the code.
 */
export class AppError extends TRPCError {
  readonly messageKey: ErrorKey | null;
  readonly messageValues: ErrorValues | undefined;

  constructor(code: ErrorCode, key?: ErrorKey, values?: ErrorValues, options?: { cause?: unknown }) {
    super({ code, message: key ? translate('en', key, values) : genericMessage(code, 'en'), cause: options?.cause });
    this.name = 'AppError';
    this.messageKey = key ?? null;
    this.messageValues = values;
  }
}

const GENERIC_KEYS: Partial<Record<ErrorCode, keyof typeof en.generic>> = {
  BAD_REQUEST: 'badRequest',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'notFound',
  CONFLICT: 'conflict',
  TOO_MANY_REQUESTS: 'tooManyRequests',
};

function genericMessage(code: ErrorCode, locale: Locale): string {
  return translate(locale, `generic.${GENERIC_KEYS[code] ?? 'other'}`);
}

/**
 * What the person sees for an error: its key's text in their language, or for one without
 * a key (an unexpected exception, input that failed validation, tRPC's own errors) the
 * general message for its code, never the error's own text.
 */
export function userErrorMessage(error: TRPCError, locale: Locale): string {
  if (error instanceof AppError && error.messageKey) {
    return translate(locale, error.messageKey, error.messageValues);
  }
  return genericMessage(error.code, locale);
}

/** A key's text in a language, for answers that aren't tRPC errors (`/api/upload`) */
export function errorText(key: ErrorKey, locale: Locale, values?: ErrorValues): string {
  return translate(locale, key, values);
}

/** The tRPC error shape with the person's message, and the key the client can branch on */
export function errorShape<Shape extends { message: string; data: object }>(
  shape: Shape,
  error: TRPCError,
  locale: Locale,
): Shape & { data: Shape['data'] & { messageKey: ErrorKey | null } } {
  return {
    ...shape,
    message: userErrorMessage(error, locale),
    data: { ...shape.data, messageKey: error instanceof AppError ? error.messageKey : null },
  };
}
