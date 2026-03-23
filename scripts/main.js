#!/usr/bin/env node
/**
 * main.js — Complete pipeline in one script
 *
 * 1. Generate post via Groq (free)
 * 2. Send to Telegram with Approve / Skip / Regenerate buttons
 * 3. Poll Telegram for your button tap (runs inside GitHub Actions — no server needed)
 * 4. On Approve → publish to LinkedIn
 * 5. Send confirmation back to Telegram
 *
 * Zero servers. Zero storage issues. Completely free.
 */

const https = require('https');

// ── Config ────────────────────────────────────────────────────────────
const GROQ_TOKEN   = process.env.GROQ_API_KEY;
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT      = String(process.env.TELEGRAM_CHAT_ID);
const LI_TOKEN     = process.env.LINKEDIN_ACCESS_TOKEN;
const LI_URN       = process.env.LINKEDIN_PERSON_URN;

const POLL_TIMEOUT      = 30;   // Telegram long-poll seconds
const MAX_WAIT_MINUTES  = 55;   // Stop waiting after this (GitHub Actions limit is 60 min)

// ── Topic bank ────────────────────────────────────────────────────────
const TOPICS = [
  { cat:'devops',   label:'DevOps',               emoji:'🐳',
    subtopics:['Kubernetes HPA vs VPA — when to use each','Zero-downtime deployments: Blue/Green vs Canary','Docker multi-stage builds that cut image size by 80%','GitHub Actions caching to slash CI pipeline time','Helm best practices for production Kubernetes','Prometheus alerting rules that catch real issues','K8s resource requests & limits: the complete guide'] },
  { cat:'gitops',   label:'GitOps',               emoji:'🔁',
    subtopics:['ArgoCD App-of-Apps: manage 50 apps like one','Flux CD vs ArgoCD in 2025 — honest comparison','Progressive delivery with Flagger + ArgoCD','Kustomize overlays vs Helm values — which wins?','Config drift detection before it breaks production','Secrets in GitOps: Sealed Secrets vs External Secrets Operator','Multi-cluster GitOps with ArgoCD ApplicationSets'] },
  { cat:'aiops',    label:'AIOps',                emoji:'🤖',
    subtopics:['LLM-powered incident root cause analysis','ML model drift detection in production','Vector databases for ops knowledge bases','AI-assisted log analysis beyond grep','Anomaly detection without a data science background','LLMOps: deploying and monitoring AI models at scale','Reducing alert fatigue with AI-based routing'] },
  { cat:'platform', label:'Platform Engineering', emoji:'🏗️',
    subtopics:['Building an Internal Developer Platform from zero','Backstage: honest review after 6 months in production','Golden paths — why developers actually adopt them','Team Topologies applied to platform teams','Self-service infra with Crossplane + GitOps','Developer experience metrics your CTO will care about','Port vs Backstage: IDP comparison 2025'] },
];

const FORMATS = [
  { label:'Quick Tip',          instruction:'Punchy actionable tip, max 180 words, numbered steps if useful.' },
  { label:'Deep Dive',          instruction:'In-depth with a concrete before/after example. 250–300 words.' },
  { label:'Tool Spotlight',     instruction:'One tool: problem it solves, killer feature, real gotcha, who should use it.' },
  { label:'Lesson Learned',     instruction:'Production war story: what broke, what you did, what you learned.' },
  { label:'Community Question', instruction:'Bold opinion or surprising stat, then ask one sharp question.' },
];

function todaysPick() {
  const d       = Math.floor((Date.now() - new Date(new Date().getFullYear(),0,0)) / 86400000);
  const topic   = TOPICS[d % TOPICS.length];
  const subtopic = topic.subtopics[Math.floor(d / TOPICS.length) % topic.subtopics.length];
  const format  = FORMATS[d % FORMATS.length];
  return { topic, subtopic, format };
}

// ── HTTP helpers ──────────────────────────────────────────────────────
function post(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request(
      { hostname, path, method:'POST', headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(data), ...headers } },
      res => { let r=''; res.on('data',c=>r+=c); res.on('end',()=>{ try{resolve({status:res.statusCode,body:JSON.parse(r)})}catch{resolve({status:res.statusCode,body:r})} }); }
    );
    req.on('error',reject); req.write(data); req.end();
  });
}

function get(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method:'GET', headers:{ 'Content-Type':'application/json', ...headers } },
      res => { let r=''; res.on('data',c=>r+=c); res.on('end',()=>{ try{resolve({status:res.statusCode,body:JSON.parse(r)})}catch{resolve({status:res.statusCode,body:r})} }); }
    );
    req.on('error',reject); req.end();
  });
}

// ── Groq ──────────────────────────────────────────────────────────────
async function generatePost(topic, subtopic, format) {
  console.log(`🤖 Calling Groq (Llama-3.3-70B)...`);
  const prompt = `You are a senior ${topic.label} engineer with 12+ years hands-on experience.
Write a LinkedIn post about: "${subtopic}"
Format: ${format.label} — ${format.instruction}

RULES:
1. First line = powerful hook. NEVER start with "I'm excited" or "Today I want to"
2. Blank line after every 1-2 sentences (mobile readers skim)
3. 2-4 emojis placed naturally — not one per line
4. End with ONE question to spark comments
5. Last line: 5-7 hashtags only
6. Use real tool names, commands, version numbers
7. 160-280 words total

Return ONLY the post text, nothing else.`;

  const {status,body} = await post('api.groq.com','/openai/v1/chat/completions',
    { Authorization:`Bearer ${GROQ_TOKEN}` },
    { model:'llama-3.3-70b-versatile', max_tokens:900, temperature:0.82, messages:[{role:'user',content:prompt}] }
  );
  if (status!==200) throw new Error(`Groq error ${status}: ${JSON.stringify(body).substring(0,200)}`);
  return body.choices[0].message.content.trim();
}

// ── Telegram ──────────────────────────────────────────────────────────
function tlg(method, payload) {
  return post('api.telegram.org', `/bot${TG_TOKEN}/${method}`, {}, payload);
}

function esc(t) {
  return String(t).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g,'\\$1');
}

async function sendApprovalMessage(content, topic, subtopic) {
  const preview = content.length > 2500 ? content.substring(0,2500)+'…' : content;
  const text = `🤖 *Daily LinkedIn Post — Approval Needed*\n\n📌 *${esc(topic.emoji+' '+topic.label+' — '+subtopic)}*\n📊 ${content.length}/3000 chars\n\n━━━━━━━━━━━━━━━━━━━━\n${esc(preview)}\n━━━━━━━━━━━━━━━━━━━━\n\n🕙 *10:00 AM IST* — tap an action 👇`;

  const {body} = await tlg('sendMessage', {
    chat_id:      TG_CHAT,
    text,
    parse_mode:   'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        [{ text:'✅  Approve & Post', callback_data:'APPROVE' }, { text:'⏭️  Skip Today', callback_data:'SKIP' }],
        [{ text:'🔄  Regenerate',     callback_data:'REGEN' }],
      ]
    }
  });

  if (!body.ok) throw new Error(`Telegram send failed: ${JSON.stringify(body)}`);
  console.log(`📱 Telegram message sent (msg_id: ${body.result.message_id})`);
  return body.result.message_id;
}

// ── Poll Telegram for button tap ──────────────────────────────────────
async function waitForApproval() {
  console.log(`⏳ Waiting for your Telegram response (up to ${MAX_WAIT_MINUTES} min)...`);

  // Clear any old updates first
  let offset = 0;
  const clearRes = await get('api.telegram.org', `/bot${TG_TOKEN}/getUpdates?offset=-1`);
  if (clearRes.body?.result?.length > 0) {
    offset = clearRes.body.result[clearRes.body.result.length-1].update_id + 1;
  }

  const deadline = Date.now() + MAX_WAIT_MINUTES * 60 * 1000;

  while (Date.now() < deadline) {
    const {body} = await get(
      'api.telegram.org',
      `/bot${TG_TOKEN}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT}&allowed_updates=callback_query`
    );

    if (!body.ok) {
      console.warn('⚠️ getUpdates error:', JSON.stringify(body));
      await sleep(5000);
      continue;
    }

    for (const update of (body.result || [])) {
      offset = update.update_id + 1;
      const cb = update.callback_query;
      if (!cb) continue;

      // Only accept from our chat
      if (String(cb.message?.chat?.id) !== TG_CHAT) continue;

      // Acknowledge the button press
      await tlg('answerCallbackQuery', { callback_query_id: cb.id });

      const action = cb.data;
      console.log(`👆 Button tapped: ${action}`);
      return action; // 'APPROVE', 'SKIP', or 'REGEN'
    }
  }

  return 'TIMEOUT';
}

// ── LinkedIn publisher ────────────────────────────────────────────────
async function publishToLinkedIn(content) {
  console.log('📤 Publishing to LinkedIn...');
  const {status,body} = await post('api.linkedin.com','/v2/ugcPosts',
    { 'Authorization':`Bearer ${LI_TOKEN}`, 'X-Restli-Protocol-Version':'2.0.0' },
    {
      author:          `urn:li:person:${LI_URN}`,
      lifecycleState:  'PUBLISHED',
      specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary:{text:content}, shareMediaCategory:'NONE' } },
      visibility:      { 'com.linkedin.ugc.MemberNetworkVisibility':'PUBLIC' }
    }
  );

  if (status===201||status===200) {
    const url = `https://www.linkedin.com/feed/update/${body.id}/`;
    console.log(`✅ Posted! URL: ${url}`);
    return url;
  } else {
    throw new Error(`LinkedIn error ${status}: ${JSON.stringify(body).substring(0,200)}`);
  }
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── Main flow ─────────────────────────────────────────────────────────
async function main() {
  let { topic, subtopic, format } = todaysPick();
  let content;

  // Loop to handle regeneration
  while (true) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📌 Topic:  ${topic.label} — ${subtopic}`);
    console.log(`📋 Format: ${format.label}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    content = await generatePost(topic, subtopic, format);
    console.log('\n── Post ──────────────────────────────────');
    console.log(content);
    console.log(`──────────────────────────────────────────`);
    console.log(`📊 ${content.length} chars | 💰 $0.00\n`);

    await sendApprovalMessage(content, topic, subtopic);
    const action = await waitForApproval();

    if (action === 'APPROVE') {
      const url = await publishToLinkedIn(content);
      await tlg('sendMessage', {
        chat_id:    TG_CHAT,
        text:       url
          ? `✅ *Post is LIVE on LinkedIn\\!*\n\n🔗 [View your post](${url})\n\n_See you tomorrow at 10:00 AM IST 🚀_`
          : `✅ *Post published successfully\\!*\n\n_See you tomorrow at 10:00 AM IST 🚀_`,
        parse_mode: 'MarkdownV2',
      });
      console.log('🎉 Done!');
      break;

    } else if (action === 'SKIP') {
      await tlg('sendMessage', { chat_id:TG_CHAT, text:"⏭️ Skipped. See you tomorrow at 10:00 AM IST 👋" });
      console.log('⏭️ Post skipped.');
      break;

    } else if (action === 'REGEN') {
      await tlg('sendMessage', { chat_id:TG_CHAT, text:"🔄 Regenerating a fresh post..." });
      console.log('🔄 Regenerating...');
      // Pick a slightly different subtopic for regen
      const d2 = Math.floor(Date.now() / 86400000);
      topic    = TOPICS[d2 % TOPICS.length];
      subtopic = topic.subtopics[(d2+1) % topic.subtopics.length];
      format   = FORMATS[(d2+2) % FORMATS.length];
      continue;

    } else if (action === 'TIMEOUT') {
      await tlg('sendMessage', { chat_id:TG_CHAT, text:"⏰ No response in 55 minutes — post skipped for today." });
      console.log('⏰ Timed out waiting for approval.');
      break;
    }
  }
}

main().catch(async err => {
  console.error('\n❌ Pipeline failed:', err.message);
  await tlg('sendMessage', { chat_id:TG_CHAT, text:`❌ Pipeline error: ${err.message.substring(0,200)}` }).catch(()=>{});
  process.exit(1);
});
