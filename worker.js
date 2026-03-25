/**
 * 完整可替换 Worker 版本
 * 支持 Clash.Meta 全配置 + tuic/hysteria2/vmess/vless/ss
 * 纯 origin.yaml 模板驱动版 + 自动策略分组归类
 */

// ================= 1. 核心配置区 =================
// 默认规则配置文件，默认获取环境变量DEFAULT_TEMPLATE_URL
const DEFAULT_TEMPLATE_URL = "https://raw.githubusercontent.com/你的用户名/你的仓库/main/origin.yaml"; 

// ================= 2. 策略组分类配置区 =================
// 填入需要包含【所有节点】的策略组名称
const ALL_PROXIES_GROUPS = [
  "✅节点选择", 
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
    
    // ====== 新增：提取名称参数，如果没有提供则使用默认名称 ======
    const customName = reqUrl.searchParams.get("name") || "CF-SUB";
    // 解决中文名称在 Header 中乱码的问题
    const encodedName = encodeURIComponent(customName);
    
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
	
	// ====== 新增：用于保存提取到的流量信息 ======
    let subUserInfo = "";

    for (const u of urls) {
      let text = "";
      let targetUrl = u.trim();
      try {
        // --- 1. 尝试以 Clash 身份请求 (为了拿流量信息) ---
        let resp = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Clash/1.18.0 Stash/2.5.0",
            "Accept": "*/*"
          }
        });

        // 提取流量信息
        const info = resp.headers.get("subscription-userinfo");
        if (info && !subUserInfo) subUserInfo = info;

        text = await resp.text();

        // --- 2. 检查内容：如果返回的是 YAML (包含 'proxies:') 或不是 Base64 ---
        // 这种情况下，我们需要换回 v2rayN 的 UA 重新请求纯节点列表
        if (text.includes("proxies:") || text.includes("proxy-groups:") || !isBase64(text.trim())) {
          const respRetry = await fetch(targetUrl, {
            headers: {
              "User-Agent": "v2rayN/6.23 v2ray-core/5.14.1",
              "Accept": "*/*"
            }
          });
          text = await respRetry.text();
        }
      } catch (e) {
        console.log(`节点抓取失败: ${targetUrl} ${e}`);
      }

      if (!text) continue;

      try {
        // 尝试 Base64 解码，失败则保持原样
        const decoded = atob(text.trim());
        allLines.push(...decoded.split("\n"));
      } catch {
        allLines.push(...text.split("\n"));
      }
    }

    let proxies = [];

    for (let line of allLines) {
      line = line.trim();
      if (!line) continue;

      let proxy = null;

      if (line.startsWith("vmess://")) proxy = parseVmess(line);
      else if (line.startsWith("vless://")) proxy = parseVless(line);
      else if (line.startsWith("ss://")) proxy = parseSS(line);
      else if (line.startsWith("trojan://")) proxy = parseTrojan(line);
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

    // ====== 修改：增加 Content-Disposition 和 profile-title 响应头 ======
    // --- 修改此处：智能判断是否为浏览器请求 ---
    const userAgent = (request.headers.get("User-Agent") || "").toLowerCase();
    
    // 识别浏览器 (包含 mozilla 且不包含代理客户端常用关键字)
    const isBrowser = userAgent.includes("mozilla") && 
                      !userAgent.includes("clash") && 
                      !userAgent.includes("stash") && 
                      !userAgent.includes("shadowrocket") &&
                      !userAgent.includes("surge");
	// ====== 新增：如果没有获取到，则设置默认值 (已用0，总共0，不过期) ======
    if (!subUserInfo) {
        subUserInfo = "upload=0; download=0; total=0; expire=0";
    }				  

    const responseHeaders = {
        "Content-Type": "text/yaml; charset=utf-8",
        "profile-title": customName,
        "profile-update-interval": "24",
		"subscription-userinfo": subUserInfo
    };

    // 只有非浏览器请求才加上 attachment 下载头
    if (!isBrowser) {
        responseHeaders["Content-Disposition"] = `attachment; filename*=UTF-8''${encodedName}.yaml`;
    }

    return new Response(finalYaml, {
        headers: responseHeaders
    });
  }
};

// --- 核心：生成节点 -> 注入模板 -> 按地区归类策略组 (追加模式) ---
function buildFullClash(template, proxies) {
  let proxyYaml = "proxies:\n";
  const allNames = [];
  
  // 1. 生成 proxies: 块并收集名称
  for (const p of proxies) {
    allNames.push(p.name);
    proxyYaml += `  - name: "${p.name}"\n`;
    proxyYaml += `    type: ${p.type}\n`;
    proxyYaml += `    server: ${p.server}\n`;
    proxyYaml += `    port: ${p.port}\n`;

    const skip = ['name', 'type', 'server', 'port'];
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

  let finalYaml = template;
  const proxyRegex = /proxies:[\s\S]*?(?=proxy-groups:)/;
  if (proxyRegex.test(finalYaml)) {
    finalYaml = finalYaml.replace(proxyRegex, proxyYaml + "\n");
  } else {
    finalYaml = finalYaml.replace("proxies:", proxyYaml);
  }

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

  let lines = finalYaml.split('\n');
  let newLines = [];
  let inProxyGroups = false;
  let currentGroupName = "";

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
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

    let nameMatch = line.match(/^\s*-\s*name:\s*(['"]?)(.+?)\1\s*$/);
    if (nameMatch) {
      currentGroupName = nameMatch[2];
      newLines.push(line);
      continue;
    }

    if (line.match(/^\s*proxies:\s*$/)) {
      newLines.push(line);
      let indentMatch = line.match(/^(\s*)proxies:/);
      let baseIndent = indentMatch[1];
      let itemIndent = baseIndent + "  ";

      // --- 分流逻辑开始 ---
      const isRegionGroup = regionMap[currentGroupName] !== undefined;
      const isAllGroup = ALL_PROXIES_GROUPS.includes(currentGroupName);

      // A. 如果是地区组，先插入新节点 (置顶)
      if (isRegionGroup) {
        regionMap[currentGroupName].forEach(n => newLines.push(`${itemIndent}- "${n}"`));
      }

      // B. 读取模板原有的节点 (中间层)
      let j = i + 1;
      while (j < lines.length) {
        let nextLine = lines[j];
        if (nextLine.trim() !== "" && !nextLine.startsWith(itemIndent)) break;
        if (nextLine.trim() !== "") newLines.push(nextLine);
        j++;
      }

      // C. 如果是全局组，最后插入新节点 (追加)
      if (isAllGroup) {
        allNames.forEach(n => newLines.push(`${itemIndent}- "${n}"`));
      }

      i = j - 1; 
    } else {
      newLines.push(line);
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
    const deepDecode = (str) => {
      let result = str;
      try {
        while (result.includes('%')) {
          let decoded = decodeURIComponent(result);
          if (decoded === result) break;
          result = decoded;
        }
      } catch (e) {}
      return result;
    };

    let mainPart = line.replace("ss://", "");
    let name = "";
    if (mainPart.includes("#")) {
      const splitHash = mainPart.split("#");
      mainPart = splitHash[0];
      name = deepDecode(splitHash[1]);
    }

    let method, password, server, port;

    // 情况 A：标准的 userinfo@addr 格式
    if (mainPart.includes("@")) {
      const parts = mainPart.split("@");
      let userInfo = parts[0];
      const addrPart = parts[1];

      // 核心修复：如果 userInfo 不包含冒号，说明它是 Base64 加密的
      if (!userInfo.includes(":")) {
        try {
          const b64 = userInfo.replace(/-/g, '+').replace(/_/g, '/');
          userInfo = atob(b64 + "===".slice((b64.length + 3) % 4));
        } catch (e) {}
      }

      if (userInfo.includes(":")) {
        method = userInfo.split(":")[0];
        password = userInfo.split(":").slice(1).join(":");
      }

      server = addrPart.split(":")[0];
      port = parseInt(addrPart.split(":")[1]);
    } 
    // 情况 B：全 Base64 格式 (旧版)
    else {
      try {
        const b64 = mainPart.replace(/-/g, '+').replace(/_/g, '/');
        const decodedMain = atob(b64 + "===".slice((b64.length + 3) % 4));
        if (decodedMain.includes("@")) {
          const [auth, addr] = decodedMain.split("@");
          method = auth.split(":")[0];
          password = auth.split(":").slice(1).join(":");
          server = addr.split(":")[0];
          port = parseInt(addr.split(":")[1]);
        }
      } catch (e) {}
    }

    const fixChinese = (s) => {
      try {
        return decodeURIComponent(escape(s));
      } catch (e) {
        return s;
      }
    };

    name = fixChinese(name) || server;

    if (!port || isNaN(port)) return null;

    return {
      name: name.trim().replace(/[\[\]"]/g, ''),
      type: "ss",
      server: server,
      port: port,
      cipher: method || "aes-256-gcm",
      password: password || "",
      udp: true
    };
  } catch (e) {
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

function parseTrojan(line) {
  try {
    // 1. 定义深度递归解码函数
    const deepDecode = (str) => {
      let result = str;
      try {
        while (result.includes('%')) {
          let decoded = decodeURIComponent(result);
          if (decoded === result) break;
          result = decoded;
        }
      } catch (e) {}
      return result;
    };

    // 2. 预处理：手动切分 hash 部分防止 URL 类库解析偏差
    let mainPart = line.replace("trojan://", "");
    let name = "";
    if (mainPart.includes("#")) {
      const splitHash = mainPart.split("#");
      mainPart = splitHash[0];
      name = deepDecode(splitHash[1]);
    }

    // 3. 使用 URL 类库解析主体参数
    const url = new URL("trojan://" + mainPart);
    const params = url.searchParams;

    // 4. 最后的乱码修正补丁
    const fixChinese = (s) => {
      try {
        return decodeURIComponent(escape(s));
      } catch (e) {
        return s;
      }
    };

    name = fixChinese(name) || url.hostname;

    return {
      name: name.trim().replace(/[\[\]"]/g, ''),
      type: "trojan",
      server: url.hostname,
      port: parseInt(url.port),
      password: url.username,
      udp: true,
      sni: params.get("sni") || params.get("peer") || "",
      "skip-cert-verify": ["1", "true"].includes((params.get("allowInsecure") || params.get("insecure") || "").toLowerCase()),
      network: params.get("type") || "tcp",
      "grpc-opts": params.get("type") === "grpc" ? {
        "grpc-service-name": params.get("serviceName") || ""
      } : undefined,
      "ws-opts": params.get("type") === "ws" ? {
        path: params.get("path") || "/",
        headers: params.get("host") ? { "Host": params.get("host") } : undefined
      } : undefined
    };
  } catch (e) {
    return null;
  }
}

// 判断字符串是否为 Base64 格式
function isBase64(str) {
  if (!str || str.length % 4 !== 0) return false;
  const b64Reg = /^[A-Za-z0-9+/=]+$/;
  return b64Reg.test(str);
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