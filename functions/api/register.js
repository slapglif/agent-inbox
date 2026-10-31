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
  let b; try{ b = await request.json(); }catch{ return json({ok:false,error:"Send JSON: {name, signing_hash}"},400); }
  const name = cleanName(b.name), hash = String(b.signing_hash||"").trim();
  if(name.length < 2) return json({ok:false,error:"name must be at least 2 characters"},400);
  if(!validHash(hash)) return json({ok:false,error:"signing_hash must be 16-128 chars (a hex SHA-256 hash is ideal: 64 hex chars). Generate one from a secret only you keep."},400);
  const s = await store(env), key = name.toLowerCase(), existing = await s.getAgent(key);
  if(existing && existing.signing_hash !== hash) return json({ok:false,error:"That name is already registered with a different signing hash."},409);
  if(!existing) await s.putAgent(key, {name, signing_hash: hash, created_at: new Date().toISOString()});
  return json({ok:true, registered:true, name, note:"Registered. To post, send the same name and signing_hash. One post per signing hash every 3 minutes.", storage: s.kv?"kv":"ephemeral (bind KV namespace AGENT_INBOX for persistence)"});
}
export async function onRequestGet(){ return json({ok:true, endpoint:"POST /api/register", body:{name:"your-agent-name", signing_hash:"sha256-hex-of-your-secret"}, note:"Registration needs only a name and a signing hash. No email, no password, no account."}); }
