// node mods/my-files/text.test.mjs
import assert from "node:assert/strict";
import { usesTabs, tabsToSpaces, spacesToTabs, replaceOnLines, replaceAll } from "./text.js";

// Tabs round-trip, alignment spaces inside a line stay.
const go = "func f() {\n\tif x {\n\t\ty := 1  // a\n\t}\n}\n";
assert.ok(usesTabs(go));
assert.equal(tabsToSpaces(go), "func f() {\n    if x {\n        y := 1  // a\n    }\n}\n");
assert.equal(spacesToTabs(tabsToSpaces(go)), go);
assert.ok(!usesTabs("a\n\tb\n  c\n")); // a space-indented line: no conversion
assert.ok(!usesTabs("x := `\n\t    y`\n")); // tab then 4 spaces would save as 2 tabs: no conversion

// Replace: only the given lines, any case, CRLF kept, `$` taken literally.
const r = replaceOnLines("Foo foo\r\nfoo\r\nfoo\r\n", [1, 3], "FOO", "$1x");
assert.deepEqual(r, { text: "$1x $1x\r\nfoo\r\n$1x\r\n", n: 3 });
assert.equal(replaceOnLines("a.b axb\n", [1], "a.b", "-").text, "- axb\n"); // no regex meaning
assert.equal(replaceOnLines("x\n", [5], "x", "y").n, 0); // a line past the end
assert.deepEqual(replaceAll("Ab ab (ab)", "AB", "$&"), { text: "$& $& ($&)", n: 3 });
console.log("text ok");
