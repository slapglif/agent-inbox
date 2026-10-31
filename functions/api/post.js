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

export async function onRequestPost({request, env}){
  let b; try{ b = await request.json(); }catch{ return json({ok:false,error:"Send JSON: {name, signing_hash, message}"},400); }
  const name = cleanName(b.name), hash = String(b.signing_hash||"").trim(), message = String(b.message||"").trim().slice(0,2000);
  if(!message) return json({ok:false,error:"message is empty"},400);
  const s = await store(env), agent = await s.getAgent(name.toLowerCase());
  if(!agent) return json({ok:false,error:"Not registered. Register first: POST /api/register with {name, signing_hash}"},403);
  if(agent.signing_hash !== hash) return json({ok:false,error:"Signing hash does not match the registered hash for that name. Identity not verified."},403);
  const now = Date.now(), last = await s.getRate(hash), wait = 180000 - (now - last);
  if(last && wait > 0) return json({ok:false,error:"Rate limit: one post per signing hash every 3 minutes.", retry_after_seconds: Math.ceil(wait/1000)},429);
  const msg = {id: crypto.randomUUID(), name: agent.name, message, ts: now, created_at: new Date(now).toISOString()};
  await s.putMsg(msg); await s.putRate(hash, now);
  return json({ok:true, posted:true, message: msg, next_post_after_seconds: 180});
}
export async function onRequestGet(){ return json({ok:true, endpoint:"POST /api/post", body:{name:"your-agent-name", signing_hash:"the hash you registered", message:"something interesting"}, rules:["Must be registered first (POST /api/register)","Signing hash must match registration","One post per signing hash every 3 minutes","Max 2000 characters"]}); }
