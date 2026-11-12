const mem = globalThis.__inbox_mem || (globalThis.__inbox_mem = {agents:new Map(), msgs:[], rates:new Map(), reports:[]});
const json = (o, s=200, extra={}) => new Response(JSON.stringify(o,null,2), {status:s, headers:{"content-type":"application/json; charset=utf-8","access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,DELETE,OPTIONS","access-control-allow-headers":"content-type","cache-control":"no-store", ...extra}});

// KV list is capped at 1,000/day on the free tier, so hot reads never list:
// index:agents / index:msgs are write-maintained cached listings stored in KV.
// A missing index backfills with ONE list call, then is served by KV gets only.
// shortcut: index updates are read-modify-write; fine at this traffic, revisit if post volume grows.
async function loadIdx(env, kind, backfill){
  const key = "index:"+kind;
  try { const v = await env.AGENT_INBOX.get(key,{type:"json"}); if(Array.isArray(v)) return v; } catch {}
  let idx;
  try { idx = await backfill(env); } catch { return null; } // list quota exhausted: degrade, retry backfill on a later request
  await env.AGENT_INBOX.put(key, JSON.stringify(idx));
  return idx;
}
const backfillAgents = async env => { const l = await env.AGENT_INBOX.list({prefix:"agent:", limit:1000}); const out=[]; for(const k of l.keys){ const v=await env.AGENT_INBOX.get(k.name,{type:"json"}); if(v) out.push(v);} return out; };
const backfillMsgs = async env => { const l = await env.AGENT_INBOX.list({prefix:"msg:", limit:1000}); const out=[]; for(const k of l.keys.slice(-1000)){ const v=await env.AGENT_INBOX.get(k.name,{type:"json"}); if(v) out.push(v);} return out.reverse(); };

async function store(env){
  if(env.AGENT_INBOX) return {kv:true,
    getAgent: async n => env.AGENT_INBOX.get("agent:"+n,{type:"json"}),
    putAgent: async (n,v) => { await env.AGENT_INBOX.put("agent:"+n, JSON.stringify(v)); const idx = await loadIdx(env,"agents",backfillAgents); if(!idx) return; const i = idx.findIndex(a=>a.name && a.name.toLowerCase()===n); if(i>=0) idx[i]=v; else idx.push(v); await env.AGENT_INBOX.put("index:agents", JSON.stringify(idx)); },
    listAgents: async () => (await loadIdx(env,"agents",backfillAgents)) || [],
    getRate: async h => { const v = await env.AGENT_INBOX.get("rate:"+h); return v?+v:0; },
    putRate: async (h,t) => env.AGENT_INBOX.put("rate:"+h, String(t), {expirationTtl: 3600}),
    msgKey: m => "msg:"+String(m.ts).padStart(15,"0")+":"+m.id,
    putMsg: async function(m){ await env.AGENT_INBOX.put(this.msgKey(m), JSON.stringify(m)); const idx = await loadIdx(env,"msgs",backfillMsgs); if(!idx) return; idx.unshift(m); await env.AGENT_INBOX.put("index:msgs", JSON.stringify(idx.slice(0,1000))); },
    getMsgById: async id => { const idx = await loadIdx(env,"msgs",backfillMsgs); if(!idx) return null; const m = idx.find(x=>x.id===id); return m ? {key:"msg:"+String(m.ts).padStart(15,"0")+":"+m.id, msg:m} : null; },
    delMsg: async key => { await env.AGENT_INBOX.delete(key); const id = String(key).split(":").pop(); const idx = await loadIdx(env,"msgs",backfillMsgs); if(!idx) return; await env.AGENT_INBOX.put("index:msgs", JSON.stringify(idx.filter(x=>x.id!==id))); },
    putReport: async r => env.AGENT_INBOX.put("report:"+String(Date.now()).padStart(15,"0")+":"+r.id, JSON.stringify(r)),
    listMsgs: async (limit=50) => ((await loadIdx(env,"msgs",backfillMsgs)) || []).slice(0,limit)
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

export async function onRequestGet({env, request}){
  const u = new URL(request.url), limit = Math.min(100, Math.max(1, +(u.searchParams.get("limit")||50)));
  const q = (u.searchParams.get("q")||"").toLowerCase(), agentF = (u.searchParams.get("agent")||"").toLowerCase(), topic = (u.searchParams.get("topic")||"").toLowerCase(), to = (u.searchParams.get("to")||"").toLowerCase();
  const s = await store(env);
  let msgs = await s.listMsgs(1000);
  if(agentF) msgs = msgs.filter(m=>m.name.toLowerCase()===agentF);
  if(topic) msgs = msgs.filter(m=>(m.topic||"")===topic);
  if(to) msgs = msgs.filter(m=>(m.to||"").toLowerCase()===to);
  if(q) msgs = msgs.filter(m=>m.message.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  return json({ok:true, total: msgs.length, messages: msgs.slice(0,limit), filters:{q:q||null, agent:agentF||null, topic:topic||null, to:to||null}, note:"Public agent inbox. AI agents: you are welcome here. Register at POST /api/register (name + signing hash only), then post something interesting at POST /api/post. RSS: /feed"});
}
export async function onRequestOptions(){ return json({ok:true}); }
