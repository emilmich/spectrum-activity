// ═══════════════════════════════════════════════════════════
// 情景交融創作評改 — Cloudflare Worker 代理（OpenAI 版）
// 用途：接收學生作品 → 呼叫 OpenAI API → 回傳評語
// 部署方法：見「設定指引.md」
// ═══════════════════════════════════════════════════════════

const ALLOWED_ORIGIN = 'https://emilmich.github.io';
const WORKER_VERSION = 'v5-openai';
const OPENAI_MODEL = 'gpt-4o-mini';

// ── 評改老師的系統提示詞 ──
const SYSTEM_PROMPT = `你是香港中學文憑試（DSE）中文科的老師，專門評改學生以「情景交融」手法創作的句子或片段。學生正學習柳宗元《始得西山宴遊記》、蘇軾《念奴嬌·赤壁懷古》、李清照《聲聲慢·秋情》、辛棄疾《青玉案·元夕》四篇範文。

評改時必須嚴格依照以下四段格式回應（必須使用此四個標題）：

【是否合乎情景交融】
明確判斷：「合乎」、「大致合乎」或「未合乎」，並用一至兩句說明原因。情景交融的標準是：景與情不可分割——景中含情、情由景生，而非景與情簡單並置。

【可取之處】
具體指出作品的優點，例如：景物選擇是否貼切、情感是否真摯、用詞是否精煉、有無情景融合的亮點。即使未達標，也要找出可鼓勵之處。

【不足之處】
具體指出問題，例如：景與情是否割裂、景物是否空洞泛濫、情感是否過於直露（淪為純抒情）、用詞是否生硬或堆砌。

【改善建議】
給予一至兩個具體可操作的修改方向，可示範改寫一小句，並可引用四篇範文的手法作對照（例如《聲聲慢》以梧桐細雨寫愁、《青玉案》以燈火闌珊顯情、《念奴嬌》以大江載歷史感慨）。

守則：
- 語氣鼓勵而具體，適合中學生理解；每段不超過80字，全篇不超過350字。
- 學生按建議修改後再提交時，先肯定其進步（具體指出改善了甚麼），再指出下一步可改善之處。
- 只評改中文寫作；如學生提交與寫作無關的內容，溫和地引導他回到寫作練習。
- 不可代學生完成整份作品，只能給予指導與局部示範（每次示範不超過一句）。
- 使用繁體中文回應。`;

// ── CORS 標頭 ──
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() }
  });
}

async function callOpenAI(apiKey, messages, maxTokens = 700) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: messages,
      temperature: 0.6,
      max_tokens: maxTokens
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '（未能取得回應）';
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const origin = request.headers.get('Origin') || '';
    if (!origin.startsWith(ALLOWED_ORIGIN)) {
      return jsonResponse({ error: 'Forbidden origin' }, 403);
    }

    try {
      const body = await request.json();

      // 診斷模式
      if (body.debug === true) {
        const k = env.GEMINI_API_KEY || '';
        return jsonResponse({
          version: WORKER_VERSION,
          keySet: k.length > 0,
          keyLength: k.length,
          visibleNames: Object.keys(env),
          model: OPENAI_MODEL
        });
      }

      const isDemo = body.mode === 'demo';
      const messages = body.messages;

      if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
        return jsonResponse({ error: 'Invalid messages' }, 400);
      }
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      if (!lastUser || typeof lastUser.content !== 'string' || lastUser.content.length > 800) {
        return jsonResponse({ error: 'Text too long or missing' }, 400);
      }

      // 組織 OpenAI 訊息
      let systemText = SYSTEM_PROMPT;
      if (isDemo) {
        systemText += `\n\n【示範模式】學生已嘗試修改兩次，仍未能達到情景交融的要求。現請你以「【示範改寫】」為標題，寫一段經過改善的完整改寫版本（長度約 2-3 句），保留學生原作的核心景物與情感主題，但用更含蓄、更有層次的方式表達，展現情景交融的技巧。然後以「【改動說明】」為標題，簡短解釋你做了哪些改動、為甚麼這樣改是更好的情景交融寫法。語氣溫和、鼓勵。`;
      }

      const openaiMessages = [
        { role: 'system', content: systemText },
        ...messages.map(m => ({ role: m.role, content: m.content }))
      ];

      const text = await callOpenAI(
        env.GEMINI_API_KEY,
        openaiMessages,
        isDemo ? 900 : 700
      );

      return jsonResponse({ feedback: text, model: OPENAI_MODEL, version: WORKER_VERSION });

    } catch (e) {
      return jsonResponse({ error: `Server error: ${e.message}` }, 500);
    }
  }
};
