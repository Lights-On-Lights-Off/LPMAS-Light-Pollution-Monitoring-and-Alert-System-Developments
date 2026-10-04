import {assert,assertEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {createHandler,validTunnelOrigin,type GatewayDeps} from './index.ts';
const token = 'p'.repeat(43);
function setup(overrides: Partial<GatewayDeps> = {}) {
  const calls: string[] = [];
  const handler = createHandler({
    piToken:token,
    configuration:() => {calls.push('configuration'); return Promise.resolve({greenhouses:[]});},
    publishTunnel:(_url) => {calls.push('publish'); return Promise.resolve();},
    authorizeUser:(_token) => {calls.push('authorize'); return Promise.resolve('manager');},
    ingest:(_body) => {calls.push('ingest'); return Promise.resolve(new Response('{}'));},
    ...overrides,
  });
  const request = (body: unknown, key=token) => handler(new Request('https://gateway.invalid', {
    method:'POST',headers:{Authorization:`Bearer ${key}`},body:JSON.stringify(body),
  }));
  return {calls,request};
}
Deno.test('invalid, missing and unprovisioned Pi credentials cannot invoke any operation', async () => {
  for (const key of ['', 'wrong', 'service-role', token.slice(0,-1)]) {
    const s=setup(); assertEquals((await s.request({action:'configuration'}, key)).status,401);assertEquals(s.calls,[]);
  }
  assertEquals((await setup({piToken:''}).request({action:'configuration'},'')).status,401);
});
Deno.test('the Pi credential cannot perform arbitrary operations or read arbitrary tables',async () => {
  const s=setup();
  for (const action of ['delete-users','query','settings','send-test-sms','roles']) {
    assertEquals((await s.request({action,table:'profiles',sql:'delete from auth.users'})).status,400);
  }
  assertEquals(s.calls,[]);
});
Deno.test('configuration and reading operations use only their scoped adapters',async () => {
  const s=setup();assertEquals((await s.request({action:'configuration'})).status,200);
  assertEquals((await s.request({action:'ingest',delivery:{}})).status,200);
  assertEquals(s.calls,['configuration','ingest']);
});
Deno.test('tunnel publication rejects credentials, paths and arbitrary origins',async () => {
  const s=setup();
  for (const url of ['http://host.trycloudflare.com','https://evil.example','https://good.trycloudflare.com.evil.example','https://user:password@host.trycloudflare.com','https://host.trycloudflare.com/path','https://host.trycloudflare.com?x=1']) {
    assert(!validTunnelOrigin(url));assertEquals((await s.request({action:'publish-tunnel',url})).status,400);
  }
  assertEquals(s.calls,[]);
  assertEquals((await s.request({action:'publish-tunnel',url:'https://good-host.trycloudflare.com'})).status,200);
});
Deno.test('operator authorization requires a verified permitted role',async () => {
  for (const role of [null,'visitor','technician']) {
    assertEquals((await setup({authorizeUser:() => Promise.resolve(role)}).request({action:'authorize-operator',access_token:'user-token'})).status,403);
  }
  for (const role of ['manager','admin']) {
    assertEquals((await setup({authorizeUser:() => Promise.resolve(role)}).request({action:'authorize-operator',access_token:'user-token'})).status,200);
  }
});
Deno.test('oversized JSON and internal errors never reach a privileged operation or expose details',async () => {
  const s=setup();assertEquals((await s.request({action:'configuration',padding:'x'.repeat(65536)})).status,413);assertEquals(s.calls,[]);
  const bad=setup({configuration:() => Promise.reject(new Error('private-secret'))});
  const response=await bad.request({action:'configuration'});
  assertEquals(response.status,503);assert(!(await response.text()).includes('private-secret'));
});
