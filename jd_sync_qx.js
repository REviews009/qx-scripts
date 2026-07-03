// ==========================================
// ==========================================

const QL_URL = 'http://192.168.100.190:5700';  // ← 改成你的青龙地址
const QL_CLIENT_ID = 'XvlGPHERmo1-';           // ← 改成你的 CLIENT_ID
const QL_CLIENT_SECRET = 'd8-pKcFXf3FJsvcp9zNlnc-v';  // ← 改成你的 CLIENT_SECRET

// ======================
// 环境检测
// ======================
const isSurge = typeof $httpClient != "undefined";
const isQuanX = typeof $task != "undefined";

// ======================
// 兼容层 - 存储
// ======================
const S = {
    get: k => {
        if (isQuanX) {
            try { return $prefs.valueForKey(k); } catch { return null; }
        }
        if (isSurge) {
            try { return $persistentStore.read(k); } catch { return null; }
        }
        return null;
    },
    set: (k, v) => {
        if (isQuanX) {
            try { $prefs.setValueForKey(String(v), k); } catch {}
        } else if (isSurge) {
            try { $persistentStore.write(String(v), k); } catch {}
        }
    }
};

// ======================
// 兼容层 - 通知
// ======================
function notify(type, title, subtitle, body) {
    const key = `JD_NOTIFY_${type}`;
    const last = parseInt(S.get(key) || '0');
    if (Date.now() - last > 30000) {
        S.set(key, Date.now());
        if (isQuanX) {
            $notify(title, subtitle || '', body || '');
        } else if (isSurge) {
            $notification.post(title, subtitle || '', body || '');
        }
        log('NOTIFY:', type, title);
    } else {
        log('NOTIFY SKIP:', type);
    }
}

// ======================
// 兼容层 - HTTP 请求
// ======================
function httpRequest(options, callback) {
    if (isQuanX) {
        if (typeof options == "string") options = { url: options };
        $task.fetch(options).then(
            response => callback(null, response, response.body),
            reason => callback(reason.error || 'error', null, null)
        );
    } else if (isSurge) {
        $httpClient[options.method.toLowerCase()](options, (error, response, body) => {
            callback(error, response, body);
        });
    }
}

// ======================
// 兼容层 - done
// ======================
function done() {
    if (isQuanX) $done({});
    else if (isSurge) $done();
}

// ======================
// 日志
// ======================
const log = (...args) => console.log('[JD]', ...args);

// ======================
// 解析请求
// ======================
const url = $request.url || '';
const headers = $request.headers || {};
const cookie = (headers.Cookie || headers.cookie || '').toString();

log('URL:', url.substring(0, 60));
log('ENV:', isQuanX ? 'QX' : (isSurge ? 'Surge' : 'Unknown'));

if (!cookie) {
    log('NO COOKIE');
    done();
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
const isWskeyRequest = url.includes('api.m.jd.com') && !!wskey;
const isCookieRequest = url.includes('mars.jd.com') && !!pin && !!ptKey;

log('isWskey:', isWskeyRequest);
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
// wskey 请求：只保存
// ======================
if (isWskeyRequest) {
    log('WSKEY request: save only');
    if (wskeyChanged) {
        notify('WSKEY_SAVE', '🟡 WSKEY 已更新', '账号: ' + pinDecoded, '新 WSKEY 已保存，等待 Cookie 请求同步');
    } else {
        notify('WSKEY_SAVE', '🟡 WSKEY 已保存', '账号: ' + pinDecoded, '等待 Cookie 请求后同步');
    }
    done();
    return;
}

// ======================
// 不是 cookie 请求：结束
// ======================
if (!isCookieRequest) {
    log('Not cookie request');
    done();
    return;
}

// ======================
// cookie 请求：同步
// ======================
const savedWskey = S.get('JD_WSKEY_TEMP');
const savedPin = pin || S.get('JD_PIN_TEMP') || '';
const needSyncWskey = S.get('JD_WSKEY_NEED_SYNC') === '1';

log('savedWskey:', savedWskey ? 'YES' : 'NO');
log('savedPin:', savedPin);
log('needSyncWskey:', needSyncWskey);

if (!savedPin) {
    log('NO PIN');
    done();
    return;
}

const tasks = [];

if (savedWskey && needSyncWskey) {
    tasks.push({ name: 'JD_WSCK', value: `pin=${savedPin};wskey=${savedWskey};` });
    log('TASK: JD_WSCK (new/changed)');
} else if (savedWskey) {
    tasks.push({ name: 'JD_WSCK', value: `pin=${savedPin};wskey=${savedWskey};` });
    log('TASK: JD_WSCK (existing)');
}

if (ptKey && pin) {
    tasks.push({ name: 'JD_COOKIE', value: `pt_key=${ptKey};pt_pin=${pin};` });
}

if (tasks.length === 0) {
    log('No tasks');
    done();
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
    done();
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
    
    httpRequest({ url: tokenUrl, method: 'GET' }, function(err, res, body) {
        if (!err && body) {
            try {
                const j = JSON.parse(body);
                const token = j.data?.token || null;
                if (token) {
                    log('Token OK');
                    cb(token);
                    return;
                }
            } catch (parseErr) {
                log('Token parse error');
                cb(null);
                return;
            }
        }

        if (retries < MAX_RETRIES) {
            log('Token retry', retries + 1);
            setTimeout(() => getToken(cb, retries + 1), RETRY_DELAY);
        } else {
            log('Token failed after retries');
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
    httpRequest({ 
        url: searchUrl, 
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token }
    }, function(err, res, body) {
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
    httpRequest({
        url: QL_URL + '/open/envs/enable?t=' + Date.now(),
        method: 'PUT',
        headers: { 
            Authorization: 'Bearer ' + token, 
            'Content-Type': 'application/json'
        },
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
        const reqHeaders = { 
            Authorization: 'Bearer ' + token, 
            'Content-Type': 'application/json'
        };

        const doRequest = function(cb) {
            if (env && env.id) {
                log('UPDATE', task.name);
                httpRequest({
                    url: QL_URL + '/open/envs?t=' + Date.now(),
                    method: 'PUT',
                    headers: reqHeaders,
                    body: JSON.stringify({ 
                        id: env.id, 
                        name: task.name, 
                        value: task.value, 
                        remarks: savedPin 
                    })
                }, cb);
            } else {
                log('CREATE', task.name);
                httpRequest({
                    url: QL_URL + '/open/envs?t=' + Date.now(),
                    method: 'POST',
                    headers: reqHeaders,
                    body: JSON.stringify([{ 
                        name: task.name, 
                        value: task.value, 
                        remarks: savedPin 
                    }])
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
        done();
        return;
    }

    log('Token OK');

    let i = 0;
    function next() {
        if (i >= tasks.length) {
            log('All done');
            done();
            return;
        }
        syncOne(token, tasks[i++], next);
    }

    next();
});
