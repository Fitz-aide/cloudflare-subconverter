/**
 * 完整可替换 Worker 版本
 * 支持 Clash.Meta 全配置 + tuic/hysteria2/vmess/vless/ss
 * 模板注入版 (带基础配置兜底)
 */

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    
    // 修复：暴力提取 url= 后面的所有内容，防止带有 & 的参数被错误截断
    let subUrl = "";
    const urlMatch = reqUrl.search.match(/url=(.*)/);
    if (urlMatch) {
      subUrl = urlMatch[1];
    } else {
      return new Response("Missing url", { status: 400 });
    }

    const name = reqUrl.searchParams.get("name") || "SUB";

    if (!subUrl) {
      return new Response("Missing url", { status: 400 });
    }

    // --- 新增逻辑：获取 origin.yaml 模板 ---
    let template = "";
    if (env && env.origin) {
      try {
        const tResp = await fetch(env.origin);
        if (tResp.ok) {
          template = await tResp.text();
        }
      } catch (e) {
        console.log(`Fetch template failed: ${e}`);
      }
    }

    // 支持多订阅地址，用 | 分隔
    const urls = subUrl.split("|");
    let allLines = [];

    for (const u of urls) {
      let text = "";
      try {
        const resp = await fetch(u, {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "*/*",
            "Referer": u
          }
        });
        text = await resp.text();
      } catch (e) {
        console.log(`Fetch failed: ${u} ${e}`);
      }

      if (!text) continue;

      // 尝试 Base64 解码
      try {
        text = atob(text.trim());
      } catch {}
      allLines.push(...text.split("\n"));
    }

    let proxies = [];

    for (let line of allLines) {
      line = line.trim();
      if (!line) continue;

      let proxy = null;

      if (line.startsWith("vmess://")) proxy = parseVmess(line);
      else if (line.startsWith("vless://")) proxy = parseVless(line);
      else if (line.startsWith("ss://")) proxy = parseSS(line);
      else if (line.startsWith("hysteria2://")) proxy = parseHy2(line);
      else if (line.startsWith("tuic://")) proxy = parseTuic(line);

      if (!proxy) continue;
      
      // 清理节点名中的非法字符，防止破坏 YAML 结构
      proxy.name = proxy.name.replace(/[\[\]]/g, '').trim();
      proxies.push(proxy);
    }

    if (proxies.length === 0) {
      return new Response("未解析到任何有效节点", { status: 500 });
    }

    // --- 核心分支：如果有模板则注入，否则用基础版 ---
    let finalYaml = "";
    if (template) {
      finalYaml = injectProxies(template, proxies);
    } else {
      finalYaml = buildFullClash(proxies);
    }

    return new Response(finalYaml, {
      headers: { "Content-Type": "text/yaml; charset=utf-8" }
    });
  }
};

// --- 新增函数：注入节点到模板 ---
function injectProxies(template, proxies) {
  let proxyYaml = "proxies:\n";
  
  // 完全复用你 buildFullClash 里面久经考验的 YAML 生成逻辑
  for (const p of proxies) {
    proxyYaml += `  - name: "${p.name}"\n`;
    proxyYaml += `    type: ${p.type}\n`;
    proxyYaml += `    server: ${p.server}\n`;
    proxyYaml += `    port: ${p.port}\n`;

    const skip = ['name', 'type', 'server', 'port', '_country'];
    
    for (const [key, value] of Object.entries(p)) {
      if (skip.includes(key) || value === null || value === undefined) continue;
      
      if (typeof value === 'object' && !Array.isArray(value)) {
        proxyYaml += `    ${key}:\n`;
        for (const [k2, v2] of Object.entries(value)) {
          if (typeof v2 === 'object') { 
            proxyYaml += `      ${k2}:\n`;
            for (const [k3, v3] of Object.entries(v2)) {
              proxyYaml += `        ${k3}: "${v3}"\n`;
            }
          } else {
            proxyYaml += `      ${k2}: ${typeof v2 === 'string' ? `"${v2}"` : v2}\n`;
          }
        }
      } else if (Array.isArray(value)) {
        proxyYaml += `    ${key}: [${value.map(v => `"${v}"`).join(",")}]\n`;
      } else {
        proxyYaml += `    ${key}: ${typeof value === 'string' ? `"${value}"` : value}\n`;
      }
    }
  }

  // 正则替换：从 proxies: 开始，一直替换到 proxy-groups: 之前
  const regex = /proxies:[\s\S]*?(?=proxy-groups:)/;
  if (regex.test(template)) {
    return template.replace(regex, proxyYaml + "\n");
  } else {
    // 容错：如果模板里没有 proxy-groups:，就直接找 proxies: 替换
    return template.replace("proxies:", proxyYaml);
  }
}

// -------------------- 以下为你原本的函数，完全保持不变 --------------------

// 构建完整 Clash.Meta YAML (兜底使用)
function buildFullClash(proxies) {
  let yaml = `port: 7890
socks-port: 7891
mixed-port: 7892
allow-lan: false
mode: rule
log-level: info
ipv6: false
unified-delay: true
tcp-concurrent: true
global-client-fingerprint: chrome

dns:
  enable: true
  listen: ':53'
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
  fallback:
    - https://1.1.1.1/dns-query

proxies:
`;

  for (const p of proxies) {
    yaml += `  - name: "${p.name}"\n`;
    yaml += `    type: ${p.type}\n`;
    yaml += `    server: ${p.server}\n`;
    yaml += `    port: ${p.port}\n`;

    const skip = ['name', 'type', 'server', 'port', '_country'];
    
    for (const [key, value] of Object.entries(p)) {
      if (skip.includes(key) || value === null || value === undefined) continue;
      
      if (typeof value === 'object' && !Array.isArray(value)) {
        yaml += `    ${key}:\n`;
        for (const [k2, v2] of Object.entries(value)) {
          if (typeof v2 === 'object') { 
            yaml += `      ${k2}:\n`;
            for (const [k3, v3] of Object.entries(v2)) {
              yaml += `        ${k3}: "${v3}"\n`;
            }
          } else {
            yaml += `      ${k2}: ${typeof v2 === 'string' ? `"${v2}"` : v2}\n`;
          }
        }
      } else if (Array.isArray(value)) {
        yaml += `    ${key}: [${value.map(v => `"${v}"`).join(",")}]\n`;
      } else {
        yaml += `    ${key}: ${typeof value === 'string' ? `"${value}"` : value}\n`;
      }
    }
  }

  const allProxyNames = proxies.map(p => p.name);

  yaml += "\nproxy-groups:\n";
  yaml += buildGroup("🚀 节点选择", "select", ["♻️ 自动选择", ...allProxyNames]);
  yaml += buildGroup("♻️ 自动选择", "url-test", allProxyNames);

  yaml += `
rules:
  - DOMAIN-SUFFIX,local,DIRECT
  - IP-CIDR,192.168.0.0/16,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,🚀 节点选择
`;

  return yaml;
}

function buildGroup(name, type, proxyList) {
  let str = `  - name: "${name}"\n    type: ${type}\n`;
  if (type === "url-test") {
    str += `    url: http://www.gstatic.com/generate_204\n    interval: 300\n`;
  }
  str += `    proxies:\n`;
  for (const p of proxyList) {
    str += `      - "${p}"\n`;
  }
  return str;
}

function parseVless(line) {
  try {
    const url = new URL(line);
    const params = url.searchParams;

    let proxy = {
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      type: "vless",
      server: url.hostname,
      port: parseInt(url.port),
      uuid: url.username,
      cipher: "auto"
    };

    const udpParam = params.get("udp");
    proxy["udp"] = udpParam === null ? true : !["0", "false", "off", "no"].includes(udpParam.toLowerCase());

    const network = params.get("type") || params.get("network") || "tcp";
    proxy["network"] = network;
    const security = params.get("security") || "none";
    proxy["tls"] = ["tls", "reality"].includes(security);

    if (params.has("sni")) proxy["servername"] = params.get("sni");
    const allow = params.get("allowInsecure");
    proxy["skip-cert-verify"] = allow === null ? false : ["1", "true"].includes(allow.toLowerCase());

    if (proxy.tls) proxy["packet-encoding"] = "xudp";
    const flow = params.get("flow") || "";
    if (flow) {
      proxy["flow"] = flow;
      if (flow === "xtls-rprx-vision") proxy["packet-encoding"] = "xudp";
    }

    if (proxy.tls && params.has("fp")) proxy["client-fingerprint"] = params.get("fp");

    if (network === "ws") {
      let ws_opts = { path: params.get("path") || "/" };
      const host = params.get("host") || params.get("Host");
      if (host) ws_opts.headers = { "Host": host };
      proxy["ws-opts"] = ws_opts;
    }

    if (network === "grpc") {
      proxy["grpc-opts"] = { "grpc-service-name": params.get("serviceName") || params.get("service_name") || "" };
    }

    if (security === "reality") {
      proxy["reality-opts"] = {
        "public-key": params.get("pbk") || "",
        "short-id": params.get("sid") || params.get("shortid") || ""
      };
    }

    return proxy;
  } catch (e) { return null; }
}

function parseVmess(line) {
  try {
    const base64Str = line.replace("vmess://", "").trim();
    const jsonStr = safeBase64Decode(base64Str);
    const vmess = JSON.parse(jsonStr);

    let proxy = {
      name: decodeURIComponent(vmess.ps || "Vmess Node"),
      type: "vmess",
      server: vmess.add,
      port: parseInt(vmess.port),
      uuid: vmess.id,
      alterId: parseInt(vmess.aid || 0),
      cipher: vmess.scy || "auto",
      udp: String(vmess.udp || "true").toLowerCase() === "true",
      tls: vmess.tls === "tls",
      network: vmess.net || "tcp"
    };

    if (vmess.net === "ws") {
      const path = vmess["ws-path"] || vmess.path || "/";
      let ws_headers_src = null;

      if (vmess["ws-headers"] && typeof vmess["ws-headers"] === 'object') {
        ws_headers_src = vmess["ws-headers"];
      } else if (vmess.headers && typeof vmess.headers === 'object') {
        ws_headers_src = vmess.headers;
      } else if (vmess.host) {
        ws_headers_src = { "Host": vmess.host };
      }

      let ws_opts = { path: path };
      if (ws_headers_src) ws_opts.headers = { ...ws_headers_src };
      proxy["ws-opts"] = ws_opts;
    }

    if (vmess.net === "grpc") {
      proxy["grpc-opts"] = { "grpc-service-name": vmess.path || "" };
    }

    if (proxy.tls && vmess.sni) proxy.servername = vmess.sni;

    return proxy;
  } catch (e) {
    return null;
  }
}

function parseSS(line) {
  try {
    const url = new URL(line);
    let method, password, server, port;

    server = url.hostname;
    port = parseInt(url.port);
    const name = decodeURIComponent(url.hash.slice(1)) || server;

    let authStr = url.username; 
    
    if (authStr && !authStr.includes(':')) {
      try {
        authStr = safeBase64Decode(authStr);
      } catch (e) {}
    }

    if (authStr && authStr.includes(':')) {
      const parts = authStr.split(':');
      method = parts[0];
      password = parts.slice(1).join(':'); 
    } else {
      method = url.username || "unknown-method";
      password = url.password || "";
    }

    return {
      name: name,
      type: "ss",
      server: server,
      port: port,
      cipher: method,
      password: password,
      udp: true
    };
  } catch (e) {
    console.error("SS Parse Error:", e);
    return null;
  }
}

function parseHy2(line) {
  try {
    const url = new URL(line);
    const params = url.searchParams;

    let proxy = {
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      type: "hysteria2",
      server: url.hostname,
      port: parseInt(url.port),
      password: url.username,
      udp: true,
      "skip-cert-verify": ["1", "true"].includes((params.get("insecure") || "").toLowerCase())
    };

    if (params.has("sni")) proxy.sni = params.get("sni");
    if (params.has("obfs")) proxy.obfs = params.get("obfs");
    const obfsPw = params.get("obfs-password") || params.get("obfsPassword");
    if (obfsPw) proxy["obfs-password"] = obfsPw;
    if (params.has("alpn")) proxy.alpn = params.get("alpn").split(",");
    if (params.has("upmbps")) proxy.up = parseInt(params.get("upmbps"));
    if (params.has("downmbps")) proxy.down = parseInt(params.get("downmbps"));

    return proxy;
  } catch (e) { return null; }
}

function parseTuic(line) {
  try {
    const url = new URL(line);
    const params = url.searchParams;

    return {
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      type: "tuic",
      server: url.hostname,
      port: parseInt(url.port),
      version: 5,
      uuid: url.username,
      password: url.password,
      "skip-cert-verify": ["1", "true"].includes((params.get("insecure") || "").toLowerCase()),
      sni: params.get("sni") || "",
      alpn: params.get("alpn") ? params.get("alpn").split(",") : [],
      "congestion-controller": params.get("congestion_control") || "cubic",
      "udp-relay-mode": params.get("udp_relay_mode") || "native"
    };
  } catch (e) { return null; }
}

function safeBase64Decode(str) {
  try {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    return decodeURIComponent(escape(atob(base64)));
  } catch (e) {
    return str; 
  }
}