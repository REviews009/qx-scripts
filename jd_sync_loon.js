// ==========================================
// 京东 WSKEY & Cookie → 青龙（sh.jd.com 修复版）
// ==========================================

const QL_URL = 'http://192.168.100.190:5700';
const QL_CLIENT_ID = 'XvlGPHERmo1-';
const QL_CLIENT_SECRET = 'd8-pKcFXf3FJsvcp9zNlnc-v';

// ======================
// 存储
// ======================
const S = {
    get: k => { try { return $persistentStore.read(k); } catch { return null; } },
    set: (k, v) => { try { $persistentStore.write(String(v), k); } catch {} }
};

// ======================
// 日志
// ======================
const log = (...args) => console.log('[JD]', ...args);

// ======================
// 通知（带冷却）
// ======================
function notify(type, title, subtitle, body) {
    const key = `JD_NOTIFY_${type}`;
    const last = parseInt(S.get(key) || '0');
    if (Date.now() - last > 30000) {
        S.set(key, Date.now());
        $notification.post(title, subtitle || '', body || '');
        log('NOTIFY:', type, title);
    } else {
        log('NOTIFY SKIP:', type);
    }
}

// ======================
// 解析请求
// ======================
const url = $request.url || '';
const headers = $request.headers || {};
const cookie = (headers.Cookie || headers.cookie || '').toString();

log('URL:', url.substring(0, 80));

if (!cookie) {
    log('NO COOKIE');
    $done({});
    return;
}

// ======================
// 提取字段
// ======================
let pin = (cookie.match(/pin=([^;]+)/) || [])[1] || '';
let wskey = (cookie.match(/wskey=([^;]+)/) || [])[1] || '';
let ptKey = (cookie.match(/pt_key=([^;]+)/) || [])[1] || '';

log('pin:', pin ? 'YES' : 'NO');
log('wskey:', wskey ? 'YES' : 'NO');
log('ptKey:', ptKey ? 'YES' : 'NO');

let pinDecoded = pin;
try { if (pin) pinDecoded = decodeURIComponent(pin); } catch (e) {}

// ======================
// 判断请求类型
// ======================
const isShJdRequest = url.includes('sh.jd.com') && !!wskey;
const isApiWskeyRequest = url.includes('api.m.jd.com') && !!wskey;
const isCookieRequest = url.includes('mars.jd.com') && !!pin && !!ptKey;

log('isShJd:', isShJdRequest);
log('isApiWskey:', isApiWskeyRequest);
log('isCookie:', isCookieRequest);

// ======================
// 保存数据
// ======================
let wskeyChanged = false;

if (pin) {
    S.set('JD_PIN_TEMP', pin);
    log('PIN saved');
}

if (wskey) {
    const oldWskey = S.get('JD_WSKEY_TEMP');
    if (oldWskey && oldWskey !== wskey) {
        log('WSKEY CHANGED!');
        wskeyChanged = true;
        S.set('JD_WSKEY_NEED_SYNC', '1');
    }
    S.set('JD_WSKEY_TEMP', wskey);
    S.set('JD_WSKEY_TIME', Date.now());
    log('WSKEY saved');
}

if (ptKey && pin) {
    S.set('JD_COOKIE_TEMP', `pt_key=${ptKey};pt_pin=${pin};`);
    log('COOKIE saved');
}

// ======================
// 情况1：api.m.jd.com 的 wskey 请求 → 只保存，不同步
// ======================
if (isApiWskeyRequest) {
    log('API WSKEY: save only');
    notify('WSKEY_SAVE', '🟡 WSKEY 已保存', '账号: ' + pinDecoded, '等待 Cookie 请求后同步');
    $done({});
    return;
}

// ======================
// 情况2：sh.jd.com 请求 → 保存 + 直接同步 wskey
// ======================
if (isShJdRequest) {
    log('SH.JD.COM: save + sync wskey');
    if (wskeyChanged) {
        notify('WSKEY_SAVE', '🟡 WSKEY 已更新', '账号: ' + pinDecoded, '立即同步到青龙');
    }
    // 继续执行下面的同步逻辑（不 return）
}

// ======================
// 情况3：不是 sh.jd.com 也不是 cookie 请求 → 结束
// ======================
else if (!isCookieRequest) {
    log('Not a sync request');
    $done({});
    return;
}

// ======================
// 同步逻辑（sh.jd.com 和 mars.jd.com 都会走到这里）
// ======================
const savedWskey = S.get('JD_WSKEY_TEMP');
const savedPin = pin || S.get('JD_PIN_TEMP') || '';
const needSyncWskey = S.get('JD_WSKEY_NEED_SYNC') === '1';

log('savedWskey:', savedWskey ? 'YES' : 'NO');
log('savedPin:', savedPin);
log('needSyncWskey:', needSyncWskey);

if (!savedPin) {
    log('NO PIN');
    $done({});
    return;
}

// 构建任务
const tasks = [];

// sh.jd.com 请求：只要有 wskey 就同步（不需要 needSyncWskey 标记）
if (isShJdRequest && savedWskey) {
    tasks.push({ name: 'JD_WSCK', value: `pin=${savedPin};wskey=${savedWskey};` });
    log('TASK: JD_WSCK (sh.jd.com)');
}
// mars.jd.com 请求：只在 wskey 变更时同步
else if (savedWskey && needSyncWskey) {
    tasks.push({ name: 'JD_WSCK', value: `pin=${savedPin};wskey=${savedWskey};` });
    log('TASK: JD_WSCK (new/changed)');
} else if (savedWskey) {
    tasks.push({ name: 'JD_WSCK', value: `pin=${savedPin};wskey=${savedWskey};` });
    log('TASK: JD_WSCK (existing)');
}

if (ptKey && pin) {
    tasks.push({ name: 'JD_COOKIE', value: `pt_key=${ptKey};pt_pin=${pin};` });
    log('TASK: JD_COOKIE');
}

if (tasks.length === 0) {
    log('No tasks');
    $done({});
    return;
}

log('Tasks:', tasks.map(t => t.name).join(', '));

// ======================
// 执行锁
// ======================
const LOCK_KEY = 'JD_SYNC_LOCK_' + savedPin;
const now = Date.now();
const lastLock = parseInt(S.get(LOCK_KEY) || '0');

if (!needSyncWskey && (now - lastLock < 30000)) {
    log('LOCKED for', savedPin, ':', now - lastLock, 'ms ago');
    $done({});
    return;
}
S.set(LOCK_KEY, now);

notify('START', '🚀 京东同步启动', '账号: ' + pinDecoded, '同步 ' + tasks.map(t => t.name).join(' + ') + ' 到青龙');

// ======================
// TOKEN
// ======================
function getToken(cb, retries = 0) {
    const MAX_RETRIES = 2;
    const RETRY_DELAY = 1000;

    const tokenUrl = QL_URL + '/open/auth/token?client_id=' + encodeURIComponent(QL_CLIENT_ID) + 
                '&client_secret=' + encodeURIComponent(QL_CLIENT_SECRET);

    $httpClient.get(tokenUrl, function (err, res, body) {
        if (!err && body) {
            try {
                const j = JSON.parse(body);
                const token = j.data?.token || null;
                if (token) {
                    log('Token OK');
                    cb(token);
                    return;
                } else {
                    throw new Error('No token: ' + (j.message || JSON.stringify(j)));
                }
            } catch (parseErr) {
                log('Token parse error:', parseErr.message);
                cb(null);
                return;
            }
        }

        if (retries < MAX_RETRIES) {
            log('Token retry', retries + 1);
            setTimeout(function() {
                getToken(cb, retries + 1);
            }, RETRY_DELAY);
        } else {
            log('Token failed');
            notify('FAIL_TOKEN', '❌ Token 失败', '青龙登录失败', '');
            cb(null);
        }
    });
}

// ======================
// 查找 ENV
// ======================
function findEnv(token, name, matchPin, cb) {
    const searchUrl = QL_URL + '/open/envs?searchValue=' + encodeURIComponent(name) + '&t=' + Date.now();
    $httpClient.get({ url: searchUrl, headers: { Authorization: 'Bearer ' + token } }, function (err, res, body) {
        if (err || !body) { log('Search failed'); cb(null); return; }
        try {
            const list = JSON.parse(body).data || [];
            const env = list.find(x => x.name === name && x.value && x.value.includes(matchPin));
            log('ENV', name, env ? 'FOUND' : 'NEW');
            cb(env || null);
        } catch { cb(null); }
    });
}

// ======================
// 启用 ENV
// ======================
function enableEnv(token, id) {
    if (!id) return;
    $httpClient.put({
        url: QL_URL + '/open/envs/enable?t=' + Date.now(),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify([id])
    }, function(err, res, body) {
        log('Enable', id, body || err || 'ok');
    });
}

// ======================
// 同步单个
// ======================
function syncOne(token, task, done) {
    findEnv(token, task.name, savedPin, function(env) {
        const reqHeaders = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

        const doRequest = function(cb) {
            if (env && env.id) {
                log('UPDATE', task.name);
                $httpClient.put({
                    url: QL_URL + '/open/envs?t=' + Date.now(),
                    headers: reqHeaders,
                    body: JSON.stringify({ id: env.id, name: task.name, value: task.value, remarks: savedPin })
                }, cb);
            } else {
                log('CREATE', task.name);
                $httpClient.post({
                    url: QL_URL + '/open/envs?t=' + Date.now(),
                    headers: reqHeaders,
                    body: JSON.stringify([{ name: task.name, value: task.value, remarks: savedPin }])
                }, cb);
            }
        };

        doRequest(function(err, res, body) {
            if (err || !body) {
                log(task.name, 'failed: network');
                notify('FAIL_' + task.name, '❌ ' + task.name + ' 失败', '网络错误', '');
                done();
                return;
            }

            let r;
            try { r = JSON.parse(body); } catch {
                log(task.name, 'failed: parse');
                notify('FAIL_' + task.name, '❌ ' + task.name + ' 失败', '解析错误', '');
                done();
                return;
            }

            if (r.code !== 200) {
                log(task.name, 'failed:', r.message);
                notify('FAIL_' + task.name, '❌ ' + task.name + ' 失败', r.message || '', '');
                done();
                return;
            }

            log(task.name, 'success');
            notify('SUCCESS_' + task.name, '✅ ' + task.name + ' 成功', '账号: ' + pinDecoded, env ? '已更新青龙' : '首次写入青龙');

            if (task.name === 'JD_WSCK') {
                S.set('JD_WSKEY_NEED_SYNC', '0');
                log('WSKEY sync flag cleared');
            }

            if (env && env.id) {
                enableEnv(token, env.id);
            }

            done();
        });
    });
}

// ======================
// 主流程
// ======================
getToken(function(token) {
    if (!token) {
        log('NO TOKEN');
        $done({});
        return;
    }

    log('Token OK');

    let i = 0;
    function next() {
        if (i >= tasks.length) {
            log('All done');
            $done({});
            return;
        }
        syncOne(token, tasks[i++], next);
    }

    next();
});
