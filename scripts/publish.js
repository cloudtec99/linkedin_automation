#!/usr/bin/env node
/**
 * publish.js
 * Posts the approved content to LinkedIn via the UGC Posts API.
 */

const https = require('https');
const fs    = require('fs');

const TOKEN   = process.env.LINKEDIN_ACCESS_TOKEN;
const URN     = process.env.LINKEDIN_PERSON_URN;
const CONTENT = process.env.POST_CONTENT;
const POST_ID = process.env.POST_ID;

function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) fs.appendFileSync(f, `${name}=${value}\n`);
}

function linkedinPost(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: 'api.linkedin.com',
      path:     '/v2/ugcPosts',
      method:   'POST',
      headers:  {
        'Authorization':             `Bearer ${TOKEN}`,
        'Content-Type':              'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Length':            Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!TOKEN || !URN)    { console.error('❌  LINKEDIN_ACCESS_TOKEN or LINKEDIN_PERSON_URN not set'); process.exit(1); }
  if (!CONTENT)          { console.error('❌  POST_CONTENT is empty'); process.exit(1); }

  console.log(`📤  Publishing post: ${POST_ID}`);
  console.log(`👤  Author: urn:li:person:${URN}`);
  console.log(`📝  Length: ${CONTENT.length} chars`);

  const { status, body } = await linkedinPost({
    author:          `urn:li:person:${URN}`,
    lifecycleState:  'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary:    { text: CONTENT },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  });

  if (status === 201 || status === 200) {
    const liId  = body.id || '';
    const url   = `https://www.linkedin.com/feed/update/${liId}/`;
    console.log(`\n✅  Posted successfully!`);
    console.log(`🔗  URL: ${url}`);
    setOutput('linkedin_url', url);
  } else {
    console.error(`\n❌  LinkedIn API error (${status}):`, JSON.stringify(body, null, 2));
    if (status === 401) console.error('💡  Token expired — redo OAuth and update GitHub Secret LINKEDIN_ACCESS_TOKEN');
    if (status === 403) console.error('💡  Missing w_member_social scope — re-authorize the LinkedIn app');
    if (status === 422) console.error('💡  Post content too long or malformed');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌  publish.js failed:', err.message);
  process.exit(1);
});
