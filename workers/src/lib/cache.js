// Workers 无 Redis：热数据走 isolate 内存，冷数据走 Cache API（边缘节点级共享）
const memory = new Map();

function cacheRequest(key) {
  return new Request(`https://cache.internal/${encodeURIComponent(key)}`);
}

export async function cacheGet(key) {
  const local = memory.get(key);
  if (local && (local.exp === 0 || local.exp > Date.now())) {
    return local.value;
  }
  if (local) memory.delete(key);

  try {
    const res = await caches.default.match(cacheRequest(key));
    if (!res) return null;
    const body = await res.json();
    if (body && body.exp && body.exp <= Date.now()) return null;
    const value = body ? body.value : null;
    if (value !== null && value !== undefined) {
      memory.set(key, { value, exp: body.exp || 0 });
    }
    return value;
  } catch {
    return null;
  }
}

export async function cacheSet(key, value, ttlSeconds) {
  const ttl = Number(ttlSeconds) > 0 ? Number(ttlSeconds) : 0;
  const exp = ttl > 0 ? Date.now() + ttl * 1000 : 0;
  memory.set(key, { value, exp });

  try {
    await caches.default.put(
      cacheRequest(key),
      new Response(JSON.stringify({ value, exp }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": ttl > 0 ? `max-age=${ttl}` : "no-store",
        },
      }),
    );
  } catch {
    // 缓存写入失败不影响主流程
  }
}

// 同 isolate 内的并发去重
const inflight = new Map();

export function dedupe(key, factory) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const task = Promise.resolve()
    .then(factory)
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}
