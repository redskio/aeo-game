require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const DATA_FILE = path.join(__dirname, 'data.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { contents: [], searches: [] };
  }
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Content APIs ---
app.get('/api/contents', (req, res) => {
  const { contents } = load();
  res.json(contents);
});

app.post('/api/contents', (req, res) => {
  const { team, title, body } = req.body;
  if (!team || !title || !body) return res.status(400).json({ error: '필드 누락' });
  const data = load();
  const item = { id: Date.now(), team: parseInt(team), title, body, createdAt: new Date().toISOString() };
  data.contents.push(item);
  save(data);
  res.json(item);
});

app.delete('/api/contents/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const data = load();
  const idx = data.contents.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: '없음' });
  data.contents.splice(idx, 1);
  save(data);
  res.json({ ok: true });
});

app.delete('/api/contents', (req, res) => {
  save({ contents: [], searches: [] });
  res.json({ ok: true });
});

// --- Search API ---
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: '질문 없음' });

  const { contents, searches } = load();

  if (contents.length === 0) {
    return res.json({ answer: '업로드된 콘텐츠가 없습니다. 먼저 팀 콘텐츠를 업로드하세요.', citations: [], scores: {} });
  }

  const contextText = contents.map(c =>
    `[팀${c.team}: ${c.title}]\n${c.body}`
  ).join('\n\n────────────\n\n');

  const systemPrompt = `당신은 AEO(Answer Engine Optimization) 시뮬레이터입니다.
아래 팀들이 올린 콘텐츠만을 기반으로 사용자 질문에 답하세요.

규칙:
1. 반드시 콘텐츠에 있는 정보만 사용하세요.
2. 인용한 팀은 반드시 [출처: 팀N] 형식으로 표시하세요. (예: [출처: 팀3])
3. 여러 팀 콘텐츠를 참고했다면 각각 표시하세요.
4. 답변은 명확하고 간결하게 작성하세요.
5. 콘텐츠에 없는 내용은 "해당 정보는 업로드된 콘텐츠에 없습니다"라고 하세요.

=== 업로드된 팀 콘텐츠 ===

${contextText}`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query }
      ]
    });

    const answer = response.choices[0].message.content;

    // Parse citations
    const citedTeams = new Set();
    const scores = {};
    const citationRegex = /\[출처:\s*팀\s*(\d+)\]/g;
    let match;
    while ((match = citationRegex.exec(answer)) !== null) {
      const t = parseInt(match[1]);
      citedTeams.add(t);
      scores[t] = (scores[t] || 0) + 1;
    }

    // AEO 분석 호출
    const analysisPrompt = `당신은 AEO(Answer Engine Optimization) 전문 분석가입니다.
아래 질문과 팀별 콘텐츠를 보고 각 팀 콘텐츠의 AEO 친화도를 채점하세요.

질문: "${query}"

채점 기준 (각 0~10점):
1. 질문직결성: 이 질문에 대한 답이 콘텐츠에 명확히 있는가
2. 첫문장직답: 첫 50단어 안에 결론/답이 나오는가 (두괄식)
3. 인용가능성: AI가 그대로 발췌할 수 있는 완결된 문장이 있는가
4. 구체성: 수치, 예시, 고유명사 등 구체적 정보가 있는가
5. 간결성: 문장이 짧고 명확한가 (한 문장에 하나의 사실)

=== 팀별 콘텐츠 ===
${contextText}

반드시 아래 JSON 형식으로만 답하세요. 다른 텍스트 없이 JSON만:
{
  "scores": {
    "팀번호": {
      "질문직결성": 점수,
      "첫문장직답": 점수,
      "인용가능성": 점수,
      "구체성": 점수,
      "간결성": 점수,
      "총점": 점수합계,
      "한줄평": "이 질문에서 이 팀 콘텐츠의 강점/약점 한 줄"
    }
  }
}`;

    let analysis = {};
    try {
      const analysisRes = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 1000,
        messages: [{ role: 'user', content: analysisPrompt }]
      });
      const raw = analysisRes.choices[0].message.content.trim()
        .replace(/^```json\s*/i, '').replace(/```\s*$/, '');
      analysis = JSON.parse(raw).scores || {};
    } catch (e) {
      console.error('분석 오류:', e.message);
    }

    const record = {
      id: Date.now(),
      query,
      answer,
      citations: [...citedTeams],
      scores,
      analysis,
      createdAt: new Date().toISOString()
    };

    const data = load();
    data.searches.unshift(record);
    if (data.searches.length > 50) data.searches.pop();
    save(data);

    res.json({ answer, citations: [...citedTeams], scores, analysis });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Claude API 오류: ' + err.message });
  }
});

app.get('/api/searches', (req, res) => {
  const { searches } = load();
  res.json(searches.slice(0, 20));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 AEO 경쟁 테스트 서버 시작`);
  console.log(`   http://localhost:${PORT}\n`);
});
