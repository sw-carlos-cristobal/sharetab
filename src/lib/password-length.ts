/**
 * The longest password ShareTab sets, in UTF-8 bytes (#456): bcrypt reads only the first 72, so
 * anything after them wouldn't count. A character outside ASCII takes 2 to 4 bytes. Applies to
 * new passwords only; one set before the limit keeps working, since bcrypt cuts it the same way
 * when it is checked.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Whether a password is longer than bcrypt reads. Counts bytes as bcryptjs does (its
 * `truncates`): TextEncoder writes a lone surrogate as U+FFFD, 3 bytes, as bcryptjs encodes one.
 */
export function passwordTooLong(password: string): boolean {
  // Every UTF-16 code unit is at least one byte, so a longer string needs no encoding
  return password.length > MAX_PASSWORD_BYTES || new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES;
}
