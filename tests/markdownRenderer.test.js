"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const { MarkdownRenderer } = require("../utils/markdownRenderer");

let tempDir;
let templatePath;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-server-markdown-"));
  templatePath = path.join(tempDir, "template.html");
  fs.writeFileSync(
    templatePath,
    "<title>${title}</title>${htmlContent}",
    "utf8",
  );
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("MarkdownRenderer", () => {
  it("should escape raw HTML and reject executable URL schemes", async () => {
    const renderer = new MarkdownRenderer(templatePath);
    const html = await renderer.render(
      "<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![bad](file:///tmp/image.png)",
      "security.md",
    );

    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /file:\/\//i);
    assert.match(html, />bad</);
  });

  it("should reject entity-obfuscated schemes and unsafe data images", async () => {
    const renderer = new MarkdownRenderer(templatePath);
    const html = await renderer.render(
      "[bad](javascript&#58;alert(1))\n\n![svg](data:image/svg+xml;base64,PHN2Zz4=)",
      "entities.md",
    );

    assert.doesNotMatch(html, /javascript/i);
    assert.doesNotMatch(html, /data:image\/svg\+xml/i);
    assert.doesNotMatch(html, /href=/);
    assert.doesNotMatch(html, /src=/);
  });

  it("should reject backslash and control-character-obfuscated executable schemes", async () => {
    const renderer = new MarkdownRenderer(templatePath);
    const controlCharacter = String.fromCharCode(0);
    const html = await renderer.render(
      `[backslash]: java\\script:alert(1)\n[control]: java${controlCharacter}script:alert(1)\n\n[backslash]\n[control]`,
      "obfuscated.md",
    );

    assert.doesNotMatch(html, /href=/);
    assert.doesNotMatch(html, /javascript/i);
    assert.match(html, /backslash/);
    assert.match(html, /control/);
  });

  it("should preserve normal links and images", async () => {
    const renderer = new MarkdownRenderer(templatePath);
    const html = await renderer.render(
      "[docs](https://example.test/docs)\n\n[guide](/docs/getting-started)\n\n![image](/image/test.png)",
      "links.md",
    );

    assert.match(html, /href="https:\/\/example\.test\/docs"/);
    assert.match(html, /href="\/docs\/getting-started"/);
    assert.match(html, /src="\/image\/test\.png"/);
  });
});
