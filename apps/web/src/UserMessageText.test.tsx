import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  UserMessageText,
  stripInjectedBrowserContext,
  stripInjectedMessageScaffolding,
} from "./UserMessageText";

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

  it("隐藏所有宿主请求标题，不依赖浏览器上下文且支持重复标题", () => {
    const automatic = ambientBlock("Current URL: https://example.invalid/thread");

    expect(
      stripInjectedBrowserContext(`${automatic}\n\n## My request for Codex:\n真正的用户正文`),
    ).toBe("真正的用户正文");
    expect(
      stripInjectedBrowserContext(`${automatic}\r\n\r\n## My request for Codex: 同一行正文`),
    ).toBe("同一行正文");
    expect(
      stripInjectedBrowserContext(
        "## My request for Codex:\n第一段正文\n\n## My request for Codex: 第二段正文\n## My request for Codex第三段正文",
      ),
    ).toBe("第一段正文\n\n第二段正文\n第三段正文");
  });

  it("隐藏文件清单、图片路径标记和请求包装，但保留实际请求", () => {
    const message = [
      "# Files mentioned by the user:",
      "",
      "## codex-clipboard-example.png: C:/Users/example/AppData/Local/Temp/example.png",
      "",
      "## My request for Codex:",
      "请修复真实问题",
      '<image name=[Image #1] path="C:\\Users\\example\\example.png">',
    ].join("\n");

    expect(stripInjectedMessageScaffolding(message)).toBe("请修复真实问题");
  });

  it("成对隐藏宿主图片包装标签，但保留用户单独输入的相似字面量", () => {
    const hostWrapped = [
      '<image name=[Image #1] path="C:\\Users\\example\\proof.png">',
      "</image>",
      "请检查图片内容",
    ].join("\n");

    expect(stripInjectedMessageScaffolding(hostWrapped)).toBe("请检查图片内容");
    expect(stripInjectedMessageScaffolding("请解释下面的字面量：\n</image>\n不要删除")).toBe(
      "请解释下面的字面量：\n</image>\n不要删除",
    );
  });

  it("隐藏内部委派包装并保留相邻的真实用户正文", () => {
    const delegation = [
      "<codex_delegation>",
      "  <source_thread_id>internal</source_thread_id>",
      "  <input>内部协调内容</input>",
      "</codex_delegation>",
    ].join("\n");

    expect(
      stripInjectedMessageScaffolding(`第一段真实正文\n\n${delegation}\n\n第二段真实正文`),
    ).toBe("第一段真实正文\n\n第二段真实正文");
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
