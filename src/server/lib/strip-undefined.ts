/**
 * The shape of `T` with `undefined` excluded from every property's value
 * type, while keeping any property that could be `undefined` optional (`?`)
 * rather than required. Mirrors what `stripUndefined` does at runtime.
 */
type StripUndefined<T> = {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} & {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

/**
 * Drop keys whose value is `undefined`, returning a new object.
 *
 * Prisma's generated `*CreateInput`/`*UpdateInput` types (and other optional
 * `key?: T` properties across the codebase) distinguish "key absent" from
 * "key present with value `undefined`" once `exactOptionalPropertyTypes` is
 * enabled. Input objects built from an optional-field zod schema naturally
 * carry `T | undefined` values for unset fields — this omits those keys
 * entirely so the resulting object satisfies the stricter optional-property
 * contract, instead of explicitly assigning `undefined` to them.
 *
 * `null` values are kept as-is; only `undefined` is stripped. The cast on the
 * return is a runtime->type-level bridge TS can't infer on its own (the loop
 * below is exactly what `StripUndefined<T>` describes); see
 * strip-undefined.test.ts for the behavioral guarantee it relies on.
 */
export function stripUndefined<T extends Record<string, unknown>>(obj: T): StripUndefined<T> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result as StripUndefined<T>;
}
