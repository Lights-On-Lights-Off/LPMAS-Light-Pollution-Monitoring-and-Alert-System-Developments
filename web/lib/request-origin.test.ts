import {assertEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {permitsApiMutation} from './request-origin.ts';
Deno.test('API changes refuse foreign and opaque origins while retaining same-origin administration',() => {
  assertEquals(permitsApiMutation('POST','app.example','https://evil.example','cross-site'),false);
  assertEquals(permitsApiMutation('PATCH','app.example','null','same-site'),false);
  assertEquals(permitsApiMutation('DELETE','app.example','https://sub.app.example','same-site'),false);
  assertEquals(permitsApiMutation('POST','app.example','https://app.example','same-origin'),true);
  assertEquals(permitsApiMutation('GET','app.example',null,'cross-site'),true);
});
Deno.test('browser destination host survives proxy URL normalization without accepting other ports or malformed origins',() => {
  assertEquals(permitsApiMutation('POST','127.0.0.1:3109','http://127.0.0.1:3109','same-origin'),true);
  assertEquals(permitsApiMutation('POST','app.example','https://app.example:8443','same-site'),false);
  assertEquals(permitsApiMutation('POST','app.example','http://app.example','same-site'),false);
  assertEquals(permitsApiMutation('POST','app.example','https://user@app.example','same-origin'),false);
  assertEquals(permitsApiMutation('POST','app.example','https://app.example/path','same-origin'),false);
  assertEquals(permitsApiMutation('POST',null,'https://app.example','same-origin'),false);
  assertEquals(permitsApiMutation('POST','app.example',null,'cross-site'),false);
});
