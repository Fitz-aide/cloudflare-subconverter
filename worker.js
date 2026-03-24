export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    let subUrl = reqUrl.searchParams.get("url") || "";
    if (!subUrl) return new Response("缺少订阅地址", { status: 400 });

    // 处理被截断的 URL
    reqUrl.searchParams.forEach((value, key) => {
      if (key !== "url" && key !== "name") subUrl += `&${key}=${value}`;
    });

    // 1. 获取 origin.yaml 模板
    const githubRawUrl = env.origin;
    let template = "";
    try {
      const tResp = await fetch(githubRawUrl);
      template = await tResp.text();
    } catch (e) {
      return new Response("无法读取 origin.yaml，请检查环境变量", { status: 500 });
    }

    // 2. 抓取并解析节点
    const urls = subUrl.split("|");
    let proxies = [];
    for (const u of urls) {
      try {
        const resp = await fetch(u.trim(), {
          headers: { "User-Agent": "ClashMeta" }
        });
        let text = await resp.text();
        text = text.trim().replace(/^\uFEFF/, '');
        let content = text.includes("://") ? text : safeBase64Decode(text);

        content.split(/\r?\n/).forEach(line => {
          let p = null;
          if (line.startsWith("ss://")) p = parseSS(line);
          else if (line.startsWith("vless://")) p = parseVless(line);
          else if (line.startsWith("vmess://")) p = parseVmess(line);
          else if (line.startsWith("hysteria2://") || line.startsWith("hy2://")) p = parseHy2(line);
          else if (line.startsWith("tuic://")) p = parseTuic(line);

          if (p && p.server) {
            // 清理节点名中的非法字符，防止破坏 YAML 结构
            p.name = p.name.replace(/[\[\]]/g, '').trim();
            proxies.push(p);
          }
        });
      } catch (e) {}
    }

    if (proxies.length === 0) return new Response("未解析到任何有效节点", { status: 500 });

    // 3. 定义分类逻辑
    const filter = (regex) => proxies.filter(p => regex.test(p.name)).map(p => p.name);
    
    const groups = {
      HK: filter(/HK|香港|HongKong|🇭🇰/i),
      JP: filter(/JP|日本|Japan|🇯🇵/i),
      US: filter(/US|美国|States|🇺🇸/i),
      SG: filter(/SG|新加坡|Singapore|🇸🇬/i),
      TW: filter(/TW|台湾|Taiwan|🇹🇼/i),
      CA: filter(/CA|加拿大|Canada|🇨🇦/i),
      ALL: proxies.map(p => p.name)
    };

    // 4. 执行智能注入
    const finalYaml = injectToTemplate(template, proxies, groups);

    return new Response(finalYaml, {
      headers: { "Content-Type": "text/yaml; charset=utf-8" }
    });
  }
};

/**
 * 注入函数：精准识别底层组并填充
 */
function injectToTemplate(template, proxies, groups) {
  let lines = template.split('\n');
  let result = [];
  let currentGroupName = "";
  let isInsideProxiesBlock = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let trimmed = line.trim();

    // A. 替换全局 proxies 列表
    if (trimmed === "proxies:" || trimmed === "proxies: # 这里的内容会被替换") {
      result.push("proxies:");
      proxies.forEach(p => {
        result.push(generateProxyLine(p));
      });
      // 跳过模板里原本自带的 example 节点
      while (i + 1 < lines.length && (lines[i+1].trim().startsWith("-") || lines[i+1].trim() === "")) {
        i++;
      }
      continue;
    }

    // B. 处理策略组内部
    if (trimmed.startsWith("- name:")) {
      currentGroupName = trimmed.split(":")[1].trim().replace(/['"]/g, "");
    }

    result.push(line);

    // C. 寻找底层策略组的空 proxies 标记进行填充
    if (trimmed === "proxies:" && i > 0) {
      // 只有当这一组的下面没有定义任何节点时，我们才填充
      const nextLine = (i + 1 < lines.length) ? lines[i+1].trim() : "";
      
      // 判断该组名属于哪个分类，填充对应节点
      let listToFill = [];
      if (currentGroupName.includes("HK")) listToFill = groups.HK;
      else if (currentGroupName.includes("JP")) listToFill = groups.JP;
      else if (currentGroupName.includes("US")) listToFill = groups.US;
      else if (currentGroupName.includes("SG")) listToFill = groups.SG;
      else if (currentGroupName.includes("TW")) listToFill = groups.TW;
      else if (currentGroupName.includes("CA")) listToFill = groups.CA;
      else if (currentGroupName.includes("自动切换") || currentGroupName.includes("最低延迟") || currentGroupName.includes("负载均衡")) {
        listToFill = groups.ALL;
      }

      // 如果找到了对应的节点列表，且当前处于模板中该组的 proxies: 位置
      // 注意：如果模板里已经手动写了节点（如 ✅节点选择 里的那些），nextLine 就不为空，我们跳过填充
      if (listToFill.length > 0 && nextLine === "") {
        listToFill.forEach(name => {
          result.push(`      - "${name}"`);
        });
      }
    }
  }
  return result.join('\n');
}

function generateProxyLine(p) {
  let fields = [`name: "${p.name}"`, `type: ${p.type}`, `server: ${p.server}`, `port: ${p.port}`];
  if (p.uuid) fields.push(`uuid: ${p.uuid}`);
  if (p.cipher) fields.push(`cipher: ${p.cipher}`);
  if (p.password) fields.push(`password: "${p.password}"`);
  if (p.tls !== undefined) fields.push(`tls: ${p.tls}`);
  if (p.network) fields.push(`network: ${p.network}`);
  if (p.aid !== undefined) fields.push(`alterId: ${p.aid}`);
  if (p["ws-opts"]) fields.push(`ws-opts: ${JSON.stringify(p["ws-opts"])}`);
  return `  - { ${fields.join(", ")} }`;
}

// --- 通用工具函数 ---
function safeBase64Decode(str) {
  try {
    let b = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return decodeURIComponent(escape(atob(b)));
  } catch (e) { return ""; }
}

function parseSS(l) { try { const u = new URL(l); const auth = safeBase64Decode(u.username).split(':'); return { name: decodeURIComponent(u.hash.slice(1)), type: "ss", server: u.hostname, port: u.port, cipher: auth[0], password: auth[1] }; } catch(e){return null;} }
function parseVmess(l) { try { const v = JSON.parse(safeBase64Decode(l.replace("vmess://", ""))); return { name: v.ps, type: "vmess", server: v.add, port: v.port, uuid: v.id, aid: v.aid, tls: !!v.tls, network: v.net }; } catch(e){return null;} }
function parseVless(l) { try { const u = new URL(l); return { name: decodeURIComponent(u.hash.slice(1)), type: "vless", server: u.hostname, port: u.port, uuid: u.username, tls: l.includes("tls"), network: u.searchParams.get("type") || "tcp" }; } catch(e){return null;} }
function parseHy2(l) { try { const u = new URL(l); return { name: decodeURIComponent(u.hash.slice(1)), type: "hysteria2", server: u.hostname, port: u.port, password: u.username }; } catch(e){return null;} }
function parseTuic(l) { try { const u = new URL(l); return { name: decodeURIComponent(u.hash.slice(1)), type: "tuic", server: u.hostname, port: u.port, uuid: u.username, password: u.password }; } catch(e){return null;} }