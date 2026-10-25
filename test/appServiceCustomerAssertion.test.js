'use strict';
const { createBrowserAuthService } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createProductionApplication } = require('../lib/productionApplication');
const { DEADLINE_MS } = require('../api/shared/customerSignup/appServiceCredential');
const { createAppServiceCustomerAssertion } = require('../api/shared/customerSignup/appServiceCustomerAssertion');
const { configuration } = require('./helpers/publicCustomerAssertion');
const { options, transport, validBody, settle } = require('./helpers/syntheticAppServiceTransport');
const { apiRequire, denyOutbound, syntheticIdentityEnvironment, keyVaultTransport, offlineMsal,
    captureIdentityLogs, response, GENERIC, CONTEXT, IDENTITY_HEADER, FAKE_TOKEN, METADATA_BASE, id } = require('./helpers/offlineCustomerSigner');
const PRIVATE = 'OFFLINE_SIGNER_PRIVATE_RESPONSE';
let escapes, logging;
beforeEach(() => { jest.resetModules(); escapes=denyOutbound(); syntheticIdentityEnvironment(); });
afterEach(() => {
    try { expect(escapes).toEqual([]); }
    finally { logging?.restore(); logging=null; jest.restoreAllMocks(); jest.useRealTimers(); }
});

function signer(config={}, extra={}) {
    const t=transport(config), o=options(), h=keyVaultTransport();
    const calls=[], clients=[], credentials=[], wrappers=new WeakMap();
    const sdk=apiRequire('@azure/keyvault-keys');
    // Observe constructor arguments and forward every getToken to actual source.
    // No credential behavior, token or fresh-client lifecycle is substituted.
    function observed(credential) {
        credentials.push(credential);
        if(!wrappers.has(credential))wrappers.set(credential,{getToken(...args){
            calls.push(args);return credential.getToken(...args);
        }});
        return wrappers.get(credential);
    }
    class KeyClient extends sdk.KeyClient {
        constructor(url,credential,settings){super(url,observed(credential),settings);clients.push(this);}
    }
    class CryptographyClient extends sdk.CryptographyClient {
        constructor(key,credential,settings){super(key,observed(credential),settings);}
    }
    const sourceOptions={enabled:true,configuration:configuration(),managedIdentity:o.identity,
        managedIdentityTenantId:o.tenantId,env:o.env,...extra.options};
    const dependencies={identityRequest:t.request,httpClient:h.httpClient,KeyClient,CryptographyClient};
    h.callback=createAppServiceCustomerAssertion(sourceOptions,dependencies);
    const m=offlineMsal(h.callback);
    return {t,credentialCalls:calls,clients,credentials,h,m,sourceOptions,dependencies};
}

test.each([undefined,false])('source signer disabled=%s reads no environment, pins, SDK or credential dependency',enabled=>{
    const source=new Proxy({enabled},{get(target,key){if(key==='enabled')return target.enabled;throw new Error('disabled signer config access');}});
    const dependencies=new Proxy({},{get(){throw new Error('disabled signer dependency access');},ownKeys(){throw new Error('disabled signer dependency enumeration');}});
    expect(createAppServiceCustomerAssertion(source,dependencies)).toBeNull();expect(createAppServiceCustomerAssertion()).toBeNull();
});

test.each([null,0,'true','false'])('source signer rejects nonboolean enablement %j',enabled=>{
    expect(()=>createAppServiceCustomerAssertion({enabled})).toThrow(GENERIC);
});

test('invalid assertion pins reject before identity environment or SDK dependency access',()=>{
    const source={enabled:true,configuration:{...configuration(),keyId:'https://invalid.invalid/keys/key/version'},
        managedIdentity:options().identity,managedIdentityTenantId:id(1),
        env:new Proxy({},{get(){throw new Error('identity environment must not be read');}})};
    const touched=[];
    const dependencies={get identityRequest(){touched.push('request');throw new Error('not expected');},
        get KeyClient(){touched.push('SDK');throw new Error('not expected');}};
    expect(()=>createAppServiceCustomerAssertion(source,dependencies)).toThrow(GENERIC);expect(touched).toEqual([]);
});

test.each(['missing client ID','principal ID field','missing hosting tenant','mixed secret','credential override'])(
    'source signer rejects %s without HTTP or inferred metadata',defect=>{
        const t=transport(),o=options(),source={enabled:true,configuration:configuration(),managedIdentity:o.identity,
            managedIdentityTenantId:o.tenantId,env:o.env},dependencies={identityRequest:t.request};
        if(defect==='missing client ID')delete source.managedIdentity.clientId;
        if(defect==='principal ID field'){source.managedIdentity.principalId=id(7);delete source.managedIdentity.clientId;}
        if(defect==='missing hosting tenant')delete source.managedIdentityTenantId;
        if(defect==='mixed secret')source.clientSecret='OFFLINE_FORBIDDEN';
        if(defect==='credential override')dependencies.ManagedIdentityCredential=class{};
        expect(()=>createAppServiceCustomerAssertion(source,dependencies)).toThrow(GENERIC);expect(t.request).not.toHaveBeenCalled();
    });

test('ordinary runtime has no selector for this source factory while external authentication is disabled',()=>{
    const reads=[];
    const env=new Proxy({NODE_ENV:'test',NOFRIES_EXTERNAL_CUSTOMER_ENABLED:'false'},{get(target,key){
        if(typeof key==='string'&&(key.startsWith('IDENTITY_')||key.startsWith('NOFRIES_EXTERNAL_CUSTOMER_'))){
            reads.push(key);if(key!=='NOFRIES_EXTERNAL_CUSTOMER_ENABLED')throw new Error('unselected credential config access');
        }
        return target[key];
    }});
    const createAppServiceCustomerAssertion=jest.fn(()=>{throw new Error('runtime selector not authorized');});
    expect(typeof createProductionApplication(env,{createAppServiceCustomerAssertion})).toBe('function');
    expect(createAppServiceCustomerAssertion).not.toHaveBeenCalled();expect(reads).toEqual(['NOFRIES_EXTERNAL_CUSTOMER_ENABLED']);
});

test('all per-read and signing clients receive one source credential across repeated callbacks',async()=>{
    const s=signer();
    for(let i=0;i<3;i++)await expect(s.m.exchange()).rejects.toThrow(GENERIC);
    expect(s.clients).toHaveLength(3);expect(new Set(s.clients).size).toBe(3);
    expect(s.credentials).toHaveLength(6);expect(new Set(s.credentials).size).toBe(1);
    expect(s.t.calls).toHaveLength(3);expect(s.m.calls).toHaveLength(0);
});

test('explicit hosting MI tenant remains separate from the external customer tenant and client',async()=>{
    const s=signer({}, {options:{managedIdentityTenantId:id(5)}}),original=s.h.httpClient.sendRequest.getMockImplementation();
    s.h.httpClient.sendRequest.mockImplementation(request=>request.headers.has('authorization')?original(request):
        Promise.resolve(response(request,401,{}, {'www-authenticate':
            `Bearer authorization="https://login.microsoftonline.com/${id(5)}", resource="https://vault.azure.net"`} )));
    await expect(s.m.exchange()).rejects.toThrow(GENERIC); // reaches native zero-signature denial.
    expect(s.h.calls.map(r=>r.method)).toEqual(['GET','POST']);
    expect(s.credentialCalls.every(([,o])=>o.tenantId===id(5))).toBe(true);
    expect(CONTEXT.clientId).toBe(id(2));expect(s.sourceOptions.managedIdentity.clientId).toBe(id(7));
    expect(s.t.calls).toHaveLength(1);expect(s.m.calls).toHaveLength(0);
});

test('a mismatching expected hosting client ID cannot be accepted as an identity match',async()=>{
    const s=signer({}, {options:{managedIdentity:{kind:'system-assigned',clientId:id(8)}}});
    await expect(s.m.exchange()).rejects.toThrow(GENERIC);expect(s.t.calls).toHaveLength(1);
    expect(s.h.calls).toHaveLength(0);expect(s.m.calls).toHaveLength(0);
});

test('user-assigned source selection sends exactly client_id and preserves public SDK verification',async()=>{
    const s=signer({}, {options:{managedIdentity:{kind:'user-assigned',clientId:id(7)}}});
    await expect(s.m.exchange()).rejects.toThrow(GENERIC);
    expect(s.t.calls).toHaveLength(1);expect(s.t.calls[0].url.searchParams.get('client_id')).toBe(id(7));
    expect([...s.t.calls[0].url.searchParams.keys()]).toEqual(['resource','api-version','client_id']);
    expect(s.h.calls.map(r=>r.method)).toEqual(['GET','POST']);expect(s.m.calls).toHaveLength(0);
});

test('root governed SDK closure also uses the actual source factory without mocked credentials or signature verification',async()=>{
    const s=signer(),{KeyClient,CryptographyClient}=require('@azure/keyvault-keys');
    const callback=createAppServiceCustomerAssertion(s.sourceOptions,{identityRequest:s.t.request,httpClient:s.h.httpClient,KeyClient,CryptographyClient});
    await expect(callback(CONTEXT)).rejects.toThrow(GENERIC);
    expect(s.t.calls).toHaveLength(1);expect(s.h.calls.map(r=>r.method)).toEqual(['GET','POST']);
});

test('independent staff MSAL exchange never invokes the new customer source credential or signer',async()=>{
    const s=signer(),staff=offlineMsal(null,{staff:true,clientId:id(6)});
    await expect(staff.exchange()).rejects.toMatchObject({errorCode:'invalid_grant'});
    expect(staff.calls).toHaveLength(1);expect(staff.calls[0].form.has('client_secret')).toBe(true);
    expect(staff.calls[0].form.has('client_assertion')).toBe(false);
    expect(s.t.request).not.toHaveBeenCalled();expect(s.h.attempts).toHaveLength(0);
    expect(s.clients).toHaveLength(0);expect(s.m.calls).toHaveLength(0);
});

function otherConsumer() {
    const {ManagedIdentityCredential}=apiRequire('@azure/identity');
    const requests=[];
    const credential=new ManagedIdentityCredential({clientId:id(8),retryOptions:{maxRetries:0},httpClient:{
        sendRequest:jest.fn(async request=>{
            requests.push(request);
            return response(request,400,{error:'invalid_request',error_description:'OFFLINE_OTHER_DIAGNOSTIC'});
        })
    }});
    return {requests,run:()=>credential.getToken('https://vault.azure.net/.default').catch(e=>e)};
}
const diagnostic=()=>apiRequire('@azure/logger').createClientLogger('offline-unrelated-sdk').error('OFFLINE_CONCURRENT_DIAGNOSTIC');

test.each(['error','verbose'].flatMap(level=>['other first','signer first'].map(order=>[level,order])))(
    'REST isolation at %s with %s: actual unrelated SDK keeps its own transport and diagnostics',async(level,order)=>{
        logging=captureIdentityLogs(level);
        const s=signer({status:400,body:{error_description:PRIVATE}});
        let other;
        if(order==='other first'){other=otherConsumer();await other.run();}
        else{await expect(s.h.callback(CONTEXT)).rejects.toThrow(GENERIC);other=otherConsumer();}
        logging.output.length=0;
        await Promise.all([s.m.exchange().catch(e=>e),other.run(),Promise.resolve().then(diagnostic)]);
        expect(s.t.calls).toHaveLength(order==='other first'?1:2);
        expect(s.t.calls.every(c=>!c.url.searchParams.has('client_id'))).toBe(true);
        expect(other.requests).toHaveLength(order==='other first'?2:1);
        expect(other.requests.every(r=>new URL(r.url).searchParams.get('client_id')===id(8))).toBe(true);
        const logs=logging.output.join('\n');
        expect(logs).toContain('OFFLINE_OTHER_DIAGNOSTIC');expect(logs).toContain('OFFLINE_CONCURRENT_DIAGNOSTIC');
        expect(logs).not.toContain(PRIVATE);expect(logs).not.toContain(IDENTITY_HEADER);
        expect(s.m.calls).toHaveLength(0);expect(s.h.calls).toHaveLength(0);
    });

const failureCases = ['denied','malformed JSON','malformed success','oversized','hostile headers','transport'];
function failureConfig(kind) {
    if(kind==='denied')return {status:503,body:{error:'private',error_description:PRIVATE}};
    if(kind==='malformed JSON')return {raw:PRIVATE+'{'};
    if(kind==='malformed success')return {body:{...validBody(),access_token:{private:PRIVATE}}};
    if(kind==='oversized')return {raw:PRIVATE.repeat(3000)};
    if(kind==='hostile headers')return {status:302,headers:{location:'http://evil.invalid/'+PRIVATE,'x-private':PRIVATE,'retry-after':'0'}};
    if(kind==='transport')return {throw:true};
    throw new Error('unexpected test case');
}

test.each(['error','verbose'].flatMap(level=>failureCases.map(kind=>[level,kind])))(
    'real Key Vault/MSAL composition at %s cannot log signer %s details or submit a token',async(level,kind)=>{
        logging=captureIdentityLogs(level);
        const consoleCalls=[];
        for(const method of ['log','warn','error','info'])jest.spyOn(console,method).mockImplementation((...args)=>consoleCalls.push(args.join(' ')));
        const s=signer(failureConfig(kind));
        await expect(s.m.exchange()).rejects.toThrow(GENERIC);
        const logs=[...logging.output,...consoleCalls].join('\n');
        for(const marker of [PRIVATE,IDENTITY_HEADER,FAKE_TOKEN,'OFFLINE_TRANSPORT_PRIVATE','OFFLINE_CAUSE_PRIVATE'])expect(logs).not.toContain(marker);
        expect(s.t.request).toHaveBeenCalledTimes(1);expect(s.h.calls).toHaveLength(0);expect(s.m.calls).toHaveLength(0);
    });

test('synthetic REST success reaches actual public SDK but native zero signature blocks MSAL submission and logs no token',async()=>{
    logging=captureIdentityLogs('verbose');const s=signer();
    await expect(s.m.exchange()).rejects.toThrow(GENERIC);
    expect(s.h.calls.map(r=>r.method)).toEqual(['GET','POST']);
    expect(s.credentialCalls.length).toBeGreaterThan(0);
    expect(s.credentialCalls[0][1]).toMatchObject({tenantId:id(1),enableCae:true,requestOptions:{timeout:5000}});
    expect(s.t.calls).toHaveLength(1); // shared callback abort signal, SDK clients cannot replay MI.
    expect(s.m.calls).toHaveLength(0);
    expect(logging.output.join('\n')).not.toContain(FAKE_TOKEN);expect(logging.output.join('\n')).not.toContain(IDENTITY_HEADER);
});

test.each(['foreign resource','foreign tenant','redirect'])('public Key Vault %s boundary stays enforced before REST access',async kind=>{
    const s=signer();
    s.h.httpClient.sendRequest.mockImplementation(async request=>response(request,kind==='redirect'?302:401,{},
        kind==='redirect'?{location:'https://foreign.invalid/keys/other'}:{'www-authenticate':
            `Bearer authorization="https://login.microsoftonline.com/${kind==='foreign tenant'?id(8):id(1)}", resource="${kind==='foreign resource'?'https://foreign.invalid':'https://vault.azure.net'}"`}));
    await expect(s.m.exchange()).rejects.toThrow(GENERIC);
    expect(s.h.httpClient.sendRequest).toHaveBeenCalledTimes(1);expect(s.t.request).not.toHaveBeenCalled();expect(s.m.calls).toHaveLength(0);
});

test.each(['private key','revoked key','wrong wire ID'])('public SDK and frozen signer reject %s after synthetic REST success',async kind=>{
    const s=signer();
    if(kind==='private key')s.h.body.key.d='OFFLINE_PRIVATE_COMPONENT';
    if(kind==='revoked key')s.h.body.attributes.enabled=false;
    if(kind==='wrong wire ID')s.h.signed.kid+='changed';
    await expect(s.m.exchange()).rejects.toThrow(GENERIC);expect(s.m.calls).toHaveLength(0);
    expect(s.h.calls.map(r=>r.method)).toEqual(kind==='wrong wire ID'?['GET','POST']:['GET']);
});

test('claims challenge is rejected, with no second REST request or authenticated SDK retry',async()=>{
    const s=signer(), original=s.h.httpClient.sendRequest.getMockImplementation();
    s.h.httpClient.sendRequest.mockImplementation(async request=>request.headers.has('authorization')
        ? response(request,401,{}, {'www-authenticate':`Bearer error="insufficient_claims", claims="${Buffer.from('{"OFFLINE_PRIVATE_CLAIMS":true}').toString('base64')}"`})
        : original(request));
    await expect(s.m.exchange()).rejects.toThrow(GENERIC);expect(s.t.calls).toHaveLength(1);
    expect(s.credentialCalls.some(([,o])=>Object.hasOwn(o,'claims'))).toBe(true);
    expect(s.h.httpClient.sendRequest).toHaveBeenCalledTimes(2);expect(s.m.calls).toHaveLength(0);
});

test.each(['headers','body'])('actual SDK forwards cancellation and the owned %s deadline frees closed work before outer expiry',async phase=>{
    jest.useFakeTimers({doNotFake:['queueMicrotask']});const s=signer({phase});
    const pending=s.m.exchange().catch(e=>e);await settle();await jest.advanceTimersByTimeAsync(DEADLINE_MS);
    expect((await pending).message).toBe(GENERIC);expect(s.t.calls).toHaveLength(1);
    expect(s.t.calls[0].req.destroy).toHaveBeenCalled();if(phase==='body')expect(s.t.calls[0].res.destroy).toHaveBeenCalled();
    expect(s.m.calls).toHaveLength(0);
    s.t.config.phase=undefined;s.t.config.status=503;
    await expect(s.m.exchange()).rejects.toThrow(GENERIC);expect(s.t.calls).toHaveLength(2);
});

test('four timed-out callbacks cannot grow REST work when a broken transport ignores destroy; close restores capacity',async()=>{
    jest.useFakeTimers({doNotFake:['queueMicrotask']});const s=signer({phase:'headers',ignoreDestroy:true});
    const pending=Array.from({length:4},()=>s.m.exchange().catch(e=>e));await settle();
    await jest.advanceTimersByTimeAsync(DEADLINE_MS);
    expect((await Promise.all(pending)).every(e=>e.message===GENERIC)).toBe(true);
    // Four fresh KeyClients still consume one shared credential budget.
    expect(s.clients).toHaveLength(4);expect(new Set(s.credentials).size).toBe(1);
    expect(s.t.calls).toHaveLength(4);
    await expect(s.m.exchange()).rejects.toThrow(GENERIC);expect(s.t.calls).toHaveLength(4);expect(s.m.calls).toHaveLength(0);
    expect(s.clients).toHaveLength(5);expect(new Set(s.credentials).size).toBe(1);
    s.t.calls.forEach(c=>c.close());s.t.config.ignoreDestroy=false;s.t.config.phase=undefined;s.t.config.status=503;
    await expect(s.m.exchange()).rejects.toThrow(GENERIC);expect(s.t.calls).toHaveLength(5);
});

test('fresh public KeyClient per read removes cached background refresh after failure while retaining native signature rejection',async()=>{
    jest.useFakeTimers({doNotFake:['queueMicrotask']});
    const s=signer({body:{...validBody(),expires_on:String(Math.floor(Date.now()/1000)+90)}});
    await expect(s.m.exchange()).rejects.toThrow(GENERIC);
    expect(s.h.calls.map(r=>r.method)).toEqual(['GET','POST']); // native zero signature still fails.
    s.t.config.status=503;await expect(s.m.exchange()).rejects.toThrow(GENERIC);
    const requests=s.t.calls.length,attempts=s.credentialCalls.length;
    await jest.advanceTimersByTimeAsync(90001);
    expect(s.credentialCalls).toHaveLength(attempts);expect(s.t.calls).toHaveLength(requests);
    expect(jest.getTimerCount()).toBe(0);expect(s.m.calls).toHaveLength(0);
});

test.each(['foreign resource','foreign tenant','wrong wire ID','claims challenge'])(
    'fresh public KeyClient composition retains the %s check',async kind=>{
        const s=signer({}),original=s.h.httpClient.sendRequest.getMockImplementation();
        if(kind==='wrong wire ID')s.h.signed.kid+='changed';
        else s.h.httpClient.sendRequest.mockImplementation(async request=>{
            if(kind==='claims challenge')return request.headers.has('authorization')
                ? response(request,401,{}, {'www-authenticate':`Bearer error="insufficient_claims", claims="${Buffer.from('{}').toString('base64')}"`})
                : original(request);
            return response(request,401,{}, {'www-authenticate':
                `Bearer authorization="https://login.microsoftonline.com/${kind==='foreign tenant'?id(8):id(1)}", resource="${kind==='foreign resource'?'https://foreign.invalid':'https://vault.azure.net'}"`});
        });
        await expect(s.m.exchange()).rejects.toThrow(GENERIC);expect(s.m.calls).toHaveLength(0);
        expect(s.t.calls).toHaveLength(kind==='foreign resource'||kind==='foreign tenant'?0:1);
    });

function browser(m) {
    const store=new MemoryBrowserSessionStore();
    const env={NOFRIES_PUBLIC_URL:'https://nofries.example.test',NOFRIES_REQUIRE_AUTH:'true',
        NOFRIES_ENTRA_TENANT_ID:id(5),NOFRIES_ENTRA_CLIENT_ID:id(6),NOFRIES_ENTRA_CLIENT_SECRET:'OFFLINE_STAFF_PLACEHOLDER',
        NOFRIES_ALLOWED_SUBJECTS:id(5)+':'+id(9),NOFRIES_CUSTOMER_ENTRA_CLIENT_ID:id(2),
        NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET:'OFFLINE_CONFIG_PLACEHOLDER_NEVER_SENT'};
    const policy={begin:async()=>({context:{kind:'offline-customer'}}),verify:jest.fn(),recheck:jest.fn()};
    const service=createBrowserAuthService({env,store,clientApplication:m.app,customerPolicy:policy,customerTransport:'external',
        cryptoProvider:{generatePkceCodes:async()=>({verifier:'v'.repeat(64),challenge:'c'.repeat(43)})},
        customerIdentityProvider:{kind:'external-id',tenantId:id(1),clientId:id(2),authority:'https://synthetic-customer.ciamlogin.com/',
            issuer:`https://${id(1)}.ciamlogin.com/${id(1)}/v2.0`,authorizationEndpoint:METADATA_BASE+'/oauth2/v2.0/authorize'}});
    return {store,policy,service,createSession:jest.spyOn(store,'createSession')};
}

test.each([...failureCases,'body timeout'])('browser failure on %s consumes one transaction and never creates a token/session',async kind=>{
    if(kind==='body timeout')jest.useFakeTimers({doNotFake:['queueMicrotask']});
    const s=signer(kind==='body timeout'?{phase:'body'}:failureConfig(kind)),b=browser(s.m);
    const preserved=Object.freeze({synthetic:'existing record'});b.store.sessions.set('existing',preserved);
    const started=await b.service.beginLogin(),input={cookieHeader:started.cookie.split(';')[0],body:{
        state:new URL(started.location).searchParams.get('state'),code:'OFFLINE_NOT_A_CODE'}};
    const pending=b.service.completeLogin(input).catch(e=>e);
    if(kind==='body timeout'){await settle();await jest.advanceTimersByTimeAsync(DEADLINE_MS);}
    const failure=await pending;
    expect(failure).toMatchObject({code:'browser_auth_code_exchange_failed',clearTransactionCookie:true});
    expect(failure.cause).toBeUndefined();expect(failure.cookie).toBeUndefined();expect(failure.identity).toBeUndefined();
    expect(s.m.calls).toHaveLength(0);expect(b.createSession).not.toHaveBeenCalled();
    expect([...b.store.sessions]).toEqual([['existing',preserved]]);expect(b.store.transactions.size).toBe(0);
    expect(b.policy.verify).not.toHaveBeenCalled();expect(b.policy.recheck).not.toHaveBeenCalled();
    await expect(b.service.completeLogin(input)).rejects.toMatchObject({code:'browser_auth_transaction_invalid'});
});
