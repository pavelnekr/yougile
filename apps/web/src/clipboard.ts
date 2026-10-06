/**
 * Копирование текста в буфер обмена с запасным вариантом.
 *
 * `navigator.clipboard` работает только в secure-контексте (localhost и https).
 * На http-адресах вручную запущенного Vite без secure-контекста используется
 * скрытый textarea с `document.execCommand("copy")`.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    textarea.remove();
    return ok;
  }
}