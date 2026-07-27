import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UserMessageText, stripInjectedBrowserContext } from "./UserMessageText";

const ambientBlock = (body: string, newline = "\n") =>
  ['<in-app-browser-context source="ambient-ui-state">', body, "</in-app-browser-context>"].join(
    newline,
  );

describe("用户消息纯文本", () => {
  it("原样保留 Windows 反斜杠和换行，不解释 Markdown 或 HTML", () => {
    const message = String.raw`在 C:\Projects\codex-local-remote\.local\acceptance 中检查
第二行 **不是粗体** <script>alert("x")</script>`;

    const html = renderToStaticMarkup(<UserMessageText>{message}</UserMessageText>);

    expect(html).toContain(String.raw`C:\Projects\codex-local-remote\.local\acceptance`);
    expect(html).toContain("\n第二行 **不是粗体**");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('class="user-message-text"');
  });

  it("隐藏正文前后的真实自动浏览器上下文块", () => {
    const before = ambientBlock("Current URL: https://example.invalid/private");
    const after = ambientBlock("Current URL: http://127.0.0.1:18790/");

    expect(stripInjectedBrowserContext(`${before}\n\n真正的用户正文`)).toBe("真正的用户正文");
    expect(stripInjectedBrowserContext(`真正的用户正文\r\n\r\n${after}`)).toBe("真正的用户正文");
  });

  it("兼容多个自动块和 CRLF，同时保留块之间的真实正文", () => {
    const first = ambientBlock("first automatic context", "\r\n");
    const second = ambientBlock("second automatic context");

    const visible = stripInjectedBrowserContext(
      `${first}\r\n\r\n第一段真实正文\r\n\r\n${second}\n第二段真实正文`,
    );

    expect(visible).toBe("第一段真实正文\r\n\r\n第二段真实正文");
    expect(visible).not.toContain("automatic context");
  });

  it("只识别精确自动标签，保留普通相似文本和不完整标签", () => {
    const similar = [
      '<in-app-browser-context source="user-note">',
      "这是一段用户主动写下的相似文本",
      "</in-app-browser-context>",
      '<in-app-browser-context source="ambient-ui-state" data-user="true">',
      "标签带额外属性，不是精确自动块",
      "</in-app-browser-context>",
      '<in-app-browser-context source="ambient-ui-state">',
      "没有闭合标签，也必须原样保留",
    ].join("\n");

    expect(stripInjectedBrowserContext(similar)).toBe(similar);
  });

  it("渲染时不泄露自动上下文，但仍以纯文本保留用户正文", () => {
    const message = `${ambientBlock("<script>ambient-secret()</script>")}\n\n用户输入 **保持纯文本**`;

    const html = renderToStaticMarkup(<UserMessageText>{message}</UserMessageText>);

    expect(html).not.toContain("in-app-browser-context");
    expect(html).not.toContain("ambient-secret");
    expect(html).toContain("用户输入 **保持纯文本**");
    expect(html).not.toContain("<strong>");
  });
});
