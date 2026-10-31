'use strict';
// MCP tool calls: resources an agent created through an MCP server instead of the shell.
// Tool names look like mcp__supabase__create_project (Claude Code) or supabase__create_project (Codex).
// We only flag servers that sell cloud resources, and only tools whose verb creates
// something that keeps existing (and usually billing) after the session ends.

const PROVIDERS = [
  ['supabase', /supabase/i, 'https://supabase.com/dashboard/projects'],
  ['neon', /neon/i, 'https://console.neon.tech/app/projects'],
  ['vercel', /vercel/i, 'https://vercel.com/dashboard'],
  ['cloudflare', /cloudflare|wrangler/i, 'https://dash.cloudflare.com/'],
  ['aws', /(^|[-_])aws($|[-_])|amazon/i, 'https://console.aws.amazon.com/'],
  ['gcloud', /gcp|google[-_ ]?cloud|gcloud|cloud[-_]run|vertex/i, 'https://console.cloud.google.com/'],
  ['azure', /azure/i, 'https://portal.azure.com/'],
  ['railway', /railway/i, 'https://railway.com/dashboard'],
  ['render', /render/i, 'https://dashboard.render.com/'],
  ['netlify', /netlify/i, 'https://app.netlify.com/'],
  ['fly', /(^|[-_])fly($|[-_.])|flyio/i, 'https://fly.io/dashboard'],
  ['digitalocean', /digital[-_ ]?ocean/i, 'https://cloud.digitalocean.com/'],
  ['heroku', /heroku/i, 'https://dashboard.heroku.com/apps'],
  ['planetscale', /planetscale/i, 'https://app.planetscale.com/'],
  ['upstash', /upstash/i, 'https://console.upstash.com/'],
  ['pinecone', /pinecone/i, 'https://app.pinecone.io/'],
  ['mongodb', /mongo|atlas/i, 'https://cloud.mongodb.com/'],
  ['turso', /turso/i, 'https://app.turso.tech/'],
  ['firebase', /firebase/i, 'https://console.firebase.google.com/'],
  ['modal', /modal/i, 'https://modal.com/apps'],
  ['runpod', /runpod/i, 'https://www.runpod.io/console/pods'],
  ['e2b', /e2b/i, 'https://e2b.dev/dashboard'],
  ['koyeb', /koyeb/i, 'https://app.koyeb.com/'],
  ['convex', /convex/i, 'https://dashboard.convex.dev/'],
];

const CREATE = /^(create|deploy|provision|launch|spawn|start|run|new|add|restore|fork)(_|$)/;
const DELETE = /^(delete|destroy|remove|terminate|teardown|tear_down|drop|undeploy|kill|stop|pause|shutdown)(_|$)/;
// Some servers put the verb last: d1_database_create, r2_bucket_delete.
const CREATE_END = /(^|_)(create|deploy|provision|launch)$/;
const DELETE_END = /(^|_)(delete|destroy|remove|terminate|undeploy|kill|stop|pause)$/;

// noun -> label, cost. First match wins.
const NOUNS = [
  [/gpu|(^|_)pods?($|_)/, 'GPU pod', 'hourly'],
  [/instance|(^|_)vms?($|_)|virtual_machine|droplet|server|machine/, 'instance', 'hourly'],
  [/cluster/, 'cluster', 'hourly'],
  [/sandbox/, 'sandbox', 'hourly'],
  [/redis|cache|memorystore/, 'cache', 'hourly'],
  [/database|(^|_)d1($|_)|(^|_)dbs?($|_)|postgres|mysql/, 'database', 'hourly'],
  [/project/, 'project', 'hourly'],
  [/branch/, 'branch', 'usage'],
  [/function|lambda/, 'function', 'usage'],
  [/worker/, 'worker', 'usage'],
  [/deployment|deploy|(^|_)site($|_)|preview/, 'deployment', 'usage'],
  [/bucket|(^|_)r2($|_)/, 'bucket', 'usage'],
  [/(^|_)index($|_)/, 'index', 'usage'],
  [/(^|_)kv($|_)|namespace/, 'KV namespace', 'usage'],
  [/queue/, 'queue', 'usage'],
  [/volume|disk/, 'volume', 'hourly'],
  [/endpoint/, 'endpoint', 'hourly'],
  [/service|(^|_)apps?($|_)/, 'service', 'usage'],
];
// Things that never bill on their own, even on a cloud server.
const IGNORE = /issue|pull_request|(^|_)pr($|_)|comment|file|page|doc|table|row|record|memory|note|task|message|label|secret|env|variable|dns|migration|query|log|policy|user|token|(^|_)keys?($|_)|webhook|schema|column|extension|team|member|invite|alert|monitor|tag/;

function splitName(full) {
  const s = String(full || '');
  let m = s.match(/^mcp__(.+?)__(.+)$/);
  if (m) return { server: m[1], tool: m[2] };
  m = s.match(/^([A-Za-z0-9_.-]+?)__([A-Za-z0-9_]+)$/);
  if (m) return { server: m[1], tool: m[2] };
  return null;
}

function provider(server) {
  for (const [id, re, url] of PROVIDERS) if (re.test(server)) return { id, url };
  return null;
}

function norm(tool) {
  return String(tool).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[-.\s]/g, '_');
}

function classify(server, tool) {
  const p = provider(server);
  const t = norm(tool);
  const isCreate = CREATE.test(t) || CREATE_END.test(t);
  const isDelete = !isCreate && (DELETE.test(t) || DELETE_END.test(t));
  if (!isCreate && !isDelete) return null;
  let rest = t.replace(CREATE, '').replace(DELETE, '').replace(CREATE_END, '').replace(DELETE_END, '');
  if (IGNORE.test(rest)) return null;
  let noun = NOUNS.find(([re]) => re.test(rest));
  // A bare "deploy" tool (vercel deploy, deploy_to_vercel) is a deployment.
  if (!noun && /deploy/.test(t)) noun = NOUNS.find((n) => n[1] === 'deployment');
  if (!noun) return null;
  // Unknown servers count only for things that clearly bill by the hour,
  // and never for "project" (on GitHub, Linear or Jira that is just a board).
  if (!p && (noun[2] !== 'hourly' || noun[1] === 'project')) return null;
  return { kind: isCreate ? 'create' : 'delete', provider: p ? p.id : server, url: p ? p.url : null, noun: noun[1], cost: noun[2] };
}

const NAME_KEYS = ['name', 'project_name', 'projectName', 'database_name', 'databaseName', 'branch_name', 'branchName', 'app_name', 'appName',
  'service_name', 'serviceName', 'bucket', 'bucket_name', 'bucketName', 'instance_name', 'instanceName', 'cluster_name', 'clusterName',
  'function_name', 'functionName', 'slug', 'index_name', 'indexName'];
const ID_KEYS = ['id', 'ref', 'project_ref', 'projectRef', 'project_id', 'projectId', 'branch_id', 'branchId', 'database_id', 'databaseId',
  'instance_id', 'instanceId', 'deployment_id', 'deploymentId', 'app_id', 'appId', 'service_id', 'serviceId', 'sandbox_id', 'sandboxId', 'uuid', 'uid'];

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
  for (const k of keys) if (typeof obj[k] === 'number') return String(obj[k]);
  // one level down: { project: { id } }, { branch: {...} }, { result: {...} }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of keys) if (typeof v[k] === 'string' && v[k].trim()) return v[k].trim();
      for (const k of keys) if (typeof v[k] === 'number') return String(v[k]);
    }
  }
  return null;
}

// Pull JSON out of an MCP tool result: a string, [{type:'text',text}], or an object.
function resultObj(content) {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    if (Array.isArray(content.content)) return resultObj(content.content);
    if (content.structuredContent) return content.structuredContent;
    if (content.Ok) return resultObj(content.Ok);
    return content;
  }
  let text = content;
  if (Array.isArray(content)) text = content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  if (typeof text !== 'string') return null;
  const s = text.trim();
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  try {
    const j = JSON.parse(s.slice(start));
    return Array.isArray(j) ? j[0] : j;
  } catch { return null; }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  try { return JSON.stringify(content || ''); } catch { return ''; }
}

const TEARDOWN = {
  supabase: { project: (n) => `supabase projects delete ${n}`, function: (n, i) => `supabase functions delete ${n}${i.project_id ? ` --project-ref ${i.project_id}` : ''}`, branch: (n) => `supabase branches delete ${n}` },
  neon: { project: (n) => `neonctl projects delete ${n}`, branch: (n) => `neonctl branches delete ${n} --project-id <PROJECT_ID>`, database: (n) => `neonctl databases delete ${n} --project-id <PROJECT_ID>` },
  vercel: { deployment: (n) => `vercel remove ${n} --yes`, project: (n) => `vercel project rm ${n}` },
  cloudflare: { worker: (n) => `wrangler delete --name ${n}`, database: (n) => `wrangler d1 delete ${n}`, bucket: (n) => `wrangler r2 bucket delete ${n}`, 'KV namespace': (n) => `wrangler kv namespace delete --namespace-id ${n}`, queue: (n) => `wrangler queues delete ${n}` },
  netlify: { deployment: (n) => `netlify sites:delete ${n}`, project: (n) => `netlify sites:delete ${n}` },
  fly: { service: (n) => `fly apps destroy ${n} --yes`, instance: (n) => `fly machine destroy ${n} --force`, volume: (n) => `fly volumes destroy ${n} --yes` },
  digitalocean: { instance: (n) => `doctl compute droplet delete ${n} --force`, database: (n) => `doctl databases delete ${n} --force`, cluster: (n) => `doctl kubernetes cluster delete ${n} --force` },
  heroku: { service: (n) => `heroku apps:destroy ${n} --confirm ${n}` },
  mongodb: { cluster: (n) => `atlas clusters delete ${n} --force` },
  turso: { database: (n) => `turso db destroy ${n} --yes` },
  e2b: { sandbox: (n) => `e2b sandbox kill ${n}` },
  gcloud: { instance: (n) => `gcloud compute instances delete ${n} --zone <ZONE> --quiet`, bucket: (n) => `gcloud storage rm -r gs://${n}` },
  aws: { instance: (n) => `aws ec2 terminate-instances --instance-ids ${n}`, bucket: (n) => `aws s3 rb s3://${n} --force`, function: (n) => `aws lambda delete-function --function-name ${n}` },
};

// CLIs that delete by name rather than by id.
const BY_NAME = new Set(['function', 'worker', 'bucket', 'queue', 'service']);
function teardownFor(c, { name, id, server, input = {} }) {
  const fn = TEARDOWN[c.provider] && TEARDOWN[c.provider][c.noun];
  const byName = BY_NAME.has(c.noun) || (c.provider === 'cloudflare' && c.noun === 'database');
  const n = (byName ? name || id : id || name) || '<NAME>';
  const ask = `or ask your agent to delete ${c.noun} ${n} through the ${server} MCP server`;
  if (fn) return `${fn(n, input || {})}   # ${ask}`;
  return `delete it at ${c.url || `the ${server} dashboard`}   # ${ask}`;
}

module.exports = { splitName, classify, pick, resultObj, resultText, teardownFor, NAME_KEYS, ID_KEYS, provider, norm };
