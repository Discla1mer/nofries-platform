'use strict';
const { Duplex } = require('node:stream');
// Captured only for tests that inject an in-memory createConnection. All socket,
// DNS, global HTTP/fetch and CLI escapes remain guarded in every scenario.
const nativeRequest = require('node:http').request;
const { createAppServiceCredential, DEADLINE_MS, MAX_BYTES, MESSAGE } = require('../api/shared/customerSignup/appServiceCredential');
const { transport, options, validBody, settle, SCOPE } = require('./helpers/syntheticAppServiceTransport');
const { denyOutbound, syntheticIdentityEnvironment, IDENTITY_HEADER, FAKE_TOKEN, id } = require('./helpers/offlineCustomerSigner');
let escapes;
beforeEach(() => { escapes = denyOutbound(); syntheticIdentityEnvironment(); });
afterEach(() => {
    try { expect(escapes).toEqual([]); }
    finally { jest.restoreAllMocks(); jest.useRealTimers(); }
});
const rejected = async promise => {
    const result = await promise.catch(e => e);
    expect(result).toBeInstanceOf(Error); expect(result.message).toBe(MESSAGE);
    expect(result.code).toBe('appservice_identity_unavailable'); expect(result.cause).toBeUndefined();
    expect(Object.keys(result)).toEqual(['code']); return result;
};
const make = (t, o = options()) => createAppServiceCredential(o, { request: t.request });

test.each([undefined,false])('source credential disabled=%s reads only its enable gate',enabled=>{
    const source=new Proxy({enabled},{get(target,key){if(key==='enabled')return target.enabled;throw new Error('disabled config access');}});
    const dependencies=new Proxy({},{get(){throw new Error('disabled dependency access');},ownKeys(){throw new Error('disabled dependency enumeration');}});
    expect(createAppServiceCredential(source,dependencies)).toBeNull();expect(createAppServiceCredential()).toBeNull();
});

test.each([null,0,'true','false'])('source credential rejects nonboolean enablement %j',enabled=>{
    const t=transport();expect(()=>make(t,{...options(),enabled})).toThrow(MESSAGE);expect(t.request).not.toHaveBeenCalled();
});

test('enabled source default HTTP dependency remains one owned request, with no ambient credential fallback',async()=>{
    const t=transport();require('node:http').request.mockImplementation(t.request);
    const c=createAppServiceCredential(options());
    expect((await c.getToken(SCOPE)).token).toBe(FAKE_TOKEN);expect(t.calls).toHaveLength(1);
});

test('operation memo expires without retry; a fresh signal performs a fresh acquisition',async()=>{
    jest.useFakeTimers({doNotFake:['queueMicrotask']});const t=transport(),c=make(t),a=new AbortController();
    await c.getToken(SCOPE,{abortSignal:a.signal});await jest.advanceTimersByTimeAsync(5000);
    await rejected(c.getToken(SCOPE,{abortSignal:a.signal}));expect(t.calls).toHaveLength(1);
    await c.getToken(SCOPE,{abortSignal:new AbortController().signal});expect(t.calls).toHaveLength(2);
});

test('throwing clock during acquisition cannot consume slots when no HTTP request exists',async()=>{
    const t=transport();let reads=0,throwOnAcquire=true;
    const c=createAppServiceCredential(options(),{request:t.request,now(){
        reads++;if(throwOnAcquire&&reads%2===0)throw new Error('OFFLINE_CLOCK_DETAIL');return Date.now();
    }});
    for(let i=0;i<6;i++)await rejected(c.getToken(SCOPE));expect(t.calls).toHaveLength(0);
    throwOnAcquire=false;expect((await c.getToken(SCOPE)).token).toBe(FAKE_TOKEN);
});

test.each(['system-assigned', 'user-assigned'])('explicit %s identity makes one fixed-resource request and validates success metadata', async kind => {
    const now = Date.now(), clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const body = validBody(), t = transport({ body }), o = options(); o.identity.kind = kind;
    const c = make(t, o), signal = new AbortController().signal;
    const token = await c.getToken([SCOPE], { abortSignal: signal, tenantId: id(1), enableCae: true,
        requestOptions: { timeout: 5000 }, tracingOptions: {} });
    clock.mockReturnValue(now + 1000);
    expect(token).toEqual({ token: FAKE_TOKEN, expiresOnTimestamp: Number(body.expires_on) * 1000, tokenType: 'Bearer' });
    expect(t.calls).toHaveLength(1);
    const { url, settings, req } = t.calls[0];
    expect([...url.searchParams]).toEqual([['resource', 'https://vault.azure.net'], ['api-version', '2019-08-01'],
        ...(kind === 'user-assigned' ? [['client_id', id(7)]] : [])]);
    expect(settings).toEqual({ method: 'GET', agent: false, maxHeaderSize: 8192,
        headers: { 'X-IDENTITY-HEADER': IDENTITY_HEADER, Accept: 'application/json', 'Accept-Encoding': 'identity' } });
    expect(req.end).toHaveBeenCalledTimes(1);
    expect(await c.getToken(SCOPE, { abortSignal: signal })).toBe(token);
    expect(t.calls).toHaveLength(1);
});

test('header rotation is read for each new operation; endpoint or identity mutations cannot retarget the credential', async () => {
    const t = transport(), o = options(), c = make(t, o);
    await c.getToken(SCOPE); o.env.IDENTITY_HEADER = 'OFFLINE_ROTATED_HEADER'; o.identity.clientId = id(8);
    await c.getToken(SCOPE);
    expect(t.calls[1].settings.headers['X-IDENTITY-HEADER']).toBe('OFFLINE_ROTATED_HEADER');
    expect(t.calls[1].url.searchParams.has('client_id')).toBe(false);
    o.env.IDENTITY_ENDPOINT = 'http://127.0.0.1:47112/changed';
    await rejected(c.getToken(SCOPE)); expect(t.calls).toHaveLength(2);
});

test.each(['http://169.254.169.254/metadata/identity/oauth2/token', 'http://127.0.0.1/metadata/identity',
    'https://example.invalid/token', 'http://example.invalid/token', 'http://10.0.0.2/token',
    'http://127.0.0.1/token?resource=other', 'http://127.0.0.1/token#private',
    'http://user:private@127.0.0.1/token', 'http://127.1/token', 'http://127.0.0.1/%74oken', ''])('rejects endpoint %s before I/O', value => {
    const t = transport(), o = options(); o.env.IDENTITY_ENDPOINT = value;
    expect(() => make(t, o)).toThrow(MESSAGE); expect(t.request).not.toHaveBeenCalled();
});

test.each([undefined, {}, {kind:'automatic',clientId:id(7)}, {kind:'system-assigned'},
    {kind:'user-assigned',clientId:id(7),objectId:id(8)}])('rejects implicit or ambiguous identity %j', identity => {
    const t = transport(), o = options(); o.identity = identity;
    expect(() => make(t, o)).toThrow(MESSAGE); expect(t.request).not.toHaveBeenCalled();
});

test.each([undefined, '', 'OFFLINE\r\nInjected: value', 'x'.repeat(4097)])('rejects invalid identity header without fallback %#', async header => {
    const t = transport(), o = options(); o.env.IDENTITY_HEADER = header;
    await rejected(make(t, o).getToken(SCOPE)); expect(t.request).not.toHaveBeenCalled();
});

test.each([
    ['https://graph.microsoft.com/.default', {}], [[SCOPE, SCOPE], {}], [[], {}],
    [SCOPE, {tenantId:id(8)}], [SCOPE, {claims:'OFFLINE_PRIVATE_CLAIMS'}],
    [SCOPE, {proofOfPossessionOptions:{nonce:'OFFLINE_PRIVATE_NONCE'}}], [SCOPE, {enableCae:'true'}],
    [SCOPE, {requestOptions:{timeout:0}}], [SCOPE, {requestOptions:{timeout:5001}}],
    [SCOPE, {requestOptions:{url:'http://example.invalid'}}], [SCOPE, {tracingOptions:{private:'marker'}}],
    [SCOPE, {abortSignal:{aborted:false}}], [SCOPE, {arbitrary:'OFFLINE_OPTION'}]
])('rejects unsupported scopes/options without HTTP %#', async (scope, input) => {
    const t = transport(); await rejected(make(t).getToken(scope, input)); expect(t.request).not.toHaveBeenCalled();
});

test.each([301,302,307,308,400,401,403,429,500,503])('HTTP %s discards adversarial body/headers with zero retry or redirect', async status => {
    const t = transport({status, raw:'OFFLINE_PRIVATE_BODY'.repeat(4000), headers: {
        location:'http://example.invalid/OFFLINE_LOCATION', 'retry-after':'0', 'x-ms-request-id':'OFFLINE_CORRELATION',
        authorization:'OFFLINE_AUTHORIZATION', 'www-authenticate':'OFFLINE_CHALLENGE'
    }});
    await rejected(make(t).getToken(SCOPE)); await settle();
    expect(t.request).toHaveBeenCalledTimes(1); expect(t.calls[0].req.destroy).toHaveBeenCalled();
    expect(t.calls[0].res.destroy).toHaveBeenCalled();
});

const badSuccess = [
    ['missing token', b => {delete b.access_token;}], ['empty token', b => {b.access_token='';}],
    ['token injection', b => {b.access_token='OFFLINE\r\nsecret';}], ['long token', b => {b.access_token='x'.repeat(16385);}],
    ['wrong resource', b => {b.resource='https://graph.microsoft.com';}], ['wrong type', b => {b.token_type='pop';}],
    ['wrong identity', b => {b.client_id=id(8);}], ['missing identity', b => {delete b.client_id;}],
    ['expired', b => {b.expires_on=String(Math.floor(Date.now()/1000)-1);}],
    ['excessive lifetime', b => {b.expires_on=String(Math.floor(Date.now()/1000)+172801);}],
    ['numeric expiry', b => {b.expires_on=123;}], ['ambiguous expiry', b => {b.expires_on='01';}],
    ['overflow expiry', b => {b.expires_on='99999999999999999999';}],
    ['future not before', b => {b.not_before=String(Math.floor(Date.now()/1000)+120);}],
    ['bad relative expiry', b => {b.expires_in='0';}],
    ['nested token', b => {b.access_token={private:'OFFLINE_PRIVATE'};}],
    ['unexpected field', b => {b.error_description='OFFLINE_PRIVATE';}]
];
test.each(badSuccess)('malformed success: %s cannot return a token', async (_name, mutate) => {
    // Keep expiry construction and validation at one instant across second boundaries.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now());
    const body=validBody(); mutate(body); const t=transport({body});
    await rejected(make(t).getToken(SCOPE)); expect(t.request).toHaveBeenCalledTimes(1);
});

test.each([[59, false], [60, true], [172800, true], [172801, false]])(
    'absolute expiry %s seconds ahead is accepted=%s at a fixed clock', async (seconds, accepted) => {
        const now = 1700000000000;
        jest.spyOn(Date, 'now').mockReturnValue(now);
        const body = { ...validBody(), expires_on: String(now / 1000 + seconds) }, t = transport({ body });
        const result = make(t).getToken(SCOPE);
        if (accepted) await expect(result).resolves.toEqual({ token: FAKE_TOKEN,
            expiresOnTimestamp: now + seconds * 1000, tokenType: 'Bearer' });
        else await rejected(result);
        expect(t.request).toHaveBeenCalledTimes(1);
    });

test.each(['{', 'null', '[]', '{} trailing', '{"access_token":"OFFLINE_1","access_token":"OFFLINE_2"}',
    '{"client_id":"one","client\\u005fid":"two"}', '{"x":true}', '{"x":1,}'])('malformed/duplicate JSON fails closed %#', async raw => {
    const t = transport({raw}); await rejected(make(t).getToken(SCOPE));
});

test.each([
    {bytes:Buffer.from([0xff])}, {headers:{'content-type':'text/html'}}, {headers:{'content-type':['application/json']}},
    {headers:{'content-encoding':'gzip'}}, {headers:{'content-length':'99999999'}},
    {headers:{'content-length':'1'}}, {raw:'x'.repeat(MAX_BYTES+1),chunkSize:1024}
])('invalid body encoding/size/headers destroys both sides %#', async config => {
    const t=transport(config); await rejected(make(t).getToken(SCOPE));
    expect(t.calls[0].req.destroy).toHaveBeenCalled(); expect(t.calls[0].res.destroy).toHaveBeenCalled();
});

test('transport throws and emitted errors cannot retain private details or consume capacity forever after close', async () => {
    const t=transport({throw:true}), c=make(t);
    for(let i=0;i<6;i++) await rejected(c.getToken(SCOPE));
    expect(t.request).toHaveBeenCalledTimes(6);
    t.config.throw=false; t.config.phase='headers';
    const p=c.getToken(SCOPE); await settle();
    t.calls[0].req.emit('error',Object.assign(new Error('OFFLINE_PRIVATE'),{cause:'OFFLINE_CAUSE'}));
    await rejected(p); await settle(); t.config.phase=undefined;
    expect((await c.getToken(SCOPE)).token).toBe(FAKE_TOKEN);
});

test.each(['empty chunks','excessive chunks','premature close','response error'])(
    '%s cannot hold an unbounded body buffer or return a token',async defect=>{
        const t=transport({phase:'body'}),c=make(t),p=rejected(c.getToken(SCOPE));await settle();
        const {res,req}=t.calls[0];
        if(defect==='empty chunks')res.emit('data',Buffer.alloc(0));
        if(defect==='excessive chunks')for(let i=0;i<4097;i++)res.emit('data',Buffer.from(' '));
        if(defect==='premature close')res.emit('close');
        if(defect==='response error')res.emit('error',Object.assign(new Error('OFFLINE_PRIVATE_STREAM'),{cause:'OFFLINE_PRIVATE_CAUSE'}));
        await p;expect(req.destroy).toHaveBeenCalled();expect(res.destroy).toHaveBeenCalled();
    });

test.each(['headers','body'])('total deadline destroys stalled %s and late success never resolves', async phase => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }); const t=transport({phase}), c=make(t);
    const p=rejected(c.getToken(SCOPE)); await jest.advanceTimersByTimeAsync(DEADLINE_MS);
    await p; expect(t.calls[0].req.destroy).toHaveBeenCalled();
    if(phase==='body') expect(t.calls[0].res.destroy).toHaveBeenCalled();
    if(phase==='headers') t.calls[0].headers(); t.calls[0].complete();
    t.config.phase=undefined; expect((await c.getToken(SCOPE)).token).toBe(FAKE_TOKEN);
});

test('caller abort and shorter request timeout destroy HTTP; already-aborted input performs no I/O', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }); const t=transport({phase:'body'}), c=make(t), a=new AbortController();
    const p=rejected(c.getToken(SCOPE,{abortSignal:a.signal})); await jest.advanceTimersByTimeAsync(0);
    a.abort(new Error('OFFLINE_PRIVATE_ABORT_REASON')); await p; await jest.advanceTimersByTimeAsync(0);
    expect(t.calls[0].req.destroy).toHaveBeenCalled(); expect(t.calls[0].res.destroy).toHaveBeenCalled();
    await rejected(c.getToken(SCOPE,{abortSignal:a.signal})); expect(t.calls).toHaveLength(1);
    const q=rejected(c.getToken(SCOPE,{requestOptions:{timeout:10}}));
    await jest.advanceTimersByTimeAsync(10); await q; expect(t.calls[1].req.destroy).toHaveBeenCalled();
});

test('four stalled requests retain their per-credential slots until actual close; no unbounded replacement work', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }); const t=transport({phase:'headers',ignoreDestroy:true}), c=make(t);
    const pending=Array.from({length:4},()=>rejected(c.getToken(SCOPE)));
    await rejected(c.getToken(SCOPE)); expect(t.calls).toHaveLength(4);
    await jest.advanceTimersByTimeAsync(DEADLINE_MS); await Promise.all(pending);
    await rejected(c.getToken(SCOPE)); expect(t.calls).toHaveLength(4);
    t.calls.forEach(call=>call.close()); t.config.phase=undefined; t.config.ignoreDestroy=false;
    expect((await c.getToken(SCOPE)).token).toBe(FAKE_TOKEN); expect(t.calls).toHaveLength(5);
});

test('one failed attempt per signal blocks SDK-style retry while a new operation can recover', async () => {
    const t=transport({status:503}), c=make(t), signal=new AbortController().signal;
    await rejected(c.getToken(SCOPE,{abortSignal:signal})); await rejected(c.getToken(SCOPE,{abortSignal:signal}));
    expect(t.calls).toHaveLength(1); t.config.status=200;
    expect((await c.getToken(SCOPE,{abortSignal:new AbortController().signal})).token).toBe(FAKE_TOKEN);
});

test('deadline includes final success parsing/validation and rejects a clock jump before token delivery',async()=>{
    const t=transport(),base=Date.now();let reads=0;
    const c=createAppServiceCredential(options(),{request:t.request,now:()=>base+(reads++>=5?DEADLINE_MS:0)});
    await rejected(c.getToken(SCOPE));expect(t.calls[0].req.destroy).toHaveBeenCalled();
});

function nativeTransport(mode) {
    const sockets=[], requests=[];
    const request=(url,settings)=>{
        let received='';
        const socket=new Duplex({read(){},write(chunk,_encoding,done){
            received+=chunk.toString('ascii'); done();
            if(!received.includes('\r\n\r\n') || this.responded) return;
            this.responded=true;
            queueMicrotask(()=>{
                if(mode==='headers') return;
                const bytes=Buffer.from(JSON.stringify(validBody()));
                this.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: '+bytes.length+'\r\nConnection: close\r\n\r\n'));
                if(mode==='body') return;
                this.push(bytes); this.push(null);
            });
        }});
        sockets.push(socket);
        // No Agent and no socket factory: the real HTTP client/parser operates
        // exclusively on this already-created in-memory Duplex.
        const req=nativeRequest(url,{...settings,agent:undefined,createConnection:()=>socket});
        requests.push(req); return req;
    };
    return {request,sockets,requests};
}

test('actual Node HTTP parser accepts synthetic success over an in-memory stream with zero socket connections', async () => {
    const t=nativeTransport('success'); expect((await make(t).getToken(SCOPE)).token).toBe(FAKE_TOKEN);
    await new Promise(setImmediate); expect(t.sockets[0].destroyed).toBe(true);
});

test.each(['headers','body'])('actual Node HTTP client destroys a synthetic stalled %s stream at the body-inclusive deadline', async phase => {
    const t=nativeTransport(phase);
    await rejected(make(t).getToken(SCOPE,{requestOptions:{timeout:30}}));
    await new Promise(setImmediate);
    expect(t.requests[0].destroyed).toBe(true); expect(t.sockets[0].destroyed).toBe(true);
});

test.each(['headers','body'])('actual Node HTTP client propagates caller abort through a synthetic %s stall',async phase=>{
    const t=nativeTransport(phase),a=new AbortController(),p=rejected(make(t).getToken(SCOPE,{abortSignal:a.signal}));
    await new Promise(setImmediate);a.abort(new Error('OFFLINE_PRIVATE_CALLER_ABORT'));await p;
    await new Promise(setImmediate);expect(t.requests[0].destroyed).toBe(true);expect(t.sockets[0].destroyed).toBe(true);
});
