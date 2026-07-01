// ==========================================
// 京东 WSKEY & Cookie → 青龙（防重复通知 + 修复 WSKEY 同步版）
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
    if (Date.now() - last > 30000) {  // 30秒冷却
        S.set(key, Date.now());
        $notification.post(title, subtitle || '', body || '');
        log('NOTIFY:', type, title);
    } else {
        log('NOTIFY SKIP:', type);
    }
}

// ======================
// 解析请求（先解析，不受锁影响）
// ======================
const url = $request.url || '';
const headers = $request.headers || {};
const cookie = (headers.Cookie || headers.cookie || '').toString();

log('URL:', url.substring(0, 60));

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

// 解码 pin
let pinDecoded = pin;
try { if (pin) pinDecoded = decodeURIComponent(pin); } catch (e) {}

// ======================
// 判断请求类型
// ======================
const isWskeyRequest = url.includes('api.m.jd.com') && !!wskey;
const isCookieRequest = url.includes('mars.jd.com') && !!pin && !!ptKey;

log('isWskey:', isWskeyRequest);
log('isCookie:', isCookieRequest);

// ======================
// 【关键】保存数据（移到锁之前！不受锁影响）
// ======================
let wskeyChanged = false;

if (pin) {
    S.set('JD_PIN_TEMP', pin);
    log('PIN saved');
}

if (wskey) {
    const oldWskey = S.get('JD_WSKEY_TEMP');
    if (oldWskey && oldWskey !== wskey) {
        log('WSKEY CHANGED! old:', oldWskey.substring(0, 20) + '...', 'new:', wskey.substring(0, 20) + '...');
        wskeyChanged = true;
        // 标记 wskey 已变更，需要重新同步
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
// wskey 请求：只保存，不同步
// ======================
if (isWskeyRequest) {
    log('WSKEY request: save only');
    if (wskeyChanged) {
        notify('WSKEY_SAVE', '🟡 WSKEY 已更新', '账号: ' + pinDecoded, '新 WSKEY 已保存，等待 Cookie 请求同步');
    } else {
        notify('WSKEY_SAVE', '🟡 WSKEY 已保存', '账号: ' + pinDecoded, '等待 Cookie 请求后同步');
    }
    $done({});
    return;
}

// ======================
// 不是 cookie 请求：结束
// ======================
if (!isCookieRequest) {
    log('Not cookie request');
    $done({});
    return;
}

// ======================
// cookie 请求：同步 wskey + cookie
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

// 【关键】如果有新 wskey 需要同步，或者没有同步过，就加入任务
if (savedWskey && needSyncWskey) {
    tasks.push({ name: 'JD_WSCK', value: `pin=${savedPin};wskey=${savedWskey};` });
    log('TASK: JD_WSCK (new/changed)');
} else if (savedWskey) {
    // wskey 已经同步过，但这次 cookie 请求也带上（确保青龙里是最新的）
    tasks.push({ name: 'JD_WSCK', value: `pin=${savedPin};wskey=${savedWskey};` });
    log('TASK: JD_WSCK (existing)');
}

if (ptKey && pin) {
    tasks.push({ name: 'JD_COOKIE', value: `pt_key=${ptKey};pt_pin=${pin};` });
}

if (tasks.length === 0) {
    log('No tasks');
    $done({});
    return;
}

log('Tasks:', tasks.map(t => t.name).join(', '));

// ======================
// 【关键】执行锁（只锁同步，不锁保存）
// ======================
const LOCK_KEY = 'JD_SYNC_LOCK_' + savedPin;  // 按账号锁，不是全局锁
const now = Date.now();
const lastLock = parseInt(S.get(LOCK_KEY) || '0');

// 如果 wskey 变了，强制突破锁同步；否则正常检查锁
if (!needSyncWskey && (now - lastLock < 30000)) {
    log('LOCKED for', savedPin, ':', now - lastLock, 'ms ago');
    $done({});
    return;
}
S.set(LOCK_KEY, now);

// 只弹一次启动通知
notify('START', '🚀 京东同步启动', '账号: ' + pinDecoded, '同步 ' + tasks.map(t => t.name).join(' + ') + ' 到青龙');

// ======================
// TOKEN
// ======================
function getToken(cb) {
    const url = QL_URL + '/open/auth/token?client_id=' + encodeURIComponent(QL_CLIENT_ID) + '&client_secret=' + encodeURIComponent(QL_CLIENT_SECRET);
    $httpClient.get(url, function (err, res, body) {
        if (err || !body) { log('Token failed'); cb(null); return; }
        try {
            const j = JSON.parse(body);
            cb(j.data?.token || null);
        } catch { cb(null); }
    });
}

// ======================
// 查找 ENV
// ======================
function findEnv(token, name, matchPin, cb) {
    const url = QL_URL + '/open/envs?searchValue=' + encodeURIComponent(name) + '&t=' + Date.now();
    $httpClient.get({ url, headers: { Authorization: 'Bearer ' + token } }, function (err, res, body) {
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

            // 【关键】wskey 同步成功后，清除需要同步的标记
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
        notify('FAIL_TOKEN', '❌ Token失败', '青龙登录失败', '');
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
