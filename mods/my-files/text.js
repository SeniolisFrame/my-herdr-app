// Text changes that end up written to files. No imports, so node can test them:
// node mods/my-files/text.test.mjs

// The editor draws a tab as nothing, so tab indents show as 4 spaces and turn back
// into tabs on save. Only when no line starts with a space, or with tabs then 4 spaces
// (a Go raw string, say: they would come back as one more tab), so it round-trips.
export const usesTabs = (text) => /^\t/m.test(text) && !/^ /m.test(text) && !/^\t+ {4}/m.test(text);
export const tabsToSpaces = (text) => text.replace(/^\t+/gm, (m) => "    ".repeat(m.length));
export const spacesToTabs = (text) => text.replace(/^( {4})+/gm, (m) => "\t".repeat(m.length / 4));

// q found literally, in any case.
const literal = (q) => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

// Replaces q with `to` on the given 1-based lines only; line endings stay as they
// are. Returns the new text and how many were replaced.
export function replaceOnLines(text, lines, q, to) {
  const re = literal(q), parts = text.split(/(?<=\n)/);
  let n = 0;
  for (const l of lines) if (parts[l - 1]) parts[l - 1] = parts[l - 1].replace(re, () => { n++; return to; });
  return { text: parts.join(""), n };
}

// Replaces every q in the text (ctrl+h, Replace all).
export function replaceAll(text, q, to) {
  let n = 0;
  return { text: text.replace(literal(q), () => { n++; return to; }), n };
}
