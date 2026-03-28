/**
 * 完整可替换 Worker 版本
 * 支持 Clash.Meta 全配置 + tuic/hysteria2/vmess/vless/ss
 * 纯 origin.yaml 模板驱动版 + 自动策略分组归类
 */

// ================= 1. 核心配置区 =================
// 默认规则配置文件，默认获取环境变量DEFAULT_TEMPLATE_URL
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
// target: 模板中已有的目标策略组
// position: "front" (插在前面) 或 "back" (插在后面)
// includeTypes: 包含哪些动态组后缀
// includeAllNodes: 是否要把所有单节点追加到末尾 (相当于取代原来的 ALL_PROXIES_GROUPS)
const PARENT_GROUPS_CONFIG = [
  { target: "✅节点选择", position: "front", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: true },
  { target: "🕸GPT", position: "back", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: true },
  { target: "🎧Spotify", position: "front", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: false },
  { target: "🍎苹果", position: "front", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: false },
  { target: "🚀最低延迟", position: "front", includeTypes: [], includeAllNodes: true },
  { target: "♻️自动切换", position: "front", includeTypes: [], includeAllNodes: true },
  { target: "⚖️负载均衡", position: "front", includeTypes: [], includeAllNodes: true }
];
// =======================================================

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    
    // ====== 新增：提取名称参数，如果没有提供则使用默认名称 ======
    const customName = reqUrl.searchParams.get("name") || "CF-SUB";
    // 解决中文名称在 Header 中乱码的问题
    const encodedName = encodeURIComponent(customName);
	
    // ====== 新增：提取更新间隔参数（单位：小时），默认 24 小时 ======
    const updateInterval = reqUrl.searchParams.get("interval") || "24";
    
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
	  if (targetUrl.startsWith("http")) {
        // 如果是链接，执行 fetch 抓取
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
      } else {
        // 如果不是链接，直接当做原始节点文本处理
        allLines.push(targetUrl); 
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
        "profile-update-interval": updateInterval,
        "X-Config-Update-Interval": updateInterval,
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

// --- 核心：生成节点 -> 动态生成地区组 -> 智能注入模板 ---
function buildFullClash(template, proxies) {
  let proxyYaml = "proxies:\n";
  const allNames = [];
  let regionNodes = {};
  REGIONS.forEach(r => regionNodes[r.prefix] = []);

  // 1. 生成 proxies: 块并收集名称与地区分类
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

    // 地区分类归纳
    for (let r of REGIONS) {
      if (r.keywords.some(kw => p.name.toLowerCase().includes(kw.toLowerCase()))) {
        regionNodes[r.prefix].push(p.name);
        break; 
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

  // 2. 【核心修改】动态生成地区组 YAML (按地区归类：日本最低、日本自动、香港最低、香港自动...)
  let dynamicGroupsYaml = "";
  let activeDynamicGroupsByRegion = {}; // 存储每个地区生成的组

  for (const [prefix, nodes] of Object.entries(regionNodes)) {
    if (nodes.length > 0) {
      activeDynamicGroupsByRegion[prefix] = [];
      
      for (const t of DYNAMIC_GROUP_TYPES) {
        const groupName = `${t.icon}${prefix}${t.suffix}`;
        activeDynamicGroupsByRegion[prefix].push(groupName);

        dynamicGroupsYaml += `  - name: "${groupName}"\n`;
        dynamicGroupsYaml += `    type: ${t.type}\n`;
        dynamicGroupsYaml += `    url: http://cp.cloudflare.com/generate_204\n`;
        dynamicGroupsYaml += `    interval: 600\n`;
        dynamicGroupsYaml += `    tolerance: 300\n`;
        dynamicGroupsYaml += `    proxies:\n`;
        nodes.forEach(n => dynamicGroupsYaml += `      - "${n}"\n`);
      }
    }
  }

  // 3. 逐行处理 proxy-groups，精准注入
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
       if (insideInsertTargetBlock && !dynamicGroupsInjected && dynamicGroupsYaml.trim() !== "") {
          newLines.push(...dynamicGroupsYaml.trimEnd().split('\n'));
          dynamicGroupsInjected = true;
          insideInsertTargetBlock = false;
       }
       currentGroupName = nameMatch[2];
       if (currentGroupName === INSERT_AFTER_GROUP) {
          insideInsertTargetBlock = true;
       }
    }

    if (line.match(/^\s*proxies:\s*$/) && currentGroupName) {
       newLines.push(line);
       let indentMatch = line.match(/^(\s*)proxies:/);
       let itemIndent = indentMatch[1] + "  ";

       let targetConfig = PARENT_GROUPS_CONFIG.find(t => t.target === currentGroupName);
       let dynamicGroupsToInject = [];
       
       if (targetConfig) {
          // 【核心修改】读取配置，按地区顺序绑定吐出
          for (const [prefix, groups] of Object.entries(activeDynamicGroupsByRegion)) {
             groups.forEach(groupName => {
                 // 检查这个组名的后缀（最低延迟/自动切换）是否在配置的 includeTypes 中
                 const hasType = targetConfig.includeTypes.some(type => groupName.endsWith(type));
                 if (hasType) {
                     dynamicGroupsToInject.push(groupName);
                 }
             });
          }
       }

       // A. 插入前面 (front)
       if (targetConfig && targetConfig.position === "front") {
           dynamicGroupsToInject.forEach(n => newLines.push(`${itemIndent}- "${n}"`));
       }

       // B. 读取并保留模板原有的代理 (比如 DIRECT 或写死的全局组)
       let j = i + 1;
       while (j < lines.length) {
         let nextLine = lines[j];
         if (nextLine.trim() !== "" && !nextLine.startsWith(itemIndent)) break;
         if (nextLine.trim() !== "") newLines.push(nextLine);
         j++;
       }
       i = j - 1; 

       // C. 插入后面 (back)
       if (targetConfig && targetConfig.position === "back") {
           dynamicGroupsToInject.forEach(n => newLines.push(`${itemIndent}- "${n}"`));
       }

       // D. 在末尾追加所有单节点 (原本的 ALL_PROXIES_GROUPS 逻辑)
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