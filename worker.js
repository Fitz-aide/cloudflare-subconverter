/**
 * 完整可替换 Worker 版本
 * 支持 Clash.Meta 全配置 + tuic/hysteria2/vmess/vless/ss
 */

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    const subUrl = reqUrl.searchParams.get("url");
    
    if (!subUrl) return new Response("Missing url (请在 URL 后添加 ?url=订阅地址)", { status: 400 });

    // 1. 获取 GitHub 模板 URL (优先从环境变量读取)
    const githubRawUrl = env.origin || "https://raw.githubusercontent.com/xxxx/cloudflare-subconverter/refs/heads/main/origin.yaml";
    
    let template = "";
    try {
      // 添加较短的超时处理，防止 GitHub 响应过慢导致整个请求挂掉
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时
      
      const tResp = await fetch(githubRawUrl, { signal: controller.signal });
      if (!tResp.ok) throw new Error(`Status: ${tResp.status}`);
      template = await tResp.text();
      clearTimeout(timeoutId);
    } catch (e) {
      return new Response(`无法读取 GitHub 模板: ${e.message}`, { status: 500 });
    }

    // 2. 抓取并解析节点
    const urls = subUrl.split("|");
    let proxies = [];
    for (const u of urls) {
      try {
        const resp = await fetch(u.trim(), { 
          headers: { "User-Agent": "ClashMeta; Mihomo; Clash-verge" } 
        });
        
        let text = await resp.text();
        if (!text || text.includes("<html")) continue;

        // 智能 Base64 处理
        let content = text.trim();
        try {
          // 只有看起来像 Base64 且不包含协议头时才解码
          if (!content.includes("://")) {
            const decoded = safeBase64Decode(content);
            if (decoded.includes("://")) content = decoded;
          }
        } catch (e) {
          // 解码失败则直接使用原文本（可能是明文链接列表）
        }
        
        const lines = content.split(/\r?\n/);
        for (let line of lines) {
          line = line.trim();
          if (!line || line.startsWith("#")) continue; // 跳过空行和注释
          
          let p = null;
          if (line.startsWith("ss://")) p = parseSS(line);
          else if (line.startsWith("vless://")) p = parseVless(line);
          else if (line.startsWith("vmess://")) p = parseVmess(line);
          else if (line.startsWith("hysteria2://")) p = parseHy2(line);
          else if (line.startsWith("tuic://")) p = parseTuic(line);
          
          if (p && p.server && p.port) {
            // 防止重名
            let originalName = p.name;
            let counter = 1;
            while (proxies.some(x => x.name === p.name)) {
              p.name = `${originalName}_${counter++}`;
            }
            proxies.push(p);
          }
        }
      } catch (e) {
        console.error("Fetch error:", e);
      }
    }

    // 如果没有任何节点，给出一个最基础的占位节点，防止 Clash 报错打不开
    if (proxies.length === 0) {
      proxies.push({
        name: "⚠️未检测到有效节点-请检查订阅链接",
        type: "ss",
        server: "1.1.1.1",
        port: 80,
        cipher: "aes-128-gcm",
        password: "password"
      });
    }

    // 3. 动态处理：按国家分类（用于填充你的模板分组）
    const groups = { HK: [], JP: [], US: [], SG: [], TW: [], CA: [] };
    proxies.forEach(p => {
      const name = p.name.toUpperCase();
      if (name.includes("HK") || name.includes("香港")) groups.HK.push(p.name);
      else if (name.includes("JP") || name.includes("日本")) groups.JP.push(p.name);
      else if (name.includes("US") || name.includes("美国")) groups.US.push(p.name);
      else if (name.includes("SG") || name.includes("新加坡")) groups.SG.push(p.name);
      else if (name.includes("TW") || name.includes("台湾")) groups.TW.push(p.name);
      else if (name.includes("CA") || name.includes("加拿大")) groups.CA.push(p.name);
    });

    // 4. 组装最终 YAML
    let finalYaml = injectProxies(template, proxies, groups);

    return new Response(finalYaml, {
      headers: { "Content-Type": "text/yaml; charset=utf-8" }
    });
  }
};

// 注入函数：找到模板中的关键位置并替换
function injectProxies(template, proxies, groups) {
  let lines = template.split('\n');
  let result = [];
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    result.push(line);

    // 在 proxies: 标签下插入所有节点
    if (line.trim() === 'proxies:') {
      proxies.forEach(p => {
        result.push(generateProxyItem(p));
      });
      // 跳过模板中原本自带的 example 节点（如果有的话）
      while(i + 1 < lines.length && (lines[i+1].startsWith('  -') || lines[i+1].trim() === '')) i++;
    }

    // 自动填充国家分组
    if (line.includes('proxies:') && i > 0) {
      const prevLine = lines[i-1];
      // 匹配模板中的分组名，如 "name: 🚀🇯🇵JP最低延迟"
      if (prevLine.includes('JP')) fillGroup(result, groups.JP);
      else if (prevLine.includes('HK')) fillGroup(result, groups.HK);
      else if (prevLine.includes('US')) fillGroup(result, groups.US);
      else if (prevLine.includes('SG')) fillGroup(result, groups.SG);
      else if (prevLine.includes('TW')) fillGroup(result, groups.TW);
      else if (prevLine.includes('CA')) fillGroup(result, groups.CA);
      else if (prevLine.includes('自动选择') || prevLine.includes('最低延迟') || prevLine.includes('负载均衡')) {
        if (!prevLine.includes('JP') && !prevLine.includes('HK')) { // 全局组
            fillGroup(result, proxies.map(p => p.name));
        }
      }
    }
  }
  return result.join('\n');
}

function fillGroup(resultArr, nameList) {
  if (nameList.length === 0) {
    resultArr.push('      - DIRECT'); // 如果没节点，回退到直连
  } else {
    nameList.forEach(n => resultArr.push(`      - "${n}"`));
  }
}

function generateProxyItem(p) {
  // 这里复用你之前的对象转 YAML 字符串逻辑，注意缩进是 2 个空格
  let str = `  - { name: "${p.name}", type: ${p.type}, server: ${p.server}, port: ${p.port}`;
  // 简化的 inline 格式，或者你可以用你之前的多行格式
  for (let [k, v] of Object.entries(p)) {
    if (['name', 'type', 'server', 'port'].includes(k)) continue;
    str += `, ${k}: ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`;
  }
  str += ` }`;
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