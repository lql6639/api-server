"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const urlDecoderMiddleware = require("../utils/urlDecoder");

describe("urlDecoderMiddleware", () => {
  it("should decode only the pathname and preserve encoded query delimiters", () => {
    const originalQuery =
      "?target=https%3A%2F%2Fexample.test%2Fpath%3Fone%3D1%26two%3D2%23section&value=%26%23%3F";
    const request = { url: `/v1/%E6%B5%8B%E8%AF%95${originalQuery}` };
    let nextCalls = 0;

    urlDecoderMiddleware(request, {}, () => {
      nextCalls++;
    });

    assert.strictEqual(request.url, `/v1/测试${originalQuery}`);
    assert.strictEqual(nextCalls, 1);
  });
});
