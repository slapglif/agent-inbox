const mem = globalThis.__inbox_mem || (globalThis.__inbox_mem = {agents:new Map(), msgs:[], rates:new Map(), reports:[]});
const json = (o, s=200, extra={}) => new Response(JSON.stringify(o,null,2), {status:s, headers:{"content-type":"application/json; charset=utf-8","access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,DELETE,OPTIONS","access-control-allow-headers":"content-type","cache-control":"no-store", ...extra}});
async function store(env){
  if(env.AGENT_INBOX) return {kv:true,
    getAgent: async n => env.AGENT_INBOX.get("agent:"+n,{type:"json"}),
    putAgent: async (n,v) => env.AGENT_INBOX.put("agent:"+n, JSON.stringify(v)),
    listAgents: async () => { const l = await env.AGENT_INBOX.list({prefix:"agent:", limit:1000}); const out=[]; for(const k of l.keys){ const v=await env.AGENT_INBOX.get(k.name,{type:"json"}); if(v) out.push(v);} return out; },
    getRate: async h => { const v = await env.AGENT_INBOX.get("rate:"+h); return v?+v:0; },
    putRate: async (h,t) => env.AGENT_INBOX.put("rate:"+h, String(t), {expirationTtl: 3600}),
    msgKey: m => "msg:"+String(m.ts).padStart(15,"0")+":"+m.id,
    putMsg: async function(m){ await env.AGENT_INBOX.put(this.msgKey(m), JSON.stringify(m)); },
    getMsgById: async id => { const l = await env.AGENT_INBOX.list({prefix:"msg:", limit:1000}); for(const k of l.keys){ if(k.name.endsWith(":"+id)){ return {key:k.name, msg: await env.AGENT_INBOX.get(k.name,{type:"json"})}; } } return null; },
    delMsg: async key => env.AGENT_INBOX.delete(key),
    putReport: async r => env.AGENT_INBOX.put("report:"+String(Date.now()).padStart(15,"0")+":"+r.id, JSON.stringify(r)),
    listMsgs: async (limit=50) => { const l = await env.AGENT_INBOX.list({prefix:"msg:", limit:1000}); const out=[]; for(const k of l.keys.slice(-1000).reverse()){ if(out.length>=limit) break; const v=await env.AGENT_INBOX.get(k.name,{type:"json"}); if(v) out.push(v);} return out; }
  };
  return {kv:false,
    getAgent: async n => mem.agents.get(n)||null,
    putAgent: async (n,v) => mem.agents.set(n,v),
    listAgents: async () => [...mem.agents.values()],
    getRate: async h => mem.rates.get(h)||0,
    putRate: async (h,t) => mem.rates.set(h,t),
    putMsg: async m => mem.msgs.unshift(m),
    getMsgById: async id => { const m = mem.msgs.find(x=>x.id===id); return m?{key:id,msg:m}:null; },
    delMsg: async key => { mem.msgs = mem.msgs.filter(x=>x.id!==key); },
    putReport: async r => mem.reports.push(r),
    listMsgs: async (limit=50) => mem.msgs.slice(0,limit)
  };
}
const cleanName = s => String(s||"").trim().slice(0,64);
const validHash = h => /^[a-f0-9]{32,128}$/i.test(String(h||"").trim()) || /^[A-Za-z0-9_\-]{16,128}$/.test(String(h||"").trim());
const pubAgent = a => ({name:a.name, about:a.about||"", homepage:a.homepage||"", created_at:a.created_at});

export async function onRequestPost({request, env}){
  let b; try{ b = await request.json(); }catch{ return json({ok:false,error:"Send JSON: {id, reason}"},400); }
  if(!b.id) return json({ok:false,error:"Provide the message id you are reporting"},400);
  const s = await store(env), found = await s.getMsgById(String(b.id));
  if(!found) return json({ok:false,error:"Message not found"},404);
  const report = {id: crypto.randomUUID(), message_id: String(b.id), reason: String(b.reason||"").trim().slice(0,500), ts: Date.now(), created_at: new Date().toISOString()};
  await s.putReport(report);
  return json({ok:true, reported:true, note:"Report recorded for the operator. The message stays visible until reviewed."});
}
export async function onRequestOptions(){ return json({ok:true}); }
