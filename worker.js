/**
 * 完整可替换 Worker 版本
 * 支持 Clash.Meta 全配置 + tuic/hysteria2/vmess/vless/ss
 * 纯 origin.yaml 模板驱动版 + 自动策略分组归类
 */

// ================= 1. 核心配置区 =================
// 默认的底层规则模板地址。如果没有在 Cloudflare 环境变量中设置 'origin'，则默认抓取此地址的 YAML 文件。
const DEFAULT_TEMPLATE_URL = "https://raw.githubusercontent.com/你的用户名/你的仓库/main/origin.yaml"; 

// ================= 2. 策略组分类与动态注入配置区 =================

// 1. 地区识别关键词配置
// 遍历抓取到的节点名称，包含 keywords 中的字眼就会被归类到对应的 prefix 前缀下。
const REGIONS = [
  { prefix: "🇯🇵JP", keywords: ["JP", "Japan", "日本"] },
  { prefix: "🇭🇰HK", keywords: ["HK", "Hong", "Kong", "香港"] },
  { prefix: "🇸🇬SG", keywords: ["SG", "Singapore", "狮城", "新加坡"] },
  { prefix: "🇺🇸US", keywords: ["US", "America", "美国"] },
  { prefix: "🇹🇼TW", keywords: ["TW", "Taiwan", "台湾", "新北"] },
  { prefix: "🇨🇦CA", keywords: ["CA", "Canada", "加拿大"] },
  { prefix: "🇬🇧UK", keywords: ["UK", "United Kingdom", "英国"] }
];

// 2. 动态策略组生成规则
// 如果检测到上方某个地区有节点（例如有日本节点），就会自动生成 "🇯🇵JP最低延迟" 和 "🇯🇵JP自动切换" 两个策略组。
const DYNAMIC_GROUP_TYPES = [
  { suffix: "最低延迟", type: "url-test", icon: "🚀" }, // 自动测速选择最低延迟节点
  { suffix: "自动切换", type: "fallback", icon: "♻️" } // 节点故障时按顺序自动切换
];

// 3. 锚点策略组
// 脚本在修改模板时，会将上面新生成的动态地区组，整块插入到模板原有的这个组名之后。
const INSERT_AFTER_GROUP = "🅰️Adobe";

// 4. 父级策略组注入配置
// 定义如何将生成的地区组或所有单节点填入模板已有的策略组中。
// target: 模板中存在的组名
// position: 插入位置 (front 在最前面, back 在最后面)
// includeTypes: 包含哪些动态生成的地区组类型
// includeAllNodes: 是否要把所有抓取到的单个节点名称也全塞进去
const PARENT_GROUPS_CONFIG = [
  { target: "✅节点选择", position: "front", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: true },
  { target: "🤖AI", position: "back", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: true },
  { target: "🎧Spotify", position: "front", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: false },
  { target: "🍎苹果", position: "front", includeTypes: ["最低延迟", "自动切换"], includeAllNodes: false },
  { target: "🚀最低延迟", position: "front", includeTypes: [], includeAllNodes: true },
  { target: "♻️自动切换", position: "front", includeTypes: [], includeAllNodes: true },
  { target: "⚖️负载均衡", position: "front", includeTypes: [], includeAllNodes: true }
];

// ================= 3. 主逻辑处理区 =================

export default {
  async fetch(request, env) {
    let debugLog = "--- 订阅转换调试日志 ---\n"; // 初始化调试日志，抓取失败时会返回此内容方便排错
    try {
      // 获取用户请求的 URL 及其参数
      const reqUrl = new URL(request.url);
      const customName = reqUrl.searchParams.get("name") || "CF-SUB"; // 客户端显示的配置文件名称
      const encodedName = encodeURIComponent(customName);
      const updateInterval = reqUrl.searchParams.get("interval") || "24"; // 客户端默认更新间隔(小时)
      
      // 提取目标机场订阅地址 (支持通过 | 分割多个订阅)
      let subUrl = "";
      const urlMatch = reqUrl.search.match(/url=(.*)/);
      if (urlMatch) {
        subUrl = urlMatch[1];
      } else {
        return new Response("缺少订阅地址 (Missing url)", { status: 400 });
      }

      // 确定模板 URL，优先使用 Cloudflare 环境变量，其次使用默认配置
      const templateUrl = (env && env.origin) ? env.origin : DEFAULT_TEMPLATE_URL;
      let template = "";
      // 尝试获取 origin.yaml 模板
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

      // 处理多订阅合并逻辑
      const urls = subUrl.split("|");
      let allLines = []; // 存放所有抓取到的未解析节点文本(例如 vmess://... 或 base64)
      let subUserInfo = ""; // 存放流量信息

      for (const u of urls) {
        let text = "";
        let targetUrl = u.trim();
        debugLog += `\n[抓取] 目标: ${targetUrl}\n`;

        if (targetUrl.startsWith("http")) {
          try {
            // 第一次请求尝试，伪装成常见的 Clash 客户端
            let resp = await fetch(targetUrl, {
              headers: { "User-Agent": "Clash/1.18.0 Stash/2.5.0", "Accept": "*/*" }
            });

            debugLog += `[抓取] 初始请求状态: ${resp.status}\n`;
            
            // 尝试获取机场返回的流量信息 header
            const info = resp.headers.get("subscription-userinfo");
            if (info && !subUserInfo) subUserInfo = info;

            text = await resp.text();

            // 智能重试机制：如果返回的是 YAML 格式或者根本不是 Base64(可能是被防火墙拦截了)，换个 v2rayN 的 UA 再试一次
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
          // 如果传入的不是 http 链接，而是纯文本节点(如直接贴 vmess://)，直接压入数组
          allLines.push(targetUrl); 
          debugLog += `[抓取] 识别为静态单行节点\n`;
        }

        if (!text) {
          debugLog += `[抓取] 警告: 未获取到任何内容\n`;
          continue;
        }

        // 尝试解码获取到的内容
        try {
          // 假设内容是 Base64，去除空格后解码
          const cleanText = text.trim().replace(/\s/g, '');
          const decoded = atob(cleanText);
          allLines.push(...decoded.split("\n")); // 按行拆分成单个节点链接
          debugLog += `[解码] Base64 解码成功，获取行数: ${decoded.split("\n").length}\n`;
        } catch (e) {
          // 如果 Base64 解码失败，说明可能是明文(如单行文本集)，直接按行拆分
          allLines.push(...text.split("\n"));
          debugLog += `[解码] 尝试明文解析，内容前300位: ${text.substring(0, 300).replace(/\n/g, ' ')}...\n`;
        }
      }

      // 开始解析节点协议
      let proxies = [];
      for (let line of allLines) {
        line = line.trim();
        if (!line || line.length < 10) continue; // 过滤空行或太短的无效行

        let proxy = null;
        try {
          // 根据协议头调用不同的解析函数
          if (line.startsWith("vmess://")) proxy = parseVmess(line);
          else if (line.startsWith("vless://")) proxy = parseVless(line);
          else if (line.startsWith("ss://")) proxy = parseSS(line);
          else if (line.startsWith("trojan://")) proxy = parseTrojan(line);
          else if (line.startsWith("hysteria2://") || line.startsWith("hy2://")) proxy = parseHy2(line);
          else if (line.startsWith("tuic://")) proxy = parseTuic(line);

          if (proxy) {
            // 清理节点名称中的特殊字符(如引号和方括号)，防止打乱 YAML 语法
            proxy.name = proxy.name.replace(/[\[\]"]/g, '').trim();
            proxies.push(proxy); // 存入有效节点数组
          }
        } catch (e) {
          // 单个节点解析失败不记录，防止日志爆炸
        }
      }

      debugLog += `\n[汇总] 最终有效节点总数: ${proxies.length}\n`;

      // 如果一个有效节点都没解析出来，返回 500 错误并输出调试日志
      if (proxies.length === 0) {
        return new Response(`未解析到任何有效节点。\n\n${debugLog}`, { 
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          status: 500 
        });
      }

      // 核心组装函数：将解析好的节点和模板融合
      const finalYaml = buildFullClash(template, proxies);
      
      // 判断请求来源是否为浏览器
      const userAgent = (request.headers.get("User-Agent") || "").toLowerCase();
      const isBrowser = userAgent.includes("mozilla") && 
                        !["clash", "stash", "shadowrocket", "surge"].some(k => userAgent.includes(k));

      // 设置默认的流量信息展示
      if (!subUserInfo) subUserInfo = "upload=0; download=0; total=0; expire=0";

      // 构造返回给客户端的 HTTP Headers
      const responseHeaders = {
        "Content-Type": "text/yaml; charset=utf-8",
        "profile-title": customName, // 订阅标题
        "profile-update-interval": updateInterval, // 自动更新间隔
        "X-Config-Update-Interval": updateInterval,
        "subscription-userinfo": subUserInfo // 流量信息面板
      };

      // 如果不是在浏览器中直接预览，则强制触发文件下载
      if (!isBrowser) {
        responseHeaders["Content-Disposition"] = `attachment; filename*=UTF-8''${encodedName}.yaml`;
      }

      // 输出最终生成的 YAML 文件内容
      return new Response(finalYaml, { headers: responseHeaders });

    } catch (globalError) {
      // 捕捉任何未预料的 Worker 崩溃错误
      return new Response(`Worker 崩溃: ${globalError.message}\n\n${debugLog}`, { status: 500 });
    }
  }
};

// ================= 4. YAML 生成与注入逻辑 =================

function buildFullClash(template, proxies) {
  let proxyYaml = "proxies:\n"; // 初始化代理节点列表的 YAML 字符串
  const allNames = []; // 收集所有节点名称，用于后续填充"包含全部节点"的策略组
  let regionNodes = {}; // 按地区存储节点名称的对象
  REGIONS.forEach(r => regionNodes[r.prefix] = []);

  // 1. 生成 `proxies:` 下的详细节点信息，并进行地区分类
  for (const p of proxies) {
    allNames.push(p.name);
    // 写入基础字段
    proxyYaml += `  - name: "${p.name}"\n    type: ${p.type}\n    server: ${p.server}\n    port: ${p.port}\n`;

    const skip = ['name', 'type', 'server', 'port'];
    // 遍历代理对象的其他高级配置参数(如 tls, ws-opts 等)并转换为 YAML 格式
    for (const [key, value] of Object.entries(p)) {
      if (skip.includes(key) || value === null || value === undefined) continue;
      
      // 处理嵌套的 JSON 对象 (如 ws-opts: { path: "/", headers: {...} })
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
        // 处理数组格式配置 (如 alpn: ["h2", "http/1.1"])
        proxyYaml += `    ${key}: [${value.map(v => `"${v}"`).join(",")}]\n`;
      } else {
        // 处理普通键值对
        proxyYaml += `    ${key}: ${typeof value === 'string' ? `"${value}"` : value}\n`;
      }
    }

    // 关键字匹配：将节点名称分配到对应的地区分组(regionNodes)中
    for (let r of REGIONS) {
      if (r.keywords.some(kw => p.name.toLowerCase().includes(kw.toLowerCase()))) {
        regionNodes[r.prefix].push(p.name);
        break; 
      }
    }
  }

  // 2. 将生成的 `proxies:` 字符串替换进模板
  let finalYaml = template;
  const proxyRegex = /proxies:[\s\S]*?(?=proxy-groups:)/; // 匹配模板中原有的 proxies 块
  // 如果模板有 proxies 块就替换掉它，没有就在 proxies 标签后直接追加
  finalYaml = proxyRegex.test(finalYaml) ? finalYaml.replace(proxyRegex, proxyYaml + "\n") : finalYaml.replace("proxies:", proxyYaml);

  // 3. 构建动态地区策略组的 YAML 文本 (例如: JP最低延迟, HK自动切换)
  let dynamicGroupsYaml = "";
  let activeDynamicGroupsByRegion = {}; // 记录实际生成了哪些组

  for (const [prefix, nodes] of Object.entries(regionNodes)) {
    if (nodes.length > 0) { // 只有当该地区存在至少一个节点时，才生成对应的组
      activeDynamicGroupsByRegion[prefix] = [];
      for (const t of DYNAMIC_GROUP_TYPES) {
        const groupName = `${t.icon}${prefix}${t.suffix}`;
        activeDynamicGroupsByRegion[prefix].push(groupName);
        // 生成对应组的基础配置 (测速 URL、间隔等)
        dynamicGroupsYaml += `  - name: "${groupName}"\n    type: ${t.type}\n    url: http://www.msftconnecttest.com/connecttest.txt\n    interval: 600\n    tolerance: 300\n    proxies:\n`;
        // 将该地区下的所有节点塞进这个组里
        nodes.forEach(n => dynamicGroupsYaml += `      - "${n}"\n`);
      }
    }
  }

  // 4. 解析并逐行重写 YAML，完成策略组的动态注入
  let lines = finalYaml.split('\n');
  let newLines = [];
  let inProxyGroups = false;
  let currentGroupName = "";
  let insideInsertTargetBlock = false;
  let dynamicGroupsInjected = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // 定位到 proxy-groups: 区块开始
    if (line.trim() === "proxy-groups:") {
      inProxyGroups = true;
      newLines.push(line);
      continue;
    }
    
    // 如果还不在 proxy-groups 区块内，直接照抄原内容
    if (!inProxyGroups) {
      newLines.push(line);
      continue;
    }
    
    // 如果碰到了顶格写的非空格字符(比如遇到了 rules:)，说明 proxy-groups 区块结束了
    if (/^[a-zA-Z]/.test(line) && !line.startsWith(" ") && line.trim() !== "proxy-groups:") {
      // 在离开 proxy-groups 区块前，作为保底措施，确保新生成的动态地区组被注入了
      if (!dynamicGroupsInjected && dynamicGroupsYaml.trim() !== "") {
        newLines.push(...dynamicGroupsYaml.trimEnd().split('\n'));
        dynamicGroupsInjected = true;
      }
      inProxyGroups = false;
      newLines.push(line);
      continue;
    }

    // 提取当前正在处理的策略组的名称 (匹配 - name: "组名")
    let nameMatch = line.match(/^\s*-\s*name:\s*(['"]?)(.+?)\1\s*$/);
    if (nameMatch) {
      // 检查是否刚刚经过了预设的注入位置 (INSERT_AFTER_GROUP)
      if (insideInsertTargetBlock && !dynamicGroupsInjected && dynamicGroupsYaml.trim()) {
        newLines.push(...dynamicGroupsYaml.trimEnd().split('\n')); // 在这里整块插入动态生成的地区组
        dynamicGroupsInjected = true;
        insideInsertTargetBlock = false; // 闭合状态
      }
      currentGroupName = nameMatch[2]; // 记录当前读取到的组名
      // 如果遇到了目标组，标记状态，以便在读取它的下一个组前触发插入动作
      if (currentGroupName === INSERT_AFTER_GROUP) insideInsertTargetBlock = true;
    }

    // 处理向父级策略组(如'节点选择', '自动切换')中注入子项
    if (line.match(/^\s*proxies:\s*$/) && currentGroupName) {
      newLines.push(line);
      let indentMatch = line.match(/^(\s*)proxies:/);
      let itemIndent = indentMatch[1] + "  "; // 保持 YAML 缩进格式
      
      // 查找当前组是否在我们的配置表(PARENT_GROUPS_CONFIG)中
      let targetConfig = PARENT_GROUPS_CONFIG.find(t => t.target === currentGroupName);
      let dynamicGroupsToInject = [];
      
      // 收集需要注入到该父级组的动态地区组名称
      if (targetConfig) {
        for (const [prefix, groups] of Object.entries(activeDynamicGroupsByRegion)) {
          groups.forEach(groupName => {
            if (targetConfig.includeTypes.some(type => groupName.endsWith(type))) dynamicGroupsToInject.push(groupName);
          });
        }
      }

      // 根据配置，在原有节点的前面插入
      if (targetConfig && targetConfig.position === "front") {
        dynamicGroupsToInject.forEach(n => newLines.push(`${itemIndent}- "${n}"`));
      }

      // 跳过模板中该组原来自带的节点列表(防止重复或打乱插入逻辑)
      let j = i + 1;
      while (j < lines.length) {
        let nextLine = lines[j];
        if (nextLine.trim() !== "" && !nextLine.startsWith(itemIndent)) break; // 遇到缩进改变，说明这个组的 proxies 列表结束了
        if (nextLine.trim() !== "") newLines.push(nextLine); // 保留模板原有的静态节点
        j++;
      }
      i = j - 1; 

      // 根据配置，在原有节点的后面追加
      if (targetConfig && targetConfig.position === "back") {
        dynamicGroupsToInject.forEach(n => newLines.push(`${itemIndent}- "${n}"`));
      }
      
      // 根据配置，判断是否需要将所有单个节点全部展开平铺在这个组里
      if (targetConfig && targetConfig.includeAllNodes) {
        allNames.forEach(n => newLines.push(`${itemIndent}- "${n}"`));
      }
      continue;
    }
    newLines.push(line); // 普通行直接照抄
  }

  // 最终兜底：如果整个文件读完了还没触发插入，就在最后补上
  if (insideInsertTargetBlock && !dynamicGroupsInjected && dynamicGroupsYaml.trim()) {
    newLines.push(...dynamicGroupsYaml.trimEnd().split('\n'));
  }
  
  return newLines.join('\n'); // 拼接数组还原为完整的 YAML 文本
}

// ================= 5. 工具函数与协议解析 =================

// 判断字符串是否为标准 Base64 编码
function isBase64(str) {
  if (!str || str.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(str);
}

// 安全的 Base64 解码，支持替换 url-safe 字符(-和_)，并处理 URI 编码
function safeBase64Decode(str) {
  try {
    let base = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base.length % 4) base += '=';
    return decodeURIComponent(escape(atob(base)));
  } catch { return str; }
}

// 解析 Vless 链接格式 (vless://uuid@server:port?type=ws&security=tls...)
function parseVless(line) {
  try {
    const url = new URL(line);
    const params = url.searchParams;
    let proxy = {
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname, // hash为节点名
      type: "vless", server: url.hostname, port: parseInt(url.port), uuid: url.username, cipher: "auto"
    };
    const network = params.get("type") || params.get("network") || "tcp";
    proxy["network"] = network;
    proxy["tls"] = ["tls", "reality"].includes(params.get("security") || "none");
    if (params.has("sni")) proxy["servername"] = params.get("sni");
    
    // 组装 WebSocket 配置
    if (network === "ws") proxy["ws-opts"] = { path: params.get("path") || "/", headers: params.get("host") ? { "Host": params.get("host") } : undefined };
    // 组装 gRPC 配置
    if (network === "grpc") proxy["grpc-opts"] = { "grpc-service-name": params.get("serviceName") || "" };
    // 组装 Reality 配置
    if (params.get("security") === "reality") proxy["reality-opts"] = { "public-key": params.get("pbk") || "", "short-id": params.get("sid") || "" };
    
    return proxy;
  } catch { return null; }
}

// 解析 Vmess 链接格式 (vmess://Base64编码的JSON)
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

// 解析 Shadowsocks 链接格式 (ss://Base64(method:password)@server:port#name)
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

// 解析 Hysteria2 链接格式 (hy2://password@server:port?sni=...#name)
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

// 解析 TUIC 链接格式 (tuic://uuid:password@server:port#name)
function parseTuic(line) {
  try {
    const url = new URL(line);
    return {
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      type: "tuic", server: url.hostname, port: parseInt(url.port), version: 5, uuid: url.username, password: url.password
    };
  } catch { return null; }
}

// 解析 Trojan 链接格式 (trojan://password@server:port?sni=...#name)
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