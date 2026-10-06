// ==========================================
// JD wskey + cookie 同步青龙
// 【本次修改】
// 1. 去掉域名限制：请求 cookie 里只要有 pin + pt_key 就触发同步
//    （原逻辑必须等到 mars.jd.com 的请求才同步，而 App 流量几乎都是
//     api.m.jd.com，导致 pt_key 永远等不到同步 → cookie 从不更新）
// 2. wskey 早退分支改为"只有当前请求里没有 pt_key 时才只保存不同步"
// 3. findEnv 同时按编码/解码两种 pin 匹配旧变量，避免重复创建
// 4. 保存 wskey 时记录所属 pin，防止多账号时把 A 的 wskey 配到 B 的 pin 上
// ==========================================

const QL_URL = 'https://qinglong.qzz.io';
const QL_CLIENT_ID = 'Y57RsFPVBbz-';
const QL_CLIENT_SECRET = 'UmUwXTnVE0qM1_pLCRNCfvdA';

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
// 【修改】不再限定域名：
//   - cookie 里有 wskey → wskey 数据
//   - cookie 里同时有 pin + pt_key → 可触发同步
// ======================
const isWskeyRequest = !!wskey;
const isCookieRequest = !!pin && !!ptKey;

log('isWskey:', isWskeyRequest);
log('isCookie:', isCookieRequest);

// ======================
// 保存数据（在锁之前，不受锁影响）
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
    S.set('JD_WSKEY_PIN', pin || S.get('JD_PIN_TEMP') || '');  // 【新增】记录 wskey 所属账号
    S.set('JD_WSKEY_TIME', Date.now());
    log('WSKEY saved');
}

if (ptKey && pin) {
    S.set('JD_COOKIE_TEMP', `pt_key=${ptKey};pt_pin=${pin};`);
    log('COOKIE saved');
}

// ======================
// 【修改】只有 wskey、没有 pt_key 的请求：只保存，不同步
// （原来只要命中 api.m.jd.com 就直接返回，即使该请求同时带了 pt_key 也不同步）
// ======================
if (isWskeyRequest && !isCookieRequest) {
    log('WSKEY request: save only (no pt_key in this request)');
    if (wskeyChanged) {
        notify('WSKEY_SAVE', '🟡 WSKEY 已更新', '账号: ' + pinDecoded, '新 WSKEY 已保存，等待带 pt_key 的请求触发同步');
    } else {
        notify('WSKEY_SAVE', '🟡 WSKEY 已保存', '账号: ' + pinDecoded, '等待带 pt_key 的请求触发同步');
    }
    $done({});
    return;
}

// ======================
// 没有 pin + pt_key：结束
// ======================
if (!isCookieRequest) {
    log('Not syncable (no pin + pt_key)');
    $done({});
    return;
}

// ======================
// 带 pin + pt_key 的请求：同步 wskey + cookie
// ======================
const savedWskey = S.get('JD_WSKEY_TEMP');
const savedWskeyPin = S.get('JD_WSKEY_PIN') || '';
const savedPin = pin || S.get('JD_PIN_TEMP') || '';
const needSyncWskey = S.get('JD_WSKEY_NEED_SYNC') === '1';

log('savedWskey:', savedWskey ? 'YES' : 'NO');
log('savedWskeyPin:', savedWskeyPin || '(unknown)');
log('savedPin:', savedPin);
log('needSyncWskey:', needSyncWskey);

if (!savedPin) {
    log('NO PIN');
    $done({});
    return;
}

// 构建任务
const tasks = [];

// 【修改】wskey 只有所属账号匹配时才同步，避免多账号串号
if (savedWskey && (!savedWskeyPin || savedWskeyPin === savedPin)) {
    tasks.push({ name: 'JD_WSCK', value: `pin=${savedPin};wskey=${savedWskey};` });
    log('TASK: JD_WSCK' + (needSyncWskey ? ' (new/changed)' : ' (existing)'));
} else if (savedWskey) {
    log('WSKEY belongs to another pin, skip JD_WSCK');
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
// 执行锁（只锁同步，不锁保存；按账号锁，wskey 变更时可强制突破）
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

// 只弹一次启动通知
notify('START', '🚀 京东同步启动', '账号: ' + pinDecoded, '同步 ' + tasks.map(t => t.name).join(' + ') + ' 到青龙');

// ======================
// TOKEN（带重试机制）
// ======================
function getToken(cb, retries = 0) {
    const MAX_RETRIES = 2;
    const RETRY_DELAY = 1000;  // 1秒延迟

    const tokenUrl = QL_URL + '/open/auth/token?client_id=' + encodeURIComponent(QL_CLIENT_ID) +
                     '&client_secret=' + encodeURIComponent(QL_CLIENT_SECRET);

    $httpClient.get(tokenUrl, function (err, res, body) {
        if (!err && body) {
            try {
                const j = JSON.parse(body);
                const token = j.data?.token || null;

                if (token) {
                    log('Token OK (retry: ' + retries + ')');
                    cb(token);
                    return;
                } else {
                    throw new Error('No token in response: ' + (j.message || JSON.stringify(j)));
                }
            } catch (parseErr) {
                log('Token parse error:', parseErr.message);
                cb(null);
                return;
            }
        }

        // 网络错误或无响应，尝试重试
        if (retries < MAX_RETRIES) {
            log('Token failed, retry ' + (retries + 1) + '/' + MAX_RETRIES +
                ', delay ' + RETRY_DELAY + 'ms', err ? err.message || err : 'empty body');

            setTimeout(function () {
                getToken(cb, retries + 1);
            }, RETRY_DELAY);
        } else {
            log('Token failed after ' + MAX_RETRIES + ' retries');
            notify('FAIL_TOKEN', '❌ Token 失败', '青龙登录失败，已重试 ' + MAX_RETRIES + ' 次', '');
            cb(null);
        }
    });
}

// ======================
// 查找 ENV
// ======================
function findEnv(token, name, matchPin, cb) {
    // 【修改】同时匹配编码/解码两种 pin，避免因编码差异找不到旧变量而重复创建
    const pins = [matchPin];
    try {
        const d = decodeURIComponent(matchPin);
        if (d && d !== matchPin) pins.push(d);
    } catch (e) {}

    const searchUrl = QL_URL + '/open/envs?searchValue=' + encodeURIComponent(name) + '&t=' + Date.now();
    $httpClient.get({ url: searchUrl, headers: { Authorization: 'Bearer ' + token } }, function (err, res, body) {
        if (err || !body) { log('Search failed'); cb(null); return; }
        try {
            const list = JSON.parse(body).data || [];
            const env = list.find(x => x.name === name && x.value && pins.some(p => x.value.includes(p)));
            log('ENV', name, env ? 'FOUND (id:' + env.id + ')' : 'NEW');
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
    }, function (err, res, body) {
        log('Enable', id, body || err || 'ok');
    });
}

// ======================
// 同步单个
// ======================
function syncOne(token, task, done) {
    findEnv(token, task.name, savedPin, function (env) {
        const reqHeaders = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

        const doRequest = function (cb) {
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

        doRequest(function (err, res, body) {
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

            // wskey 同步成功后，清除需要同步的标记
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
getToken(function (token) {
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
