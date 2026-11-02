"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const JSON_FILES = [
  "server-config.json",
  "webhook.json",
  "v1/img/config.json",
  "v1/ipinfo/config.json",
  "v1/weather/config.json",
];

function readJson(relativePath) {
  const filePath = path.join(PROJECT_ROOT, relativePath);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isPlaceholderCredential(value) {
  return (
    value === "" ||
    /^YOUR_[A-Z0-9_]+$/.test(value) ||
    /^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(value) ||
    /^\$\{[A-Z0-9_]+\}$/.test(value)
  );
}

function getWebhookSecret(webhook) {
  return webhook["trigger-rule"].and[0].match.secret;
}

function assertUrlCredentialsArePlaceholders(value) {
  const url = new URL(value);
  const credentialNames = new Set([
    "api_key",
    "apikey",
    "appid",
    "key",
    "password",
    "secret",
    "token",
  ]);

  assert.strictEqual(url.username, "");
  assert.strictEqual(url.password, "");
  url.searchParams.forEach((parameterValue, parameterName) => {
    if (credentialNames.has(parameterName.toLowerCase())) {
      assert.ok(
        isPlaceholderCredential(parameterValue),
        `${parameterName} in ${url}`,
      );
    }
  });
}

describe("committed JSON configuration", () => {
  it("should parse every server, webhook, and v1 configuration file", () => {
    JSON_FILES.forEach((relativePath) => {
      assert.doesNotThrow(() => readJson(relativePath), relativePath);
    });
  });

  it("should keep Redis and webhook credentials as placeholders", () => {
    ["server-config.json"].forEach((relativePath) => {
      const config = readJson(relativePath);
      assert.ok(isPlaceholderCredential(config.redis.password), relativePath);
    });

    ["webhook.json"].forEach((relativePath) => {
      const webhooks = readJson(relativePath);
      assert.ok(Array.isArray(webhooks), relativePath);
      webhooks.forEach((webhook) => {
        assert.ok(
          isPlaceholderCredential(getWebhookSecret(webhook)),
          relativePath,
        );
      });
    });
  });

  it("should use placeholders for credential-bearing weather URL parameters", () => {
    const config = readJson("v1/weather/config.json");
    const bingUrl = new URL(config.bing.url);
    const msnUrl = new URL(config.msn.url);
    const amapUrl = new URL(config.amap.url);

    assert.strictEqual(bingUrl.searchParams.get("appid"), "{appid}");
    assert.strictEqual(msnUrl.searchParams.get("apikey"), "{apikey}");
    assert.strictEqual(amapUrl.searchParams.get("key"), "{key}");
  });

  it("should not embed credentials in configured upstream URLs", () => {
    const imgConfig = readJson("v1/img/config.json");
    const ipinfoConfig = readJson("v1/ipinfo/config.json");
    const weatherConfig = readJson("v1/weather/config.json");
    const urls = [
      imgConfig.url,
      ...Object.values(imgConfig.upstream),
      ...ipinfoConfig.upstream_apis.map((api) => api.url),
      ...Object.values(weatherConfig)
        .filter((value) => value && typeof value.url === "string")
        .map((value) => value.url),
    ];

    urls.forEach((value) => {
      assertUrlCredentialsArePlaceholders(value);
    });
  });
});
