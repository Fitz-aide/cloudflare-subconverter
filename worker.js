/**
 * 完整增强版 Worker
 * 支持环境变量 origin (通过 wrangler.toml 配置)
 * 修复了重名节点、HTML 拦截、变量丢失等问题
 */

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    const subUrl = reqUrl.searchParams.get("url");
    
    if (!subUrl) return new Response("缺少订阅地址 (?url=xxx)", { status: 400 });

    // 1. 获取 GitHub 模板 (从环境变量 origin 读取)
    const githubRawUrl = env.origin;
    if (!githubRawUrl) return new Response("环境变量 origin 未配置", { status: 500 });

    let template = "";
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const tResp = await fetch(githubRawUrl, { signal: controller.signal });
      if (!tResp.ok) throw new Error(`Status: ${tResp.status}`);
      template = await tResp.text();
      clearTimeout(timeoutId);
    } catch (e) {
      return new Response(`读取 GitHub 模板失败: ${e.message}`, { status: 500 });
    }

    // 2. 抓取并解析节点
    const urls = subUrl.split("|");
    let proxies = [];
    for (const u of urls) {
      try {
        const resp = await fetch(u.trim(), { 
          headers: { "User-Agent": "ClashMeta; Mihomo; sub-web" } 
        });
        let text = await resp.text();
        
        // 过滤 HTML
        if (!text || text.includes("<html") || text.includes("<!DOCTYPE")) continue;

        let content = text.trim();
        // 尝试解码 Base64
        try {
          if (!content.includes("://")) {
            const decoded = safeBase64Decode(content);
            if (decoded.includes("://")) content = decoded;
          }
        } catch (e) {}
        
        for (let line of content.split(/\r?\n/)) {
          line = line.trim();
          if (!line || line.startsWith("#")) continue;

          let p = null;
          if (line.startsWith("ss://")) p = parseSS(line);
          else if (line.startsWith("vless://")) p = parseVless(line);
          else if (line.startsWith("vmess://")) p = parseVmess(line);
          else if (line.startsWith("hysteria2://")) p = parseHy2(line);
          else if (line.startsWith("tuic://")) p = parseTuic(line);
          
          if (p && p.server) {
            // 防止同名节点导致 Clash 报错
            let baseName = p.name;
            let counter = 1;
            while (proxies.some(x => x.name === p.name)) {
              p.name = `${baseName} (${counter++})`;
            }
            proxies.push(p);
          }
        }
      } catch (e) {}
    }

    if (proxies.length === 0) {
      return new Response("未能解析到任何节点，请检查订阅源格式是否正确 (支持 Base64 或明文链接)", { status: 500 });
    }

    // 3. 国家分类
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

    // 4. 生成 YAML
    const finalYaml = injectProxies(template, proxies, groups);

    return new Response(finalYaml, {
      headers: { "Content-Type": "text/yaml; charset=utf-8" }
    });
  }
};

// --- 以下是辅助函数 ---

function injectProxies(template, proxies, groups) {
  let lines = template.split('\n');
  let result = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    result.push(line);

    if (line.trim() === 'proxies:') {
      proxies.forEach(p => result.push(generateProxyItem(p)));
      // 跳过模板原有示例
      while(i + 1 < lines.length && (lines[i+1].trim().startsWith('-') || lines[i+1].trim() === '')) i++;
    }

    if (line.includes('proxies:') && i > 0) {
      const prevLine = lines[i-1];
      if (prevLine.includes('JP')) fillGroup(result, groups.JP);
      else if (prevLine.includes('HK')) fillGroup(result, groups.HK);
      else if (prevLine.includes('US')) fillGroup(result, groups.US);
      else if (prevLine.includes('SG')) fillGroup(result, groups.SG);
      else if (prevLine.includes('TW')) fillGroup(result, groups.TW);
      else if (prevLine.includes('CA')) fillGroup(result, groups.CA);
      else if (prevLine.includes('自动选择') || prevLine.includes('最低延迟') || prevLine.includes('负载均衡')) {
        if (!prevLine.includes('JP') && !prevLine.includes('HK')) {
            fillGroup(result, proxies.map(p => p.name));
        }
      }
    }
  }
  return result.join('\n');
}

function fillGroup(resultArr, nameList) {
  if (nameList.length === 0) {
    resultArr.push('      - DIRECT');
  } else {
    nameList.forEach(n => resultArr.push(`      - "${n}"`));
  }
}

function generateProxyItem(p) {
  let str = `  - { name: "${p.name}", type: ${p.type}, server: ${p.server}, port: ${p.port}`;
  for (let [k, v] of Object.entries(p)) {
    if (['name', 'type', 'server', 'port'].includes(k)) continue;
    str += `, ${k}: ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`;
  }
  str += ` }`;
  return str;
}

// 协议解析器 (保持不变，已在之前的版本中给出)
function parseVless(line) { try { const url = new URL(line); const params = url.searchParams; let proxy = { name: decodeURIComponent(url.hash.slice(1)) || url.hostname, type: "vless", server: url.hostname, port: parseInt(url.port), uuid: url.username, cipher: "auto" }; const network = params.get("type") || "tcp"; proxy["network"] = network; const security = params.get("security") || "none"; proxy["tls"] = ["tls", "reality"].includes(security); if (params.has("sni")) proxy["servername"] = params.get("sni"); if (network === "ws") proxy["ws-opts"] = { path: params.get("path") || "/", headers: params.get("host") ? { Host: params.get("host") } : {} }; if (security === "reality") proxy["reality-opts"] = { "public-key": params.get("pbk") || "", "short-id": params.get("sid") || "" }; return proxy; } catch(e){return null;} }
function parseVmess(line) { try { const base64Str = line.replace("vmess://", "").trim(); const vmess = JSON.parse(safeBase64Decode(base64Str)); let proxy = { name: vmess.ps, type: "vmess", server: vmess.add, port: parseInt(vmess.port), uuid: vmess.id, alterId: parseInt(vmess.aid || 0), cipher: vmess.scy || "auto", tls: vmess.tls === "tls", network: vmess.net || "tcp" }; if (vmess.net === "ws") proxy["ws-opts"] = { path: vmess.path || "/", headers: vmess.host ? { Host: vmess.host } : {} }; return proxy; } catch(e){return null;} }
function parseSS(line) { try { const url = new URL(line); let auth = url.username; if (!auth.includes(':')) auth = safeBase64Decode(auth); const [method, password] = auth.split(':'); return { name: decodeURIComponent(url.hash.slice(1)) || url.hostname, type: "ss", server: url.hostname, port: parseInt(url.port), cipher: method, password: password }; } catch(e){return null;} }
function parseHy2(line) { try { const url = new URL(line); return { name: decodeURIComponent(url.hash.slice(1)) || url.hostname, type: "hysteria2", server: url.hostname, port: parseInt(url.port), password: url.username, udp: true }; } catch(e){return null;} }
function parseTuic(line) { try { const url = new URL(line); return { name: decodeURIComponent(url.hash.slice(1)) || url.hostname, type: "tuic", server: url.hostname, port: parseInt(url.port), uuid: url.username, password: url.password, version: 5 }; } catch(e){return null;} }

function safeBase64Decode(str) {
  try {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return decodeURIComponent(escape(atob(base64)));
  } catch (e) { return str; }
}