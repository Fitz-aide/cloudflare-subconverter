/**
 * 融合修复版：GitHub 模板支持 + 暴力 URL 提取逻辑
 */

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    
    // 1. 【完美提取 URL】：自动拼合被意外截断的参数，无需正则，兼容性 100%
    let subUrl = reqUrl.searchParams.get("url");
    if (!subUrl) {
      return new Response("Missing url (请在 URL 后添加 ?url=订阅地址)", { status: 400 });
    }
    
    // 重新拼回带有 & 的参数（例如 &token=srvuhzdj），同时排除 worker 自己的参数
    reqUrl.searchParams.forEach((value, key) => {
      if (key !== "url" && key !== "name") {
        subUrl += `&${key}=${value}`;
      }
    });

    const name = reqUrl.searchParams.get("name") || "SUB";

    // 支持多订阅地址，用 | 分隔
    const urls = subUrl.split("|");
    let allLines = [];

    for (const u of urls) {
      let text = "";
      try {
        const resp = await fetch(u.trim(), {
          headers: {
            "User-Agent": "ClashMeta; Mihomo", // 伪装客户端防屏蔽
            "Accept": "*/*",
            "Referer": u
          }
        });
        text = await resp.text();
      } catch (e) {
        console.log(`Fetch failed: ${u} ${e}`);
        continue;
      }

      if (!text || text.includes("<html")) continue;

      // 2. 【核心修复】：使用兼容性极强的 safeBase64Decode 替代原生 atob
      try {
        // 先判断是否已经是明文协议，如果不是再尝试解码
        if (!text.includes("://")) {
          const decoded = safeBase64Decode(text.trim());
          if (decoded.includes("://")) {
            text = decoded;
          }
        }
      } catch (e) {}

      allLines.push(...text.split(/\r?\n/));
    }

    let proxies = [];
    for (let line of allLines) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;

      let proxy = null;
      if (line.startsWith("vmess://")) proxy = parseVmess(line);
      else if (line.startsWith("vless://")) proxy = parseVless(line);
      else if (line.startsWith("ss://")) proxy = parseSS(line);
      else if (line.startsWith("hysteria2://")) proxy = parseHy2(line);
      else if (line.startsWith("tuic://")) proxy = parseTuic(line);

      if (!proxy) continue;
      
      proxies.push(proxy);
    }

    // 调试反馈：如果确实没抓到，给个提示
    if (proxies.length === 0) {
      return new Response("未能解析到任何有效节点，请检查机场订阅链接是否可用。", { status: 500 });
    }

    // 3. 抓取并解析节点
    const urls = subUrl.split("|");
    let proxies = [];
    
    for (const u of urls) {
      try {
        const resp = await fetch(u.trim(), {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        let text = await resp.text();
        if (!text || text.includes("<html")) continue;

        // 尝试 Base64 解码 (采用旧版简单的 atob 逻辑进行初筛)
        let content = text.trim();
        try {
          content = safeBase64Decode(content);
        } catch (e) {
          // 解码失败说明可能是明文，保持原样
        }

        const lines = content.split(/\r?\n/);
        for (let line of lines) {
          line = line.trim();
          if (!line || line.startsWith("#")) continue;

          let p = null;
          if (line.startsWith("ss://")) p = parseSS(line);
          else if (line.startsWith("vless://")) p = parseVless(line);
          else if (line.startsWith("vmess://")) p = parseVmess(line);
          else if (line.startsWith("hysteria2://")) p = parseHy2(line);
          else if (line.startsWith("tuic://")) p = parseTuic(line);

          if (p && p.server) {
            // 防止同名节点
            let baseName = p.name;
            let counter = 1;
            while (proxies.some(x => x.name === p.name)) {
              p.name = `${baseName}_${counter++}`;
            }
            proxies.push(p);
          }
        }
      } catch (e) {}
    }

    if (proxies.length === 0) {
      return new Response("Error: 未能解析到有效节点。请确保订阅链接返回的是 Base64 或明文标准协议。", { status: 500 });
    }

    // 4. 按国家分类（用于填充模板分组）
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

    // 5. 注入到模板并返回
    const finalYaml = injectProxies(template, proxies, groups);
    return new Response(finalYaml, {
      headers: { "Content-Type": "text/yaml; charset=utf-8" }
    });
  }
};

// --- 辅助工具函数 ---

function injectProxies(template, proxies, groups) {
  let lines = template.split('\n');
  let result = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    result.push(line);

    if (line.trim() === 'proxies:') {
      proxies.forEach(p => result.push(generateProxyItem(p)));
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

// 协议解析器
function parseVless(line) { try { const url = new URL(line); const params = url.searchParams; let p = { name: decodeURIComponent(url.hash.slice(1)) || url.hostname, type: "vless", server: url.hostname, port: parseInt(url.port), uuid: url.username, cipher: "auto", tls: url.search.includes("tls") || url.search.includes("reality"), network: params.get("type") || "tcp" }; if (params.has("sni")) p.servername = params.get("sni"); if (p.network === "ws") p["ws-opts"] = { path: params.get("path") || "/", headers: { Host: params.get("host") || "" } }; if (url.search.includes("reality")) p["reality-opts"] = { "public-key": params.get("pbk") || "", "short-id": params.get("sid") || "" }; return p; } catch(e){return null;} }
function parseVmess(line) { try { const v = JSON.parse(safeBase64Decode(line.replace("vmess://", ""))); return { name: v.ps, type: "vmess", server: v.add, port: parseInt(v.port), uuid: v.id, alterId: parseInt(v.aid || 0), cipher: "auto", tls: v.tls === "tls", network: v.net || "tcp" }; } catch(e){return null;} }
function parseSS(line) { try { const url = new URL(line); let auth = safeBase64Decode(url.username); const [m, pw] = auth.split(':'); return { name: decodeURIComponent(url.hash.slice(1)), type: "ss", server: url.hostname, port: parseInt(url.port), cipher: m, password: pw }; } catch(e){return null;} }
function parseHy2(line) { try { const url = new URL(line); return { name: decodeURIComponent(url.hash.slice(1)), type: "hysteria2", server: url.hostname, port: parseInt(url.port), password: url.username, udp: true }; } catch(e){return null;} }
function parseTuic(line) { try { const url = new URL(line); return { name: decodeURIComponent(url.hash.slice(1)), type: "tuic", server: url.hostname, port: parseInt(url.port), uuid: url.username, password: url.password, version: 5 }; } catch(e){return null;} }

function safeBase64Decode(str) {
  try {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return decodeURIComponent(escape(atob(base64)));
  } catch (e) {
    return atob(str); // 兜底使用原始 atob
  }
}