export function isIPv4(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((part) => {
    const n = Number(part);
    return n >= 0 && n <= 255 && String(n) === part.replace(/^0+(?=\d)/, "");
  });
}

export function isIPv6(value) {
  const s = String(value || "").trim();
  if (!s || !s.includes(":")) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return false;
  const doubleColonCount = (s.match(/::/g) || []).length;
  if (doubleColonCount > 1) return false;
  const groups = s.split(":").filter(Boolean);
  if (doubleColonCount === 0 && groups.length !== 8) return false;
  if (doubleColonCount === 1 && groups.length > 7) return false;
  return groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g)) || /::/.test(s);
}

export function isIP(value) {
  if (isIPv4(value)) return 4;
  if (isIPv6(value)) return 6;
  return 0;
}

export function ipv4Prefix24(ip) {
  const parts = String(ip).split(".").slice(0, 3);
  return `${parts.join(".")}.0/24`;
}

export function expandIpv6(ip) {
  const head = [];
  const tail = [];
  const doubleColon = ip.indexOf("::");
  if (doubleColon === -1) return ip.split(":");
  head.push(...ip.slice(0, doubleColon).split(":").filter(Boolean));
  tail.push(...ip.slice(doubleColon + 2).split(":").filter(Boolean));
  const missing = 8 - head.length - tail.length;
  return [...head, ...new Array(Math.max(0, missing)).fill("0"), ...tail];
}

export function ipv6Prefix48(ip) {
  const groups = expandIpv6(String(ip).toLowerCase()).map((g) =>
    g.padStart(4, "0"),
  );
  return `${groups.slice(0, 3).join(":")}/48`;
}

export function isIpv4MappedIpv6(ip) {
  if (isIP(ip) !== 6) return false;
  const s = String(ip).toLowerCase();
  return /^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s) ||
    /^::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);
}

// Cloudflare 边缘会带 CF-Connecting-IP，本地开发退化为 X-Forwarded-For
export function getClientIp(request) {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "127.0.0.1";
}

export function normalizeCityForMatch(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\s,，]/g, "")
    .replace(/[省市]/g, "");
}

export function createCityLookup(items, valueField) {
  const exact = new Map();
  let maxNameLength = 0;
  items.forEach((item) => {
    const name = String(item?.name || "").trim();
    const value = String(item?.[valueField] || "").trim();
    if (!name || !value) return;
    const variants = new Set([name, normalizeCityForMatch(name)]);
    variants.forEach((variant) => {
      if (!variant) return;
      if (!exact.has(variant)) exact.set(variant, value);
      maxNameLength = Math.max(maxNameLength, variant.length);
    });
  });
  return { exact, maxNameLength };
}

export function findIdByTailMatch(name, lookup) {
  const raw = String(name ?? "").trim();
  if (!raw) return "";

  const base2 = normalizeCityForMatch(raw);
  const base3 = base2.replace(/区$/g, "").replace(/市$/g, "");
  const bases = [raw, base2, base3].filter(Boolean);

  for (const base of bases) {
    if (lookup.exact.has(base)) return lookup.exact.get(base);
  }
  for (const base of bases) {
    const maxLen = Math.min(4, base.length);
    for (let len = 2; len <= maxLen; len++) {
      const cand = base.slice(-len);
      if (lookup.exact.has(cand)) return lookup.exact.get(cand);
    }
  }
  for (const base of bases) {
    const maxLength = Math.min(base.length, lookup.maxNameLength);
    for (let length = maxLength; length >= 1; length--) {
      const candidate = base.slice(-length);
      if (lookup.exact.has(candidate)) return lookup.exact.get(candidate);
    }
  }
  return "";
}
