export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    
    // 1. 暴力提取 URL (兼容 &token= 截断问题)
    let subUrl = reqUrl.searchParams.get("url") || "";
    if (!subUrl) return new Response("Missing url", { status: 400 });
    reqUrl.searchParams.forEach((value, key) => {
      if (key !== "url" && key !== "name") subUrl += `&${key}=${value}`;
    });

    // 2. 获取 GitHub 模板 (origin.yaml)
    const githubRawUrl = env.origin;
    let template = "";
    try {
      const tResp = await fetch(githubRawUrl);
      template = await tResp.text();
    } catch (e) {
      return new Response("无法读取模板，请检查环境变量 origin", { status: 500 });
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
        text = text.trim().replace(/^\uFEFF/, '');
        let content = text.includes("://") ? text : safeBase64Decode(text);

        const lines = content.split(/\r?\n/);
        for (let line of lines) {
          let p = null;
          if (line.startsWith("ss://")) p = parseSS(line);
          else if (line.startsWith("vless://")) p = parseVless(line);
          else if (line.startsWith("vmess://")) p = parseVmess(line);
          else if (line.startsWith("hysteria2://") || line.startsWith("hy2://")) p = parseHy2(line);
          else if (line.startsWith("tuic://")) p = parseTuic(line);

          if (p && p.server) {
            p.name = (p.name || `${p.type}_${p.server}`).replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s_-]/g, '');
            let baseName = p.name;
            let counter = 1;
            while (proxies.some(x => x.name === p.name)) p.name = `${baseName}_${counter++}`;
            proxies.push(p);
          }
        }
      } catch (e) {}
    }

    if (proxies.length === 0) return new Response("未能解析到节点", { status: 500 });

    // 4. 国家分类逻辑
    const groups = {
      HK: proxies.filter(p => /HK|香港|HongKong/i.test(p.name)).map(p => p.name),
      JP: proxies.filter(p => /JP|日本|Japan/i.test(p.name)).map(p => p.name),
      US: proxies.filter(p => /US|美国|United States/i.test(p.name)).map(p => p.name),
      SG: proxies.filter(p => /SG|新加坡|Singapore/i.test(p.name)).map(p => p.name),
      TW: proxies.filter(p => /TW|台湾|Taiwan/i.test(p.name)).map(p => p.name),
      ALL: proxies.map(p => p.name)
    };

    // 5. 【智能注入】核心逻辑
    const finalYaml = smartInject(template, proxies, groups);

    return new Response(finalYaml, {
      headers: { "Content-Type": "text/yaml; charset=utf-8" }
    });
  }
};

/**
 * 智能注入函数：处理 proxies 和 proxy-groups
 */
function smartInject(template, proxies, groups) {
  let lines = template.split('\n');
  let newLines = [];
  let skipOldProxies = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let trimmed = line.trim();

    // A. 处理 proxies 模块
    if (trimmed === 'proxies:') {
      newLines.push(line);
      // 将所有节点塞进去
      proxies.forEach(p => {
        newLines.push(generateClashProxy(p));
      });
      skipOldProxies = true; // 标记开始跳过原有的 example 节点
      continue;
    }

    // 如果处于跳过状态，且遇到了下一个一级配置（如 proxy-groups:），停止跳过
    if (skipOldProxies && line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
      skipOldProxies = false;
    }

    if (skipOldProxies) continue; // 跳过旧的示例节点行

    // B. 处理 proxy-groups 模块
    newLines.push(line);

    // 寻找包含 "proxies:" 的行，通常它在某个 Group 下面
    if (trimmed === 'proxies:' && i > 0) {
      // 向上查找最近的一个 - name: 来确定这是哪个组
      let groupName = "";
      for (let j = i - 1; j >= 0; j--) {
        if (lines[j].includes('- name:')) {
          groupName = lines[j].split('- name:')[1].trim().replace(/['"]/g, '');
          break;
        }
      }

      // 根据组名注入节点
      let listToInject = [];
      if (groupName.includes("香港") || groupName.includes("HK")) listToInject = groups.HK;
      else if (groupName.includes("日本") || groupName.includes("JP")) listToInject = groups.JP;
      else if (groupName.includes("美国") || groupName.includes("US")) listToInject = groups.US;
      else if (groupName.includes("新加坡") || groupName.includes("SG")) listToInject = groups.SG;
      else if (groupName.includes("台湾") || groupName.includes("TW")) listToInject = groups.TW;
      else listToInject = groups.ALL; // 默认（如 ✅节点选择）注入所有节点

      if (listToInject.length > 0) {
        listToInject.forEach(n => newLines.push(`      - "${n}"`));
      } else {
        newLines.push(`      - DIRECT`);
      }
      
      // 跳过模板中原本可能存在的示例节点行（直到遇到下一个 - name 或新块）
      while (i + 1 < lines.length && (lines[i+1].trim().startsWith('-') || lines[i+1].trim() === '')) {
        i++;
      }
    }
  }
  return newLines.join('\n');
}

function generateClashProxy(p) {
  let entries = Object.entries(p).map(([k, v]) => {
    if (k === 'name') return `name: "${v}"`;
    if (typeof v === 'string') return `${k}: ${v}`;
    return `${k}: ${JSON.stringify(v)}`;
  });
  return `  - { ${entries.join(', ')} }`;
}

// --- 基础解析与 Base64 函数 (保持不变) ---
function safeBase64Decode(str) {
  try {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return decodeURIComponent(escape(atob(base64)));
  } catch (e) { return atob(str); }
}

function parseVless(line) { try { const url = new URL(line); return { name: decodeURIComponent(url.hash.slice(1)), type: "vless", server: url.hostname, port: parseInt(url.port), uuid: url.username, cipher: "auto", tls: line.includes("tls") || line.includes("reality"), network: url.searchParams.get("type") || "tcp" }; } catch(e){return null;} }
function parseVmess(line) { try { const v = JSON.parse(safeBase64Decode(line.replace("vmess://", ""))); return { name: v.ps, type: "vmess", server: v.add, port: parseInt(v.port), uuid: v.id, alterId: parseInt(v.aid || 0), cipher: "auto", tls: !!v.tls, network: v.net || "tcp" }; } catch(e){return null;} }
function parseSS(line) { try { const url = new URL(line); let auth = safeBase64Decode(url.username); const [m, pw] = auth.split(':'); return { name: decodeURIComponent(url.hash.slice(1)), type: "ss", server: url.hostname, port: parseInt(url.port), cipher: m, password: pw }; } catch(e){return null;} }
function parseHy2(line) { try { const url = new URL(line); return { name: decodeURIComponent(url.hash.slice(1)), type: "hysteria2", server: url.hostname, port: parseInt(url.port), password: url.username, udp: true }; } catch(e){return null;} }
function parseTuic(line) { try { const url = new URL(line); return { name: decodeURIComponent(url.hash.slice(1)), type: "tuic", server: url.hostname, port: parseInt(url.port), uuid: url.username, password: url.password, version: 5 }; } catch(e){return null;} }