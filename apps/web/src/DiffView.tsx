import { memo } from "react";

export type DiffLineKind = "addition" | "context" | "deletion" | "header" | "hunk";

export interface DiffLine {
  kind: DiffLineKind;
  newLine?: number;
  oldLine?: number;
  text: string;
}

export function parseUnifiedDiff(value: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const text of value.replace(/\r\n?/gu, "\n").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text });
      continue;
    }
    if (oldLine === undefined || newLine === undefined) {
      rows.push({ kind: "header", text });
      continue;
    }
    if (text.startsWith("+") && !text.startsWith("+++")) {
      rows.push({ kind: "addition", newLine, text });
      newLine += 1;
      continue;
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      rows.push({ kind: "deletion", oldLine, text });
      oldLine += 1;
      continue;
    }
    if (text.startsWith(" ")) {
      rows.push({ kind: "context", newLine, oldLine, text });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    rows.push({ kind: "header", text });
  }
  return rows;
}

export const DiffView = memo(function DiffView({ diff }: { diff: string }) {
  const rows = parseUnifiedDiff(diff);
  return (
    <div aria-label="文件差异" className="diff-view" role="region">
      <table>
        <tbody>
          {rows.map((row, index) => (
            <tr
              className={`diff-view__line diff-view__line--${row.kind}`}
              key={`${index}-${row.text}`}
            >
              <td aria-hidden="true" className="diff-view__number">
                {row.oldLine ?? ""}
              </td>
              <td aria-hidden="true" className="diff-view__number">
                {row.newLine ?? ""}
              </td>
              <td className="diff-view__code">
                <code>{row.text || " "}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
