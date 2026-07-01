// ==========================================
// 京东 WSKEY & Cookie → 青龙（简洁版）
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
// 通知
// ======================
function notify(title, subtitle, body) {
    $notification.post(title, subtitle || '', body || '');
    log('NOTIFY:', title);
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
// 【WSKEY 请求】捕获 + 标记变更
// ======================
if (isWskeyRequest) {
    const oldWskey = S.get('JD_WSKEY_' + pin);
    
    if (!oldWskey) {
        log('WSKEY FIRST TIME for', pinDecoded);
        notify('🔐 首次捕获 WSKEY', pinDecoded, '等待 Cookie 完整同步...');
    } else if (oldWskey !== wskey) {
        log('WSKEY CHANGED for', pinDecoded);
        notify('🔐 检测到新登录', pinDecoded, '准备重新同步...');
        // 【关键】标记为需要同步
        S.set('JD_WSKEY_NEED_SYNC_' + pin, '1');
    }
    
    // 保存 WSKEY
    S.set('JD_WSKEY_' + pin, wskey);
    S.set('JD_PIN_' + pin, pinDecoded);
    
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
log('COOKIE REQUEST:', pin);

if (!pin || !ptKey) {
    log('MISSING DATA');
    $done({});
    return;
}

// 【防重复】60秒内只同步一次
const SYNC_KEY = 'JD_SYNC_TIME_' + pin;
const lastSyncTime = parseInt(S.get(SYNC_KEY) || '0');
const now = Date.now();

if (now - lastSyncTime < 60000) {
    log('SKIP: Synced', ((now - lastSyncTime) / 1000).toFixed(1), 's ago');
    $done({});
    return;
}

// 更新同步时间
S.set(SYNC_KEY, now);

// ======================
// 构建任务
// ======================
const tasks = [];

// 检查 WSKEY 是否需要同步
const needWskeySync = S.get('JD_WSKEY_NEED_SYNC_' + pin) === '1';
const savedWskey = S.get('JD_WSKEY_' + pin);

if (savedWskey && needWskeySync) {
    tasks.push({
        name: 'JD_WSCK',
        value: `pin=${pin};wskey=${savedWskey};`,
        pin: pin,
        type: 'wskey'
    });
    log('TASK: JD_WSCK');
}

// Cookie 总是同步
tasks.push({
    name: 'JD_COOKIE',
    value: `pt_key=${ptKey};pt_pin=${pin};`,
    pin: pin,
    type: 'cookie'
});
log('TASK: JD_COOKIE');

if (tasks.length === 0) {
    log('No tasks');
    $done({});
    return;
}

// ======================
// 启动通知
// ======================
const taskDesc = tasks.map(t => t.name).join(' + ');
notify('🚀 开始同步', pinDecoded, taskDesc);

// ======================
// TOKEN（10秒超时）
// ======================
function getToken(cb) {
    const tokenUrl = QL_URL + '/open/auth/token?client_id=' + encodeURIComponent(QL_CLIENT_ID) + '&client_secret=' + encodeURIComponent(QL_CLIENT_SECRET);
    const tid = setTimeout(() => {
        log('Token timeout');
        cb(null);
    }, 10000);
    
    $httpClient.get(tokenUrl, function (err, res, body) {
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
// 查找 ENV
// ======================
function findEnv(token, name, pin, cb) {
    const searchUrl = QL_URL + '/open/envs?searchValue=' + encodeURIComponent(name);
    $httpClient.get({
        url: searchUrl,
        headers: { Authorization: 'Bearer ' + token }
    }, function (err, res, body) {
        if (err || !body) {
            log('Search error');
            cb(null);
            return;
        }
        try {
            const list = JSON.parse(body).data || [];
            let env = list.find(x => x.name === name && x.remarks === pin);
            if (!env) {
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
// 同步单个任务
// ======================
function syncOne(token, task, done) {
    findEnv(token, task.name, task.pin, function(env) {
        const headers = {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
        };

        const isUpdate = env && env.id;
        const url = QL_URL + '/open/envs';
        
        const body = isUpdate
            ? JSON.stringify({
                id: env.id,
                name: task.name,
                value: task.value,
                remarks: task.pin
            })
            : JSON.stringify([{
                name: task.name,
                value: task.value,
                remarks: task.pin
            }]);

        const method = isUpdate ? 'put' : 'post';

        $httpClient[method]({
            url: url,
            headers: headers,
            body: body
        }, function(err, res, respBody) {
            if (err || !respBody) {
                log(task.name, 'FAILED: network error');
                notify('❌ ' + task.name + ' 失败', pinDecoded, '网络错误');
                done();
                return;
            }

            try {
                const r = JSON.parse(respBody);
                if (r.code === 200) {
                    log(task.name, 'SUCCESS');
                    
                    if (task.type === 'wskey') {
                        notify('✅ WSKEY 已同步', pinDecoded, isUpdate ? '已更新' : '已创建');
                        S.set('JD_WSKEY_NEED_SYNC_' + task.pin, '0');
                    } else {
                        notify('✅ Cookie 已同步', pinDecoded, isUpdate ? '已更新' : '已创建');
                    }
                    
                    if (env && env.id) {
                        enableEnv(token, env.id);
                    }
                } else {
                    log(task.name, 'FAILED:', r.message);
                    notify('❌ ' + task.name + ' 失败', pinDecoded, r.message || '未知错误');
                }
            } catch (e) {
                log(task.name, 'FAILED: parse error');
                notify('❌ ' + task.name + ' 失败', pinDecoded, '青龙响应异常');
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
        notify('❌ 登录失败', '青龙', 'Token 获取失败，请检查配置');
        $done({});
        return;
    }

    log('Token OK');

    let i = 0;
    function next() {
        if (i >= tasks.length) {
            log('All tasks done');
            notify('✅ 全部同步完成', pinDecoded, '可在青龙中使用');
            setTimeout(() => $done({}), 200);
            return;
        }
        syncOne(token, tasks[i++], next);
    }

    next();
});
