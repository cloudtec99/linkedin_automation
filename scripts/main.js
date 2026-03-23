#!/usr/bin/env node
/**
 * main.js — LinkedIn automation pipeline
 *
 * 8 Topics: DevOps, GitOps, AIOps, Platform Eng, Kubernetes, Docker, Terraform, AWS
 * + Diagram generation via Groq → mermaid.ink → LinkedIn image post
 *
 * Flow:
 * 1. Generate post via Groq (free)
 * 2. For visual topics: generate Mermaid diagram → render as PNG
 * 3. Send Telegram: diagram preview + post text + action buttons
 * 4. Poll for tap: Approve with diagram / Approve text only / Skip / Regen
 * 5. Publish to LinkedIn
 */

const https = require('https');
const fs    = require('fs');

const GROQ_TOKEN = process.env.GROQ_API_KEY;
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT    = String(process.env.TELEGRAM_CHAT_ID);
const LI_TOKEN   = process.env.LINKEDIN_ACCESS_TOKEN;
const LI_URN     = process.env.LINKEDIN_PERSON_URN;

const POLL_TIMEOUT     = 30;
const MAX_WAIT_MINUTES = 55;

// ── Topics (8 categories) ─────────────────────────────────────────────
const TOPICS = [
  { cat:'devops',    label:'DevOps',               emoji:'⚙️',  diagram:false,
    subtopics:['Zero-downtime deployments: Blue/Green vs Canary vs Rolling','GitHub Actions caching strategies that cut CI time in half','Helm best practices every production team should follow','Prometheus alerting rules that catch real issues not noise','Observability vs Monitoring — what most teams get wrong','SRE error budgets: how to actually use them in practice','CI/CD pipeline security: shift-left in practice'] },

  { cat:'gitops',    label:'GitOps',               emoji:'🔁',  diagram:true,
    subtopics:['ArgoCD App-of-Apps pattern: manage 50 apps like one','Flux CD vs ArgoCD in 2025 — honest comparison','Progressive delivery with Flagger + ArgoCD rollouts','Kustomize overlays vs Helm values files — which wins?','Config drift detection before it breaks production','Secrets in GitOps: Sealed Secrets vs External Secrets Operator','Multi-cluster GitOps with ArgoCD ApplicationSets'] },

  { cat:'aiops',     label:'AIOps',                emoji:'🤖',  diagram:false,
    subtopics:['LLM-powered incident root cause analysis','ML model drift detection: when your model goes stale','Vector databases for intelligent ops knowledge bases','AI-assisted log analysis beyond grep and Splunk','Anomaly detection without a data science background','LLMOps: deploying and monitoring AI models at scale','Cutting alert fatigue 90% with AI-based routing'] },

  { cat:'platform',  label:'Platform Engineering', emoji:'🏗️', diagram:true,
    subtopics:['Building an Internal Developer Platform from zero','Backstage: honest lessons after 6 months in production','Golden paths — why developers actually adopt them','Team Topologies applied to platform teams: practical guide','Self-service infra with Crossplane + GitOps','Developer experience metrics your CTO will care about','Port vs Backstage: IDP comparison 2025'] },

  { cat:'kubernetes',label:'Kubernetes',            emoji:'☸️',  diagram:true,
    subtopics:['Kubernetes HPA vs VPA vs KEDA — when to use each','K8s resource requests & limits: the complete guide','Kubernetes networking deep dive: CNI, Services, Ingress','Pod disruption budgets: protect your app during node drains','Kubernetes RBAC done right — least privilege in practice','StatefulSets vs Deployments: choosing the right workload type','K8s cost optimization: 6 ways to cut your cloud bill by 40%'] },

  { cat:'docker',    label:'Docker',                emoji:'🐳',  diagram:false,
    subtopics:['Docker multi-stage builds that slash image size by 80%','Docker layer caching: the secret to fast CI builds','Docker security best practices every dev should know','Docker Compose for local dev: tips most teams miss','Distroless vs Alpine vs Scratch: choosing the right base image','Docker BuildKit: features that changed how I build images','Container image scanning: shift security left in your pipeline'] },

  { cat:'terraform', label:'Terraform',             emoji:'🌍',  diagram:true,
    subtopics:['Terraform modules: how to structure them for large teams','Terraform state management: remote backends and locking','Terragrunt vs Terraform workspaces — which scales better?','Terraform import: bring existing infra under IaC control','Terraform testing with Terratest — yes, test your IaC','Terraform drift detection: catch manual changes automatically','OpenTofu vs Terraform in 2025 — should you migrate?'] },

  { cat:'aws',       label:'AWS',                   emoji:'☁️',  diagram:true,
    subtopics:['AWS EKS vs ECS vs Fargate — choosing the right platform','AWS cost optimization: 7 changes that cut my bill by 35%','AWS VPC design patterns for production workloads','AWS IAM least privilege: how to actually achieve it','AWS RDS vs Aurora vs DynamoDB — picking the right database','AWS Lambda cold starts: causes, impact, and real solutions','AWS multi-account strategy with Control Tower and Landing Zone'] },
];

const FORMATS = [
  { label:'Quick Tip',          instruction:'Punchy actionable tip, max 180 words, numbered steps if useful.' },
  { label:'Deep Dive',          instruction:'In-depth with a concrete before/after example. 250–300 words.' },
  { label:'Tool Spotlight',     instruction:'One tool: problem it solves, killer feature, real gotcha, who should use it.' },
  { label:'Lesson Learned',     instruction:'Production war story: what broke, what you did, what you learned.' },
  { label:'Community Question', instruction:'Bold opinion or surprising stat up front, then one sharp question.' },
];

function todaysPick() {
  const d        = Math.floor((Date.now() - new Date(new Date().getFullYear(),0,0)) / 86400000);
  const topic    = TOPICS[d % TOPICS.length];
  const subtopic = topic.subtopics[Math.floor(d / TOPICS.length) % topic.subtopics.length];
  const format   = FORMATS[d % FORMATS.length];
  return { topic, subtopic, format };
}

// ── HTTP helpers ──────────────────────────────────────────────────────
function httpReq(options, bodyData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        try { resolve({ status: res.statusCode, body: JSON.parse(raw.toString()), raw }); }
        catch { resolve({ status: res.statusCode, body: raw.toString(), raw }); }
      });
    });
    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

function postJson(hostname, path, headers, body) {
  const data = JSON.stringify(body);
  return httpReq({ hostname, path, method:'POST', headers:{ 'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),...headers } }, data);
}

function getReq(hostname, path) {
  return httpReq({ hostname, path, method:'GET', headers:{ 'Content-Type':'application/json' } }, null);
}

// ── Groq — post text ─────────────────────────────────────────────────
async function generatePost(topic, subtopic, format) {
  console.log(`🤖 Generating post via Groq...`);
  const prompt = `You are a senior ${topic.label} engineer with 12+ years hands-on experience.
Write a LinkedIn post about: "${subtopic}"
Format: ${format.label} — ${format.instruction}

STRICT RULES:
1. First line = powerful hook. NEVER start with "I'm excited", "Today I want to", "In today's world"
2. Blank line after every 1-2 sentences — LinkedIn is read on mobile
3. 2-4 emojis placed naturally — NOT one per line
4. End with exactly ONE question to spark comments
5. Last line only: 5-7 hashtags
6. Use real tool names, commands, version numbers
7. 160-280 words total

Return ONLY the post text. Nothing else.`;

  const {status,body} = await postJson('api.groq.com','/openai/v1/chat/completions',
    { Authorization:`Bearer ${GROQ_TOKEN}` },
    { model:'llama-3.3-70b-versatile', max_tokens:900, temperature:0.82, messages:[{role:'user',content:prompt}] }
  );
  if (status!==200) throw new Error(`Groq error ${status}: ${JSON.stringify(body).substring(0,200)}`);
  return body.choices[0].message.content.trim();
}

// ── Groq — Mermaid diagram ────────────────────────────────────────────
async function generateDiagram(topic, subtopic) {
  console.log(`📊 Generating diagram...`);
  const prompt = `Create a Mermaid diagram that visually explains: "${subtopic}" in the context of ${topic.label}.

Rules:
- Use flowchart TD or LR (pick most readable)
- Maximum 10 nodes — keep it clean
- Use descriptive labels with real tool names (e.g. ArgoCD, EKS, S3, Terraform)
- Add: classDef highlight fill:#0077b5,stroke:#005f8f,color:#fff

Return ONLY valid Mermaid syntax. No markdown fences, no backticks, no explanation.
Start directly with: flowchart or graph`;

  const {status,body} = await postJson('api.groq.com','/openai/v1/chat/completions',
    { Authorization:`Bearer ${GROQ_TOKEN}` },
    { model:'llama-3.3-70b-versatile', max_tokens:500, temperature:0.3, messages:[{role:'user',content:prompt}] }
  );
  if (status!==200) throw new Error(`Groq diagram error ${status}`);
  let code = body.choices[0].message.content.trim();
  code = code.replace(/^```mermaid\n?/i,'').replace(/^```\n?/,'').replace(/```$/,'').trim();
  return code;
}

// ── Render via mermaid.ink (free, no install) ─────────────────────────
async function renderDiagram(mermaidCode) {
  console.log(`🖼️  Rendering via mermaid.ink...`);
  try {
    const encoded = Buffer.from(mermaidCode).toString('base64url');
    const imgPath = '/tmp/diagram.png';
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(imgPath);
      https.get(`https://mermaid.ink/img/${encoded}?bgColor=1e2d45&theme=dark`, res => {
        if (res.statusCode !== 200) { reject(new Error(`mermaid.ink returned ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    });
    const size = fs.statSync(imgPath).size;
    if (size < 500) throw new Error('Empty image returned');
    console.log(`✅ Diagram ready (${Math.round(size/1024)}KB)`);
    return imgPath;
  } catch(err) {
    console.warn(`⚠️  Diagram render failed: ${err.message} — will post text only`);
    return null;
  }
}

// ── Send diagram to Telegram ──────────────────────────────────────────
async function sendDiagramToTelegram(imgPath, caption) {
  const imgData  = fs.readFileSync(imgPath);
  const boundary = 'Boundary' + Date.now();
  const pre      = Buffer.from([
    `--${boundary}`,`Content-Disposition: form-data; name="chat_id"`,``,TG_CHAT,
    `--${boundary}`,`Content-Disposition: form-data; name="caption"`,``,caption,
    `--${boundary}`,`Content-Disposition: form-data; name="photo"; filename="diagram.png"`,`Content-Type: image/png`,``,``
  ].join('\r\n'));
  const end  = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([pre, imgData, end]);

  await httpReq({
    hostname:'api.telegram.org', path:`/bot${TG_TOKEN}/sendPhoto`, method:'POST',
    headers:{ 'Content-Type':`multipart/form-data; boundary=${boundary}`, 'Content-Length':body.length }
  }, body);
  console.log('✅ Diagram sent to Telegram');
}

// ── Telegram ──────────────────────────────────────────────────────────
function tlg(method, payload) {
  return postJson('api.telegram.org',`/bot${TG_TOKEN}/${method}`,{},payload);
}
function esc(t) { return String(t).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g,'\\$1'); }

async function sendApprovalMessage(content, topic, subtopic, hasDiagram) {
  const preview  = content.length>2000 ? content.substring(0,2000)+'…' : content;
  const diagNote = hasDiagram ? '\n🖼️  *Diagram preview sent above*' : '';
  const text = `🤖 *Daily LinkedIn Post — Approval Needed*\n\n📌 *${esc(topic.emoji+' '+topic.label+' — '+subtopic)}*\n📊 ${content.length}/3000 chars${diagNote}\n\n━━━━━━━━━━━━━━━━━━\n${esc(preview)}\n━━━━━━━━━━━━━━━━━━\n\n🕙 *10:00 AM IST* 👇`;

  const keyboard = hasDiagram
    ? { inline_keyboard:[
        [{text:'✅ Approve + Diagram',callback_data:'APPROVE_IMG'},{text:'📝 Text Only',callback_data:'APPROVE'}],
        [{text:'⏭️ Skip',callback_data:'SKIP'},{text:'🔄 Regen',callback_data:'REGEN'}]
      ]}
    : { inline_keyboard:[
        [{text:'✅ Approve & Post',callback_data:'APPROVE'},{text:'⏭️ Skip',callback_data:'SKIP'}],
        [{text:'🔄 Regenerate',callback_data:'REGEN'}]
      ]};

  const {body} = await tlg('sendMessage',{chat_id:TG_CHAT,text,parse_mode:'MarkdownV2',reply_markup:keyboard});
  if (!body.ok) throw new Error(`Telegram failed: ${JSON.stringify(body)}`);
  console.log(`📱 Approval message sent`);
}

// ── Poll Telegram ─────────────────────────────────────────────────────
async function waitForApproval() {
  console.log(`⏳ Waiting for your tap (up to ${MAX_WAIT_MINUTES} min)...`);
  let offset = 0;
  const c = await getReq('api.telegram.org',`/bot${TG_TOKEN}/getUpdates?offset=-1`);
  if (c.body?.result?.length>0) offset = c.body.result[c.body.result.length-1].update_id+1;

  const deadline = Date.now() + MAX_WAIT_MINUTES*60*1000;
  while (Date.now()<deadline) {
    const {body} = await getReq('api.telegram.org',`/bot${TG_TOKEN}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT}&allowed_updates=callback_query`);
    if (!body.ok) { console.warn('⚠️ getUpdates:', JSON.stringify(body)); await sleep(5000); continue; }
    for (const u of (body.result||[])) {
      offset = u.update_id+1;
      const cb = u.callback_query;
      if (!cb || String(cb.message?.chat?.id)!==TG_CHAT) continue;
      await tlg('answerCallbackQuery',{callback_query_id:cb.id});
      console.log(`👆 Action: ${cb.data}`);
      return cb.data;
    }
  }
  return 'TIMEOUT';
}

// ── LinkedIn ──────────────────────────────────────────────────────────
async function publishText(content) {
  const {status,body} = await postJson('api.linkedin.com','/v2/ugcPosts',
    { Authorization:`Bearer ${LI_TOKEN}`,'X-Restli-Protocol-Version':'2.0.0' },
    { author:`urn:li:person:${LI_URN}`, lifecycleState:'PUBLISHED',
      specificContent:{'com.linkedin.ugc.ShareContent':{shareCommentary:{text:content},shareMediaCategory:'NONE'}},
      visibility:{'com.linkedin.ugc.MemberNetworkVisibility':'PUBLIC'} }
  );
  if (status===201||status===200) return `https://www.linkedin.com/feed/update/${body.id}/`;
  throw new Error(`LinkedIn error ${status}: ${JSON.stringify(body).substring(0,200)}`);
}

async function publishWithImage(content, imgPath) {
  try {
    // Register asset
    const {status:s1,body:b1} = await postJson('api.linkedin.com','/v2/assets?action=registerUpload',
      { Authorization:`Bearer ${LI_TOKEN}`,'X-Restli-Protocol-Version':'2.0.0' },
      { registerUploadRequest:{ recipes:['urn:li:digitalmediaRecipe:feedshare-image'], owner:`urn:li:person:${LI_URN}`,
          serviceRelationships:[{relationshipType:'OWNER',identifier:'urn:li:userGeneratedContent'}] } }
    );
    if (s1!==200) throw new Error(`Register failed ${s1}`);
    const uploadUrl = b1.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    const asset     = b1.value.asset;

    // Upload image
    const imgData = fs.readFileSync(imgPath);
    const uUrl    = new URL(uploadUrl);
    await httpReq({ hostname:uUrl.hostname, path:uUrl.pathname+uUrl.search, method:'PUT',
      headers:{ Authorization:`Bearer ${LI_TOKEN}`,'Content-Type':'image/png','Content-Length':imgData.length }
    }, imgData);

    // Post with image
    const {status:s2,body:b2} = await postJson('api.linkedin.com','/v2/ugcPosts',
      { Authorization:`Bearer ${LI_TOKEN}`,'X-Restli-Protocol-Version':'2.0.0' },
      { author:`urn:li:person:${LI_URN}`, lifecycleState:'PUBLISHED',
        specificContent:{'com.linkedin.ugc.ShareContent':{ shareCommentary:{text:content}, shareMediaCategory:'IMAGE',
          media:[{status:'READY',description:{text:'Diagram'},media:asset,title:{text:'Architecture Diagram'}}] }},
        visibility:{'com.linkedin.ugc.MemberNetworkVisibility':'PUBLIC'} }
    );
    if (s2===201||s2===200) return `https://www.linkedin.com/feed/update/${b2.id}/`;
    throw new Error(`Post with image failed ${s2}`);
  } catch(err) {
    console.warn(`⚠️  Image post failed (${err.message}) — falling back to text only`);
    return await publishText(content);
  }
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  let { topic, subtopic, format } = todaysPick();
  let regenCount = 0;

  while (true) {
    console.log(`\n${'━'.repeat(50)}`);
    console.log(`📌 ${topic.emoji} ${topic.label} — ${subtopic}`);
    console.log(`📋 Format: ${format.label} | 🖼️  Diagram: ${topic.diagram?'Yes':'No'}`);
    console.log(`${'━'.repeat(50)}\n`);

    const content = await generatePost(topic, subtopic, format);
    console.log('\n── Post ──────────────────────────────────────');
    console.log(content);
    console.log(`──────────────────────────────────────────────`);
    console.log(`📊 ${content.length} chars | 💰 $0.00\n`);

    // Generate diagram for visual topics
    let imgPath = null;
    if (topic.diagram) {
      const mermaidCode = await generateDiagram(topic, subtopic);
      imgPath = await renderDiagram(mermaidCode);
      if (imgPath) await sendDiagramToTelegram(imgPath, `📊 ${topic.emoji} ${subtopic}`);
    }

    await sendApprovalMessage(content, topic, subtopic, !!imgPath);
    const action = await waitForApproval();

    if (action==='APPROVE'||action==='APPROVE_IMG') {
      const url = (action==='APPROVE_IMG'&&imgPath)
        ? await publishWithImage(content, imgPath)
        : await publishText(content);

      await tlg('sendMessage',{ chat_id:TG_CHAT,
        text:`✅ *Post is LIVE on LinkedIn\\!*\n\n🔗 [View your post](${url})\n\n_See you tomorrow at 10:00 AM IST 🚀_`,
        parse_mode:'MarkdownV2' });
      console.log(`\n🎉 Live at: ${url}`);
      break;

    } else if (action==='SKIP') {
      await tlg('sendMessage',{chat_id:TG_CHAT,text:'⏭️ Skipped. See you tomorrow at 10:00 AM IST 👋'});
      break;

    } else if (action==='REGEN') {
      regenCount++;
      await tlg('sendMessage',{chat_id:TG_CHAT,text:`🔄 Regenerating (attempt ${regenCount})…`});
      const d2   = Math.floor(Date.now()/86400000)+regenCount;
      topic      = TOPICS[d2%TOPICS.length];
      subtopic   = topic.subtopics[(d2+regenCount)%topic.subtopics.length];
      format     = FORMATS[(d2+1)%FORMATS.length];
      continue;

    } else {
      await tlg('sendMessage',{chat_id:TG_CHAT,text:'⏰ No response in 55 min — post skipped for today.'});
      break;
    }
  }
}

main().catch(async err => {
  console.error('\n❌ Pipeline failed:', err.message);
  await tlg('sendMessage',{chat_id:TG_CHAT,text:`❌ Error: ${err.message.substring(0,200)}`}).catch(()=>{});
  process.exit(1);
});
