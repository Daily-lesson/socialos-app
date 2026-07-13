// @ts-check

/**
 * SocialOS — AI Module
 * All Claude API calls routed through the Cloudflare Worker proxy.
 * Uses prompt templates from Section 11 of BUILD_PLAN exactly.
 */

const SocialOSAI = (() => {
  'use strict';

  const MODEL = 'claude-sonnet-4-6';

  // ── Core proxy call ───────────────────────────────────────────────────

  /**
   * @typedef {{type: 'text', text: string} | {type: 'image', source: {type: 'base64', media_type: string, data: string}}} ContentBlock
   */

  /**
   * Send a request to Claude via the proxy.
   * @param {string} systemPrompt
   * @param {string|ContentBlock[]} userMessage - string, or content blocks (e.g. image + text) for vision calls
   * @param {number} [maxTokens=1000]
   * @returns {Promise<string>}
   */
  async function callClaude(systemPrompt, userMessage, maxTokens = 1000) {
    const settings = await SocialOSDB.getSettings();
    if (!settings || !settings.proxy_url) {
      throw new Error('Proxy URL not configured. Complete onboarding step 9.');
    }

    const response = await fetch(settings.proxy_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SocialOS-Secret': settings.proxy_secret
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Proxy returned ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || 'Claude API error');
    }

    return data.content[0].text;
  }

  /**
   * Test the proxy connection with a simple ping.
   * @param {string} proxyUrl
   * @param {string} proxySecret
   * @returns {Promise<boolean>}
   */
  async function testProxy(proxyUrl, proxySecret) {
    try {
      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SocialOS-Secret': proxySecret
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Reply with only the word "connected".' }]
        })
      });

      if (!response.ok) return false;
      const data = await response.json();
      return !!(data.content && data.content[0] && data.content[0].text);
    } catch {
      return false;
    }
  }

  // ── System prompt builder ─────────────────────────────────────────────

  /**
   * Build the base system prompt per Section 11.
   * @param {string} platform
   * @returns {Promise<string>}
   */
  async function buildSystemPrompt(platform) {
    const profile = await SocialOSDB.getProfile();
    if (!profile) throw new Error('Profile not found');

    return `You are the AI engine for SocialOS, a personal social media manager.

User profile:
- Name: ${profile.name}
- Title: ${profile.title}
- Expertise: ${profile.topics.join(', ')}
- Tone preference: ${profile.tone[platform] || 'professional'}
- Target audience on ${platform}: ${profile.target_audience[platform] || 'professionals'}

Rules you must follow:
1. Never include: client names, employer name, facility locations, financial figures, proprietary information, or any information marked as off-limits.
2. Always write in first person as the user.
3. Content must sound authentic, not like AI-generated corporate speak.
4. Platform-specific rules must be followed exactly.
5. Always return exactly what is requested — no preamble, no explanation.`;
  }

  // ── Post draft generation ─────────────────────────────────────────────

  /** @type {Object<string, string>} */
  const POST_PROMPTS = {
    linkedin: `Write a LinkedIn post based on the following content.

Source content: {content}
Angle: {angle}

Requirements:
- Length: 150–350 words
- Structure: Hook (1–2 sentences) → Story/Insight (3–5 paragraphs) → Takeaway/CTA
- Hashtags: Exactly 5, relevant to robotics/engineering/autonomous systems
- Tone: Professional, thoughtful, first-person narrative
- Do NOT use: corporate buzzwords, "I'm excited to share", "Thrilled to announce"
- DO use: specific details, real observations, honest insight
- End with either a question for the reader OR a clear takeaway

Return ONLY the post text followed by hashtags on the last line.
No explanation, no title, no quotation marks.`,

    facebook: `Write a Facebook post based on the following content.

Source content: {content}
Angle: {angle}

Requirements:
- Length: 100–250 words
- Tone: Conversational, warm, relatable
- Hashtags: 1–2 maximum
- Write as if sharing with professional friends
- End with a question to encourage comments
- 1–2 emoji maximum, used naturally

Return ONLY the post text. No explanation, no quotation marks.`,

    instagram: `Write an Instagram caption based on the following content.

Source content: {content}
This post includes a photo/video related to the content.

Requirements:
- Caption length: 50–150 words
- First line must be a punchy hook (visible before "more" cutoff)
- Casual, visual-first tone — the image is the star
- 1–3 relevant emoji maximum in the caption body
- After caption body, add line break then 25–30 hashtags
- Hashtag mix: 5 large (1M+ posts), 10 medium (100K–1M), 10 small/niche (<100K)
- Include hashtags relevant to: robotics, engineering, technology, autonomous systems, and 5–8 niche tags specific to the content

Return ONLY: caption text, blank line, hashtags.`,

    reddit: `Write a Reddit post for {subreddit} based on the following content.

Source content: {content}
Subreddit: {subreddit}

Requirements:
- Title: Under 100 characters, informative, not clickbait
- Body: Write as a peer sharing genuine experience, not self-promotion
- Length: 200–500 words depending on complexity
- Tone: Technical, honest, peer-to-peer — Reddit users are skeptical of marketing
- NO hashtags
- Include: what you did, what you learned, what was hard, what surprised you
- End with a genuine question to spark discussion
- Use Reddit markdown: **bold**, *italic*, bullet points where appropriate

Return ONLY:
TITLE: [title text]
BODY: [body text]`,

    tiktok: `Write a TikTok caption and a short video concept based on the following content.

Source content: {content}
Angle: {angle}

Requirements:
- Caption: under 150 characters before any hashtags — the first 3–5 words must hook
- Tone: energetic, authentic, first-person — TikTok rewards real over polished
- Hashtags: 3–5, mixing one broad tag with niche robotics/engineering tags
- 1–2 emoji maximum, used naturally
- Video concept: one sentence describing a 15–30 second clip that fits the content (what's on screen, what's said or shown)

Return ONLY:
CAPTION: [caption text with hashtags]
VIDEO: [one-sentence video concept]`
  };

  /**
   * Generate post drafts for a content item across specified platforms.
   * Scrubs content first, then generates 3 alternatives per platform.
   * @param {ContentItem} contentItem
   * @param {string[]} platforms
   * @returns {Promise<ScheduledPost[]>}
   */
  async function generatePostDrafts(contentItem, platforms) {
    const settings = await SocialOSDB.getSettings();
    const rawText = contentItem.raw_content || contentItem.description || contentItem.title;

    // Scrub before any Claude call
    const scrubbed = SocialOSUtils.scrub(
      rawText,
      settings?.content_scrubbing?.custom_blocked_terms
    );

    const posts = [];

    for (const platform of platforms) {
      const systemPrompt = await buildSystemPrompt(platform);
      const angle = contentItem.suggested_angles?.[0] || 'General professional insight';
      const subreddit = platform === 'reddit' ? 'r/robotics' : '';

      // Generate primary draft
      let prompt = POST_PROMPTS[platform]
        .replace('{content}', scrubbed.text)
        .replace('{angle}', angle)
        .replace(/\{subreddit\}/g, subreddit);

      const maxTokens = platform === 'instagram' ? 1500 : 1500;
      const primaryText = await callClaude(systemPrompt, prompt, maxTokens);

      // Generate 2 alternative drafts
      const alternatives = [];
      const altAngles = (contentItem.suggested_angles || []).slice(1, 3);
      if (altAngles.length === 0) {
        altAngles.push('Behind-the-scenes perspective', 'Question to spark discussion');
      }
      while (altAngles.length < 2) {
        altAngles.push('Different angle on the same topic');
      }

      for (const altAngle of altAngles) {
        let altPrompt = POST_PROMPTS[platform]
          .replace('{content}', scrubbed.text)
          .replace('{angle}', altAngle)
          .replace(/\{subreddit\}/g, subreddit);

        const altText = await callClaude(systemPrompt, altPrompt, maxTokens);
        alternatives.push({ text: altText, angle: altAngle });
      }

      // Parse hashtags from primary text
      const hashtags = extractHashtags(primaryText);

      // Parse Reddit title/body if applicable
      const platformMetadata = {};
      if (platform === 'reddit') {
        const titleMatch = primaryText.match(/TITLE:\s*(.+)/i);
        if (titleMatch) {
          platformMetadata.reddit_title = titleMatch[1].trim();
        }
        platformMetadata.subreddit = subreddit;
      }
      if (platform === 'tiktok') {
        const videoMatch = primaryText.match(/VIDEO:\s*(.+)/i);
        if (videoMatch) {
          platformMetadata.video_concept = videoMatch[1].trim();
        }
      }

      /** @type {ScheduledPost} */
      const post = {
        id: SocialOSUtils.uuid(),
        content_id: contentItem.id,
        platform,
        status: 'pending_approval',
        scheduled_time: '',
        published_time: null,
        draft: {
          text: primaryText,
          hashtags,
          angle,
          platform_metadata: platformMetadata
        },
        alternatives,
        selected_alternative: 0,
        approval_sent_at: SocialOSUtils.now(),
        approved_at: null,
        approved_by: 'user',
        edits_made: false,
        edit_history: [],
        platform_post_id: null,
        engagement_stats: {
          likes: 0,
          comments: 0,
          shares: 0,
          last_checked: SocialOSUtils.now()
        }
      };

      await SocialOSDB.put(SocialOSDB.STORES.posts, post);
      posts.push(post);
    }

    return posts;
  }

  /**
   * Extract hashtags from post text.
   * @param {string} text
   * @returns {string[]}
   */
  function extractHashtags(text) {
    const matches = text.match(/#\w+/g);
    return matches ? matches.map(h => h.replace('#', '')) : [];
  }

  // ── Content analysis ──────────────────────────────────────────────────

  /**
   * Analyse a piece of content for rating, tags, angles, and sensitivity.
   * @param {string} text - Already scrubbed text
   * @param {string} title
   * @returns {Promise<{rating: string, rating_reason: string, tags: string[], angles: string[], platforms: string[], sensitivity_flags: string[]}>}
   */
  async function analyseContent(text, title) {
    const prompt = `Analyse this content for a robotics/autonomous systems professional's social media.

Title: ${title}
Content (first 2000 chars): ${text.slice(0, 2000)}

Return JSON only — no explanation:
{
  "rating": "high|medium|low|skip",
  "rating_reason": "one sentence",
  "tags": ["tag1", "tag2"],
  "angles": ["angle 1", "angle 2", "angle 3"],
  "platforms": ["linkedin", "reddit"],
  "sensitivity_flags": []
}`;

    const result = await callClaude(
      'You are a content analyst for a professional social media manager. Return only valid JSON.',
      prompt,
      2000
    );

    try {
      return JSON.parse(result);
    } catch {
      // Try to extract JSON from the response
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return {
        rating: 'medium',
        rating_reason: 'Could not analyse — defaulting to medium',
        tags: [],
        angles: ['General professional insight'],
        platforms: ['linkedin'],
        sensitivity_flags: []
      };
    }
  }

  // ── Photo analysis (Phase 2, BUILD_PLAN §7 — vision) ──────────────────

  /**
   * Analyse a photo with Claude vision: is it post-worthy, what's in it,
   * are faces visible. Mirrors analyseContent()'s return shape plus a
   * `description` field the caller stores as the content item's description.
   * @param {string} imageDataUri - "data:<mime>;base64,<data>"
   * @param {string} mimeType
   * @param {string} filename
   * @returns {Promise<{rating: string, rating_reason: string, tags: string[], angles: string[], platforms: string[], sensitivity_flags: string[], description: string}>}
   */
  async function analysePhoto(imageDataUri, mimeType, filename) {
    const base64Data = imageDataUri.slice(imageDataUri.indexOf(',') + 1);

    const prompt = `Analyse this photo for a robotics/autonomous systems professional's social media.

Filename: ${filename}

Requirements:
- Do NOT mention or transcribe any visible text, signage, badges, screens, or
  facility/location names in the image — describe subject matter only
  (e.g. "a quadruped robot on a warehouse floor", not what a sign says).
- Flag if any person's face is clearly visible (consent consideration).

Return JSON only — no explanation:
{
  "rating": "high|medium|low|skip",
  "rating_reason": "one sentence",
  "description": "1-2 sentences: what's shown, no identifying text",
  "tags": ["tag1", "tag2"],
  "angles": ["angle 1", "angle 2", "angle 3"],
  "platforms": ["linkedin", "instagram"],
  "sensitivity_flags": []
}
If a person's face is visible, include "faces_visible" in sensitivity_flags.`;

    const result = await callClaude(
      'You are a content analyst for a professional social media manager. Return only valid JSON.',
      [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
        { type: 'text', text: prompt }
      ],
      1000
    );

    try {
      return JSON.parse(result);
    } catch {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return {
        rating: 'medium',
        rating_reason: 'Could not analyse — defaulting to medium',
        description: filename,
        tags: [],
        angles: ['General professional insight'],
        platforms: ['linkedin'],
        sensitivity_flags: []
      };
    }
  }

  // ── Linked-profile analysis (onboarding Step 1, js/linker.js) ─────────

  /**
   * Infer a starting user profile from linked social accounts and whatever
   * public activity data js/linker.js could fetch. Everything in the
   * payload is already scrubbed by the caller. Runs WITHOUT
   * buildSystemPrompt (no profile exists yet — this call creates the
   * suggestions the profile is built from).
   * @param {{linked_accounts: Object<string, string>, public_data: any[]}} payload
   * @returns {Promise<{name: string, title: string, topics: string[], target_audience: Object<string, string>, tone: Object<string, string>, post_frequency_preference: string, activity_summary: Object<string, string>}|null>}
   */
  async function analyseLinkedProfiles(payload) {
    const prompt = `A new user is setting up SocialOS, a personal social media manager. They linked these social accounts as the first onboarding step. Infer as much of their profile as the data supports, so the rest of setup arrives pre-filled.

Linked accounts (platform -> handle): ${JSON.stringify(payload.linked_accounts)}
Public activity data fetched from those profiles: ${JSON.stringify(payload.public_data)}

Rules:
- Infer the real display name from public data first (e.g. a TikTok display name), then from handle wording (e.g. "jane-doe" -> "Jane Doe"). Empty string if genuinely unknowable.
- topics: infer from recent post titles and handle context; empty array if unknowable.
- post_frequency_preference must reflect their EXISTING posting rhythm where measurable (posts_per_week from public data): >5/week -> "daily", 2-5 -> "moderate", <2 -> "conservative", no data -> "ai_recommended".
- tone values must come from this vocabulary per platform:
  linkedin: professional_thoughtful | authoritative | conversational_professional
  facebook: conversational_warm | friendly | inspirational
  instagram: casual_visual | playful | minimal
  reddit: technical_peer | helpful_expert | casual_knowledgeable
  tiktok: energetic_authentic | educational_quick | playful_casual
- Only include platforms the user actually linked in target_audience, tone, and activity_summary.
- activity_summary: one honest sentence per linked platform about their existing presence and posting/interaction frequency (say "no public data available" where nothing was fetched).

Return JSON only — no explanation:
{
  "name": "",
  "title": "",
  "topics": [],
  "target_audience": { "<platform>": "one-line audience description" },
  "tone": { "<platform>": "tone_value" },
  "post_frequency_preference": "ai_recommended|daily|moderate|conservative",
  "activity_summary": { "<platform>": "one sentence" }
}`;

    const result = await callClaude(
      'You are an onboarding analyst for a personal social media manager. Infer only what the data supports; never fabricate specifics. Return only valid JSON.',
      prompt,
      1500
    );

    try {
      return JSON.parse(result);
    } catch {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { return JSON.parse(jsonMatch[0]); } catch { return null; }
      }
      return null;
    }
  }

  // ── Content scrubbing (secondary Claude check per Section 9) ──────────

  /**
   * Run Claude secondary scrub check.
   * @param {string} text - Already regex-scrubbed text
   * @returns {Promise<{clean: boolean, issues: Array<{type: string, text: string, replacement: string}>}>}
   */
  async function scrubCheck(text) {
    const prompt = `Review the following text for social media safety.

Text: ${text}

Identify and list any of the following that appear:
1. Company or client names (other than well-known public companies)
2. Specific geographic locations (cities, facilities, campuses, addresses)
3. Financial figures (costs, budgets, savings amounts)
4. Proprietary technical specifications
5. Employee or colleague names
6. Any information that a corporate legal or communications team would flag

Return JSON only:
{
  "clean": true/false,
  "issues": [
    { "type": "company_name", "text": "found text", "replacement": "suggested replacement" }
  ]
}`;

    const result = await callClaude(
      'You are a corporate communications reviewer. Return only valid JSON.',
      prompt,
      500
    );

    try {
      return JSON.parse(result);
    } catch {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return { clean: true, issues: [] };
    }
  }

  // ── Engagement Engine (Phase 3, BUILD_PLAN §7/§10/§11) ─────────────────
  // Orchestration + persistence lives in js/engagement.js. Everything here
  // is a raw Claude call using the exact prompt shapes from §11, plus the
  // platform tone/length rules from §10. Callers MUST scrub user-pasted
  // text (SocialOSUtils.scrub) before it reaches any function below —
  // these functions do not scrub for you.

  /** Platform reply length/tone rules — §10 + §11 "Comment Reply Prompt" */
  const PLATFORM_REPLY_RULES = {
    linkedin: '2–4 sentences, professional and thoughtful',
    facebook: '1–3 sentences, conversational and warm',
    instagram: '1–2 sentences, casual, optional emoji (max 1-2)',
    reddit: 'can be longer than other platforms, peer-to-peer technical tone, markdown formatting welcome',
    tiktok: '1–2 short sentences, energetic and authentic, optional emoji (max 1-2)'
  };

  /**
   * comment_monitor() categorization step (§7 Phase 3).
   * Categorizes an already-scrubbed comment and flags high priority
   * (recruiter/opportunity/influential account).
   * @param {string} scrubbedCommentText
   * @param {{platform: string, postSummary?: string, commenterTitle?: string}} context
   * @returns {Promise<{category: 'question'|'compliment'|'disagreement'|'spam'|'opportunity'|'peer', is_high_priority: boolean, reasoning: string}>}
   */
  async function categorizeComment(scrubbedCommentText, context) {
    const prompt = `Categorize this comment on a ${context.platform} post.

${context.postSummary ? `Original post summary: ${context.postSummary}\n` : ''}Comment: ${scrubbedCommentText}
${context.commenterTitle ? `Commenter title: ${context.commenterTitle}\n` : ''}
Categories: question, compliment, disagreement, spam, opportunity, peer
- "opportunity" = recruiter outreach, job opportunity, business/collaboration inquiry
- "spam" = bot-like, irrelevant, promotional junk
- High priority = recruiters, job opportunities, or clearly influential accounts

Return JSON only — no explanation:
{
  "category": "question|compliment|disagreement|spam|opportunity|peer",
  "is_high_priority": true/false,
  "reasoning": "one sentence"
}`;

    const result = await callClaude(
      'You are a comment triage assistant for a professional social media manager. Return only valid JSON.',
      prompt,
      400
    );

    try {
      return JSON.parse(result);
    } catch {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return { category: 'peer', is_high_priority: false, reasoning: 'Could not categorize — defaulting to peer.' };
    }
  }

  /**
   * reply_draft(comment) — §7/§11 "Comment Reply Prompt", exact template.
   * @param {{platform: string, commentText: string, category: string, postSummary?: string, commenterTitle?: string}} input - commentText must already be scrubbed
   * @returns {Promise<{reply: string, alternative: string}>}
   */
  async function draftReply(input) {
    const systemPrompt = await buildSystemPrompt(input.platform);
    const lengthRule = PLATFORM_REPLY_RULES[input.platform] || PLATFORM_REPLY_RULES.linkedin;

    const promptFor = () => `Draft a reply to this comment on a ${input.platform} post.

Original post summary: ${input.postSummary || '(not provided)'}
Comment: ${input.commentText}
Comment category: ${input.category}
Commenter profile: ${input.commenterTitle || '(unknown)'}

Requirements:
- Platform tone: ${input.platform} tone per user profile above
- Length: ${lengthRule}
- Never start with "Great question!" or similar
- Sound genuine and specific, not templated
- If comment is a question: answer it clearly and concisely
- If comment is a compliment: acknowledge warmly and add one sentence of insight
- If comment is a disagreement: respond thoughtfully, acknowledge their point, share your perspective
- If comment is an opportunity (recruiter etc): respond professionally and open the door to further conversation

Return ONLY the reply text.`;

    const reply = await callClaude(systemPrompt, promptFor(), 500);
    const alternative = await callClaude(systemPrompt, promptFor() + '\n\nWrite a different reply than a typical first attempt — same requirements, different phrasing/angle.', 500);

    return { reply: reply.trim(), alternative: alternative.trim() };
  }

  /**
   * engagement_like_queue() scoring step (§7 Phase 3 — manual paste, no live feed).
   * Scores relevance 0–1 of a pasted post for the like queue.
   * @param {{platform: string, postSnippet: string}} input - postSnippet must already be scrubbed
   * @returns {Promise<{score: number, reason: string}>}
   */
  async function scoreLikeRelevance(input) {
    const profile = await SocialOSDB.getProfile();
    const prompt = `Score how relevant this ${input.platform} post is for a ${profile?.title || 'robotics systems integrator'} to like/engage with.

Post snippet: ${input.postSnippet}

Scoring criteria:
- Directly relevant to robotics, autonomous systems, manufacturing, drones, IoT, or the user's expertise: high (0.7-1.0)
- Adjacent tech/engineering content: medium (0.4-0.69)
- Unrelated content: low (0-0.39)

Return JSON only — no explanation:
{ "score": 0.0-1.0, "reason": "one sentence" }`;

    const result = await callClaude(
      'You are an engagement scoring assistant. Return only valid JSON.',
      prompt,
      300
    );

    try {
      const parsed = JSON.parse(result);
      return { score: Math.max(0, Math.min(1, Number(parsed.score) || 0)), reason: parsed.reason || '' };
    } catch {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return { score: Math.max(0, Math.min(1, Number(parsed.score) || 0)), reason: parsed.reason || '' };
      }
      return { score: 0, reason: 'Could not score — defaulting to 0.' };
    }
  }

  /**
   * strategic_comment_suggestions() drafting step (§7 Phase 3).
   * Comment rules: min 2 sentences, must reference real experience,
   * no "Great post!" generics, adds value/insight.
   * @param {{platform: string, postSnippet: string}} input - postSnippet must already be scrubbed
   * @returns {Promise<{comment: string, alternative: string}>}
   */
  async function draftStrategicComment(input) {
    const systemPrompt = await buildSystemPrompt(input.platform);

    const promptFor = () => `Write a strategic comment on this ${input.platform} post, from the user's professional perspective.

Post snippet: ${input.postSnippet}

Requirements:
- Minimum 2 sentences
- Must reference the user's real experience/expertise (from the profile above) — be specific, not generic
- Never write "Great post!" or any equivalent generic opener
- Adds genuine value or insight to the conversation, not just praise
- Platform tone: ${input.platform} conventions (see §10 — e.g. no hashtags on Reddit, professional on LinkedIn)

Return ONLY the comment text.`;

    const comment = await callClaude(systemPrompt, promptFor(), 400);
    const alternative = await callClaude(systemPrompt, promptFor() + '\n\nWrite a different comment than a typical first attempt — same requirements, different angle or example.', 400);

    return { comment: comment.trim(), alternative: alternative.trim() };
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    callClaude,
    testProxy,
    buildSystemPrompt,
    generatePostDrafts,
    analyseContent,
    analysePhoto,
    analyseLinkedProfiles,
    scrubCheck,
    extractHashtags,
    categorizeComment,
    draftReply,
    scoreLikeRelevance,
    draftStrategicComment,
    PLATFORM_REPLY_RULES,
    MODEL
  };
})();
