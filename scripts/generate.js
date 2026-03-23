#!/usr/bin/env node
/**
 * generate.js
 * Calls Groq API (Llama-3.1-70B) — 100% free, no credit card.
 * Sign up: https://console.groq.com
 */

const https  = require('https');
const fs     = require('fs');
const crypto = require('crypto');

// ── 28 topics across 4 categories ───────────────────────────────────
const TOPICS = [
  {
    cat: 'devops', label: 'DevOps', emoji: '🐳',
    subtopics: [
      'Kubernetes HPA vs VPA — when to use each and why it matters',
      'Zero-downtime deployments: Blue/Green vs Canary vs Rolling update',
      'Docker multi-stage builds that slash production image size by 80%',
      'GitHub Actions caching strategies that cut CI pipeline time in half',
      'Helm chart best practices every production team should follow',
      'Prometheus alerting rules that actually catch real issues (not noise)',
      'Kubernetes resource requests & limits: the complete practical guide',
    ],
  },
  {
    cat: 'gitops', label: 'GitOps', emoji: '🔁',
    subtopics: [
      'ArgoCD App-of-Apps pattern: manage 50 microservices like one',
      'Flux CD vs ArgoCD in 2025 — an honest side-by-side comparison',
      'Progressive delivery with Flagger + ArgoCD rollouts',
      'Kustomize overlays vs Helm values files — which one actually wins?',
      'Config drift detection: catch it before it silently breaks production',
      'GitOps secrets management: Sealed Secrets vs External Secrets Operator',
      'Multi-cluster GitOps with ArgoCD ApplicationSets — real-world patterns',
    ],
  },
  {
    cat: 'aiops', label: 'AIOps', emoji: '🤖',
    subtopics: [
      'LLM-powered incident root cause analysis — moving beyond runbooks',
      'ML model drift detection: how to know when your model goes stale',
      'Vector databases for ops knowledge bases and intelligent runbooks',
      'AI-assisted log analysis: what comes after grep and Splunk',
      'Anomaly detection in production without a data science background',
      'LLMOps: deploying, versioning, and monitoring AI models at scale',
      'Reducing alert fatigue 90% with AI-based intelligent alert routing',
    ],
  },
  {
    cat: 'platform', label: 'Platform Engineering', emoji: '🏗️',
    subtopics: [
      'Building an Internal Developer Platform from zero to production',
      'Backstage: honest lessons after 6 months running it in production',
      'Golden paths — why developers actually adopt them (and why they don\'t)',
      'Team Topologies applied to platform teams: a practical guide',
      'Self-service infrastructure with Crossplane + GitOps',
      'Developer experience metrics that actually matter to your CTO',
      'Port vs Backstage: a real IDP comparison for 2025',
    ],
  },
];

const FORMATS = [
  {
    label: 'Quick Tip',
    instruction: 'A punchy, highly actionable tip. Max 180 words. Use a short numbered list if steps are involved.',
  },
  {
    label: 'Deep Dive',
    instruction: 'In-depth explanation with a concrete before/after example or real scenario. 250–300 words.',
  },
  {
    label: 'Tool Spotlight',
    instruction: 'Shine a light on one specific tool: the problem it solves, its single best feature, one real gotcha, and who should use it.',
  },
  {
    label: 'Lesson Learned',
    instruction: 'Honest war story from production: what went wrong, what you did under pressure, what you actually learned. Raw and relatable.',
  },
  {
    label: 'Community Question',
    instruction: 'Open a discussion. Start with a bold opinion or a surprising statistic, then ask the community one sharp, specific question.',
  },
];

// ── Pick today's topic by day-of-year rotation ───────────────────────
function todaysPick() {
  const start     = new Date(new Date().getFullYear(), 0, 0);
  const dayOfYear = Math.floor((Date.now() - start) / 86_400_000);
  const topic     = TOPICS[dayOfYear % TOPICS.length];
  const subtopic  = topic.subtopics[Math.floor(dayOfYear / TOPICS.length) % topic.subtopics.length];
  const format    = FORMATS[dayOfYear % FORMATS.length];
  return { topic, subtopic, format };
}

// ── Call Groq API ────────────────────────────────────────────────────
function callGroq(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:       'llama-3.3-70b-versatile',
      max_tokens:  900,
      temperature: 0.82,
      messages:    [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.groq.com',
      path:     '/openai/v1/chat/completions',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (res.statusCode !== 200) {
            reject(new Error(`Groq ${res.statusCode}: ${data.error?.message || raw.substring(0, 200)}`));
          } else {
            resolve(data.choices[0].message.content.trim());
          }
        } catch (e) {
          reject(new Error(`Parse error: ${raw.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Write GitHub Actions step output ────────────────────────────────
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    const delim = `DELIM_${crypto.randomBytes(6).toString('hex')}`;
    fs.appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
  } else {
    console.log(`\n[OUTPUT] ${name}:\n${String(value).substring(0, 120)}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error('❌  GROQ_API_KEY is not set.');
    console.error('    Get a free key at https://console.groq.com');
    process.exit(1);
  }

  const { topic, subtopic, format } = todaysPick();

  console.log('━'.repeat(60));
  console.log(`📌  Topic   : ${topic.label} — ${subtopic}`);
  console.log(`📋  Format  : ${format.label}`);
  console.log(`📅  Date    : ${new Date().toDateString()}`);
  console.log(`🤖  Model   : Llama-3.1-70B via Groq (free)`);
  console.log('━'.repeat(60));

  const prompt = `You are a senior ${topic.label} engineer with 12+ years of hands-on experience.
You write LinkedIn posts that practitioners actually enjoy reading.

Write a LinkedIn post about: "${subtopic}"
Format: ${format.label} — ${format.instruction}

STRICT RULES:
1. First line = powerful hook. Bold claim, surprising number, or sharp question.
   NEVER open with: "I'm excited", "Today I want to", "In today's world", "Let me share"
2. Put a blank line after every 1–2 sentences. LinkedIn is read on phones — readers skim.
3. Use 2–4 emojis placed naturally inside the text, NOT one at the start of every line.
4. Close with exactly ONE question to spark comments from your network.
5. Final line only: 5–7 relevant hashtags, nothing else.
6. Be specific: real tool names, real kubectl / git commands, real version numbers.
7. Sound like a practitioner sharing hard-won knowledge, not a content marketer.
8. Total word count: 160–280 words.

Return ONLY the post text. No intro, no explanation, no quotes around it.`;

  const postContent = await callGroq(prompt);
  const postId      = `post_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  console.log('\n── Generated Post ──────────────────────────────────────');
  console.log(postContent);
  console.log('────────────────────────────────────────────────────────');
  console.log(`\n📊  Characters : ${postContent.length} / 3000`);
  console.log(`🆔  Post ID    : ${postId}`);
  console.log(`💰  API Cost   : $0.00`);

  setOutput('post_content', postContent);
  setOutput('post_topic',   `${topic.emoji} ${topic.label} — ${subtopic}`);
  setOutput('post_id',      postId);
}

main().catch(err => {
  console.error('\n❌  generate.js failed:', err.message);
  process.exit(1);
});
