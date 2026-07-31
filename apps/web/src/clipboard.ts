export interface ClipboardEnvironment {
  clipboard?: Pick<Clipboard, "writeText">;
  document?: Pick<Document, "body" | "createElement" | "execCommand">;
}

export async function copyPlainText(
  text: string,
  environment: ClipboardEnvironment = {
    clipboard: navigator.clipboard,
    document,
  },
): Promise<void> {
  if (environment.clipboard?.writeText) {
    try {
      await environment.clipboard.writeText(text);
      return;
    } catch {
      // Android browsers can expose Clipboard.writeText while denying it for
      // the current gesture or page state. Fall through to the synchronous
      // selection path instead of reporting a false permanent failure.
    }
  }

  const ownerDocument = environment.document;
  if (!ownerDocument) throw new Error("当前浏览器不支持复制");
  const control = ownerDocument.createElement("textarea");
  control.value = text;
  control.readOnly = true;
  control.style.position = "fixed";
  control.style.opacity = "0";
  control.style.pointerEvents = "none";
  ownerDocument.body.append(control);
  try {
    control.select();
    if (!ownerDocument.execCommand("copy")) {
      throw new Error("当前浏览器不支持复制");
    }
  } finally {
    control.remove();
  }
}
