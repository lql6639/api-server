const DEFAULT_TIMEOUT = 10000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

function timeoutSignal(ms) {
  return typeof AbortSignal !== "undefined" && AbortSignal.timeout
    ? AbortSignal.timeout(ms)
    : undefined;
}

async function readLimited(res, maxBytes) {
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new Error("响应内容超过限制");
  }
  return buf;
}

export async function fetchJson(url, options = {}) {
  const timeout = Number(options.timeout) || DEFAULT_TIMEOUT;
  const maxBytes = Number(options.maxBytes) || DEFAULT_MAX_BYTES;
  const signal = timeoutSignal(timeout);

  let res;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json",
        ...(options.headers || {}),
      },
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    throw new Error(`未收到来自服务器的响应`);
  }

  if (!res.ok) {
    throw new Error(`上游返回状态 ${res.status}`);
  }

  const buf = await readLimited(res, maxBytes);
  const text = new TextDecoder().decode(buf);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("上游返回内容不是合法 JSON");
  }
}

export async function fetchRaw(url, options = {}) {
  const timeout = Number(options.timeout) || DEFAULT_TIMEOUT;
  const signal = timeoutSignal(timeout);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        ...(options.headers || {}),
      },
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new Error("未收到来自服务器的响应");
  }
}

export { BROWSER_UA };
