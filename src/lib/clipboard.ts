/**
 * Copy text to the clipboard with a fallback for insecure contexts.
 *
 * `navigator.clipboard` is only available in secure contexts (HTTPS or
 * localhost). Self-hosted deployments often run over plain HTTP on a LAN,
 * where it is `undefined`. In that case we fall back to a temporary
 * textarea + `document.execCommand("copy")`.
 *
 * @returns true if the text was copied, false otherwise.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy fallback (e.g. permission denied).
    }
  }

  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // Remove in finally so a select()/execCommand() throw can't leak the
    // node into the DOM on repeated failures.
    textarea?.remove();
  }
}
