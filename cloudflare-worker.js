// ═══════════════════════════════════════════════════════════
// 情景交融創作評改 — Cloudflare Worker 代理
// 用途：接收學生作品 → 呼叫 Google Gemini API → 回傳評語
// 部署方法：見「設定指引.md」
// ═══════════════════════════════════════════════════════════

const ALLOWED_ORIGIN = 'https://emilmich.github.io';
const WORKER_VERSION = 'v4-model-fallback';

// ── 候選型號自動備援：逐個實測，邊個用到用邊個 ──
let cachedModel = null;

async function listModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${data?.error?.message || 'unknown'}`);
    return {
      models: (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''))
        .filter(n => !/image|tts|embedding|aqa|imagen/i.test(n)),
      error: null
    };
  } catch (e) {
    return { models: [], error: e.message };
  }
}

function sortCandidates(names) {
  const score = n => {
    let s = 0;
    if (/flash/i.test(n)) s += 100;      // flash 快且平
    if (/lite/i.test(n)) s += 20;        // lite 更慳配額
    const v = n.match(/(\d+(?:\.\d+)?)/);
    if (v) s += parseFloat(v[1]);        // 版本愈新愈好
    return s;
  };
  return [...names].sort((a, b) => score(b) - score(a));
}

function callGemini(apiKey, model, payload) {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
}

// 逐個候選型號實測，回傳第一個成功的回應
async function callWithFallback(apiKey, payload) {
  let modelsResult;
  // 地區限制係間歇性——重試 model 清單（可能落到另一個數據中心）
  for (let attempt = 0; attempt < 4; attempt++) {
    modelsResult = await listModels(apiKey);
    if (modelsResult.models.length > 0 || !modelsResult.error?.includes('location')) break;
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }

  const candidates = [];
  if (cachedModel) candidates.push(cachedModel);
  candidates.push(...sortCandidates(modelsResult.models));

  if (candidates.length === 0) {
    if (cachedModel) {
      // 有快取型號但清單讀唔到——照用快取
      const r = await callGemini(apiKey, cachedModel, payload);
      if (r.ok) return { res: r, model: cachedModel };
    }
    const msg = modelsResult.error?.includes('location')
      ? '服務暫時受限，請稍後再試（自動重試中）'
      : '無法連接 AI 服務，請檢查網絡後再試';
    return { error: msg };
  }

  const tried = new Set();
  let lastErr = 'no available model';
  for (const cand of candidates) {
    if (tried.has(cand)) continue;
    tried.add(cand);
    const r = await callGemini(apiKey, cand, payload);
    if (r.ok) {
      cachedModel = cand;
      return { res: r, model: cand };
    }
    const e = await r.json().catch(() => ({}));
    lastErr = e?.error?.message || `HTTP ${r.status}`;
    if (cachedModel === cand) cachedModel = null;
  }
  return { error: lastErr };
}

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

export default {
  async fetch(request, env) {
    // 處理 CORS 預檢
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 只接受來自指定網站的請求
    const origin = request.headers.get('Origin') || '';
    if (!origin.startsWith(ALLOWED_ORIGIN)) {
      return jsonResponse({ error: 'Forbidden origin' }, 403);
    }

    try {
      const body = await request.json();

      // 診斷模式：顯示版本、金鑰狀態、可用型號清單
      if (body.debug === true) {
        const k = env.GEMINI_API_KEY || '';
        const listResult = k ? await listModels(k) : { models: [], error: 'no key' };
        return jsonResponse({
          version: WORKER_VERSION,
          keySet: k.length > 0,
          keyLength: k.length,
          visibleNames: Object.keys(env),
          availableModels: listResult.models,
          listError: listResult.error,
          cachedModel
        });
      }

      const isDemo = body.mode === 'demo';
      const messages = body.messages;

      // 基本驗證
      if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
        return jsonResponse({ error: 'Invalid messages' }, 400);
      }
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      if (!lastUser || typeof lastUser.content !== 'string' || lastUser.content.length > 800) {
        return jsonResponse({ error: 'Text too long or missing' }, 400);
      }

      // 轉換為 Gemini 格式
      const geminiContents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      let systemText = SYSTEM_PROMPT;
      if (isDemo) {
        systemText += '\n\n【示範模式】學生已嘗試修改兩次，仍未能達到情景交融的要求。現請你以「【示範改寫】」為標題，寫一段經過改善的完整改寫版本（長度約 2-3 句），保留學生原作的核心景物與情感主題，但用更含蓄、更有層次的方式表達，展現情景交融的技巧。然後以「【改動說明】」為標題，簡短解釋你做了哪些改動、為甚麼這樣改是更好的情景交融寫法。語氣溫和、鼓勵。';
      }

      const payload = {
        systemInstruction: { parts: [{ text: systemText }] },
        contents: geminiContents,
        generationConfig: { temperature: 0.6, maxOutputTokens: isDemo ? 900 : 700 }
      };

      // 教師可用 GEMINI_MODEL 變數指定型號；否則自動備援
      let data, usedModel;
      if (env.GEMINI_MODEL) {
        const r = await callGemini(env.GEMINI_API_KEY, env.GEMINI_MODEL, payload);
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          return jsonResponse({ error: `Gemini error: ${e?.error?.message || 'HTTP ' + r.status}` }, 502);
        }
        data = await r.json();
        usedModel = env.GEMINI_MODEL;
      } else {
        const outcome = await callWithFallback(env.GEMINI_API_KEY, payload);
        if (outcome.error) {
          return jsonResponse({ error: `Gemini error: ${outcome.error}` }, 502);
        }
        data = await outcome.res.json();
        usedModel = outcome.model;
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
        || '（暫時未能取得評語，請稍後再試。）';

      return jsonResponse({ feedback: text, model: usedModel, version: WORKER_VERSION });

    } catch (e) {
      return jsonResponse({ error: `Server error: ${e.message}` }, 500);
    }
  }
};
