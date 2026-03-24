/**
 * 完整可替换 Worker 版本
 * 支持 Clash.Meta 全配置 + tuic/hysteria2/vmess/vless/ss
 * 纯 origin.yaml 模板驱动版 + 自动策略分组归类
 */

// ================= 1. 核心配置区 =================
const DEFAULT_TEMPLATE_URL = "https://raw.githubusercontent.com/你的用户名/你的仓库/main/origin.yaml"; 

// ================= 2. 策略组分类配置区 =================
// 填入需要包含【所有节点】的策略组名称
const ALL_PROXIES_GROUPS = [
  "🌎社媒", 
  "🕸GPT", 
  "🎧Spotify", 
  "🚀最低延迟", 
  "♻️自动切换", 
  "⚖️负载均衡"
];

// 填入地区匹配规则：keywords 是匹配节点名称的关键词，groups 是目标策略组名称
const REGION_RULES = [
  { keywords: ["HK", "Hong", "Kong", "香港"], groups: ["🚀🇭🇰HK最低延迟", "♻️🇭🇰HK自动切换"] },
  { keywords: ["JP", "Japan", "日本"], groups: ["🚀🇯🇵JP最低延迟", "♻️🇯🇵JP自动切换"] },
  { keywords: ["SG", "Singapore", "狮城", "新加坡"], groups: ["🚀🇸🇬SG最低延迟", "♻️🇸🇬SG自动切换"] },
  { keywords: ["TW", "Taiwan", "台湾", "新北"], groups: ["🚀🇹🇼TW最低延迟", "♻️🇹🇼TW自动切换"] },
  { keywords: ["US", "America", "美国"], groups: ["🚀🇺🇸US最低延迟", "♻️🇺🇸US自动切换"] },
  { keywords: ["CA", "Canada", "加拿大"], groups: ["🚀🇨🇦CA最低延迟", "♻️🇨🇦CA自动切换"] },
  { keywords: ["UK", "United Kingdom", "英国"], groups: ["🚀🇬🇧UK最低延迟", "♻️🇬🇧UK自动切换"] }
];
// =======================================================

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    
    let subUrl = "";
    const urlMatch = reqUrl.search.match(/url=(.*)/);
    if (urlMatch) {
      subUrl = urlMatch[1];
    } else {
      return new Response("缺少订阅地址 (Missing url)", { status: 400 });
    }

    if (!subUrl) return new Response("缺少订阅地址", { status: 400 });

    const templateUrl = (env && env.origin) ? env.origin : DEFAULT_TEMPLATE_URL;
    let template = "";
    try {
      const tResp = await fetch(templateUrl);
      if (tResp.ok) {
        template = await tResp.text();
      }
    } catch (e) {
      console.log(`模板拉取失败: ${e}`);
    }

    if (!template) {
      return new Response("无法读取 origin.yaml 模板，请检查链接是否正确或公开访问权限。", { status: 500 });
    }

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
        console.log(`节点抓取失败: ${u} ${e}`);
      }

      if (!text) continue;

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
      else if (line.startsWith("hysteria2://") || line.startsWith("hy2://")) proxy = parseHy2(line);
      else if (line.startsWith("tuic://")) proxy = parseTuic(line);

      if (!proxy) continue;
      
      // 清理非法字符并去除双引号，防止 YAML 语法断裂
      proxy.name = proxy.name.replace(/[\[\]"]/g, '').trim();
      proxies.push(proxy);
    }

    if (proxies.length === 0) {
      return new Response("未解析到任何有效节点，请检查订阅地址", { status: 500 });
    }

    // 执行核心的注入与分类逻辑
    const finalYaml = buildFullClash(template, proxies);

    return new Response(finalYaml, {
      headers: { "Content-Type": "text/yaml; charset=utf-8" }
    });
  }
};

// --- 核心：生成节点 -> 注入模板 -> 按地区归类策略组 (追加模式) ---
function buildFullClash(template, proxies) {
  let proxyYaml = "proxies:\n";
  const allNames = [];
  
  // 1. 生成 proxies: 块并收集所有节点名称
  for (const p of proxies) {
    allNames.push(p.name);
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

  // 2. 替换原模板中的 proxies 块
  let finalYaml = template;
  const proxyRegex = /proxies:[\s\S]*?(?=proxy-groups:)/;
  if (proxyRegex.test(finalYaml)) {
    finalYaml = finalYaml.replace(proxyRegex, proxyYaml + "\n");
  } else {
    finalYaml = finalYaml.replace("proxies:", proxyYaml);
  }

  // 3. 准备地区匹配数据
  let regionMap = {};
  for (const rule of REGION_RULES) {
    for (const group of rule.groups) {
      regionMap[group] = [];
    }
  }

  for (const name of allNames) {
    for (const rule of REGION_RULES) {
      if (rule.keywords.some(kw => name.toLowerCase().includes(kw.toLowerCase()))) {
        rule.groups.forEach(g => regionMap[g].push(name));
        break; 
      }
    }
  }

  // 4. 逐行解析模板，执行“追加”逻辑
  let lines = finalYaml.split('\n');
  let newLines = [];
  let inProxyGroups = false;
  let currentGroupName = "";
  let groupProxiesBuffer = []; // 用于临时存放检测到的策略组内容

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // 检查是否进入/退出 proxy-groups
    if (line.trim() === "proxy-groups:") {
      inProxyGroups = true;
      newLines.push(line);
      continue;
    }
    if (inProxyGroups && /^[a-zA-Z]/.test(line.trim()) && !line.startsWith(" ") && line.trim() !== "proxy-groups:") {
      inProxyGroups = false;
    }

    if (!inProxyGroups) {
      newLines.push(line);
      continue;
    }

    // 提取组名
    let nameMatch = line.match(/^\s*-\s*name:\s*(['"]?)(.+?)\1\s*$/);
    if (nameMatch) {
      currentGroupName = nameMatch[2];
      newLines.push(line);
      continue;
    }

    // 核心逻辑：碰到下一个策略组的开始 (-) 或者块结束，才把 buffer 里的节点插进去
    // 但为了简单稳定，我们直接定位到当前组的 proxies: 块并寻找它的结束位置
    newLines.push(line);

    // 如果当前行是 "proxies:"，我们向后扫描，直到找到下一个不再缩进的行
    if (line.match(/^\s*proxies:\s*$/)) {
      let indentMatch = line.match(/^(\s*)proxies:/);
      let baseIndent = indentMatch[1];
      let itemIndent = baseIndent + "  ";

      // 继续读取后续行，直到遇到不属于当前 proxies 列表的内容
      let j = i + 1;
      while (j < lines.length) {
        let nextLine = lines[j];
        // 如果下一行是空行，或者是更浅缩进的行，或者是新的 group (-)
        if (nextLine.trim() !== "" && !nextLine.startsWith(itemIndent)) {
          break;
        }
        newLines.push(nextLine);
        j++;
      }
      
      // 在这里插入新节点（此时已达到原列表末尾）
      if (ALL_PROXIES_GROUPS.includes(currentGroupName)) {
        allNames.forEach(n => newLines.push(`${itemIndent}- "${n}"`));
      } else if (regionMap[currentGroupName]) {
        regionMap[currentGroupName].forEach(n => newLines.push(`${itemIndent}- "${n}"`));
      }

      i = j - 1; // 跳过已处理的行
    }
  }

  return newLines.join('\n');
}

// -------------------- 协议解析区 (保持不变) --------------------

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