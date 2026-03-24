export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    
    // 1. 暴力提取并重新拼合 URL (保持你的逻辑)
    let subUrl = reqUrl.searchParams.get("url") || "";
    if (!subUrl) return new Response("Missing url", { status: 400 });
    
    reqUrl.searchParams.forEach((value, key) => {
      if (key !== "url" && key !== "name") subUrl += `&${key}=${value}`;
    });

    // 2. 抓取模板
    const githubRawUrl = env.origin;
    let template = "";
    try {
      const tResp = await fetch(githubRawUrl);
      template = await tResp.text();
    } catch (e) {
      return new Response("无法读取模板，请检查环境变量 origin", { status: 500 });
    }

    // 3. 开始抓取订阅
    const urls = subUrl.split("|");
    let proxies = [];
    
    for (const u of urls) {
      try {
        const resp = await fetch(u.trim(), {
          headers: { 
            // 模拟最常见的浏览器，防止被机场拦截
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "*/*"
          }
        });

        if (!resp.ok) continue;
        let text = await resp.text();
        
        // 核心修复：清理可能存在的不可见字符 (BOM头、空格等)
        text = text.trim().replace(/^\uFEFF/, '');

        let content = text;
        // 如果内容不包含 :// 协议头，说明是 Base64
        if (!text.includes("://")) {
          try {
            content = safeBase64Decode(text);
          } catch (e) {
            console.log("Base64 Decode Failed");
          }
        }

        const lines = content.split(/\r?\n/);
        for (let line of lines) {
          line = line.trim();
          if (!line || line.startsWith("#")) continue;

          let p = null;
          if (line.startsWith("ss://")) p = parseSS(line);
          else if (line.startsWith("vless://")) p = parseVless(line);
          else if (line.startsWith("vmess://")) p = parseVmess(line);
          else if (line.startsWith("hysteria2://") || line.startsWith("hy2://")) p = parseHy2(line);
          else if (line.startsWith("tuic://")) p = parseTuic(line);

          if (p && p.server) {
            // 确保节点名不为空
            p.name = p.name || `${p.type}_${p.server.slice(0,4)}`;
            
            // 防止同名
            let baseName = p.name;
            let counter = 1;
            while (proxies.some(x => x.name === p.name)) {
              p.name = `${baseName}_${counter++}`;
            }
            proxies.push(p);
          }
        }
      } catch (e) {
        console.log(`Fetch Error: ${e.message}`);
      }
    }

    // 4. 如果还是没节点，返回抓取到的原始内容作为调试 (这一步很关键！)
    if (proxies.length === 0) {
      return new Response(`Error: 未能解析到有效节点。\n可能原因：1.机场封锁了CF IP 2.链接失效\n\n请尝试直接访问你的订阅链接，看是否有内容返回。`, { status: 500 });
    }

    // 5. 分组注入 (保持你的逻辑)
    const groups = { HK: [], JP: [], US: [], SG: [], TW: [], CA: [] };
    proxies.forEach(p => {
      const n = p.name.toUpperCase();
      if (n.includes("HK") || n.includes("香港")) groups.HK.push(p.name);
      else if (n.includes("JP") || n.includes("日本")) groups.JP.push(p.name);
      else if (n.includes("US") || n.includes("美国")) groups.US.push(p.name);
      else if (n.includes("SG") || n.includes("新加坡")) groups.SG.push(p.name);
      else if (n.includes("TW") || n.includes("台湾")) groups.TW.push(p.name);
      else if (n.includes("CA") || n.includes("加拿大")) groups.CA.push(p.name);
    });

    const finalYaml = injectProxies(template, proxies, groups);
    return new Response(finalYaml, {
      headers: { "Content-Type": "text/yaml; charset=utf-8" }
    });
  }
};

// --- 适配性更强的工具函数 ---

function safeBase64Decode(str) {
  try {
    // 替换 URL 安全字符并补齐等号
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return decodeURIComponent(escape(atob(base64)));
  } catch (e) {
    // 如果上面失败，尝试最原始的 atob
    try {
      return atob(str);
    } catch (e2) {
      return str; 
    }
  }
}

// 极其宽容的 Vmess 解析器
function parseVmess(line) {
  try {
    const b64 = line.replace("vmess://", "").trim();
    const jsonStr = safeBase64Decode(b64);
    const v = JSON.parse(jsonStr);
    return {
      name: v.ps || "Vmess_Node",
      type: "vmess",
      server: v.add,
      port: parseInt(v.port),
      uuid: v.id,
      alterId: parseInt(v.aid || 0),
      cipher: "auto",
      tls: !!(v.tls && v.tls !== "none"),
      network: v.net || "tcp",
      "ws-opts": v.net === "ws" ? { path: v.path || "/", headers: { Host: v.host || "" } } : undefined
    };
  } catch(e){ return null; }
}

// 其余解析器（保持精简）
function parseVless(line) { try { const url = new URL(line); return { name: decodeURIComponent(url.hash.slice(1)) || "Vless_Node", type: "vless", server: url.hostname, port: parseInt(url.port), uuid: url.username, cipher: "auto", tls: line.includes("tls") || line.includes("reality"), network: url.searchParams.get("type") || "tcp" }; } catch(e){return null;} }
function parseSS(line) { try { const url = new URL(line); let auth = safeBase64Decode(url.username); const [m, pw] = auth.split(':'); return { name: decodeURIComponent(url.hash.slice(1)), type: "ss", server: url.hostname, port: parseInt(url.port), cipher: m, password: pw }; } catch(e){return null;} }
function parseHy2(line) { try { const url = new URL(line); return { name: decodeURIComponent(url.hash.slice(1)), type: "hysteria2", server: url.hostname, port: parseInt(url.port), password: url.username, udp: true }; } catch(e){return null;} }
function parseTuic(line) { try { const url = new URL(line); return { name: decodeURIComponent(url.hash.slice(1)), type: "tuic", server: url.hostname, port: parseInt(url.port), uuid: url.username, password: url.password, version: 5 }; } catch(e){return null;} }

function injectProxies(template, proxies, groups) {
  let lines = template.split('\n');
  let result = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    result.push(line);
    if (line.trim() === 'proxies:') {
      proxies.forEach(p => {
        let str = `  - { name: "${p.name}", type: ${p.type}, server: ${p.server}, port: ${p.port}`;
        if (p.uuid) str += `, uuid: ${p.uuid}`;
        if (p.cipher) str += `, cipher: ${p.cipher}`;
        if (p.password) str += `, password: ${p.password}`;
        if (p.tls !== undefined) str += `, tls: ${p.tls}`;
        if (p.network) str += `, network: ${p.network}`;
        if (p["ws-opts"]) str += `, ws-opts: ${JSON.stringify(p["ws-opts"])}`;
        str += ` }`;
        result.push(str);
      });
      while(i + 1 < lines.length && (lines[i+1].trim().startsWith('-') || lines[i+1].trim() === '')) i++;
    }
    if (line.includes('proxies:') && i > 0) {
      const prevLine = lines[i-1];
      const match = ['JP','HK','US','SG','TW','CA'].find(c => prevLine.includes(c));
      if (match) fillGroup(result, groups[match]);
      else if (prevLine.includes('自动选择') || prevLine.includes('节点')) fillGroup(result, proxies.map(p => p.name));
    }
  }
  return result.join('\n');
}

function fillGroup(resultArr, nameList) {
  if (!nameList || nameList.length === 0) resultArr.push('      - DIRECT');
  else nameList.forEach(n => resultArr.push(`      - "${n}"`));
}