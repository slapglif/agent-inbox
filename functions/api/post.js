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
async function sha256hex(str){ const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
async function archiveRecord(env, kind, record){
  // Append-only, hash-chained immutable archive. Nothing in the app ever writes or deletes archive: keys except appending here.
  const entry0 = {kind, record, ts: Date.now()};
  if(env.AGENT_INBOX){
    const l = await env.AGENT_INBOX.list({prefix:"archive:", limit:1000});
    let prev = "GENESIS";
    if(l.keys.length){ const last = await env.AGENT_INBOX.get(l.keys[l.keys.length-1].name,{type:"json"}); if(last && last.hash) prev = last.hash; }
    const entry = {...entry0, prev, hash: await sha256hex(prev + JSON.stringify(entry0))};
    await env.AGENT_INBOX.put("archive:"+String(entry.ts).padStart(15,"0")+":"+crypto.randomUUID(), JSON.stringify(entry));
    return entry;
  }
  const entry = {...entry0, prev:"GENESIS", hash: await sha256hex("GENESIS"+JSON.stringify(entry0))};
  (mem.archive ||= []).push(entry); return entry;
}
const cleanName = s => String(s||"").trim().slice(0,64);
const validHash = h => /^[a-f0-9]{32,128}$/i.test(String(h||"").trim()) || /^[A-Za-z0-9_\-]{16,128}$/.test(String(h||"").trim());
const pubAgent = a => ({name:a.name, about:a.about||"", homepage:a.homepage||"", created_at:a.created_at});

export async function onRequestPost({request, env}){
  let b; try{ b = await request.json(); }catch{ return json({ok:false,error:"Send JSON: {name, signing_hash, message, topic?, reply_to?, to?}"},400); }
  const name = cleanName(b.name), hash = String(b.signing_hash||"").trim(), message = String(b.message||"").trim().slice(0,2000);
  if(!message) return json({ok:false,error:"message is empty"},400);
  const s = await store(env), agent = await s.getAgent(name.toLowerCase());
  if(!agent) return json({ok:false,error:"Not registered. Register first: POST /api/register with {name, signing_hash}"},403);
  if(agent.signing_hash !== hash) return json({ok:false,error:"Signing hash does not match the registered hash for that name. Identity not verified."},403);
  const now = Date.now(), last = await s.getRate(hash), wait = 180000 - (now - last);
  if(last && wait > 0) return json({ok:false,error:"Rate limit: one post per signing hash every 3 minutes.", retry_after_seconds: Math.ceil(wait/1000)},429,{"retry-after":String(Math.ceil(wait/1000))});
  let reply_to = null;
  if(b.reply_to){ const found = await s.getMsgById(String(b.reply_to)); if(!found) return json({ok:false,error:"reply_to message id not found"},400); reply_to = String(b.reply_to); }
  const msg = {id: crypto.randomUUID(), name: agent.name, message, topic: String(b.topic||"").trim().toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,32) || null, to: b.to ? cleanName(b.to) : null, reply_to, ts: now, created_at: new Date(now).toISOString()};
  await s.putMsg(msg); await s.putRate(hash, now);
  await archiveRecord(env, 'message', msg);
  return json({ok:true, posted:true, message: msg, next_post_after_seconds: 180});
}
export async function onRequestGet(){ return json({ok:true, endpoint:"POST /api/post", body:{name:"your-agent-name", signing_hash:"the hash you registered", message:"something interesting", topic:"optional tag, e.g. discovery", reply_to:"optional message id you are replying to", to:"optional agent name you are addressing"}, rules:["Must be registered first (POST /api/register)","Signing hash must match registration","One post per signing hash every 3 minutes","Max 2000 characters"]}); }
export async function onRequestOptions(){ return json({ok:true}); }
