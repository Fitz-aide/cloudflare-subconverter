/**
 * 完整可替换 Worker 版本
 * 支持 Clash.Meta 全配置 + tuic/hysteria2/vmess/vless/ss
 * 防封架构，自动分组
 */

export default {
  async fetch(request) {
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
    let nameCounter = {};

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
	  
      proxies.push(proxy);
    }

    return new Response(buildFullClash(proxies), {
      headers: { "Content-Type": "text/yaml; charset=utf-8" }
    });
  }
};


// 构建完整 Clash.Meta YAML
// 构建完整 Clash.Meta YAML
function buildFullClash(proxies) {
  // 基础配置头部
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

  // 1. 动态生成 Proxy 节点
  for (const p of proxies) {
    yaml += `  - name: "${p.name}"\n`;
    yaml += `    type: ${p.type}\n`;
    yaml += `    server: ${p.server}\n`;
    yaml += `    port: ${p.port}\n`;

    // 定义需要跳过处理的基础字段
    const skip = ['name', 'type', 'server', 'port', '_country'];
    
    for (const [key, value] of Object.entries(p)) {
      if (skip.includes(key) || value === null || value === undefined) continue;
      
      if (typeof value === 'object' && !Array.isArray(value)) {
        // 处理一级对象 (如 ws-opts, reality-opts)
        yaml += `    ${key}:\n`;
        for (const [k2, v2] of Object.entries(value)) {
          if (typeof v2 === 'object') { 
            // 处理二级对象 (如 headers)
            yaml += `      ${k2}:\n`;
            for (const [k3, v3] of Object.entries(v2)) {
              yaml += `        ${k3}: "${v3}"\n`;
            }
          } else {
            yaml += `      ${k2}: ${typeof v2 === 'string' ? `"${v2}"` : v2}\n`;
          }
        }
      } else if (Array.isArray(value)) {
        // 处理数组 (如 alpn)
        yaml += `    ${key}: [${value.map(v => `"${v}"`).join(",")}]\n`;
      } else {
        // 处理普通字段
        yaml += `    ${key}: ${typeof value === 'string' ? `"${value}"` : value}\n`;
      }
    }
  }

  // 获取所有节点名称用于策略组
  const allProxyNames = proxies.map(p => p.name);

  // 2. 生成策略组
  yaml += "\nproxy-groups:\n";
  // 默认主选择组
  yaml += buildGroup("🚀 节点选择", "select", ["♻️ 自动选择", ...allProxyNames]);
  // 自动延迟测试组
  yaml += buildGroup("♻️ 自动选择", "url-test", allProxyNames);

  // 3. 规则部分
  yaml += `
rules:
  - DOMAIN-SUFFIX,local,DIRECT
  - IP-CIDR,192.168.0.0/16,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,🚀 节点选择
`;

  return yaml;
}

// 构建组辅助函数
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

// -------------------- 协议解析示例 --------------------
// 这里只写简化示例，你可以自己替换成 parse_to_clash 的完整逻辑

// 解析 VLESS (标准 URI 格式)
// 示例: vless://uuid@server:port?encryption=none&security=tls&sni=xxx&type=ws#name
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

    // UDP
    const udpParam = params.get("udp");
    proxy["udp"] = udpParam === null ? true : !["0", "false", "off", "no"].includes(udpParam.toLowerCase());

    // Network & Security
    const network = params.get("type") || params.get("network") || "tcp";
    proxy["network"] = network;
    const security = params.get("security") || "none";
    proxy["tls"] = ["tls", "reality"].includes(security);

    // SNI & Skip-Cert-Verify
    if (params.has("sni")) proxy["servername"] = params.get("sni");
    const allow = params.get("allowInsecure");
    proxy["skip-cert-verify"] = allow === null ? false : ["1", "true"].includes(allow.toLowerCase());

    // Packet-Encoding & Flow
    if (proxy.tls) proxy["packet-encoding"] = "xudp";
    const flow = params.get("flow") || "";
    if (flow) {
      proxy["flow"] = flow;
      if (flow === "xtls-rprx-vision") proxy["packet-encoding"] = "xudp";
    }

    // Fingerprint
    if (proxy.tls && params.has("fp")) proxy["client-fingerprint"] = params.get("fp");

    // WS & gRPC & Reality
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

// 解析 VMESS (Base64 JSON 格式)
// 示例: vmess://ey... (base64 encoded json)
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

    // 1. 获取基础信息
    server = url.hostname;
    port = parseInt(url.port);
    const name = decodeURIComponent(url.hash.slice(1)) || server;

    // 2. 核心：处理 Base64 认证部分
    // userInfo 可能是明文 "method:pass" 或者 Base64 后的内容
    let authStr = url.username; 
    
    // 如果 username 看起来像 Base64，尝试解码它
    if (authStr && !authStr.includes(':')) {
      try {
        authStr = safeBase64Decode(authStr);
      } catch (e) {
        // 如果解码失败，保持原样
      }
    }

    // 3. 拆分加密方式和密码
    if (authStr && authStr.includes(':')) {
      const parts = authStr.split(':');
      method = parts[0];
      // 处理某些格式下密码后可能带有的额外信息
      password = parts.slice(1).join(':'); 
    } else {
      // 容错处理：如果仍然无法解析，返回原样便于排查
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

// 安全 Base64 解码
function safeBase64Decode(str) {
  try {
    // 1. 替换 URL 安全字符
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    // 2. 补全 padding
    while (base64.length % 4) {
      base64 += '=';
    }
    // 3. 解决中文 UTF-8 乱码问题
    return decodeURIComponent(escape(atob(base64)));
  } catch (e) {
    return str; // 解析失败则返回原字符串
  }
}