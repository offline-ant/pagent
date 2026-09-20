// Plain-text blocks, not Markdown rendering. A blank line completes a paragraph
// only outside a fenced code block. Unfinished streaming tails remain invisible.
export function completedParagraphs(text, complete) {
  const paragraphs = [];
  let block = "";
  let fence = null;
  const flush = () => {
    const paragraph = block.replace(/(?:\r?\n)+$/, "");
    if (paragraph.trim()) paragraphs.push(paragraph);
    block = "";
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const content = line.replace(/\r?\n$/, "");
    if (!fence && /^[\t ]*$/.test(content) && line.endsWith("\n")) {
      flush();
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (marker) {
      if (fence) {
        if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^[\t ]*$/.test(marker[2])) fence = null;
      } else if (marker[1][0] === "~" || !marker[2].includes("`")) {
        fence = marker[1];
      }
    }
    block += line;
  }
  if (complete) flush();
  return paragraphs;
}
