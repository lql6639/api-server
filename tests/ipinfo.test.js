"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const AXIOS_PATH = require.resolve("axios");
const CACHE_STORE_PATH = require.resolve("../libs/cacheStore");
const CONFIG_PATH = require.resolve("../v1/ipinfo/config.json");
const IPINFO_PATH = require.resolve("../v1/ipinfo");
const LOGGER_PATH = require.resolve("../utils/logger");
const IPINFO_MODULE_PATHS = [
  IPINFO_PATH,
  CONFIG_PATH,
  AXIOS_PATH,
  CACHE_STORE_PATH,
  LOGGER_PATH,
];

function setCachedModule(modulePath, moduleExports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: moduleExports,
  };
}

function snapshotModules(modulePaths) {
  return new Map(
    modulePaths.map((modulePath) => [modulePath, require.cache[modulePath]]),
  );
}

function restoreModules(snapshot) {
  for (const [modulePath, cachedModule] of snapshot.entries()) {
    delete require.cache[modulePath];
    if (cachedModule) {
      require.cache[modulePath] = cachedModule;
    }
  }
}

function loadIpinfo(config, axiosGet, cache) {
  const snapshot = snapshotModules(IPINFO_MODULE_PATHS);
  delete require.cache[IPINFO_PATH];
  setCachedModule(CONFIG_PATH, config);
  setCachedModule(AXIOS_PATH, { get: axiosGet });
  setCachedModule(CACHE_STORE_PATH, { getStore: () => cache });
  setCachedModule(LOGGER_PATH, {
    debug() {},
    error() {},
    info() {},
    warn() {},
  });

  try {
    const ipinfo = require(IPINFO_PATH);
    return {
      ipinfo,
      restore() {
        restoreModules(snapshot);
      },
    };
  } catch (error) {
    restoreModules(snapshot);
    throw error;
  }
}

function createProvider(name, options = {}) {
  const provider = {
    name,
    url: options.url || `https://${name}.test/lookup?ip={ip}`,
    max_requests: options.maxRequests ?? 100,
    time_window: options.timeWindow ?? 60,
    enabled: options.enabled ?? true,
    field_mapping: { ip: "{ip}" },
  };
  if (Object.prototype.hasOwnProperty.call(options, "ipVersions")) {
    provider.ip_versions = options.ipVersions;
  }
  return provider;
}

function createConfig(upstreamApis, overrides = {}) {
  return {
    default_timeout: 25,
    retry_count: 0,
    cache_ttl: 120,
    load_balance_strategy: "round_robin",
    response_fields: ["ip"],
    ...overrides,
    upstream_apis: upstreamApis,
  };
}

function createContext(config, options = {}) {
  const cacheGetCalls = [];
  const cacheSetCalls = [];
  const cacheSetNXCalls = [];
  const cacheDeleteCalls = [];
  const requestCalls = [];
  const cache = {
    async get(key) {
      cacheGetCalls.push(key);
      if (typeof options.cacheGet === "function") {
        return options.cacheGet(key);
      }
      return Object.prototype.hasOwnProperty.call(options, "cachedValue")
        ? options.cachedValue
        : null;
    },
    async set(key, value, ttl) {
      cacheSetCalls.push({ key, value, ttl });
      if (typeof options.cacheSet === "function") {
        return options.cacheSet(key, value, ttl);
      }
    },
    async setNX(key, value, ttl) {
      cacheSetNXCalls.push({ key, value, ttl });
      if (typeof options.cacheSetNX === "function") {
        return options.cacheSetNX(key, value, ttl);
      }
      return true;
    },
    async delIfValue(key, value) {
      cacheDeleteCalls.push({ key, value });
      return true;
    },
  };
  const axiosGet = async (url, requestOptions) => {
    requestCalls.push({ url, options: requestOptions });
    if (typeof options.axiosGet === "function") {
      return options.axiosGet(url, requestOptions);
    }
    return { data: {} };
  };

  return {
    cacheGetCalls,
    cacheSetCalls,
    cacheSetNXCalls,
    cacheDeleteCalls,
    requestCalls,
    load() {
      return loadIpinfo(config, axiosGet, cache);
    },
    async run(callback) {
      const loaded = loadIpinfo(config, axiosGet, cache);
      try {
        return await callback(loaded.ipinfo);
      } finally {
        loaded.restore();
      }
    },
  };
}

function assertLoadFails(config, matcher) {
  const context = createContext(config);
  let loaded;
  try {
    assert.throws(() => {
      loaded = context.load();
    }, matcher);
  } finally {
    if (loaded) {
      loaded.restore();
    }
  }
}

function assertStatusCode(statusCode) {
  return (error) => {
    assert.strictEqual(error.statusCode, statusCode);
    return true;
  };
}

describe("ipinfo client IP", () => {
  it("should use Express resolved req.ip instead of forwarding headers", async () => {
    const config = createConfig([createProvider("dual")]);
    const context = createContext(config);
    const request = {
      ip: "198.51.100.20",
      connection: { remoteAddress: "127.0.0.1" },
      get() {
        throw new Error("forwarding headers must not be read");
      },
    };

    await context.run((ipinfo) => {
      assert.strictEqual(ipinfo.getClientIp(request), "198.51.100.20");
    });
  });

  it("should return an empty IP when Express has no resolved client IP", async () => {
    const config = createConfig([createProvider("dual")]);
    const context = createContext(config);

    await context.run((ipinfo) => {
      assert.strictEqual(ipinfo.getClientIp({}), "");
    });
  });
});

describe("ipinfo configured provider capabilities", () => {
  it("should keep bt.cn IPv4-only and the other configured providers dual-stack", () => {
    const snapshot = snapshotModules([CONFIG_PATH]);
    delete require.cache[CONFIG_PATH];
    try {
      const config = require(CONFIG_PATH);
      const capabilities = Object.fromEntries(
        config.upstream_apis.map((provider) => [
          provider.name,
          provider.ip_versions
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .sort(),
        ]),
      );
      assert.deepStrictEqual(capabilities["bt.cn"], ["ipv4"]);
      assert.deepStrictEqual(capabilities.ip9, ["ipv4", "ipv6"]);
      assert.deepStrictEqual(capabilities.songzixian, ["ipv4", "ipv6"]);
      assert.deepStrictEqual(capabilities["52vmy"], ["ipv4", "ipv6"]);
    } finally {
      restoreModules(snapshot);
    }
  });
});

describe("ipinfo provider filtering", () => {
  it("should call only an IPv4 provider for an IPv4 request", async () => {
    const config = createConfig([
      createProvider("ipv6-only", { ipVersions: "IPv6" }),
      createProvider("ipv4-only", { ipVersions: "IPv4" }),
    ]);
    const context = createContext(config);
    const result = await context.run((ipinfo) =>
      ipinfo.queryIpInfoWithRetry("198.51.100.7"),
    );

    assert.strictEqual(result.source, "ipv4-only");
    assert.deepStrictEqual(
      context.requestCalls.map((call) => call.url),
      ["https://ipv4-only.test/lookup?ip=198.51.100.7"],
    );
  });

  it("should call only an IPv6 provider for an IPv6 request", async () => {
    const config = createConfig([
      createProvider("ipv4-only", { ipVersions: "IPv4" }),
      createProvider("ipv6-only", { ipVersions: "IPv6" }),
    ]);
    const context = createContext(config);
    const result = await context.run((ipinfo) =>
      ipinfo.queryIpInfoWithRetry("2001:db8::7"),
    );

    assert.strictEqual(result.source, "ipv6-only");
    assert.deepStrictEqual(
      context.requestCalls.map((call) => call.url),
      ["https://ipv6-only.test/lookup?ip=2001%3Adb8%3A%3A7"],
    );
  });

  it("should keep every failed retry round within the requested IP version", async () => {
    const config = createConfig(
      [
        createProvider("ipv6-a", { ipVersions: "IPv6" }),
        createProvider("ipv4-only", { ipVersions: "IPv4" }),
        createProvider("ipv6-b", { ipVersions: "IPv6" }),
      ],
      { retry_count: 1 },
    );
    const context = createContext(config, {
      axiosGet: async () => {
        throw new Error("offline");
      },
    });

    await context.run(async (ipinfo) => {
      await assert.rejects(
        () => ipinfo.queryIpInfoWithRetry("2001:db8::8"),
        /查询失败: offline/,
      );
    });
    const requestedHosts = context.requestCalls.map(
      (call) => new URL(call.url).hostname,
    );
    assert.strictEqual(requestedHosts.length, 4);
    assert.ok(
      requestedHosts.every((hostname) => hostname !== "ipv4-only.test"),
    );
    assert.strictEqual(
      requestedHosts.filter((hostname) => hostname === "ipv6-a.test").length,
      2,
    );
    assert.strictEqual(
      requestedHosts.filter((hostname) => hostname === "ipv6-b.test").length,
      2,
    );
  });

  it("should return 503 when no available provider matches the IP version", async () => {
    const config = createConfig([
      createProvider("ipv4-only", { ipVersions: "IPv4" }),
    ]);
    const context = createContext(config);

    await context.run(async (ipinfo) => {
      await assert.rejects(
        () => ipinfo.queryIpInfoWithRetry("2001:db8::9"),
        assertStatusCode(503),
      );
    });
    assert.strictEqual(context.requestCalls.length, 0);
  });
});

describe("ipinfo IP version configuration", () => {
  it("should default a missing ip_versions field to dual-stack", async () => {
    const config = createConfig([createProvider("default-dual")]);
    const context = createContext(config);

    await context.run(async (ipinfo) => {
      await ipinfo.queryIpInfoWithRetry("203.0.113.10");
      await ipinfo.queryIpInfoWithRetry("2001:db8::10");
    });
    assert.deepStrictEqual(
      context.requestCalls.map((call) => call.url),
      [
        "https://default-dual.test/lookup?ip=203.0.113.10",
        "https://default-dual.test/lookup?ip=2001%3Adb8%3A%3A10",
      ],
    );
  });

  it("should treat an empty ip_versions string as supporting no versions", async () => {
    const config = createConfig([createProvider("none", { ipVersions: "" })]);
    const context = createContext(config);

    await context.run(async (ipinfo) => {
      await assert.rejects(
        () => ipinfo.queryIpInfoWithRetry("203.0.113.11"),
        assertStatusCode(503),
      );
      await assert.rejects(
        () => ipinfo.queryIpInfoWithRetry("2001:db8::11"),
        assertStatusCode(503),
      );
    });
    assert.strictEqual(context.requestCalls.length, 0);
  });

  it("should ignore whitespace and case in ip_versions", async () => {
    const config = createConfig([
      createProvider("loose-dual", { ipVersions: "  iPv6 , IPV4  " }),
    ]);
    const context = createContext(config);

    await context.run(async (ipinfo) => {
      await ipinfo.queryIpInfoWithRetry("203.0.113.12");
      await ipinfo.queryIpInfoWithRetry("2001:db8::12");
    });
    assert.strictEqual(context.requestCalls.length, 2);
  });

  it("should throw during module loading for an unknown ip_versions value", () => {
    const config = createConfig([
      createProvider("unknown", { ipVersions: "IPv4,IPv7" }),
    ]);
    assertLoadFails(config, /ip_versions 包含未知值: ipv7/);
  });

  it("should throw during module loading for non-string ip_versions values", () => {
    for (const value of [null, 4, ["IPv4"], { version: "IPv4" }]) {
      const config = createConfig([
        createProvider("invalid-type", { ipVersions: value }),
      ]);
      assertLoadFails(config, /ip_versions 必须是逗号分隔的字符串/);
    }
  });

  it("should throw during module loading for duplicate provider names", () => {
    const config = createConfig([
      createProvider("duplicate", { ipVersions: "IPv4" }),
      createProvider(" duplicate ", { ipVersions: "IPv6" }),
    ]);
    assertLoadFails(config, /upstream API 名称重复: duplicate/);
  });
});

describe("ipinfo address validation", () => {
  it("should reject an invalid IP with statusCode 400 before reading cache", async () => {
    const config = createConfig([createProvider("dual")]);
    const context = createContext(config, {
      cachedValue: { source: "cache", data: { ip: "cached" } },
    });

    await context.run(async (ipinfo) => {
      await assert.rejects(
        () => ipinfo.queryIpInfoWithRetry("not-an-ip"),
        assertStatusCode(400),
      );
    });
    assert.strictEqual(context.cacheGetCalls.length, 0);
    assert.strictEqual(context.requestCalls.length, 0);
  });

  it("should reject legal IPv4-mapped IPv6 text forms with statusCode 400", async () => {
    const mappedAddresses = [
      "::ffff:192.0.2.128",
      "::ffff:c000:280",
      "0:0:0:0:0:ffff:192.0.2.128",
      "0:0:0:0:0:ffff:c000:0280",
      "0000:0000:0000:0000:0000:ffff:c000:0280",
      "0:0:0::ffff:192.0.2.128",
      "::FFFF:C000:0280",
      "::ffff:192.0.2.128%eth0",
    ];
    const config = createConfig([createProvider("dual")]);
    const context = createContext(config, {
      cachedValue: { source: "cache", data: { ip: "cached" } },
    });

    await context.run(async (ipinfo) => {
      for (const address of mappedAddresses) {
        await assert.rejects(
          () => ipinfo.queryIpInfoWithRetry(address),
          assertStatusCode(400),
        );
      }
    });
    assert.strictEqual(context.cacheGetCalls.length, 0);
    assert.strictEqual(context.requestCalls.length, 0);
  });

  it("should allow similar legal IPv6 addresses that are not IPv4-mapped", async () => {
    const addresses = [
      "::fffe:192.0.2.128",
      "::ffff:0:192.0.2.128",
      "2001:db8::ffff:c000:280",
    ];
    const config = createConfig([
      createProvider("ipv6-only", { ipVersions: "IPv6" }),
    ]);
    const context = createContext(config);

    await context.run(async (ipinfo) => {
      for (const address of addresses) {
        const result = await ipinfo.queryIpInfoWithRetry(address);
        assert.strictEqual(result.source, "ipv6-only");
      }
    });
    assert.strictEqual(context.requestCalls.length, addresses.length);
  });
});

describe("ipinfo URL and cache behavior", () => {
  it("should encode every IP placeholder in the upstream URL", async () => {
    const config = createConfig([
      createProvider("encoded", {
        ipVersions: "IPv6",
        url: "https://encoded.test/{ip}?copy={ip}",
      }),
    ]);
    const context = createContext(config);

    await context.run((ipinfo) => ipinfo.queryIpInfoWithRetry("2001:db8::20"));
    assert.strictEqual(
      context.requestCalls[0].url,
      "https://encoded.test/2001%3Adb8%3A%3A20?copy=2001%3Adb8%3A%3A20",
    );
  });

  it("should return a valid cached result without calling an upstream provider", async () => {
    const cachedValue = {
      source: "cache",
      raw_data: { internal: "cached upstream response" },
      data: { ip: "198.51.100.0", city: "Test City" },
    };
    Object.defineProperty(cachedValue, "__proto__", {
      value: { raw_data: { internal: "poisoned cache response" } },
      enumerable: true,
    });
    const config = createConfig([createProvider("dual")], {
      response_fields: ["ip", "city"],
    });
    const context = createContext(config, { cachedValue });
    const { result, responseBody } = await context.run(async (ipinfo) => {
      const result = await ipinfo.queryIpInfoWithRetry(" 198.51.100.42 ");
      const route = ipinfo.stack.find((layer) => layer.route?.path === "/");
      const response = {
        body: null,
        json(body) {
          this.body = body;
          return this;
        },
      };
      await route.route.stack[0].handle(
        { query: { ip: "198.51.100.42" } },
        response,
      );
      return { result, responseBody: response.body };
    });

    assert.deepStrictEqual(context.cacheGetCalls, [
      "ipinfo:198.51.100.0/24",
      "ipinfo:198.51.100.0/24",
    ]);
    assert.deepStrictEqual(result, {
      source: "cache",
      data: { ip: "198.51.100.42", city: "Test City" },
    });
    assert.deepStrictEqual(responseBody, {
      source: "cache",
      data: { ip: "198.51.100.42", city: "Test City" },
    });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(result, "raw_data"),
      false,
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(responseBody, "raw_data"),
      false,
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(responseBody, "__proto__"),
      false,
    );
    assert.strictEqual(context.requestCalls.length, 0);
    assert.strictEqual(context.cacheSetCalls.length, 0);
  });

  it("should ignore malformed cache values", async () => {
    const functionValue = () => {};
    functionValue.raw_data = { internal: "invalid cache value" };
    const arrayValue = [];
    arrayValue.raw_data = { internal: "invalid cache value" };
    const inheritedSourceValue = Object.create({ source: "cache" });
    inheritedSourceValue.data = { city: "cached" };
    const malformedValues = [
      null,
      "invalid",
      arrayValue,
      functionValue,
      {
        source: "cache",
        data: [],
      },
      {
        data: { city: "cached" },
      },
      inheritedSourceValue,
      {
        source: "",
        data: { city: "cached" },
      },
      {
        source: "   ",
        data: { city: "cached" },
      },
      {
        source: 1,
        data: { city: "cached" },
      },
    ];

    for (const cachedValue of malformedValues) {
      const config = createConfig([createProvider("dual")]);
      const context = createContext(config, { cachedValue });
      const result = await context.run((ipinfo) =>
        ipinfo.queryIpInfoWithRetry("203.0.113.22"),
      );

      assert.deepStrictEqual(result, {
        source: "dual",
        data: { ip: "203.0.113.22" },
      });
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(result, "raw_data"),
        false,
      );
      assert.strictEqual(context.requestCalls.length, 1);
      assert.strictEqual(context.cacheSetCalls.length, 1);
    }
  });

  it("should share IPv6 cache entries by /48 prefix", async () => {
    const config = createConfig([createProvider("dual")]);
    const context = createContext(config);

    await context.run(async (ipinfo) => {
      await ipinfo.queryIpInfoWithRetry("2001:db8::1");
      await ipinfo.queryIpInfoWithRetry("2001:db8::2");
    });
    assert.deepStrictEqual(context.cacheGetCalls, [
      "ipinfo:2001:0db8:0000/48",
      "ipinfo:2001:0db8:0000/48",
    ]);
    assert.strictEqual(context.requestCalls.length, 2);
  });

  it("should normalize IPv6 cache keys across case and compression forms", async () => {
    const config = createConfig([createProvider("dual")]);
    const context = createContext(config);

    await context.run(async (ipinfo) => {
      await ipinfo.queryIpInfoWithRetry("2001:DB8:0:0::1");
      await ipinfo.queryIpInfoWithRetry("2001:db8::2");
    });
    assert.deepStrictEqual(context.cacheGetCalls, [
      "ipinfo:2001:0db8:0000/48",
      "ipinfo:2001:0db8:0000/48",
    ]);
  });

  it("should keep different IPv6 /48 prefixes separate", async () => {
    const config = createConfig([createProvider("dual")]);
    const context = createContext(config);

    await context.run(async (ipinfo) => {
      await ipinfo.queryIpInfoWithRetry("2001:db8::1");
      await ipinfo.queryIpInfoWithRetry("2001:db9::1");
    });
    assert.deepStrictEqual(context.cacheGetCalls, [
      "ipinfo:2001:0db8:0000/48",
      "ipinfo:2001:0db9:0000/48",
    ]);
  });

  it("should normalize dotted IPv6 forms into canonical /48 cache keys", async () => {
    const config = createConfig([createProvider("dual")]);
    const context = createContext(config);

    await context.run(async (ipinfo) => {
      await ipinfo.queryIpInfoWithRetry("::fffe:192.0.2.128");
      await ipinfo.queryIpInfoWithRetry("::ffff:0:192.0.2.128");
    });
    assert.deepStrictEqual(context.cacheGetCalls, [
      "ipinfo:0000:0000:0000/48",
      "ipinfo:0000:0000:0000/48",
    ]);
    assert.strictEqual(context.requestCalls.length, 2);
  });

  it("should reuse the /48 cache entry for a later address in the same /48", async () => {
    const config = createConfig([createProvider("dual")]);
    let context;
    context = createContext(config, {
      cacheGet: (key) => {
        for (
          let index = context.cacheSetCalls.length - 1;
          index >= 0;
          index--
        ) {
          if (context.cacheSetCalls[index].key === key) {
            return context.cacheSetCalls[index].value;
          }
        }
        return null;
      },
    });

    const result = await context.run(async (ipinfo) => {
      await ipinfo.queryIpInfoWithRetry("2001:db8::1");
      return ipinfo.queryIpInfoWithRetry("2001:db8::2");
    });

    assert.deepStrictEqual(context.cacheGetCalls, [
      "ipinfo:2001:0db8:0000/48",
      "ipinfo:2001:0db8:0000/48",
    ]);
    assert.deepStrictEqual(
      context.requestCalls.map((call) => call.url),
      ["https://dual.test/lookup?ip=2001%3Adb8%3A%3A1"],
    );
    assert.strictEqual(context.cacheSetCalls.length, 1);
    assert.deepStrictEqual(result, {
      source: "dual",
      data: { ip: "2001:db8::2" },
    });
  });

  it("should cache a successful provider response with the configured TTL", async () => {
    const config = createConfig([createProvider("dual")], { cache_ttl: 321 });
    const context = createContext(config);
    const result = await context.run((ipinfo) =>
      ipinfo.queryIpInfoWithRetry("203.0.113.21"),
    );

    assert.strictEqual(context.cacheSetCalls.length, 1);
    assert.strictEqual(context.cacheSetCalls[0].key, "ipinfo:203.0.113.0/24");
    assert.strictEqual(context.cacheSetCalls[0].ttl, 321);
    assert.deepStrictEqual(context.cacheSetCalls[0].value, result);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(result, "raw_data"),
      false,
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        context.cacheSetCalls[0].value,
        "raw_data",
      ),
      false,
    );
  });

  it("should return an upstream result when cache persistence fails", async () => {
    const config = createConfig([createProvider("dual")]);
    const context = createContext(config, {
      cacheSet() {
        throw new Error("cache unavailable");
      },
    });

    const result = await context.run((ipinfo) =>
      ipinfo.queryIpInfoWithRetry("203.0.113.45"),
    );

    assert.deepStrictEqual(result, {
      source: "dual",
      data: { ip: "203.0.113.45" },
    });
    assert.strictEqual(context.requestCalls.length, 1);
    assert.strictEqual(context.cacheSetCalls.length, 1);
  });
});
