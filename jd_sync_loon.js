// ==========================================
// 京东 WSKEY & Cookie → 青龙（详细通知 + 首次登录支持）
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
// 通知（分类型弹窗，防冷却）
// ======================
function notify(type, title, subtitle, body) {
    // 进度类通知：START、WSKEY、COOKIE、DONE → 各自独立通知（不冷却）
    // 错误类通知：FAIL → 5分钟冷却
    // 不弹：其他
    
    const progressTypes = ['START', 'WSKEY', 'COOKIE', 'DONE'];
    const isProgress = progressTypes.includes(type);
    const isFail = type.startsWith('FAIL');
    
    if (!isProgress && !isFail) {
        return;
    }
    
    // 冷却检查（只对错误类生效）
    if (isFail) {
        const key = `JD_NOTIFY_${type}`;
        const last = parseInt(S.get(key) || '0');
        if (Date.now() - last < 300000) {  // 5分钟内已弹过
            log('NOTIFY SKIP (cooldown):', type);
            return;
        }
        S.set(key, Date.now());
    }
    
    $notification.post(title, subtitle || '', body || '');
    log('NOTIFY:', type, title);
}

// ======================
// 解析请求
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

let pin = (cookie.match(/pin=([^;]+)/) || [])[1] || '';
let wskey = (cookie.match(/wskey=([^;]+)/) || [])[1] || '';
let ptKey = (cookie.match(/pt_key=([^;]+)/) || [])[1] || '';

log('pin:', pin ? 'YES' : 'NO');
log('wskey:', wskey ? 'YES' : 'NO');
log('ptKey:', ptKey ? 'YES' : 'NO');

let pinDecoded = pin;
try { if (pin) pinDecoded = decodeURIComponent(pin); } catch (e) {}

const isWskeyRequest = url.includes('api.m.jd.com') && !!wskey;
const isCookieRequest = url.includes('mars.jd.com') && !!pin && !!ptKey;

log('isWskey:', isWskeyRequest);
log('isCookie:', isCookieRequest);

// ======================
// 【WSKEY 请求】检测变更，保存
// ======================
if (isWskeyRequest) {
    const oldWskey = S.get('JD_WSKEY_' + pin);
    let isFirstTime = !oldWskey;
    let isChanged = oldWskey && oldWskey !== wskey;
    
    // 【重点】重新登录：清除同步标记
    if (isChanged) {
        log('WSKEY CHANGED for', pinDecoded);
        S.set('JD_WSKEY_SYNCED_' + pin, '0');
        notify('WSKEY', '🔐 检测到新登录', '账号: ' + pinDecoded, 'WSKEY 已更新，准备同步');
    } else if (isFirstTime) {
        log('WSKEY FIRST TIME for', pinDecoded);
        notify('WSKEY', '🔐 WSKEY 已捕获', '账号: ' + pinDecoded, '首次登录，等待 Cookie 完整同步');
    }
    
    // 保存当前 WSKEY
    S.set('JD_WSKEY_' + pin, wskey);
    S.set('JD_PIN_' + pin, pin);
    
    $done({});
    return;
}

// ======================
// 【非 Cookie 请求】结束
// ======================
if (!isCookieRequest) {
    log('Not cookie request');
    $done({});
    return;
}

// ======================
// 【Cookie 请求】准备同步
// ======================
let syncPin = pin;
let syncWskey = S.get('JD_WSKEY_' + syncPin) || '';
let syncPtKey = ptKey;
let pinDecoded2 = pinDecoded;

log('COOKIE REQUEST:', syncPin);
log('Have WSKEY:', syncWskey ? 'YES' : 'NO');

if (!syncPin || !syncPtKey) {
    log('MISSING DATA');
    $done({});
    return;
}

// ======================
// 构建任务
// ======================
const tasks = [];

// 【关键】WSKEY 同步条件：有 WSKEY 且 (未同步过 或 已变更)
const wskeyNotSynced = S.get('JD_WSKEY_SYNCED_' + syncPin) !== '1';
let willSyncWskey = false;

if (syncWskey && wskeyNotSynced) {
    tasks.push({ 
        name: 'JD_WSCK', 
        value: `pin=${syncPin};wskey=${syncWskey};`,
        pin: syncPin,
        type: 'wskey',
        index: 0
    });
    willSyncWskey = true;
    log('TASK: JD_WSCK');
}

// Cookie 总是同步
tasks.push({ 
    name: 'JD_COOKIE', 
    value: `pt_key=${syncPtKey};pt_pin=${syncPin};`,
    pin: syncPin,
    type: 'cookie',
    index: willSyncWskey ? 1 : 0
});
log('TASK: JD_COOKIE');

if (tasks.length === 0) {
    log('No tasks');
    $done({});
    return;
}

// ======================
// 【防重复】按账号锁（60秒）
// ======================
const LOCK_KEY = 'JD_SYNC_LOCK_' + syncPin;
const now = Date.now();
const lastLock = parseInt(S.get(LOCK_KEY) || '0');
const isWskeyChanged = S.get('JD_WSKEY_SYNCED_' + syncPin) === '0';

if (!isWskeyChanged && (now - lastLock < 60000)) {
    log('LOCKED for', syncPin, ':', ((now - lastLock) / 1000).toFixed(1), 's ago');
    $done({});
    return;
}

S.set(LOCK_KEY, now);
log('LOCK SET');

// ======================
// 【启动通知】
// ======================
const taskDesc = tasks.map(t => t.name).join(' + ');
notify('START', '🚀 开始同步', '账号: ' + pinDecoded2, '任务: ' + taskDesc);

// ======================
// TOKEN（10秒超时）
// ======================
function getToken(cb) {
    const url = QL_URL + '/open/auth/token?client_id=' + encodeURIComponent(QL_CLIENT_ID) + '&client_secret=' + encodeURIComponent(QL_CLIENT_SECRET);
    const tid = setTimeout(() => {
        log('Token timeout');
        cb(null);
    }, 10000);
    
    $httpClient.get(url, function (err, res, body) {
        clearTimeout(tid);
        if (err || !body) {
            log('Token error:', err);
            cb(null);
            return;
        }
        try {
            const j = JSON.parse(body);
            cb(j.data?.token || null);
        } catch (e) {
            log('Token parse error:', e);
            cb(null);
        }
    });
}

// ======================
// 查找 ENV（按 remarks 精确匹配）
// ======================
function findEnv(token, name, pin, cb) {
    const url = QL_URL + '/open/envs?searchValue=' + encodeURIComponent(name);
    $httpClient.get({ 
        url, 
        headers: { Authorization: 'Bearer ' + token } 
    }, function (err, res, body) {
        if (err || !body) {
            log('Search error');
            cb(null);
            return;
        }
        try {
            const list = JSON.parse(body).data || [];
            // 【改进】优先按 remarks = pin 精确匹配
            let env = list.find(x => x.name === name && x.remarks === pin);
            if (!env) {
                // 其次按 value 包含 pin
                env = list.find(x => x.name === name && x.value && x.value.includes(pin));
            }
            cb(env || null);
        } catch (e) {
            log('Search parse error');
            cb(null);
        }
    });
}

// ======================
// 启用 ENV
// ======================
function enableEnv(token, id) {
    if (!id) return;
    $httpClient.put({
        url: QL_URL + '/open/envs/enable',
        headers: { 
            Authorization: 'Bearer ' + token, 
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify([id])
    }, function(err) {
        if (!err) log('Enable OK:', id);
    });
}

// ======================
// 同步单个
// ======================
function syncOne(token, task, done) {
    findEnv(token, task.name, task.pin, function(env) {
        const headers = { 
            Authorization: 'Bearer ' + token, 
            'Content-Type': 'application/json' 
        };

        const doRequest = function(cb) {
            if (env && env.id) {
                log('UPDATE', task.name);
                $httpClient.put({
                    url: QL_URL + '/open/envs',
                    headers: headers,
                    body: JSON.stringify({ 
                        id: env.id, 
                        name: task.name, 
                        value: task.value, 
                        remarks: task.pin 
                    })
                }, cb);
            } else {
                log('CREATE', task.name);
                $httpClient.post({
                    url: QL_URL + '/open/envs',
                    headers: headers,
                    body: JSON.stringify([{ 
                        name: task.name, 
                        value: task.value, 
                        remarks: task.pin 
                    }])
                }, cb);
            }
        };

        doRequest(function(err, res, body) {
            // 【错误处理】
            if (err || !body) {
                log(task.name, 'failed: network error');
                notify('FAIL', '❌ ' + task.name + ' 失败', '网络错误', pinDecoded2);
                done();
                return;
            }

            let r;
            try { 
                r = JSON.parse(body); 
            } catch (e) {
                log(task.name, 'failed: parse error');
                notify('FAIL', '❌ ' + task.name + ' 失败', '青龙响应异常', pinDecoded2);
                done();
                return;
            }

            if (r.code !== 200) {
                log(task.name, 'failed:', r.message);
                notify('FAIL', '❌ ' + task.name + ' 失败', r.message || '未知错误', pinDecoded2);
                done();
                return;
            }

            log(task.name, 'success');

            // 【进度通知】根据任务类型弹窗
            if (task.type === 'wskey') {
                notify('WSKEY', '✅ WSKEY 已同步', '账号: ' + pinDecoded2, env ? '更新到青龙' : '首次添加到青龙');
                // 标记已同步
                S.set('JD_WSKEY_SYNCED_' + task.pin, '1');
            } else if (task.type === 'cookie') {
                notify('COOKIE', '✅ Cookie 已同步', '账号: ' + pinDecoded2, env ? '更新到青龙' : '首次添加到青龙');
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
        notify('FAIL', '❌ 青龙登录失败', 'Token 获取失败', '请检查青龙地址和密钥');
        $done({});
        return;
    }

    log('Token OK');

    let i = 0;
    function next() {
        if (i >= tasks.length) {
            log('All done');
            // 【完成通知】
            notify('DONE', '✅ 全部同步完成', '账号: ' + pinDecoded2, '现在可以在青龙中使用了');
            setTimeout(() => $done({}), 300);
            return;
        }
        syncOne(token, tasks[i++], next);
    }

    next();
});
