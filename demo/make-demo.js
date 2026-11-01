'use strict';
// Builds a realistic Claude Code session log for the README demo:
//   node demo/make-demo.js /tmp/demo-home && HOME=/tmp/demo-home node bin/agent-leftovers.js
// Everything in it is synthetic; no real account was used.
const fs = require('fs');
const path = require('path');

const home = process.argv[2] || path.join(require('os').tmpdir(), 'agent-leftovers-demo');
const dir = path.join(home, '.claude', 'projects', '-home-dev-pdf-summarizer');
fs.mkdirSync(dir, { recursive: true });
const cwd = '/home/dev/pdf-summarizer';
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();

const steps = [
  [74, { bash: 'gcloud config set project pdf-demo-4412' }],
  [74, { bash: 'gcloud compute instances create llm-worker-1 --zone us-central1-a --machine-type g2-standard-4 --accelerator type=nvidia-l4,count=1 --maintenance-policy TERMINATE' }],
  [73, { bash: 'gcloud compute disks create scratch-250 --size 250GB --zone us-central1-a' }],
  [72, { bash: 'gcloud run deploy pdf-api --source . --region us-central1 --allow-unauthenticated' }],
  [70, { bash: 'aws s3 mb s3://pdf-tmp-uploads-7731 --region us-east-1' }],
  [70, { bash: 'aws s3 rb s3://pdf-tmp-uploads-7731' }],
  [69, { write: `${cwd}/batch_summarize.py`, content: 'import os\nfrom openai import OpenAI\nclient = OpenAI(api_key=os.environ["OPENAI_API_KEY"])\nfor f in files:\n    client.chat.completions.create(model="gpt-5", messages=[])\n' }],
  [69, { bash: 'nohup python batch_summarize.py > run.log 2>&1 &' }],
  [50, { bash: 'docker run -d --name pg-dev -p 5432:5432 postgres:16' }],
  [30, { mcp: 'mcp__supabase__create_project', input: { name: 'pdf-staging', region: 'us-east-1' }, result: { id: 'qwertyref123', name: 'pdf-staging' } }],
  [26, { bash: 'kubectl --context gke_pdf-demo_us-central1_main apply -f k8s/' }],
  [26, { write: `${cwd}/k8s/svc.yaml`, content: 'apiVersion: v1\nkind: Service\nmetadata:\n  name: web-lb\n  namespace: pdf\nspec:\n  type: LoadBalancer\n' }],
  [25, { bash: 'kubectl --context gke_pdf-demo_us-central1_main apply -f k8s/svc.yaml' }],
  [20, { bash: 'gcloud sql instances create pdf-db --tier db-f1-micro --region us-central1', fail: true }],
];

const L = [];
steps.forEach(([h, s], i) => {
  const id = `toolu_demo_${i}`;
  const tu = s.bash ? { type: 'tool_use', id, name: 'Bash', input: { command: s.bash } }
    : s.mcp ? { type: 'tool_use', id, name: s.mcp, input: s.input }
      : { type: 'tool_use', id, name: 'Write', input: { file_path: s.write, content: s.content } };
  L.push({ sessionId: 'demo-1', cwd, timestamp: ago(h), type: 'assistant', message: { role: 'assistant', content: [tu] } });
  const res = s.mcp ? [{ type: 'text', text: JSON.stringify(s.result) }] : s.fail ? 'Exit code 1\nERROR: quota exceeded' : 'ok';
  L.push({ sessionId: 'demo-1', cwd, timestamp: ago(h - 0.01), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: res, is_error: !!s.fail }] } });
});
fs.writeFileSync(path.join(dir, 'demo-1.jsonl'), L.map((o) => JSON.stringify(o)).join('\n') + '\n');
console.log(home);
