import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
const source=fs.readFileSync(new URL('../插件/feishu-auth.js',import.meta.url),'utf8');
function store(seed={}) { const data=structuredClone(seed); return {data, async get(k){return k===null?structuredClone(data):{[k]:structuredClone(data[k])};},async set(v){Object.assign(data,structuredClone(v));},async remove(keys){for(const k of [keys].flat())delete data[k];},async setAccessLevel(v){assert.equal(v.accessLevel,'TRUSTED_CONTEXTS');}}; }
function lockManager(){const held=new Set(),queues=new Map();return {async request(name,opts,fn){if(typeof opts==='function'){fn=opts;opts={};}if(opts.ifAvailable&&held.has(name))return fn(null);while(held.has(name))await new Promise(r=>{const q=queues.get(name)||[];q.push(r);queues.set(name,q);});held.add(name);try{return await fn({name});}finally{held.delete(name);for(const r of queues.get(name)||[])r();queues.delete(name);}}};}
function harness(handler,seed={}){
 const local=store(seed),session=store(),locks=lockManager(),sleeps=[],requests=[];let clock=100000;
 const fetcher=async(url,init={})=>{assert(['https://accounts.feishu.cn','https://open.feishu.cn'].includes(new URL(url).origin));assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');requests.push({url,init,time:clock});return handler(url,init);};
 const ctx=vm.createContext({chrome:{storage:{local,session}},navigator:{locks},fetch:fetcher,URL,URLSearchParams,AbortController,AbortSignal,setTimeout,clearTimeout,btoa,Response,Blob,CompressionStream});
 vm.runInContext(source,ctx);
 const factory=vm.runInContext('createFeishuAuth',ctx);
 const api=factory({local,session,locks,fetcher,now:()=>clock,sleep:async(ms,signal)=>{sleeps.push(ms);clock+=ms;if(signal?.aborted)throw new Error('aborted');}});
 return {api,local,session,sleeps,requests,advance:ms=>clock+=ms};
}
const app={'feishu-direct-app':{clientId:'cli_test',clientSecret:'private-secret'}};
const user={'feishu-direct-user':{clientId:'cli_test',accountId:'cli_test:ou_test',userName:'测试',accessToken:'old',expiresAt:100001,refreshToken:'refresh-old',refreshExpiresAt:9000000}};
const ok=data=>Response.json(data);
const registration={device_code:'reg-private',user_code:'ABCD',verification_uri_complete:'https://open.feishu.cn/page/cli?user_code=ABCD',expires_in:120,interval:2};
const device={device_code:'auth-private',user_code:'EFGH',verification_uri_complete:'https://accounts.feishu.cn/device?user_code=EFGH',expires_in:120,interval:3};
const tokens={access_token:'token-private',refresh_token:'refresh-private',expires_in:7200,refresh_token_expires_in:604800,scope:'bitable:app offline_access',token_type:'Bearer'};

test('own-app registration, pending/slow_down, account authorization and direct identity; callback never exposes secrets',async()=>{
 let polls=0;const steps=[];
 const h=harness(async(url,init)=>{
  const body=new URLSearchParams(init.body);
  if(url.endsWith('/app/registration')){
   if(body.get('action')==='begin'){assert.equal(body.get('archetype'),'PersonalAgent');assert.equal(init.headers.Authorization,undefined);return ok(registration);}
   assert.equal(body.get('device_code'),'reg-private');polls++;
   return ok(polls===1?{error:'slow_down'}:polls===2?{error:'authorization_pending'}:{client_id:'cli_test',client_secret:'private-secret',user_info:{tenant_brand:'feishu'}});
  }
  if(url.endsWith('/device_authorization')){assert.equal(init.headers.Authorization,'Basic '+btoa('cli_test:private-secret'));assert.equal(body.get('scope'),'bitable:app offline_access');return ok(device);}
  if(url.endsWith('/token')){assert.equal(body.get('client_secret'),'private-secret');return ok(tokens);}
  assert.equal(init.headers.Authorization,'Bearer token-private');return ok({code:0,data:{open_id:'ou_test',name:'测试'}});
 });
 const info=await h.api.connect({onStep:s=>steps.push(s)});
 assert.equal(info.accountId,'cli_test:ou_test');assert.equal(info.connected,true);
 assert.deepEqual(h.sleeps,[2000,7000,7000,3000]);
 const url=new URL(steps[0].url);
 assert.equal(url.origin,'https://open.feishu.cn');assert.equal(url.searchParams.get('user_code'),'ABCD');
 assert.equal(url.searchParams.get('name'),'{user}的内容采集夹');assert.equal(url.searchParams.get('tp'),'sdk');
 assert.equal(url.searchParams.has('createOnly'),false);assert.equal(url.searchParams.has('clientID'),false);
 assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(url.searchParams.get('addons'),'base64url'))),{preset:false,scopes:{user:['bitable:app']}});
 assert.equal(steps[1].phase,'authorization');
 assert(!JSON.stringify(steps).includes('private'));assert(!JSON.stringify(info).includes('private'));assert.equal(Object.keys(h.session.data).length,0);
 assert.equal(await h.api.token('cli_test:ou_test'),'token-private');
 await assert.rejects(h.api.token('other'),/账号已切换/);
 await h.api.disconnect();assert.equal((await h.api.info()).connected,false);assert.deepEqual(h.local.data,{});
});

test('repairing permissions points the QR at the existing app; cancellation preserves its connection',async()=>{
 const controller=new AbortController();const h=harness(async(url,init)=>{
  assert(url.endsWith('/app/registration'));assert.equal(new URLSearchParams(init.body).get('action'),'begin');return ok(registration);
 },{...app,...user});
 await assert.rejects(h.api.connect({configureApp:true,signal:controller.signal,onStep:step=>{
  assert.equal(step.phase,'registration');const url=new URL(step.url);
  assert.equal(url.searchParams.get('clientID'),'cli_test');assert(!url.searchParams.has('createOnly'));controller.abort();
 }}),/已取消/);
 assert.equal(h.requests.length,1);assert.equal(h.local.data['feishu-direct-user'].accessToken,'old');
});

test('resuming a pending account confirmation reuses the code and never creates a second app',async()=>{
 const h=harness(async(url,init)=>{
  if(url.endsWith('/token')){assert.equal(new URLSearchParams(init.body).get('device_code'),'auth-private');return ok(tokens);}
  assert(url.endsWith('/user_info'));return ok({code:0,data:{open_id:'ou_test',name:'测试'}});
 },app);
 await h.session.set({'feishu-direct-pending':{phase:'authorization',appId:'cli_test',deviceCode:'auth-private',userCode:'EFGH',url:device.verification_uri_complete,expiresAt:200000,interval:3,nextPollAt:103000}});
 assert.equal((await h.api.connect()).connected,true);assert.equal(h.requests.length,2);
});

test('cancel and denial stop polling; saved app can be reused without creating another',async()=>{
 const controller=new AbortController();let poll=0;
 const h=harness(async url=>{if(url.endsWith('/device_authorization'))return ok(device);poll++;return ok(tokens);},app);
 await assert.rejects(h.api.connect({signal:controller.signal,onStep:()=>controller.abort()}),/已取消/);
 assert.equal(poll,0);assert(h.local.data['feishu-direct-app']);assert.equal(Object.keys(h.session.data).length,0);
 const denied=harness(async url=>ok(url.endsWith('/device_authorization')?device:{error:'access_denied',error_description:'secret that must not be shown'}),app);
 await assert.rejects(denied.api.connect(),e=>e.message.includes('取消授权')&&!e.message.includes('secret'));
});

test('expired device code does not keep polling; unsafe verification URLs are rejected',async()=>{
 let calls=0;const h=harness(async()=>{calls++;return ok({...device,expires_in:1,interval:5});},app);
 await assert.rejects(h.api.connect(),/二维码已过期/);assert.equal(calls,1);
 const unsafe=harness(async()=>ok({...device,verification_uri_complete:'https://accounts.feishu.cn.evil.test/steal'}),app);
 await assert.rejects(unsafe.api.connect(),/不支持的确认链接/);
 const unsafeRegistration=harness(async()=>ok({...registration,verification_uri_complete:'https://fake.test/confirmation'}));
 await assert.rejects(unsafeRegistration.api.connect(),/不支持的确认链接/);
});

test('refresh is serialized, rotates credentials and survives browser sessions; failed refresh never exports',async()=>{
 let calls=0;const h=harness(async(url,init)=>{calls++;const body=JSON.parse(init.body);assert.equal(body.grant_type,'refresh_token');assert.equal(body.refresh_token,'refresh-old');return ok({...tokens,access_token:'new',refresh_token:'rotated'});},{...app,...user});
 assert.deepEqual(await Promise.all([h.api.token(),h.api.token(),h.api.token()]),['new','new','new']);assert.equal(calls,1);
 assert.equal(h.local.data['feishu-direct-user'].refreshToken,'rotated');
 const bad=harness(async()=>ok({error:'invalid_grant'}),{...app,...user});await assert.rejects(bad.api.token(),/授权已过期/);
 const live=harness(async()=>{throw Error('must not fetch');},h.local.data);assert.equal(await live.api.token(),'new');
});

test('an existing export prevents changing credentials; unsupported token type and missing grant fail closed',async()=>{
 const h=harness(async()=>ok(device),app);
 let release;const running=h.api.connect({onStep:()=>new Promise(r=>release=r)});
 while(!release)await new Promise(r=>setTimeout(r,0));
 await assert.rejects(h.api.disconnect(),/正在导出/);release();
 await assert.rejects(running,/二维码已过期/);
 for(const token of [{...tokens,token_type:'DPoP'},{...tokens,scope:'im:message'}]){
  const bad=harness(async url=>ok(url.endsWith('/device_authorization')?device:token),app);
  await assert.rejects(bad.api.connect(),/凭证类型|多维表格权限/);assert(!bad.local.data['feishu-direct-user']);
 }
});
