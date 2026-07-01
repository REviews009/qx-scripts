// ==========================================
// QX 版：京东 WSKEY & Cookie → 青龙（修复版）
// ==========================================

const QL_URL = "http://192.168.100.190:5700";
const QL_CLIENT_ID = "XvlGPHERmo1-";
const QL_CLIENT_SECRET = "d8-pKcFXf3FJsvcp9zNlnc-v";

// ======================
// QX 存储封装
// ======================
const S = {
  get: (k) => {
    try { return $prefs.valueForKey(k); } catch { return null; }
  },
  set: (k, v) => {
    try { $prefs.setValueForKey(String(v), k); return true; } catch { return false; }
  }
};

const log = (...args) => console.log("[JD-QX]", ...args);
const notify = (title, subtitle, body) => {
  try { $notify(title, subtitle || "", body || ""); } catch {}
};

// ======================
// 解析 Cookie
// ======================
function parseCookie(str) {
  let pin = (str.match(/pin=([^;]+)/) || [])[1] || "";
  let wskey = (str.match(/wskey=([^;]+)/) || [])[1] || "";
  let pt_key = (str.match(/pt_key=([^;]+)/) || [])[1] || "";
  let pt_pin = (str.match(/pt_pin=([^;]+)/) || [])[1] || "";
  return { pin, wskey, pt_key, pt_pin };
}

// ======================
// 判断请求类型
// ======================
function getRequestType(url, cookie) {
  let { pin, wskey, pt_key, pt_pin } = parseCookie(cookie);
  
  // wskey 请求：api.m.jd.com 且包含 wskey
  if (url.includes("api.m.jd.com") && wskey) return { type: "wskey", pin, wskey };
  
  // cookie 请求：包含 pt_key + pt_pin
  if (pt_key && pt_pin) return { type: "cookie", pt_key, pt_pin };
  
  return { type: "unknown" };
}

// ======================
// 青龙 API
// ======================
async function getQLToken() {
  let url = `${QL_URL}/open/auth/token?client_id=${encodeURIComponent(QL_CLIENT_ID)}&client_secret=${encodeURIComponent(QL_CLIENT_SECRET)}`;
  let res = await $task.fetch({ url });
  let data = JSON.parse(res.body);
  if (data.code !== 200) throw new Error("Token failed: " + data.message);
  return data.data.token;
}

async function findEnv(token, name, matchPin) {
  let url = `${QL_URL}/open/envs?searchValue=${encodeURIComponent(name)}&t=${Date.now()}`;
  let res = await $task.fetch({
    url,
    headers: { Authorization: `Bearer ${token}` }
  });
  let list = JSON.parse(res.body).data || [];
  return list.find(x => x.name === name && x.value && x.value.includes(matchPin)) || null;
}

async function updateEnv(token, id, name, value, remarks) {
  let res = await $task.fetch({
    url: `${QL_URL}/open/envs?t=${Date.now()}`,
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ id, name, value, remarks })
  });
  return JSON.parse(res.body);
}

async function createEnv(token, name, value, remarks) {
  let res = await $task.fetch({
    url: `${QL_URL}/open/envs?t=${Date.now()}`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([{ name, value, remarks }])
  });
  return JSON.parse(res.body);
}

async function enableEnv(token, ids) {
  if (!ids || ids.length === 0) return;
  await $task.fetch({
    url: `${QL_URL}/open/envs/enable?t=${Date.now()}`,
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(ids)
  });
}

// ======================
// 同步到青龙（按账号隔离）
// ======================
async function syncToQL(pt_pin, wskey, cookie) {
  let token = await getQLToken();
  log("Token OK");
  
  let results = [];
  let ids = [];
  
  // 同步 JD_WSCK
  if (wskey) {
    let wsckValue = `pin=${pt_pin};wskey=${wskey};`;
    let env = await findEnv(token, "JD_WSCK", pt_pin);
    
    if (env) {
      log("UPDATE JD_WSCK");
      await updateEnv(token, env.id, "JD_WSCK", wsckValue, pt_pin);
      ids.push(env.id);
    } else {
      log("CREATE JD_WSCK");
      let r = await createEnv(token, "JD_WSCK", wsckValue, pt_pin);
      if (r.data && r.data[0]) ids.push(r.data[0].id);
    }
    results.push("JD_WSCK");
  }
  
  // 同步 JD_COOKIE
  if (cookie) {
    let env = await findEnv(token, "JD_COOKIE", pt_pin);
    
    if (env) {
      log("UPDATE JD_COOKIE");
      await updateEnv(token, env.id, "JD_COOKIE", cookie, pt_pin);
      ids.push(env.id);
    } else {
      log("CREATE JD_COOKIE");
      let r = await createEnv(token, "JD_COOKIE", cookie, pt_pin);
      if (r.data && r.data[0]) ids.push(r.data[0].id);
    }
    results.push("JD_COOKIE");
  }
  
  // 启用
  await enableEnv(token, ids);
  
  return results;
}

// ======================
// 主流程
// ======================
(async () => {
  try {
    let url = $request.url || "";
    let headers = $request.headers || {};
    let cookie = headers.Cookie || headers.cookie || "";
    
    log("URL:", url.substring(0, 60));
    
    if (!cookie) {
      log("NO COOKIE");
      return $done({});
    }
    
    let req = getRequestType(url, cookie);
    log("TYPE:", req.type);
    
    // ---------- wskey 请求：保存 ----------
    if (req.type === "wskey") {
      let pinKey = req.pin || "unknown";
      // 按账号存储
      S.set(`JD_PIN_${pinKey}`, req.pin);
      S.set(`JD_WSKEY_${pinKey}`, req.wskey);
      S.set(`JD_WSKEY_TIME_${pinKey}`, Date.now());
      S.set(`JD_WSKEY_NEED_SYNC_${pinKey}`, "1");
      
      log("WSKEY saved for", pinKey);
      notify("🟡 WSKEY 已保存", `账号: ${req.pin}`, "等待 Cookie 请求后同步");
      return $done({});
    }
    
    // ---------- cookie 请求：同步 ----------
    if (req.type === "cookie") {
      let pt_pin = req.pt_pin;
      let pinKey = pt_pin;
      
      // 读取该账号存储的 wskey
      let savedWskey = S.get(`JD_WSKEY_${pinKey}`);
      let needSync = S.get(`JD_WSKEY_NEED_SYNC_${pinKey}`) === "1";
      let savedPin = S.get(`JD_PIN_${pinKey}`);
      
      log("savedWskey:", savedWskey ? "YES" : "NO");
      log("needSync:", needSync);
      
      // 检查冷却（30秒）
      let lockKey = `JD_SYNC_LOCK_${pinKey}`;
      let lastSync = parseInt(S.get(lockKey) || "0");
      if (Date.now() - lastSync < 30000) {
        log("COOLDOWN, skip");
        return $done({});
      }
      
      // 构建同步任务
      let tasks = [];
      
      // 如果有新 wskey 需要同步
      if (savedWskey && needSync) {
        tasks.push({ name: "JD_WSCK", value: `pin=${savedPin || pt_pin};wskey=${savedWskey};` });
      }
      
      // cookie 总是同步（修复：去掉 encodeURIComponent）
      let cookieValue = `pt_key=${req.pt_key};pt_pin=${pt_pin};`;
      tasks.push({ name: "JD_COOKIE", value: cookieValue });
      
      if (tasks.length === 0) {
        log("No tasks");
        return $done({});
      }
      
      // 执行同步
      log("SYNC:", tasks.map(t => t.name).join(", "));
      let results = await syncToQL(
        pt_pin, 
        savedWskey && needSync ? savedWskey : null,
        cookieValue
      );
      
      // 清除同步标记
      if (savedWskey && needSync) {
        S.set(`JD_WSKEY_NEED_SYNC_${pinKey}`, "0");
        log("WSKEY sync flag cleared");
      }
      
      // 更新锁
      S.set(lockKey, Date.now());
      
      notify("✅ 同步完成", `账号: ${pt_pin}`, results.join(" + "));
      log("DONE");
      return $done({});
    }
    
    // 其他请求
    log("Unknown request type");
    $done({});
    
  } catch (e) {
    log("ERROR:", e.message || e);
    notify("❌ 同步失败", "", e.message || String(e));
    $done({});
  }
})();
