'use strict';
// Builds realistic Claude Code and Codex session logs (same shapes the tools write).
const fs = require('fs');
const path = require('path');

function iso(minsAgo) { return new Date(Date.now() - minsAgo * 60000).toISOString(); }

function claudeSession(dir) {
  const cwd = '/home/dev/code/pdf-summarizer';
  const sid = '7f1c2a9e-claude-demo';
  const L = [];
  let n = 0;
  let t = 3000;
  const bash = (command, { error = false, out = 'ok' } = {}) => {
    const id = `toolu_${++n}`;
    t -= 7;
    L.push({ parentUuid: null, sessionId: sid, cwd, timestamp: iso(t), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'run' } }] } });
    L.push({ sessionId: sid, cwd, timestamp: iso(t - 1), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out, is_error: error }] } });
  };
  const write = (file_path, content) => {
    t -= 7;
    L.push({ sessionId: sid, cwd, timestamp: iso(t), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${++n}`, name: 'Write', input: { file_path, content } }] } });
  };
  L.push({ type: 'user', sessionId: sid, cwd, timestamp: iso(t), message: { role: 'user', content: 'deploy the summarizer and test it on the 2,000 PDFs' } });
  bash('gcloud services enable aiplatform.googleapis.com run.googleapis.com --project pdf-sum-prod');
  bash('gcloud compute instances create llm-worker-1 --zone us-central1-a --machine-type g2-standard-8 --accelerator type=nvidia-l4,count=1 --image-family debian-12 --image-project debian-cloud');
  bash('gcloud compute disks create scratch-250 --size 250GB --zone=us-central1-a');
  bash('cd /home/dev/code/pdf-summarizer && gcloud beta run deploy pdf-api --source . --region us-central1 --allow-unauthenticated');
  bash('gcloud sql instances create pdf-db --tier db-custom-2-7680 --region us-central1', { error: true, out: 'ERROR: (gcloud.sql.instances.create) quota exceeded' });
  bash('aws s3 mb s3://tmp-test-bucket-123 && aws s3 cp sample.pdf s3://tmp-test-bucket-123/ && aws s3 rb s3://tmp-test-bucket-123 --force');
  bash('gcloud compute instances create test-vm-$RANDOM --zone us-central1-a');
  write(`${cwd}/batch_summarize.py`, [
    'import os, glob',
    'from openai import OpenAI',
    'client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])',
    'for f in glob.glob("pdfs/*.pdf"):',
    '    text = open(f, "rb").read()[:20000]',
    '    r = client.chat.completions.create(model="gpt-5", messages=[{"role":"user","content":str(text)}])',
    '    print(f, r.choices[0].message.content[:80])',
  ].join('\n'));
  bash('nohup python3 batch_summarize.py > out.log 2>&1 &');
  bash('echo "export const x = 1" > notes.txt'); // noise
  bash('gcloud compute ssh llm-worker-1 --zone us-central1-a --command "nvidia-smi"'); // noise
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), L.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

function codexSession(dir) {
  const cwd = '/home/dev/code/site';
  const L = [];
  let t = 1500;
  let n = 0;
  L.push({ timestamp: iso(t), type: 'session_meta', payload: { id: 'codex-0199-demo', cwd, originator: 'codex_cli_rs', cli_version: '0.50.0' } });
  const sh = (cmd, code = 0, style = 'shell') => {
    const call_id = `call_${++n}`;
    t -= 5;
    const args = style === 'exec' ? { cmd } : { command: ['bash', '-lc', cmd], workdir: cwd };
    L.push({ timestamp: iso(t), type: 'response_item', payload: { type: 'function_call', name: style === 'exec' ? 'exec_command' : 'shell', arguments: JSON.stringify(args), call_id } });
    L.push({ timestamp: iso(t - 1), type: 'response_item', payload: { type: 'function_call_output', call_id, output: JSON.stringify({ output: code ? 'error' : 'done', metadata: { exit_code: code, duration_seconds: 1.2 } }) } });
  };
  sh('npx wrangler d1 create site-db');
  sh('npx wrangler r2 bucket create site-assets');
  sh('npx wrangler@latest deploy');
  sh('fly launch --name site-preview --region sin --now --yes');
  sh('supabase functions deploy notify', 0, 'exec');
  sh('aws rds create-db-instance --db-instance-identifier site-pg --db-instance-class db.t3.medium --engine postgres --allocated-storage 50', 254);
  sh('aws ec2 run-instances --image-id ami-0abc --instance-type t3.large --count 2 --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=load-tester}]"');
  sh('npx wrangler r2 bucket delete site-assets');
  t -= 5;
  L.push({ timestamp: iso(t), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_patch', input: [
    '*** Begin Patch',
    '*** Add File: scripts/gen-alt-text.js',
    "+import Anthropic from '@anthropic-ai/sdk';",
    '+const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });',
    '+const files = (await import("fs")).readdirSync("public/img");',
    '+await Promise.all(files.map((f) => client.messages.create({ model: "claude-sonnet-4-5", max_tokens: 200, messages: [{ role: "user", content: f }] })));',
    '*** End Patch',
  ].join('\n') } });
  sh('node scripts/gen-alt-text.js');
  sh('for i in $(seq 1 500); do curl -s https://api.openai.com/v1/embeddings -H "Authorization: Bearer $OPENAI_API_KEY" -d @chunk_$i.json; done');
  const d = path.join(dir, '2026', '10', '30');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'rollout-2026-10-30T09-00-00-codex-0199-demo.jsonl'), L.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

function make(root) {
  const claudeDir = path.join(root, '.claude', 'projects', '-home-dev-code-pdf-summarizer');
  const codexDir = path.join(root, '.codex', 'sessions');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  claudeSession(claudeDir);
  codexSession(codexDir);
  return root;
}

module.exports = { make };
if (require.main === module) console.log(make(process.argv[2] || path.join(__dirname, 'fixtures', 'home')));
