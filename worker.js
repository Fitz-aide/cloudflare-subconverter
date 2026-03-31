/**
 * 完整可替换 Worker 版本
 * 支持 Clash.Meta 全配置 + tuic/hysteria2/vmess/vless/ss
 * 纯 origin.yaml 模板驱动版 + 自动策略分组归类
 */

// ================= 1. 核心配置区 =================
// 默认规则配置文件，默认获取环境变量 DEFAULT_TEMPLATE_URL
const DEFAULT_TEMPLATE_URL = "https://raw.githubusercontent.com/你的用户名/你的仓库/main/origin.yaml"; 

// ================= 2. 策略组分类与动态注入配置区 =================

// 1. 地区识别关键词 (根据节点名称自动归类)
const REGIONS = [
  { prefix: "🇯🇵JP", keywords: ["JP", "Japan", "日本"] },
  { prefix: "🇭🇰HK", keywords: ["HK", "Hong", "Kong", "香港"] },
  { prefix: "🇸🇬SG", keywords: ["SG", "Singapore", "狮城", "新加坡"] },
  { prefix: "🇺🇸US", keywords: ["US", "America", "美国"] },
  { prefix: "🇹🇼TW", keywords: ["TW", "Taiwan", "台湾", "新北"] },
  { prefix: "🇨🇦CA", keywords: ["CA", "Canada", "加拿大"] },
  { prefix: "🇬🇧UK", keywords: ["UK", "United Kingdom", "英国"] }
];

// 2. 生成哪些类型的地区组 (当某地区有节点时，自动生成以下组)
const DYNAMIC_GROUP_TYPES = [
  { suffix: "最低延迟", type: "url-test", icon: "🚀" },
  { suffix: "自动切换", type: "fallback", icon: "♻️" }
];

// 3. 将【新生成的地区组】整体插在这个策略组的后面 (模板中需存在此组名)
const INSERT_AFTER_GROUP = "🅰️Adobe";

// 4. 定义需要注入【地区组】或【全部单节点】的父级组
const PARENT_GROUPS_CONFIG = [
  { target: "✅节点选择", position: "front", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: true },
  { target: "🕸GPT", position: "back", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: true },
  { target: "🎧Spotify", position: "front", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: false },
  { target: "🍎苹果", position: "front", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: false },
  { target: "🚀最低延迟", position: "front", includeTypes: [], includeAllNodes: true },
  { target: "♻️自动切换", position: "front", includeTypes: [], includeAllNodes: true },
  { target: "⚖️负载均衡", position: "front", includeTypes: [], includeAllNodes: true }
];

// ================= 3. 主逻辑处理区 =================

export default {
  async fetch(request, env) {
    let debugLog = "--- 订阅转换调试日志 ---\n"; // 初始化错误捕捉日志
    try {
      const reqUrl = new URL(request.url);
      const customName = reqUrl.searchParams.get("name") || "CF-SUB";
      const encodedName = encodeURIComponent(customName);
      const updateInterval = reqUrl.searchParams.get("interval") || "24";
      
      let subUrl = "";
      const urlMatch = reqUrl.search.match(/url=(.*)/);
      if (urlMatch) {
        subUrl = urlMatch[1];
      } else {
        return new Response("缺少订阅地址 (Missing url)", { status: 400 });
      }

      const templateUrl = (env && env.origin) ? env.origin : DEFAULT_TEMPLATE_URL;
      let template = "";
      try {
        const tResp = await fetch(templateUrl);
        if (tResp.ok) {
          template = await tResp.text();
          debugLog += `[模板] 获取成功: ${templateUrl}\n`;
        } else {
          debugLog += `[模板] 获取失败，状态码: ${tResp.status}\n`;
        }
      } catch (e) {
        debugLog += `[模板] 请求异常: ${e.message}\n`;
      }

      if (!template) {
        return new Response(`无法读取 origin.yaml 模板。\n\n${debugLog}`, { status: 500 });
      }

      const urls = subUrl.split("|");
      let allLines = [];
      let subUserInfo = "";

      for (const u of urls) {
        let text = "";
        let targetUrl = u.trim();
        debugLog += `\n[抓取] 目标: ${targetUrl}\n`;

        if (targetUrl.startsWith("http")) {
          try {
            let resp = await fetch(targetUrl, {
              headers: { "User-Agent": "Clash/1.18.0 Stash/2.5.0", "Accept": "*/*" }
            });

            debugLog += `[抓取] 初始请求状态: ${resp.status}\n`;
            const info = resp.headers.get("subscription-userinfo");
            if (info && !subUserInfo) subUserInfo = info;

            text = await resp.text();

            // 检查是否需要重新请求
            if (text.includes("proxies:") || text.includes("proxy-groups:") || !isBase64(text.trim()) || text.includes("Invalid")) {
              debugLog += `[抓取] 识别为 YAML 或非 Base64，尝试 v2rayN UA 重试...\n`;
              const respRetry = await fetch(targetUrl, {
                headers: { "User-Agent": "v2rayN/6.23 v2ray-core/5.14.1", "Accept": "*/*" }
              });
              text = await respRetry.text();
              debugLog += `[抓取] 重试请求状态: ${respRetry.status}\n`;
            }
          } catch (e) {
            debugLog += `[抓取] 失败: ${e.message}\n`;
          }
        } else {
          allLines.push(targetUrl); 
          debugLog += `[抓取] 识别为静态单行节点\n`;
        }

        if (!text) {
          debugLog += `[抓取] 警告: 未获取到任何内容\n`;
          continue;
        }

        try {
          // 处理 Base64
          const cleanText = text.trim().replace(/\s/g, '');
          const decoded = atob(cleanText);
          allLines.push(...decoded.split("\n"));
          debugLog += `[解码] Base64 解码成功，获取行数: ${decoded.split("\n").length}\n`;
        } catch (e) {
          allLines.push(...text.split("\n"));
          debugLog += `[解码] 尝试明文解析，内容前300位: ${text.substring(0, 300).replace(/\n/g, ' ')}...\n`;
        }
      }

      let proxies = [];
      for (let line of allLines) {
        line = line.trim();
        if (!line || line.length < 10) continue;

        let proxy = null;
        try {
          if (line.startsWith("vmess://")) proxy = parseVmess(line);
          else if (line.startsWith("vless://")) proxy = parseVless(line);
          else if (line.startsWith("ss://")) proxy = parseSS(line);
          else if (line.startsWith("trojan://")) proxy = parseTrojan(line);
          else if (line.startsWith("hysteria2://") || line.startsWith("hy2://")) proxy = parseHy2(line);
          else if (line.startsWith("tuic://")) proxy = parseTuic(line);

          if (proxy) {
            proxy.name = proxy.name.replace(/[\[\]"]/g, '').trim();
            proxies.push(proxy);
          }
        } catch (e) {
          // 仅单个节点解析失败不记录在 debugLog，防止日志过长
        }
      }

      debugLog += `\n[汇总] 最终有效节点总数: ${proxies.length}\n`;

      if (proxies.length === 0) {
        return new Response(`未解析到任何有效节点。\n\n${debugLog}`, { 
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          status: 500 
        });
      }

      // 以下部分保持原样逻辑
      const finalYaml = buildFullClash(template, proxies);
      const userAgent = (request.headers.get("User-Agent") || "").toLowerCase();
      const isBrowser = userAgent.includes("mozilla") && 
                        !["clash", "stash", "shadowrocket", "surge"].some(k => userAgent.includes(k));

      if (!subUserInfo) subUserInfo = "upload=0; download=0; total=0; expire=0";

      const responseHeaders = {
        "Content-Type": "text/yaml; charset=utf-8",
        "profile-title": customName,
        "profile-update-interval": updateInterval,
        "X-Config-Update-Interval": updateInterval,
        "subscription-userinfo": subUserInfo
      };

      if (!isBrowser) {
        responseHeaders["Content-Disposition"] = `attachment; filename*=UTF-8''${encodedName}.yaml`;
      }

      return new Response(finalYaml, { headers: responseHeaders });

    } catch (globalError) {
      // 全局兜底捕捉
      return new Response(`Worker 崩溃: ${globalError.message}\n\n${debugLog}`, { status: 500 });
    }
  }
};

// ================= 4. YAML 生成与注入逻辑 =================

function buildFullClash(template, proxies) {
  let proxyYaml = "proxies:\n";
  const allNames = [];
  let regionNodes = {};
  REGIONS.forEach(r => regionNodes[r.prefix] = []);

  for (const p of proxies) {
    allNames.push(p.name);
    proxyYaml += `  - name: "${p.name}"\n    type: ${p.type}\n    server: ${p.server}\n    port: ${p.port}\n`;

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

    for (let r of REGIONS) {
      if (r.keywords.some(kw => p.name.toLowerCase().includes(kw.toLowerCase()))) {
        regionNodes[r.prefix].push(p.name);
        break; 
      }
    }
  }

  let finalYaml = template;
  const proxyRegex = /proxies:[\s\S]*?(?=proxy-groups:)/;
  finalYaml = proxyRegex.test(finalYaml) ? finalYaml.replace(proxyRegex, proxyYaml + "\n") : finalYaml.replace("proxies:", proxyYaml);

  let dynamicGroupsYaml = "";
  let activeDynamicGroupsByRegion = {};

  for (const [prefix, nodes] of Object.entries(regionNodes)) {
    if (nodes.length > 0) {
      activeDynamicGroupsByRegion[prefix] = [];
      for (const t of DYNAMIC_GROUP_TYPES) {
        const groupName = `${t.icon}${prefix}${t.suffix}`;
        activeDynamicGroupsByRegion[prefix].push(groupName);
        dynamicGroupsYaml += `  - name: "${groupName}"\n    type: ${t.type}\n    url: http://cp.cloudflare.com/generate_204\n    interval: 600\n    tolerance: 300\n    proxies:\n`;
        nodes.forEach(n => dynamicGroupsYaml += `      - "${n}"\n`);
      }
    }
  }

  let lines = finalYaml.split('\n');
  let newLines = [];
  let inProxyGroups = false;
  let currentGroupName = "";
  let insideInsertTargetBlock = false;
  let dynamicGroupsInjected = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.trim() === "proxy-groups:") {
      inProxyGroups = true;
      newLines.push(line);
      continue;
    }
    if (!inProxyGroups) {
      newLines.push(line);
      continue;
    }
    if (/^[a-zA-Z]/.test(line) && !line.startsWith(" ") && line.trim() !== "proxy-groups:") {
      if (!dynamicGroupsInjected && dynamicGroupsYaml.trim() !== "") {
        newLines.push(...dynamicGroupsYaml.trimEnd().split('\n'));
        dynamicGroupsInjected = true;
      }
      inProxyGroups = false;
      newLines.push(line);
      continue;
    }

    let nameMatch = line.match(/^\s*-\s*name:\s*(['"]?)(.+?)\1\s*$/);
    if (nameMatch) {
      if (insideInsertTargetBlock && !dynamicGroupsInjected && dynamicGroupsYaml.trim()) {
        newLines.push(...dynamicGroupsYaml.trimEnd().split('\n'));
        dynamicGroupsInjected = true;
        insideInsertTargetBlock = false;
      }
      currentGroupName = nameMatch[2];
      if (currentGroupName === INSERT_AFTER_GROUP) insideInsertTargetBlock = true;
    }

    if (line.match(/^\s*proxies:\s*$/) && currentGroupName) {
      newLines.push(line);
      let indentMatch = line.match(/^(\s*)proxies:/);
      let itemIndent = indentMatch[1] + "  ";
      let targetConfig = PARENT_GROUPS_CONFIG.find(t => t.target === currentGroupName);
      let dynamicGroupsToInject = [];
      
      if (targetConfig) {
        for (const [prefix, groups] of Object.entries(activeDynamicGroupsByRegion)) {
          groups.forEach(groupName => {
            if (targetConfig.includeTypes.some(type => groupName.endsWith(type))) dynamicGroupsToInject.push(groupName);
          });
        }
      }

      if (targetConfig && targetConfig.position === "front") {
        dynamicGroupsToInject.forEach(n => newLines.push(`${itemIndent}- "${n}"`));
      }

      let j = i + 1;
      while (j < lines.length) {
        let nextLine = lines[j];
        if (nextLine.trim() !== "" && !nextLine.startsWith(itemIndent)) break;
        if (nextLine.trim() !== "") newLines.push(nextLine);
        j++;
      }
      i = j - 1; 

      if (targetConfig && targetConfig.position === "back") {
        dynamicGroupsToInject.forEach(n => newLines.push(`${itemIndent}- "${n}"`));
      }
      if (targetConfig && targetConfig.includeAllNodes) {
        allNames.forEach(n => newLines.push(`${itemIndent}- "${n}"`));
      }
      continue;
    }
    newLines.push(line);
  }

  if (insideInsertTargetBlock && !dynamicGroupsInjected && dynamicGroupsYaml.trim()) {
    newLines.push(...dynamicGroupsYaml.trimEnd().split('\n'));
  }
  return newLines.join('\n');
}

// ================= 5. 工具函数与协议解析 =================

function isBase64(str) {
  if (!str || str.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(str);
}

function safeBase64Decode(str) {
  try {
    let base = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base.length % 4) base += '=';
    return decodeURIComponent(escape(atob(base)));
  } catch { return str; }
}

function parseVless(line) {
  try {
    const url = new URL(line);
    const params = url.searchParams;
    let proxy = {
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      type: "vless", server: url.hostname, port: parseInt(url.port), uuid: url.username, cipher: "auto"
    };
    const network = params.get("type") || params.get("network") || "tcp";
    proxy["network"] = network;
    proxy["tls"] = ["tls", "reality"].includes(params.get("security") || "none");
    if (params.has("sni")) proxy["servername"] = params.get("sni");
    if (network === "ws") proxy["ws-opts"] = { path: params.get("path") || "/", headers: params.get("host") ? { "Host": params.get("host") } : undefined };
    if (network === "grpc") proxy["grpc-opts"] = { "grpc-service-name": params.get("serviceName") || "" };
    if (params.get("security") === "reality") proxy["reality-opts"] = { "public-key": params.get("pbk") || "", "short-id": params.get("sid") || "" };
    return proxy;
  } catch { return null; }
}

function parseVmess(line) {
  try {
    const vmess = JSON.parse(safeBase64Decode(line.replace("vmess://", "")));
    let proxy = {
      name: vmess.ps || "Vmess Node", type: "vmess", server: vmess.add, port: parseInt(vmess.port),
      uuid: vmess.id, alterId: parseInt(vmess.aid || 0), cipher: vmess.scy || "auto", tls: vmess.tls === "tls", network: vmess.net || "tcp"
    };
    if (vmess.net === "ws") proxy["ws-opts"] = { path: vmess.path || "/", headers: vmess.host ? { "Host": vmess.host } : undefined };
    return proxy;
  } catch { return null; }
}

function parseSS(line) {
  try {
    let main = line.replace("ss://", "");
    let name = "";
    if (main.includes("#")) {
      const parts = main.split("#");
      main = parts[0];
      name = decodeURIComponent(parts[1]);
    }
    let method, password, server, port;
    if (main.includes("@")) {
      const [user, addr] = main.split("@");
      const decodedUser = user.includes(":") ? user : atob(user.replace(/-/g, '+').replace(/_/g, '/'));
      [method, password] = decodedUser.split(":");
      [server, port] = addr.split(":");
    }
    return { name: name || server, type: "ss", server, port: parseInt(port), cipher: method, password, udp: true };
  } catch { return null; }
}

function parseHy2(line) {
  try {
    const url = new URL(line);
    const params = url.searchParams;
    return {
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      type: "hysteria2", server: url.hostname, port: parseInt(url.port), password: url.username,
      sni: params.get("sni") || undefined, obfs: params.get("obfs") || undefined, "obfs-password": params.get("obfs-password") || undefined
    };
  } catch { return null; }
}

function parseTuic(line) {
  try {
    const url = new URL(line);
    return {
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      type: "tuic", server: url.hostname, port: parseInt(url.port), version: 5, uuid: url.username, password: url.password
    };
  } catch { return null; }
}

function parseTrojan(line) {
  try {
    const parts = line.replace("trojan://", "").split("#");
    const url = new URL("trojan://" + parts[0]);
    return {
      name: decodeURIComponent(parts[1] || url.hostname),
      type: "trojan", server: url.hostname, port: parseInt(url.port), password: url.username, sni: url.searchParams.get("sni") || ""
    };
  } catch { return null; }
}