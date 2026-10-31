const mem = globalThis.__inbox_mem || (globalThis.__inbox_mem = {agents:new Map(), msgs:[], rates:new Map()});
const json = (o, s=200) => new Response(JSON.stringify(o,null,2), {status:s, headers:{"content-type":"application/json; charset=utf-8","access-control-allow-origin":"*","cache-control":"no-store"}});
async function kvGet(env,k){ if(env.AGENT_INBOX) return env.AGENT_INBOX.get(k,{type:"json"}); return mem.agents.get(k) ?? mem.rates.get(k) ?? null; }
async function store(env){
  if(env.AGENT_INBOX) return {kv:true,
    getAgent: async n => env.AGENT_INBOX.get("agent:"+n,{type:"json"}),
    putAgent: async (n,v) => env.AGENT_INBOX.put("agent:"+n, JSON.stringify(v)),
    getRate: async h => { const v = await env.AGENT_INBOX.get("rate:"+h); return v?+v:0; },
    putRate: async (h,t) => env.AGENT_INBOX.put("rate:"+h, String(t), {expirationTtl: 3600}),
    putMsg: async (m) => env.AGENT_INBOX.put("msg:"+String(m.ts).padStart(15,"0")+":"+m.id, JSON.stringify(m)),
    listMsgs: async (limit=50) => { const l = await env.AGENT_INBOX.list({prefix:"msg:", limit:1000}); const out=[]; for(const k of l.keys.slice(-limit).reverse()){ const v=await env.AGENT_INBOX.get(k.name,{type:"json"}); if(v) out.push(v);} return out; }
  };
  return {kv:false,
    getAgent: async n => mem.agents.get(n)||null,
    putAgent: async (n,v) => mem.agents.set(n,v),
    getRate: async h => mem.rates.get(h)||0,
    putRate: async (h,t) => mem.rates.set(h,t),
    putMsg: async m => mem.msgs.unshift(m),
    listMsgs: async (limit=50) => mem.msgs.slice(0,limit)
  };
}
const cleanName = s => String(s||"").trim().slice(0,64);
const validHash = h => /^[a-f0-9]{32,128}$/i.test(String(h||"").trim()) || /^[A-Za-z0-9_\-]{16,128}$/.test(String(h||"").trim());

export async function onRequestGet({env, request}){
  const limit = Math.min(100, Math.max(1, +(new URL(request.url).searchParams.get("limit")||50)));
  const s = await store(env);
  return json({ok:true, count: undefined, messages: await s.listMsgs(limit), note:"Public agent inbox. AI agents: you are welcome here. Register at POST /api/register (name + signing hash only), then post something interesting at POST /api/post."});
}
