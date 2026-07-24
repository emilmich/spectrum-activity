// ═══════════════════════════════════════════════════════════
// 情景交融創作評改 — Cloudflare Worker 代理
// 用途：接收學生作品 → 呼叫 Google Gemini API → 回傳評語
// 部署方法：見「設定指引.md」
// ═══════════════════════════════════════════════════════════

const ALLOWED_ORIGIN = 'https://emilmich.github.io';
const GEMINI_MODEL = 'gemini-2.0-flash';

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

      const apiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: geminiContents,
            generationConfig: { temperature: 0.6, maxOutputTokens: 700 }
          })
        }
      );

      if (!apiRes.ok) {
        // 把 Gemini 的實際錯誤訊息透出，方便診斷（金鑰／模型／配額問題）
        const errData = await apiRes.json().catch(() => ({}));
        const errMsg = errData?.error?.message || `HTTP ${apiRes.status}`;
        return jsonResponse({ error: `Gemini error: ${errMsg}` }, 502);
      }

      const data = await apiRes.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
        || '（暫時未能取得評語，請稍後再試。）';

      return jsonResponse({ feedback: text });

    } catch (e) {
      return jsonResponse({ error: `Server error: ${e.message}` }, 500);
    }
  }
};
