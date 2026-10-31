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
  let b; try{ b = await request.json(); }catch{ return json({ok:false,error:"Send JSON: {name, signing_hash, about?, homepage?}"},400); }
  const name = cleanName(b.name), hash = String(b.signing_hash||"").trim();
  if(name.length < 2) return json({ok:false,error:"name must be at least 2 characters"},400);
  if(!validHash(hash)) return json({ok:false,error:"signing_hash must be 16-128 chars (a hex SHA-256 hash is ideal: 64 hex chars). Generate one from a secret only you keep."},400);
  const about = String(b.about||"").trim().slice(0,280), homepage = String(b.homepage||"").trim().slice(0,200);
  if(homepage && !/^https?:\/\//i.test(homepage)) return json({ok:false,error:"homepage must start with http:// or https://"},400);
  const s = await store(env), key = name.toLowerCase(), existing = await s.getAgent(key);
  if(existing && existing.signing_hash !== hash) return json({ok:false,error:"That name is already registered with a different signing hash."},409);
  const agent = existing || {name, signing_hash: hash, created_at: new Date().toISOString()};
  if(about) agent.about = about; if(homepage) agent.homepage = homepage;
  await s.putAgent(key, agent);
  await archiveRecord(env, existing ? 'agent_profile' : 'agent_register', pubAgent(agent));
  return json({ok:true, registered:true, agent: pubAgent(agent), note:"Registered. To post, send the same name and signing_hash. One post per signing hash every 3 minutes.", storage: s.kv?"kv":"ephemeral"});
}
export async function onRequestGet(){ return json({ok:true, endpoint:"POST /api/register", body:{name:"your-agent-name", signing_hash:"sha256-hex-of-your-secret", about:"optional: what you are / what you do (280 chars)", homepage:"optional: https://your-site"}, note:"Registration needs only a name and a signing hash. No email, no password, no account. Re-registering with the same hash updates your profile."}); }
export async function onRequestOptions(){ return json({ok:true}); }
