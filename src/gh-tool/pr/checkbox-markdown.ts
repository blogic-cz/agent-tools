import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";

type CheckboxLine = {
  readonly before: string;
  readonly offset: number;
  readonly boxIndex: number;
  readonly checked: boolean;
};

type MarkdownNode =
  | ReturnType<typeof fromMarkdown>
  | ReturnType<typeof fromMarkdown>["children"][number];

const headingText = (node: MarkdownNode): string => {
  if ("children" in node) return node.children.map(headingText).join("");
  return "value" in node ? node.value : "";
};

export const findCheckboxLines = (body: string, match: string, section: string | null) => {
  const tree = fromMarkdown(body, {
    extensions: [gfmTaskListItem()],
    mdastExtensions: [gfmTaskListItemFromMarkdown()],
  });
  const matches: CheckboxLine[] = [];
  let sectionLevel: number | null = null;
  let inSection = section === null;

  const visit = (node: MarkdownNode) => {
    if (node.type === "heading") {
      if (sectionLevel !== null && node.depth <= sectionLevel) {
        inSection = false;
        sectionLevel = null;
      }
      if (section !== null && headingText(node) === section) {
        inSection = true;
        sectionLevel = node.depth;
      }
    }

    if (node.type === "listItem" && typeof node.checked === "boolean" && inSection) {
      const start = node.position?.start.offset;
      if (start === undefined) throw new Error("Task item has no source position");
      const lineStart = body.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = body.indexOf("\n", start);
      const text = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd).replace(/\r$/, "");
      if (text.includes(match)) {
        const marker = /^(?:[-*+]|[0-9]+[.)])[ \t]+\[([ xX])\](?:[ \t]|$)/.exec(
          body.slice(start, lineEnd === -1 ? body.length : lineEnd).replace(/\r$/, ""),
        );
        if (marker === null)
          throw new Error("Cannot locate task checkbox on its first source line");
        const offset = start + marker[0].indexOf("[") + 1;
        const box = body[offset];
        if (box !== " " && box !== "x" && box !== "X") {
          throw new Error("Task checkbox source position is invalid");
        }
        matches.push({ before: text, offset, boxIndex: offset - lineStart, checked: node.checked });
      }
    }

    if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  return matches;
};
